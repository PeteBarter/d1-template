/* src/index.ts — SAMii Milestone Tracker (Cloudflare Worker, TypeScript)
   Routes:
   - GET  /                      Public milestone page (logo, progress, celebration overlay)
   - GET  /__diag                KV health check
   - GET  /latest-payment        Raw JSON of latest payment
   - POST /stripe-webhook        Stripe events (signed, idempotent)
   - GET  /admin/set-latest      ?name=&amount=&token=   (optional helper)
   - GET  /admin/reset-latest    ?token=                 (optional helper)
*/

interface Env {
  MILESTONE_KV: KVNamespace;        // Bind in Workers → Bindings → KV namespace
  STRIPE_WEBHOOK_SECRET: string;    // whsec_... for THIS endpoint URL
  ADMIN_TOKEN?: string;             // optional: long random string
}

const TARGET_AUD = 1_000_000;
const GROSS_KEY   = "total_cents";        // running total (cents)
const LATEST_KEY  = "latest_payment";     // { name, amount:number(AUD), created:ISO }
const DEDUPE_PREF = "evt:";               // prefix for processed event IDs

/* ===================================================================== */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ---------- Diagnostics ----------
    if (url.pathname === "/__diag") {
      try { await env.MILESTONE_KV.get("ping"); return json({ ok: true }); }
      catch (e: any) { return json({ ok: false, error: String(e?.message ?? e) }, 500); }
    }

    // ---------- Debug ----------
    if (url.pathname === "/latest-payment") {
      const lp = await getLatestPayment(env);
      return json(lp ?? {});
    }

    // ---------- Admin helpers (optional) ----------
    if (url.pathname === "/admin/set-latest") {
      if (!isAuthorised(url, env)) return text("unauthorised", 401);
      const name = (url.searchParams.get("name") || "Test Payer").slice(0, 120);
      const amount = Number(url.searchParams.get("amount") || "42");
      await kvPut(env, LATEST_KEY, JSON.stringify({
        name,
        amount: Number.isFinite(amount) ? amount : 0,
        created: new Date().toISOString()
      }));
      return text(`ok: stored ${name} (${amount})`);
    }
    if (url.pathname === "/admin/reset-latest") {
      if (!isAuthorised(url, env)) return text("unauthorised", 401);
      try { await env.MILESTONE_KV.delete(LATEST_KEY); } catch {}
      return text("ok: cleared");
    }

    // ---------- Stripe webhook ----------
    if (url.pathname === "/stripe-webhook" && req.method === "POST") {
      return handleStripeWebhook(req, env);
    }

    // ---------- Public page (wrapped; never 1101s) ----------
    try {
      const gross = await readGrossAud(env);                    // AUD dollars
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

async function kvPut(env: Env, key: string, val: string) {
  try { await env.MILESTONE_KV.put(key, val); }
  catch (e) { console.error("KV.put failed:", e); throw e; }
}

async function addCents(env: Env, cents: number) {
  try {
    const raw = await env.MILESTONE_KV.get(GROSS_KEY);
    const current = parseInt(raw ?? "0", 10) || 0;
    const next = current + Math.max(0, (cents | 0));
    await env.MILESTONE_KV.put(GROSS_KEY, String(next));
  } catch (e) {
    console.error("addCents failed:", e);
    throw e;
  }
}

async function readGrossAud(env: Env): Promise<number> {
  try {
    const raw = await env.MILESTONE_KV.get(GROSS_KEY);
    const cents = parseInt(raw ?? "0", 10);
    if (!Number.isFinite(cents)) throw new Error("cents not finite");
    return Math.round(cents / 100);
  } catch (e) {
    console.warn("readGrossAud fallback:", e);
    return 988100; // fallback so page still renders
  }
}

async function getLatestPayment(env: Env): Promise<null | { name: string; amount: number; created: string }> {
  try {
    const raw = await env.MILESTONE_KV.get(LATEST_KEY);
    if (!raw) return null;
    const val = JSON.parse(raw);
    const amount = Number((val?.amount as any) ?? 0);
    const name = String(val?.name ?? "Unknown").slice(0, 120);
    const created = String(val?.created ?? new Date().toISOString());
    return { name, amount: Number.isFinite(amount) ? amount : 0, created };
  } catch (e) {
    console.warn("latest_payment parse fallback:", e);
    return null;
  }
}

async function markProcessed(env: Env, eventId: string): Promise<boolean> {
  try {
    const key = DEDUPE_PREF + eventId;
    if (await env.MILESTONE_KV.get(key)) return false;
    await env.MILESTONE_KV.put(key, "1", { expirationTtl: 60 * 60 * 24 * 14 }); // 14 days
    return true;
  } catch (e) {
    console.error("dedupe write failed (continuing):", e);
    return true; // don't block processing on dedupe failures
  }
}

/* ========================== Stripe webhook bits ========================= */

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const rawBody = await req.text();                              // RAW body
  const sigHeader = req.headers.get("stripe-signature") || "";   // header is case-insensitive

  try {
    await verifyStripeSignatureAsync(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET, 1800); // 30-min tolerance
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

    // Increment running total ONLY on charge.succeeded (avoid double-counting alongside PI/Checkout)
    if (type === "charge.succeeded") {
      const ch = event.data.object || {};
      if ((ch.currency || "").toLowerCase() === "aud") {
        const cents = ch.amount || 0;
        await addCents(env, cents);
      }
      const name = ch.billing_details?.name || "Unknown";
      const createdISO = unixToIso(event.created);
      const amountAud = ((ch.amount ?? 0) / 100);
      await kvPut(env, LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    // Record latest payer line for these, but DO NOT increment total (prevents double-counting)
    if (type === "payment_intent.succeeded") {
      const pi = event.data.object || {};
      const name = pi.charges?.data?.[0]?.billing_details?.name || pi.shipping?.name || "Unknown";
      const createdISO = unixToIso(event.created);
      const amountAud = ((pi.amount_received ?? pi.amount ?? 0) / 100);
      await kvPut(env, LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

    if (type === "checkout.session.completed") {
      const s = event.data.object || {};
      const name = s.customer_details?.name || s.customer?.name || "Unknown";
      const createdISO = unixToIso(event.created);
      const amountAud = (s.amount_total ?? 0) / 100;
      await kvPut(env, LATEST_KEY, JSON.stringify({ name, amount: amountAud, created: createdISO }));
      return text("ok", 200);
    }

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
      const [k, v] = p.split("="); return [k.trim(), (v ?? "").trim()];
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

function unixToIso(u?: number) {
  const s = typeof u === "number" ? u : Math.floor(Date.now() / 1000);
  return new Date(s * 1000).toISOString();
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
    ? (() => {
        const safeAmountNum = Number(o.latestPayment.amount);
        const amt = Number.isFinite(safeAmountNum) ? safeAmountNum.toFixed(2) : "0.00";
        const safeName = escapeHtml(o.latestPayment.name || "Unknown");
        return `<p class="credit">Latest payment from <strong>${safeName}</strong> for A$${amt}.</p>`;
      })()
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
body{margin:0;background:var(--dark-teal);color:var(--white);font-family:'Comfortaa',sans-serif;text-align:center;overflow-x:hidden}
.samii-logo{display:block;margin:40px auto 20px;width:360px;max-width:90vw;transition:transform .6s ease,opacity .8s ease;opacity:0}
.samii-logo.show{transform:scale(1.1);opacity:1}
h1{margin:10px 0 0;font-size:clamp(24px,3vw,40px);background:linear-gradient(90deg,var(--mint),var(--light-teal));-webkit-background-clip:text;background-clip:text;color:transparent}
.bar{width:min(860px,92vw);height:32px;margin:40px auto 20px;background:rgba(255,255,255,.18);border-radius:20px;overflow:hidden}
.fill{height:100%;width:${(isFinite(o.percentValue)?o.percentValue:0).toFixed(2)}%;background:linear-gradient(90deg,var(--blue-teal),var(--mint));border-radius:20px;transition:width .5s ease}
.stats{color:var(--silver);font-size:20px;line-height:1.8}
.highlight{color:var(--mint);font-weight:700}
.credit{font-size:22px;color:var(--mint);margin:10px 0 0}
footer{margin:30px 0 10px;color:var(--silver);font-size:14px}
/* Celebrate overlay */
#celebrate{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);z-index:50;flex-direction:column;padding:20px}
#celebrate.show{display:flex;animation:fadein .35s ease-out}
.massive{font-size:clamp(60px,12vw,160px);font-weight:700;color:var(--mint);
  text-shadow:0 0 20px var(--light-teal),0 0 40px var(--mint);animation:flash 1s infinite alternate;margin:0 0 16px}
.gifgrid{display:flex;flex-wrap:wrap;justify-content:center;gap:20px;margin-top:18px}
.gifgrid img{width:320px;max-width:90vw;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
@keyframes flash{0%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
</style>
</head>
<body>
<img class="samii-logo" src="https://cdn.prod.website-files.com/6642ff26ca1cac64614e0e96/6642ff6de91fa06b733c39c6_SAMii-p-500.png" alt="SAMii logo">
<script>addEventListener('load',()=>document.querySelector('.samii-logo')?.classList.add('show'));</script>

<h1>🎉 SAMii Lesson Payments Milestone Tracker 🎉</h1>
<div class="bar"><div class="fill"></div></div>
<div class="stats">
  <div>Total so far: <span class="highlight">${escapeHtml(o.grossText)}</span></div>
  <div>Remaining to $1M: <span class="highlight">${escapeHtml(o.remainingText)}</span></div>
  <div>Progress: <span class="highlight">${escapeHtml(o.percentText)}</span></div>
</div>
${creditHtml}
<footer>Updated automatically with Stripe • SAMii.com.au</footer>

<!-- Celebrate overlay -->
<div id="celebrate" aria-hidden="true">
  <div class="massive">$1,000,000</div>
  ${o.latestPayment ? `<p class="credit">Milestone reached thanks to <strong>${escapeHtml(o.latestPayment.name || "Unknown")}</strong> for A$${Number(o.latestPayment.amount||0).toFixed(2)}!</p>` : ""}
  <div class="gifgrid">
    <img src="https://media1.giphy.com/media/5GoVLqeAOo6PK/giphy.gif" alt="Confetti celebration">
    <img src="https://media3.giphy.com/media/hZj44bR9FVI3K/giphy.webp" alt="Fireworks">
  </div>
</div>

<!-- Confetti + trigger -->
<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
<script>
(function(){
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');               // use ?demo=hit to force the overlay
  const IS_HIT = ${o.isHit ? "true" : "false"};
  const KEY = 'samii_milestone_seen_v1';

  function conf(){ const blast=()=>confetti({particleCount:160,spread:120,startVelocity:45,origin:{y:0.6}});
                   blast(); setTimeout(blast,600); setTimeout(blast,1200); }
  function showCelebrate(){
    const el = document.getElementById('celebrate');
    if(!el) return; el.classList.add('show'); conf();
    el.addEventListener('click', e => { if (e.target === el) el.classList.remove('show'); });
  }
  if (demo==='reset') localStorage.removeItem(KEY);
  if (IS_HIT || demo==='hit') {
    const seen = Number(localStorage.getItem(KEY)||0);
    if (seen < 2) { showCelebrate(); localStorage.setItem(KEY, String(seen+1)); }
  }
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
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
