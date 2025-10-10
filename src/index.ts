interface Env { KV?: KVNamespace }

const TARGET = 1_000_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const demo = url.searchParams.get("demo");
    const gross = await safeGetGross(env);
    const remaining = Math.max(0, TARGET - gross);
    const percent = Math.min(100, (gross / TARGET) * 100);
    const isHit = gross >= TARGET || demo === "hit";

    const html = renderPage({
      title: "🎉 SAMii Lesson Payments Milestone Tracker 🎉",
      grossText: `A$${gross.toLocaleString()}`,
      remainingText: `A$${remaining.toLocaleString()}`,
      percentText: `${percent.toFixed(2)}%`,
      percentValue: percent,
      isHit,
    });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
};

async function safeGetGross(env: Env): Promise<number> {
  try {
    if (!env.KV || typeof env.KV.get !== "function") return 988100;
    const v = await env.KV.get("grossAud");
    return Number(v ?? "988100");
  } catch {
    return 988100;
  }
}

function renderPage(o: {
  title: string;
  grossText: string;
  remainingText: string;
  percentText: string;
  percentValue: number;
  isHit: boolean;
}) {
  const IS_HIT = o.isHit ? "true" : "false";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SAMii Lesson Payments Milestone Tracker</title>
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
body{
  margin:0;
  font-family:'Comfortaa',sans-serif;
  background:var(--dark-teal);
  color:var(--white);
  text-align:center;
  overflow-x:hidden;
}
h1{
  margin:30px 0 10px;
  font-size:clamp(24px,3vw,40px);
  background:linear-gradient(90deg,var(--mint),var(--light-teal));
  -webkit-background-clip:text;
  background-clip:text;
  color:transparent;
}
.samii-logo{
  display:block;
  margin:40px auto 20px;
  width:360px; /* doubled from 180px */
  max-width:90vw;
  transition:transform 0.6s ease-in-out, opacity 1s ease-in-out;
  opacity:0;
}
.samii-logo.show{
  transform:scale(1.1);
  opacity:1;
}
.bar{
  width:min(860px,92vw);
  height:32px;
  margin:40px auto 20px;
  background:rgba(255,255,255,.18);
  border-radius:20px;
  overflow:hidden;
}
.fill{
  height:100%;
  width:${o.percentValue.toFixed(2)}%;
  background:linear-gradient(90deg,var(--blue-teal),var(--mint));
  border-radius:20px;
  transition:width .5s ease-out;
}
.stats{color:var(--silver);font-size:20px;line-height:1.8}
.highlight{color:var(--mint);font-weight:700}
footer{margin:30px 0 10px;color:var(--silver);font-size:14px}
#celebrate{
  position:fixed;
  inset:0;
  display:none;
  align-items:center;
  justify-content:center;
  background:rgba(0,0,0,.72);
  z-index:50;
  flex-direction:column;
  padding:20px;
}
#celebrate.show{display:flex;animation:fadein .5s ease-out}
.massive{
  font-size:clamp(60px,12vw,160px);
  font-weight:700;
  color:var(--mint);
  text-shadow:0 0 20px var(--light-teal),0 0 40px var(--mint);
  animation:flash 1s infinite alternate;
  margin-bottom:20px;
}
.sound-btn{
  margin:10px 0 0;
  background:var(--mint);
  color:#042016;
  border:none;
  padding:10px 16px;
  border-radius:999px;
  font-weight:700;
  cursor:pointer;
  display:none;
}
.sound-btn.show{display:inline-block}
.gifgrid{
  display:flex;
  flex-wrap:wrap;
  justify-content:center;
  gap:20px;
  margin-top:20px;
}
.gifgrid img{
  width:320px;
  max-width:90vw;
  border-radius:12px;
  box-shadow:0 6px 24px rgba(0,0,0,.35);
}
@keyframes flash{0%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
@keyframes fadein{from{opacity:0}to{opacity:1}}
</style>
</head>
<body>
<img class="samii-logo" src="https://cdn.prod.website-files.com/6642ff26ca1cac64614e0e96/6642ff6de91fa06b733c39c6_SAMii-p-500.png" alt="SAMii logo">
<script>
  window.addEventListener('load', ()=>{
    document.querySelector('.samii-logo')?.classList.add('show');
  });
</script>

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

// ---- audio ----
let audioCtx;
function ensureAudioCtx(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') return audioCtx.resume();
  return Promise.resolve();
}

function playFanfare(){
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const notes = [261.63, 392.00, 523.25];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i*0.05);
    gain.gain.exponentialRampToValueAtTime(0.5, now + i*0.05 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7 + i*0.02);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + i*0.05);
    osc.stop(now + 0.8 + i*0.02);
  });
}

function playApplause(){
  if (!audioCtx) return;
  const dur = 1.6;
  const rate = audioCtx.sampleRate;
  const buffer = audioCtx.createBuffer(1, rate * dur, rate);
  const data = buffer.getChannelData(0);
  for (let i=0;i<data.length;i++){
    const t = i/data.length;
    data[i] = (Math.random()*2-1)*(1-t)*0.7;
  }
  const src = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  gain.gain.value = 0.25;
  src.buffer = buffer;
  src.connect(gain).connect(audioCtx.destination);
  src.start();
}

async function playCelebrationAudio(){
  try {
    await ensureAudioCtx();
    playFanfare();
    setTimeout(playApplause, 300);
    return true;
  } catch(e){ return false; }
}

function showCelebrate(){
  const el = document.getElementById('celebrate');
  const btn = document.getElementById('soundBtn');
  el.classList.add('show');
  playCelebrationAudio().then(ok => { if (!ok) btn.classList.add('show'); });
  btn.addEventListener('click', async ()=>{ const ok = await playCelebrationAudio(); if (ok) btn.classList.remove('show'); });
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('show'); });
}

(function main(){
  if (IS_HIT || demo==='hit'){
    const seen = Number(localStorage.getItem(KEY)||0);
    if (seen < 2){
      showCelebrate();
      fireConfetti();
      localStorage.setItem(KEY,String(seen+1));
    }
  }
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}
