// 🎉 SAMii Lesson Payments Milestone Tracker (TypeScript Worker)
// Endpoints:
//   GET  /                 -> Public dashboard (confetti + GIFs on milestone)
//   GET  /progress         -> JSON (gross, remaining, percent, milestone info)
//   POST /init?value=NNN   -> Seed current total (AUD dollars)
//   POST /stripe-webhook   -> Stripe events (charge.succeeded)
//
// Bindings required:
//   KV (KVNamespace)          - stores totals + milestone flags
//   STRIPE_WEBHOOK_SECRET     - Stripe signing secret (webhook verification)
//   SLACK_WEBHOOK_URL (opt)   - Slack Incoming Webhook for alerts

interface Env {
  KV: KVNamespace;
  STRIPE_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_URL?: string;
}

const TARGET = 1_000_000; // AUD

export default {
  // Uncomment if you later want cron summaries
  // async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {},

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const demo = url.searchParams.get("demo"); // 'hit' | 'reset' | null

    // ---------- JSON ----------
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

    // ---------- Seed (one-off / manual adjust) ----------
    if (url.pathname === "/init" && request.method === "POST") {
      const value = Number(url.searchParams.get("value") || "0");
      await env.KV.put("grossAud", String(value));
      // clear milestone + per-threshold alerts
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
      const sigHeader = request.headers.get("stripe-signature") || "";
      const ok = await verifyStripe(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET || "");
      if (!ok) return text("bad signature", 400);

      const event = JSON.parse(payload);
      if (event.type === "charge.succeeded") {
        const obj = event.data?.object || {};
        if (obj.currency === "aud") {
          const inc = Number(obj.amount || 0) / 100; // dollars
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
