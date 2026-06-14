/**
 * Single match — Recently Completed (FT recap).
 *
 *   GET /api/match (last AUS fixture)  → ?demo=1 = 2022 final
 *
 * Renders the winning team in white, losing team in mid-grey + desaturated flag.
 * "TOP PERFORMERS" panel currently shows placeholder rows — api-football's
 * /players endpoint would populate this but isn't wired yet.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const params = new URLSearchParams(location.search);
  const isDemo = params.get('demo') === '1';

  const $ = (id) => document.getElementById(id);
  let hasData = false;
  const CACHE_KEY = `cba:matchcomplete:v2:demo=${isDemo ? 1 : 0}`; // v2: last-finished resolution

  // ── Apply (from fetch or cache) ──────────────────────────────────────────
  function applyPayload(json, badgeText = 'Just updated') {
    render(json);
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
      const qs = new URLSearchParams();
      qs.set('players', '1');                       // top performers panel
      // Resolve the most recent FINISHED match — not the live/upcoming default,
      // which would show a not-yet-played fixture as "Recently Completed".
      if (isDemo) qs.set('demo', '1');
      else qs.set('status', 'finished');
      const res = await fetch(`/api/match?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      writeCache(json);
      applyPayload(json); // reload values when the API call returns
    } catch (err) {
      console.error('[matchcomplete]', err);
      // Keep cached/previous recap visible; just flag the failure.
      $('updatedBadge').textContent = 'Update failed';
    }
  }

  // Shrink a team name until it fits its column. Short names stay at
  // --name-base (the Figma size); long names step down so they don't overflow
  // and shove the score row off-centre.
  // - Multi-word names (e.g. "BOSNIA & HERZEGOVINA") may wrap to two centred
  //   lines, breaking only at the space.
  // - Single-word names (e.g. "SWITZERLAND") must stay on ONE line — never split
  //   mid-word — so we force nowrap and shrink purely to fit the width.
  function fitTeamName(el) {
    if (!el) return;
    const cs = getComputedStyle(el);
    const base = parseFloat(cs.getPropertyValue('--name-base')) || parseFloat(cs.fontSize);
    const MIN = 22;
    const singleWord = !/\s/.test((el.textContent || '').trim());
    el.style.whiteSpace = singleWord ? 'nowrap' : '';   // reset each call
    let size = base;
    el.style.fontSize = size + 'px';
    let guard = 0;
    while (size > MIN && guard++ < 24) {
      const tooWide = el.scrollWidth > el.clientWidth + 1;
      let fits;
      if (singleWord) {
        fits = !tooWide;                                // one line, just fit the width
      } else {
        const lineH = size * 1.15;                      // generous, avoids off-by-one
        const tooManyLines = el.scrollHeight > lineH * 2 + 2;
        fits = !tooManyLines && !tooWide;
      }
      if (fits) break;
      size -= 2;
      el.style.fontSize = size + 'px';
    }
  }
  function fitTeamNames() {
    fitTeamName($('name-home'));
    fitTeamName($('name-away'));
  }
  // Re-fit once the brand font loads — measuring before it does gives wrong widths.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTeamNames);

  function render(state) {
    // Server-resolved winner accounts for penalty shootouts (PEN/AET/FT).
    const homeLoser = state.winner === 'away';
    const awayLoser = state.winner === 'home';

    $('meta-group').textContent = state.metaGroup ?? '–';
    $('meta-venue').textContent = state.metaVenue ?? '–';

    $('score-home').textContent = state.scoreH ?? 0;
    $('score-away').textContent = state.scoreA ?? 0;
    $('name-home').textContent = (state.home.name || '').toUpperCase();
    $('name-away').textContent = (state.away.name || '').toUpperCase();
    fitTeamNames();
    setFlag($('flag-home'), state.home.name, state.home.logo);
    setFlag($('flag-away'), state.away.name, state.away.logo);
    setFlag($('poss-flag-home'), state.home.name, state.home.logo);
    setFlag($('poss-flag-away'), state.away.name, state.away.logo);

    document.querySelector('.team-col.home').classList.toggle('loser', homeLoser);
    document.querySelector('.team-col.away').classList.toggle('loser', awayLoser);

    $('result-line').textContent = state.resultLine || (state.winner === 'draw' ? 'Draw' : '–');

    const possH = Number.isFinite(state.possH) ? state.possH : 50;
    const possA = Number.isFinite(state.possA) ? state.possA : 50;
    $('poss-home').textContent = `${possH}%`;
    $('poss-away').textContent = `${possA}%`;
    $('poss-bar-home').style.width = `${possH}%`;

    // Card order matches the Figma 4×2 grid: shots/target, fouls/corners,
    // passes/pass-accuracy, saves/offsides.
    const statRows = [
      ['shots', state.shots],
      ['target', state.target],
      ['fouls', state.fouls],
      ['corners', state.corners],
      ['passes', state.passes],
      ['passacc', state.passAcc],
      ['saves', state.saves],
      ['offsides', state.offsides],
    ];
    for (const [id, pair] of statRows) {
      $(`s-${id}-h`).textContent = pair?.[0] ?? '–';
      $(`s-${id}-a`).textContent = pair?.[1] ?? '–';
    }

    renderTopPerformers(state);
  }

  function renderTopPerformers(state) {
    const root = $('tp-list');
    const performers = state.topPerformers || [];
    if (!performers.length) {
      root.innerHTML = '<div class="tp-empty">Player stats unavailable</div>';
      return;
    }
    // Players on the losing team get the dark-grey "loser" row treatment.
    const losingTeamId = state.winner === 'home' ? state.away.id
                       : state.winner === 'away' ? state.home.id
                       : null;
    root.innerHTML = performers.map((p) => {
      const isLoser = losingTeamId != null && p.teamId === losingTeamId;
      const photo = p.photo ? `<img src="${p.photo}" alt="${p.name}">` : '';
      return `
        <div class="tp-row ${isLoser ? 'loser' : ''}">
          <div class="tp-flag">${photo}</div>
          <span class="tp-name">${(p.name || '').toUpperCase()}</span>
          <span class="tp-stats">${p.statLine}</span>
        </div>`;
    }).join('');
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  const cached = readCache();
  if (cached) applyPayload(cached.payload, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
})();
