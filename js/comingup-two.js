/**
 * Matches Coming Up — pair (group-stage variant).
 *
 *   GET /api/upcoming-list?count=2[&demo=1]
 *
 * Renders the next AUS / featured upcoming match in a large hero block with
 * full HH:MM:SS countdown, and a second secondary upcoming match below.
 * Local 1-second tick keeps the countdown live; data refresh every 5 min.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const DEMO_OFFSET_DAYS = 15;

  const $ = (id) => document.getElementById(id);

  let kickoffEpoch = null;
  let demoNowMs = null;
  let hasData = false;
  const CACHE_KEY = `cba:comingup-two:v1:demo=${isDemo ? 1 : 0}`;

  function aestKickoffLine(ms) {
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${(p.weekday || '').toUpperCase()} ${p.day} ${(p.month || '').toUpperCase()} ${p.hour}:${p.minute}${(p.dayPeriod || '').toUpperCase().replace(/\./g, '')}`;
  }

  function pad2(n) { return String(Math.max(0, n)).padStart(2, '0'); }
  function nowMs() { return demoNowMs ?? Date.now(); }
  function clockHMS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad2(Math.floor(s/3600))}:${pad2(Math.floor((s%3600)/60))}:${pad2(s%60)}`;
  }

  function tick() {
    if (kickoffEpoch == null) return;
    $('cd-clock').textContent = clockHMS(kickoffEpoch - nowMs());
  }

  function renderPrimary(fix) {
    kickoffEpoch = new Date(fix.kickoffISO).getTime();
    if (isDemo) demoNowMs = kickoffEpoch - DEMO_OFFSET_DAYS * 86400_000;
    $('cd-kickoff').textContent = aestKickoffLine(kickoffEpoch);
    $('p-name-home').textContent = (fix.home.name || '').toUpperCase();
    $('p-name-away').textContent = (fix.away.name || '').toUpperCase();
    setFlag($('p-flag-home'), fix.home.name, fix.home.logo);
    setFlag($('p-flag-away'), fix.away.name, fix.away.logo);
    tick();
  }

  function renderSecondary(fix) {
    if (!fix) {
      $('s-date').textContent = '—';
      $('s-name-home').textContent = 'TBD';
      $('s-name-away').textContent = 'TBD';
      return;
    }
    const ms = new Date(fix.kickoffISO).getTime();
    $('s-date').textContent = aestKickoffLine(ms);
    $('s-name-home').textContent = (fix.home.name || '').toUpperCase();
    $('s-name-away').textContent = (fix.away.name || '').toUpperCase();
    setFlag($('s-flag-home'), fix.home.name, fix.home.logo);
    setFlag($('s-flag-away'), fix.away.name, fix.away.logo);
  }

  // ── Apply (from fetch or cache) ──────────────────────────────────────────
  function applyPayload(json, badgeText = 'Just updated') {
    const [primary, secondary] = json.matches || [];
    if (primary) renderPrimary(primary);
    renderSecondary(secondary || null);
    $('updatedBadge').textContent = badgeText;
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

  async function refresh() {
    $('updatedBadge').textContent = 'Updating…';
    try {
      const url = `/api/upcoming-list?count=2${isDemo ? '&demo=1' : ''}`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);

      writeCache(json);
      applyPayload(json); // reload values when the API call returns
    } catch (err) {
      console.error('[comingup-two]', err);
      // Keep cached/previous fixtures visible; just flag the failure.
      $('updatedBadge').textContent = 'Update failed';
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  const cached = readCache();
  if (cached) applyPayload(cached.payload, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, 1000);
})();
