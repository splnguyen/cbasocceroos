/**
 * Tournament Draw — full vertical bracket.
 *
 *   R32 (top)  →  R16 (top)  →  QF (top)  →  SF1
 *                                              ↓
 *                                            FINAL
 *                                              ↑
 *   R32 (bot)  ←  R16 (bot)  ←  QF (bot)  ←  SF2
 *
 * Modes
 *   default (live) — R32 slots populate from /api/standings as each group
 *                    finalises (see "Live R32 population" below). R16 onward
 *                    stay TBC until those fixtures are actually played.
 *   ?demo=1        — 2022 WC actual bracket (R16 onward; 2022 had no R32 so
 *                    the R32 strips stay TBC).
 *
 * Live R32 population
 *   api-football has NOT scheduled any knockout fixtures yet (verified: only
 *   "Group Stage - 1/2/3" exist), so there are no R32 fixtures to read. Instead
 *   we project the FIFA-published R32 bracket template (R32_TEMPLATE below)
 *   onto the live group tables: every R32 slot is a group WINNER (1X) or
 *   RUNNER-UP (2X) — except the best-third slots, which stay TBC because FIFA's
 *   third-place assignment isn't fixed until all 12 groups finish. A 1X/2X slot
 *   is filled ONLY once that group has played all 3 matchdays: until a group is
 *   complete the 1st/2nd order can still swap on the final day, and 1st vs 2nd
 *   land in DIFFERENT bracket positions, so filling early could misplace a team.
 *   (Once api-football publishes real R32 fixtures they'd be the better source —
 *   they carry the third-place teams and results too — but they don't exist yet.)
 *
 * Winner/loser styling per Figma annotation:
 *   - winner side: white flag + white/yellow code
 *   - loser side:  mid-grey code + desaturated flag (greyscale 1 + opacity)
 */

(function () {
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const POLL_MS = 5 * 60 * 1000;
  const CACHE_KEY = 'cba:tournament-draw:v1';

  // ── 2022 WC bracket data ─────────────────────────────────────────────────
  // winner: 'home' | 'away' | null (TBC).  PEN/AET decided handled by the
  // visual treatment only — we just record who advanced.
  const BLANK = { home: null, away: null, winner: null };
  const blanks = (n) => Array(n).fill(0).map(() => ({ ...BLANK }));

  const DEMO_2022 = {
    // 2022 World Cup had no Round of 32 — keep blank.
    r32_top: blanks(8),
    r16_top: [
      { home: 'Netherlands', away: 'USA',         winner: 'home' },
      { home: 'Argentina',   away: 'Australia',   winner: 'home' },
      { home: 'France',      away: 'Poland',      winner: 'home' },
      { home: 'England',     away: 'Senegal',     winner: 'home' },
    ],
    qf_top: [
      { home: 'Netherlands', away: 'Argentina',   winner: 'away' }, // ARG on pens
      { home: 'France',      away: 'England',     winner: 'home' },
    ],
    sf_top: { home: 'Argentina',   away: 'Croatia', winner: 'home' }, // ARG 3-0
    final:  { home: 'Argentina',   away: 'France',  winner: 'home' }, // ARG 4-2 on pens
    sf_bot: { home: 'France',      away: 'Morocco', winner: 'home' }, // FRA 2-0
    qf_bot: [
      { home: 'Croatia',     away: 'Brazil',      winner: 'home' }, // CRO on pens
      { home: 'Morocco',     away: 'Portugal',    winner: 'home' }, // MAR 1-0
    ],
    r16_bot: [
      { home: 'Japan',       away: 'Croatia',     winner: 'away' }, // CRO on pens
      { home: 'Brazil',      away: 'South Korea', winner: 'home' },
      { home: 'Morocco',     away: 'Spain',       winner: 'home' }, // MAR on pens
      { home: 'Portugal',    away: 'Switzerland', winner: 'home' },
    ],
    r32_bot: blanks(8),
  };

  // All-TBC bracket — the initial live paint (and the shape R16+ keep for live).
  function blankBracket() {
    return {
      r32_top: blanks(8), r16_top: blanks(4), qf_top: blanks(2), sf_top: { ...BLANK },
      final:   { ...BLANK },
      sf_bot:  { ...BLANK }, qf_bot: blanks(2), r16_bot: blanks(4), r32_bot: blanks(8),
    };
  }

  // ── WC2026 R32 bracket template ───────────────────────────────────────────
  // Verified (HIGH confidence) against Wikipedia's knockout-stage wikitext, the
  // FIFA match-centre slugs embedded there, and Sky Sports — all in agreement.
  // Each match has two slots: W('X') = winner of group X, R('X') = runner-up of
  // group X, T3 = a best-third-placed team (TBC until FIFA's table resolves).
  // `feeds` = the R16 match (89–96) the winner advances to; it fixes the bracket
  // ordering (R16 89 is fed by M74+M77, which are out of numeric order, etc.).
  const W = (g) => ({ slot: 'W', group: g });
  const R = (g) => ({ slot: 'R', group: g });
  const T3 = { slot: '3' };
  const R32_TEMPLATE = [
    { m: 73, home: R('A'), away: R('B'), feeds: 90 },
    { m: 74, home: W('E'), away: T3,     feeds: 89 },
    { m: 75, home: W('F'), away: R('C'), feeds: 90 },
    { m: 76, home: W('C'), away: R('F'), feeds: 91 },
    { m: 77, home: W('I'), away: T3,     feeds: 89 },
    { m: 78, home: R('E'), away: R('I'), feeds: 91 },
    { m: 79, home: W('A'), away: T3,     feeds: 92 },
    { m: 80, home: W('L'), away: T3,     feeds: 92 },
    { m: 81, home: W('D'), away: T3,     feeds: 94 },
    { m: 82, home: W('G'), away: T3,     feeds: 94 },
    { m: 83, home: R('K'), away: R('L'), feeds: 93 },
    { m: 84, home: W('H'), away: R('J'), feeds: 93 },
    { m: 85, home: W('B'), away: T3,     feeds: 96 },
    { m: 86, home: W('J'), away: R('H'), feeds: 95 },
    { m: 87, home: W('K'), away: T3,     feeds: 96 },
    { m: 88, home: R('D'), away: R('G'), feeds: 95 },
  ];
  // Visual placement: each R32 row renders as adjacent pairs that sit above one
  // R16 cell, so the two matches feeding the same R16 must be neighbours. Top
  // half feeds R16 89/90/93/94 (→ SF1); bottom half feeds 91/92/95/96 (→ SF2).
  // NOTE: only the R32 slots + their R16 feed are verified; the QF/SF topology
  // used for the top/bottom split is the standard bracket and isn't load-bearing
  // here (R16+ render as TBC), but it keeps the layout ready for a later wire-up.
  const R32_TOP_ORDER = [74, 77, 73, 75, 83, 84, 81, 82];
  const R32_BOT_ORDER = [76, 78, 79, 80, 86, 88, 85, 87];

  // ── Resolve template slots against live group tables ───────────────────────
  function resolveSlot(slot, groups) {
    if (slot.slot === '3') return null;                 // best-third → TBC for now
    const g = groups[slot.group];
    if (!g || !g.complete) return null;                 // group not finalised → TBC
    return g.byRank[slot.slot === 'W' ? 1 : 2] || null; // 1st / 2nd of the group
  }

  function buildLiveBracket(groups) {
    const data = blankBracket();
    const byMatch = {};
    for (const tpl of R32_TEMPLATE) {
      byMatch[tpl.m] = { home: resolveSlot(tpl.home, groups), away: resolveSlot(tpl.away, groups), winner: null };
    }
    data.r32_top = R32_TOP_ORDER.map((m) => byMatch[m]);
    data.r32_bot = R32_BOT_ORDER.map((m) => byMatch[m]);
    return data;
  }

  // Reduce /api/standings to { LETTER: { complete, byRank:{1:name,2:name} } }.
  function groupsFromStandings(json) {
    const map = {};
    for (const g of json.groups || []) {
      const teams = g.teams || [];
      const complete = teams.length === 4 && teams.every((t) => (t.mp ?? 0) >= 3);
      const byRank = {};
      for (const t of teams) if (t.rank) byRank[t.rank] = t.name;
      map[g.letter] = { complete, byRank };
    }
    return map;
  }

  // ── Cell renderers ───────────────────────────────────────────────────────
  function cellSmall(match) {
    // R32 card (small): flag — VS — flag, vertically stacked
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--small">
        ${cellSmallSide(match.home, homeLoser, tbc)}
        <div class="vs">VS</div>
        ${cellSmallSide(match.away, awayLoser, tbc)}
      </div>`;
  }
  function cellSmallSide(name, loser, tbc) {
    if (!name) {
      return `<div class="bteam-small ${tbc ? 'tbc' : ''}"><div class="bflag bflag--xs"></div></div>`;
    }
    return `
      <div class="bteam-small ${loser ? 'loser' : ''}">
        <div class="bflag bflag--xs"><img alt="${name}"></div>
      </div>`;
  }

  function cellMid(match) {
    // R16 / R32-bot card (horizontal): [flag CODE] VS [flag CODE]
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--mid">
        ${cellMidSide(match.home, homeLoser, tbc, 'home')}
        <div class="vs ${tbc ? 'tbc' : ''}">VS</div>
        ${cellMidSide(match.away, awayLoser, tbc, 'away')}
      </div>`;
  }
  function cellMidSide(name, loser, tbc, side) {
    if (!name) {
      return `
        <div class="bteam-mid ${side} tbc">
          <div class="bflag bflag--sm"></div>
          <span class="bcode">TBC</span>
        </div>`;
    }
    return `
      <div class="bteam-mid ${side} ${loser ? 'loser' : ''}">
        <div class="bflag bflag--sm"><img alt="${name}"></div>
        <span class="bcode">${teamCode(name)}</span>
      </div>`;
  }

  function cellLarge(match) {
    // QF / SF card: [CODE flag] VS [flag CODE], bigger flags + codes
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--large">
        ${cellLargeSide(match.home, homeLoser, tbc, 'home')}
        <div class="vs vs--lg ${tbc ? 'tbc' : ''}">VS</div>
        ${cellLargeSide(match.away, awayLoser, tbc, 'away')}
      </div>`;
  }
  function cellLargeSide(name, loser, tbc, side) {
    if (!name) {
      return `
        <div class="bteam-lg ${side} tbc">
          ${side === 'home' ? `<span class="bcode bcode--lg">TBC</span>` : ''}
          <div class="bflag bflag--md"></div>
          ${side === 'away' ? `<span class="bcode bcode--lg">TBC</span>` : ''}
        </div>`;
    }
    return `
      <div class="bteam-lg ${side} ${loser ? 'loser' : ''}">
        ${side === 'home' ? `<span class="bcode bcode--lg">${teamCode(name)}</span>` : ''}
        <div class="bflag bflag--md"><img alt="${name}"></div>
        ${side === 'away' ? `<span class="bcode bcode--lg">${teamCode(name)}</span>` : ''}
      </div>`;
  }

  function cellFinal(match) {
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--final">
        ${cellFinalSide(match.home, homeLoser, tbc, 'home')}
        <div class="vs vs--final">VS</div>
        ${cellFinalSide(match.away, awayLoser, tbc, 'away')}
      </div>`;
  }
  function cellFinalSide(name, loser, tbc, side) {
    if (!name) {
      return `
        <div class="bteam-final ${side} tbc">
          ${side === 'home' ? `<span class="bcode bcode--xl">TBC</span>` : ''}
          <div class="bflag bflag--xl"></div>
          ${side === 'away' ? `<span class="bcode bcode--xl">TBC</span>` : ''}
        </div>`;
    }
    return `
      <div class="bteam-final ${side} ${loser ? 'loser' : ''}">
        ${side === 'home' ? `<span class="bcode bcode--xl">${teamCode(name)}</span>` : ''}
        <div class="bflag bflag--xl"><img alt="${name}"></div>
        ${side === 'away' ? `<span class="bcode bcode--xl">${teamCode(name)}</span>` : ''}
      </div>`;
  }

  // ── Render full bracket ──────────────────────────────────────────────────
  function rowOf(matches, kind, columns) {
    const cells = matches.map(kind === 'small' ? cellSmall : kind === 'mid' ? cellMid : cellLarge);
    if (columns === 'pairs') {
      // 8 → 4 pairs of 2; 4 → 2 pairs of 2
      const out = [];
      for (let i = 0; i < cells.length; i += 2) {
        out.push(`<div class="bpair">${cells[i]}${cells[i+1] || ''}</div>`);
      }
      return out.join('');
    }
    return cells.join('');
  }

  function render(data, badgeText) {
    const root = document.getElementById('bracket');
    root.innerHTML = `
      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 32</span><span class="bline"></span></div>
        <div class="brow brow--r32">${rowOf(data.r32_top, 'small', 'pairs')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 16</span><span class="bline"></span></div>
        <div class="brow brow--r16">${rowOf(data.r16_top, 'mid')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">QUARTER FINALS</span><span class="bline"></span></div>
        <div class="brow brow--qf">${rowOf(data.qf_top, 'large')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">SEMI FINAL 1</span><span class="bline"></span></div>
        <div class="brow brow--sf">${cellLarge(data.sf_top)}</div>
      </section>

      <section class="bround bround--final">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">FINAL</span><span class="bline"></span></div>
        <div class="brow brow--final">${cellFinal(data.final)}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">SEMI FINAL 2</span><span class="bline"></span></div>
        <div class="brow brow--sf">${cellLarge(data.sf_bot)}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">QUARTER FINALS</span><span class="bline"></span></div>
        <div class="brow brow--qf">${rowOf(data.qf_bot, 'large')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 16</span><span class="bline"></span></div>
        <div class="brow brow--r16">${rowOf(data.r16_bot, 'mid')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 32</span><span class="bline"></span></div>
        <div class="brow brow--r32">${rowOf(data.r32_bot, 'small', 'pairs')}</div>
      </section>`;

    // Paint flags (3-tier fallback handled by flag-global.js)
    root.querySelectorAll('.bflag img').forEach((img) => setFlag(img, img.alt, null));
    document.getElementById('updatedBadge').textContent = badgeText;
  }

  // ── Live cache (localStorage; instant paint on carousel revisits) ──────────
  function readCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return parsed && parsed.groups && parsed.ts ? parsed : null;
    } catch (e) { return null; }
  }
  function writeCache(groups) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ groups, ts: Date.now() })); }
    catch (e) { /* best-effort */ }
  }
  function cacheBadge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins <= 0) return 'Just updated';
    if (mins === 1) return 'Updated 1 min ago';
    return `Updated ${mins} mins ago`;
  }

  async function refresh() {
    document.getElementById('updatedBadge').textContent = 'Updating…';
    try {
      const res = await fetch('/api/standings', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const groups = groupsFromStandings(json);
      writeCache(groups);
      render(buildLiveBracket(groups), 'Just updated');
    } catch (err) {
      console.error('[tournament-draw]', err);
      // Keep whatever bracket is on screen; just flag the failure.
      document.getElementById('updatedBadge').textContent = 'Update failed';
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (isDemo) {
    render(DEMO_2022, 'Demo · 2022');
    return;
  }
  const cached = readCache();
  // Paint immediately: cached groups if we have them, otherwise an all-TBC frame.
  if (cached) render(buildLiveBracket(cached.groups), cacheBadge(cached.ts));
  else render(blankBracket(), 'Updating…');
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
})();
