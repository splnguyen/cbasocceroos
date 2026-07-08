const { getApiFootballKey } = require('./load-env');
const { apiGet, DEFAULT_LEAGUE, DEFAULT_SEASON } = require('./match-service');

const FINISHED = new Set(['FT', 'AET', 'PEN']);

// Shootout matches (status PEN) are officially DRAWS in FIFA head-to-head
// records, but on a fan screen crediting the shootout winner reads better
// ("Argentina beat France in the 2022 final"). Flip to false for the
// official-record convention.
const COUNT_SHOOTOUT_AS_WIN = true;

/**
 * Head-to-head record between two teams, aggregated from api-football's
 * `/fixtures/headtohead?h2h=A-B` — every meeting IN THE PROVIDER'S DATABASE
 * across all competitions (WC, qualifiers, friendlies). For national teams
 * that history only goes back to ~2008 (e.g. FRA–MAR returns just the 2022
 * WC semi), so treat this as a "recent record", not an all-time one.
 *
 * Response is keyed to the QUERY order: `home`/`away` here mean the two ids
 * passed in (matching the fixture being displayed), NOT who hosted each
 * historical meeting — api-football flips home/away per fixture, so goals and
 * wins are re-mapped by team id.
 *
 * Shape:
 *   { ok, home: {id,name,logo}, away: {id,name,logo},
 *     played, winsHome, winsAway, draws, goalsHome, goalsAway,
 *     lastMeeting: { dateISO, year, leagueName, round, resultLine,
 *                    scoreH, scoreA, penH, penA, homeName, awayName } | null }
 */
async function fetchH2H(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const homeId = Number(query.home);
  const awayId = Number(query.away);
  if (!homeId || !awayId) throw new Error('h2h requires ?home=<teamId>&away=<teamId>');

  // 30s TTL — an H2H record changes at most once per matchday, and this screen
  // polls every 5 min anyway; the TTL just collapses multi-display bursts.
  const json = await apiGet('/fixtures/headtohead', { h2h: `${homeId}-${awayId}` }, apiKey, { ttlMs: 30000 });

  const meetings = (json.response ?? [])
    .filter((f) => FINISHED.has(f.fixture?.status?.short))
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  const rec = {
    played: 0,
    winsHome: 0,
    winsAway: 0,
    draws: 0,
    goalsHome: 0,
    goalsAway: 0,
  };
  let homeTeam = null;
  let awayTeam = null;
  let last = null;
  const rows = []; // per-meeting rows (chronological; reversed + capped below)

  for (const f of meetings) {
    const th = f.teams?.home, ta = f.teams?.away;
    const gh = f.goals?.home, ga = f.goals?.away;
    if (!th || !ta || !Number.isFinite(gh) || !Number.isFinite(ga)) continue;

    // Re-map this meeting's sides onto the queried pair by team id.
    const queriedHomeWasHost = th.id === homeId;
    if (!queriedHomeWasHost && ta.id !== homeId) continue; // defensive: unrelated fixture
    const gFor = queriedHomeWasHost ? gh : ga;   // goals for the queried "home" team
    const gAgn = queriedHomeWasHost ? ga : gh;
    homeTeam = queriedHomeWasHost ? th : ta;
    awayTeam = queriedHomeWasHost ? ta : th;

    rec.played += 1;
    rec.goalsHome += gFor;
    rec.goalsAway += gAgn;

    // Winner: goals decide FT/AET; PEN fixtures are level on goals, so use the
    // shootout tally (score.penalty) when COUNT_SHOOTOUT_AS_WIN is on.
    const pen = f.score?.penalty || {};
    const isPen = f.fixture.status?.short === 'PEN'
      && Number.isFinite(pen.home) && Number.isFinite(pen.away);
    let winnerId = null;
    if (gh > ga) winnerId = th.id;
    else if (ga > gh) winnerId = ta.id;
    else if (isPen && COUNT_SHOOTOUT_AS_WIN) winnerId = pen.home > pen.away ? th.id : ta.id;

    if (winnerId === homeId) rec.winsHome += 1;
    else if (winnerId === awayId) rec.winsAway += 1;
    else rec.draws += 1;

    last = {
      dateISO: f.fixture.date,
      year: new Date(f.fixture.date).getFullYear(),
      leagueName: f.league?.name ?? null,
      round: f.league?.round ?? null,
      homeName: th.name,
      awayName: ta.name,
      scoreH: gh,
      scoreA: ga,
      penH: isPen ? pen.home : null,
      penA: isPen ? pen.away : null,
    };
    rows.push({ ...last, winnerId });
  }

  return {
    ok: true,
    home: { id: homeId, name: homeTeam?.name ?? null, logo: homeTeam?.logo ?? null },
    away: { id: awayId, name: awayTeam?.name ?? null, logo: awayTeam?.logo ?? null },
    ...rec,
    lastMeeting: last,
    meetings: rows.reverse().slice(0, 5), // most recent first, capped for display
    resolvedAs: 'headtohead',
    source: 'api-football',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * A team's finished-match record inside one tournament — drives the
 * "World Cup 2026" form strip on the coming-up screen.
 *
 * Uses `/fixtures?team&league&season&status=FT-AET-PEN` (finished only, so an
 * in-play or unplayed fixture can never pollute the strip). W/D/L is derived
 * from goals — api-football's `teams.*.winner` boolean is not trusted because
 * its shootout semantics vary; PEN fixtures are level on goals, so the winner
 * comes from `score.penalty.*` (a shootout win counts as a W, matching
 * COUNT_SHOOTOUT_AS_WIN above; knockout fixtures therefore never show D).
 *
 * Shape: { ok, team: {id,name,logo}, played, goalsFor, goalsAgainst, unbeaten,
 *          form: [{ result:'W'|'D'|'L', opponent, scoreFor, scoreAgainst,
 *                   penFor, penAgainst, round, dateISO }] }  // newest first
 */
async function fetchTeamForm(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const teamId = Number(query.team);
  if (!teamId) throw new Error('form requires ?team=<teamId>');
  const league = Number(query.league || DEFAULT_LEAGUE);
  const season = Number(query.season || DEFAULT_SEASON);
  const count = Math.max(1, Math.min(10, Number(query.count || 5)));

  const json = await apiGet(
    '/fixtures',
    { team: teamId, league, season, status: 'FT-AET-PEN' },
    apiKey,
    { ttlMs: 30000 },
  );

  const fixtures = (json.response ?? [])
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, count);

  let team = null;
  let goalsFor = 0;
  let goalsAgainst = 0;
  const form = [];

  for (const f of fixtures) {
    const th = f.teams?.home, ta = f.teams?.away;
    const gh = f.goals?.home, ga = f.goals?.away;
    if (!th || !ta || !Number.isFinite(gh) || !Number.isFinite(ga)) continue;

    const isHome = th.id === teamId;
    team = isHome ? th : ta;
    const opp = isHome ? ta : th;
    const gFor = isHome ? gh : ga;
    const gAgn = isHome ? ga : gh;
    goalsFor += gFor;
    goalsAgainst += gAgn;

    const pen = f.score?.penalty || {};
    const isPen = f.fixture.status?.short === 'PEN'
      && Number.isFinite(pen.home) && Number.isFinite(pen.away);
    const pFor = isPen ? (isHome ? pen.home : pen.away) : null;
    const pAgn = isPen ? (isHome ? pen.away : pen.home) : null;

    let result = 'D';
    if (gFor > gAgn) result = 'W';
    else if (gAgn > gFor) result = 'L';
    else if (isPen) result = pFor > pAgn ? 'W' : 'L';

    form.push({
      result,
      opponent: opp.name,
      scoreFor: gFor,
      scoreAgainst: gAgn,
      penFor: pFor,
      penAgainst: pAgn,
      round: f.league?.round ?? null,
      dateISO: f.fixture.date,
    });
  }

  return {
    ok: true,
    team: { id: teamId, name: team?.name ?? null, logo: team?.logo ?? null },
    league,
    season,
    played: form.length,
    goalsFor,
    goalsAgainst,
    unbeaten: form.length > 0 && form.every((m) => m.result !== 'L'),
    form,
    resolvedAs: 'team-form',
    source: 'api-football',
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchH2H, fetchTeamForm };
