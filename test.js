const assert = require('assert');
const { score, lifetimeFraction } = require('./scoring.js');

// cold post: few views, low engagement
const cold = score({ views: 120, likes: 2, replies: 0, reposts: 0, bookmarks: 0, ageMin: 60 });
assert.strictEqual(cold.label, 'normal');
assert(cold.score < 30, 'cold score ' + cold.score);

// too little data
assert.strictEqual(score({ views: 10, likes: 1, replies: 0, reposts: 0, bookmarks: 0, ageMin: 10 }).label, 'low-data');

// hot: 30 min, 8k views, high engagement, 6x author's normal, accelerating
const hot = score(
  { views: 8000, likes: 400, replies: 60, reposts: 90, bookmarks: 80, ageMin: 30 },
  { authorProjected: [5000, 6000, 4000, 7000], prev: { views: 5000, ageMin: 20 } }
);
assert.strictEqual(hot.label, 'hot', JSON.stringify(hot));

// same numbers but old -> not flagged
const old = score({ views: 8000, likes: 400, replies: 60, reposts: 90, bookmarks: 80, ageMin: 900 });
assert.strictEqual(old.label, 'old');

// big account, normal day: large absolute views but equal to author's baseline -> lower than same post vs small baseline
const vsBig = score({ views: 50000, likes: 500, replies: 20, reposts: 30, bookmarks: 20, ageMin: 120 }, { authorProjected: [90000, 100000, 110000] });
const vsSmall = score({ views: 50000, likes: 500, replies: 20, reposts: 30, bookmarks: 20, ageMin: 120 }, { authorProjected: [3000, 4000, 5000] });
assert(vsSmall.score > vsBig.score, 'relative signal should matter');

assert(lifetimeFraction(150, 150) > 0.63 && lifetimeFraction(150, 150) < 0.64);
console.log('ok', { cold: cold.score, hot: hot.score, vsBig: vsBig.score, vsSmall: vsSmall.score });
