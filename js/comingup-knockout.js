/**
 * Match Coming Up — knockout variant.
 *
 * Renders one of two states depending on whether the sibling-bracket
 * opponent is known:
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

  // ── Time helpers ─────────────────────────────────────────────────────────
  const AEST = 'Australia/Sydney';

  function aestKickoffLine(ms) {
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
    nameHome.textContent = (fix.home.name || '').toUpperCase();
    nameAway.textContent = (fix.away.name || '').toUpperCase();
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
        <div class="mini-name">${(team1?.name || 'TBD').toUpperCase()}</div>
      </div>
      <div class="mini-vs">VS</div>
      <div class="mini-team">
        <div class="mini-flag"><img alt="${team2?.name || 'TBD'}"></div>
        <div class="mini-name">${(team2?.name || 'TBD').toUpperCase()}</div>
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
        <div class="mini-name">${(team.name || '').toUpperCase()}</div>
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
      const qs = new URLSearchParams();
      qs.set('team', AUS_TEAM_ID);
      if (isDemo) qs.set('season', '2022');
      const res = await fetch(`/api/upcoming?${qs.toString()}`, { cache: 'no-store' });
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
        const sibling = await findSiblingBracket(fix);
        if (sibling.kind === 'known') renderWinnerPlaysKnown(sibling.team, sibling.kickoffEpoch);
        else if (sibling.kind === 'unknown') renderWinnerPlaysUnknown(sibling.team1, sibling.team2, sibling.kickoffEpoch);
        else renderWinnerPlaysPlaceholder(sibling.reason);
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
