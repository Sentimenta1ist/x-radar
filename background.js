// Single writer for saved posts + user-started re-check.
// Re-check opens each due post in a background tab ONE AT A TIME, reads its counters, closes the tab.
// It only runs when you press the button in the popup (no timers), max RECHECK_LIMIT posts per run.
const KEY = 'xvr_saved';
const STATUS = 'xvr_recheck_status';
const DUE_AFTER_MS = 24 * 3600 * 1000;   // first check no earlier than 24h after saving
const RECHECK_LIMIT = 10;
const WAIT_MS = 30000;

let queue = Promise.resolve();
function mutate(fn) {
  queue = queue.then(async () => {
    const d = await chrome.storage.local.get(KEY);
    const saved = d[KEY] || {};
    const r = fn(saved);
    await chrome.storage.local.set({ [KEY]: saved });
    return r;
  }).catch((e) => console.warn('xvr mutate failed', e));
  return queue;
}

const waiters = new Map();   // post id -> resolve()
const ownTabs = new Set();   // tab ids opened by re-check

function isDue(r, now) {
  if (now - r.savedAt < DUE_AFTER_MS) return false;
  return !(r.checks || []).some((c) => c.t - r.savedAt >= DUE_AFTER_MS);
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg.type === 'save') {
    mutate((s) => { if (!s[msg.id]) s[msg.id] = { ...msg.record, checks: [] }; }).then(() => send({ ok: true }));
    return true;
  }
  if (msg.type === 'unsave') {
    mutate((s) => { delete s[msg.id]; }).then(() => send({ ok: true }));
    return true;
  }
  if (msg.type === 'measure') {
    mutate((s) => {
      const r = s[msg.id];
      if (!r) return;
      r.checks = r.checks || [];
      const last = r.checks[r.checks.length - 1];
      if (last && msg.check.t - last.t < 30 * 60000) return;   // no near-duplicates
      r.checks.push(msg.check);
      if (r.checks.length > 20) r.checks.shift();
    }).then(() => {
      const w = waiters.get(msg.id);
      if (w) w();
      send({ ok: true });
    });
    return true;
  }
  if (msg.type === 'recheck') {
    runRecheck().then(send);
    return true;
  }
});

chrome.tabs.onRemoved.addListener((id) => ownTabs.delete(id));

let running = false;
async function runRecheck() {
  if (running) return { started: false, reason: 'already running' };
  running = true;
  try {
    const d = await chrome.storage.local.get(KEY);
    const now = Date.now();
    const due = Object.values(d[KEY] || {}).filter((r) => isDue(r, now)).slice(0, RECHECK_LIMIT);
    await chrome.storage.local.set({ [STATUS]: { running: true, done: 0, total: due.length, failed: 0 } });
    let done = 0, failed = 0;
    for (const r of due) {
      let tab;
      try {
        tab = await chrome.tabs.create({ url: r.url, active: false });
        ownTabs.add(tab.id);
        const got = await new Promise((resolve) => {
          const t = setTimeout(() => { waiters.delete(r.id); resolve(false); }, WAIT_MS);
          waiters.set(r.id, () => { clearTimeout(t); waiters.delete(r.id); resolve(true); });
        });
        if (got) done++; else failed++;
      } catch (e) {
        failed++;
      } finally {
        if (tab && ownTabs.has(tab.id)) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* already closed */ } }
      }
      await chrome.storage.local.set({ [STATUS]: { running: true, done, total: due.length, failed } });
      await new Promise((res) => setTimeout(res, 4000 + Math.random() * 4000));   // calm pace
    }
    await chrome.storage.local.set({ [STATUS]: { running: false, done, total: due.length, failed, finishedAt: Date.now() } });
    return { started: true, done, failed, total: due.length };
  } finally {
    running = false;
  }
}
