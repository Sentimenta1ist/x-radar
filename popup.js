const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

chrome.storage.local.get(['xvr_tweets', 'xvr_settings'], (d) => {
  const tweets = d.xvr_tweets || {};
  const cfg = d.xvr_settings || {};
  $('hot').value = cfg.hotScore || 70;
  $('tau').value = cfg.tau || 150;

  const cutoff = Date.now() - 3 * 3600 * 1000;
  const rows = Object.entries(tweets)
    .filter(([, t]) => (t.seen || 0) >= cutoff && t.label && t.label !== 'low-data' && t.label !== 'old')
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 20);

  $('count').textContent = `${Object.keys(tweets).length} tracked`;
  if (!rows.length) { $('list').innerHTML = '<div class="empty">Open x.com and scroll your feed. Scored posts seen in the last 3 hours show up here.</div>'; return; }

  $('list').innerHTML = rows.map(([id, t]) => {
    const ageMin = Math.round((t.seen - t.created) / 60000);
    return `<div class="row" data-url="https://x.com/${esc(t.handle)}/status/${id}">
      <div class="top"><span class="pill ${t.label}">${t.score}</span>@${esc(t.handle)}
        <span class="meta">${fmt(t.views)} views · ~${fmt(t.projected)} proj · ${ageMin} min old</span></div>
      <div class="txt">${esc(t.text || '')}</div></div>`;
  }).join('');
  document.querySelectorAll('.row').forEach((r) => r.addEventListener('click', () => chrome.tabs.create({ url: r.dataset.url })));
});

$('save').onclick = () => {
  const hotScore = Math.max(1, Math.min(100, +$('hot').value || 70));
  const tau = Math.max(30, Math.min(600, +$('tau').value || 150));
  chrome.storage.local.set({ xvr_settings: { hotScore, tau, risingScore: Math.round(hotScore * 0.65) } }, () => ($('count').textContent = 'saved'));
};

$('clear').onclick = () => {
  if (confirm('Delete all collected data?')) chrome.storage.local.remove(['xvr_tweets', 'xvr_authors'], () => location.reload());
};

// One row per snapshot: lets you calibrate tau and thresholds against what actually happened.
$('csv').onclick = () => {
  chrome.storage.local.get('xvr_tweets', (d) => {
    const lines = ['id,handle,created,snap_time,age_min,views,likes,replies,reposts,bookmarks'];
    for (const [id, t] of Object.entries(d.xvr_tweets || {})) {
      for (const s of t.snaps || []) {
        lines.push([id, t.handle, new Date(t.created).toISOString(), new Date(s[0]).toISOString(), ((s[0] - t.created) / 60000).toFixed(1), s[1], s[2], s[3], s[4], s[5]].join(','));
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `x-viral-radar-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  });
};
