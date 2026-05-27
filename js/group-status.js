/**
 * Renders the group-stage state-of-play screen.
 *
 *   data-page="1" → Groups A–F
 *   data-page="2" → Groups G–L  (demo: G–H + 4 'Available in 2026' placeholders)
 *
 * Polls /api/standings every 5 minutes. ?demo=1 swaps in WC 2022 final standings
 * so the screen can be previewed in a finished-stage state before the tournament.
 */

(function () {
  const PAGE_GROUPS = {
    1: ['A', 'B', 'C', 'D', 'E', 'F'],
    2: ['G', 'H', 'I', 'J', 'K', 'L'],
  };
  const POLL_MS = 5 * 60 * 1000; // 5 minutes
  // qualified at top, then contention, then eliminated — within each, by points desc
  const STATUS_RANK = { qualified: 0, contention: 1, eliminated: 2 };

  const grid = document.getElementById('grid');
  const badge = document.getElementById('updatedBadge');
  const page = Number(document.body.dataset.page || 1);
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const letters = PAGE_GROUPS[page] || PAGE_GROUPS[1];

  // ── Rendering ──────────────────────────────────────────────────────────────

  function sortTeams(teams) {
    return [...teams].sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (s !== 0) return s;
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd  !== a.gd ) return b.gd  - a.gd;
      return b.gf - a.gf;
    });
  }

  function rowHtml(team) {
    const code = teamCode(team.name);
    const cls  = `grow grow--${team.status}`;
    return `
      <div class="${cls}">
        <div class="grow-left">
          <div class="grow-flag"><img alt="${team.name}"></div>
          <div class="grow-code">${code}</div>
        </div>
        <div class="grow-stats">
          <span class="gs-reg">${team.mp}</span>
          <span class="gs-reg">${team.w}</span>
          <span class="gs-reg">${team.d}</span>
          <span class="gs-reg">${team.l}</span>
          <span class="gs-pts">${team.pts}</span>
        </div>
      </div>`;
  }

  function cardHtml(letter, group) {
    const rows = sortTeams(group.teams).map(rowHtml).join('');
    return `
      <div class="gcard" data-group="${letter}">
        <div class="gtitle">Group ${letter}</div>
        <div class="gdivider"></div>
        <div class="gcols">
          <span>MP</span><span>W</span><span>D</span><span>L</span><span>PTS</span>
        </div>
        <div class="grows">${rows}</div>
      </div>`;
  }

  function placeholderHtml(letter) {
    return `
      <div class="gcard gcard--placeholder" data-group="${letter}">
        <div class="gtitle">Group ${letter}</div>
        <div class="gdivider"></div>
        <div class="placeholder-msg">Available in 2026</div>
      </div>`;
  }

  function paintFlags() {
    grid.querySelectorAll('.grow-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  function render(payload) {
    const byLetter = new Map((payload.groups || []).map((g) => [g.letter, g]));
    const cards = letters.map((L) => {
      const g = byLetter.get(L);
      return g ? cardHtml(L, g) : placeholderHtml(L);
    });
    grid.innerHTML = cards.join('');
    paintFlags();
    setBadge('Just updated');
  }

  function renderError(msg) {
    grid.innerHTML = letters.map(placeholderHtml).join('');
    setBadge('Update failed');
    console.error('[group-status]', msg);
  }

  function setBadge(text) {
    if (badge) badge.textContent = text;
  }

  // ── Fetching ───────────────────────────────────────────────────────────────

  async function fetchOnce() {
    setBadge('Updating…');
    try {
      const url = isDemo ? '/api/standings?demo=1' : '/api/standings';
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      render(json);
    } catch (err) {
      renderError(err.message || String(err));
    }
  }

  fetchOnce();
  setInterval(fetchOnce, POLL_MS);
})();
