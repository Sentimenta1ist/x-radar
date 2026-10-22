# x-viral-radar

Chrome MV3 extension (plain JS, no build). Passive: reads rendered tweets on x.com, scores early virality, shows a badge. No network, no automated actions — keep it that way (account safety).

- `scoring.js` pure scoring, UMD, tested with `node test.js`.
- `content.js` DOM reading, snapshots in `chrome.storage.local`, badge painting.
- `popup.*` top list, settings (hot threshold, tau), CSV export.
- X selectors (`article[data-testid="tweet"]`, group `aria-label`) are the fragile part.
- Context and decisions: `~/dev/brain` (factory/2-areas/x.md, backlog #53).
