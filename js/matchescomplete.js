/**
 * Latest Matches (group-stage results summary).
 *
 *   GET /api/upcoming-list?count=20&status=finished[&demo=1]  → recent FT matches
 *   GET /api/standings                          → render 2 group cards below
 *
 * Picks the 2 most recent FT fixtures for the top section. Below shows 2
 * group standings cards (the groups those matches are in, or A+B fallback).
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';

  const $ = (id) => document.getElementById(id);

  // Map team rank → status class (qualified/contention/eliminated).
  const STATUS_RANK = { qualified: 0, contention: 1, eliminated: 2 };
  let hasData = false;
  const CACHE_KEY = `cba:matchescomplete:v1:demo=${isDemo ? 1 : 0}`;

  // ── Apply (from fetch or cache) — payload bundles both API responses ───────
  function applyPayload(payload, badgeText = 'Just updated') {
    const recentJson = payload.recent || {};
    const standingsJson = payload.standings || {};
    // Server returns finished matches newest-first. Prefer showing the full
    // concurrent pair: concurrent matches kick off at the same time, but the
    // API returns them in fixture-ID order so a match from a different slot can
    // slip in at position 2 and push a same-slot partner to position 3. Grab
    // all matches within 15 min of the most recent kickoff first; fall back to
    // simple top-2 only if the slot has just one match.
    const allFinished = (recentJson.matches || []).filter((m) => m.isFinished);
    let finished;
    if (!allFinished.length) {
      finished = [];
    } else {
      const t0 = allFinished[0].kickoffEpoch || +new Date(allFinished[0].kickoffISO);
      const SLOT_MS = 15 * 60 * 1000;
      const slot = allFinished.filter((m) => {
        const t = m.kickoffEpoch || +new Date(m.kickoffISO);
        return t0 - t <= SLOT_MS;
      });
      finished = slot.length >= 2 ? slot.slice(0, 2) : allFinished.slice(0, 2);
    }
    renderResults(finished);
    // Group cards mirror the two results: most-recent match's group on the left,
    // next most-recent on the right.
    renderStandings(standingsJson.groups || [], finished);
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
      const [recentRes, standingsRes] = await Promise.all([
        // status=finished → most-recent FINISHED matches (newest first). The plain
        // ?next= default returns upcoming-only, which filtered to nothing live.
        fetch(`/api/upcoming-list?count=20&status=finished${isDemo ? '&demo=1' : ''}`, { cache: 'no-store' }),
        fetch(`/api/standings${isDemo ? '?demo=1' : ''}`, { cache: 'no-store' }),
      ]);
      const recentJson = await recentRes.json();
      const standingsJson = await standingsRes.json();
      if (!recentJson.ok) throw new Error(recentJson.error || 'standings failed');

      const payload = { recent: recentJson, standings: standingsJson };
      writeCache(payload);
      applyPayload(payload); // reload values when the API call returns
    } catch (err) {
      console.error('[matchescomplete]', err);
      // Keep cached/previous results visible; just flag the failure.
      $('updatedBadge').textContent = 'Update failed';
    }
  }

  function aestKickoffLine(ms) {
    // Figma shows the long form, e.g. "TUESDAY 16 JUNE 05:00AM AEST".
    // WC 2026 window (11 Jun–19 Jul) sits entirely in AEST, so the suffix is fixed.
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${(p.weekday || '').toUpperCase()} ${p.day} ${(p.month || '').toUpperCase()} ${p.hour}:${p.minute}${(p.dayPeriod || '').toUpperCase().replace(/\./g, '')} AEST`;
  }

  const ROUND_LABELS = {
    'Semi-finals': 'Semi Finals',
    'Quarter-finals': 'Quarter Finals',
    'Round of 16': 'Round of 16',
    'Final': 'Final',
    '3rd Place': 'Third Place Play-Off',
  };

  function renderResults(matches) {
    const metaEl = $('meta-round');
    if (metaEl && matches.length) {
      const round = matches[0].leagueRound || matches[0].stage || '';
      metaEl.textContent = ROUND_LABELS[round] || round || 'Group Stage';
    }
    const root = $('results-stack');
    if (!matches.length) {
      root.innerHTML = '<div class="results-empty">No recent results yet.</div>';
      return;
    }
    root.innerHTML = matches.map((m) => {
      const date = aestKickoffLine(m.kickoffEpoch || new Date(m.kickoffISO).getTime());
      // Use server-resolved winner so PEN matches mark the correct loser.
      const homeLoser = m.winner === 'away';
      const awayLoser = m.winner === 'home';
      return `
        <div class="result-block">
          <div class="result-date">${date}</div>
          <div class="result-row">
            <div class="result-team home ${homeLoser ? 'loser' : ''}">
              <div class="result-score">${m.scoreH ?? '–'}</div>
              <div class="result-avatar">
                <div class="result-flag"><img alt="${m.home.name}"></div>
                <div class="result-name">${(m.home.name || '').toUpperCase()}</div>
              </div>
            </div>
            <div class="result-centre">
              <div class="vert-seg"></div>
              <div class="result-ft">FT</div>
              <div class="vert-seg"></div>
            </div>
            <div class="result-team away ${awayLoser ? 'loser' : ''}">
              <div class="result-score">${m.scoreA ?? '–'}</div>
              <div class="result-avatar">
                <div class="result-flag"><img alt="${m.away.name}"></div>
                <div class="result-name">${(m.away.name || '').toUpperCase()}</div>
              </div>
            </div>
          </div>
        </div>`;
    }).join('<div class="div-thick"></div>');
    root.querySelectorAll('.result-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  // Goal difference with explicit sign (FIFA convention: +5, 0, −3). U+2212 minus
  // to match the design font, same as the group-status screens.
  function gdLabel(gd) {
    const n = Number(gd) || 0;
    if (n > 0) return `+${n}`;
    if (n < 0) return `−${Math.abs(n)}`;
    return '0';
  }

  // `solo` → only one group card is shown (both results share a group), so it
  // spans the full width — use the full country name instead of the 3-letter code.
  function rowHtml(t, solo) {
    const label = solo ? (t.name || '').toUpperCase() : teamCode(t.name);
    return `
      <div class="grow grow--${t.status}">
        <div class="grow-left">
          <div class="grow-flag"><img alt="${t.name}"></div>
          <div class="grow-code">${label}</div>
        </div>
        <div class="grow-stats">
          <span class="gs-reg">${t.mp}</span>
          <span class="gs-reg">${t.w}</span>
          <span class="gs-reg">${t.d}</span>
          <span class="gs-reg">${t.l}</span>
          <span class="gs-reg gs-gd">${gdLabel(t.gd)}</span>
          <span class="gs-pts">${t.pts}</span>
        </div>
      </div>`;
  }

  function groupCardHtml(group, solo) {
    const sorted = [...group.teams].sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (s !== 0) return s;
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd  !== a.gd ) return b.gd  - a.gd;
      return b.gf - a.gf;
    });
    return `
      <div class="gcard${solo ? ' gcard--solo' : ''}">
        <div class="gtitle">GROUP ${group.letter}</div>
        <div class="gdivider"></div>
        <div class="gcols">
          <span>MP</span><span>W</span><span>D</span><span>L</span><span class="gs-gd">GD</span><span>PTS</span>
        </div>
        <div class="grows">${sorted.map((t) => rowHtml(t, solo)).join('')}</div>
      </div>`;
  }

  function renderStandings(groups, matches = []) {
    const root = $('standings-pair');
    const byLetter = new Map(groups.map((g) => [g.letter, g]));
    // Pick the groups of the displayed matches in order (recent → left). m.group
    // is "GROUP E"; dedupe so two matches in one group don't show it twice.
    const letters = [];
    for (const m of matches) {
      const L = (m.group || '').replace(/^GROUP\s+/i, '').trim();
      if (L && byLetter.has(L) && !letters.includes(L)) letters.push(L);
    }
    let pair = letters.map((L) => byLetter.get(L));
    // Fallback (e.g. knockout matches carry no group letter): first 2 groups.
    if (!pair.length) pair = groups.slice(0, 2);
    // A single card spans the full width → room for full country names.
    const solo = pair.length === 1;
    root.innerHTML = pair.map((g) => groupCardHtml(g, solo)).join('');
    root.querySelectorAll('.grow-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  const cached = readCache();
  if (cached) applyPayload(cached.payload, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
})();
