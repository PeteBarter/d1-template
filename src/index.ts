/* src/index.ts – Static SAMii milestone page served by a Worker */
export default {
  async fetch(_req: Request): Promise<Response> {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SAMii • Lesson Payments Milestone Tracker (Static)</title>
  <link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg:#0e2a33;
      --card:#0f3340;
      --text:#e9f5f4;
      --muted:#bfe7e2;
      --accent:#2cd3b8;
      --accent2:#12a8a8;
      --barStart:#0d6aa2;
      --barEnd:#19d39d;
      --glow: 0 10px 40px rgba(25, 211, 157, .35);
    }
    * { box-sizing: border-box; }
    html, body { height:100%; }
    body{
      margin:0;
      font-family: 'Comfortaa', system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji","Segoe UI Emoji";
      background: radial-gradient(1200px 800px at 80% -10%, #174354 0%, var(--bg) 45%) fixed,
                  radial-gradient(1000px 700px at -10% 120%, #143745 0%, var(--bg) 50%) fixed,
                  var(--bg);
      color:var(--text);
      display:flex;
      align-items:center;
      justify-content:center;
      padding:40px 16px;
    }
    .wrap{
      width:min(1000px, calc(100% - 24px));
      text-align:center;
    }
    .logo img {
      width: clamp(360px, 70vw, 600px);
      margin-bottom: 10px;
    }
    .sub{
      margin: 4px 0 26px;
      font-size: clamp(18px, 2.2vw, 28px);
      color: var(--muted);
      display:flex;
      align-items:center;
      justify-content:center;
      gap:10px;
    }
    .bar{
      position:relative;
      height: 22px;
      background: linear-gradient(180deg, #0c4055, #0a3446);
      border-radius: 16px;
      padding: 4px;
      box-shadow: inset 0 2px 10px rgba(0,0,0,.45);
    }
    .bar > .fill{
      height: 100%;
      width: 0%;
      border-radius: 12px;
      background: linear-gradient(90deg, var(--barStart), var(--barEnd));
      box-shadow: var(--glow);
      transition: width 900ms ease-in-out;
    }
    .numbers{
      margin: 26px 0 18px;
      line-height: 1.9;
      font-size: clamp(18px, 2vw, 24px);
    }
    .numbers b{ color: var(--accent); font-weight:700; }
    .footer{
      margin-top: 22px;
      color: #9fd1c9;
      font-size: 14px;
      opacity:.9;
    }
    .celebrate{
      position: fixed; inset: 0; display:none; place-items: center;
      background: rgba(0,0,0,.35); z-index: 10; pointer-events: none;
    }
    .celebrate .card{
      background: linear-gradient(180deg, #0f3a48, #0e2f3a);
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 18px;
      padding: 22px 18px; width:min(560px, 92vw); text-align:center;
      box-shadow: 0 30px 80px rgba(0,0,0,.45), var(--glow);
      animation: pop .6s ease-out both;
    }
    .celebrate h2{ margin: 8px 0 6px; font-size: clamp(22px, 3vw, 30px); }
    .celebrate p{ margin: 0 0 8px; color:var(--muted) }
    .celebrate .badge{
      font-size: clamp(26px, 4vw, 40px); font-weight: 700; letter-spacing:.04em;
      color: #d6fff5; text-shadow: 0 6px 30px rgba(25,211,157,.45);
    }
    @keyframes pop{ from{ transform: translateY(8px) scale(.98); opacity: 0; } to{ transform:none; opacity: 1; } }
    #confetti{ position: fixed; inset: 0; z-index: 9; pointer-events:none; display:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">
      <img src="https://cdn.prod.website-files.com/6642ff26ca1cac64614e0e96/6642ff6de91fa06b733c39c6_SAMii-p-500.png" alt="SAMii logo" />
    </div>
    <div class="sub">🎉 <span>Lesson Payments Milestone Tracker</span> 🎉</div>
    <div class="bar" aria-label="Progress to A$1,000,000">
      <div class="fill" id="fill" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
    </div>
    <div class="numbers" id="numbers"></div>
    <div class="footer">Updated manually • SAMii.com.au</div>
  </div>

  <canvas id="confetti"></canvas>
  <div class="celebrate" id="celebrate">
    <div class="card">
      <div style="font-size:42px" aria-hidden="true">🥳🎊</div>
      <h2>Milestone reached!</h2>
      <div class="badge">A$1,000,000+</div>
      <p>Massive congrats to every educator, parent and supporter.</p>
    </div>
  </div>

  <script>
    const TOTAL_AUD = 998_500; // update manually each morning
    const TARGET = 1_000_000;

    function fmtAUD(n){
      return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);
    }
    function fmtPct(n){ return n.toFixed(2) + '%'; }

    const numbers = document.getElementById('numbers');
    const fill = document.getElementById('fill');

    const progress = Math.max(0, Math.min(1, TOTAL_AUD / TARGET));
    const remaining = Math.max(0, TARGET - TOTAL_AUD);

    numbers.innerHTML = [
      \`Total so far: <b>\${fmtAUD(TOTAL_AUD)}</b>\`,
      \`Remaining to $1M: <b>\${fmtAUD(remaining)}</b>\`,
      \`Progress: <b>\${fmtPct(progress * 100)}</b>\`
    ].join('<br/>');

    fill.style.width = (progress * 100) + '%';
    fill.setAttribute('aria-valuenow', (progress * 100).toFixed(2));

    if (TOTAL_AUD >= TARGET) celebrate();

    function celebrate(){
      const overlay = document.getElementById('celebrate');
      const canvas = document.getElementById('confetti');
      overlay.style.display = 'grid';
      canvas.style.display = 'block';
      const ctx = canvas.getContext('2d');
      const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      let W, H, running = true;
      let pieces = [];
      const colours = ['#ffffff','#b0fff0','#8ef0d8','#5ee0d0','#1ad1a4','#19b9c8','#0aa2cf','#68f9d2'];

      function resize(){
        W = canvas.width = Math.floor(window.innerWidth * DPR);
        H = canvas.height = Math.floor((window.innerHeight) * DPR);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      }
      window.addEventListener('resize', resize, { passive:true });
      resize();

      function spawn(n){
        for (let i=0; i<n; i++){
          const w = 6 + Math.random()*10;
          const h = 8 + Math.random()*14;
          pieces.push({
            x: Math.random()*W, y: -20, w, h,
            a: Math.random()*Math.PI*2,
            v: { x: (Math.random() - .5) * 1.2, y: 1.5 + Math.random()*2.5 },
            rot: (Math.random() - .5) * .2,
            col: colours[(Math.random()*colours.length)|0]
          });
        }
      }

      function step(){
        if (!running) return;
        ctx.clearRect(0,0,W,H);
        spawn(6);
        for (const p of pieces){
          p.v.y += 0.02;
          p.x += p.v.x * DPR;
          p.y += p.v.y * DPR;
          p.a += p.rot;
        }
        for (const p of pieces){
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
          ctx.fillStyle = p.col; ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
          ctx.restore();
        }
        pieces = pieces.filter(p => p.y < H + 40);
        requestAnimationFrame(step);
      }
      step();
      setTimeout(() => { running = false; }, 80000);
    }
  </script>
</body>
</html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
};
