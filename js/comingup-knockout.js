/**
 * Match Coming Up — knockout variant.
 *
 * Shows the NEXT scheduled tournament fixture (regardless of who's playing) via
 * /api/upcoming (no team filter). Renders one of two states depending on whether
 * the sibling-bracket opponent is known:
 *   • UNKNOWN — "WINNER PLAYS THE WINNER OF [A] vs [B]"
 *   • KNOWN   — "WINNER PLAYS [team]"
 *
 * Auto-detection: fetches all fixtures in the next knockout round and looks
 * for one that lists the AUS slot's bracket counterpart. If api-football has
 * resolved a team into the next-round fixture's other slot → KNOWN.
 *
 * Override:
 *   ?variant=known|unknown   force render path (useful for previewing)
 *   ?demo=1                  use AUS's last 2022 fixture (R16 vs ARG)
 */

(function () {
  const params = new URLSearchParams(location.search);
  const isDemo = params.get('demo') === '1';
  const variantOverride = params.get('variant'); // 'known' | 'unknown' | null
  const POLL_MS = 5 * 60 * 1000;
  const AUS_TEAM_ID = 20;
  const DEMO_OFFSET_DAYS = 15;

  const updatedBadge = document.getElementById('updatedBadge');
  const subhead     = document.getElementById('subhead');
  const cdClock     = document.getElementById('cd-clock');
  const cdKickoff   = document.getElementById('cd-kickoff');
  const flagHome    = document.getElementById('flag-home');
  const flagAway    = document.getElementById('flag-away');
  const nameHome    = document.getElementById('name-home');
  const nameAway    = document.getElementById('name-away');
  const wpHeading   = document.getElementById('winner-plays-heading');
  const wpUnknown   = document.getElementById('winner-plays-unknown');
  const wpKnown     = document.getElementById('winner-plays-known');
  const wpDate      = document.getElementById('winner-plays-date');

  let kickoffEpoch = null;
  let demoNowMs = null;

  // Display-name overrides (shorter labels that fit one line). The ORIGINAL API
  // name is still used for flag lookup (setFlag) — only the visible text changes.
  const NAME_REMAP = { 'Cape Verde Islands': 'Cabo Verde' };
  const displayName = (name) => (NAME_REMAP[name] || name || '').toUpperCase();

  // ── Time helpers ─────────────────────────────────────────────────────────
  const AEST = 'Australia/Sydney';

  function aestKickoffLine(ms) {
    // Figma: "TUESDAY 16 JUNE 5:00AM AEST" — long weekday/month, AEST suffix.
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: AEST,
      weekday: 'long', day: 'numeric', month: 'long',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const period = (p.dayPeriod || '').toUpperCase().replace(/\./g, '');
    return `${(p.weekday || '').toUpperCase()} ${p.day} ${(p.month || '').toUpperCase()} ${p.hour}:${p.minute}${period} AEST`;
  }

  function pad2(n) { return String(Math.max(0, n)).padStart(2, '0'); }
  function nowMs() { return demoNowMs ?? Date.now(); }

  function clockHMS(remainMs) {
    const secs = Math.max(0, Math.floor(remainMs / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function tick() {
    if (kickoffEpoch == null) return;
    cdClock.textContent = clockHMS(kickoffEpoch - nowMs());
  }

  // ── Knockout round progression ───────────────────────────────────────────
  // api-football labels rounds as strings like "Round of 32" → "Round of 16".
  const NEXT_ROUND = {
    'Round of 32': 'Round of 16',
    'Round of 16': 'Quarter-finals',
    'Quarter-finals': 'Semi-finals',
    'Semi-finals': 'Final',
    'Final': null,
  };

  // ── Render ───────────────────────────────────────────────────────────────
  function renderFixture(fix) {
    nameHome.textContent = displayName(fix.home.name);
    nameAway.textContent = displayName(fix.away.name);
    setFlag(flagHome, fix.home.name, fix.home.logo);
    setFlag(flagAway, fix.away.name, fix.away.logo);
    subhead.textContent = fix.leagueRound || fix.stage || 'Knockout';
    cdKickoff.textContent = aestKickoffLine(fix.kickoffEpoch);
  }

  function renderWinnerPlaysUnknown(team1, team2, kickoffMs) {
    wpHeading.textContent = 'WINNER PLAYS THE WINNER OF';
    wpKnown.hidden = true;
    wpUnknown.hidden = false;
    wpUnknown.innerHTML = `
      <div class="mini-team">
        <div class="mini-flag"><img alt="${team1?.name || 'TBD'}"></div>
        <div class="mini-name">${displayName(team1?.name || 'TBD')}</div>
      </div>
      <div class="mini-vs">VS</div>
      <div class="mini-team">
        <div class="mini-flag"><img alt="${team2?.name || 'TBD'}"></div>
        <div class="mini-name">${displayName(team2?.name || 'TBD')}</div>
      </div>`;
    wpUnknown.querySelectorAll('.mini-flag img').forEach((img) => setFlag(img, img.alt, null));
    wpDate.textContent = kickoffMs ? `MATCH ON ${aestKickoffLine(kickoffMs)}` : '';
  }

  function renderWinnerPlaysKnown(team, kickoffMs) {
    wpHeading.textContent = 'WINNER PLAYS';
    wpUnknown.hidden = true;
    wpKnown.hidden = false;
    wpKnown.innerHTML = `
      <div class="mini-team">
        <div class="mini-flag"><img alt="${team.name}"></div>
        <div class="mini-name">${displayName(team.name)}</div>
      </div>`;
    setFlag(wpKnown.querySelector('.mini-flag img'), team.name, team.logo);
    wpDate.textContent = kickoffMs ? `MATCH ON ${aestKickoffLine(kickoffMs)}` : '';
  }

  function renderWinnerPlaysPlaceholder(reason) {
    wpHeading.textContent = 'NEXT ROUND OPPONENT';
    wpUnknown.hidden = true;
    wpKnown.hidden = true;
    wpDate.textContent = reason || '';
  }

  // ── Bracket-sibling resolution (any knockout round) ──────────────────────
  // The "winner plays the winner of" match is the OTHER fixture in the same round
  // that feeds the SAME next-round slot (an R16 fixture's sibling is the other R16
  // match feeding its QF, etc). We resolve it from the verified WC2026 bracket:
  // R32 slots project from live standings + real R32 fixtures (same data as
  // js/roundof32.js), and each later round projects from the previous round's
  // winners, overlaid with that round's real fixtures so exact teams, results and
  // kickoff times come through as soon as the provider posts them.
  const W = (g) => ({ slot: 'W', group: g });
  const R = (g) => ({ slot: 'R', group: g });
  const T3 = { slot: '3' };
  const R32_TEMPLATE = {
    73: { home: R('A'), away: R('B') }, 74: { home: W('E'), away: T3 },
    75: { home: W('F'), away: R('C') }, 76: { home: W('C'), away: R('F') },
    77: { home: W('I'), away: T3 },     78: { home: R('E'), away: R('I') },
    79: { home: W('A'), away: T3 },     80: { home: W('L'), away: T3 },
    81: { home: W('D'), away: T3 },     82: { home: W('G'), away: T3 },
    83: { home: R('K'), away: R('L') }, 84: { home: W('H'), away: R('J') },
    85: { home: W('B'), away: T3 },     86: { home: W('J'), away: R('H') },
    87: { home: W('K'), away: T3 },     88: { home: R('D'), away: R('G') },
  };
  // Bracket chain (winner of feeder → next slot). FEEDS[next] = [homeFeeder,
  // awayFeeder]; verified `feeds` topology — see js/roundof16.js / tournament-draw.js.
  const FEEDS = {
    89: [74, 77], 90: [73, 75], 91: [76, 78], 92: [79, 80],
    93: [83, 84], 94: [81, 82], 95: [86, 88], 96: [85, 87],   // R32 → R16
    97: [89, 90], 98: [93, 94], 99: [91, 92], 100: [95, 96],  // R16 → QF
    101: [97, 98], 102: [99, 100],                            // QF  → SF
    104: [101, 102],                                          // SF  → Final
  };
  const ROUND_ORDER = ['Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'];
  const ROUND_MATCHES = {
    'Round of 32': [73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88],
    'Round of 16': [89, 90, 91, 92, 93, 94, 95, 96],
    'Quarter-finals': [97, 98, 99, 100],
    'Semi-finals': [101, 102],
    'Final': [104],
  };
  // Sibling pairs per round: the two matches feeding one next-round slot.
  const R32_PAIRS = [[74, 77], [73, 75], [83, 84], [81, 82], [76, 78], [79, 80], [86, 88], [85, 87]];
  const ROUND_PAIRS = {
    'Round of 32': R32_PAIRS,
    'Round of 16': [[89, 90], [93, 94], [91, 92], [95, 96]],
    'Quarter-finals': [[97, 98], [99, 100]],
    'Semi-finals': [[101, 102]],
    'Final': [],
  };

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
    if (!slot || slot.slot === '3') return null;          // best-third → TBD
    const g = groups[slot.group];
    return g ? (g.byRank[slot.slot === 'W' ? 1 : 2] || null) : null;
  }
  function winnerOf(m) {
    if (!m) return null;
    return m.winner === 'home' ? m.home : m.winner === 'away' ? m.away : null;
  }

  // Overlay a projected {home,away} match with the real fixture that shares a
  // known team (each team plays one match per round, so any shared team is
  // unambiguous). Mutates `pool` — the claimed fixture is removed.
  function overlayReal(proj, pool) {
    const known = [proj.home, proj.away].filter(Boolean);
    let idx = -1;
    for (let i = 0; i < pool.length; i++) {
      const f = pool[i];
      if (known.includes(f.home.name) || known.includes(f.away.name)) { idx = i; break; }
    }
    if (idx >= 0) {
      const f = pool.splice(idx, 1)[0];
      return { home: f.home.name, away: f.away.name, kickoff: f.kickoffEpoch || +new Date(f.kickoffISO), winner: f.winner, isFinished: f.isFinished };
    }
    return { home: proj.home, away: proj.away, kickoff: null, winner: null, isFinished: false };
  }
  function buildR32ByNum(groups, r32pool) {
    const pool = (r32pool || []).slice();
    const byNum = {};
    for (const m of Object.keys(R32_TEMPLATE)) {
      const tpl = R32_TEMPLATE[m];
      byNum[m] = overlayReal({ home: resolveSlot(tpl.home, groups), away: resolveSlot(tpl.away, groups) }, pool);
    }
    return byNum;
  }
  function buildProjectedRound(nums, prevByNum, roundPool) {
    const pool = (roundPool || []).slice();
    const byNum = {};
    for (const m of nums) {
      const [a, b] = FEEDS[m];
      byNum[m] = overlayReal({ home: winnerOf(prevByNum[a]), away: winnerOf(prevByNum[b]) }, pool);
    }
    return byNum;
  }

  // Kickoff of the next-round match a known opponent has advanced to — used for
  // "MATCH ON …" once the opponent is decided. api-football lists the advanced
  // team in its next-round fixture, so we find it by name. Null until that fixture
  // exists (then it fills in automatically).
  async function nextRoundDate(opponentName, nextRound) {
    if (!opponentName || !nextRound) return null;
    try {
      const res = await fetch(`/api/upcoming-list?count=16&round=${encodeURIComponent(nextRound)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) return null;
      const f = (json.matches || []).find((m) => m.home.name === opponentName || m.away.name === opponentName);
      return f ? (f.kickoffEpoch || +new Date(f.kickoffISO)) : null;
    } catch (e) { return null; }
  }

  async function resolveSibling(fix) {
    if (isDemo) return null;                                 // demo → placeholder fallback
    const round = fix.leagueRound;
    const idx = ROUND_ORDER.indexOf(round);
    const pairs = ROUND_PAIRS[round];
    if (idx < 0 || !pairs || !pairs.length) return null;     // unknown round / Final → no sibling

    // Real fixtures for R32 up through the displayed round (each round projects
    // from the previous round's winners). Standings seed the R32 projection.
    const needed = ROUND_ORDER.slice(0, idx + 1);
    const [stRes, ...fxRes] = await Promise.all([
      fetch('/api/standings', { cache: 'no-store' }),
      ...needed.map((r) => fetch(`/api/upcoming-list?count=20&round=${encodeURIComponent(r)}`, { cache: 'no-store' })),
    ]);
    const st = await stRes.json();
    if (!st.ok) return null;
    const groups = groupsFromStandings(st);
    const poolByRound = {};
    for (let i = 0; i < needed.length; i++) {
      const j = await fxRes[i].json();
      poolByRound[needed[i]] = (fxRes[i].ok && j.ok) ? (j.matches || []) : [];
    }

    // Build the bracket forward to the displayed round.
    let byNum = buildR32ByNum(groups, poolByRound['Round of 32']);
    for (let k = 1; k <= idx; k++) {
      const r = needed[k];
      byNum = buildProjectedRound(ROUND_MATCHES[r], byNum, poolByRound[r]);
    }

    // Find the displayed fixture's match + its pair sibling.
    const fixTeams = [fix.home.name, fix.away.name];
    const fixNum = ROUND_MATCHES[round]
      .find((m) => [byNum[m].home, byNum[m].away].some((n) => n && fixTeams.includes(n)));
    if (fixNum == null) return null;
    const pair = pairs.find((p) => p.includes(fixNum));
    if (!pair) return null;
    const sib = byNum[pair[0] === fixNum ? pair[1] : pair[0]];
    if (!sib || (!sib.home && !sib.away)) return null;

    // Sibling decided → KNOWN opponent (its winner); otherwise UNKNOWN (winner of
    // the two sibling teams, "match on" = when that sibling match is played).
    if (sib.isFinished && (sib.winner === 'home' || sib.winner === 'away')) {
      const opponent = sib.winner === 'home' ? sib.home : sib.away;
      return { decided: true, opponent: opponent ? { name: opponent } : null, kickoff: await nextRoundDate(opponent, NEXT_ROUND[round]) };
    }
    return {
      decided: false,
      team1: sib.home ? { name: sib.home } : null,
      team2: sib.away ? { name: sib.away } : null,
      kickoff: sib.kickoff,
    };
  }

  // ── Sibling-bracket lookup ───────────────────────────────────────────────
  async function findSiblingBracket(currentFix) {
    const nextRound = NEXT_ROUND[currentFix.leagueRound];
    if (!nextRound) return { kind: 'placeholder', reason: 'No further rounds.' };

    // Fetch all WC fixtures in the next round. api-football's /fixtures
    // supports `round=` for this when the season has the round populated.
    const season = isDemo ? 2022 : currentFix.leagueSeason;
    const url = `/api/upcoming-list?count=20&season=${season}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      const nextRoundMatches = (json.matches || []).filter((m) => m.leagueRound === nextRound);
      // Pre-tournament every team slot will be a placeholder ("Winner Round of 32 1")
      // — api-football names those teams with strings like "Winner W1" etc.
      // We don't have AUS bracket position info, so we fall back to placeholder.
      if (!nextRoundMatches.length) {
        return { kind: 'placeholder', reason: 'Next-round bracket not yet scheduled.' };
      }
      // TODO: real bracket lookup would resolve AUS's parent fixture and
      // surface its other slot. For now: placeholder when we can't be sure.
      return { kind: 'placeholder', reason: 'Bracket pairings not yet resolved.' };
    } catch (err) {
      return { kind: 'placeholder', reason: 'Bracket lookup failed.' };
    }
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  async function refresh() {
    updatedBadge.textContent = 'Updating…';
    try {
      // Show the NEXT fixture overall (regardless of who's playing): /api/upcoming
      // with no team resolves the next scheduled tournament fixture. Demo pins
      // AUS's 2022 fixture — a finished season has no "next", so the offline
      // preview needs a team to resolve a fixture to show.
      const qs = new URLSearchParams();
      if (isDemo) { qs.set('season', '2022'); qs.set('team', AUS_TEAM_ID); }
      const res = await fetch(`/api/upcoming${qs.toString() ? `?${qs}` : ''}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);

      const fix = json.fixture;
      fix.kickoffEpoch = new Date(fix.kickoffISO).getTime();
      kickoffEpoch = fix.kickoffEpoch;
      if (isDemo) demoNowMs = kickoffEpoch - DEMO_OFFSET_DAYS * 86400_000;

      renderFixture(fix);

      // Decide which "winner plays" variant to render.
      if (variantOverride === 'known') {
        // Preview the "opponent known" state — pretend the sibling has been decided
        // and show a resolved team (its winner, or one of the two sibling teams).
        let team = { name: 'TBD', logo: null };
        let when = fix.kickoffEpoch + 4 * 86400_000;
        try {
          const sib = await resolveSibling(fix);
          if (sib && sib.decided && sib.opponent) { team = sib.opponent; when = sib.kickoff || when; }
          else if (sib && (sib.team1 || sib.team2)) { team = sib.team1 || sib.team2; when = sib.kickoff || when; }
        } catch (e) { /* keep TBD */ }
        renderWinnerPlaysKnown(team, when);
      } else if (variantOverride === 'unknown') {
        renderWinnerPlaysUnknown({ name: 'TBD' }, { name: 'TBD' }, fix.kickoffEpoch + 4 * 86400_000);
      } else {
        // Resolve the bracket sibling for the displayed round. If that sibling
        // match is finished → KNOWN opponent; otherwise → winner-of-A-vs-B.
        // Auto-updates each poll as fixtures resolve.
        let sib = null;
        try { sib = await resolveSibling(fix); } catch (e) { /* fall back below */ }
        if (sib && sib.decided && sib.opponent) {
          renderWinnerPlaysKnown(sib.opponent, sib.kickoff);
        } else if (sib && !sib.decided) {
          renderWinnerPlaysUnknown(sib.team1, sib.team2, sib.kickoff);
        } else {
          const sibling = await findSiblingBracket(fix);
          if (sibling.kind === 'known') renderWinnerPlaysKnown(sibling.team, sibling.kickoffEpoch);
          else if (sibling.kind === 'unknown') renderWinnerPlaysUnknown(sibling.team1, sibling.team2, sibling.kickoffEpoch);
          else renderWinnerPlaysPlaceholder(sibling.reason);
        }
      }

      tick();
      updatedBadge.textContent = 'Just updated';
    } catch (err) {
      console.error('[comingup-knockout]', err);
      updatedBadge.textContent = 'Update failed';
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, 1000);
})();
