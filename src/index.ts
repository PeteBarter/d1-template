// 🎉 SAMii Lesson Payments Milestone Tracker (TypeScript Worker)
// Routes:
//   GET  /                 → Public dashboard (Comfortaa + SAMii colours + confetti/GIFs)
//   GET  /progress         → JSON status
//   POST /init?value=NNN   → Seed starting total (AUD)
//   POST /stripe-webhook   → Stripe charge.succeeded → updates KV + milestone flags
//
// Required bindings (Worker → Settings → Bindings):
//   KV (KVNamespace)                     – stores totals + flags
//   STRIPE_WEBHOOK_SECRET (Secret)       – Stripe signing secret
//   SLACK_WEBHOOK_URL (Secret, optional) – Slack Incoming Webhook

interface Env {
  KV: KVNamespace;
  STRIPE_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_URL?: string;
}

const TARGET = 1_000_000; // AUD

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const demo = url.searchParams.get("demo"); // 'hit' | 'reset' | null

    // --- JSON API -----------------------------------------------------------
    if (path === "/progress" && req.method === "GET") {
      const gross = await getGross(env);
      const { hitAt, version } = await getMilestone(env);
      const remaining = Math.max(0, TARGET - gross);
      const percent = Math.min(100, (gross / TARGET) * 100);

      return json({
        currency: "AUD",
        gross_aud: round2(gross),
        remaining_to_million_aud: round2(remaining),
        percent: round2(percent),
        milestone_hit: gross >= TARGET,
        milestone_hit_at: hitAt,
        milestone_version: version,
      });
    }

    // --- Seed endpoint ------------------------------------------------------
    if (path === "/init" && req.method === "POST") {
      const value = Number(url.searchParams.get("value") || "0");
      await env.KV.put("grossAud", String(value));
      // reset flags
      await env.KV.delete("alert:10000");
      await env.KV.delete("alert:5000");
      await env.KV.delete("alert:1000");
      await env.KV.delete("alert:hit");
      await env.KV.delete("milestone_hit_at");
      await env.KV.delete("milestone_version");
      return text("initialised");
    }

    // --- Stripe webhook -----------------------------------------------------
    if (path === "/stripe-webhook" && req.method === "POST") {
      const payload = await req.text();
      const sig = req.headers.get("stripe-signature") || "";
      const ok = await verifyStripe(payload, sig, env.STRIPE_WEBHOOK_SECRET || "");
      if (!ok) return text("bad signature", 400);

      const event = JSON.parse(payload);
      if (event.type === "charge.succeeded") {
        const obj = event.data?.object ?? {};
        if ((obj.currency || "").toLowerCase() === "aud") {
          const inc = Number(obj.amount || 0) / 100; // dollars
          const prev = await getGross(env);
          const gross = prev + inc;
          await env.KV.put("grossAud", String(gross));

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

    // --- Public dashboard ---------------------------------------------------
    if (path === "/" || path === "/index.html") {
      const gross = await getGross(env);
      const remaining = Math.max(0, TARGET - gross);
      const percent = Math.min(100, (gross / TARGET) * 100);
      const { hitAt, version } = await getMilestone(env);
      const isHit = gross >= TARGET || demo === "hit";

      const title = "🎉 SAMii Lesson Payments Milestone Tracker 🎉";
      const badge = isHit
        ? `A$1,000,000 reached ${hitAt ? "on " + new Date(hitAt).toLocaleString() : ""}`
        : "";

      const htmlDoc = renderPage({
        title,
        grossText: `A$${gross.toLocaleString()}`,
        remainingText: `A$${remaining.toLocaleString()}`,
        percentText: `${percent.toFixed(2)}%`,
        percentValue: percent,
        showBadge: isHit,
        badgeText: badge,
        demo,
        milestoneVersion: version || "v1",
      });

      return html(htmlDoc);
    }

    // Fallback
    return text("OK");
  },
};

// ---------------- helpers ----------------

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function json(obj: unknown, status = 200) {
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

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function getGross(env: Env): Promise<number> {
  // default seed so first render never crashes
  return Number((await env.KV.get("grossAud")) || "988100");
}

async function getMilestone(env: Env): Promise<{ hitAt: string | null; version: string | null }> {
  const hitAt = await env.KV.get("milestone_hit_at");
  const version = await env.KV.get("milestone_version");
  return { hitAt, version };
}

async function postSlack(url: string | undefined, msg: string) {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: msg }),
  });
}

// Stripe signature verification (Workers-safe, HMAC SHA-256)
async function verifyStripe(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  try {
    if (!secret) return false;
    const parts = Object.fromEntries(sigHeader.split(",").map((s) => s.split("=")));
    const t = parts["t"];
    const v1 = parts["v1"];
    if (!t || !v1) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
    const calc = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

    // constant-time-ish compare
    if (calc.length !== v1.length) return false;
    let diff = 0;
    for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ v1.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

// Build the HTML safely (no nested template chaos)
function renderPage(o: {
  title: string;
  grossText: string;
  remainingText: string;
  percentText: string;
  percentValue: number;
  showBadge: boolean;
  badgeText: string;
  demo: string | null;
  milestoneVersion: string;
}) {
  const isHitFlag = o.showBadge ? "true" : "false";
  const demoVal = JSON.stringify(o.demo);
  const versionVal = JSON.stringify(o.milestoneVersion);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SAMii Lesson Payments Milestone Tracker</title>
  <link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;600;700&display=swap" rel="stylesheet">
  <meta name="theme-color" content="#0d6694" />
  <style>
    :root {
      --dark-teal: #0d3447;   /* background */
      --blue-teal: #0d6694;   /* bar start */
      --light-teal: #4791B8;  /* gradient mid */
      --mint: #3CC99F;        /* accent */
      --white: #ffffff;
      --silver: #e0dfdf;
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:'Comfortaa',system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--dark-teal);color:var(--white);text-align:center}
    h1{margin:40px 0 20px;font-size:clamp(24px,3vw,40px);background:linear-gradient(90deg,var(--mint),var(--light-teal));-webkit-background-clip:text;background-clip:text;color:transparent}
    .bar{width:min(860px,92vw);height:32px;margin:40px auto 20px;background:rgba(255,255,255,.18);border-radius:20px;overflow:hidden;box-shadow:0 0 12px rgba(0,0,0,.35) inset}
    .fill{height:100%;width:${o.percentValue.toFixed(2)}%;background:linear-gradient(90deg,var(--blue-teal),var(--mint));border-radius:20px;transition:width .5s ease-out}
    .stats{color:var(--silver);font-size:20px;line-height:1.8}
    .highlight{color:var(--mint);font-weight:700}
    .badge{display:${o.showBadge ? "inline-block" : "none"};margin-top:12px;background:#15c46a;color:#04130b;padding:8px 12px;border-radius:999px;font-weight:700}
    footer{margin:46px 0 24px;color:var(--silver);font-size:14px}
    /* Celebration overlay */
    .celebrate{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:50;background:rgba(0,0,0,.7)}
    .celebrate.show{display:flex}
    .gifgrid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:1000px;padding:20px}
    .gifgrid img{width:100%;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
  </style>
</head>
<body>
  <h1>${escapeHtml(o.title)}</h1>

  <div class="bar"><div class="fill"></div></div>

  <div class="stats">
    <div>Total so far: <span class="highlight">${escapeHtml(o.grossText)}</span></div>
    <div>Remaining to $1M: <span class="highlight">${escapeHtml(o.remainingText)}</span></div>
    <div>Progress: <span class="highlight">${escapeHtml(o.percentText)}</span></div>
    <div class="badge">${escapeHtml(o.badgeText)}</div>
  </div>

  <footer>Updated automatically with Stripe • SAMii.com.au</footer>

  <div id="celebrate" class="celebrate" aria-hidden="true">
    <div class="gifgrid">
      <img src="https://media.giphy.com/media/5GoVLqeAOo6PK/giphy.gif" alt="Confetti celebration">
      <img src="https://media.giphy.com/media/3o6Zt6ML6BklcajjsA/giphy.gif" alt="Party time">
      <img src="https://media.giphy.com/media/l0Exk8EUzSLsrErEQ/giphy.gif" alt="Fireworks">
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
  <script>
    (function(){
      const params = new URLSearchParams(location.search);
      const demo = ${demoVal};
      const IS_HIT = ${isHitFlag};
      const VERSION = ${versionVal} || "v1";
      const KEY = 'samii_milestone_seen_' + VERSION;
      if (params.get('demo') === 'reset') localStorage.removeItem(KEY);

      if ((IS_HIT || params.get('demo') === 'hit') && VERSION !== 'none') {
        const seen = Number(localStorage.getItem(KEY) || '0');
        if (seen < 2) {
          const overlay = document.getElementById('celebrate');
          overlay.classList.add('show');
          overlay.addEventListener('click', () => overlay.classList.remove('show'));
          const blast = () => {
            confetti({ particleCount: 150, spread: 100, startVelocity: 45, origin: { y: 0.6 }});
            confetti({ particleCount: 110, spread: 160, origin: { x: 0.2, y: 0.5 }});
            confetti({ particleCount: 110, spread: 160, origin: { x: 0.8, y: 0.5 }});
          };
          blast(); setTimeout(blast, 600); setTimeout(blast, 1200);
          localStorage.setItem(KEY, String(seen + 1));
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
