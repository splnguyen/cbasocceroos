const { getApiFootballKey } = require('./load-env');

const API_BASE = 'https://v3.football.api-sports.io';

// api-football's season player aggregates (/players, /players/topscorers) lag a
// whole fixture behind during matchdays — e.g. after France-Iraq the season rows
// still showed Mbappé on 1 appearance / 2 goals while the match itself was FT.
// The per-fixture endpoints (/fixtures, /fixtures/players) update right after a
// match, so we build the leaderboards ourselves by sweeping every PLAYED fixture
// and summing per-player goals / assists / saves / minutes. Goals-conceded for a
// keeper is derived from the FINAL SCORE (the per-fixture `conceded` field comes
// back null even on clean sheets), attributed to whoever kept goal that match.
const PLAYED = new Set(['FT', 'AET', 'PEN', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
const LIVE   = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);

const FIXTURE_CONCURRENCY = 3;        // api-football rejects rapid per-second bursts
const FIXTURE_RETRIES     = 3;
const MAX_FIXTURES        = 200;      // safety cap on the sweep
const CACHE_TTL_MS        = 60 * 1000; // aggregate cache; finished fixtures are memoised below

const _aggCache = new Map();          // `${league}:${season}` -> { ts, data }
// Finished fixtures never change, so memoise their per-player contributions and
// only re-fetch live ones each sweep. Keyed by fixture id.
const _fixtureCache = new Map();      // fixtureId -> { statusShort, contributions: [...] }

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

async function apiGetRetry(path, params, apiKey, tries = FIXTURE_RETRIES) {
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

// Build the per-player contributions for ONE fixture from /fixtures/players +
// the final score (passed in for keeper-conceded attribution).
function buildFixtureContributions(teamsResponse, scoreByTeamId) {
  const out = [];
  for (const block of teamsResponse || []) {
    const team = block.team || {};
    const concededByTeam = scoreByTeamId.get(team.id) ?? 0; // goals this team let in
    // Identify the keeper(s) who actually played; attribute the team's
    // goals-against to the one with the most minutes (keeper subs are rare).
    let topKeeper = null;
    for (const pl of block.players || []) {
      const st = (pl.statistics && pl.statistics[0]) || {};
      const pos = st.games?.position;
      const mins = st.games?.minutes ?? 0;
      if (pos === 'G' && mins > 0 && mins > (topKeeper?.mins ?? -1)) {
        topKeeper = { id: pl.player?.id, mins };
      }
    }
    for (const pl of block.players || []) {
      const p = pl.player || {};
      const st = (pl.statistics && pl.statistics[0]) || {};
      const mins = st.games?.minutes ?? 0;
      const isKeeper = st.games?.position === 'G';
      out.push({
        playerId: p.id ?? null,
        name: p.name || '–',
        photo: p.photo ?? null,
        teamId: team.id ?? null,
        teamName: team.name ?? '',
        teamLogo: team.logo ?? null,
        goals: st.goals?.total ?? 0,
        assists: st.goals?.assists ?? 0,
        saves: st.goals?.saves ?? 0,
        minutes: mins,
        played: mins > 0 ? 1 : 0,
        isKeeper,
        // Only the match's primary keeper carries the conceded tally.
        conceded: (isKeeper && topKeeper && p.id === topKeeper.id) ? concededByTeam : 0,
      });
    }
  }
  return out;
}

async function fixtureContributions(fixture, apiKey) {
  const id = fixture.id;
  const cached = _fixtureCache.get(id);
  // Finished fixtures are immutable — reuse. Live fixtures always re-fetch.
  if (cached && !LIVE.has(fixture.statusShort)) return cached.contributions;

  const json = await apiGetRetry('/fixtures/players', { fixture: id }, apiKey);
  const scoreByTeamId = new Map([
    [fixture.homeId, fixture.goalsAway ?? 0],   // home conceded = away goals
    [fixture.awayId, fixture.goalsHome ?? 0],
  ]);
  const contributions = buildFixtureContributions(json.response, scoreByTeamId);
  // Only memoise finished fixtures (live ones keep changing). Guard against the
  // narrow window where a fixture flips to FT before /fixtures/players has
  // populated — caching an empty result would drop its goals permanently (the
  // per-fixture cache has no TTL), so leave it uncached to re-fetch next sweep.
  if (!LIVE.has(fixture.statusShort) && contributions.length) {
    _fixtureCache.set(id, { statusShort: fixture.statusShort, contributions });
  }
  return contributions;
}

async function listPlayedFixtures(league, season, apiKey) {
  const json = await apiGetRetry('/fixtures', { league, season }, apiKey);
  return (json.response || [])
    .map((f) => ({
      id: f.fixture?.id,
      statusShort: f.fixture?.status?.short,
      homeId: f.teams?.home?.id,
      awayId: f.teams?.away?.id,
      goalsHome: f.goals?.home ?? 0,
      goalsAway: f.goals?.away ?? 0,
    }))
    .filter((f) => f.id && PLAYED.has(f.statusShort))
    .slice(0, MAX_FIXTURES);
}

// Sweep every played fixture and return a Map of playerId -> aggregated totals.
async function fetchPlayerAggregates({ league, season, apiKey }) {
  const cacheKey = `${league}:${season}`;
  const hit = _aggCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.data;

  if (!apiKey) apiKey = getApiFootballKey();

  const fixtures = await listPlayedFixtures(league, season, apiKey);

  // Bounded-concurrency sweep; tolerate a dropped fixture rather than failing.
  const agg = new Map();
  let next = 0;
  let dropped = 0;
  function merge(c) {
    if (!c.playerId) return;
    const cur = agg.get(c.playerId) || {
      playerId: c.playerId, name: c.name, photo: c.photo,
      teamId: c.teamId, teamName: c.teamName, teamLogo: c.teamLogo,
      goals: 0, assists: 0, saves: 0, conceded: 0, minutes: 0, apps: 0, isKeeper: false,
    };
    cur.goals += c.goals; cur.assists += c.assists; cur.saves += c.saves;
    cur.conceded += c.conceded; cur.minutes += c.minutes; cur.apps += c.played;
    if (c.isKeeper) cur.isKeeper = true;
    // Keep the most recent non-empty media/team (handles club→country shifts).
    if (c.photo) cur.photo = c.photo;
    if (c.teamName) { cur.teamName = c.teamName; cur.teamId = c.teamId; cur.teamLogo = c.teamLogo; }
    agg.set(c.playerId, cur);
  }
  async function worker() {
    while (next < fixtures.length) {
      const fx = fixtures[next++];
      try {
        const contributions = await fixtureContributions(fx, apiKey);
        contributions.forEach(merge);
      } catch (_) { dropped++; }
    }
  }
  const workers = Math.min(FIXTURE_CONCURRENCY, fixtures.length);
  await Promise.all(Array.from({ length: workers }, worker));

  const data = {
    players: Array.from(agg.values()),
    fixtures: fixtures.length,
    partial: dropped > 0,
    fetchedAt: new Date().toISOString(),
  };
  // Don't cache a partial sweep for the full TTL — let it retry sooner.
  _aggCache.set(cacheKey, { ts: data.partial ? Date.now() - (CACHE_TTL_MS - 15_000) : Date.now(), data });
  return data;
}

module.exports = { fetchPlayerAggregates };
