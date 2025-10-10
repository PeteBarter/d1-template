/* src/index.ts
   SAMii Milestone Tracker + Stripe Webhook (Workers)
   - KV key "grossAud" (optional) stores running AUD total (fallback=988100)
   - KV key "latest_payment" stores {name, amount, created}
*/

interface Env {
  SAMII_KV: KVNamespace;           // KV binding (required)
  STRIPE_WEBHOOK_SECRET: string;   // whsec_… (required for webhook)
}

const TARGET = 1_000_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Stripe webhook endpoint
    if (url.pathname === "/stripe-webhook" && req.method === "POST") {
      return handleStripeWebhook(req, env);
    }

    // (Optional tiny JSON endpoint to help debugging)
    if (url.pathname === "/latest-payment") {
      const lp = await getLatestPayment(env);
      return new Response(JSON.stringify(lp ?? {}), {
        headers: { "content-type": "application/json" },
      });
    }

    // Main page
    const demo = url.searchParams.get("demo");
    const gross = await safeGetGross(env); // AUD total
    const remaining = Math.max(0, TARGET - gross);
    const percent = Math.min(100, (gross / TARGET) * 100);
    const isHit = gross >= TARGET || demo === "hit";
    const latestPayment = await getLatestPayment(env); // {name, amount, created} | null

    const html = renderPage({
      title: "🎉 SAMii Lesson Payments Milestone Tracker 🎉",
      grossText: `A$${gross.toLocaleString()}`,
      remainingText: `A$${remaining.toLocaleString()}`,
      percentText: `${percent.toFixed(2)}%`,
      percentValue: percent,
      isHit,
      latestPayment,
    });

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};

/* ----------------------------- Data helpers ----------------------------- */

async function safeGetGross(env: Env): Promise<number> {
  try {
    const v = await env.SAMII_KV.get("grossAud");
    // If you don’t maintain gross in KV yet, this fallback keeps the page working.
    return Number(v ?? "988100");
  } catch {
    return 988100;
  }
}

async function getLatestPayment(env: Env): Promise<null | { name: string; amount: number; created: string }> {
  try {
    const raw = await env.SAMII_KV.get("latest_payment");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* ----------------------------- HTML renderer ---------------------------- */

function renderPage(o: {
  title: string;
  grossText: string;
  remainingText: string;
  percentText: string;
  percentValue: number;
  isHit: boolean;
  latestPayment: null | { name: string; amount: number; created: string };
}) {
  const IS_HIT = o.isHit ? "true" : "false";
  const creditHtml = o.latestPayment
    ? `<p style="font-size:22px;color:var(--mint);margin:10px 0 0;">
         Milestone reached thanks to
         <strong>${escapeHtml(o.latestPayment.name || "Unknown")}</strong>
         for A$${Number(o.latestPayment.amount || 0).toFixed(2)}!
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
:root{
  --dark-teal:#0d3447;
  --blue-teal:#0d6694;
  --light-teal:#4791B8;
  --mint:#3CC99F;
  --white:#ffffff;
  --silver:#e0dfdf;
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--dark-teal);color:var(--white);
  font-family:'Comfortaa',sans-serif;text-align:center;overflow-x:hidden;
}
.samii-logo{
  display:block;margin:40px auto 20px;width:360px;max-width:90vw;
  transition:transform .6s ease,opacity .8s ease;opacity:0;
}
.samii-logo.show{transform:scale(1.1);opacity:1}
h1{
  margin:10px 0 0;font-size:clamp(24px,3vw,40px);
  background:linear-gradient(90deg,var(--mint),var(--light-teal));
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.bar{
  width:min(860px,92vw);height:32px;margin:40px auto 20px;
  background:rgba(255,255,255,.18);border-radius:20px;overflow:hidden;
}
.fill{
  height:100%;width:${o.percentValue.toFixed(2)}%;
  background:linear-gradient(90deg,var(--blue-teal),var(--mint));
  border-radius:20px;transition:width .5s ease;
}
.stats{color:var(--silver);font-size:20px;line-height:1.8}
.highlight{color:var(--mint);font-weight:700}
footer{margin:30px 0 10px;color:var(--silver);font-size:14px}
#celebrate{
  position:fixed;inset:0;display:none;align-items:center;justify-content:center;
  background:rgba(0,0,0,.72);z-index:50;flex-direction:column;padding:20px;
}
#celebrate.show{display:flex;animation:fadein .4s ease-out}
.massive{
  font-size:clamp(60px,12vw,160px);font-weight:700;color:var(--mint);
  text-shadow:0 0 20px var(--light-teal),0 0 40px var(--mint);
  animation:flash 1s infinite alternate;margin:0 0 16px;
}
.sound-btn{
  margin:10px 0 0;background:var(--mint);color:#042016;border:none;
  padding:10px 16px;border-radius:999px;font-weight:700;cursor:pointer;display:none;
}
.sound-btn.show{display:inline-block}
.gifgrid{
  display:flex;flex-wrap:wrap;justify-content:center;gap:20px;margin-top:18px;
}
.gifgrid img{
  width:320px;max-width:90vw;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);
}
@keyframes flash{0%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
</style>
</head>
<body>
<img class="samii-logo" src="https://cdn.prod.website-files.com/6642ff26ca1cac64614e0e96/6642ff6de91fa06b733c39c6_SAMii-p-500.png" alt="SAMii logo">
<script>addEventListener('load',()=>document.querySelector('.samii-logo')?.classList.add('show'));</script>

<h1>${escapeHtml(o.title)}</h1>
<div class="bar"><div class="fill"></div></div>
<div class="stats">
  <div>Total so far: <span class="highlight">${escapeHtml(o.grossText)}</span></div>
  <div>Remaining to $1M: <span class="highlight">${escapeHtml(o.remainingText)}</span></div>
  <div>Progress: <span class="highlight">${escapeHtml(o.percentText)}</span></div>
</div>
<footer>Updated automatically with Stripe • SAMii.com.au</footer>

<div id="celebrate" aria-hidden="true">
  <div class="massive">$1,000,000</div>
  ${creditHtml}
  <button id="soundBtn" class="sound-btn" type="button">Tap for sound 🔊</button>
  <div class="gifgrid">
    <img src="https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExNjAwc3R1azZ6b280MzkybjF4ZHUzOGc1em85NjUyc3lkZjgxYzNiayZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/5GoVLqeAOo6PK/giphy.gif" alt="Confetti celebration">
    <img src="https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExZXowbGZzZGc0bWNtZTR3eDFlcnE5NW9ia3Z4c2lsaDZib20ydnlkYiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/hZj44bR9FVI3K/giphy.webp" alt="Fireworks">
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
<script>
const params = new URLSearchParams(location.search);
const demo = params.get('demo');
const IS_HIT = ${IS_HIT};
const KEY = 'samii_milestone_seen_v1';
if (demo==='reset') localStorage.removeItem(KEY);

function fireConfetti(){
  const blast = () => confetti({particleCount:160,spread:120,startVelocity:45,origin:{y:0.6}});
  blast(); setTimeout(blast,600); setTimeout(blast,1200);
}

// Real audio files (CDN, CC-licensed)
function playAudioFiles() {
  const fanfare = new Audio("https://cdn.pixabay.com/download/audio/2022/03/15/audio_2c9aef3ec2.mp3?filename=trumpet-fanfare-117277.mp3");
  const applause = new Audio("https://cdn.pixabay.com/download/audio/2022/03/15/audio_9e84f17b6a.mp3?filename=small-crowd-applause-117084.mp3");
  fanfare.volume = 0.8; applause.volume = 0.6;
  fanfare.play().then(()=>{ setTimeout(()=>applause.play(), 1800); }).catch(()=>{
    const btn = document.getElementById('soundBtn');
    if (btn) {
      btn.classList.add('show');
      btn.onclick = ()=>{ fanfare.play(); setTimeout(()=>applause.play(),1800); btn.classList.remove('show'); };
    }
  });
}

function showCelebrate(){
  const el = document.getElementById('celebrate');
  el.classList.add('show');
  fireConfetti();
  playAudioFiles();
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('show'); });
}

(function main(){
  if (IS_HIT || demo==='hit'){
    const seen = Number(localStorage.getItem(KEY)||0);
    if (seen < 2){
      showCelebrate();
      localStorage.setItem(KEY,String(seen+1));
    }
  }
})();
</script>
</body>
</html>`;
}

/* ----------------------------- Utilities ----------------------------- */

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

/* -------------------------- Stripe Webhook --------------------------- */
/* Writes latest payer info to KV: key "latest_payment" */

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  const rawBody = await req.text();
  const sigHeader = req.headers.get("Stripe-Signature") || "";

  try {
    await verifyStripeSignatureAsync(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return new Response("Signature verification failed", { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(rawBody); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object || {};
      const name = s.customer_details?.name || s.customer?.name || "Unknown";
      const amount = (s.amount_total ?? 0) / 100;
      const createdISO = (event.created ? new Date(event.created * 1000) : new Date()).toISOString();
      await env.SAMII_KV.put("latest_payment", JSON.stringify({ name, amount, created: createdISO }));
    }

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object || {};
      const amount = (pi.amount_received ?? pi.amount ?? 0) / 100;
      const latestCharge = pi.charges?.data?.[0];
      const name = latestCharge?.billing_details?.name || pi.shipping?.name || "Unknown";
      const createdISO = (event.created ? new Date(event.created * 1000) : new Date()).toISOString();
      await env.SAMII_KV.put("latest_payment", JSON.stringify({ name, amount, created: createdISO }));
    }
  } catch {
    return new Response("KV write failed", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

/* -------- Signature verification (Web Crypto, async) -------- */

async function verifyStripeSignatureAsync(
  rawBody: string,
  sigHeader: string,
  endpointSecret: string,
  toleranceSeconds = 300
) {
  const pairs = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const [k, v] = p.split("="); return [k, v];
    })
  );
  const t = Number(pairs["t"]);
  const v1 = pairs["v1"];
  if (!t || !v1) throw new Error("Bad Stripe-Signature header");

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) throw new Error("Timestamp outside tolerance");

  const signedPayload = `${t}.${rawBody}`;
  const expectedHex = await hmacSHA256Async(endpointSecret, signedPayload);
  if (!timingSafeEqualHex(expectedHex, v1)) throw new Error("Signature mismatch");
}

async function hmacSHA256Async(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}
