/**
 * Match Live screen — live api-football via /api/match proxy (season 2026, league 1).
 *
 * URL params:
 *   ?fixture=855750   — specific fixture
 *   ?team=23          — Australia (default)
 *   ?season=2026      — default
 *   ?league=1         — FIFA World Cup
 *   ?demo=1           — force 2022 final demo fixture
 *   ?poll=N           — override poll interval in seconds (default: 5s when live, 5min otherwise)
 *   ?mode=demo        — start in demo scenario mode
 */

const DEMO_EVENTS = [
  { time: { elapsed: 23 }, team: { id: 26, name: 'Argentina' }, player: { name: 'Ángel Di María' }, assist: { name: 'Nahuel Molina' }, type: 'Goal', detail: 'Normal Goal', comments: null },
  { time: { elapsed: 36 }, team: { id: 26, name: 'Argentina' }, player: { name: 'Lionel Messi' }, assist: { name: null }, type: 'Goal', detail: 'Penalty', comments: null },
  { time: { elapsed: 41 }, team: { id: 2, name: 'France' }, player: { name: 'K. Mbappé' }, assist: { name: null }, type: 'Goal', detail: 'Penalty', comments: null },
  { time: { elapsed: 43 }, team: { id: 2, name: 'France' }, player: { name: 'K. Mbappé' }, assist: { name: null }, type: 'Goal', detail: 'Normal Goal', comments: null },
  { time: { elapsed: 52 }, team: { id: 26, name: 'Argentina' }, player: { name: 'Ángel Di María' }, assist: { name: 'Acuña' }, type: 'subst', detail: 'Substitution 1', comments: null },
  { time: { elapsed: 64 }, team: { id: 2, name: 'France' }, player: { name: 'M. Thuram' }, assist: { name: 'O. Giroud' }, type: 'subst', detail: 'Substitution 1', comments: null },
  { time: { elapsed: 89 }, team: { id: 26, name: 'Argentina' }, player: { name: 'G. Montiel' }, assist: { name: null }, type: 'Card', detail: 'Yellow Card', comments: 'Foul' },
  { time: { elapsed: 90 }, team: { id: 2, name: 'France' }, player: { name: 'K. Mbappé' }, assist: { name: null }, type: 'Goal', detail: 'Penalty', comments: null },
  { time: { elapsed: 90 }, team: { id: 2, name: 'France' }, player: { name: 'K. Mbappé' }, assist: { name: null }, type: 'Goal', detail: 'Normal Goal', comments: null },
  { time: { elapsed: 108 }, team: { id: 26, name: 'Argentina' }, player: { name: 'Lionel Messi' }, assist: { name: null }, type: 'Goal', detail: 'Normal Goal', comments: null },
  { time: { elapsed: 118 }, team: { id: 2, name: 'France' }, player: { name: 'K. Mbappé' }, assist: { name: null }, type: 'Goal', detail: 'Penalty', comments: null },
];

const DEMO_SNAPSHOTS = {
  h1_23: { elapsed: 23, period: 'First Half', scoreH: 1, scoreA: 0, possH: 46, possA: 54, shots: [3, 5], target: [2, 1], corners: [1, 2], fouls: [4, 3], eventCount: 1 },
  h1_36: { elapsed: 36, period: 'First Half', scoreH: 2, scoreA: 0, possH: 44, possA: 56, shots: [6, 9], target: [3, 2], corners: [2, 4], fouls: [7, 5], eventCount: 2 },
  halftime: { elapsed: 45, period: 'Half Time', scoreH: 2, scoreA: 0, possH: 43, possA: 57, shots: [7, 11], target: [3, 3], corners: [3, 5], fouls: [8, 7], eventCount: 2 },
  h2_80: { elapsed: 80, period: 'Second Half', scoreH: 2, scoreA: 1, possH: 42, possA: 58, shots: [10, 16], target: [4, 6], corners: [4, 7], fouls: [11, 10], eventCount: 6 },
  h2_90: { elapsed: 90, period: 'Second Half', scoreH: 2, scoreA: 2, possH: 42, possA: 58, shots: [12, 18], target: [5, 7], corners: [5, 8], fouls: [13, 11], eventCount: 9 },
  extra_time: { elapsed: 108, period: 'Extra Time', scoreH: 3, scoreA: 2, possH: 41, possA: 59, shots: [14, 20], target: [6, 8], corners: [5, 9], fouls: [13, 12], eventCount: 10 },
  full_time: { elapsed: 120, period: 'AET 3–3 · ARG win on pens', scoreH: 3, scoreA: 3, possH: 42, possA: 58, shots: [15, 22], target: [6, 9], corners: [5, 10], fouls: [13, 12], eventCount: 11 },
};

const DEMO_HOME = { id: 26, name: 'Argentina', logo: 'https://media.api-sports.io/football/teams/26.png' };
const DEMO_AWAY = { id: 2, name: 'France', logo: 'https://media.api-sports.io/football/teams/2.png' };

const params = new URLSearchParams(window.location.search);
const LIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 5 * 60_000;
const POLL_OVERRIDE_MS = params.get('poll')
  ? Math.max(2, Number(params.get('poll'))) * 1000
  : null;

let currentMode = params.get('mode') === 'demo' ? 'demo' : 'live';
let pollTimer = null;
let liveState = null;
let homeId = null;
let awayId = null;
let lastScoreH = null;
let lastScoreA = null;

function $(id) {
  return document.getElementById(id);
}

function buildDesc(ev) {
  if (ev.type === 'Goal') {
    if (ev.detail === 'Penalty') return 'Penalty';
    return ev.assist?.name ? `Assist: ${ev.assist.name}` : 'No assist';
  }
  if (ev.type === 'Card') return ev.comments || ev.detail;
  if (ev.type === 'subst') return ev.assist?.name ? `Off: ${ev.assist.name}` : 'Substitution';
  return ev.detail || '';
}

function eventSide(ev) {
  return ev.team.id === homeId ? 'home' : 'away';
}

function eventLabel(ev) {
  if (ev.type === 'Goal') return ev.detail === 'Penalty' ? 'GOAL (PEN)' : 'GOAL';
  if (ev.type === 'Card') return String(ev.detail || '').includes('Red') ? 'Red Card' : 'Yellow Card';
  if (ev.type === 'subst') return 'Sub';
  if (ev.type === 'Var') return 'VAR';
  return ev.type;
}

function formatClock(state) {
  const tick = state.extra ? `${state.elapsed}+${state.extra}` : String(state.elapsed);
  const showTick = !state.isFinished && state.period !== 'Half Time' && !String(state.period).includes('AET');
  return tick + (showTick ? "'" : '');
}

function renderFeed(events) {
  const feed = $('feed-card');
  const recent = [...(events || [])].reverse().slice(0, 5);
  feed.innerHTML = recent
    .map((ev, i) => {
      const side = eventSide(ev);
      const label = eventLabel(ev);
      const desc = buildDesc(ev);
      const min = ev.time.elapsed + (ev.time.extra ? `+${ev.time.extra}` : '') + "'";
      const isLast = i === recent.length - 1;
      return `<div class="feed-item${isLast ? ' last' : ''}">
      <div class="feed-top">
        <span class="feed-min">${min}</span>
        <span class="feed-type ${side}">${label}</span>
        <span class="feed-player ${side}">${ev.player?.name ?? '–'}</span>
      </div>
      <div class="feed-desc">${desc}</div>
    </div>`;
    })
    .join('');
}

function renderState(state) {
  homeId = state.home.id;
  awayId = state.away.id;

  $('score-home').textContent = state.scoreH ?? '–';
  $('score-away').textContent = state.scoreA ?? '–';
  $('match-clock').textContent = formatClock(state);
  $('match-period').textContent = state.period ?? '–';
  $('meta-group').textContent = state.metaGroup ?? '–';
  $('meta-venue').textContent = state.metaVenue ?? '–';
  $('name-home').textContent = (state.home.name || '').toUpperCase();
  $('name-away').textContent = (state.away.name || '').toUpperCase();

  setFlag($('flag-home'), state.home.name, state.home.logo);
  setFlag($('flag-away'), state.away.name, state.away.logo);

  $('poss-home').textContent = `${state.possH}%`;
  $('poss-away').textContent = `${state.possA}%`;
  $('poss-bar-home').style.width = `${state.possH}%`;

  const statRows = [
    ['shots', state.shots?.[0], state.shots?.[1]],
    ['target', state.target?.[0], state.target?.[1]],
    ['corners', state.corners?.[0], state.corners?.[1]],
    ['fouls', state.fouls?.[0], state.fouls?.[1]],
  ];
  statRows.forEach(([id, h, a]) => {
    $(`s-${id}-h`).textContent = h ?? '–';
    $(`s-${id}-a`).textContent = a ?? '–';
  });

  renderFeed(state.events);
}

function renderDemoScenario(key) {
  const s = DEMO_SNAPSHOTS[key];
  if (!s) return;
  homeId = DEMO_HOME.id;
  awayId = DEMO_AWAY.id;
  renderState({
    home: DEMO_HOME,
    away: DEMO_AWAY,
    scoreH: s.scoreH,
    scoreA: s.scoreA,
    elapsed: s.elapsed,
    extra: null,
    period: s.period,
    isFinished: s.period.includes('AET') || s.period === 'Half Time',
    metaGroup: 'Final',
    metaVenue: 'Lusail',
    possH: s.possH,
    possA: s.possA,
    shots: s.shots,
    target: s.target,
    corners: s.corners,
    fouls: s.fouls,
    events: DEMO_EVENTS.slice(0, s.eventCount),
  });
  setStatus(`Demo scenario · ${key}`);
}

function apiQuery() {
  const q = new URLSearchParams();
  if (params.get('fixture')) q.set('fixture', params.get('fixture'));
  if (params.get('team')) q.set('team', params.get('team'));
  if (params.get('season')) q.set('season', params.get('season'));
  if (params.get('league')) q.set('league', params.get('league'));
  if (params.get('demo')) q.set('demo', params.get('demo'));
  return q.toString();
}

async function fetchLive() {
  const qs = apiQuery();
  const url = `/api/match${qs ? `?${qs}` : ''}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function setStatus(msg, isError = false) {
  const el = $('api-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--color-red-bright, #f00)' : '#888';
}

// Find most recent goal scorer for a given team from events
function findScorer(events, teamId) {
  if (!events?.length) return '';
  const goals = [...events]
    .reverse()
    .filter(ev => ev.type === 'Goal' && ev.team?.id === teamId);
  return goals[0]?.player?.name ?? '';
}

// Notify parent carousel frame to show goal overlay
function notifyGoal(scorerText) {
  try {
    if (window.parent && window.parent !== window) {
      // Running inside carousel iframe
      window.parent.postMessage({ type: 'GOAL', scorer: scorerText }, '*');
    } else if (typeof window.triggerGoal === 'function') {
      // Running standalone (preview / direct open)
      window.triggerGoal(scorerText);
    }
  } catch (e) {
    console.warn('[match-live] notifyGoal failed:', e);
  }
}

async function refreshLive() {
  try {
    setStatus('Fetching…');
    liveState = await fetchLive();
    renderState(liveState);

    // ── Goal detection ─────────────────────────────────────────
    // On first poll, just store baseline scores — don't trigger.
    // On subsequent polls, detect any score increase.
    const newH = liveState.scoreH ?? 0;
    const newA = liveState.scoreA ?? 0;
    if (lastScoreH !== null && lastScoreA !== null && liveState.period !== 'Full Time') {
      if (newH > lastScoreH) {
        // Home team scored — find scorer from most recent goal event
        const scorer = findScorer(liveState.events, liveState.home.id);
        notifyGoal(`${scorer} scores for ${liveState.home.name}`);
      } else if (newA > lastScoreA) {
        // Away team scored
        const scorer = findScorer(liveState.events, liveState.away.id);
        notifyGoal(`${scorer} scores for ${liveState.away.name}`);
      }
    }
    lastScoreH = newH;
    lastScoreA = newA;
    const t = new Date(liveState.fetchedAt).toLocaleTimeString();
    const season = `season ${liveState.leagueSeason ?? '?'}`;
    const src = liveState.resolvedAs ? ` · ${liveState.resolvedAs}` : '';
    const cadence = liveState.isLive ? '5s' : '5min';
    setStatus(`Live · ${season} · #${liveState.fixtureId} · ${liveState.home.name} vs ${liveState.away.name}${src} · ${t} · poll ${cadence}`);
    return liveState;
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    console.error('[match-live]', err);
    return null;
  }
}

function nextPollDelay(data) {
  if (POLL_OVERRIDE_MS) return POLL_OVERRIDE_MS;
  if (!data) return IDLE_POLL_MS;
  return data.isLive ? LIVE_POLL_MS : IDLE_POLL_MS;
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function pollTick() {
  const data = await refreshLive();
  if (currentMode === 'live') {
    pollTimer = setTimeout(pollTick, nextPollDelay(data));
  }
}

function startPolling() {
  stopPolling();
  pollTick();
}

function setMode(mode) {
  currentMode = mode;
  const scenarioRow = $('scenario-row');
  const modeSelect = $('mode-select');
  if (modeSelect) modeSelect.value = mode;

  if (mode === 'live') {
    if (scenarioRow) scenarioRow.style.display = 'none';
    lastScoreH = null; // reset baseline so first poll doesn't false-trigger
    lastScoreA = null;
    startPolling();
  } else {
    stopPolling();
    if (scenarioRow) scenarioRow.style.display = 'flex';
    const key = $('scenario-select')?.value || 'h2_90';
    renderDemoScenario(key);
  }
}

function initControls() {
  $('mode-select')?.addEventListener('change', (e) => setMode(e.target.value));
  $('refresh-btn')?.addEventListener('click', () => {
    if (currentMode === 'live') refreshLive();
    else renderDemoScenario($('scenario-select')?.value || 'h2_90');
  });
  $('scenario-select')?.addEventListener('change', (e) => {
    if (currentMode === 'demo') renderDemoScenario(e.target.value);
  });
}

initControls();
setMode(currentMode);
