export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Fetch your current total (from KV or hardcoded until KV added)
    const gross = 988100; // Replace with env.KV.get("grossAud") once live
    const remaining = Math.max(0, 1_000_000 - gross);
    const percent = Math.min(100, (gross / 1_000_000) * 100).toFixed(2);

    // --- Public dashboard view ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>SAMii Milestone Tracker</title>
          <style>
            body {
              background: #0f1115;
              color: #f8f8f8;
              font-family: 'Helvetica Neue', sans-serif;
              text-align: center;
              padding: 4rem 1rem;
            }
            h1 { font-size: 2rem; margin-bottom: 1rem; color: #9f8fff; }
            .bar {
              width: 80%;
              margin: 2rem auto;
              height: 30px;
              background: #333;
              border-radius: 15px;
              overflow: hidden;
            }
            .fill {
              height: 100%;
              width: ${percent}%;
              background: linear-gradient(90deg, #7b5cff, #ff6cfb);
              transition: width 0.5s ease;
            }
            .stats {
              font-size: 1.2rem;
              margin-top: 2rem;
              line-height: 1.6rem;
            }
          </style>
        </head>
        <body>
          <h1>🎉 SAMii Stripe Milestone Tracker 🎉</h1>
          <div class="bar"><div class="fill"></div></div>
          <div class="stats">
            <p><strong>Total so far:</strong> A$${gross.toLocaleString()}</p>
            <p><strong>Remaining to $1M:</strong> A$${remaining.toLocaleString()}</p>
            <p><strong>Progress:</strong> ${percent}%</p>
          </div>
          <footer style="margin-top:3rem;opacity:0.6;font-size:0.9rem;">
            Updated automatically with Stripe | SAMii.com.au
          </footer>
        </body>
        </html>
      `, { headers: { "content-type": "text/html" }});
    }

    // --- JSON API for GPT or automations ---
    if (url.pathname === "/progress") {
      return new Response(JSON.stringify({
        gross_aud: gross,
        remaining_to_million_aud: remaining,
        percent: percent
      }), { headers: { "content-type": "application/json" }});
    }

    return new Response("OK", { status: 200 });
  }
};
