/**
 * Recently Completed (Knockout) — Figma 2221-7152.
 *
 *   GET /api/upcoming-list?count=20&status=finished[&demo=1]  → recent FT matches
 *        (dates, scores, winner, teams). Prefer knockout matches; fall back to
 *        the most recent finished if no knockout results exist yet.
 *   GET /api/match?fixture=<id>     → per-match POST-GAME STATS (possession,
 *        shots, on-target, corners, fouls). Demo: /api/match resolves by team
 *        (it ignores ?fixture in demo), so request ?demo=1&team=<homeId>.
 *
 * Shows the 2 most recent matches, each as: date · FT score line (winner white,
 * loser grey) · possession bar · 4 stat cards.
 */
(function () {
  const POLL_MS = 5 * 60 * 1000;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const $ = (id) => document.getElementById(id);
  const CACHE_KEY = `cba:matchescomplete-knockout:v1:demo=${isDemo ? 1 : 0}`;

  // ── Date line: "TUESDAY 16 JUNE 05:00AM AEST" (AEST fixed — WC window). ─────
  function aestKickoffLine(ms) {
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${(p.weekday || '').toUpperCase()} ${p.day} ${(p.month || '').toUpperCase()} ${p.hour}:${p.minute}${(p.dayPeriod || '').toUpperCase().replace(/\./g, '')} AEST`;
  }

  // FT / AET / PEN label (knockout matches can run to extra time or a shootout).
  function resultTag(m) {
    return m.decidedBy === 'PEN' ? 'PEN' : m.decidedBy === 'AET' ? 'AET' : 'FT';
  }

  function statCard(label, pair) {
    return `<div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-vals">
          <span class="stat-h">${pair?.[0] ?? '–'}</span>
          <span class="stat-sep"></span>
          <span class="stat-a">${pair?.[1] ?? '–'}</span>
        </div>
      </div>`;
  }

  function blockHtml(m) {
    const date = aestKickoffLine(m.kickoffEpoch || +new Date(m.kickoffISO));
    // Server-resolved winner accounts for penalty shootouts → correct loser.
    const homeLoser = m.winner === 'away';
    const awayLoser = m.winner === 'home';
    // Shootout score under the PEN tag (home–away, matching the columns) —
    // a bare "PEN" between two 0s reads as missing information.
    const pens = m.decidedBy === 'PEN' && m.penH != null && m.penA != null
      ? `<div class="result-pens">${m.penH}–${m.penA}</div>` : '';
    const possH = Number.isFinite(m.possH) ? m.possH : 50;
    const possA = Number.isFinite(m.possA) ? m.possA : 50;
    return `
      <div class="match-block">
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
            <div class="result-ft">${resultTag(m)}</div>
            ${pens}
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
        <div class="poss-wrap">
          <div class="poss-label">POSSESSION</div>
          <div class="poss-row">
            <span class="poss-pct home ${homeLoser ? 'loser' : ''}">${possH}%</span>
            <div class="poss-flag"><img alt="${m.home.name}"></div>
            <div class="poss-bar">
              <div class="poss-seg ${homeLoser ? 'loser' : ''}" style="width:${possH}%"></div>
              <div class="poss-seg ${awayLoser ? 'loser' : ''}" style="width:${possA}%"></div>
            </div>
            <div class="poss-flag"><img alt="${m.away.name}"></div>
            <span class="poss-pct away ${awayLoser ? 'loser' : ''}">${possA}%</span>
          </div>
        </div>
        <div class="stat-cards">
          ${statCard('SHOTS', m.shots)}
          ${statCard('ON TARGET', m.target)}
          ${statCard('CORNERS', m.corners)}
          ${statCard('FOULS', m.fouls)}
        </div>
      </div>`;
  }

  // TOP PERFORMERS panel (single layout only) — losing team's players get the
  // dark-grey row treatment, same as the group-stage recap (matchcomplete.js).
  function topPerformersHtml(m) {
    const performers = m.topPerformers || [];
    if (!performers.length) {
      return '<div class="top-performers"><div class="tp-title">TOP PERFORMERS</div><div class="tp-list"><div class="tp-empty">Player stats unavailable</div></div></div>';
    }
    const losingTeamId = m.winner === 'home' ? m.away.id : m.winner === 'away' ? m.home.id : null;
    const rows = performers.map((p) => {
      const isLoser = losingTeamId != null && p.teamId === losingTeamId;
      const photo = p.photo ? `<img src="${p.photo}" alt="">` : '';
      return `
        <div class="tp-row ${isLoser ? 'loser' : ''}">
          <div class="tp-flag">${photo}</div>
          <span class="tp-name">${(p.name || '').toUpperCase()}</span>
          <span class="tp-stats">${p.statLine || ''}</span>
        </div>`;
    }).join('');
    return `<div class="top-performers"><div class="tp-title">TOP PERFORMERS</div><div class="tp-list">${rows}</div></div>`;
  }

  // Single-match recap — a clone of the group-stage single design
  // (screen-matchcomplete.html): score line + result text + possession, then the
  // 8-stat grid (left) + TOP PERFORMERS (right). Score keeps winner/loser colour;
  // possession is home(white)/away(grey) like matchcomplete.
  function singleRecapHtml(m) {
    const homeLoser = m.winner === 'away';
    const awayLoser = m.winner === 'home';
    const possH = Number.isFinite(m.possH) ? m.possH : 50;
    const possA = Number.isFinite(m.possA) ? m.possA : 50;
    const resultLine = m.resultLine || (m.winner === 'draw' ? 'Draw' : '');
    const teamCol = (side, name, score, loser) => `
      <div class="team-col ${side} ${loser ? 'loser' : ''}">
        <div class="score-num">${score ?? '–'}</div>
        <div class="team-avatar">
          <div class="flag-circle"><img alt="${name}"></div>
          <div class="team-name${(name || '').length >= 8 ? ' long' : ''}">${(name || '').toUpperCase()}</div>
        </div>
      </div>`;
    return `
      <div class="recap">
        <div class="score-section">
          ${teamCol('home', m.home.name, m.scoreH, homeLoser)}
          <div class="centre-col">
            <div class="vert-seg"></div>
            <div class="result-block">
              <div class="result-ft">${resultTag(m)}</div>
              ${resultLine ? `<div class="result-line">${resultLine}</div>` : ''}
            </div>
            <div class="vert-seg"></div>
          </div>
          ${teamCol('away', m.away.name, m.scoreA, awayLoser)}
        </div>
        <div class="div-thick"></div>
        <div class="poss-wrap">
          <div class="poss-label">POSSESSION</div>
          <div class="poss-row">
            <span class="poss-pct home">${possH}%</span>
            <div class="poss-flag"><img alt="${m.home.name}"></div>
            <div class="poss-bar"><div class="poss-fill-home" style="width:${possH}%"></div></div>
            <div class="poss-flag"><img alt="${m.away.name}"></div>
            <span class="poss-pct away">${possA}%</span>
          </div>
        </div>
        <div class="bottom-grid">
          <div class="stats-grid">
            ${statCard('SHOTS', m.shots)}
            ${statCard('ON TARGET', m.target)}
            ${statCard('FOULS', m.fouls)}
            ${statCard('CORNERS', m.corners)}
            ${statCard('PASSES', m.passes)}
            ${statCard('PASS ACCURACY', m.passAcc)}
            ${statCard('SAVES', m.saves)}
            ${statCard('OFFSIDES', m.offsides)}
          </div>
          ${topPerformersHtml(m)}
        </div>
      </div>`;
  }

  function render(matches, badgeText) {
    const root = $('match-blocks');
    const single = matches.length <= 1;
    // One match → single recap (top performers + stacked stats); two → dual.
    root.classList.toggle('single', single);
    if (!matches.length) {
      root.innerHTML = '<div class="results-empty">No recent results yet.</div>';
    } else if (single) {
      root.innerHTML = singleRecapHtml(matches[0]);
    } else {
      root.innerHTML = matches.map(blockHtml).join('<div class="div-thick"></div>');
    }
    // Country flags resolve by name; player photos use their direct src in HTML.
    root.querySelectorAll('.result-flag img, .poss-flag img, .flag-circle img').forEach((img) => setFlag(img, img.alt, null));
    $('updatedBadge').textContent = badgeText;
  }

  // ── Cache (instant paint on carousel revisits) ─────────────────────────────
  function readCache() {
    try {
      const p = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return p && p.matches && p.ts ? p : null;
    } catch (e) { return null; }
  }
  function writeCache(matches) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ matches, ts: Date.now() })); }
    catch (e) { /* best-effort */ }
  }
  function cacheBadge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins <= 0) return 'Just updated';
    if (mins === 1) return 'Updated 1 min ago';
    return `Updated ${mins} mins ago`;
  }

  // Decide how many matches to show by a 24-hour window: 2+ played in the last
  // 24h → the two most recent (dual layout); otherwise just the single most
  // recent (single layout). `list` is newest-first.
  function pickRecent(list) {
    if (!list.length) return [];
    const t = (m) => m.kickoffEpoch || +new Date(m.kickoffISO);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const within24h = list.filter((m) => now - t(m) <= DAY_MS);
    return within24h.length >= 2 ? within24h.slice(0, 2) : list.slice(0, 1);
  }

  // Fetch post-game stats for one match and merge them onto the list entry.
  // `withPlayers` also pulls TOP PERFORMERS (single layout only).
  async function withStats(m, withPlayers) {
    const qs = new URLSearchParams();
    // Demo /api/match ignores ?fixture (resolves by team's last 2022 match), so
    // request by the home team to get THIS match's stats; live uses the fixture id.
    if (isDemo) { qs.set('demo', '1'); qs.set('team', m.home.id); }
    else { qs.set('fixture', m.fixtureId); }
    if (withPlayers) qs.set('players', '1');
    try {
      const r = await fetch(`/api/match?${qs}`, { cache: 'no-store' });
      const j = await r.json();
      if (r.ok && j.ok) {
        return { ...m, possH: j.possH, possA: j.possA,
          shots: j.shots, target: j.target, corners: j.corners, fouls: j.fouls,
          passes: j.passes, passAcc: j.passAcc, saves: j.saves, offsides: j.offsides,
          topPerformers: j.topPerformers };
      }
    } catch (e) { /* stats are optional — cards fall back to '–' */ }
    return m;
  }

  async function refresh() {
    $('updatedBadge').textContent = 'Updating…';
    try {
      const res = await fetch(`/api/upcoming-list?count=20&status=finished${isDemo ? '&demo=1' : ''}`, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);

      const allFinished = (json.matches || []).filter((m) => m.isFinished);
      // Prefer knockout results; fall back to the most recent finished so the
      // page is never blank (the "Latest Matches" title is phase-neutral).
      const knockout = allFinished.filter((m) => !/group/i.test(m.stage || m.leagueRound || ''));
      const picked = pickRecent(knockout.length ? knockout : allFinished);
      const single = picked.length <= 1;   // single layout pulls TOP PERFORMERS too
      const matches = await Promise.all(picked.map((m) => withStats(m, single)));

      writeCache(matches);
      render(matches, 'Just updated');
    } catch (err) {
      console.error('[matchescomplete-knockout]', err);
      if (!$('match-blocks').children.length) render([], 'Update failed');
      else $('updatedBadge').textContent = 'Update failed';
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  const cached = readCache();
  if (cached) render(cached.matches, cacheBadge(cached.ts));
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) refresh();
  setInterval(refresh, POLL_MS);
})();
