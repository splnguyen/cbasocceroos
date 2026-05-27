/**
 * Match Coming Up — group-stage variant.
 *
 * Data:  GET /api/upcoming?team=20      (Australia)
 * Poll:  every 5 minutes
 * Tick:  every 1 second (countdown, no API call)
 *
 * Demo (?demo=1): uses AUS's last 2022 match (group-stage opener vs France)
 * — pin "now" 15 days before that kickoff so the countdown reads sensibly.
 */

(function () {
  const params = new URLSearchParams(location.search);
  const isDemo = params.get('demo') === '1';
  const POLL_MS = 5 * 60 * 1000;
  const AUS_TEAM_ID = 20;

  // Demo: pin "now" to (kickoff - 15 days) for readable countdown.
  const DEMO_OFFSET_DAYS = 15;
  let demoNowMs = null;

  const STATUS_RANK = { qualified: 0, contention: 1, eliminated: 2 };

  const updatedBadge = document.getElementById('updatedBadge');
  const subhead    = document.getElementById('subhead');
  const cdClock    = document.getElementById('cd-clock');
  const cdKickoff  = document.getElementById('cd-kickoff');
  const flagHome   = document.getElementById('flag-home');
  const flagAway   = document.getElementById('flag-away');
  const nameHome   = document.getElementById('name-home');
  const nameAway   = document.getElementById('name-away');
  const groupTitle = document.getElementById('group-title');
  const standingsRoot = document.getElementById('standings-rows');

  let kickoffEpoch = null;

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

  // → "HH:MM:SS" (always; days roll up into hours past 24)
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

  // ── Render ───────────────────────────────────────────────────────────────
  function rowHtml(t) {
    return `
      <div class="grow grow--${t.status}">
        <div class="grow-left">
          <div class="grow-flag"><img alt="${t.name}"></div>
          <div class="grow-code">${teamCode(t.name)}</div>
        </div>
        <div class="grow-stats">
          <span class="gs-reg">${t.played}</span>
          <span class="gs-reg">${t.win}</span>
          <span class="gs-reg">${t.draw}</span>
          <span class="gs-reg">${t.loss}</span>
          <span class="gs-pts">${t.points}</span>
        </div>
      </div>`;
  }

  function renderStandings(rows, groupLabel) {
    groupTitle.textContent = groupLabel || 'GROUP';
    const sorted = [...rows].sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (s !== 0) return s;
      if (b.points !== a.points) return b.points - a.points;
      return (b.goalDiff || 0) - (a.goalDiff || 0);
    });
    standingsRoot.innerHTML = sorted.map(rowHtml).join('');
    standingsRoot.querySelectorAll('.grow-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  function renderFixture(fix) {
    nameHome.textContent = (fix.home.name || '').toUpperCase();
    nameAway.textContent = (fix.away.name || '').toUpperCase();
    setFlag(flagHome, fix.home.name, fix.home.logo);
    setFlag(flagAway, fix.away.name, fix.away.logo);
    subhead.textContent = fix.stage || 'Group Stage';
    cdKickoff.textContent = aestKickoffLine(fix.kickoffEpoch);
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  async function refresh() {
    updatedBadge.textContent = 'Updating…';
    try {
      const qs = new URLSearchParams();
      qs.set('team', AUS_TEAM_ID);
      if (isDemo) {
        qs.set('season', '2022');
      }
      const res = await fetch(`/api/upcoming?${qs.toString()}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);

      const fix = json.fixture;
      kickoffEpoch = new Date(fix.kickoffISO).getTime();

      if (isDemo) {
        // For 2022: pin "now" to (kickoff - 15 days) so countdown reads sensibly.
        demoNowMs = kickoffEpoch - DEMO_OFFSET_DAYS * 86400_000;
      }

      renderFixture(fix);
      renderStandings(json.standings || [], fix.group || 'GROUP');
      tick();
      updatedBadge.textContent = 'Just updated';
    } catch (err) {
      console.error('[comingup]', err);
      updatedBadge.textContent = 'Update failed';
    }
  }

  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, 1000);
})();
