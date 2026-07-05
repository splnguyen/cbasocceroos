/**
 * Round of 16 — "State of Play" knockout bracket (Figma 2177-5443).
 *
 * Layout: two equal columns (one round deeper than js/roundof32.js).
 *   LEFT  — all 8 Round-of-16 matches (16 teams), grouped as 4 pairs.
 *   RIGHT — the 4 Quarter-final matches each pair feeds into. The two R16 matches
 *           in a pair feed ONE QF, so its two teams are those matches' winners —
 *           blank circle + "TBC" until a winner is known.
 *
 * Tile states (per match side):
 *   default (not played) : charcoal tile, white code
 *   winner               : white tile, charcoal code
 *   loser                : charcoal tile, desaturated flag + grey code
 *   TBC                  : empty flag + grey "TBC"
 *
 * Data — merged so the board always shows the full R16 draw:
 *   1. /api/upcoming-list?round=Round of 16 → REAL R16 fixtures (exact teams, live
 *      scores, server-resolved `winner` incl. penalty shootouts). Authoritative
 *      for the matchup + result once the provider schedules them.
 *   2. Projection from the R32 result: each R16 slot is the WINNER of a feeding
 *      R32 match. R32 results are themselves rebuilt exactly as js/roundof32.js
 *      does — real R32 fixtures (/api/upcoming-list?round=Round of 32) merged onto
 *      the FIFA R32 template projected from /api/standings — so R16 slots fill in
 *      the instant an R32 match is decided, even before the R16 fixture is posted.
 *
 * A real R16 fixture is matched onto its slot by team membership (each team plays
 * exactly one R16 match, so any shared team is unambiguous).
 *
 *   ?demo=1 → static 2026-shaped snapshot with a few finished R16 matches so the
 *             winner/loser tiles AND the populated QF column are visible offline.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const R16_ROUND = 'Round of 16';
  const R32_ROUND = 'Round of 32';
  const CACHE_KEY = 'cba:roundof16:v1';

  const grid = document.getElementById('grid');
  const badge = document.getElementById('updatedBadge');

  // ── WC2026 R32 bracket template ───────────────────────────────────────────
  // Same verified template as js/roundof32.js / js/tournament-draw.js. W('X') =
  // winner of group X, R('X') = runner-up of X, T3 = best-third (TBC until fixed).
  // Used only to rebuild the R32 RESULTS that feed the R16 slots below.
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
  // Each R16 match (89–96) is fed by two R32 matches; home = winner of the first,
  // away = winner of the second (verified `feeds` mapping — see tournament-draw.js).
  const R16_FEEDS = {
    89: [74, 77], 90: [73, 75], 91: [76, 78], 92: [79, 80],
    93: [83, 84], 94: [81, 82], 95: [86, 88], 96: [85, 87],
  };
  // The 4 pairs (each = two R16 matches feeding one QF), in render order: top half
  // (→ SF1) first, then bottom half (→ SF2). Within a pair the first match renders
  // on top. QF pairings: 89+90→QF97, 93+94→QF98, 91+92→QF99, 95+96→QF100.
  const PAIRS = [
    [89, 90], [93, 94],   // top half → SF1
    [91, 92], [95, 96],   // bottom half → SF2
  ];

  // ── Resolve R32 template slots against group tables ─────────────────────────
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

  // ── Rebuild the R32 results (projected bracket + real fixtures) ──────────────
  // Identical strategy to js/roundof32.js: project each slot from standings, then
  // claim the real fixture that shares a known team (one match per fixture).
  function buildR32ByNum(groups, r32Fixtures) {
    const pool = (r32Fixtures || []).slice();
    const byNum = {};
    for (const m of Object.keys(R32_TEMPLATE)) {
      const tpl = R32_TEMPLATE[m];
      const home = resolveSlot(tpl.home, groups);
      const away = resolveSlot(tpl.away, groups);
      const known = [home, away].filter(Boolean);
      let idx = -1;
      for (let i = 0; i < pool.length; i++) {
        const f = pool[i];
        if (known.includes(f.home.name) || known.includes(f.away.name)) { idx = i; break; }
      }
      if (idx >= 0) {
        const f = pool.splice(idx, 1)[0];
        byNum[m] = { home: f.home.name, away: f.away.name, winner: f.winner };
      } else {
        byNum[m] = { home, away, winner: null };
      }
    }
    return byNum;
  }

  // Winner of a match → the team that advances (null until decided).
  function winnerOf(m) {
    if (!m) return null;
    return m.winner === 'home' ? m.home : m.winner === 'away' ? m.away : null;
  }

  // ── Build the R16 matches: projection (R32 winners) + real R16 fixtures ──────
  function buildR16ByNum(r32ByNum, r16Fixtures) {
    const pool = (r16Fixtures || []).slice();
    const byNum = {};
    for (const m of Object.keys(R16_FEEDS)) {
      const [a, b] = R16_FEEDS[m];
      const home = winnerOf(r32ByNum[a]);
      const away = winnerOf(r32ByNum[b]);

      // Claim the real R16 fixture that contains either projected team.
      const known = [home, away].filter(Boolean);
      let idx = -1;
      for (let i = 0; i < pool.length; i++) {
        const f = pool[i];
        if (known.includes(f.home.name) || known.includes(f.away.name)) { idx = i; break; }
      }
      if (idx >= 0) {
        const f = pool.splice(idx, 1)[0];   // authoritative once posted
        byNum[m] = { home: f.home.name, away: f.away.name, winner: f.winner };
      } else {
        byNum[m] = { home, away, winner: null };
      }
    }
    return byNum;
  }

  // Build the 4 bracket rows: each has its R16 pair + the QF match it feeds.
  function buildRows(r16ByNum) {
    return PAIRS.map(([a, b]) => {
      const mA = r16ByNum[a], mB = r16ByNum[b];
      return { r16: [mA, mB], qf: { home: winnerOf(mA), away: winnerOf(mB), winner: null } };
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  // R16 tiles are the LARGE card-country-h2h component (Figma 2177-5722): a
  // vertical card — 70px circular flag over the FULL country name — bigger than
  // the R32 pill (48px flag + 3-letter code). Names ≥11 chars get a smaller size
  // so e.g. SWITZERLAND still fits on one line.
  const NAME_REMAP = { 'Cape Verde Islands': 'Cabo Verde' };
  const displayName = (name) => (NAME_REMAP[name] || name || '').toUpperCase();

  function tileHtml(name, state) {
    if (!name) {
      return `<div class="h2h-tile tbc"><span class="h2h-flag"></span><span class="h2h-name">TBC</span></div>`;
    }
    const label = displayName(name);
    const long = label.length >= 11 ? ' long' : '';
    return `
      <div class="h2h-tile ${state}">
        <span class="h2h-flag"><img alt="${name}"></span>
        <span class="h2h-name${long}">${label}</span>
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
        <div class="pair">${cardHtml(row.r16[0])}${cardHtml(row.r16[1])}</div>
        <div class="qf">${cardHtml(row.qf)}</div>
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
      const [stRes, r32Res, r16Res] = await Promise.all([
        fetch('/api/standings', { cache: 'no-store' }),
        fetch(`/api/upcoming-list?count=16&round=${encodeURIComponent(R32_ROUND)}`, { cache: 'no-store' }),
        fetch(`/api/upcoming-list?count=16&round=${encodeURIComponent(R16_ROUND)}`, { cache: 'no-store' }),
      ]);
      const st = await stRes.json();
      const r32 = await r32Res.json();
      const r16 = await r16Res.json();
      if (!stRes.ok || !st.ok) throw new Error(st.error || `standings HTTP ${stRes.status}`);
      const groups = groupsFromStandings(st);
      const r32Fixtures = (r32Res.ok && r32.ok) ? (r32.matches || []) : [];
      const r16Fixtures = (r16Res.ok && r16.ok) ? (r16.matches || []) : [];
      const rows = buildRows(buildR16ByNum(buildR32ByNum(groups, r32Fixtures), r16Fixtures));
      writeCache(rows);
      render(rows, 'Just updated');
    } catch (err) {
      console.error('[roundof16]', err);
      badge.textContent = 'Update failed';
    }
  }

  // ── Demo: static snapshot mirroring the REAL 2026 R16 draw (verified against
  //    /api/upcoming-list AND press coverage, 2026-07-05: FRA 1-0 PAR, MAR 3-0
  //    CAN → QF1 France vs Morocco). First pair decided so winner/loser tiles
  //    AND the populated QF column are visible; the rest stay TBC. ──────────────
  const DEMO_BYNUM = {
    89: { home: 'Paraguay',     away: 'France',       winner: 'away' },  // FRA ↑ 1-0
    90: { home: 'Canada',       away: 'Morocco',      winner: 'away' },  // MAR ↑ 3-0
    93: { home: 'Portugal',     away: 'Spain',        winner: null },
    94: { home: 'USA',          away: 'Belgium',      winner: null },
    91: { home: 'Brazil',       away: 'Norway',       winner: null },
    92: { home: 'Mexico',       away: 'England',      winner: null },
    95: { home: 'Argentina',    away: 'Egypt',        winner: null },
    96: { home: 'Switzerland',  away: 'Colombia',     winner: null },
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
