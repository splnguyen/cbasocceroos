const { getApiFootballKey } = require('./load-env');
const { fetchPlayerAggregates } = require('./fixture-stats');

const API_BASE = 'https://v3.football.api-sports.io';
const DEFAULT_LEAGUE = 1;       // FIFA World Cup
const DEFAULT_SEASON = 2026;    // tournament season
const DEMO_SEASON   = 2022;     // 2022 WC = finished, full GK table (E. Martínez golden glove)
const MAX_KEEPERS   = 20;       // cap the payload; screens slice to what they show
const MAX_PAGES     = 60;       // safety cap on the /players sweep (demo only)
const PAGE_CONCURRENCY = 3;     // gentle: api-football rejects rapid bursts (per-second)
const PAGE_RETRIES  = 3;        // retry a rate-limited page with backoff before giving up
const CACHE_TTL_MS  = 30 * 60 * 1000; // demo GK table is static; cache hard

// LIVE keepers are built from the shared per-fixture sweep (fixture-stats.js),
// because the season /players aggregate lags a whole fixture on matchdays. DEMO
// (the finished 2022 tournament) keeps the original /players page-sweep — its
// season aggregates are complete and correct, and it needs `saves`/`conceded`
// which the historical fixture endpoints are slower to serve.
const _cache = new Map();       // `${league}:${season}` -> { ts, data }  (demo only)

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimited = (err) => /too many requests|exceeded the limit/i.test(err?.message || '');

async function apiGetRetry(path, params, apiKey, tries = PAGE_RETRIES) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await apiGet(path, params, apiKey); }
    catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

function isGoalkeeper(s) {
  return String(s?.games?.position || '').toLowerCase() === 'goalkeeper';
}

function normaliseKeeper(entry) {
  const p = entry.player || {};
  const gkRows = (entry.statistics || []).filter(isGoalkeeper);
  if (!gkRows.length) return null;
  const stats = gkRows.reduce((best, s) => {
    const m = s?.games?.minutes ?? 0;
    return m >= (best?.games?.minutes ?? -1) ? s : best;
  }, gkRows[0]);

  const appearances = stats.games?.appearences ?? 0;
  if (appearances < 1) return null;

  return {
    playerId: p.id ?? null,
    name: p.name || [p.firstname, p.lastname].filter(Boolean).join(' ') || '–',
    photo: p.photo ?? null,
    nationality: p.nationality ?? null,
    teamId: stats.team?.id ?? null,
    teamName: stats.team?.name ?? '',
    teamLogo: stats.team?.logo ?? null,
    conceded: stats.goals?.conceded ?? 0,
    saves: stats.goals?.saves ?? 0,
    penSaved: stats.penalty?.saved ?? 0,
    appearances,
    minutes: stats.games?.minutes ?? 0,
  };
}

// DEMO: page through /players for the finished season, with bounded concurrency.
async function sweepPlayers(league, season, apiKey) {
  const first = await apiGetRetry('/players', { league, season, page: 1 }, apiKey);
  const reportedPages = first.paging?.total || 1;
  const totalPages = Math.min(reportedPages, MAX_PAGES);
  const all = [...(first.response || [])];

  let nextPage = 2;
  let skipped = 0;
  async function worker() {
    while (nextPage <= totalPages) {
      const page = nextPage++;
      try {
        const json = await apiGetRetry('/players', { league, season, page }, apiKey);
        all.push(...(json.response || []));
      } catch (err) { skipped++; }
    }
  }
  const workerCount = Math.min(PAGE_CONCURRENCY, Math.max(0, totalPages - 1));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { players: all, capped: reportedPages > MAX_PAGES, partial: skipped > 0 };
}

// Shared ranking: Golden Glove = fewest conceded, tie-broken by minutes then saves.
// Qualify on appearances that SCALE with the tournament (60% of the most-played
// keeper's apps) so a one-match keeper can't out-rank a tournament-long starter.
function rankKeepers(candidates) {
  const maxApps = candidates.reduce((m, k) => Math.max(m, k.appearances), 0);
  const qualifyMinApps = Math.max(1, Math.ceil(maxApps * 0.6));
  const keepers = candidates
    .filter((k) => k.appearances >= qualifyMinApps)
    .sort((a, b) => a.conceded - b.conceded || b.minutes - a.minutes || b.saves - a.saves)
    .slice(0, MAX_KEEPERS)
    .map((k, i) => ({ rank: i + 1, ...k }));
  return { keepers, qualifyMinApps };
}

async function fetchDemoKeepers(league, season, apiKey) {
  const cacheKey = `${league}:${season}`;
  const cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

  const { players, capped, partial } = await sweepPlayers(league, season, apiKey);
  const candidates = players.map(normaliseKeeper).filter(Boolean);
  const { keepers, qualifyMinApps } = rankKeepers(candidates);

  const data = { keepers, qualifyMinApps, capped, partial };
  _cache.set(cacheKey, { ts: partial ? Date.now() - (CACHE_TTL_MS - 60_000) : Date.now(), data });
  return data;
}

// LIVE: derive keepers from the shared per-fixture aggregate.
function buildLiveKeepers(aggregates) {
  const candidates = aggregates.players
    .filter((p) => p.isKeeper && p.apps >= 1)
    .map((p) => ({
      playerId: p.playerId,
      name: p.name,
      photo: p.photo,
      teamId: p.teamId,
      teamName: p.teamName,
      teamLogo: p.teamLogo,
      conceded: p.conceded,
      saves: p.saves,
      appearances: p.apps,
      minutes: p.minutes,
    }));
  return rankKeepers(candidates);
}

async function fetchTopKeepers(query = {}) {
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

  let keepers, qualifyMinApps, capped = false, partial = false;
  if (isDemo) {
    ({ keepers, qualifyMinApps, capped, partial } = await fetchDemoKeepers(league, season, apiKey));
  } else {
    const aggregates = await fetchPlayerAggregates({ league, season, apiKey });
    ({ keepers, qualifyMinApps } = buildLiveKeepers(aggregates));
    partial = aggregates.partial;
  }

  return {
    ok: true,
    season,
    league,
    resolvedAs: isDemo ? 'demo-2022' : 'live',
    keepers,
    qualifyMinApps,   // appearances threshold applied (scales through the tournament)
    capped,           // true if the demo /players sweep hit MAX_PAGES
    partial,          // true if some pages/fixtures were dropped to rate-limiting
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchTopKeepers, DEFAULT_LEAGUE, DEFAULT_SEASON, DEMO_SEASON };
