/**
 * Latest Matches (group-stage results summary).
 *
 *   GET /api/upcoming-list?count=20[&demo=1]   → filter to FT matches
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

  async function refresh() {
    $('updatedBadge').textContent = 'Updating…';
    try {
      const [recentRes, standingsRes] = await Promise.all([
        fetch(`/api/upcoming-list?count=20${isDemo ? '&demo=1' : ''}`, { cache: 'no-store' }),
        fetch(`/api/standings${isDemo ? '?demo=1' : ''}`, { cache: 'no-store' }),
      ]);
      const recentJson = await recentRes.json();
      const standingsJson = await standingsRes.json();
      if (!recentJson.ok) throw new Error(recentJson.error || 'standings failed');

      const finished = (recentJson.matches || []).filter((m) => m.isFinished).slice(-2).reverse();
      renderResults(finished);
      renderStandings(standingsJson.groups || []);
      $('updatedBadge').textContent = 'Just updated';
    } catch (err) {
      console.error('[matchescomplete]', err);
      $('updatedBadge').textContent = 'Update failed';
    }
  }

  function aestKickoffLine(ms) {
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'long', day: 'numeric', month: 'long',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${(p.weekday || '').toUpperCase()} ${p.day} ${(p.month || '').toUpperCase()} ${p.hour}:${p.minute}${(p.dayPeriod || '').toUpperCase().replace(/\./g, '')} AEST`;
  }

  function renderResults(matches) {
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
              <div class="result-flag"><img alt="${m.home.name}"></div>
              <div class="result-name">${(m.home.name || '').toUpperCase()}</div>
            </div>
            <div class="result-status">FT</div>
            <div class="result-team away ${awayLoser ? 'loser' : ''}">
              <div class="result-score">${m.scoreA ?? '–'}</div>
              <div class="result-flag"><img alt="${m.away.name}"></div>
              <div class="result-name">${(m.away.name || '').toUpperCase()}</div>
            </div>
          </div>
        </div>`;
    }).join('');
    root.querySelectorAll('.result-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  function rowHtml(t) {
    return `
      <div class="grow grow--${t.status}">
        <div class="grow-left">
          <div class="grow-flag"><img alt="${t.name}"></div>
          <div class="grow-code">${teamCode(t.name)}</div>
        </div>
        <div class="grow-stats">
          <span class="gs-reg">${t.mp}</span>
          <span class="gs-reg">${t.w}</span>
          <span class="gs-reg">${t.d}</span>
          <span class="gs-reg">${t.l}</span>
          <span class="gs-pts">${t.pts}</span>
        </div>
      </div>`;
  }

  function groupCardHtml(group) {
    const sorted = [...group.teams].sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (s !== 0) return s;
      return b.pts - a.pts;
    });
    return `
      <div class="gcard">
        <div class="gtitle">GROUP ${group.letter}</div>
        <div class="gdivider"></div>
        <div class="gcols">
          <span>MP</span><span>W</span><span>D</span><span>L</span><span>PTS</span>
        </div>
        <div class="grows">${sorted.map(rowHtml).join('')}</div>
      </div>`;
  }

  function renderStandings(groups) {
    const root = $('standings-pair');
    // Show first 2 groups by default.
    const pair = groups.slice(0, 2);
    root.innerHTML = pair.map(groupCardHtml).join('');
    root.querySelectorAll('.grow-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();
