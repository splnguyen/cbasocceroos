/**
 * Top Keepers — Golden Glove leaderboard.
 *
 *   GET /api/topkeepers[?demo=1]   → proxy sweeps api-football /players, ranks GKs
 *
 * api-football has no "top keepers" endpoint, so the proxy pages the whole
 * /players list and ranks goalkeepers by FEWEST goals conceded (Golden Glove),
 * tie-broken by minutes then saves. Hero number = conceded; secondary = saves.
 * Reuses the top-scorers card styles (.scorer*) so the two boards stay identical.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const LIMIT = 8;                       // rows that fit the 1080×1920 board
  const params = new URLSearchParams(location.search);
  const isDemo = params.get('demo') === '1';

  const $ = (id) => document.getElementById(id);
  let hasData = false;
  const CACHE_KEY = `cba:topkeepers:v1:demo=${isDemo ? 1 : 0}`;

  // ── Apply (from fetch or cache) ──────────────────────────────────────────
  function applyPayload(json, badgeText = 'Just updated') {
    render(json.keepers || []);
    $('updatedBadge').textContent = badgeText;
    hasData = true;
  }

  // ── Cache (localStorage; renders instantly on carousel revisits) ───────────
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.payload || !parsed.ts) return null;
      return parsed;
    } catch (e) { return null; }
  }
  function writeCache(payload) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ payload, ts: Date.now() })); }
    catch (e) { /* best-effort */ }
  }
  function cacheBadge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins <= 0) return 'Just updated';
    if (mins === 1) return 'Updated 1 min ago';
    return `Updated ${mins} mins ago`;
  }

  async function refresh() {
    $('updatedBadge').textContent = 'Updating…';
    try {
      const qs = new URLSearchParams();
      if (isDemo) qs.set('demo', '1');
      const res = await fetch(`/api/topkeepers?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      writeCache(json);
      applyPayload(json); // reload values when the API call returns
    } catch (err) {
      console.error('[topkeepers]', err);
      // Keep cached/previous leaderboard visible; just flag the failure.
      $('updatedBadge').textContent = 'Update failed';
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function render(keepers) {
    const root = $('scorers');
    const list = (keepers || []).slice(0, LIMIT);
    if (!list.length) {
      root.innerHTML = '<div class="scorers-empty">No keeper stats yet</div>';
      return;
    }
    root.innerHTML = list.map((k) => {
      const photo = k.photo ? `<img src="${esc(k.photo)}" alt="">` : '';
      const flag = k.teamLogo ? `<img src="${esc(k.teamLogo)}" alt="">` : '';
      const saves = `${k.saves ?? 0} Save${(k.saves ?? 0) === 1 ? '' : 's'}`;
      return `
        <div class="scorer${k.rank === 1 ? ' scorer--lead' : ''}">
          <div class="scorer-rank">${k.rank}</div>
          <div class="scorer-photo">${photo}<span class="scorer-flag">${flag}</span></div>
          <div class="scorer-id">
            <div class="scorer-name">${esc((k.name || '').toUpperCase())}</div>
            <div class="scorer-team">${esc((k.teamName || '').toUpperCase())}</div>
          </div>
          <div class="scorer-stat">
            <div class="scorer-goals"><span class="num">${k.conceded ?? 0}</span><span class="lbl">Conceded</span></div>
            <div class="scorer-assists">${esc(saves)}</div>
          </div>
        </div>`;
    }).join('');
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  const cached = readCache();
  if (cached) applyPayload(cached.payload, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
})();
