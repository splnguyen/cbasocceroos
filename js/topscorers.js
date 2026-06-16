/**
 * Top Scorers — Golden Boot leaderboard.
 *
 *   GET /api/topscorers[?demo=1]   → api-football /players/topscorers
 *
 * Shows the leading WC 2026 goalscorers (rank, photo, team, goals, assists).
 * Player photos + team logos come from api-football media URLs (online only;
 * circles keep a placeholder background so the layout holds offline).
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const LIMIT = 8;                       // rows that fit the 1080×1920 board
  const params = new URLSearchParams(location.search);
  const isDemo = params.get('demo') === '1';

  const $ = (id) => document.getElementById(id);
  let hasData = false;
  const CACHE_KEY = `cba:topscorers:v1:demo=${isDemo ? 1 : 0}`;

  // ── Apply (from fetch or cache) ──────────────────────────────────────────
  function applyPayload(json, badgeText = 'Just updated') {
    render(json.scorers || []);
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
      const res = await fetch(`/api/topscorers?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      writeCache(json);
      applyPayload(json); // reload values when the API call returns
    } catch (err) {
      console.error('[topscorers]', err);
      // Keep cached/previous leaderboard visible; just flag the failure.
      $('updatedBadge').textContent = 'Update failed';
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function render(scorers) {
    const root = $('scorers');
    const list = (scorers || []).slice(0, LIMIT);
    if (!list.length) {
      root.innerHTML = '<div class="scorers-empty">No goals scored yet</div>';
      return;
    }
    // Golden Boot leader = most goals. Highlight ALL co-leaders tied on that
    // top tally (the list is sorted descending), not just rank 1. Guard on >0 so
    // a board of goalless players isn't painted entirely gold.
    const leadGoals = list[0]?.goals ?? 0;
    root.innerHTML = list.map((s) => {
      const photo = s.photo ? `<img src="${esc(s.photo)}" alt="">` : '';
      const flag = s.teamLogo ? `<img src="${esc(s.teamLogo)}" alt="">` : '';
      const assists = s.assists
        ? `${s.assists} Assist${s.assists > 1 ? 's' : ''}`
        : 'No assists';
      const isLead = leadGoals > 0 && (s.goals ?? 0) === leadGoals;
      return `
        <div class="scorer${isLead ? ' scorer--lead' : ''}">
          <div class="scorer-rank">${s.rank}</div>
          <div class="scorer-photo">${photo}<span class="scorer-flag">${flag}</span></div>
          <div class="scorer-id">
            <div class="scorer-name">${esc((s.name || '').toUpperCase())}</div>
            <div class="scorer-team">${esc((s.teamName || '').toUpperCase())}</div>
          </div>
          <div class="scorer-stat">
            <div class="scorer-goals"><span class="num">${s.goals ?? 0}</span><span class="lbl">Goals</span></div>
            <div class="scorer-assists">${esc(assists)}</div>
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
