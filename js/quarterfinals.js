/**
 * Quarter Finals — "State of Play" knockout bracket (Figma 2233-6003).
 *
 * Layout: two equal columns, one round deeper than js/roundof16.js.
 *   LEFT  — all 4 Quarter-final matches, grouped as 2 pairs.
 *   RIGHT — the 2 Semi-final matches each pair feeds into (TBC until the
 *           QF winners are known).
 *
 * NEW vs the R16 board: every match carries its kick-off time (brand-yellow
 * caption under the card, e.g. "FRIDAY 10 JULY 6AM AEST"). Times come from the
 * REAL fixture's kickoff — a projected/unposted match shows a muted "KICK-OFF
 * TBC" instead of a guessed time (SF fixtures aren't posted by api-football
 * until the QFs resolve). Finished matches show winner/loser tile states, so
 * the time caption stays meaningful pre-match and the result takes over after.
 *
 * Tile states (per match side): as js/roundof16.js — charcoal default, white
 * winner (charcoal name), desaturated loser, grey TBC.
 *
 * Data — same merge strategy as js/roundof16.js, one round further:
 *   standings → R32 template → R16 feeds → QF feeds. Real fixtures for each
 *   round (/api/upcoming-list?round=...) claim their projected slot by team
 *   membership and are authoritative for matchup, kickoff and result. QF slots
 *   fill the moment an R16 match is decided even before the QF is posted.
 *   SF slots: winners of the QF pair; a posted SF fixture is claimed by team
 *   membership, and any leftover SF fixtures are assigned to teamless slots
 *   chronologically (SF1 kicks off before SF2 in the official schedule) so
 *   kick-off times can show before the pairings are known.
 *
 *   ?demo=1 → static snapshot mirroring the REAL QF draw (verified against
 *   /api/upcoming-list, 2026-07-08) with QF1 decided so winner/loser tiles and
 *   a populated SF slot are visible offline.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const CACHE_KEY = 'cba:quarterfinals:v1';

  const grid = document.getElementById('grid');
  const badge = document.getElementById('updatedBadge');

  // ── WC2026 bracket templates (same verified chain as js/roundof16.js) ──────
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
  const R16_FEEDS = {
    89: [74, 77], 90: [73, 75], 91: [76, 78], 92: [79, 80],
    93: [83, 84], 94: [81, 82], 95: [86, 88], 96: [85, 87],
  };
  // QF97–100 ← R16 winners; SF101/102 ← QF winners (verified: matches the real
  // posted QF fixtures — 97 FRA-MAR, 98 ESP-BEL, 99 NOR-ENG, 100 ARG-SUI).
  const QF_FEEDS = { 97: [89, 90], 98: [93, 94], 99: [91, 92], 100: [95, 96] };
  const SF_FEEDS = { 101: [97, 98], 102: [99, 100] };
  // Render rows: [QF pair] → the SF it feeds.
  const ROWS = [
    { pair: [97, 98], sf: 101 },
    { pair: [99, 100], sf: 102 },
  ];

  // ── Resolve the chain: standings → R32 → R16 (as js/roundof16.js) ──────────
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
    if (!slot || slot.slot === '3') return null;
    const g = groups[slot.group];
    if (!g) return null;
    return g.byRank[slot.slot === 'W' ? 1 : 2] || null;
  }
  function winnerOf(m) {
    if (!m) return null;
    return m.winner === 'home' ? m.home : m.winner === 'away' ? m.away : null;
  }

  // Project each slot, then claim the real fixture that shares a known team
  // (each team plays one match per round, so any shared team is unambiguous).
  // Claimed fixtures carry matchup + result + KICKOFF; projections have no time.
  function claimFixture(pool, home, away) {
    const known = [home, away].filter(Boolean);
    for (let i = 0; i < pool.length; i++) {
      const f = pool[i];
      if (known.includes(f.home.name) || known.includes(f.away.name)) {
        return pool.splice(i, 1)[0];
      }
    }
    return null;
  }
  function buildRound(feeds, prevByNum, fixtures) {
    const pool = (fixtures || []).slice();
    const byNum = {};
    for (const m of Object.keys(feeds)) {
      const [a, b] = feeds[m];
      const home = winnerOf(prevByNum[a]);
      const away = winnerOf(prevByNum[b]);
      const f = claimFixture(pool, home, away);
      byNum[m] = f
        ? { home: f.home.name, away: f.away.name, winner: f.winner, kickoffISO: f.kickoffISO }
        : { home, away, winner: null, kickoffISO: null };
    }
    return { byNum, leftover: pool };
  }
  function buildR32ByNum(groups, r32Fixtures) {
    const pool = (r32Fixtures || []).slice();
    const byNum = {};
    for (const m of Object.keys(R32_TEMPLATE)) {
      const tpl = R32_TEMPLATE[m];
      const home = resolveSlot(tpl.home, groups);
      const away = resolveSlot(tpl.away, groups);
      const f = claimFixture(pool, home, away);
      byNum[m] = f
        ? { home: f.home.name, away: f.away.name, winner: f.winner }
        : { home, away, winner: null };
    }
    return byNum;
  }

  function buildRows(st, r32Fx, r16Fx, qfFx, sfFx) {
    const groups = groupsFromStandings(st);
    const r32 = buildR32ByNum(groups, r32Fx);
    const r16 = buildRound(R16_FEEDS, r32, r16Fx).byNum;
    const qf = buildRound(QF_FEEDS, r16, qfFx).byNum;
    const sfBuilt = buildRound(SF_FEEDS, qf, sfFx);
    const sf = sfBuilt.byNum;
    // SF fixtures posted before any QF winner exists can't be claimed by team —
    // assign leftovers to timeless SF slots chronologically (SF1 before SF2).
    const leftovers = sfBuilt.leftover
      .slice()
      .sort((a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO));
    for (const num of Object.keys(SF_FEEDS)) {
      if (!sf[num].kickoffISO && leftovers.length) {
        sf[num].kickoffISO = leftovers.shift().kickoffISO;
      }
    }
    return ROWS.map((r) => ({
      qf: r.pair.map((n) => qf[n]),
      sf: sf[r.sf],
    }));
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const NAME_REMAP = { 'Cape Verde Islands': 'Cabo Verde' };
  const displayName = (name) => (NAME_REMAP[name] || name || '').toUpperCase();

  // "FRIDAY 10 JULY 6AM AEST" — minutes only when not on the hour (6:30AM).
  // AEST/AEDT note: July is winter, Australia/Sydney == AEST (UTC+10).
  function kickoffAEST(iso) {
    if (!iso) return null;
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'long', day: 'numeric', month: 'long',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    const period = (p.dayPeriod || '').toUpperCase().replace(/\./g, '');
    const time = p.minute === '00' ? p.hour : `${p.hour}:${p.minute}`;
    return `${p.weekday} ${p.day} ${p.month} ${time}${period} AEST`.toUpperCase();
  }

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
  function matchHtml(m) {
    const homeState = m.winner === 'home' ? 'winner' : m.winner === 'away' ? 'loser' : '';
    const awayState = m.winner === 'away' ? 'winner' : m.winner === 'home' ? 'loser' : '';
    const time = kickoffAEST(m.kickoffISO);
    return `
      <div class="match">
        <div class="h2h-card">
          ${tileHtml(m.home, homeState)}
          <span class="h2h-vs">VS</span>
          ${tileHtml(m.away, awayState)}
        </div>
        ${time ? `<div class="ko-time">${time}</div>` : `<div class="ko-time tbc">Kick-off TBC</div>`}
      </div>`;
  }
  // Two explicit columns (Figma 2233-6003): the QF column is a fixed-height
  // block of 2 pairs and the SF column a shorter block of 2 matches, BOTH
  // vertically centred in the bracket area — the cluster pulls to the middle
  // (Figma h-1947 / h-1479 inside a centred h-2321 row) rather than spreading
  // edge-to-edge like the R16 board.
  function render(rows, badgeText) {
    grid.innerHTML = `
      <div class="col col-qf">
        ${rows.map((r) => `<div class="pair">${r.qf.map(matchHtml).join('')}</div>`).join('')}
      </div>
      <div class="col col-sf">
        ${rows.map((r) => matchHtml(r.sf)).join('')}
      </div>`;
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
      const rounds = ['Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals'];
      const [stRes, ...roundRes] = await Promise.all([
        fetch('/api/standings', { cache: 'no-store' }),
        ...rounds.map((r) =>
          fetch(`/api/upcoming-list?count=16&round=${encodeURIComponent(r)}`, { cache: 'no-store' })),
      ]);
      const st = await stRes.json();
      if (!stRes.ok || !st.ok) throw new Error(st.error || `standings HTTP ${stRes.status}`);
      const [r32, r16, qf, sf] = await Promise.all(roundRes.map(async (res) => {
        const json = await res.json();
        return (res.ok && json.ok) ? (json.matches || []) : [];
      }));
      const rows = buildRows(st, r32, r16, qf, sf);
      writeCache(rows);
      render(rows, 'Just updated');
    } catch (err) {
      console.error('[quarterfinals]', err);
      badge.textContent = 'Update failed';
    }
  }

  // ── Demo: mirrors the REAL QF draw + kickoffs (api-football, 2026-07-08).
  //    QF1 decided (illustrative) so winner/loser tiles + a populated SF slot
  //    show offline; SF kickoffs stay TBC exactly like live pre-posting. ──────
  const DEMO_ROWS = [
    {
      qf: [
        { home: 'France', away: 'Morocco', winner: 'home', kickoffISO: '2026-07-09T20:00:00+00:00' },
        { home: 'Spain', away: 'Belgium', winner: null, kickoffISO: '2026-07-10T19:00:00+00:00' },
      ],
      sf: { home: 'France', away: null, winner: null, kickoffISO: null },
    },
    {
      qf: [
        { home: 'Norway', away: 'England', winner: null, kickoffISO: '2026-07-11T21:00:00+00:00' },
        { home: 'Argentina', away: 'Switzerland', winner: null, kickoffISO: '2026-07-12T01:00:00+00:00' },
      ],
      sf: { home: null, away: null, winner: null, kickoffISO: null },
    },
  ];

  // ── Boot ────────────────────────────────────────────────────────────────────
  if (isDemo) {
    render(DEMO_ROWS, 'Demo');
    return;
  }
  const cached = readCache();
  if (cached) render(cached.rows, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
})();
