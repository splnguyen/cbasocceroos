const { getApiFootballKey } = require('./load-env');

const API_BASE = 'https://v3.football.api-sports.io';
const DEFAULT_LEAGUE = 1; // FIFA World Cup
const DEFAULT_SEASON = 2026;
const DEFAULT_TEAM = 26; // Australia

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);

function hasApiErrors(errs) {
  if (!errs) return false;
  if (Array.isArray(errs)) return errs.length > 0;
  if (typeof errs === 'object') return Object.keys(errs).length > 0;
  return Boolean(errs);
}

// ── Upstream rate-limit snapshot (from api-football response headers) ────────
// api-football returns: x-ratelimit-limit / -remaining   → per-MINUTE quota
//                       x-ratelimit-requests-limit / -remaining → per-DAY quota
let lastRateLimit = null;
function snapshotRateLimit(res) {
  const num = (h) => { const v = res.headers.get(h); return v == null || v === '' ? null : Number(v); };
  lastRateLimit = {
    perMinLimit:     num('x-ratelimit-limit'),
    perMinRemaining: num('x-ratelimit-remaining'),
    dayLimit:        num('x-ratelimit-requests-limit'),
    dayRemaining:    num('x-ratelimit-requests-remaining'),
    at: new Date().toISOString(),
  };
}
function getLastRateLimit() { return lastRateLimit; }

// ── Short-TTL upstream cache + single-flight ─────────────────────────────────
// Collapses the office-1/office-2/foundry-1 displays' near-simultaneous identical
// upstream calls into ONE request (single-flight), and reuses a fresh result for
// a few seconds (TTL). Keeps peak requests/min well under the api-football limit.
// Cache lives on the warm serverless instance (best-effort) — always correct,
// just fewer upstream hits. Live data uses a shorter TTL (see fetchLive) so the
// pre-kickoff ramp / live detection stay responsive.
const DEFAULT_TTL_MS = 8000;
const _cache = new Map();    // url -> { ts, json }
const _inflight = new Map(); // url -> Promise<json>

async function apiGet(path, params, apiKey, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const key = url.toString();

  const cached = _cache.get(key);
  if (cached && (Date.now() - cached.ts) < ttlMs) return cached.json;

  const pending = _inflight.get(key);
  if (pending) return pending; // single-flight: reuse the in-progress fetch

  const p = (async () => {
    const res = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
    snapshotRateLimit(res);
    const json = await res.json();
    if (!res.ok || hasApiErrors(json.errors)) {
      const msg = hasApiErrors(json.errors)
        ? Object.values(json.errors).join('; ')
        : `HTTP ${res.status}`;
      const err = new Error(msg);
      if (res.status === 429) err.code = 'RATE_LIMITED';
      throw err;
    }
    _cache.set(key, { ts: Date.now(), json });
    return json;
  })();

  _inflight.set(key, p);
  try { return await p; }
  finally { _inflight.delete(key); }
}

function periodLabel(short, long) {
  const map = {
    '1H': 'First Half',
    '2H': 'Second Half',
    HT: 'Half Time',
    ET: 'Extra Time',
    BT: 'Break Time',
    FT: 'Full Time',
    AET: 'AET',
    PEN: 'Penalties',
    NS: 'Not Started',
    LIVE: 'Live',
  };
  return map[short] || long || short || '–';
}

function parsePct(value) {
  if (value == null) return null;
  const n = parseInt(String(value).replace('%', ''), 10);
  return Number.isFinite(n) ? n : null;
}

function statValue(stats, type) {
  const row = stats?.find((s) => s.type === type);
  return row?.value ?? null;
}

function normalizeStatistics(homeId, awayId, statsResponse) {
  const homeStats = statsResponse?.find((s) => s.team.id === homeId)?.statistics ?? [];
  const awayStats = statsResponse?.find((s) => s.team.id === awayId)?.statistics ?? [];

  const possH = parsePct(statValue(homeStats, 'Ball Possession'));
  const possA = parsePct(statValue(awayStats, 'Ball Possession'));

  return {
    possH: possH ?? 50,
    possA: possA ?? 50,
    shots: [num(statValue(homeStats, 'Total Shots')), num(statValue(awayStats, 'Total Shots'))],
    target: [num(statValue(homeStats, 'Shots on Goal')), num(statValue(awayStats, 'Shots on Goal'))],
    corners: [num(statValue(homeStats, 'Corner Kicks')), num(statValue(awayStats, 'Corner Kicks'))],
    fouls: [num(statValue(homeStats, 'Fouls')), num(statValue(awayStats, 'Fouls'))],
    passes: [num(statValue(homeStats, 'Total passes')), num(statValue(awayStats, 'Total passes'))],
    // 'Passes %' comes through as a string like "89%" — keep it verbatim for display
    passAcc: [statValue(homeStats, 'Passes %'), statValue(awayStats, 'Passes %')],
    offsides: [num(statValue(homeStats, 'Offsides')), num(statValue(awayStats, 'Offsides'))],
    saves: [num(statValue(homeStats, 'Goalkeeper Saves')), num(statValue(awayStats, 'Goalkeeper Saves'))],
    // Expected goals — string like "0.42" (drives the live ticker's xG pulse).
    xg: [statValue(homeStats, 'expected_goals'), statValue(awayStats, 'expected_goals')],
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeEvents(events) {
  return (events ?? []).map((ev) => ({
    time: { elapsed: ev.time?.elapsed ?? 0, extra: ev.time?.extra ?? null },
    team: { id: ev.team?.id, name: ev.team?.name },
    player: { name: ev.player?.name ?? '–' },
    assist: ev.assist?.name ? { name: ev.assist.name } : { name: null },
    type: ev.type,
    detail: ev.detail,
    comments: ev.comments ?? null,
  }));
}

/**
 * Compute who won, taking into account penalty shootouts.
 *
 * api-football returns `goals.home/away` as regulation/AET goals only — for
 * matches decided on penalties (status PEN, e.g. 2022 Final ARG 3-3 FRA then
 * ARG 4-2 on pens) we have to look at `score.penalty.home/away` to know who
 * actually won, otherwise the screen renders a non-existent "Draw".
 */
function computeResult(rawFixture) {
  const status = rawFixture.fixture?.status?.short ?? null;
  const goals = rawFixture.goals || {};
  const pen = rawFixture.score?.penalty || {};
  const homeName = rawFixture.teams?.home?.name || 'Home';
  const awayName = rawFixture.teams?.away?.name || 'Away';

  if (status === 'PEN' && Number.isFinite(pen.home) && Number.isFinite(pen.away)) {
    const winner = pen.home > pen.away ? 'home' : 'away';
    const winName = winner === 'home' ? homeName : awayName;
    return {
      winner,
      decidedBy: 'PEN',
      penH: pen.home,
      penA: pen.away,
      resultLine: `${winName} wins ${pen.home}-${pen.away} on pens`,
    };
  }
  if (status === 'AET' && Number.isFinite(goals.home) && Number.isFinite(goals.away)) {
    const winner = goals.home > goals.away ? 'home' : goals.away > goals.home ? 'away' : 'draw';
    const winName = winner === 'home' ? homeName : winner === 'away' ? awayName : null;
    return {
      winner,
      decidedBy: 'AET',
      resultLine: winName ? `${winName} wins (AET)` : 'Draw (AET)',
    };
  }
  if (status === 'FT' && Number.isFinite(goals.home) && Number.isFinite(goals.away)) {
    const winner = goals.home > goals.away ? 'home' : goals.away > goals.home ? 'away' : 'draw';
    const winName = winner === 'home' ? homeName : winner === 'away' ? awayName : null;
    return {
      winner,
      decidedBy: 'FT',
      resultLine: winName ? `${winName} Wins` : 'Draw',
    };
  }
  return { winner: null, decidedBy: null, resultLine: null };
}

// ── Shared match-clock anchor ────────────────────────────────────────────────
// api-football gives the time in whole minutes only, so screens synthesise the
// seconds. To keep every display in sync, the server records when each new
// minute first appeared and hands that anchor to all displays, so they all
// count up from the SAME reference instead of from "when I personally saw it".
const _clockAnchors = new Map(); // fixtureId -> { minute, anchorMs }
function liveClockAnchor(fixtureId, minute, isLive) {
  if (!isLive || minute == null) return null;
  let rec = _clockAnchors.get(fixtureId);
  if (!rec || minute > rec.minute) {
    rec = { minute, anchorMs: Date.now() };
    _clockAnchors.set(fixtureId, rec);
  }
  return { minute: rec.minute, anchorMs: rec.anchorMs };
}

// ── Shared synthetic live ticker ─────────────────────────────────────────────
// api-football's events endpoint only carries goals/cards/subs/VAR, so during
// open play the feed would barely move. We synthesise "movement" (shots/corners/
// saves/fouls/offsides/possession) from the live statistics.
//
// STATELESS BY DESIGN: the list is derived from the ABSOLUTE stat totals on every
// request — no in-memory diff state. An earlier version diffed against a per-fixture
// `prev` kept in memory, but on serverless that state is per-instance: a cold start
// or a second warm instance would reset the baseline and silently swallow every
// stat recorded so far (e.g. a foul shows on the card but never reaches the feed),
// and different displays hitting different instances saw different feeds. Deriving
// from absolute totals with STABLE ids means every instance and every display
// produces the identical, complete list; the client dedupes on the id. Minutes are
// spread across the elapsed time so the items read as a timeline.
function liveTicker(fixtureId, isLive, elapsed, stats, homeName, awayName) {
  if (!isLive) return undefined;
  const E = Math.max(1, elapsed ?? 0);
  const pair = (n) => {
    const v = stats[n];
    return [Number.isFinite(v?.[0]) ? v[0] : 0, Number.isFinite(v?.[1]) ? v[1] : 0];
  };
  const shots = pair('shots'), target = pair('target'), corners = pair('corners');
  const saves = pair('saves'), fouls = pair('fouls'), offsides = pair('offsides');
  const name = (i) => (i === 0 ? homeName : awayName) || '';
  const CAP = 6; // keep only the most-recent N of each (side, type) in the payload

  const items = [];
  // For a stat that has occurred `total` times, emit the most recent CAP, each with
  // a stable id and a minute spread evenly across the elapsed time (newest ≈ now).
  const emit = (side, type, total) => {
    const T = Math.min(Math.max(0, total), 99);
    for (let k = Math.max(0, T - CAP); k < T; k++) {
      const minute = Math.max(1, Math.round((E * (k + 1)) / T));
      items.push({ id: `${side}:${type}:${k}`, min: `${minute}'`, minNum: minute * 100,
        side, type, who: side === 'home' ? name(0) : name(1) });
    }
  };

  for (const [side, i] of [['home', 0], ['away', 1]]) {
    emit(side, 'Shot on Target', target[i]);
    emit(side, 'Shot', shots[i] - target[i]);   // off-target attempts
    emit(side, 'Corner', corners[i]);
    emit(side, 'Save', saves[i]);
    emit(side, 'Foul', fouls[i]);
    emit(side, 'Offside', offsides[i]);
  }

  // Possession: one item per 5% bucket the home share has reached. Stable id per
  // bucket → no duplicates; skip ~47.5–52.5% as too even to be worth a row.
  const possH = Number.isFinite(stats.possH) ? stats.possH : 50;
  const bucket = Math.round(possH / 5);
  if (bucket !== 10) {
    const homeLead = possH >= 50;
    items.push({ id: `poss:${bucket}`, min: `${E}'`, minNum: E * 100,
      side: homeLead ? 'home' : 'away', type: 'Possession',
      who: `${name(homeLead ? 0 : 1)} ${homeLead ? possH : 100 - possH}%` });
  }

  return items;
}

function normalizeFixture(fixture, events, statistics) {
  const f = fixture;
  const home = f.teams.home;
  const away = f.teams.away;
  const goals = f.goals;
  const status = f.fixture.status;
  const stats = normalizeStatistics(home.id, away.id, statistics);
  const result = computeResult(f);

  let periodDisplay = periodLabel(status.short, status.long);
  if (status.short === 'HT') periodDisplay = 'Half Time';
  if (status.short === 'AET') periodDisplay = `AET ${goals.home}–${goals.away}`;
  if (status.short === 'PEN') periodDisplay = `Penalties ${result.penH}-${result.penA}`;
  if (status.short === 'P')   periodDisplay = 'Penalty Kick-Off';   // live shootout

  // Live penalty shootout (status 'P'): expose the running shootout tally from
  // score.penalty so the screen can show penalty-kick numbers per team. The big
  // scores stay the (tied) regulation/extra-time goals. Finished shootouts (PEN)
  // carry the final tally via computeResult above.
  const livePen = f.score?.penalty || {};
  const penH = status.short === 'P'
    ? (Number.isFinite(livePen.home) ? livePen.home : 0)
    : (result.penH ?? null);
  const penA = status.short === 'P'
    ? (Number.isFinite(livePen.away) ? livePen.away : 0)
    : (result.penA ?? null);

  // api-football's group-stage round is "Group Stage - N" where N is the MATCHDAY,
  // NOT the group — so the round cannot tell us the group letter (mapping it gives
  // e.g. matchday 2 → "Group B" for a Group E match). Emit a neutral "Group Stage"
  // here; fetchMatch fills in the real letter ("Group E") from /standings by team
  // id. Knockout rounds ("Round of 32", "Final", …) pass through unchanged.
  const leagueRound = f.league?.round ?? '';
  const metaGroup = /^Group Stage/i.test(leagueRound)
    ? 'Group Stage'
    : (leagueRound || f.league?.name || '–');

  return {
    fixtureId: f.fixture.id,
    home: { id: home.id, name: home.name, logo: home.logo },
    away: { id: away.id, name: away.name, logo: away.logo },
    scoreH: goals.home ?? 0,
    scoreA: goals.away ?? 0,
    penH,
    penA,
    winner: result.winner,           // 'home' | 'away' | 'draw' | null
    decidedBy: result.decidedBy,     // 'FT' | 'AET' | 'PEN' | null
    resultLine: result.resultLine,   // e.g. "Argentina wins 4-2 on pens"
    elapsed: status.elapsed ?? 0,
    extra: status.extra ?? null,
    period: periodDisplay,
    isFinished: ['FT', 'AET', 'PEN'].includes(status.short),
    isLive: LIVE_STATUS.has(status.short),
    // Server-anchored clock so every display ticks from the same reference.
    clock: liveClockAnchor(f.fixture.id, status.elapsed, LIVE_STATUS.has(status.short)),
    // Server-generated synthetic ticker so every display/reload shows the same feed.
    ticker: liveTicker(f.fixture.id, LIVE_STATUS.has(status.short), status.elapsed, stats, home.name, away.name),
    metaGroup,
    metaVenue: f.fixture.venue?.name ?? f.fixture.venue?.city ?? '–',
    ...stats,
    events: normalizeEvents(events),
    statusShort: status.short,
    statusLong: status.long,
    leagueId: f.league?.id,
    leagueSeason: f.league?.season,
    leagueName: f.league?.name,
    leagueRound,                     // "Group Stage - N" (matchday) | "Round of 32" | …
    source: 'api-football',
    fetchedAt: new Date().toISOString(),
  };
}

function isWcSeason(f, league, season) {
  return (
    f.league?.id === Number(league) &&
    Number(f.league?.season) === Number(season)
  );
}

function hasTeam(f, teamId) {
  return f.teams.home.id === Number(teamId) || f.teams.away.id === Number(teamId);
}

function isInPlay(f) {
  return LIVE_STATUS.has(f.fixture?.status?.short);
}

function pickFixtureId(f) {
  return String(f.fixture.id);
}

async function resolveFixtureId(query, apiKey) {
  if (query.demo === '1' || query.demo === 'true') {
    // Demo: by default, Argentina's last 2022 match = WC Final.
    // Honour ?team= / ?season= so the pair screen can request a different
    // companion (e.g. team=31 → Morocco's last = 2022 3rd-place playoff).
    const demoTeam = Number(query.team || 26);
    const demoSeason = Number(query.season || 2022);
    const demoJson = await apiGet('/fixtures', {
      league: 1, season: demoSeason, team: demoTeam, last: 1,
    }, apiKey);
    const demoFixture = demoJson.response?.[0];
    if (!demoFixture) throw new Error(`Could not resolve demo fixture (team=${demoTeam}, season=${demoSeason})`);
    const tag = demoTeam === 26 && demoSeason === 2022 ? 'demo-2022-final' : `demo-${demoSeason}-team-${demoTeam}`;
    return { fixtureId: pickFixtureId(demoFixture), resolvedAs: tag };
  }
  if (query.fixture) {
    return { fixtureId: String(query.fixture), resolvedAs: 'explicit-fixture' };
  }

  const team = Number(query.team || DEFAULT_TEAM);
  const season = Number(query.season || DEFAULT_SEASON);
  const league = Number(query.league || DEFAULT_LEAGUE);
  const wc = (f) => isWcSeason(f, league, season);

  // "Recently Completed" screen → the most recent FINISHED WC2026 match.
  // (Without this it would fall through to the live/today/next default and could
  // show a not-yet-played fixture as "Recently Completed".)
  if (query.status === 'finished') {
    const finJson = await apiGet('/fixtures', { league, season, status: 'FT-AET-PEN' }, apiKey, { ttlMs: 30000 });
    const finished = (finJson.response ?? [])
      .filter(wc)
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
    if (finished[0]) {
      return { fixtureId: pickFixtureId(finished[0]), resolvedAs: 'last-finished-wc2026' };
    }
    const err = new Error('No finished WC2026 fixture yet');
    err.code = 'NO_FINISHED_FIXTURE';
    throw err;
  }

  // 1. Live Australia match in WC 2026
  // Short TTL so the pre-kickoff ramp (5s) and live detection stay responsive,
  // while single-flight still collapses the displays' simultaneous polls.
  const liveJson = await apiGet('/fixtures', { live: 'all' }, apiKey, { ttlMs: 4000 });
  const liveList = (liveJson.response ?? []).filter(wc);
  const ausLive = liveList.find((f) => hasTeam(f, team));
  if (ausLive) {
    return { fixtureId: pickFixtureId(ausLive), resolvedAs: 'live-australia-wc2026' };
  }

  // 2. Any live WC 2026 match
  if (liveList[0]) {
    return { fixtureId: pickFixtureId(liveList[0]), resolvedAs: 'live-wc2026' };
  }

  // 3. Today's WC 2026 games (AUS preferred, any otherwise)
  const today = new Date().toISOString().slice(0, 10);
  const todayJson = await apiGet('/fixtures', { league, season, date: today }, apiKey);
  const todayList = todayJson.response ?? [];
  const ausToday = todayList.find((f) => hasTeam(f, team));
  if (ausToday) {
    return { fixtureId: pickFixtureId(ausToday), resolvedAs: 'today-australia-wc2026' };
  }
  if (todayList[0]) {
    return { fixtureId: pickFixtureId(todayList[0]), resolvedAs: 'today-wc2026' };
  }

  // 4. Next upcoming WC 2026 fixture (any team)
  const nextLeagueJson = await apiGet('/fixtures', { league, season, next: 1 }, apiKey);
  if (nextLeagueJson.response?.[0]) {
    return {
      fixtureId: pickFixtureId(nextLeagueJson.response[0]),
      resolvedAs: 'next-wc2026',
    };
  }

  throw new Error(
    `No ${season} fixture found. Use ?demo=1 for the 2022 demo, or ?fixture=<id> for a specific match.`,
  );
}

async function loadMatch(fixtureId, apiKey, opts = {}) {
  const calls = [
    apiGet('/fixtures', { id: fixtureId }, apiKey),
    apiGet('/fixtures/events', { fixture: fixtureId }, apiKey),
    apiGet('/fixtures/statistics', { fixture: fixtureId }, apiKey),
  ];
  if (opts.withPlayers) calls.push(apiGet('/fixtures/players', { fixture: fixtureId }, apiKey));

  const [fixtureJson, eventsJson, statsJson, playersJson] = await Promise.all(calls);

  const fixture = fixtureJson.response?.[0];
  if (!fixture) throw new Error(`Fixture ${fixtureId} not found`);

  const match = normalizeFixture(fixture, eventsJson.response ?? [], statsJson.response ?? []);
  if (opts.withPlayers) {
    match.topPerformers = pickTopPerformers(playersJson?.response ?? []);
  }
  return match;
}

/**
 * Pick the top 4 players across both teams from a /fixtures/players response.
 * Score = goals*5 + assists*3 + rating (api-football rating is 0-10 already).
 * Returns: [{ name, photo, teamId, teamName, goals, assists, rating, statLine }].
 */
function pickTopPerformers(teamsResponse) {
  const all = [];
  for (const t of teamsResponse) {
    for (const p of (t.players || [])) {
      const stats = p.statistics?.[0] || {};
      const minutes = Number(stats.games?.minutes) || 0;
      if (minutes < 1) continue;            // skip unused subs
      const goals = Number(stats.goals?.total) || 0;
      const assists = Number(stats.goals?.assists) || 0;
      const rating = parseFloat(stats.games?.rating) || 0;
      all.push({
        name: p.player?.name || '–',
        photo: p.player?.photo || null,
        teamId: t.team?.id ?? null,
        teamName: t.team?.name ?? '',
        goals,
        assists,
        rating,
        score: goals * 5 + assists * 3 + rating,
      });
    }
  }
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, 4).map((p) => {
    const parts = [];
    if (p.goals) parts.push(`${p.goals}G`);
    if (p.assists) parts.push(`${p.assists}A`);
    if (!parts.length && p.rating) parts.push(`${p.rating.toFixed(1)}★`);
    return {
      name: p.name,
      photo: p.photo,
      teamId: p.teamId,
      teamName: p.teamName,
      goals: p.goals,
      assists: p.assists,
      rating: p.rating || null,
      statLine: parts.join(', ') || '—',
    };
  });
}

function formatKickoffAEST(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '–';
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday').toUpperCase();
  const day = get('day');
  const month = get('month').toUpperCase();
  const hour = get('hour');
  const minute = get('minute');
  const period = get('dayPeriod').toUpperCase().replace(/\./g, '');
  return `${weekday} ${day} ${month} ${hour}:${minute}${period}`;
}

function parseStageGroup(round) {
  if (!round) return { stage: '–', group: null };
  // "Group Stage - N" is the matchday, NOT the group letter — so leave group null
  // and let callers resolve the real group from /standings by team id (see
  // fetchUpcoming / fetchUpcomingList). Mapping N→letter here would be wrong.
  if (/^Group Stage/i.test(round)) return { stage: 'Group Stage', group: null };
  return { stage: round, group: null };
}

function normalizeUpcomingFixture(f) {
  const { stage, group } = parseStageGroup(f.league?.round);
  return {
    fixtureId: f.fixture.id,
    kickoffISO: f.fixture.date,
    kickoffEpoch: new Date(f.fixture.date).getTime(),
    kickoffStr: formatKickoffAEST(f.fixture.date),
    stage,
    group,
    leagueRound: f.league?.round ?? null,
    leagueId: f.league?.id,
    leagueSeason: f.league?.season,
    leagueName: f.league?.name,
    venue: f.fixture.venue?.name ?? f.fixture.venue?.city ?? null,
    statusShort: f.fixture.status?.short ?? null,
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
  };
}

function normalizeStandingsGroup(groupArr) {
  const rows = (groupArr ?? []).map((t) => ({
    rank: t.rank,
    teamId: t.team?.id,
    name: t.team?.name,
    logo: t.team?.logo,
    played: t.all?.played ?? 0,
    win: t.all?.win ?? 0,
    draw: t.all?.draw ?? 0,
    loss: t.all?.lose ?? 0,
    goalsFor: t.all?.goals?.for ?? 0,
    goalsAgainst: t.all?.goals?.against ?? 0,
    goalDiff: typeof t.goalsDiff === 'number' ? t.goalsDiff : (t.all?.goals?.for ?? 0) - (t.all?.goals?.against ?? 0),
    points: t.points ?? 0,
  }));

  // Mathematical-elimination status per row (same rules as standings-service).
  const GROUP_MATCHES = 3;
  const allFinished = rows.every((t) => t.played >= GROUP_MATCHES);
  rows.forEach((t, i) => {
    if (allFinished) {
      t.status = t.rank != null && t.rank <= 2 ? 'qualified' : 'eliminated';
      return;
    }
    const maxT = t.points + 3 * (GROUP_MATCHES - t.played);
    let cantCatch = 0;
    let alreadyAhead = 0;
    for (let j = 0; j < rows.length; j++) {
      if (j === i) continue;
      const r = rows[j];
      const maxR = r.points + 3 * (GROUP_MATCHES - r.played);
      if (maxR < t.points) cantCatch++;
      if (r.points >= maxT) alreadyAhead++;
    }
    if (cantCatch >= 2) t.status = 'qualified';
    else if (alreadyAhead >= 2) t.status = 'eliminated';
    else t.status = 'contention';
  });

  return rows;
}

async function fetchUpcoming(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const team = query.team ? Number(query.team) : null;
  const season = Number(query.season || DEFAULT_SEASON);
  const league = Number(query.league || DEFAULT_LEAGUE);
  const debug = query.debug === '1' || query.debug === 'true';

  const attempts = [];
  let fixture = null;
  let resolvedAs = null;

  async function tryLookup(name, params) {
    try {
      const json = await apiGet('/fixtures', params, apiKey);
      const count = json.response?.length ?? 0;
      attempts.push({ name, params, results: count, errors: json.errors ?? null });
      return json.response?.[0] ?? null;
    } catch (err) {
      attempts.push({ name, params, error: err.message });
      return null;
    }
  }

  if (team) {
    fixture = await tryLookup('next-team-in-tournament', { team, season, league, next: 1 });
    if (fixture) resolvedAs = `next-team-${team}`;
  }

  if (!fixture) {
    fixture = await tryLookup('next-tournament', { league, season, next: 1 });
    if (fixture) resolvedAs = 'next-tournament';
  }

  if (!fixture && team) {
    fixture = await tryLookup('next-team-any-comp', { team, next: 1 });
    if (fixture) resolvedAs = `next-team-${team}-any-comp`;
  }

  if (!fixture) {
    const detail = attempts.map((a) => `${a.name}=${a.error ? `error(${a.error})` : `${a.results} results`}`).join('; ');
    const err = new Error(`No upcoming fixture found. Tried: ${detail}`);
    if (debug) err.debug = { attempts };
    throw err;
  }

  const fixtureData = normalizeUpcomingFixture(fixture);

  let standings = [];
  let standingsError = null;
  const fixtureLeague = fixture.league?.id ?? league;
  const fixtureSeason = fixture.league?.season ?? season;
  try {
    const standingsJson = await apiGet('/standings', { league: fixtureLeague, season: fixtureSeason }, apiKey);
    const groups = standingsJson.response?.[0]?.league?.standings ?? [];
    const homeId = fixture.teams.home.id;
    const awayId = fixture.teams.away.id;
    const groupArr = groups.find((g) => g.some((t) => t.team?.id === homeId || t.team?.id === awayId));
    if (groupArr) {
      standings = normalizeStandingsGroup(groupArr);
      // Override fixtureData.group with the real letter — api-football's
      // league.round = "Group Stage - N" is the matchday, not the group letter.
      const realGroup = String(groupArr[0]?.group || '').match(/Group\s+([A-L])/i);
      if (realGroup) fixtureData.group = `GROUP ${realGroup[1].toUpperCase()}`;
    }
  } catch (err) {
    standingsError = err.message;
  }

  const result = {
    ok: true,
    season,
    league,
    teamId: team,
    fixture: fixtureData,
    standings,
    standingsError,
    resolvedAs,
    source: 'api-football',
    fetchedAt: new Date().toISOString(),
  };
  if (debug) result.debug = { attempts, fixtureLeague, fixtureSeason };
  return result;
}

// Resolve the real group label ("Group E") for a fixture's teams from a
// /standings response. api-football's group-stage round is the matchday number,
// not the group, so the round can't be trusted — standings (team → group) is the
// source of truth. Returns null if neither team is found (e.g. knockout).
function groupFromStandings(standingsJson, homeId, awayId) {
  const groups = standingsJson?.response?.[0]?.league?.standings ?? [];
  const arr = groups.find((g) => g.some((t) => t.team?.id === homeId || t.team?.id === awayId));
  const m = String(arr?.[0]?.group || '').match(/Group\s+([A-L])/i);
  return m ? `Group ${m[1].toUpperCase()}` : null;
}

async function fetchMatch(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const { fixtureId, resolvedAs } = await resolveFixtureId(query, apiKey);
  const withPlayers = query.players === '1' || query.players === 'true';
  const match = await loadMatch(fixtureId, apiKey, { withPlayers });

  // Group-stage fixtures only carry the matchday in their round, so resolve the
  // real group letter from /standings by team id (cached + single-flighted by
  // apiGet, so live 10s polling stays cheap). On any failure the neutral
  // "Group Stage" from normalizeFixture stands — never a wrong letter.
  if (/^Group Stage/i.test(match.leagueRound || '')) {
    try {
      const standingsJson = await apiGet(
        '/standings',
        { league: match.leagueId || DEFAULT_LEAGUE, season: match.leagueSeason || DEFAULT_SEASON },
        apiKey,
      );
      const realGroup = groupFromStandings(standingsJson, match.home?.id, match.away?.id);
      if (realGroup) match.metaGroup = realGroup;
    } catch (_) { /* keep the neutral "Group Stage" fallback */ }
  }

  return {
    ok: true,
    season: Number(query.season) || DEFAULT_SEASON,
    league: Number(query.league) || DEFAULT_LEAGUE,
    resolvedAs,
    ...match,
  };
}

/**
 * Brief shape for one live fixture — just what the carousel controller needs
 * to decide single vs dual live, and to pin primary/secondary on the pair
 * screen (via ?fixture / ?other).
 */
function liveFixtureBrief(f, team) {
  return {
    fixtureId: f.fixture.id,
    statusShort: f.fixture.status?.short ?? null,
    kickoffEpoch: new Date(f.fixture.date).getTime(),
    hasAUS: hasTeam(f, team),
    leagueRound: f.league?.round ?? null,
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
  };
}

// Stable ordering: Australia's match first, then earliest kickoff, then id.
function sortLiveFixtures(a, b) {
  if (a.hasAUS !== b.hasAUS) return a.hasAUS ? -1 : 1;
  if (a.kickoffEpoch !== b.kickoffEpoch) return a.kickoffEpoch - b.kickoffEpoch;
  return a.fixtureId - b.fixtureId;
}

/**
 * List currently-live WC 2026 fixtures so the office carousel can pick its
 * state (no-live → rotate screens; 1 live → single live screen; 2+ live →
 * dual live screen). Single `/fixtures?live=all` call.
 *
 * Testing aid: `?simulate=0|1|2` forces a live-match count using 2022
 * fixtures (Argentina final, Morocco 3rd-place playoff) so the state machine
 * can be exercised before the tournament starts.
 */
async function fetchLive(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const league = Number(query.league || DEFAULT_LEAGUE);
  const season = Number(query.season || DEFAULT_SEASON);
  const team = Number(query.team || DEFAULT_TEAM);

  if (query.simulate != null) {
    const n = Math.max(0, Math.min(2, Number(query.simulate) || 0));
    const demoTeams = [26, 31]; // Argentina (2022 final), Morocco (3rd-place playoff)
    const fixtures = [];
    for (let i = 0; i < n; i++) {
      const j = await apiGet('/fixtures', { league: 1, season: 2022, team: demoTeams[i], last: 1 }, apiKey);
      const f = j.response?.[0];
      if (f) fixtures.push(liveFixtureBrief(f, team));
    }
    return {
      ok: true,
      count: fixtures.length,
      fixtures,
      resolvedAs: `simulate-${n}`,
      fetchedAt: new Date().toISOString(),
    };
  }

  // Short TTL so the pre-kickoff ramp (5s) and live detection stay responsive,
  // while single-flight still collapses the displays' simultaneous polls.
  const liveJson = await apiGet('/fixtures', { live: 'all' }, apiKey, { ttlMs: 4000 });
  const liveList = (liveJson.response ?? []).filter(
    (f) => isWcSeason(f, league, season) && isInPlay(f),
  );
  const fixtures = liveList.map((f) => liveFixtureBrief(f, team)).sort(sortLiveFixtures);
  return {
    ok: true,
    count: fixtures.length,
    fixtures,
    resolvedAs: 'live-wc2026',
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchUpcomingList(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  // Demo: 2022 WC fixtures (pretend tournament hasn't started yet — clients
  // can pin a reference date to make countdowns sensible). Live: WC 2026.
  const isDemo = query.demo === '1' || query.demo === 'true';
  const league = Number(query.league || DEFAULT_LEAGUE);
  const season = isDemo ? 2022 : Number(query.season || DEFAULT_SEASON);
  const count = Math.max(1, Math.min(20, Number(query.count || 5)));

  // For 2026 (pre-tournament): all fixtures are NS, so /fixtures?next=N works.
  // For 2022 (demo): all fixtures are FT — use /fixtures?league&season and
  // take the first N by chronological order so countdowns are well-defined.
  // Fetch standings in parallel so we can attach the real group letter
  // (api-football's fixture.league.round is "Group Stage - N" matchday, not
  // the group letter — we look that up via team→group from /standings).
  // Optional ?round=<name> filter (e.g. "Round of 32"); for demo we pull all
  // and filter client-side.
  // status=finished → "Latest Matches / Recently Completed": the most-recent
  // FINISHED fixtures, newest first. Without this the live path falls back to
  // ?next=count (upcoming only), so the results screen filters to nothing.
  const wantFinished = query.status === 'finished';
  const roundFilter = query.round || null;
  const fixturesPromise = isDemo
    ? apiGet('/fixtures', { league, season }, apiKey)        // 2022: all fixtures are FT
    : wantFinished
      ? apiGet('/fixtures', { league, season, status: 'FT-AET-PEN' }, apiKey)
      : roundFilter
        ? apiGet('/fixtures', { league, season, round: roundFilter }, apiKey)
        : apiGet('/fixtures', { league, season, next: count }, apiKey);
  const standingsPromise = apiGet('/standings', { league, season }, apiKey).catch(() => null);

  const [fixturesJson, standingsJson] = await Promise.all([fixturesPromise, standingsPromise]);

  let response = fixturesJson.response ?? [];
  if (wantFinished) {
    // Newest finished first, then take `count`. Works for demo (all FT) and live
    // alike; the FT/AET/PEN filter guards demo's mixed list defensively.
    response = response
      .filter((f) => ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short))
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, count);
  } else if (isDemo) {
    // For demo + roundFilter, narrow to the requested round first.
    if (roundFilter) {
      response = response.filter((f) => f.league?.round === roundFilter);
    }
    response = response
      .slice()
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))
      .slice(0, count);
  } else if (roundFilter) {
    // Live with roundFilter: api-football already returned only that round.
    response = response.slice(0, count);
  }

  // Attach final score + winner when available (FT/AET/PEN for recap screens).
  function attachStatus(json, raw) {
    const result = computeResult(raw);
    json.statusShort = raw.fixture.status?.short ?? null;
    json.scoreH = raw.goals?.home ?? null;
    json.scoreA = raw.goals?.away ?? null;
    json.penH = result.penH ?? null;
    json.penA = result.penA ?? null;
    json.winner = result.winner;        // 'home' | 'away' | 'draw' | null
    json.decidedBy = result.decidedBy;
    json.resultLine = result.resultLine;
    json.isFinished = ['FT', 'AET', 'PEN'].includes(json.statusShort);
    return json;
  }

  // teamId → group letter map (e.g. 16 → 'A')
  const teamGroup = new Map();
  const rawGroups = standingsJson?.response?.[0]?.league?.standings ?? [];
  for (const group of rawGroups) {
    for (const t of group) {
      const m = String(t.group || '').match(/Group\s+([A-L])/i);
      if (m && t.team?.id) teamGroup.set(t.team.id, m[1].toUpperCase());
    }
  }

  const matches = response.map((f) => {
    const fix = attachStatus(normalizeUpcomingFixture(f), f);
    const groupLetter = teamGroup.get(f.teams.home.id) || teamGroup.get(f.teams.away.id) || null;
    if (groupLetter) fix.group = `GROUP ${groupLetter}`;
    return fix;
  });

  return {
    ok: true,
    season,
    league,
    count: matches.length,
    resolvedAs: isDemo ? 'demo-2022' : 'live',
    matches,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchMatch, fetchLive, fetchUpcoming, fetchUpcomingList, getApiFootballKey, getLastRateLimit, liveTicker, DEFAULT_SEASON, DEFAULT_LEAGUE };
