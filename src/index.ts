/* src/index.ts
   SAMii Milestone Tracker — Worker + Stripe webhook (KV-backed)

   Routes:
   - GET  /                     Public milestone page
   - GET  /latest-payment       JSON of latest payment (debug)
   - GET  /__diag               KV health check
   - POST /stripe-webhook       Stripe events (signing verified)
   - GET  /admin/set-latest     ?name=&amount=&token=
   - GET  /admin/reset-latest   ?token=
*/

interface Env {
  MILESTONE_KV: KVNamespace;        // KV namespace binding (Bindings → KV namespace)
  STRIPE_WEBHOOK_SECRET: string;    // whsec_... for THIS endpoint URL
  ADMIN_TOKEN?: string;             // optional: long random string for admin endpoints
}

const TARGET_AUD = 1_000_000;             // Display target
const GROSS_KEY   = "total_cents";        // KV key: running total in cents
const LATEST_KEY  = "latest_payment";     // KV key: last payment blob
const DEDUPE_PREF = "evt:";               // KV prefix for processed event ids

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ------------- Diagnostics -------------
    if (url.pathname === "/__diag") {
      try {
        await env.MILESTONE_KV.get("any");
        return json({ ok: true, kv: "attached" });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message ?? e) }, 500);
      }
    }

    // ------------- Admin helpers -------------
    if (url.pathname === "/admin/set-latest") {
      if (!(await isAuthorised(url, env))) return new Response("unauthorised", { status: 401 });
      const name = (url.searchParams.get("name") || "Test Payer").slice(0, 120);
      const amount = Number(url.searchParams.get("amount") || "42");
      await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({ name, amount, created: new Date().toISOString() }));
      return text(`ok: stored ${name} (${amount})`);
    }

    if (url.pathname === "/admin/reset-latest") {
      if (!(await isAuthorised(url, env))) return new Response("unauthorised", { status: 401 });
      await env.MILESTONE_KV.delete(LATEST_KEY);
      return text("ok: cleared");
    }

    // ------------- Debug API -------------
    if (url.pathname === "/latest-payment") {
      const lp = await getLatestPayment(env);
      return json(lp ?? {});
    }

    // ------------- Stripe webhook -------------
    if (url.pathname === "/stripe-webhook" && req.method === "POST") {
      return handleStripeWebhook(req, env);
    }

    // ------------- Public page -------------
    const gross = await readGrossAud(env);                 // number in AUD dollars
    const remaining = Math.max(0, TARGET_AUD - gross);
    const percent = Math.min(100, (gross / TARGET_AUD) * 100);
    const latestPayment = await getLatestPayment(env);
    const html = renderPage({
      grossText: `A$${gross.toLocaleString()}`,
      remainingText: `A$${remaining.toLocaleString()}`,
      percentText: `${percent.toFixed(2)}%`,
      percentValue: percent,
      isHit: gross >= TARGET_AUD,
      latestPayment,
    });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

/* ============================== KV helpers ============================== */

async function addCents(env: Env, cents: number) {
  const raw = (await env.MILESTONE_KV.get(GROSS_KEY)) ?? "0";
  const current = parseInt(raw, 10) || 0;
  const next = current + Math.max(0, cents | 0);
  await env.MILESTONE_KV.put(GROSS_KEY, String(next));
}

async function readGrossAud(env: Env): Promise<number> {
  const raw = (await env.MILESTONE_KV.get(GROSS_KEY)) ?? "0";
  const cents = parseInt(raw, 10) || 0;
  return Math.round(cents / 100);
}

async function getLatestPayment(env: Env): Promise<null | { name: string; amount: number; created: string }> {
  try {
    const raw = await env.MILESTONE_KV.get(LATEST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function markProcessed(env: Env, eventId: string): Promise<boolean> {
  const key = DEDUPE_PREF + eventId;
  const exists = await env.MILESTONE_KV.get(key);
  if (exists) return false;                       // already processed
  await env.MILESTONE_KV.put(key, "1", { expirationTtl: 60 * 60 * 24 * 14 }); // keep 14 days
  return true;
}

/* ========================== Stripe webhook bits ========================= */

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const rawBody = await req.text();                                  // RAW body
  const sigHeader = req.headers.get("stripe-signature") || "";        // case-insensitive

  try {
    await verifyStripeSignatureAsync(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET, 1800); // 30 min tolerance
  } catch (err: any) {
    console.log("Stripe verify failed:", err?.message || err);
    return text("Signature verification failed", 400);
  }

  // Parse the (now-trusted) event
  let event: any;
  try { event = JSON.parse(rawBody); }
  catch { return text("Invalid JSON", 400); }

  const eventId = event?.id || "";
  if (!eventId) return text("Missing event id", 400);

  // Idempotency: skip if this event id was already processed
  if (!(await markProcessed(env, eventId))) {
    return text("duplicate", 200);
  }

  try {
    const type = event.type;

    // Always capture a 'latest payment' credit line when we can
    if (type === "charge.succeeded") {
      const ch = event.data.object || {};
      if ((ch.currency || "").toLowerCase() === "aud") {
        const cents = ch.amount || 0;
        await addCents(env, cents);                                            // increment TOTAL
      }
      const name = ch.billing_details?.name || "Unknown";
      const createdISO = new Date((event.created ?? Math.floor(Date.now()/1000)) * 1000).toISOString();
      const amountAud = ((ch.amount ?? 0) / 100);
      await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    // Don’t increment total on PI/Checkout to avoid double-counting; just record latest_payment if present.
    if (type === "payment_intent.succeeded") {
      const pi = event.data.object || {};
      const latestCharge = pi.charges?.data?.[0];
      const name = latestCharge?.billing_details?.name || pi.shipping?.name || "Unknown";
      const createdISO = new Date((event.created ?? Math.floor(Date.now()/1000)) * 1000).toISOString();
      const amountAud = ((pi.amount_received ?? pi.amount ?? 0) / 100);
      await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    if (type === "checkout.session.completed") {
      const s = event.data.object || {};
      const name = s.customer_details?.name || s.customer?.name || "Unknown";
      const amountAud = (s.amount_total ?? 0) / 100;
      const createdISO = new Date((event.created ?? Math.floor(Date.now()/1000)) * 1000).toISOString();
      await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    // Ignore everything else
    return text("ignored", 200);
  } catch (err: any) {
    console.log("KV write failed:", err?.message || err);
    return text("KV write failed", 500);
  }
}

/* ---------------------- Stripe signature verification ------------------- */
// Cloudflare-native HMAC (no Stripe SDK)

async function verifyStripeSignatureAsync(
  rawBody: string,
  sigHeader: string,
  endpointSecret: string,
  toleranceSeconds = 300
) {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k.trim(), (v ?? "").trim()];
    })
  );
  const t = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!t || !v1) throw new Error("Bad Stripe-Signature header");

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) throw new Error("Timestamp outside tolerance");

  const signedPayload = `${t}.${rawBody}`;
  const expectedHex = await hmacSHA256(endpointSecret, signedPayload);
  if (!timingSafeEqualHex(expectedHex, v1)) throw new Error("Signature mismatch");
}

async function hmacSHA256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

/* ============================== Page render ============================= */

function renderPage(o: {
  grossText: string;
  remainingText: string;
  percentText: string;
  percentValue: number;
  isHit: boolean;
  latestPayment: null | { name: string; amount: number; created: string };
}) {
  const creditHtml = o.latestPayment
    ? `<p style="font-size:22px;color:var(--mint);margin:10px 0 0;">
         Latest payment from <strong>${escapeHtml(o.latestPayment.name || "Unknown")}</strong>
         for A$${Number(o.latestPayment.amount || 0).toFixed(2)}.
       </p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAMii Milestone</title>
<link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--dark-teal:#0d3447;--blue-teal:#0d6694;--light-teal:#4791B8;--mint:#3CC99F;--white:#ffffff;--silver:#e0dfdf}
*{box-sizing:border-box}
body{margin:0;background:var(--dark-teal);color:var(--white);font-family:'Comfortaa',sans-serif;text-align:center}
h1{margin:18px 0 0;font-size:clamp(24px,3vw,40px);background:linear-gradient(90deg,var(--mint),var(--light-teal));-webkit-background-clip:text;background-clip:text;color:transparent}
.bar{width:min(860px,92vw);height:32px;margin:40px auto 20px;background:rgba(255,255,255,.18);border-radius:20px;overflow:hidden}
.fill{height:100%;width:${o.percentValue.toFixed(2)}%;background:linear-gradient(90deg,var(--blue-teal),var(--mint));border-radius:20px;transition:width .5s ease}
.stats{color:var(--silver);font-size:20px;line-height:1.8}
.highlight{color:var(--mint);font-weight:700}
footer{margin:30px 0 10px;color:var(--silver);font-size:14px}
</style>
</head>
<body>
<h1>🎉 SAMii Lesson Payments Milestone Tracker 🎉</h1>
<div class="bar"><div class="fill"></div></div>
<div class="stats">
  <div>Total so far: <span class="highlight">${escapeHtml(o.grossText)}</span></div>
  <div>Remaining to $1M: <span class="highlight">${escapeHtml(o.remainingText)}</span></div>
  <div>Progress: <span class="highlight">${escapeHtml(o.percentText)}</span></div>
</div>
${creditHtml}
<footer>Updated automatically with Stripe • SAMii.com.au</footer>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c as "&" | "<" | ">" | '"' | "'"])
  );
}

/* ============================== utils ============================== */
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function text(s: string, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
function isAuthorised(url: URL, env: Env) {
  const token = url.searchParams.get("token") || "";
  return Boolean(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN);
}
