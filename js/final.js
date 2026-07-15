/**
 * FIFA World Cup 2026 Final — single-match hero display.
 *
 * Fetches Semi-finals results + Final fixture to determine the two finalists.
 * If the Final fixture is posted by api-football, uses it directly (matchup,
 * kickoff, result). Otherwise derives finalists from SF winners.
 *
 * ?demo=1 → static snapshot: Spain vs TBC (SF1 decided, SF2 pending).
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const CACHE_KEY = 'cba:final:v1';
  const KNOWN_KICKOFF = '2026-07-19T19:00:00+00:00';

  const $ = (id) => document.getElementById(id);

  let kickoffEpoch = null;
  let hasData = false;

  function pad2(n) { return String(Math.max(0, n)).padStart(2, '0'); }
  function clockHMS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  }

  function aestLine(ms) {
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${(p.weekday || '').toUpperCase()} ${p.day} ${(p.month || '').toUpperCase()} ${p.hour}:${p.minute}${(p.dayPeriod || '').toUpperCase().replace(/\./g, '')} AEST`;
  }

  function tick() {
    if (kickoffEpoch == null) return;
    const diff = kickoffEpoch - Date.now();
    $('cd-clock').textContent = diff > 0 ? clockHMS(diff) : '00:00:00';
  }

  function render(data, badgeText) {
    const home = data.home;
    const away = data.away;

    $('home-name').textContent = home ? home.toUpperCase() : 'TBC';
    $('away-name').textContent = away ? away.toUpperCase() : 'TBC';

    const homeFlag = $('home-flag');
    const awayFlag = $('away-flag');
    if (home) setFlag(homeFlag, home, null);
    else homeFlag.removeAttribute('src');
    if (away) setFlag(awayFlag, away, null);
    else awayFlag.removeAttribute('src');

    if (data.kickoffISO) {
      kickoffEpoch = new Date(data.kickoffISO).getTime();
      $('cd-kickoff').textContent = aestLine(kickoffEpoch);
      tick();
    } else {
      kickoffEpoch = null;
      $('cd-clock').textContent = '--:--:--';
      $('cd-kickoff').textContent = 'KICK-OFF TBC';
    }

    $('updatedBadge').textContent = badgeText;
    hasData = true;
  }

  // ── Cache ────────────────────────────────────────────────────────────────────
  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && p.data && p.ts ? p : null;
    } catch (e) { return null; }
  }
  function writeCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); }
    catch (e) { /* best-effort */ }
  }
  function cacheBadge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins <= 0) return 'Just updated';
    if (mins === 1) return 'Updated 1 min ago';
    return `Updated ${mins} mins ago`;
  }

  // ── Refresh ──────────────────────────────────────────────────────────────────
  async function refresh() {
    $('updatedBadge').textContent = 'Updating…';
    try {
      const [sfRes, finRes] = await Promise.all([
        fetch('/api/upcoming-list?count=16&round=Semi-finals', { cache: 'no-store' }),
        fetch('/api/upcoming-list?count=16&round=Final', { cache: 'no-store' }),
      ]);
      const sfJson = await sfRes.json();
      const finJson = await finRes.json();
      const sfMatches = (sfRes.ok && sfJson.ok) ? (sfJson.matches || []) : [];
      const finMatches = (finRes.ok && finJson.ok) ? (finJson.matches || []) : [];

      let data;
      if (finMatches.length > 0) {
        const f = finMatches[0];
        data = { home: f.home.name, away: f.away.name, kickoffISO: f.kickoffISO, winner: f.winner };
      } else {
        // Derive finalists from SF winners (sorted by kickoff → SF1, SF2)
        const sorted = sfMatches.slice().sort((a, b) => new Date(a.kickoffISO) - new Date(b.kickoffISO));
        const w1 = sorted[0] && sorted[0].winner ? (sorted[0].winner === 'home' ? sorted[0].home.name : sorted[0].away.name) : null;
        const w2 = sorted[1] && sorted[1].winner ? (sorted[1].winner === 'home' ? sorted[1].home.name : sorted[1].away.name) : null;
        data = { home: w1, away: w2, kickoffISO: KNOWN_KICKOFF, winner: null };
      }
      writeCache(data);
      render(data, 'Just updated');
    } catch (err) {
      console.error('[final]', err);
      $('updatedBadge').textContent = 'Update failed';
    }
  }

  // ── Demo ─────────────────────────────────────────────────────────────────────
  const DEMO = { home: 'Spain', away: null, kickoffISO: KNOWN_KICKOFF, winner: null };

  // ── Boot ─────────────────────────────────────────────────────────────────────
  if (isDemo) { render(DEMO, 'Demo'); return; }
  const cached = readCache();
  if (cached) render(cached.data, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, 1000);
})();
