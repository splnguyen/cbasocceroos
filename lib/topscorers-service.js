const { getApiFootballKey } = require('./load-env');
const { fetchPlayerAggregates } = require('./fixture-stats');

const API_BASE = 'https://v3.football.api-sports.io';
const DEFAULT_LEAGUE = 1;       // FIFA World Cup
const DEFAULT_SEASON = 2026;    // tournament season
const DEMO_SEASON   = 2022;     // 2022 WC = finished, full top-scorers table
const MAX_SCORERS   = 20;       // cap the payload; screens slice to what they show

function hasApiErrors(errs) {
  if (!errs) return false;
  if (Array.isArray(errs)) return errs.length > 0;
  if (typeof errs === 'object') return Object.keys(errs).length > 0;
  return Boolean(errs);
}

async function apiGet(path, params, apiKey) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
  const json = await res.json();
  if (!res.ok || hasApiErrors(json.errors)) {
    const msg = hasApiErrors(json.errors)
      ? Object.values(json.errors).join('; ')
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// ── DEMO: finished 2022 tournament — season aggregates are complete & correct,
//    so the cheap /players/topscorers endpoint is fine (no fixture sweep needed).
function normaliseScorer(entry, index) {
  const p = entry.player || {};
  const stats = (entry.statistics || []).reduce((best, s) => {
    const g = s?.goals?.total ?? 0;
    return g >= (best?.goals?.total ?? -1) ? s : best;
  }, entry.statistics?.[0] || {});

  return {
    rank: index + 1,
    playerId: p.id ?? null,
    name: p.name || [p.firstname, p.lastname].filter(Boolean).join(' ') || '–',
    photo: p.photo ?? null,
    nationality: p.nationality ?? null,
    teamId: stats.team?.id ?? null,
    teamName: stats.team?.name ?? '',
    teamLogo: stats.team?.logo ?? null,
    goals: stats.goals?.total ?? 0,
    assists: stats.goals?.assists ?? 0,
    appearances: stats.games?.appearences ?? 0,
    minutes: stats.games?.minutes ?? 0,
  };
}

async function fetchDemoScorers(league, season, apiKey) {
  const json = await apiGet('/players/topscorers', { league, season }, apiKey);
  return (json.response ?? []).map(normaliseScorer).slice(0, MAX_SCORERS);
}

// ── LIVE: build the Golden Boot board from per-fixture stats (the season
//    aggregate lags a whole fixture during matchdays — see fixture-stats.js).
function buildLiveScorers(aggregates) {
  return aggregates.players
    .filter((p) => p.goals > 0)
    .sort((a, b) => (b.goals - a.goals) || (b.assists - a.assists) || (a.minutes - b.minutes))
    .slice(0, MAX_SCORERS)
    .map((p, i) => ({
      rank: i + 1,
      playerId: p.playerId,
      name: p.name,
      photo: p.photo,
      teamId: p.teamId,
      teamName: p.teamName,
      teamLogo: p.teamLogo,
      goals: p.goals,
      assists: p.assists,
      appearances: p.apps,
      minutes: p.minutes,
    }));
}

async function fetchTopScorers(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const isDemo = query.demo === '1' || query.demo === 'true';
  const league = Number(query.league || DEFAULT_LEAGUE);
  const season = isDemo ? DEMO_SEASON : Number(query.season || DEFAULT_SEASON);

  let scorers;
  let partial = false;
  if (isDemo) {
    scorers = await fetchDemoScorers(league, season, apiKey);
  } else {
    const aggregates = await fetchPlayerAggregates({ league, season, apiKey });
    scorers = buildLiveScorers(aggregates);
    partial = aggregates.partial;
  }

  return {
    ok: true,
    season,
    league,
    resolvedAs: isDemo ? 'demo-2022' : 'live',
    scorers,
    partial,           // true if some fixtures were dropped to rate-limiting
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchTopScorers, DEFAULT_LEAGUE, DEFAULT_SEASON, DEMO_SEASON };
