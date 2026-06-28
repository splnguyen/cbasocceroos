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

  // ── Round-of-32 sibling resolution ───────────────────────────────────────
  // The "winner plays the winner of" match is the OTHER R32 fixture feeding the
  // same Round-of-16 slot. Resolve it from the FIFA R32 template + live standings
  // (same verified data as js/roundof32.js), overlaid with the real R32 fixtures
  // so best-third opponents + kickoff times come through.
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
  // The 8 pairs (two R32 matches feeding one R16) — see js/roundof32.js.
  const R32_PAIRS = [[74, 77], [73, 75], [83, 84], [81, 82], [76, 78], [79, 80], [86, 88], [85, 87]];

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

  async function resolveR32Sibling(ausFix) {
    if (ausFix.leagueRound !== 'Round of 32') return null;   // only R32 for now
    const ausTeams = [ausFix.home.name, ausFix.away.name];
    const [stRes, fxRes] = await Promise.all([
      fetch('/api/standings', { cache: 'no-store' }),
      fetch(`/api/upcoming-list?count=16&round=${encodeURIComponent('Round of 32')}`, { cache: 'no-store' }),
    ]);
    const st = await stRes.json();
    const fx = await fxRes.json();
    if (!st.ok) return null;
    const groups = groupsFromStandings(st);
    const pool = (fxRes.ok && fx.ok ? fx.matches || [] : []).slice();

    // Each template match's teams: resolved W/R, overridden by the real fixture
    // (matched by team membership — each team plays one R32 match).
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
        byNum[m] = { home: f.home.name, away: f.away.name, kickoff: f.kickoffEpoch || +new Date(f.kickoffISO) };
      } else {
        byNum[m] = { home, away, kickoff: null };
      }
    }

    // Find AUS's match + its pair sibling.
    const ausNum = Object.keys(byNum).map(Number)
      .find((m) => [byNum[m].home, byNum[m].away].some((n) => n && ausTeams.includes(n)));
    if (ausNum == null) return null;
    const pair = R32_PAIRS.find((p) => p.includes(ausNum));
    if (!pair) return null;
    const sib = byNum[pair[0] === ausNum ? pair[1] : pair[0]];
    if (!sib || (!sib.home && !sib.away)) return null;
    return {
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
        // Synthesise placeholder for preview only.
        renderWinnerPlaysKnown({ name: 'TBD', logo: null }, fix.kickoffEpoch + 4 * 86400_000);
      } else if (variantOverride === 'unknown') {
        renderWinnerPlaysUnknown({ name: 'TBD' }, { name: 'TBD' }, fix.kickoffEpoch + 4 * 86400_000);
      } else {
        // Round of 32: resolve the bracket sibling directly (the draw is known).
        let r32sib = null;
        try { r32sib = await resolveR32Sibling(fix); } catch (e) { /* fall back below */ }
        if (r32sib) {
          renderWinnerPlaysUnknown(r32sib.team1, r32sib.team2, r32sib.kickoff);
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
