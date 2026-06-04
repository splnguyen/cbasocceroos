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
  let hasData = false;
  const CACHE_KEY = `cba:comingup:v1:demo=${isDemo ? 1 : 0}`;

  // ── Time helpers ─────────────────────────────────────────────────────────
  const AEST = 'Australia/Sydney';

  function aestKickoffLine(ms) {
    // Figma: "TUESDAY 16 JUNE 5:00AM AEST" — long weekday/month, no zero-padded
    // hour, AEST suffix (the WC 2026 window is entirely AEST).
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
          <div class="grow-code">${(t.name || '').toUpperCase()}</div>
        </div>
        <div class="grow-stats">
          <span>${t.played}</span>
          <span>${t.win}</span>
          <span>${t.draw}</span>
          <span>${t.loss}</span>
          <span>${t.points}</span>
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

  // ── Apply (from fetch or cache) ──────────────────────────────────────────
  function applyPayload(json, badgeText = 'Just updated') {
    const fix = json.fixture;
    kickoffEpoch = new Date(fix.kickoffISO).getTime();
    if (isDemo) {
      // For 2022: pin "now" to (kickoff - 15 days) so countdown reads sensibly.
      demoNowMs = kickoffEpoch - DEMO_OFFSET_DAYS * 86400_000;
    }
    renderFixture(fix);
    renderStandings(json.standings || [], fix.group || 'GROUP');
    tick();
    updatedBadge.textContent = badgeText;
    hasData = true;
  }

  // ── Cache (localStorage; renders instantly on carousel revisits) ───────────
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.payload || !parsed.ts) return null;
      return parsed;
    } catch (e) { return null; }
  }
  function writeCache(payload) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ payload, ts: Date.now() })); }
    catch (e) { /* best-effort */ }
  }
  function cacheBadge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins <= 0) return 'Just updated';
    if (mins === 1) return 'Updated 1 min ago';
    return `Updated ${mins} mins ago`;
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

      writeCache(json);
      applyPayload(json); // reload values when the API call returns
    } catch (err) {
      console.error('[comingup]', err);
      // Keep cached/previous fixture visible; just flag the failure.
      updatedBadge.textContent = 'Update failed';
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  const cached = readCache();
  // Carousel revisit (fresh cache) → render instantly, no reload flash. Only
  // hit the network on mount if there's no cache or it's gone stale.
  if (cached) applyPayload(cached.payload, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, 1000);
})();
