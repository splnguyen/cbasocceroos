/**
 * Round of 32 — "State of Play" knockout bracket (Figma 2162-5229).
 *
 * Layout: two equal columns.
 *   LEFT  — all 16 Round-of-32 matches (32 teams), grouped as 8 pairs.
 *   RIGHT — the 8 Round-of-16 matches each pair feeds into. The two R32 matches
 *           in a pair feed ONE R16 match, so its two teams are those matches'
 *           winners — blank circle + "TBC" until a winner is known.
 *
 * Tile states (per match side):
 *   default (not played) : charcoal tile, white code
 *   winner               : white tile, charcoal code
 *   loser                : charcoal tile, desaturated flag + grey code
 *   TBC                  : empty flag + grey "TBC"
 *
 * Data — merged so the board always shows the full draw:
 *   1. /api/upcoming-list?round=Round of 32 → REAL fixtures (exact teams, live
 *      scores, server-resolved `winner` incl. penalty shootouts). Authoritative
 *      for pairing + result, and the only reliable source for best-third teams.
 *   2. /api/standings → live group tables, projected onto the FIFA R32 template
 *      (R32_TEMPLATE) to fill slots the provider hasn't scheduled yet. Each slot
 *      is a group WINNER (1X) / RUNNER-UP (2X); best-third (T3) slots stay TBC.
 *
 * A real fixture is matched onto its template slot by team membership (each team
 * plays exactly one R32 match, so any shared team is unambiguous).
 *
 *   ?demo=1 → static 2026-shaped snapshot with a few finished R32 matches so the
 *             winner/loser tiles AND R16 population are visible offline.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const ROUND_NAME = 'Round of 32';
  const CACHE_KEY = 'cba:roundof32:v2';

  const grid = document.getElementById('grid');
  const badge = document.getElementById('updatedBadge');

  // ── WC2026 R32 bracket template ───────────────────────────────────────────
  // Verified against Wikipedia's knockout wikitext + FIFA match-centre slugs
  // (same source as js/tournament-draw.js). W('X')=winner of group X,
  // R('X')=runner-up of X, T3=a best-third-placed team (TBC until fixed).
  const W = (g) => ({ slot: 'W', group: g });
  const R = (g) => ({ slot: 'R', group: g });
  const T3 = { slot: '3' };
  const R32_TEMPLATE = {
    73: { home: R('A'), away: R('B') },
    74: { home: W('E'), away: T3     },
    75: { home: W('F'), away: R('C') },
    76: { home: W('C'), away: R('F') },
    77: { home: W('I'), away: T3     },
    78: { home: R('E'), away: R('I') },
    79: { home: W('A'), away: T3     },
    80: { home: W('L'), away: T3     },
    81: { home: W('D'), away: T3     },
    82: { home: W('G'), away: T3     },
    83: { home: R('K'), away: R('L') },
    84: { home: W('H'), away: R('J') },
    85: { home: W('B'), away: T3     },
    86: { home: W('J'), away: R('H') },
    87: { home: W('K'), away: T3     },
    88: { home: R('D'), away: R('G') },
  };
  // The 8 pairs (each = two R32 matches feeding one R16 match), in render order:
  // top half (→ SF1) first, then bottom half (→ SF2). Within a pair the first
  // match renders on top. Pairings come from the verified R16 `feeds` mapping
  // (74+77→R16 89, 73+75→90, 83+84→93, 81+82→94, 76+78→91, 79+80→92, 86+88→95,
  // 85+87→96 — see tournament-draw.js).
  const PAIRS = [
    [74, 77], [73, 75], [83, 84], [81, 82],
    [76, 78], [79, 80], [86, 88], [85, 87],
  ];

  // ── Resolve template slots against group tables ────────────────────────────
  function groupsFromStandings(json) {
    const map = {};
    for (const g of json.groups || []) {
      const byRank = {};
      for (const t of g.teams || []) if (t.rank) byRank[t.rank] = t.name;
      map[g.letter] = { byRank };
    }
    return map;
  }
  function resolveSlot(slot, groups) {
    if (!slot || slot.slot === '3') return null;          // best-third → TBC
    const g = groups[slot.group];
    if (!g) return null;
    return g.byRank[slot.slot === 'W' ? 1 : 2] || null;   // group 1st / 2nd
  }

  // ── Merge real fixtures onto the projected bracket → { matchNum: match } ─────
  function buildMatches(groups, fixtures) {
    const pool = (fixtures || []).slice();   // consumed as we match
    const byNum = {};
    for (const m of Object.keys(R32_TEMPLATE)) {
      const tpl = R32_TEMPLATE[m];
      const home = resolveSlot(tpl.home, groups);
      const away = resolveSlot(tpl.away, groups);

      // Find the real fixture that contains either known side (unique per team).
      const known = [home, away].filter(Boolean);
      let idx = -1;
      for (let i = 0; i < pool.length; i++) {
        const f = pool[i];
        if (known.includes(f.home.name) || known.includes(f.away.name)) { idx = i; break; }
      }
      if (idx >= 0) {
        const f = pool.splice(idx, 1)[0];   // claim it (one match per fixture)
        byNum[m] = { home: f.home.name, away: f.away.name, winner: f.winner };
      } else {
        byNum[m] = { home, away, winner: null };
      }
    }
    return byNum;
  }

  // R32 winner → the team that advances to the R16 (null until decided).
  function winnerOf(m) {
    if (!m) return null;
    return m.winner === 'home' ? m.home : m.winner === 'away' ? m.away : null;
  }

  // Build the 8 bracket rows: each has its R32 pair + the R16 match it feeds.
  function buildRows(byNum) {
    return PAIRS.map(([a, b]) => {
      const mA = byNum[a], mB = byNum[b];
      return { r32: [mA, mB], r16: { home: winnerOf(mA), away: winnerOf(mB), winner: null } };
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function tileHtml(name, state) {
    if (!name) {
      return `<div class="h2h-tile tbc"><span class="h2h-flag"></span><span class="h2h-code">TBC</span></div>`;
    }
    return `
      <div class="h2h-tile ${state}">
        <span class="h2h-flag"><img alt="${name}"></span>
        <span class="h2h-code">${teamCode(name)}</span>
      </div>`;
  }
  function cardHtml(m) {
    // Server-resolved `winner` ('home'|'away'|null) — covers penalty shootouts.
    const homeState = m.winner === 'home' ? 'winner' : m.winner === 'away' ? 'loser' : '';
    const awayState = m.winner === 'away' ? 'winner' : m.winner === 'home' ? 'loser' : '';
    return `
      <div class="h2h-card">
        ${tileHtml(m.home, homeState)}
        <span class="h2h-vs">VS</span>
        ${tileHtml(m.away, awayState)}
      </div>`;
  }
  function rowHtml(row) {
    return `
      <div class="brow">
        <div class="pair">${cardHtml(row.r32[0])}${cardHtml(row.r32[1])}</div>
        <div class="r16">${cardHtml(row.r16)}</div>
      </div>`;
  }
  function render(rows, badgeText) {
    grid.innerHTML = rows.map(rowHtml).join('');
    grid.querySelectorAll('.h2h-flag img').forEach((img) => setFlag(img, img.alt, null));
    badge.textContent = badgeText;
  }

  // ── Live cache (instant paint on carousel revisits) ─────────────────────────
  function readCache() {
    try {
      const p = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return p && p.rows && p.ts ? p : null;
    } catch (e) { return null; }
  }
  function writeCache(rows) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ rows, ts: Date.now() })); }
    catch (e) { /* best-effort */ }
  }
  function cacheBadge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins <= 0) return 'Just updated';
    if (mins === 1) return 'Updated 1 min ago';
    return `Updated ${mins} mins ago`;
  }

  async function refresh() {
    badge.textContent = 'Updating…';
    try {
      const [stRes, fxRes] = await Promise.all([
        fetch('/api/standings', { cache: 'no-store' }),
        fetch(`/api/upcoming-list?count=16&round=${encodeURIComponent(ROUND_NAME)}`, { cache: 'no-store' }),
      ]);
      const st = await stRes.json();
      const fx = await fxRes.json();
      if (!stRes.ok || !st.ok) throw new Error(st.error || `standings HTTP ${stRes.status}`);
      const groups = groupsFromStandings(st);
      const fixtures = (fxRes.ok && fx.ok) ? (fx.matches || []) : [];
      const rows = buildRows(buildMatches(groups, fixtures));
      writeCache(rows);
      render(rows, 'Just updated');
    } catch (err) {
      console.error('[roundof32]', err);
      badge.textContent = 'Update failed';
    }
  }

  // ── Demo: static snapshot. First two pairs have results so the winner/loser
  //    tiles AND the populated R16 column are visible; the rest stay TBC. ──────
  const DEMO_BYNUM = {
    73: { home: 'South Africa', away: 'Canada',       winner: 'away' },  // CAN ↑
    75: { home: 'Netherlands',  away: 'Morocco',      winner: 'home' },  // NED ↑
    74: { home: 'Germany',      away: 'Paraguay',     winner: 'home' },  // GER ↑
    77: { home: 'France',       away: 'Sweden',       winner: 'home' },  // FRA ↑
    76: { home: 'Brazil',       away: 'Japan',        winner: null },
    78: { home: 'Ivory Coast',  away: 'Norway',       winner: null },
    79: { home: 'Mexico',       away: null,           winner: null },
    80: { home: 'England',      away: null,           winner: null },
    81: { home: 'USA',          away: 'Bosnia & Herzegovina', winner: null },
    82: { home: 'Belgium',      away: null,           winner: null },
    83: { home: 'Portugal',     away: 'Croatia',      winner: null },
    84: { home: 'Spain',        away: 'Austria',      winner: null },
    85: { home: 'Switzerland',  away: null,           winner: null },
    86: { home: 'Argentina',    away: 'Cape Verde Islands', winner: null },
    87: { home: 'Colombia',     away: null,           winner: null },
    88: { home: 'Australia',    away: 'Egypt',        winner: null },
  };

  // ── Boot ────────────────────────────────────────────────────────────────────
  if (isDemo) {
    render(buildRows(DEMO_BYNUM), 'Demo');
    return;
  }
  const cached = readCache();
  if (cached) render(cached.rows, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
})();
