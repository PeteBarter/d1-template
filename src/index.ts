/* src/index.ts — SAMii Milestone Tracker with Celebration Overlay */

interface Env {
  MILESTONE_KV: KVNamespace;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_TOKEN?: string;
}

const TARGET_AUD = 1_000_000;
const GROSS_KEY = "total_cents";
const LATEST_KEY = "latest_payment";
const DEDUPE_PREF = "evt:";

/* ========================================================== */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/__diag") {
      try {
        await env.MILESTONE_KV.get("ping");
        return json({ ok: true });
      } catch (e: any) {
        return json({ ok: false, error: e?.message || e }, 500);
      }
    }

    if (url.pathname === "/latest-payment") {
      const lp = await getLatestPayment(env);
      return json(lp ?? {});
    }

    if (url.pathname === "/stripe-webhook" && req.method === "POST") {
      return handleStripeWebhook(req, env);
    }

    if (url.pathname === "/admin/set-latest") {
      if (!isAuthorised(url, env)) return text("unauthorised", 401);
      const name = (url.searchParams.get("name") || "Test").slice(0, 100);
      const amount = Number(url.searchParams.get("amount") || 42);
      await env.MILESTONE_KV.put(
        LATEST_KEY,
        JSON.stringify({ name, amount, created: new Date().toISOString() })
      );
      return text("ok");
    }

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
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e: any) {
      console.error(e);
      return text("Render error", 500);
    }
  },
};

/* ========================= KV Utils ========================= */

async function readGrossAud(env: Env) {
  const raw = (await env.MILESTONE_KV.get(GROSS_KEY)) ?? "0";
  const cents = parseInt(raw, 10) || 0;
  return Math.round(cents / 100);
}

async function addCents(env: Env, cents: number) {
  const raw = (await env.MILESTONE_KV.get(GROSS_KEY)) ?? "0";
  const current = parseInt(raw, 10) || 0;
  await env.MILESTONE_KV.put(GROSS_KEY, String(current + cents));
}

async function getLatestPayment(env: Env) {
  const raw = await env.MILESTONE_KV.get(LATEST_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function markProcessed(env: Env, eventId: string) {
  const key = DEDUPE_PREF + eventId;
  if (await env.MILESTONE_KV.get(key)) return false;
  await env.MILESTONE_KV.put(key, "1", { expirationTtl: 60 * 60 * 24 * 14 });
  return true;
}

/* ==================== Stripe Webhook Logic ==================== */

async function handleStripeWebhook(req: Request, env: Env) {
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";

  try {
    await verifyStripeSignatureAsync(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET, 1800);
  } catch (err: any) {
    console.log("Stripe verification failed:", err.message);
    return text("Signature verification failed", 400);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return text("Invalid JSON", 400);
  }

  const eventId = event.id;
  if (!eventId) return text("Missing id", 400);
  if (!(await markProcessed(env, eventId))) return text("duplicate", 200);

  if (event.type === "charge.succeeded") {
    const ch = event.data.object;
    const cents = ch.amount || 0;
    if (ch.currency?.toLowerCase() === "aud") await addCents(env, cents);
    const name = ch.billing_details?.name || "Unknown";
    const amountAud = (cents / 100).toFixed(2);
    const created = new Date(event.created * 1000).toISOString();
    await env.MILESTONE_KV.put(LATEST_KEY, JSON.stringify({ name, amount: amountAud, created }));
    return text("ok");
  }

  return text("ignored", 200);
}

/* =================== Signature Verification =================== */

async function verifyStripeSignatureAsync(
  rawBody: string,
  sigHeader: string,
  secret: string,
  toleranceSeconds = 300
) {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.split("=") as [string, string])
  );
  const t = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!t || !v1) throw new Error("Invalid header");

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) throw new Error("Expired timestamp");

  const signedPayload = `${t}.${rawBody}`;
  const expected = await hmacSHA256(secret, signedPayload);
  if (!timingSafeEqual(expected, v1)) throw new Error("Signature mismatch");
}

async function hmacSHA256(secret: string, data: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

/* ==================== Page Rendering ==================== */

function renderPage(o: {
  grossText: string;
  remainingText: string;
  percentText: string;
  percentValue: number;
  isHit: boolean;
  latestPayment: null | { name: string; amount: number; created: string };
}) {
  const creditHtml = o.latestPayment
    ? `<p class="credit">Latest payment from <strong>${escapeHtml(o.latestPayment.name)}</strong> for A$${Number(o.latestPayment.amount).toFixed(2)}.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAMii Milestone</title>
<link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--dark-teal:#0d3447;--blue-teal:#0d6694;--light-teal:#4791B8;--mint:#3CC99F;--white:#fff;--silver:#e0dfdf}
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

<div id="celebrate">
  <div class="massive">$1,000,000</div>
  <p class="credit">Milestone reached 🎊</p>
  <div class="gifgrid">
    <img src="https://media1.giphy.com/media/5GoVLqeAOo6PK/giphy.gif">
    <img src="https://media3.giphy.com/media/hZj44bR9FVI3K/giphy.webp">
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
<script>
(function(){
  const demo = new URLSearchParams(location.search).get('demo');
  const IS_HIT = ${o.isHit ? "true" : "false"};
  const KEY='samii_milestone_seen_v1';
  function conf(){const fire=()=>confetti({particleCount:160,spread:120,startVelocity:45,origin:{y:0.6}});fire();setTimeout(fire,600);setTimeout(fire,1200);}
  function show(){document.getElementById('celebrate').classList.add('show');conf();}
  if(demo==='reset')localStorage.removeItem(KEY);
  if(IS_HIT||demo==='hit'){const s=Number(localStorage.getItem(KEY)||0);if(s<2){show();localStorage.setItem(KEY,String(s+1));}}
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c as any])
  );
}

/* ================= Utils ================= */

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(s: string, status = 200) {
  return new Response(s, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function isAuthorised(url: URL, env: Env) {
  const token = url.searchParams.get("token");
  return !!(env.ADMIN_TOKEN && token && token === env.ADMIN_TOKEN);
}
