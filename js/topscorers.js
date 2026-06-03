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

  async function refresh() {
    $('updatedBadge').textContent = 'Updating…';
    try {
      const qs = new URLSearchParams();
      if (isDemo) qs.set('demo', '1');
      const res = await fetch(`/api/topscorers?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      render(json.scorers || []);
      $('updatedBadge').textContent = 'Just updated';
    } catch (err) {
      console.error('[topscorers]', err);
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
    root.innerHTML = list.map((s) => {
      const photo = s.photo ? `<img src="${esc(s.photo)}" alt="">` : '';
      const flag = s.teamLogo ? `<img src="${esc(s.teamLogo)}" alt="">` : '';
      const assists = s.assists
        ? `${s.assists} Assist${s.assists > 1 ? 's' : ''}`
        : 'No assists';
      return `
        <div class="scorer${s.rank === 1 ? ' scorer--lead' : ''}">
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

  refresh();
  setInterval(refresh, POLL_MS);
})();
