// SAMii Lesson Payments Milestone Tracker (KV-safe)
interface Env { KV?: KVNamespace }

const TARGET = 1_000_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const demo = url.searchParams.get("demo");

    const gross = await safeGetGross(env);                    // <-- safe even if KV missing
    const remaining = Math.max(0, TARGET - gross);
    const percent = Math.min(100, (gross / TARGET) * 100);
    const isHit = gross >= TARGET || demo === "hit";

    // JSON status
    if (url.pathname === "/progress") {
      return json({
        currency: "AUD",
        gross_aud: round2(gross),
        remaining_to_million_aud: round2(remaining),
        percent: round2(percent),
        milestone_hit: isHit
      });
    }

    // simple dashboard
    const htmlDoc = renderPage({
      title: "🎉 SAMii Lesson Payments Milestone Tracker 🎉",
      grossText: `A$${gross.toLocaleString()}`,
      remainingText: `A$${remaining.toLocaleString()}`,
      percentText: `${percent.toFixed(2)}%`,
      percentValue: percent,
      isHit,
    });

    return new Response(htmlDoc, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
};

// ---------- helpers ----------
function round2(n: number) { return Math.round(n * 100) / 100; }
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type":"application/json" }});
}
async function safeGetGross(env: Env): Promise<number> {
  try {
    if (!env.KV || typeof env.KV.get !== "function") return 988100; // fallback value
    const v = await env.KV.get("grossAud");
    return Number(v ?? "988100");
  } catch { return 988100; }
}

// Build HTML (SAMii colours + Comfortaa + demo confetti)
function renderPage(o: { title: string; grossText: string; remainingText: string; percentText: string; percentValue: number; isHit: boolean; }) {
  const IS_HIT = o.isHit ? "true" : "false";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAMii Lesson Payments Milestone Tracker</title>
<link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--dark-teal:#0d3447;--blue-teal:#0d6694;--light-teal:#4791B8;--mint:#3CC99F;--white:#fff;--silver:#e0dfdf}
*{box-sizing:border-box}
body{margin:0;font-family:'Comfortaa',system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--dark-teal);color:var(--white);text-align:center}
h1{margin:40px 0 20px;font-size:clamp(24px,3vw,40px);background:linear-gradient(90deg,var(--mint),var(--light-teal));-webkit-background-clip:text;background-clip:text;color:transparent}
.bar{width:min(860px,92vw);height:32px;margin:40px auto 20px;background:rgba(255,255,255,.18);border-radius:20px;overflow:hidden;box-shadow:0 0 12px rgba(0,0,0,.35) inset}
.fill{height:100%;width:${o.percentValue.toFixed(2)}%;background:linear-gradient(90deg,var(--blue-teal),var(--mint));border-radius:20px;transition:width .5s ease-out}
.stats{color:var(--silver);font-size:20px;line-height:1.8}
.highlight{color:var(--mint);font-weight:700}
#celebrate{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.7);z-index:50}
#celebrate.show{display:flex}
.gifgrid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:1000px;padding:20px}
.gifgrid img{width:100%;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
footer{margin:46px 0 24px;color:var(--silver);font-size:14px}
</style>
</head>
<body>
<h1>${escapeHtml(o.title)}</h1>
<div class="bar"><div class="fill"></div></div>
<div class="stats">
  <div>Total so far: <span class="highlight">${escapeHtml(o.grossText)}</span></div>
  <div>Remaining to $1M: <span class="highlight">${escapeHtml(o.remainingText)}</span></div>
  <div>Progress: <span class="highlight">${escapeHtml(o.percentText)}</span></div>
</div>
<footer>Updated automatically with Stripe • SAMii.com.au</footer>

<div id="celebrate" aria-hidden="true">
  <div class="gifgrid">
    <img src="https://media.giphy.com/media/5GoVLqeAOo6PK/giphy.gif" alt="Confetti">
    <img src="https://media.giphy.com/media/3o6Zt6ML6BklcajjsA/giphy.gif" alt="Party">
    <img src="https://media.giphy.com/media/l0Exk8EUzSLsrErEQ/giphy.gif" alt="Fireworks">
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
<script>
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');
  const IS_HIT = ${IS_HIT};
  const KEY = 'samii_milestone_seen_v1';
  if (demo==='reset') localStorage.removeItem(KEY);
  if (IS_HIT || demo==='hit') {
    const seen = Number(localStorage.getItem(KEY)||0);
    if (seen < 2) {
      const el = document.getElementById('celebrate');
      el.classList.add('show');
      el.addEventListener('click',()=>el.classList.remove('show'));
      const blast = ()=>confetti({particleCount:140,spread:100,startVelocity:45,origin:{y:0.6}});
      blast(); setTimeout(blast,600); setTimeout(blast,1200);
      localStorage.setItem(KEY,String(seen+1));
    }
  }
</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] as string));
}
