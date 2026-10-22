// Virality scoring for a single X post. Pure functions, no DOM, no network.
// Used by content.js (browser) and test.js (node).
(function (root) {
  const DEFAULTS = {
    tau: 150,          // minutes: views accumulate as 1 - exp(-t / tau). Assumption, calibrate from exported data.
    hotScore: 70,
    risingScore: 45,
    minViews: 30,
    maxAgeMin: 360,    // older posts are not flagged
    weights: { reply: 3, repost: 2, like: 1, bookmark: 2 },
  };

  const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

  function lifetimeFraction(ageMin, tau) {
    return 1 - Math.exp(-Math.max(ageMin, 1) / tau);
  }

  // Expected final views if the post follows the decay curve. Fraction floored to avoid wild jumps for very young posts.
  function projectViews(views, ageMin, cfg) {
    return views / Math.max(lifetimeFraction(ageMin, cfg.tau), 0.15);
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // tweet: {views, likes, replies, reposts, bookmarks, ageMin}
  // ctx:   {authorProjected: number[] (past projected finals of this author), prev: {views, ageMin} | null}
  function score(tweet, ctx = {}, userCfg = {}) {
    const cfg = { ...DEFAULTS, ...userCfg, weights: { ...DEFAULTS.weights, ...(userCfg.weights || {}) } };
    const { views, ageMin } = tweet;
    if (!(views >= cfg.minViews) || !(ageMin >= 2)) {
      return { score: 0, label: 'low-data', parts: {}, projected: null, vpm: views / Math.max(ageMin, 1), confidence: 0 };
    }

    const projected = projectViews(views, ageMin, cfg);
    const vpm = views / ageMin;
    const w = cfg.weights;
    const eng = w.reply * (tweet.replies || 0) + w.repost * (tweet.reposts || 0) + w.like * (tweet.likes || 0) + w.bookmark * (tweet.bookmarks || 0);
    const er = eng / views;

    const parts = {};
    // 1k projected -> 0, 500k -> 100 (log scale)
    parts.size = clamp((Math.log10(projected / 1000) / Math.log10(500)) * 100);
    // weighted engagement per view: 1% -> 0, 6% -> 100
    parts.engagement = clamp(((er - 0.01) / 0.05) * 100);

    const base = ctx.authorProjected && ctx.authorProjected.length >= 3 ? median(ctx.authorProjected) : null;
    if (base && base > 0) {
      // 1x author's normal -> 0, 8x -> 100
      parts.relative = clamp((Math.log2(projected / base) / 3) * 100);
    }

    if (ctx.prev && ageMin - ctx.prev.ageMin >= 2 && views > ctx.prev.views) {
      const dt = ageMin - ctx.prev.ageMin;
      const recent = (views - ctx.prev.views) / dt;
      // instantaneous / average rate expected from the decay model at this age
      const expected = (Math.exp(-ageMin / cfg.tau) / cfg.tau) / (lifetimeFraction(ageMin, cfg.tau) / ageMin);
      const ratio = recent / (vpm * expected);
      parts.acceleration = clamp(50 + 50 * Math.log2(ratio));
      parts.recentVpm = recent;
    }

    const weights = { size: 0.35, engagement: 0.2, relative: 0.25, acceleration: 0.2 };
    let sum = 0, wsum = 0;
    for (const k of Object.keys(weights)) {
      if (parts[k] != null) { sum += parts[k] * weights[k]; wsum += weights[k]; }
    }
    const confidence = clamp(views / 300, 0, 1) * (ageMin >= 5 ? 1 : 0.6);
    let total = (sum / wsum) * (0.5 + 0.5 * confidence);

    let label = total >= cfg.hotScore ? 'hot' : total >= cfg.risingScore ? 'rising' : 'normal';
    if (ageMin > cfg.maxAgeMin) label = 'old';
    return { score: Math.round(total), label, parts, projected, vpm, er, confidence };
  }

  const api = { DEFAULTS, score, projectViews, lifetimeFraction, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XVR = api;
})(typeof self !== 'undefined' ? self : this);
