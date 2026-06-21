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
 * WC2026 advances the top 2 of each group PLUS the 8 best third-placed teams, so
 * "out of the top 2" is NOT elimination — a 3rd-place team keeps a best-third
 * lifeline. Only a team locked into 4th is unconditionally out, which makes it
 * structurally impossible for two teams in one group to be eliminated.
 *   qualified  → guaranteed a top-2 finish in EVERY remaining-result scenario
 *   eliminated → guaranteed 4th (last) in every scenario
 *   else       → contention
 *
 * The status is decided by enumerating every possible outcome (W/D/L) of the
 * group's *actual* remaining fixtures — not a per-rival points ceiling. This
 * matters when two chasers play each other: e.g. if AUS and PAR (both 3 pts)
 * meet on the final day, they can't BOTH reach 6, so a 6-pt leader is already
 * safe. A ceiling-only model can't see that constraint and understates safety.
 *
 * Ties on points are resolved adversarially (we assume tiebreakers go against
 * the team), so a side that's safe only on goal difference shows `contention`,
 * never a false `qualified`. Best-third elimination would need cross-group math
 * and is not modelled here.
 */

// Enumerate every W/D/L combination of `remaining` ([idA, idB] pairs) on top of
// the current points, and classify each team by its worst/best reachable rank.
function computeStatusesByFixtures(teams, remaining) {
  const failsTop2 = new Set();  // team not guaranteed top-2 in ≥1 scenario
  const canAvoidLast = new Set(); // team can finish 3rd-or-better in ≥1 scenario
  const scenarios = 3 ** remaining.length;

  for (let mask = 0; mask < scenarios; mask++) {
    const pts = new Map(teams.map((t) => [t.teamId, t.pts]));
    let m = mask;
    for (const [a, b] of remaining) {
      const outcome = m % 3; m = Math.floor(m / 3);
      if (outcome === 0) pts.set(a, pts.get(a) + 3);            // a wins
      else if (outcome === 1) pts.set(b, pts.get(b) + 3);       // b wins
      else { pts.set(a, pts.get(a) + 1); pts.set(b, pts.get(b) + 1); } // draw
    }
    for (const t of teams) {
      const p = pts.get(t.teamId);
      let greater = 0, equal = 0;
      for (const r of teams) {
        if (r === t) continue;
        const rp = pts.get(r.teamId);
        if (rp > p) greater++; else if (rp === p) equal++;
      }
      // Worst case: every team tied on points is ranked above us. Best case: none are.
      if (greater + equal + 1 > 2) failsTop2.add(t.teamId);
      if (greater + 1 < 4) canAvoidLast.add(t.teamId);
    }
  }

  return teams.map((t) => {
    if (!failsTop2.has(t.teamId)) return 'qualified';   // top-2 in every scenario
    if (!canAvoidLast.has(t.teamId)) return 'eliminated'; // last in every scenario
    return 'contention';
  });
}

// Fallback when remaining fixtures are unavailable (API hiccup): conservative
// per-rival points ceiling. Never a false positive, just less precise than the
// fixture-aware path (it can't see that two chasers play each other).
function computeStatusesByCeiling(teams) {
  return teams.map((t) => {
    const maxT = t.pts + 3 * (GROUP_MATCHES - t.mp);
    let cantCatch = 0, alreadyAhead = 0;
    for (const r of teams) {
      if (r === t) continue;
      const maxR = r.pts + 3 * (GROUP_MATCHES - r.mp);
      if (maxR < t.pts) cantCatch++;
      if (r.pts >= maxT) alreadyAhead++;
    }
    if (cantCatch >= 2) return 'qualified';
    if (alreadyAhead >= 3) return 'eliminated';
    return 'contention';
  });
}

function computeStatuses(teams, remaining) {
  const allFinished = teams.every((t) => t.mp >= GROUP_MATCHES);
  if (allFinished) {
    // Group done → defer to api-football's `rank` (it applies the real WC tiebreakers).
    return teams.map((t) => (t.rank != null && t.rank <= 2 ? 'qualified' : 'eliminated'));
  }
  // Mid-tournament but no fixtures resolved → don't risk a false "qualified" from
  // an empty scenario set; fall back to the conservative ceiling model.
  if (!remaining || remaining.length === 0) return computeStatusesByCeiling(teams);
  return computeStatusesByFixtures(teams, remaining);
}

const FINISHED_STATUS = new Set(['FT', 'AET', 'PEN']);

// Recompute a group's table from its actual finished results, so it never lags
// api-football's precomputed /standings (whose `update` timestamp can sit hours
// behind a match that has already gone FT — the table would otherwise show e.g.
// MP1 with no head-to-head for two teams whose result we're displaying).
function recomputeRowsFromResults(teams, ftFixtures) {
  const byId = new Map(teams.map((t) => [t.teamId, t]));
  for (const t of teams) { t.mp = 0; t.w = 0; t.d = 0; t.l = 0; t.gf = 0; t.ga = 0; t.pts = 0; }
  for (const f of ftFixtures) {
    const h = byId.get(f.teams?.home?.id);
    const a = byId.get(f.teams?.away?.id);
    if (!h || !a) continue;
    const gh = f.goals?.home, ga = f.goals?.away;
    if (gh == null || ga == null) continue; // FT but no score yet → don't count
    h.mp++; a.mp++;
    h.gf += gh; h.ga += ga; a.gf += ga; a.ga += gh;
    if (gh > ga) { h.w++; h.pts += 3; a.l++; }
    else if (gh < ga) { a.w++; a.pts += 3; h.l++; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  for (const t of teams) t.gd = t.gf - t.ga;
  // Rank by points → goal difference → goals-for → name. api-football's full WC
  // tiebreaker chain (head-to-head, fair-play, drawing of lots) isn't reproduced;
  // ordering only diverges when teams are level on all three, which is rare and
  // self-corrects once /standings catches up. The clients re-sort by these same
  // keys anyway, so the rendered order matches.
  teams.sort((x, y) => (y.pts - x.pts) || (y.gd - x.gd) || (y.gf - x.gf) || x.name.localeCompare(y.name));
  teams.forEach((t, i) => (t.rank = i + 1));
  return teams;
}

function shapeGroup(letter, rawTeams, allFixtures = [], haveFixtures = false) {
  let teams = rawTeams.map(normaliseTeam);
  const ids = new Set(teams.map((t) => t.teamId));
  let remaining = [];
  if (haveFixtures) {
    // This group's fixtures = those whose BOTH teams sit in it (the round string
    // is the matchday, not the group letter, so we map via the team-ID set).
    const inGroup = allFixtures.filter((f) => ids.has(f.teams?.home?.id) && ids.has(f.teams?.away?.id));
    teams = recomputeRowsFromResults(teams, inGroup.filter((f) => FINISHED_STATUS.has(f.fixture?.status?.short)));
    remaining = inGroup
      .filter((f) => f.fixture?.status?.short === 'NS')
      .map((f) => [f.teams.home.id, f.teams.away.id]);
  }
  // Without fixtures we keep api-football's (possibly stale) precomputed rows and
  // its rank order, and computeStatuses degrades to the conservative ceiling model.
  const statuses = computeStatuses(teams, remaining);
  teams.forEach((t, i) => (t.status = statuses[i]));
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

  // Pull all group-stage fixtures so each group's table is recomputed from its
  // actual finished results (fresh, never lagging /standings) and status can
  // enumerate the real remaining matchups. Best-effort: if this call fails,
  // shapeGroup keeps api-football's precomputed rows + ceiling-model statuses.
  let allFixtures = [];
  let haveFixtures = false;
  try {
    const fxJson = await apiGet('/fixtures', { league, season }, apiKey);
    allFixtures = fxJson.response ?? [];
    haveFixtures = true;
  } catch (e) {
    allFixtures = [];
    haveFixtures = false;
  }

  const groups = [];
  for (const raw of rawGroups) {
    if (!raw || !raw.length) continue;
    const letter = normaliseGroupLetter(raw[0].group) || normaliseGroupLetter(raw[0]?.description);
    if (!letter) continue;            // skip rows we can't place
    groups.push(shapeGroup(letter, raw, allFixtures, haveFixtures));
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
