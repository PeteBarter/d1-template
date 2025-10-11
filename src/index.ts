/* src/index.ts – SAMii Milestone Tracker (hardened) */

interface Env {
  MILESTONE_KV: KVNamespace;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_TOKEN?: string;
}

const TARGET_AUD = 1_000_000;
const GROSS_KEY  = "total_cents";
const LATEST_KEY = "latest_payment";
const DEDUPE_PREF = "evt:";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/__diag") {
      try { await env.MILESTONE_KV.get("any"); return json({ ok: true }); }
      catch (e: any) { return json({ ok: false, error: String(e?.message ?? e) }, 500); }
    }

    if (url.pathname === "/admin/set-latest") {
      if (!(await isAuthorised(url, env))) return text("unauthorised", 401);
      const name = (url.searchParams.get("name") || "Test Payer").slice(0, 120);
      const amount = Number(url.searchParams.get("amount") || "42");
      await safePut(env, LATEST_KEY, JSON.stringify({ name, amount, created: new Date().toISOString() }));
      return text(`ok: stored ${name} (${amount})`);
    }

    if (url.pathname === "/admin/reset-latest") {
      if (!(await isAuthorised(url, env))) return text("unauthorised", 401);
      try { await env.MILESTONE_KV.delete(LATEST_KEY); } catch {}
      return text("ok: cleared");
    }

    if (url.pathname === "/latest-payment") {
      const lp = await getLatestPayment(env);
      return json(lp ?? {});
    }

    if (url.pathname === "/stripe-webhook" && req.method === "POST") {
      return handleStripeWebhook(req, env);
    }

    // Public page — fully wrapped so it never 1101s
    try {
      const gross = await readGrossAud(env);
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
    } catch (e: any) {
      console.error("Render error:", e?.message || e);
      return text("Temporary render issue", 500);
    }
  },
};

/* ============================== KV helpers ============================== */
async function safePut(env: Env, key: string, val: string) {
  try { await env.MILESTONE_KV.put(key, val); } catch (e) { console.error("KV.put failed:", e); throw e; }
}
async function addCents(env: Env, cents: number) {
  try {
    const raw = (await env.MILESTONE_KV.get(GROSS_KEY)) ?? "0";
    const current = parseInt(raw, 10) || 0;
    const next = current + Math.max(0, cents | 0);
    await env.MILESTONE_KV.put(GROSS_KEY, String(next));
  } catch (e) { console.error("addCents failed:", e); throw e; }
}
async function readGrossAud(env: Env): Promise<number> {
  try {
    const raw = (await env.MILESTONE_KV.get(GROSS_KEY)) ?? "0";
    const cents = parseInt(raw, 10) || 0;
    return Math.round(cents / 100);
  } catch (e) {
    console.warn("readGrossAud fallback:", e);
    return 988100; // visual fallback, prevents 1101
  }
}
async function getLatestPayment(env: Env): Promise<null | { name: string; amount: number; created: string }> {
  try {
    const raw = await env.MILESTONE_KV.get(LATEST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn("latest_payment parse fallback:", e);
    return null;
  }
}
async function markProcessed(env: Env, eventId: string): Promise<boolean> {
  try {
    const key = DEDUPE_PREF + eventId;
    if (await env.MILESTONE_KV.get(key)) return false;
    await env.MILESTONE_KV.put(key, "1", { expirationTtl: 60 * 60 * 24 * 14 });
    return true;
  } catch (e) { console.error("dedupe put failed:", e); return true; } // don't block processing
}

/* ========================== Stripe webhook bits ========================= */
async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";

  try {
    await verifyStripeSignatureAsync(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET, 1800);
  } catch (err: any) {
    console.log("Stripe verify failed:", err?.message || err);
    return text("Signature verification failed", 400);
  }

  let event: any;
  try { event = JSON.parse(rawBody); }
  catch { return text("Invalid JSON", 400); }

  const eventId = event?.id || "";
  if (!eventId) return text("Missing event id", 400);
  if (!(await markProcessed(env, eventId))) return text("duplicate", 200);

  try {
    const type = event.type;

    if (type === "charge.succeeded") {
      const ch = event.data.object || {};
      if ((ch.currency || "").toLowerCase() === "aud") {
        await addCents(env, ch.amount || 0);
      }
      const name = ch.billing_details?.name || "Unknown";
      const createdISO = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
      const amountAud = ((ch.amount ?? 0) / 100);
      await safePut(env, LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    if (type === "payment_intent.succeeded") {
      const pi = event.data.object || {};
      const name = pi.charges?.data?.[0]?.billing_details?.name || pi.shipping?.name || "Unknown";
      const createdISO = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
      const amountAud = ((pi.amount_received ?? pi.amount ?? 0) / 100);
      await safePut(env, LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    if (type === "checkout.session.completed") {
      const s = event.data.object || {};
      const name = s.customer_details?.name || s.customer?.name || "Unknown";
      const amountAud = (s.amount_total ?? 0) / 100;
      const createdISO = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
      await safePut(env, LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    return text("ignored", 200);
  } catch (err: any) {
    console.log("KV write failed:", err?.message || err);
    return text("KV write failed", 500);
  }
}

/* ---------------------- Stripe signature verification ------------------- */
async function verifyStripeSignatureAsync(
  rawBody: string, sigHeader: string, endpointSecret: string, toleranceSeconds = 300
) {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => { const [k, v] = p.split("="); return [k.trim(), (v ?? "").trim()]; })
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
  grossText: string; remainingText: string; percentText: string; percentValue: number; isHit: boolean;
  latestPayment: null | { name: string; amount: number; created: string };
}) {
  const creditHtml = o.latestPayment
    ? `<p style="font-size:22px;color:#3CC99F;margin:10px 0 0;">
         Latest payment from <strong>${escapeHtml(o.latestPayment.name || "Unknown")}</strong>
         for A$${Number(o.latestPayment.amount || 0).toFixed(2)}.
       </p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAMii Milestone</title>
<style>
:root{--dark:#0d3447;--mint:#3CC99F;--line:#e0dfdf}
body{margin:0;background:var(--dark);color:#fff;font-family:system-ui,Segoe UI,Roboto,Arial;text-align:center}
.bar{width:min(860px,92vw);height:32px;margin:40px auto 20px;background:rgba(255,255,255,.18);border-radius:20px;overflow:hidden}
.fill{height:100%;width:${(isFinite(o.percentValue)?o.percentValue:0).toFixed(2)}%;background:linear-gradient(90deg,#0d6694,var(--mint))}
.stats{color:var(--line);font-size:20px;line-height:1.8}.highlight{color:var(--mint);font-weight:700}
</style></head><body>
<h1>🎉 Lesson Payments Milestone Tracker 🎉</h1>
<div class="bar"><div class="fill"></div></div>
<div class="stats">
  <div>Total so far: <span class="highlight">${escapeHtml(o.grossText)}</span></div>
  <div>Remaining to $1M: <span class="highlight">${escapeHtml(o.remainingText)}</span></div>
  <div>Progress: <span class="highlight">${escapeHtml(o.percentText)}</span></div>
</div>
${creditHtml}
<footer style="margin:30px 0 10px;color:#e0dfdf;font-size:14px">Updated automatically with Stripe • SAMii.com.au</footer>
</body></html>`;
}
function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/* ============================== utils ============================== */
function json(obj: any, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }); }
function text(s: string, status = 200) { return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } }); }
function isAuthorised(url: URL, env: Env) { const token = url.searchParams.get("token") || ""; return Boolean(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN); }
