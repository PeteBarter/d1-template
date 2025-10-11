/* src/index.ts — SAMii Milestone Tracker (Cloudflare Worker)
   by Pete + GPT-5
*/

interface Env {
  MILESTONE_KV: KVNamespace;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_TOKEN?: string;
}

const TARGET_AUD = 1_000_000;
const GROSS_KEY = "total_cents";
const LATEST_KEY = "latest_payment";
const DEDUPE_PREF = "evt:";

/* ====================== Main fetch handler ====================== */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // --- Diagnostics ---
    if (url.pathname === "/__diag")
      try { await env.MILESTONE_KV.get("ping"); return json({ ok: true }); }
      catch (e: any) { return json({ ok: false, error: String(e?.message ?? e) }, 500); }

    // --- Debug JSON ---
    if (url.pathname === "/latest-payment")
      return json(await getLatestPayment(env) ?? {});

    // --- Admin (optional) ---
    if (url.pathname === "/admin/set-latest") {
      if (!isAuthorised(url, env)) return text("unauthorised", 401);
      const name = (url.searchParams.get("name") || "Test").slice(0, 120);
      const amount = Number(url.searchParams.get("amount") || "42");
      await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({
        name, amount, created: new Date().toISOString()
      }));
      return text(`ok: ${name} (${amount})`);
    }

    if (url.pathname === "/admin/reset-latest") {
      if (!isAuthorised(url, env)) return text("unauthorised", 401);
      await env.MILESTONE_KV.delete(LATEST_KEY);
      return text("ok: cleared");
    }

    // --- Stripe webhook ---
    if (url.pathname === "/stripe-webhook" && req.method === "POST")
      return handleStripeWebhook(req, env);

    // --- Main page ---
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
      return htmlResponse(html);
    } catch (e: any) {
      console.error("Render error:", e);
      return text("Temporary render issue", 500);
    }
  },
};

/* ====================== KV helpers ====================== */

async function addCents(env: Env, cents: number) {
  const raw = await env.MILESTONE_KV.get(GROSS_KEY);
  const current = parseInt(raw ?? "0", 10) || 0;
  const next = current + Math.max(0, cents | 0);
  await env.MILESTONE_KV.put(GROSS_KEY, String(next));
}

async function readGrossAud(env: Env) {
  const raw = await env.MILESTONE_KV.get(GROSS_KEY);
  const cents = parseInt(raw ?? "0", 10);
  return Number.isFinite(cents) ? Math.round(cents / 100) : 988_100;
}

async function getLatestPayment(env: Env) {
  try {
    const raw = await env.MILESTONE_KV.get(LATEST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return {
      name: String(v.name ?? "Unknown"),
      amount: Number(v.amount ?? 0),
      created: String(v.created ?? new Date().toISOString())
    };
  } catch { return null; }
}

async function markProcessed(env: Env, id: string) {
  const key = DEDUPE_PREF + id;
  if (await env.MILESTONE_KV.get(key)) return false;
  await env.MILESTONE_KV.put(key, "1", { expirationTtl: 60 * 60 * 24 * 14 });
  return true;
}

/* ====================== Stripe webhook ====================== */

async function handleStripeWebhook(req: Request, env: Env) {
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") || "";

  try {
    await verifyStripeSignatureAsync(raw, sig, env.STRIPE_WEBHOOK_SECRET, 1800);
  } catch (err: any) {
    console.log("Stripe verify failed:", err?.message);
    return text("Signature verification failed", 400);
  }

  const event = JSON.parse(raw);
  const id = event.id || "";
  if (!id) return text("Missing id", 400);
  if (!(await markProcessed(env, id))) return text("duplicate", 200);

  const type = event.type;
  try {
    if (type === "charge.succeeded") {
      const ch = event.data.object;
      if ((ch.currency || "").toLowerCase() === "aud")
        await addCents(env, ch.amount);
      const name = ch.billing_details?.name || "Unknown";
      await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({
        name, amount: ch.amount / 100, created: unixToIso(event.created)
      }));
      return text("ok");
    }

    if (type === "payment_intent.succeeded" || type === "checkout.session.completed") {
      const obj = event.data.object;
      const name = obj.customer_details?.name ||
                   obj.billing_details?.name ||
                   obj.shipping?.name || "Unknown";
      await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({
        name, amount: (obj.amount_total ?? obj.amount ?? 0) / 100,
        created: unixToIso(event.created)
      }));
      return text("ok");
    }

    return text("ignored");
  } catch (err: any) {
    console.error("KV write failed:", err);
    return text("KV write failed", 500);
  }
}

/* ====================== Signature verification ====================== */

async function verifyStripeSignatureAsync(body: string, sig: string, secret: string, tol = 300) {
  const parts = Object.fromEntries(sig.split(",").map(p => p.trim().split("=")));
  const t = Number(parts.t), v1 = parts.v1;
  if (!t || !v1) throw new Error("Bad signature header");

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tol) throw new Error("Timestamp outside tolerance");

  const expected = await hmacSHA256(secret, `${t}.${body}`);
  if (!timingSafeEqual(expected, v1)) throw new Error("Signature mismatch");
}

async function hmacSHA256(secret: string, data: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function unixToIso(sec: number) { return new Date(sec * 1000).toISOString(); }

/* ====================== HTML renderer ====================== */

function renderPage(o: {
  grossText: string; remainingText: string; percentText: string;
  percentValue: number; isHit: boolean;
  latestPayment: null | { name: string; amount: number; created: string };
}) {
  const credit = o.latestPayment
    ? `<p class="credit">Latest payment from <strong>${escape(o.latestPayment.name)}</strong> for A$${o.latestPayment.amount.toFixed(2)}</p>` : "";

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAMii Milestone</title>
<link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;700&display=swap" rel="stylesheet">
<style>
body{margin:0;background:#0d3447;color:#fff;font-family:'Comfortaa',sans-serif;text-align:center;overflow-x:hidden}
.samii-logo{display:block;margin:40px auto 20px;width:360px;max-width:90vw;transition:.6s;opacity:0}
.samii-logo.show{transform:scale(1.1);opacity:1}
h1{margin:0;background:linear-gradient(90deg,#3cc99f,#4791b8);-webkit-background-clip:text;color:transparent;font-size:clamp(24px,3vw,42px)}
.bar{width:min(860px,92vw);height:32px;margin:40px auto 20px;background:rgba(255,255,255,.2);border-radius:20px;overflow:hidden}
.fill{height:100%;width:${o.percentValue.toFixed(2)}%;background:linear-gradient(90deg,#0d6694,#3cc99f);transition:.5s}
.stats{font-size:20px;color:#ddd}
.highlight{color:#3cc99f;font-weight:700}
.credit{font-size:22px;color:#3cc99f;margin-top:10px}
#celebrate{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.75);flex-direction:column;z-index:50}
#celebrate.show{display:flex;animation:fadein .4s}
.massive{font-size:clamp(60px,12vw,160px);font-weight:700;color:#3cc99f;text-shadow:0 0 20px #4791b8,0 0 40px #3cc99f;animation:flash 1s infinite alternate;margin:0}
.gifgrid{display:flex;flex-wrap:wrap;justify-content:center;gap:20px;margin-top:18px}
.gifgrid img{width:320px;max-width:90vw;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
@keyframes flash{0%{opacity:1}50%{opacity:.6;transform:scale(1.05)}100%{opacity:1}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
</style></head><body>
<img class="samii-logo" src="https://cdn.prod.website-files.com/6642ff26ca1cac64614e0e96/6642ff6de91fa06b733c39c6_SAMii-p-500.png" alt="SAMii logo">
<script>addEventListener('load',()=>document.querySelector('.samii-logo')?.classList.add('show'));</script>
<h1>🎉 SAMii Lesson Payments Milestone Tracker 🎉</h1>
<div class="bar"><div class="fill"></div></div>
<div class="stats">
  <div>Total so far: <span class="highlight">${escape(o.grossText)}</span></div>
  <div>Remaining to $1M: <span class="highlight">${escape(o.remainingText)}</span></div>
  <div>Progress: <span class="highlight">${escape(o.percentText)}</span></div>
</div>${credit}
<footer style="margin:20px;color:#aaa">Updated automatically • SAMii.com.au</footer>

<div id="celebrate">
  <div class="massive">$1,000,000</div>
  ${o.latestPayment ? `<p class="credit">Milestone reached thanks to <strong>${escape(o.latestPayment.name)}</strong>!</p>` : ""}
  <div class="gifgrid">
    <img src="https://media1.giphy.com/media/5GoVLqeAOo6PK/giphy.gif">
    <img src="https://media3.giphy.com/media/hZj44bR9FVI3K/giphy.webp">
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
<script>
(function(){
 const params=new URLSearchParams(location.search);
 const demo=params.get('demo');
 const IS_HIT=${o.isHit?'true':'false'};
 const KEY='samii_seen_v1';
 function blast(){confetti({particleCount:160,spread:120,startVelocity:45,origin:{y:.6}});}
 function show(){const el=document.getElementById('celebrate');el.classList.add('show');blast();setTimeout(blast,600);}
 if(demo==='reset')localStorage.removeItem(KEY);
 if(IS_HIT||demo==='hit'){const seen=+localStorage.getItem(KEY)||0;if(seen<2){show();localStorage.setItem(KEY,seen+1);}}
})();
</script>
</body></html>`;
}

/* ====================== Utils ====================== */

function escape(s: string) {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c as any]));
}
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function text(s: string, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain" } });
}
function htmlResponse(s: string) {
  return new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function isAuthorised(url: URL, env: Env) {
  const token = url.searchParams.get("token") || "";
  return !!(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN);
}
