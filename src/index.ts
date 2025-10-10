// 🎉 SAMii Lesson Payments Milestone Tracker
// Updated branding + colours + confetti celebration
// Author: Pete Barter x GPT-5 Assistant

const TARGET = 1_000_000; // AUD target milestone

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // JSON endpoint
    if (url.pathname === "/progress") {
      const gross = await getGross(env);
      const remaining = Math.max(0, TARGET - gross);
      const percent = Math.min(100, (gross / TARGET) * 100);
      return json({
        gross_aud: gross.toFixed(2),
        remaining_to_million_aud: remaining.toFixed(2),
        percent: pe
