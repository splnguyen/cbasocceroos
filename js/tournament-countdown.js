/**
 * Tournament Countdown screen.
 *
 * Data:  GET /api/upcoming-list?count=5    (?demo=1 → 2022 fixtures)
 * Poll:  every 5 minutes (fixtures rarely change)
 * Tick:  every 1 second (countdown timers, no API call)
 *
 * Demo: When the API returns 2022 fixtures, anchor "now" 15 days before the
 * 2022 WC kickoff (2022-11-20) so the countdowns read like a pre-tournament
 * state instead of being negative.
 */

(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';

  // Demo anchor: 2022 WC opening match was 20 Nov 2022 18:00 UTC.
  // Pin "now" to 15 days before kickoff for a sensible countdown.
  const DEMO_NOW = isDemo ? new Date('2022-11-05T18:00:00Z').getTime() : null;

  const grid     = document.getElementById('grid');
  const ausTile  = document.getElementById('aus-tile');
  const featured = document.getElementById('featured');
  const badge    = document.getElementById('updatedBadge');
  const cdRoot   = document.getElementById('countdown-cells');

  let fixtures = [];        // [{ fixtureId, kickoffEpoch, ... }, ...]
  let kickoffEpoch = null;  // first fixture's kickoff in ms
  let hasData = false;      // true once real (or cached) fixtures are on screen
  const CACHE_KEY = `cba:countdown:v1:demo=${isDemo ? 1 : 0}`;

  // ── Time helpers ─────────────────────────────────────────────────────────

  const AEST = 'Australia/Sydney';

  function aestParts(ms) {
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: AEST,
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const parts = fmt.formatToParts(new Date(ms));
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    return {
      weekday: get('weekday'),
      day: get('day'),
      month: get('month'),
      hour: get('hour'),
      minute: get('minute'),
      period: get('dayPeriod').toUpperCase().replace(/\./g, ''),
    };
  }

  // → "TUE 16 JUN 5:00AM"
  function aestKickoffLine(ms) {
    const p = aestParts(ms);
    return `${p.weekday.toUpperCase()} ${p.day} ${p.month.toUpperCase()} ${p.hour}:${p.minute}${p.period}`;
  }

  function nowMs() {
    return DEMO_NOW ?? Date.now();
  }

  function pad2(n) { return String(Math.max(0, n)).padStart(2, '0'); }

  function diffParts(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return { d, h, m, s };
  }

  // → "38d 24:03:18" (days + hh:mm:ss, only when remaining > 0)
  function shortCountdown(ms) {
    const { d, h, m, s } = diffParts(ms);
    return `${d}d ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function groupLabel(fix) {
    // Prefer the proxy-attached group letter (e.g. "GROUP A").
    if (fix.group) return fix.group.toUpperCase();
    // Fallback: knockout rounds pass through unchanged; group-stage matchday
    // strings have no letter, so just show "GROUP STAGE".
    const r = fix.leagueRound || '';
    if (/Group Stage/i.test(r)) return 'GROUP STAGE';
    return (r || 'TBC').toUpperCase();
  }

  function venueText(fix) {
    if (!fix.venue) return '';
    return `, ${fix.venue.toUpperCase()}`;
  }

  function renderFeatured(fix) {
    if (!fix) {
      featured.innerHTML = '<div class="featured-empty">No upcoming fixtures.</div>';
      return;
    }
    const group = groupLabel(fix);
    const line = aestKickoffLine(fix.kickoffEpoch);
    featured.innerHTML = `
      <div class="featured-header">${group} <span class="pipe">|</span> ${line}</div>
      <div class="featured-row">
        <div class="featured-team">
          <div class="featured-flag"><img alt="${fix.home.name}"></div>
          <div class="featured-name">${(fix.home.name || '').toUpperCase()}</div>
        </div>
        <div class="featured-vs">VS</div>
        <div class="featured-team">
          <div class="featured-flag"><img alt="${fix.away.name}"></div>
          <div class="featured-name">${(fix.away.name || '').toUpperCase()}</div>
        </div>
      </div>`;
    featured.querySelectorAll('.featured-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  function tileHtml(fix, extraClass = '') {
    const group = groupLabel(fix);
    const line  = aestKickoffLine(fix.kickoffEpoch);
    const venue = fix.venue ? fix.venue.toUpperCase() : '';
    const homeCode = teamCode(fix.home.name);
    const awayCode = teamCode(fix.away.name);
    return `
      <div class="tile-upcoming${extraClass ? ' ' + extraClass : ''}" data-kickoff="${fix.kickoffEpoch}">
        <div class="tile-meta-row">
          <div class="tile-meta">${group} <span class="pipe">|</span> ${line}</div>
          ${venue ? `<div class="tile-venue">${venue}</div>` : ''}
        </div>
        <div class="tile-row">
          <div class="tile-teams">
            <div class="tile-team">
              <div class="tile-flag"><img alt="${fix.home.name}"></div>
              <div class="tile-code">${homeCode}</div>
            </div>
            <div class="tile-vs">vs</div>
            <div class="tile-team">
              <div class="tile-flag"><img alt="${fix.away.name}"></div>
              <div class="tile-code">${awayCode}</div>
            </div>
          </div>
          <div class="tile-countdown" data-kickoff="${fix.kickoffEpoch}">–</div>
        </div>
      </div>`;
  }

  function renderAusTile(fix) {
    if (!fix) { ausTile.innerHTML = ''; return; }
    ausTile.innerHTML = tileHtml(fix, 'tile-upcoming--aus');
    ausTile.querySelectorAll('.tile-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  function renderTiles(list) {
    grid.innerHTML = list.map((f) => tileHtml(f)).join('');
    grid.querySelectorAll('.tile-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  // ── Per-second countdown tick ────────────────────────────────────────────

  function tickCountdowns() {
    const now = nowMs();

    // Featured: big day/hour/minute/second cells (first fixture)
    if (cdRoot && kickoffEpoch != null) {
      const remaining = Math.max(0, kickoffEpoch - now);
      const { d, h, m, s } = diffParts(remaining);
      cdRoot.querySelector('[data-unit="days"]').textContent    = pad2(d);
      cdRoot.querySelector('[data-unit="hours"]').textContent   = pad2(h);
      cdRoot.querySelector('[data-unit="minutes"]').textContent = pad2(m);
      cdRoot.querySelector('[data-unit="seconds"]').textContent = pad2(s);
    }

    // Tile per-row countdowns (AUS tile + coming-up grid)
    document.querySelectorAll('.tile-countdown').forEach((el) => {
      const k = Number(el.dataset.kickoff);
      el.textContent = shortCountdown(Math.max(0, k - now));
    });
  }

  // ── Fetch ────────────────────────────────────────────────────────────────

  // ── Skeleton ─────────────────────────────────────────────────────────────

  function renderSkeleton() {
    featured.innerHTML = '<div class="skel skel-featured"></div>';
    ausTile.innerHTML  = '<div class="skel skel-tile"></div>';
    grid.innerHTML     = '<div class="skel skel-tile"></div><div class="skel skel-tile"></div>';
  }

  function isAus(fix) {
    return fix.home.name === 'Australia' || fix.away.name === 'Australia';
  }

  // Apply a fetched (or cached) upcoming-list payload to the screen. The
  // per-second tick keeps the countdowns live regardless of where the
  // fixtures came from.
  function applyPayload(json, badgeText = 'Just updated') {
    fixtures = (json.matches || []).map((f) => ({
      ...f,
      kickoffEpoch: f.kickoffEpoch || new Date(f.kickoffISO).getTime(),
    }));

    // Tournament opener: hero display + main countdown timer.
    const [first, second, third] = fixtures;
    kickoffEpoch = first?.kickoffEpoch ?? null;

    // First AUS fixture for the "Next Australia Match" tile.
    const ausMatch = fixtures.find(isAus);

    // Coming Up: fixtures 2 and 3 from the overall list.
    const coming = [second, third].filter(Boolean);

    renderFeatured(first);
    renderAusTile(ausMatch);
    renderTiles(coming);
    tickCountdowns();
    badge.textContent = badgeText;
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
    } catch (e) {
      return null;
    }
  }

  function writeCache(payload) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ payload, ts: Date.now() }));
    } catch (e) {
      /* storage unavailable / quota — caching is best-effort */
    }
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
      // Fetch enough fixtures to guarantee we find the first AUS match.
      const url = isDemo ? '/api/upcoming-list?demo=1&count=20' : '/api/upcoming-list?count=20';
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);

      writeCache(json);
      applyPayload(json); // reload values when the API call returns
    } catch (err) {
      console.error('[tournament-countdown]', err);
      // Keep cached/previous fixtures visible on screen; just flag the failure.
      badge.textContent = 'Update failed';
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  const cached = readCache();
  if (cached) {
    // Carousel revisit (or warm load) → cached fixtures render immediately, no
    // skeleton flash. The countdowns tick live from the cached kickoff epochs.
    applyPayload(cached.payload, cacheBadge(cached.ts));
  } else {
    // True cold load → skeleton while the first fetch lands.
    renderSkeleton();
  }

  // Only hit the network on mount if there's no cache or it's gone stale —
  // this stops a fresh reload on every carousel hit. The interval keeps it
  // current while the screen stays mounted.
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tickCountdowns, 1000);
})();
