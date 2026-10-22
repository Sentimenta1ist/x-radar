// Passive reader: scans tweets already rendered in the user's own feed, scores them, shows a badge.
// No network calls, no clicks, no posting.
(() => {
  const SCAN_MS = 20000;
  const SNAP_MIN_GAP_MS = 60000;
  const FLUSH_MS = 5000;
  const KEEP_MS = 48 * 3600 * 1000;
  const MAX_TWEETS = 600;
  const AUTHOR_SAMPLES = 25;

  let cfg = {};
  let tweets = {};   // id -> {handle, snaps: [[t, views, likes, replies, reposts, bookmarks]], created, score, label, projected, text}
  let authors = {};  // handle -> number[] projected finals
  let dirty = false;
  let saved = {};    // id -> saved record (written only by background.js)
  const reported = {};
  const artCtx = new WeakMap();

  const store = chrome.storage.local;

  function parseCount(s) {
    if (!s) return null;
    const m = String(s).replace(/ /g, ' ').match(/([\d.,]+)\s*([KkMm]|тыс|млн)?/);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
    if (isNaN(n)) return null;
    const u = (m[2] || '').toLowerCase();
    if (u === 'k' || u === 'тыс') n *= 1e3;
    if (u === 'm' || u === 'млн') n *= 1e6;
    return Math.round(n);
  }

  // Preferred: aria-label on the action group, e.g. "12 replies, 3 reposts, 45 likes, 2 bookmarks, 1234 views"
  function readMetrics(article) {
    const out = { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: null };
    const group = article.querySelector('[role="group"][aria-label]');
    const label = group ? group.getAttribute('aria-label') : '';
    const rules = [
      ['replies', /([\d., ]+\s*[KkMm]?)\s*(?:repl|ответ)/i],
      ['reposts', /([\d., ]+\s*[KkMm]?)\s*(?:repost|retweet|репост|ретвит)/i],
      ['likes', /([\d., ]+\s*[KkMm]?)\s*(?:like|лайк|нравится)/i],
      ['bookmarks', /([\d., ]+\s*[KkMm]?)\s*(?:bookmark|закладк)/i],
      ['views', /([\d., ]+\s*[KkMm]?)\s*(?:view|просмотр)/i],
    ];
    for (const [k, re] of rules) {
      const m = label.match(re);
      if (m) out[k] = parseCount(m[1]);
    }
    // Fallbacks from visible button text (abbreviated counts)
    if (out.views == null) {
      const a = article.querySelector('a[href*="/analytics"]');
      if (a) out.views = parseCount(a.getAttribute('aria-label') || a.textContent);
    }
    const txt = (id) => { const el = article.querySelector(`[data-testid="${id}"]`); return el ? parseCount(el.textContent) : null; };
    if (!out.likes) out.likes = txt('like') || txt('unlike') || 0;
    if (!out.replies) out.replies = txt('reply') || 0;
    if (!out.reposts) out.reposts = txt('retweet') || txt('unretweet') || 0;
    return out;
  }

  function readTweet(article) {
    const time = article.querySelector('time[datetime]');
    if (!time) return null;
    const link = time.closest('a[href*="/status/"]');
    if (!link) return null;
    const m = link.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const created = Date.parse(time.getAttribute('datetime'));
    if (isNaN(created)) return null;
    const metrics = readMetrics(article);
    if (metrics.views == null) return null;
    const textEl = article.querySelector('[data-testid="tweetText"]');
    return { id: m[2], handle: m[1].toLowerCase(), created, text: textEl ? textEl.textContent.slice(0, 140) : '', ...metrics };
  }

  function process(article) {
    const t = readTweet(article);
    if (!t) return;
    const pageId = (location.pathname.match(/\/status\/(\d+)/) || [])[1];
    if (pageId && t.id !== pageId) return;   // on a post page, ignore replies under it
    const now = Date.now();
    const ageMin = (now - t.created) / 60000;
    const rec = tweets[t.id] || (tweets[t.id] = { handle: t.handle, created: t.created, snaps: [], text: t.text });
    const last = rec.snaps[rec.snaps.length - 1];

    // previous snapshot at least 2 minutes older -> measured growth
    let prev = null;
    for (let i = rec.snaps.length - 1; i >= 0; i--) {
      if ((now - rec.snaps[i][0]) / 60000 >= 2) { prev = { views: rec.snaps[i][1], ageMin: (rec.snaps[i][0] - t.created) / 60000 }; break; }
    }

    const res = XVR.score(
      { views: t.views, likes: t.likes, replies: t.replies, reposts: t.reposts, bookmarks: t.bookmarks, ageMin },
      { authorProjected: authors[t.handle] || [], prev },
      cfg
    );

    if (!last || now - last[0] >= SNAP_MIN_GAP_MS) {
      if (!last || last[1] !== t.views) {
        rec.snaps.push([now, t.views, t.likes, t.replies, t.reposts, t.bookmarks]);
        if (rec.snaps.length > 40) rec.snaps.shift();
        dirty = true;
      }
    }
    rec.score = res.score; rec.label = res.label; rec.projected = res.projected; rec.seen = now;
    rec.views = t.views;

    // learn the author's normal level from settled posts (>= 60 min old)
    if (ageMin >= 60 && ageMin <= 600 && res.projected && !rec.counted) {
      const arr = authors[t.handle] || (authors[t.handle] = []);
      arr.push(res.projected);
      if (arr.length > AUTHOR_SAMPLES) arr.shift();
      rec.counted = true; dirty = true;
    }

    reportIfSaved(t, ageMin);
    paint(article, res, t, ageMin);
  }

  function reportIfSaved(t, ageMin) {
    if (!saved[t.id]) return;
    const now = Date.now();
    if (reported[t.id] && now - reported[t.id] < 5 * 60000) return;
    reported[t.id] = now;
    try {
      chrome.runtime.sendMessage({ type: 'measure', id: t.id, check: { t: now, ageH: +(ageMin / 60).toFixed(2), views: t.views, likes: t.likes, replies: t.replies, reposts: t.reposts, bookmarks: t.bookmarks } });
    } catch (e) { /* extension reloaded, page needs refresh */ }
  }

  function onSave(e) {
    e.preventDefault(); e.stopPropagation();
    const art = e.currentTarget.closest('article');
    const d = art && artCtx.get(art);
    if (!d) return;
    const { t, res, ageMin } = d;
    try {
      if (saved[t.id]) {
        chrome.runtime.sendMessage({ type: 'unsave', id: t.id });
        delete saved[t.id];
      } else {
        const p = res.parts || {};
        const record = {
          id: t.id, url: `https://x.com/${t.handle}/status/${t.id}`, handle: t.handle, text: t.text, created: t.created,
          savedAt: Date.now(), ageMinAtSave: +ageMin.toFixed(1),
          score: res.score, label: res.label, size: p.size, engagement: p.engagement, relative: p.relative, acceleration: p.acceleration,
          projected: res.projected, vpm: res.vpm, er: res.er,
          views: t.views, likes: t.likes, replies: t.replies, reposts: t.reposts, bookmarks: t.bookmarks,
          tau: (cfg && cfg.tau) || XVR.DEFAULTS.tau, followedAuthorSamples: (authors[t.handle] || []).length,
        };
        chrome.runtime.sendMessage({ type: 'save', id: t.id, record });
        saved[t.id] = { id: t.id };
      }
    } catch (x) { return; }
    paint(art, res, t, ageMin);
  }

  function fmt(n) { return n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); }

  function paint(article, res, t, ageMin) {
    article.classList.add('xvr-host');
    article.classList.toggle('xvr-hot', res.label === 'hot');
    article.classList.toggle('xvr-rising', res.label === 'rising');
    artCtx.set(article, { t, res, ageMin });
    let wrap = article.querySelector(':scope > .xvr-wrap');
    if (!wrap) {
      wrap = document.createElement('div'); wrap.className = 'xvr-wrap';
      const sv = document.createElement('button'); sv.className = 'xvr-save'; sv.addEventListener('click', onSave);
      const nb = document.createElement('div'); nb.className = 'xvr-badge';
      wrap.append(sv, nb); article.appendChild(wrap);
    }
    const b = wrap.querySelector('.xvr-badge');
    const sv = wrap.querySelector('.xvr-save');
    const isSaved = !!saved[t.id];
    sv.textContent = isSaved ? '★' : '☆';
    sv.classList.toggle('xvr-on', isSaved);
    sv.title = isSaved ? 'Saved for calibration (click to remove)' : 'Save this post (score + engagement now) for calibration';
    b.dataset.label = res.label;
    if (res.label === 'low-data') { b.textContent = '·'; b.title = 'Not enough views/age to score yet'; return; }
    const icon = res.label === 'hot' ? '🔥 ' : res.label === 'rising' ? '↗ ' : '';
    if (res.label === 'old') {
      const h = ageMin / 60;
      b.textContent = (h >= 24 ? Math.round(h / 24) + 'd' : Math.round(h) + 'h') + ' · ' + res.score;
    } else {
      b.textContent = icon + res.score;
    }
    const p = res.parts;
    const lines = [
      `Score ${res.score}/100 (${res.label})`,
      `Age ${Math.round(ageMin)} min · ${fmt(res.vpm)} views/min`,
      `Projected ~${fmt(res.projected)} views`,
      `Engagement/view ${(res.er * 100).toFixed(1)}%`,
      `size ${Math.round(p.size)} · engagement ${Math.round(p.engagement)}` +
        (p.relative != null ? ` · vs author ${Math.round(p.relative)}` : ' · vs author n/a') +
        (p.acceleration != null ? ` · accel ${Math.round(p.acceleration)} (${fmt(p.recentVpm)}/min now)` : ''),
    ];
    b.title = lines.join('\n');
  }


  // ---- on-page panel: best fresh posts seen so far + dim toggle ----
  let panel = null, listEl = null, dimOn = false, collapsed = false;
  try { dimOn = localStorage.getItem('xvr_dim') === '1'; collapsed = localStorage.getItem('xvr_collapsed') === '1'; } catch (e) { /* storage blocked */ }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'xvr-panel';
    panel.innerHTML = '<div class="xvr-head"><b>Radar</b><span class="xvr-btns"><button data-a="dim"></button><button data-a="fold">–</button></span></div><div class="xvr-list"></div>';
    document.body.appendChild(panel);
    listEl = panel.querySelector('.xvr-list');
    panel.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === 'dim') { dimOn = !dimOn; try { localStorage.setItem('xvr_dim', dimOn ? '1' : '0'); } catch (x) {} renderPanel(); }
      if (a === 'fold') { collapsed = !collapsed; try { localStorage.setItem('xvr_collapsed', collapsed ? '1' : '0'); } catch (x) {} renderPanel(); }
    });
  }

  function goTo(id, handle) {
    const link = document.querySelector(`article a[href="/${handle}/status/${id}"]`) || document.querySelector(`article a[href$="/status/${id}"]`);
    const art = link && link.closest('article');
    if (art) art.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.open(`https://x.com/${handle}/status/${id}`, '_blank');
  }

  function renderPanel() {
    if (!document.body) return;
    if (!panel) buildPanel();
    document.body.classList.toggle('xvr-dim', dimOn);
    panel.classList.toggle('xvr-collapsed', collapsed);
    panel.querySelector('[data-a="dim"]').textContent = dimOn ? 'show all' : 'dim grey';
    panel.querySelector('[data-a="fold"]').textContent = collapsed ? '+' : '–';
    const cutoff = Date.now() - 3 * 3600 * 1000;
    const rows = Object.entries(tweets)
      .filter(([, t]) => (t.seen || 0) >= cutoff && (t.label === 'hot' || t.label === 'rising'))
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 8);
    listEl.textContent = '';
    if (!rows.length) {
      const d = document.createElement('div'); d.className = 'xvr-empty';
      d.textContent = 'No hot or rising posts yet. Scroll Following / Latest.';
      listEl.appendChild(d); return;
    }
    for (const [id, t] of rows) {
      const r = document.createElement('div'); r.className = 'xvr-row';
      const age = Math.round(((t.seen || Date.now()) - t.created) / 60000);
      const h = document.createElement('div');
      h.innerHTML = '<span class="xvr-pill"></span> <span class="xvr-who"></span> <span class="xvr-sub"></span>';
      h.querySelector('.xvr-pill').textContent = (t.label === 'hot' ? '🔥 ' : '↗ ') + t.score;
      h.querySelector('.xvr-pill').dataset.label = t.label;
      h.querySelector('.xvr-who').textContent = '@' + t.handle;
      h.querySelector('.xvr-sub').textContent = `${fmt(t.views)} views · ${age}m`;
      const x = document.createElement('div'); x.className = 'xvr-txt'; x.textContent = t.text || '';
      r.appendChild(h); r.appendChild(x);
      r.addEventListener('click', () => goTo(id, t.handle));
      listEl.appendChild(r);
    }
  }

  function scan() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => { try { process(a); } catch (e) { /* DOM changed, skip */ } });
    renderPanel();
  }

  function prune() {
    const cutoff = Date.now() - KEEP_MS;
    let ids = Object.keys(tweets);
    for (const id of ids) if ((tweets[id].seen || tweets[id].created) < cutoff) delete tweets[id];
    ids = Object.keys(tweets);
    if (ids.length > MAX_TWEETS) {
      ids.sort((a, b) => (tweets[a].seen || 0) - (tweets[b].seen || 0));
      ids.slice(0, ids.length - MAX_TWEETS).forEach((id) => delete tweets[id]);
    }
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    prune();
    store.set({ xvr_tweets: tweets, xvr_authors: authors });
  }

  let timer = null;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(scan, 800); };

  store.get(['xvr_tweets', 'xvr_authors', 'xvr_settings', 'xvr_saved'], (d) => {
    saved = d.xvr_saved || {};
    tweets = d.xvr_tweets || {};
    authors = d.xvr_authors || {};
    cfg = d.xvr_settings || {};
    scan();
    new MutationObserver(debounced).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, SCAN_MS);   // re-read counters of tweets that stay on screen
    setInterval(flush, FLUSH_MS);
  });

  chrome.storage.onChanged.addListener((ch) => {
    if (ch.xvr_saved) { saved = ch.xvr_saved.newValue || {}; scan(); }
    if (ch.xvr_settings) { cfg = ch.xvr_settings.newValue || {}; scan(); }
    if (ch.xvr_tweets && !ch.xvr_tweets.newValue) { tweets = {}; authors = {}; }   // cleared from popup
  });
})();
