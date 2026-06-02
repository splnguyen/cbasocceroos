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

  async function refresh() {
    $('updatedBadge').textContent = 'Updating…';
    try {
      const qs = new URLSearchParams();
      qs.set('players', '1');                       // top performers panel
      if (isDemo) qs.set('demo', '1');
      const res = await fetch(`/api/match?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      render(json);
      $('updatedBadge').textContent = 'Just updated';
    } catch (err) {
      console.error('[matchcomplete]', err);
      $('updatedBadge').textContent = 'Update failed';
    }
  }

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

  refresh();
  setInterval(refresh, POLL_MS);
})();
