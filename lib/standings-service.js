const { getApiFootballKey } = require('./load-env');

const API_BASE = 'https://v3.football.api-sports.io';
const DEFAULT_LEAGUE = 1;       // FIFA World Cup
const DEFAULT_SEASON = 2026;
const DEMO_SEASON   = 2022;     // 2022 WC = always finished, full standings
const GROUP_MATCHES = 3;        // each team plays 3 group fixtures

const GROUP_LETTER = {
  '1':'A','2':'B','3':'C','4':'D','5':'E','6':'F',
  '7':'G','8':'H','9':'I','10':'J','11':'K','12':'L',
};

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

// api-football returns the group either as "Group A" or "Group Stage - 1"
function normaliseGroupLetter(raw) {
  if (!raw) return null;
  const m1 = raw.match(/Group Stage\s*-\s*(\d+)/i);
  if (m1) return GROUP_LETTER[m1[1]] ?? null;
  const m2 = raw.match(/Group\s+([A-L])/i);
  if (m2) return m2[1].toUpperCase();
  return null;
}

function normaliseTeam(t) {
  const played = t.all?.played ?? 0;
  const win    = t.all?.win ?? 0;
  const draw   = t.all?.draw ?? 0;
  const loss   = t.all?.lose ?? 0;
  const gf     = t.all?.goals?.for ?? 0;
  const ga     = t.all?.goals?.against ?? 0;
  return {
    rank: t.rank ?? null,
    teamId: t.team?.id ?? null,
    name: t.team?.name ?? '',
    logo: t.team?.logo ?? null,
    mp: played,
    w: win,
    d: draw,
    l: loss,
    gf,
    ga,
    gd: typeof t.goalsDiff === 'number' ? t.goalsDiff : gf - ga,
    pts: t.points ?? 0,
  };
}

/**
 * Status per team: 'qualified' | 'contention' | 'eliminated'.
 *
 * If every team has played all 3 matches, defer to api-football's `rank`
 * (it already applies the WC tiebreakers we'd otherwise have to re-implement).
 * Mid-tournament we use pure mathematical elimination:
 *   qualified  → ≥ 2 rivals can no longer catch this team
 *   eliminated → ≥ 2 rivals already exceed this team's max-possible points
 *   else       → contention
 */
function computeStatuses(teams) {
  const allFinished = teams.every((t) => t.mp >= GROUP_MATCHES);
  if (allFinished) {
    return teams.map((t) => (t.rank != null && t.rank <= 2 ? 'qualified' : 'eliminated'));
  }
  return teams.map((t) => {
    const maxT = t.pts + 3 * (GROUP_MATCHES - t.mp);
    let cantCatch = 0;
    let alreadyAhead = 0;
    for (const r of teams) {
      if (r === t) continue;
      const maxR = r.pts + 3 * (GROUP_MATCHES - r.mp);
      if (maxR < t.pts) cantCatch++;
      if (r.pts >= maxT) alreadyAhead++;
    }
    if (cantCatch >= 2) return 'qualified';
    if (alreadyAhead >= 2) return 'eliminated';
    return 'contention';
  });
}

function shapeGroup(letter, rawTeams) {
  const teams = rawTeams.map(normaliseTeam);
  const statuses = computeStatuses(teams);
  teams.forEach((t, i) => (t.status = statuses[i]));
  // api-football already returns teams in rank order — preserve it.
  return { letter, teams };
}

async function fetchStandings(query = {}) {
  const apiKey = getApiFootballKey();
  if (!apiKey) {
    const err = new Error(
      'API_FOOTBALL_KEY is not set. Add it to .env.local (as API_FOOTBALL_KEY=your_key) or Vercel environment variables.',
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  const isDemo  = query.demo === '1' || query.demo === 'true';
  const league  = Number(query.league || DEFAULT_LEAGUE);
  const season  = isDemo ? DEMO_SEASON : Number(query.season || DEFAULT_SEASON);

  const json = await apiGet('/standings', { league, season }, apiKey);
  const rawGroups = json.response?.[0]?.league?.standings ?? [];

  const groups = [];
  for (const raw of rawGroups) {
    if (!raw || !raw.length) continue;
    const letter = normaliseGroupLetter(raw[0].group) || normaliseGroupLetter(raw[0]?.description);
    if (!letter) continue;            // skip rows we can't place
    groups.push(shapeGroup(letter, raw));
  }
  groups.sort((a, b) => a.letter.localeCompare(b.letter));

  return {
    ok: true,
    season,
    league,
    resolvedAs: isDemo ? 'demo-2022' : 'live',
    groups,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { fetchStandings, DEFAULT_LEAGUE, DEFAULT_SEASON, DEMO_SEASON };
