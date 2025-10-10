export default {
  async fetch(request, env) {
    const TARGET = 1_000_000;
    const url = new URL(request.url);
    const demo = url.searchParams.get("demo");
    const KV = env.KV;

    async function getGross() {
      return Number((await KV.get("grossAud")) || "988100");
    }

    const gross = await getGross();
    const remaining = Math.max(0, TARGET - gross);
    const percent = Math.min(100, (gross / TARGET) * 100);
    const isHit = gross >= TARGET || demo === "hit";

    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SAMii Lesson Payments Milestone Tracker</title>
<link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --dark-teal: #0d3447;
    --blue-teal: #0d6694;
    --light-teal: #4791B8;
    --mint: #3CC99F;
  }
  body {
    margin:0;
    font-family:'Comfortaa',sans-serif;
    background:var(--dark-teal);
    color:white;
    text-align:center;
  }
  h1 {
    margin:40px 0 20px;
    font-size:2rem;
    background:linear-gradient(90deg,var(--mint),var(--light-teal));
    -webkit-background-clip:text;
    color:transparent;
  }
  .bar {
    width:90%;
    max-width:800px;
    height:30px;
    margin:40px auto;
    background:rgba(255,255,255,0.15);
    border-radius:20px;
    overflow:hidden;
  }
  .fill {
    height:100%;
    width:${percent.toFixed(2)}%;
    background:linear-gradient(90deg,var(--blue-teal),var(--mint));
    transition:width 0.5s;
  }
  .stats{font-size:20px;margin:20px;}
  .highlight{color:var(--mint);}
  #celebrate{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);align-items:center;justify-content:center;z-index:10;}
  #celebrate.show{display:flex;}
  .gifgrid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));max-width:800px;}
  .gifgrid img{width:100%;border-radius:10px;}
</style>
</head>
<body>
  <h1>🎉 SAMii Lesson Payments Milestone Tracker 🎉</h1>
  <div class="bar"><div class="fill"></div></div>
  <div class="stats">
    <div>Total so far: <span class="highlight">A$${gross.toLocaleString()}</span></div>
    <div>Remaining to $1M: <span class="highlight">A$${remaining.toLocaleString()}</span></div>
    <div>Progress: <span class="highlight">${percent.toFixed(2)}%</span></div>
  </div>

  <div id="celebrate">
    <div class="gifgrid">
      <img src="https://media.giphy.com/media/5GoVLqeAOo6PK/giphy.gif">
      <img src="https://media.giphy.com/media/3o6Zt6ML6BklcajjsA/giphy.gif">
      <img src="https://media.giphy.com/media/l0Exk8EUzSLsrErEQ/giphy.gif">
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
  <script>
    const IS_HIT = ${isHit};
    const params = new URLSearchParams(location.search);
    const demo = params.get('demo');
    const KEY = 'samii_milestone_seen_v1';
    if (demo === 'reset') localStorage.removeItem(KEY);

    if ((IS_HIT || demo === 'hit')) {
      const seen = Number(localStorage.getItem(KEY) || 0);
      if (seen < 2) {
        const overlay = document.getElementById('celebrate');
        overlay.classList.add('show');
        overlay.addEventListener('click',()=>overlay.classList.remove('show'));
        const fire = () => confetti({particleCount:120,spread:100,origin:{y:0.6}});
        fire(); setTimeout(fire,600); setTimeout(fire,1200);
        localStorage.setItem(KEY, seen+1);
      }
    }
  </script>
</body>
</html>`, {
      headers: { "content-type": "text/html" }
    });
  }
};
