/**
 * Round of 32 (knockout overview).
 *
 *   GET /api/upcoming-list?round=Round of 32&count=16
 *   demo (?demo=1) → 2022 R16 (8 fixtures — leave 8 placeholder slots)
 *
 * Annotation: when match yet to play, both teams in white. When complete,
 * the losing team is mid-grey + flag desaturated.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const ROUND_NAME = 'Round of 32';
  const DEMO_ROUND = 'Round of 16'; // 2022 had R16 not R32

  const grid = document.getElementById('grid');
  const badge = document.getElementById('updatedBadge');

  function flagDataUrl(name) {
    return getFlagSVG?.(name) || '';
  }

  function teamSide(team, opponent, finished) {
    if (!finished) return 'open';
    if (team.scoreH != null && team.scoreA != null) {
      // We pass the comparison via `loser` flag from caller
    }
    return 'open';
  }

  function cardHtml(fix) {
    if (!fix) {
      return `
        <div class="h2h-card h2h-empty">
          <span class="h2h-tbd">TBD</span>
          <span class="h2h-vs">VS</span>
          <span class="h2h-tbd">TBD</span>
        </div>`;
    }
    // Use server-resolved `winner` so penalty shootouts mark the right side.
    const homeLoser = fix.winner === 'away';
    const awayLoser = fix.winner === 'home';

    const homeCode = teamCode(fix.home.name);
    const awayCode = teamCode(fix.away.name);
    return `
      <div class="h2h-card">
        <div class="h2h-team home ${homeLoser ? 'loser' : ''}">
          <div class="h2h-flag"><img alt="${fix.home.name}"></div>
          <span class="h2h-code">${homeCode}</span>
        </div>
        <span class="h2h-vs">VS</span>
        <div class="h2h-team away ${awayLoser ? 'loser' : ''}">
          <span class="h2h-code">${awayCode}</span>
          <div class="h2h-flag"><img alt="${fix.away.name}"></div>
        </div>
      </div>`;
  }

  async function refresh() {
    badge.textContent = 'Updating…';
    try {
      const round = isDemo ? DEMO_ROUND : ROUND_NAME;
      const url = `/api/upcoming-list?count=16&round=${encodeURIComponent(round)}${isDemo ? '&demo=1' : ''}`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);

      const fixtures = json.matches || [];
      // Render 16 slots (pad with empty if fewer than 16 — common pre-tournament).
      const cards = [];
      for (let i = 0; i < 16; i++) cards.push(cardHtml(fixtures[i] || null));
      grid.innerHTML = cards.join('');
      grid.querySelectorAll('.h2h-flag img').forEach((img) => setFlag(img, img.alt, null));
      badge.textContent = 'Just updated';
    } catch (err) {
      console.error('[roundof32]', err);
      badge.textContent = 'Update failed';
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();
