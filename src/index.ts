// SAMii Stripe Milestone Tracker – Cloudflare Worker
// Endpoints:
//   GET  /                 -> Public dashboard (progress bar, confetti+GIFs on milestone)
//   GET  /progress         -> JSON (gross, remaining, percent, milestone info)
//   POST /init?value=NNN   -> Seed starting total in AUD (one-off or manual adjust)
//   POST /stripe-webhook   -> Stripe sends charge.succeeded events here
//
// Requirements:
//   - KV binding named: KV
//   - Secrets: STRIPE_WEBHOOK_SECRET (required), SLACK_WEBHOOK_URL (optional)

const TARGET = 1_000_000; // AUD

export default {
  // Cron optional: uncomment if you later add a scheduled summary
  // async scheduled(event, env, ctx) { /* see earlier message for daily 9am example */ },

  async fetch(request, env) {
    const url = new URL(request.url);

    // ---------- JSON API ----------
    if (url.pathname === "/progress" && request.method === "GET") {
      const gross = await getGross(env);
      const { milestone_hit_at, milestone_version } = await getMilestone(env);
      const remaining = Math.max(0, TARGET - gross);
      const percent = Math.min(100, (gross / TARGET) * 100);

      return json({
        currency: "AUD",
        gross_aud: round2(gross),
        remaining_to_million_aud: round2(remaining),
        percent: round2(percent),
        milestone_hit: gross >= TARGET,
        milestone_hit_at,
        milestone_version
      });
    }

    // ---------- One-off initialiser ----------
    if (url.pathname === "/init" && request.method === "POST") {
      const value = Number(url.searchParams.get("value") || "0");
      await env.KV.put("grossAud", String(value));
      // reset milestone + alert flags
      await env.KV.delete("alert:10000");
      await env.KV.delete("alert:5000");
      await env.KV.delete("alert:1000");
      await env.KV.delete("alert:hit");
      await env.KV.delete("milestone_hit_at");
      await env.KV.delete("milestone_version");
      return text("initialised");
    }

    // ---------- Stripe webhook ----------
    if (url.pathname === "/stripe-webhook" && request.method === "POST") {
      const payload = await request.text();
      const sig = request.headers.get("stripe-signature") || "";
      const ok = await verifyStripe(payload, sig, env.STRIPE_WEBHOOK_SECRET);
      if (!ok) return text("bad signature", 400);

      const event = JSON.parse(payload);

      if (event.type === "charge.succeeded") {
        const obj = event.data?.object || {};
        if (obj.currency === "aud") {
          const inc = (obj.amount || 0) / 100; // dollars
          const prev = await getGross(env);
          const gross = prev + inc;
          await env.KV.put("grossAud", String(gross));

          // Alerts + milestone bookkeeping
          const remaining = TARGET - gross;
          if (gross >= TARGET && !(await env.KV.get("alert:hit"))) {
            await env.KV.put("alert:hit", "1");
            const hitAt = new Date().toISOString();
            const version = `1M-${hitAt}`;
            await env.KV.put("milestone_hit_at", hitAt);
            await env.KV.put("milestone_version", version);
            await postSlack(env.SLACK_WEBHOOK_URL, `🎉 SAMii just hit A$1,000,000 (now A$${gross.toFixed(2)})`);
          } else {
            if (remaining <= 10_000 && !(await env.KV.get("alert:10000"))) {
              await env.KV.put("alert:10000", "1");
              await postSlack(env.SLACK_WEBHOOK_URL, `⏳ Under 10k to go: A$${remaining.toFixed(2)}.`);
            }
            if (remaining <= 5_000 && !(await env.KV.get("alert:5000"))) {
              await env.KV.put("alert:5000", "1");
              await postSlack(env.SLACK_WEBHOOK_URL, `⏳ Under 5k to go: A$${remaining.toFixed(2)}.`);
            }
            if (remaining <= 1_000 && !(await env.KV.get("alert:1000"))) {
              await env.KV.put("alert:1000", "1");
              await postSlack(env.SLACK_WEBHOOK_URL, `⚡ Under 1k to go: A$${remaining.toFixed(2)}.`);
            }
          }
        }
      }

      return text("ok");
    }

    // ---------- Public dashboard (with confetti + GIFs on milestone) ----------
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const gross = await getGross(env);
      const remaining = Math.max(0, TARGET - gross);
      const percent = Math.min(100, (gross / TARGET) * 100);
      const { milestone_hit_at, milestone_version } = await getMilestone(env);
      const isHit = gross >= TARGET;

      return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SAMii Milestone Tracker</title>
  <meta property="og:title" content="SAMii is tracking to A$1,000,000" />
  <meta property="og:description" content="Live Stripe milestone tracker" />
  <meta name="theme-color" content="#7b5cff" />
  <style>
    :root { --bg:#0f1115; --fg:#f8f8f8; --muted:#b8b8b8; --bar:#333; }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
    .wrap{max-width:980px;margin:56px auto;padding:0 16px;text-align:center}
    h1{font-size:clamp(24px,3vw,40px);margin:8px 0 24px;background:linear-gradient(90deg,#a88bff,#ff77e1);-webkit-background-clip:text;background-clip:text;color:transparent}
    .bar{width:min(860px,92vw);height:28px;margin:28px auto;border-radius:18px;background:var(--bar);overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}
    .fill{height:100%;width:${percent.toFixed(2)}%;background:linear-gradient(90deg,#7b5cff,#ff6cfb)}
    .stats{margin:28px auto 8px;font-size:20px;line-height:1.7}
    .muted{color:var(--muted);font-size:14px;margin-top:28px}
    .badge{display:${isHit ? 'inline-block' : 'none'};margin-top:12px;background:#15c46a;color:#04130b;padding:8px 12px;border-radius:999px;font-weight:600}
    /* Celebration overlay */
    .celebrate{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:50;background:rgba(0,0,0,.6)}
    .celebrate.show{display:flex}
    .gifgrid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:1000px;padding:20px}
    .gifgrid img{width:100%;height:auto;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🎉 SAMii Stripe Milestone Tracker 🎉</h1>

    <div class="bar"><div class="fill"></div></div>

    <div class="stats">
      <div><strong>Total so far:</strong> A$${(gross).toLocaleString()}</div>
      <div><strong>Remaining to $1M:</strong> A$${(remaining).toLocaleString()}</div>
      <div><strong>Progress:</strong> ${percent.toFixed(2)}%</div>
      <div class="badge">A$1,000,000 reached ${milestone_hit_at ? 'on ' + new Date(milestone_hit_at).toLocaleString() : ''}</div>
    </div>

    <div class="muted">Updated automatically with Stripe • SAMii.com.au</div>
  </div>

  <!-- Celebration overlay -->
  <div id="celebrate" class="celebrate" aria-hidden="true">
    <div class="gifgrid">
      <!-- Replace these with your own GIFs if you like -->
      <img src="https://media.giphy.com/media/5GoVLqeAOo6PK/giphy.gif" alt="Confetti celebration">
      <img src="https://media.giphy.com/media/3o6Zt6ML6BklcajjsA/giphy.gif" alt="Party time">
      <img src="https://media.giphy.com/media/l0Exk8EUzSLsrErEQ/giphy.gif" alt="Fireworks">
    </div>
  </div>

  <!-- Confetti -->
  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
  <script>
    (function(){
      const IS_HIT = ${isHit ? 'true' : 'false'};
      const VERSION = ${JSON.stringify((await getMilestone(env)).milestone_version || "none")};
      const OVERLAY = document.getElementById('celebrate');

      if (IS_HIT && VERSION && VERSION !== "none") {
        const key = 'samii_milestone_seen_' + VERSION;
        const seen = Number(localStorage.getItem(key) || '0');

        if (seen < 2) {
          OVERLAY.classList.add('show');
          OVERLAY.addEventListener('click', () => OVERLAY.classList.remove('show'));

          const shoot = () => {
            confetti({ particleCount: 140, spread: 80, startVelocity: 55, origin: { y: 0.6 }});
            confetti({ particleCount: 120, spread: 120, scalar: 1.2, ticks: 250, origin: { x: 0.2, y: 0.4 }});
            confetti({ particleCount: 120, spread: 120, scalar: 1.2, ticks: 250, origin: { x: 0.8, y: 0.4 }});
          };
          shoot(); setTimeout(shoot, 600); setTimeout(shoot, 1200);

          localStorage.setItem(key, String(seen + 1));
        }
      }
    })();
  </script>
</body>
</html>`);
    }

    // Fallback
    return text("OK");
  }
};

// ---------- helpers ----------
function round2(n) { return Math.round(n * 100) / 100; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function text(s, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
async function getGross(env) {
  return Number((await env.KV.get("grossAud")) || "0");
}
async function getMilestone(env) {
  const milestone_hit_at = await env.KV.get("milestone_hit_at");
  const milestone_version = await env.KV.get("milestone_version");
  return { milestone_hit_at, milestone_version };
}
async function postSlack(url, textMsg) {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: textMsg })
  });
}

// Stripe signature verification (Workers-safe)
async function verifyStripe(payload, sigHeader, secret) {
  try {
    if (!secret) return false;
    const parts = Object.fromEntries(sigHeader.split(",").map(s => s.split("=")));
    const t = parts.t, v1 = parts.v1;
    if (!t || !v1) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
    const calc = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
    // timingSafeEqual not universally available; compare length + constant-time-ish loop
    if (calc.length !== v1.length) return false;
    let ok = 0;
    for (let i = 0; i < calc.length; i++) ok |= calc.charCodeAt(i) ^ v1.charCodeAt(i);
    return ok === 0;
  } catch {
    return false;
  }
}
