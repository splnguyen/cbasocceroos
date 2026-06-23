const { getApiFootballKey } = require('./load-env');

const API_BASE = 'https://v3.football.api-sports.io';
const DEFAULT_LEAGUE = 1;       // FIFA World Cup
const DEFAULT_SEASON = 2026;    // tournament season
const DEMO_SEASON   = 2022;     // 2022 WC = finished, full top-scorers table
const MAX_SCORERS   = 20;       // cap the payload; screens slice to what they show
const RECONCILE_TOP = 12;       // rows to re-check against /players (see reconcile note)
const CACHE_TTL_MS  = 60 * 1000; // share upstream calls across displays/polls

// In-memory cache (per warm serverless instance). Keyed by league:season:demo.
// Best-effort — collapses bursts from multiple office displays polling at once.
const _cache = new Map();

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

// api-football lists every club a player turned out for; for an international
// tournament there's only one entry, but guard for the array shape anyway.
function normaliseScorer(entry, index) {
  const p = entry.player || {};
  // The national-team line is the statistics row with goals — pick the best.
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
    penalties: stats.penalty?.scored ?? 0,
    appearances: stats.games?.appearences ?? 0,
    minutes: stats.games?.minutes ?? 0,
  };
}

// api-football's /players/topscorers leaderboard recomputes on a slower cadence
// than the per-player /players record, so mid-match it under-reports goals (e.g.
// Messi showing 3 on the board while /players already has 5). We re-read the
// fresher per-player total for the rows we actually display and re-sort. Goals
// only ever increase, so a stale leaderboard can only under-count — bumping the
// reconciled rows up and re-ranking can't wrongly demote anyone.
async function reconcileGoals(scorers, { league, season, apiKey }) {
  const top = scorers.slice(0, RECONCILE_TOP);
  await Promise.all(top.map(async (s) => {
    if (!s.playerId) return;
    try {
      const json = await apiGet('/players', { id: s.playerId, league, season }, apiKey);
      const stats = json.response?.[0]?.statistics || [];
      // Pick the row with the most goals (one WC line, but guard the shape).
      const best = stats.reduce(
        (b, st) => ((st?.goals?.total ?? 0) >= (b?.goals?.total ?? -1) ? st : b),
        stats[0] || {},
      );
      const goals = best?.goals?.total;
      if (typeof goals === 'number' && goals > s.goals) s.goals = goals;
      const assists = best?.goals?.assists;
      if (typeof assists === 'number' && assists > s.assists) s.assists = assists;
    } catch (_) { /* keep the leaderboard value if the per-player call fails */ }
  }));

  // Re-sort the whole payload by the (possibly corrected) goal totals and re-rank.
  scorers.sort((a, b) => (b.goals - a.goals) || (b.assists - a.assists));
  scorers.forEach((s, i) => { s.rank = i + 1; });
  return scorers;
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

  const cacheKey = `${league}:${season}:${isDemo ? 1 : 0}`;
  const hit = _cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.payload;

  const json = await apiGet('/players/topscorers', { league, season }, apiKey);
  const scorers = (json.response ?? [])
    .map(normaliseScorer)
    .slice(0, MAX_SCORERS);

  // The demo season is a finished tournament — its leaderboard is final, so skip
  // the per-player reconciliation (and its extra calls) entirely.
  if (!isDemo) await reconcileGoals(scorers, { league, season, apiKey });

  const payload = {
    ok: true,
    season,
    league,
    resolvedAs: isDemo ? 'demo-2022' : 'live',
    scorers,
    fetchedAt: new Date().toISOString(),
  };
  _cache.set(cacheKey, { ts: Date.now(), payload });
  return payload;
}

module.exports = { fetchTopScorers, DEFAULT_LEAGUE, DEFAULT_SEASON, DEMO_SEASON };
