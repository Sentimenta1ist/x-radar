# X Viral Radar

A Chrome (Manifest V3) extension that scores posts in your x.com feed by their likelihood of going viral, while you scroll. Each post gets a 0–100 score and a badge, and an on-page panel lists the best fresh posts you have seen. Plain JavaScript, no build step, no dependencies.

The scoring is a small, transparent model: four signals read from numbers already rendered on the page, combined with explicit weights and an explicitly stated assumption about how views accumulate. It is meant to be calibrated against your own exported data, not trusted blindly.

## What it does

- Reads the counters of posts already rendered in your own feed (views, likes, replies, reposts, bookmarks, publish time), on load, on DOM changes, and every ~20 seconds.
- Adds a score badge to each post. Hover the badge for a breakdown by component, projected final views and engagement per view.
  - 🔥 **hot**: score ≥ 70
  - ↗ **rising**: score ≥ 45
  - grey **normal**: everything else
  - posts older than 6 hours or with fewer than 30 views are not flagged
- Shows a collapsible on-page panel with the best hot/rising posts of the last few hours (click a row to scroll to the post), plus a toggle that dims grey posts.
- Popup: top posts from the last 3 hours, settings for the `hot` threshold and τ, CSV export of every measurement, and a button to clear data.
- Optional calibration helper: star a post to save its score and counters; the popup can later re-check saved posts after 24 h and export a CSV with the before/after numbers.
- Data is stored only in `chrome.storage.local` in your browser. The extension makes no network requests of its own and never posts, likes or clicks anything on your behalf.

## How scoring works

Four signals are combined:

| Signal | Meaning | Mapping | Weight |
|---|---|---|---|
| size | Projected final views (views / fraction of lifetime views typically gained by this age) | 1k → 0, 500k → 100 (log scale) | 0.35 |
| engagement | Weighted engagement per view (reply 3, repost 2, bookmark 2, like 1) | 1% → 0, 6% → 100 | 0.20 |
| vs author | Projection against the median of this author's past posts that the extension has already seen (needs ≥ 3) | 1× → 0, 8× → 100 (log scale) | 0.25 |
| acceleration | Measured view growth between two snapshots versus what the decay curve predicts | 50 = as expected; doubling or halving moves it by 50 | 0.20 |

Available signals are renormalised (the weights of missing signals are dropped), and the result is multiplied by a confidence factor: `0.5 + 0.5 × confidence`, where confidence grows with views (full at 300 views) and is reduced to 0.6× for posts younger than 5 minutes.

Views are modelled as accumulating along `1 − exp(−t/τ)`, with a default τ = 150 min. **This is an assumption, not a measured fact.** The real curve differs between accounts and posts and should be calibrated (see below). The projection divides by this fraction, floored at 0.15 so very young posts do not produce wild numbers.

The scoring logic lives in `scoring.js`: pure functions, no DOM, no network.

### What is known and what is not

- X's published recommendation code (2023) gives signal weights: a reply is valued noticeably higher than a like, and an author's reply to a reply highest of all. These are model coefficients, not an exchange rate, and the open code does not confirm the popular "the first hour decides everything" claim.
- Research on tweet cascades agrees that prediction rests on early dynamics (the first ~50 reposts) and on the author's usual post size; content alone helps little. Hence the `vs author` and `acceleration` signals.
- An author's follower count is not visible in the feed, so the extension learns each author's "normal level" itself. For the first days only size, engagement and acceleration are available.

### Calibrating

1. Use the feed normally for a week, then press **Export CSV** in the popup.
2. Rows are measurements of a post over time. For posts measured at about 30 min and about 3 h, check what share of the final views had accumulated by 30 min. That is your real τ.
3. Set τ in the popup. Choose the `hot` threshold so that only a handful of posts per day get 🔥.
4. Use the starred-post workflow (saved CSV with 24 h re-checks) to log which flagged posts actually took off.

## Install

1. Clone this repository: `git clone <repo-url>`
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
4. Open x.com and refresh the page. Pin the icon via the puzzle-piece menu if you want quick access to the popup.
5. After editing code, click the reload icon on the extension's card at `chrome://extensions` and refresh the X tab.

## Tests

The scoring module is covered by plain Node assertions (no test framework, Node only):

```
node test.js
```

It checks: a cold post stays `normal`, too little data yields `low-data`, a fast post with high engagement, 6× the author's usual size and accelerating growth is `hot`, the same numbers on an old post are labelled `old`, the same absolute views score lower against a big author's baseline than against a small one's, and the lifetime fraction at t = τ is ≈ 0.632. On success it prints `ok` with the sample scores.

## Limitations

- X's selectors (`data-testid`, `aria-label`) can change without notice. If badges disappear, look at `readMetrics` and `readTweet` in `content.js`.
- The counter parser handles English and Russian UI strings only.
- Posts without a visible views counter are skipped.
- It only works while an x.com tab is open; there is no background collection.
- The decay curve (τ) is an assumption until calibrated, so absolute scores are only as good as that calibration.
- The optional **Re-check due posts** button in the popup opens saved posts in background tabs one at a time (you must be logged in), reads their counters and closes them. It runs only when you press the button, at most 10 posts per run, with randomised delays. It is the one place where the extension navigates on its own, so use it sparingly.
- Not published on the Chrome Web Store; install it as an unpacked extension.

## Project layout

```
manifest.json   MV3 manifest (content scripts for x.com / twitter.com, popup, service worker)
scoring.js      Pure scoring model (UMD: used by content.js in the browser and by test.js in Node)
content.js      Reads rendered posts, keeps snapshots in chrome.storage.local, paints badges and the on-page panel
styles.css      Badge and panel styling
background.js   Service worker: single writer for saved posts, user-started re-check
popup.html      Popup UI
popup.js        Popup logic: top list, settings (hot threshold, τ), CSV exports, re-check
test.js         Assertions for scoring.js (run with `node test.js`)
```
