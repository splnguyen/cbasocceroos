/**
 * Match Live renderer — drives the single and pair screens off /api/match.
 *
 * Single screen (`screen-matchlive.html`):
 *   default → resolve next/current Socceroos fixture
 *   ?demo=1 → 2022 WC Final (ARG vs FRA)
 *
 * Pair screen (`screen-matchlivepair.html`, body[data-pair="1"]):
 *   primary = same resolution as single
 *   secondary = ?other=<fixtureId>     (live)
 *             = 2022 3rd-place playoff (CRO vs MAR)  (demo)
 *
 * URL params (both screens):
 *   ?fixture=<id>   pin a specific fixture
 *   ?team=<id>      override team for resolution
 *   ?season=<yyyy>  override season
 *   ?demo=1         force demo lookup
 *   ?other=<id>     pair-screen secondary fixture
 *   ?poll=<sec>     override poll interval (min 2)
 */

(function () {
  const params = new URLSearchParams(location.search);
  // Screen-level defaults (e.g. a pinned fixture) may be set via
  // window.SCREEN_CONFIG before this script loads. URL params override them,
  // so ?fixture=/?demo=1/etc. still work for ad-hoc testing.
  const cfg = (typeof window !== 'undefined' && window.SCREEN_CONFIG) || {};
  const P = (k) => (params.has(k) ? params.get(k) : (cfg[k] != null ? String(cfg[k]) : null));
  const isPair = document.body.dataset.pair === '1';

  // Per CLAUDE.md / context/api-football.md: 1 call/min when live, slower otherwise.
  const LIVE_POLL_MS = 60_000;
  const IDLE_POLL_MS = 5 * 60_000;
  const POLL_OVERRIDE_MS = P('poll')
    ? Math.max(2, Number(P('poll'))) * 1000
    : null;

  const $ = (id) => document.getElementById(id);

  // ── Score / state for goal detection ─────────────────────────────────────
  let lastScoreH = null;
  let lastScoreA = null;
  let homeId = null;
  let awayId = null;

  // ── Match clock (mm:ss, ticks locally between API polls) ─────────────────
  // api-football gives `elapsed` in whole minutes only, so we synthesise the
  // seconds locally: record the minute + a timestamp, then count up every sec.
  let clockBaseMin = null;   // minutes from the API at last sync
  let clockBaseTs  = 0;      // Date.now() when that minute was received
  let clockRunning = false;  // only ticks during live, in-play periods

  function setStatus(msg, isError = false) {
    const el = $('api-status');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? '#f88' : '#888';
    }
  }

  // ── Build /api/match query for the primary (Socceroos) fixture ───────────
  function primaryQuery() {
    const q = new URLSearchParams();
    for (const k of ['fixture', 'team', 'season', 'league', 'demo']) {
      const v = P(k);
      if (v != null) q.set(k, v);
    }
    return q.toString();
  }

  function secondaryQuery() {
    const q = new URLSearchParams();
    if (P('demo')) {
      // 2022 3rd-place playoff: Morocco's last 2022 match (team 31, season 2022).
      q.set('demo', '1');
      q.set('team', '31');
    } else if (P('other')) {
      q.set('fixture', P('other'));
    } else {
      return null; // no secondary configured
    }
    return q.toString();
  }

  async function fetchMatch(qs) {
    const url = `/api/match${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // ── Event-feed helpers ───────────────────────────────────────────────────
  function eventSide(ev) { return ev.team?.id === homeId ? 'home' : 'away'; }

  function eventLabel(ev) {
    if (ev.type === 'Goal') return ev.detail === 'Penalty' ? 'GOAL (PEN)' : 'GOAL';
    if (ev.type === 'Card') return String(ev.detail || '').includes('Red') ? 'Red Card' : 'Yellow Card';
    if (ev.type === 'subst') return 'Sub';
    if (ev.type === 'Var') return 'VAR';
    return ev.type || '–';
  }

  function eventDesc(ev) {
    if (ev.type === 'Goal') {
      if (ev.detail === 'Penalty') return 'Penalty';
      return ev.assist?.name ? `Assist: ${ev.assist.name}` : '';
    }
    if (ev.type === 'Card') return ev.comments || ev.detail || '';
    if (ev.type === 'subst') return ev.assist?.name ? `Off: ${ev.assist.name}` : 'Substitution';
    return ev.detail || '';
  }

  function eventMinute(ev) {
    const m = ev.time?.elapsed ?? 0;
    const x = ev.time?.extra ? `+${ev.time.extra}` : '';
    return `${m}${x}'`;
  }

  function renderFeed(events) {
    const feed = $('feed-card');
    if (!feed) return;
    // Most-recent N events. Single feed-card is a fixed 408px (4 rows of 76px);
    // pair has a tighter vertical budget → 3 rows.
    // Single screen shows 4 rows by default; a screen can request fewer via
    // body[data-feed-limit] (the foundry layout uses 3 to match its design).
    const limit = isPair ? 3 : (Number(document.body.dataset.feedLimit) || 4);
    const recent = [...(events || [])].reverse().slice(0, limit);
    feed.innerHTML = recent.map((ev, i) => {
      const side = eventSide(ev);
      const isLast = i === recent.length - 1;
      return `
        <div class="feed-item${isLast ? ' last' : ''}">
          <div class="feed-top">
            <span class="feed-min">${eventMinute(ev)}</span>
            <span class="feed-type ${side}">${eventLabel(ev)}</span>
            <span class="feed-player ${side}">${ev.player?.name ?? '–'}</span>
          </div>
          <div class="feed-desc">${eventDesc(ev)}</div>
        </div>`;
    }).join('');
  }

  // Compact "MM+E'" form used by the small secondary (also-live) clock.
  function formatClock(state) {
    const tick = state.extra ? `${state.elapsed}+${state.extra}` : String(state.elapsed ?? '');
    const suppress = state.isFinished || /Half Time|AET|Penalties/i.test(state.period || '');
    return tick + (suppress ? '' : "'");
  }

  // Main mm:ss clock. Re-baselines whenever the API minute advances; paused
  // outside live in-play periods (HT / FT / Penalties / AET).
  function clockIsRunning(state) {
    return !!state.isLive && !/Half Time|Full Time|Penalties|AET/i.test(state.period || '');
  }
  function syncClock(state) {
    const mins = state.elapsed ?? 0;
    if (clockIsRunning(state)) {
      if (clockBaseMin === null || mins > clockBaseMin) {
        clockBaseMin = mins;
        clockBaseTs = Date.now();
      }
      clockRunning = true;
    } else {
      clockRunning = false;
      clockBaseMin = mins;
    }
    renderClock();
  }
  function renderClock() {
    const el = $('match-clock');
    if (!el || clockBaseMin === null) return;
    let totalSec = clockBaseMin * 60;
    if (clockRunning) totalSec += Math.floor((Date.now() - clockBaseTs) / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    el.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  // ── Primary render ──────────────────────────────────────────────────────
  function renderPrimary(state) {
    homeId = state.home.id;
    awayId = state.away.id;

    $('score-home').textContent = state.scoreH ?? '–';
    $('score-away').textContent = state.scoreA ?? '–';
    syncClock(state);
    $('match-period').textContent = state.period ?? '–';
    $('meta-group').textContent = state.metaGroup ?? '–';
    $('meta-venue').textContent = state.metaVenue ?? '–';
    $('name-home').textContent = (state.home.name || '').toUpperCase();
    $('name-away').textContent = (state.away.name || '').toUpperCase();

    setFlag($('flag-home'), state.home.name, state.home.logo);
    setFlag($('flag-away'), state.away.name, state.away.logo);

    const possH = Number.isFinite(state.possH) ? state.possH : 50;
    const possA = Number.isFinite(state.possA) ? state.possA : 50;
    $('poss-home').textContent = `${possH}%`;
    $('poss-away').textContent = `${possA}%`;
    $('poss-bar-home').style.width = `${possH}%`;
    // Flag circles flanking the possession bar (single screen only).
    setFlag($('poss-flag-home'), state.home.name, state.home.logo);
    setFlag($('poss-flag-away'), state.away.name, state.away.logo);

    const stats = [
      ['shots', state.shots],
      ['target', state.target],
      ['corners', state.corners],
      ['fouls', state.fouls],
    ];
    for (const [id, pair] of stats) {
      $(`s-${id}-h`).textContent = pair?.[0] ?? '–';
      $(`s-${id}-a`).textContent = pair?.[1] ?? '–';
    }

    renderFeed(state.events);

    // Goal-overlay nudge — only fire after a baseline poll establishes scores.
    const newH = state.scoreH ?? 0;
    const newA = state.scoreA ?? 0;
    if (lastScoreH !== null && state.period !== 'Full Time') {
      if (newH > lastScoreH) notifyGoal(state, state.home);
      else if (newA > lastScoreA) notifyGoal(state, state.away);
    }
    lastScoreH = newH;
    lastScoreA = newA;
  }

  function findScorer(events, teamId) {
    if (!events?.length) return '';
    return [...events].reverse()
      .find((ev) => ev.type === 'Goal' && ev.team?.id === teamId)
      ?.player?.name ?? '';
  }

  function notifyGoal(state, team) {
    // Overlay copy: "<player> scores for <country>". scorer = goal event's
    // player name, team.name = country — both straight from the API. Fall back
    // to "Goal for <country>" if the scorer isn't in the events payload yet.
    const scorer = findScorer(state.events, team.id);
    const text = scorer ? `${scorer} scores for ${team.name}` : `Goal for ${team.name}`;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'GOAL', scorer: text }, '*');
      } else if (typeof window.triggerGoal === 'function') {
        window.triggerGoal(text);
      }
    } catch (err) {
      console.warn('[match-live] notifyGoal failed:', err);
    }
  }

  // ── Pair secondary render ────────────────────────────────────────────────
  function renderSecondary(state) {
    const card = $('also-card');
    const possWrap = $('also-poss-wrap');
    if (!card || !state) return;

    const homeCode = teamCode(state.home.name);
    const awayCode = teamCode(state.away.name);

    card.innerHTML = `
      <div class="also-team home">
        <span class="also-team-code">${homeCode}</span>
        <div class="also-flag"><img id="also-flag-home" alt=""></div>
        <span class="also-score">${state.scoreH ?? '–'}</span>
      </div>
      <div class="also-centre">
        <div class="also-clock">${formatClock(state)}</div>
        <div class="also-period">${state.period ?? '–'}</div>
      </div>
      <div class="also-team away">
        <span class="also-score">${state.scoreA ?? '–'}</span>
        <div class="also-flag"><img id="also-flag-away" alt=""></div>
        <span class="also-team-code">${awayCode}</span>
      </div>`;

    setFlag(document.getElementById('also-flag-home'), state.home.name, state.home.logo);
    setFlag(document.getElementById('also-flag-away'), state.away.name, state.away.logo);

    const possH = Number.isFinite(state.possH) ? state.possH : 50;
    const possA = Number.isFinite(state.possA) ? state.possA : 50;
    possWrap.hidden = false;
    $('also-poss-home').textContent = `${possH}%`;
    $('also-poss-away').textContent = `${possA}%`;
    $('also-poss-bar-home').style.width = `${possH}%`;
  }

  function clearSecondary(reason) {
    const card = $('also-card');
    const possWrap = $('also-poss-wrap');
    if (card) card.innerHTML = `<div class="also-empty">${reason}</div>`;
    if (possWrap) possWrap.hidden = true;
  }

  // ── Polling ──────────────────────────────────────────────────────────────
  let pollTimer = null;
  let liveState = null;

  function nextDelay() {
    if (POLL_OVERRIDE_MS) return POLL_OVERRIDE_MS;
    return liveState?.isLive ? LIVE_POLL_MS : IDLE_POLL_MS;
  }

  async function tick() {
    try {
      setStatus('Fetching…');
      const primary = await fetchMatch(primaryQuery());
      liveState = primary;
      renderPrimary(primary);

      if (isPair) {
        const sq = secondaryQuery();
        if (sq) {
          try {
            const secondary = await fetchMatch(sq);
            renderSecondary(secondary);
          } catch (err) {
            clearSecondary('Second match unavailable');
            console.warn('[match-live] secondary fetch failed:', err);
          }
        } else {
          clearSecondary('No second match configured');
        }
      }

      const t = new Date(primary.fetchedAt).toLocaleTimeString();
      const cadence = primary.isLive ? '1min' : '5min';
      const tag = primary.resolvedAs ? ` · ${primary.resolvedAs}` : '';
      setStatus(`Live · #${primary.fixtureId} · ${primary.home.name} v ${primary.away.name}${tag} · ${t} · poll ${cadence}`);
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      console.error('[match-live]', err);
    } finally {
      pollTimer = setTimeout(tick, nextDelay());
    }
  }

  tick();
  // Local 1s ticker so the mm:ss clock counts up smoothly between API polls.
  setInterval(() => { if (clockRunning) renderClock(); }, 1000);
})();
