const { getApiFootballKey } = require('./load-env');

const API_BASE = 'https://v3.football.api-sports.io';
const DEFAULT_LEAGUE = 1;       // FIFA World Cup
const DEFAULT_SEASON = 2026;    // tournament season
const DEMO_SEASON   = 2022;     // 2022 WC = finished, full GK table (E. Martínez golden glove)
const MAX_KEEPERS   = 20;       // cap the payload; screens slice to what they show
const MAX_PAGES     = 60;       // safety cap on the /players sweep
const PAGE_CONCURRENCY = 3;     // gentle: api-football rejects rapid bursts (per-second)
const PAGE_RETRIES  = 3;        // retry a rate-limited page with backoff before giving up
const MIN_APPEARANCES  = 1;     // fairness guard: ignore keepers who haven't played
const CACHE_TTL_MS  = 30 * 60 * 1000; // the GK table moves slowly; sweep is expensive

// api-football has NO "top keepers" endpoint (only topscorers/topassists/top*cards),
// so we build the Golden Glove board ourselves: page the whole /players list for the
// league+season, keep position === "Goalkeeper", and rank by fewest goals conceded.
// The sweep is many calls, so results are cached per league+season (best-effort,
// warm-instance only — same caveat as the live clock/ticker).
const _cache = new Map();       // `${league}:${season}` -> { ts, data }

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
function isRateLimited(err) {
  return /too many requests|exceeded the limit/i.test(err?.message || '');
}
// Wrap apiGet with backoff retries when the API rejects a burst (429-style).
async function apiGetRetry(path, params, apiKey, tries = PAGE_RETRIES) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await apiGet(path, params, apiKey); }
    catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;   // only retry rate-limit errors
      await sleep(500 * (i + 1));            // 500ms, 1000ms, …
    }
  }
  throw lastErr;
}

function isGoalkeeper(s) {
  return String(s?.games?.position || '').toLowerCase() === 'goalkeeper';
}

// Returns a normalised keeper, or null if the player never kept goal / hasn't played.
function normaliseKeeper(entry) {
  const p = entry.player || {};
  const gkRows = (entry.statistics || []).filter(isGoalkeeper);
  if (!gkRows.length) return null;
  // Prefer the GK line with the most minutes (national-team row for the tournament).
  const stats = gkRows.reduce((best, s) => {
    const m = s?.games?.minutes ?? 0;
    return m >= (best?.games?.minutes ?? -1) ? s : best;
  }, gkRows[0]);

  const appearances = stats.games?.appearences ?? 0;
  if (appearances < MIN_APPEARANCES) return null;

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

// Page through /players for the league+season, with bounded concurrency.
async function sweepPlayers(league, season, apiKey) {
  // Page 1 determines the page count — retry hard here (a failure aborts the whole sweep).
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
      } catch (err) {
        // Tolerate a lost page (e.g. persistent rate-limit): return a partial board
        // rather than failing the whole request. Flagged via `partial` below.
        skipped++;
      }
    }
  }
  const workerCount = Math.min(PAGE_CONCURRENCY, Math.max(0, totalPages - 1));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return { players: all, capped: reportedPages > MAX_PAGES, partial: skipped > 0 };
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

  const cacheKey = `${league}:${season}`;
  const cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

  const { players, capped, partial } = await sweepPlayers(league, season, apiKey);
  const candidates = players.map(normaliseKeeper).filter(Boolean);

  // Fairness gate: raw "fewest conceded" would crown a keeper who played one match
  // (or 10 minutes) over a tournament-long starter. The Golden Glove only means
  // something for keepers who actually played, so qualify on a minimum number of
  // appearances that SCALES with the tournament: 60% of the most-played keeper's
  // appearances (early on this is ~1; by the final it's ~5 — i.e. genuine #1s only).
  const maxApps = candidates.reduce((m, k) => Math.max(m, k.appearances), 0);
  const qualifyMinApps = Math.max(1, Math.ceil(maxApps * 0.6));

  const keepers = candidates
    .filter((k) => k.appearances >= qualifyMinApps)
    // Golden Glove: fewest conceded wins. Tie-breaks reward the keeper who did it
    // over more minutes, then made more saves.
    .sort((a, b) => a.conceded - b.conceded || b.minutes - a.minutes || b.saves - a.saves)
    .slice(0, MAX_KEEPERS)
    .map((k, i) => ({ rank: i + 1, ...k }));

  const data = {
    ok: true,
    season,
    league,
    resolvedAs: isDemo ? 'demo-2022' : 'live',
    keepers,
    qualifyMinApps,   // appearances threshold applied (scales through the tournament)
    capped,           // true if the /players sweep hit MAX_PAGES (board may be partial)
    partial,          // true if some pages were dropped to rate-limiting (board may be partial)
    fetchedAt: new Date().toISOString(),
  };
  // Don't cache a partial board for the full TTL — let it re-sweep sooner.
  _cache.set(cacheKey, { ts: partial ? Date.now() - (CACHE_TTL_MS - 60_000) : Date.now(), data });
  return data;
}

module.exports = { fetchTopKeepers, DEFAULT_LEAGUE, DEFAULT_SEASON, DEMO_SEASON };
