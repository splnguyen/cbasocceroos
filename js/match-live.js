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

  // Broadcast delay: shift the WHOLE display back ~10s so it lines up with the
  // TV feed (which has a built-in delay) instead of leading it — e.g. the goal
  // overlay firing before the broadcast shows the goal. Override with ?delay=
  // (seconds); 0 disables. Applies to score/stats/feed/goal AND the clock.
  const DISPLAY_DELAY_MS = (P('delay') != null ? Math.max(0, Number(P('delay')) || 0) : 10) * 1000;

  const $ = (id) => document.getElementById(id);

  // ── Score / state for goal detection ─────────────────────────────────────
  let lastScoreH = null;
  let lastScoreA = null;
  let homeId = null;
  let awayId = null;

  // ── Match clock (mm:ss, ticks locally between API polls) ─────────────────
  // api-football gives `elapsed` in whole minutes only. The proxy now sends a
  // shared per-minute anchor (state.clock) so every display ticks from the SAME
  // reference (assumes the screens' clocks are roughly NTP-synced, which office
  // machines are). If the anchor is missing we fall back to the old local
  // synthesis (record the minute + a local timestamp, count up each second).
  let serverClock  = null;   // { minute, anchorMs } from the proxy (shared)
  let clockBaseMin = null;   // legacy fallback: minutes from the API at last sync
  let clockBaseTs  = 0;      // legacy fallback: Date.now() when that minute was received
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

  // ── Live ticker ───────────────────────────────────────────────────────────
  // api-football's events endpoint only carries goals/cards/subs/VAR, so during
  // open play the feed would barely move. We synthesise extra "movement" by
  // diffing the live STATISTICS each poll (shots, on-target, corners, saves,
  // fouls, offsides, possession swings, xG) and injecting derived ticker items.
  // These are styled subtly (.stat) to read as live-stat updates rather than
  // confirmed goal/card events. `liveFeed` is a single newest-first stream of
  // real + synthetic items, in the order they were detected.
  let liveFeed = [];
  let prevStats = null;
  const seenEventKeys = new Set();
  let tickerFixtureId = null;
  let lastPossEmitted = null;
  let feedSeq = 0;                  // unique id per feed item (for enter animation)
  let renderedFeedIds = new Set();  // ids currently in the DOM, to detect new rows
  const TICKER_MAX = 40;

  function eventKey(ev) {
    return [ev.time?.elapsed, ev.time?.extra, ev.type, ev.detail, ev.team?.id, ev.player?.name].join('|');
  }
  function statSnapshot(state) {
    const xg = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    return {
      shots:    state.shots    || [0, 0],
      target:   state.target   || [0, 0],
      corners:  state.corners  || [0, 0],
      saves:    state.saves    || [0, 0],
      fouls:    state.fouls    || [0, 0],
      offsides: state.offsides || [0, 0],
      poss:     Number.isFinite(state.possH) ? state.possH : 50,
      xg:       [xg(state.xg?.[0]), xg(state.xg?.[1])],
    };
  }

  function updateTicker(state) {
    // Reset the ticker when the fixture changes.
    if (state.fixtureId !== tickerFixtureId) {
      tickerFixtureId = state.fixtureId;
      liveFeed = []; prevStats = null; seenEventKeys.clear();
      lastPossEmitted = null; renderedFeedIds = new Set();
    }

    const fresh = []; // new items this poll, oldest → newest
    const min = `${state.elapsed ?? 0}${state.extra ? `+${state.extra}` : ''}'`;
    const teamName = (i) => (i === 0 ? state.home.name : state.away.name) || ''; // title case (as the API gives it)

    // 1. New real events (Goal / Card / Sub / VAR) — these carry a team flag.
    for (const ev of (state.events || [])) {
      const key = eventKey(ev);
      if (seenEventKeys.has(key)) continue;
      seenEventKeys.add(key);
      const team = ev.team?.id === homeId ? state.home : state.away;
      const label = eventLabel(ev);
      let desc = eventDesc(ev);
      // Drop the white second line if it's empty or just repeats the yellow label
      // (e.g. a Yellow Card whose detail is also "Yellow Card") — the row then
      // hugs to a single line.
      if (desc && desc.trim().toLowerCase() === label.trim().toLowerCase()) desc = '';
      fresh.push({ kind: 'real', goal: ev.type === 'Goal', side: eventSide(ev), min: eventMinute(ev),
        type: label, who: ev.player?.name ?? '–', desc,
        flagName: team?.name, flagLogo: team?.logo });
    }

    // 2. Synthetic stat-derived movement (only after a baseline snapshot).
    const cur = statSnapshot(state);
    if (prevStats) {
      const push = (side, type, who) => fresh.push({ kind: 'stat', side, min, type, who, desc: '' });
      const cap = (n) => Math.min(Math.max(0, n), 3); // guard a big jump after a gap
      for (const [side, i] of [['home', 0], ['away', 1]]) {
        const onTarget  = cap(cur.target[i]   - prevStats.target[i]);
        const offTarget = cap((cur.shots[i] - prevStats.shots[i]) - (cur.target[i] - prevStats.target[i]));
        const corners   = cap(cur.corners[i]  - prevStats.corners[i]);
        const saves     = cap(cur.saves[i]    - prevStats.saves[i]);
        const fouls     = cap(cur.fouls[i]     - prevStats.fouls[i]);
        const offs      = cap(cur.offsides[i] - prevStats.offsides[i]);
        const name = teamName(i);
        for (let k = 0; k < onTarget;  k++) push(side, 'Shot on Target', name);
        for (let k = 0; k < offTarget; k++) push(side, 'Shot', name);
        for (let k = 0; k < corners;   k++) push(side, 'Corner', name);
        for (let k = 0; k < saves;     k++) push(side, 'Save', name);
        for (let k = 0; k < fouls;     k++) push(side, 'Foul', name);
        for (let k = 0; k < offs;      k++) push(side, 'Offside', name);
      }
      // Possession swing (≥4% from the last one we announced).
      if (Math.abs(cur.poss - lastPossEmitted) >= 4) {
        lastPossEmitted = cur.poss;
        const homeLead = cur.poss >= 50;
        push(homeLead ? 'home' : 'away', 'Possession',
          `${teamName(homeLead ? 0 : 1)} ${homeLead ? cur.poss : 100 - cur.poss}%`);
      }
    } else {
      // Seed the possession baseline so poll #2 doesn't announce a catch-up swing.
      lastPossEmitted = cur.poss;
    }
    prevStats = cur;

    if (fresh.length) {
      for (const it of fresh) it.id = ++feedSeq; // stable id so new rows can animate in
      liveFeed = [...fresh.reverse(), ...liveFeed].slice(0, TICKER_MAX);
    }
  }

  function feedRowHtml(it, isLast, enter) {
    // Real events (goals/cards/subs/VAR) carry a team flag avatar; synthetic
    // ticker rows do not.
    const flag = it.kind === 'real' ? '<span class="feed-flag"><img alt=""></span>' : '';
    return `
      <div class="feed-item${isLast ? ' last' : ''}${it.kind === 'stat' ? ' stat' : ''}${enter ? ' enter' : ''}">
        <div class="feed-top">
          <span class="feed-min">${it.min}</span>
          <span class="feed-type ${it.side || ''}">${it.type}</span>
          ${flag}
          <span class="feed-player ${it.side || ''}">${it.who}</span>
        </div>
        ${it.desc ? `<div class="feed-desc">${it.desc}</div>` : ''}
      </div>`;
  }

  // After a feed render, point each real event's flag avatar at its team.
  function applyFeedFlags(feed, items) {
    items.forEach((it, i) => {
      if (it.kind !== 'real') return;
      const img = feed.children[i] && feed.children[i].querySelector('.feed-flag img');
      if (img) setFlag(img, it.flagName, it.flagLogo);
    });
  }

  function renderFeed() {
    const feed = $('feed-card');
    if (!feed) return;

    // Goals are always kept (most-recent first). Synthetic rows are short (no
    // second line), so more of them fit. We pack by MEASURED height rather than
    // a fixed count: render the candidates, measure, then keep as many as fit
    // the card — never dropping a goal.
    const goals  = liveFeed.filter((it) => it.goal);
    const others = liveFeed.filter((it) => !it.goal).slice(0, 16);
    const candidates = [...goals, ...others].sort((a, b) => liveFeed.indexOf(a) - liveFeed.indexOf(b)); // newest-first

    // Pair screen keeps a fixed small count (tight vertical budget alongside the
    // second match), goals still protected.
    if (isPair) {
      const g = goals.slice(0, 3);
      const o = others.slice(0, Math.max(0, 3 - g.length));
      const recent = [...g, ...o].sort((a, b) => liveFeed.indexOf(a) - liveFeed.indexOf(b));
      feed.innerHTML = recent.map((it, i) => feedRowHtml(it, i === recent.length - 1, !renderedFeedIds.has(it.id))).join('');
      applyFeedFlags(feed, recent);
      renderedFeedIds = new Set(recent.map((it) => it.id));
      return;
    }

    // Pass 1: render every candidate at full height (no `.last`) to measure.
    feed.innerHTML = candidates.map((it) => feedRowHtml(it, false)).join('');
    const cs = getComputedStyle(feed);
    const budget = feed.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0');
    const gap = parseFloat(cs.rowGap || cs.gap || '0') || 0;
    const heightOf = new Map(candidates.map((it, i) => [it, feed.children[i] ? feed.children[i].offsetHeight : 0]));

    // Greedy fit: goals first (guaranteed), then newest others while they fit.
    const chosen = new Set();
    let used = 0;
    const tryAdd = (it) => {
      const cost = heightOf.get(it) + (chosen.size ? gap : 0);
      if (used + cost <= budget) { chosen.add(it); used += cost; return true; }
      return false;
    };
    for (const g of goals) tryAdd(g);
    for (const it of candidates) if (!it.goal && !chosen.has(it)) tryAdd(it);

    // Pass 2: render the chosen set, newest-first. New rows (ids not previously
    // rendered) get `.enter` so they ease in; persisting rows render unchanged.
    const finalItems = candidates.filter((it) => chosen.has(it));
    feed.innerHTML = finalItems
      .map((it, i) => feedRowHtml(it, i === finalItems.length - 1, !renderedFeedIds.has(it.id)))
      .join('');
    applyFeedFlags(feed, finalItems);
    renderedFeedIds = new Set(finalItems.map((it) => it.id));
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
    clockRunning = clockIsRunning(state);
    if (clockRunning && state.clock) {
      // Shared server anchor — all displays count from the same reference.
      serverClock = state.clock;
    } else if (clockRunning) {
      // Fallback: synthesise locally (re-baseline when the API minute advances).
      serverClock = null;
      const mins = state.elapsed ?? 0;
      if (clockBaseMin === null || mins > clockBaseMin) {
        clockBaseMin = mins;
        clockBaseTs = Date.now();
      }
    } else {
      serverClock = null;
      clockBaseMin = state.elapsed ?? 0;
    }
    renderClock();
  }
  function renderClock() {
    const el = $('match-clock');
    if (!el) return;
    // At breaks (Half Time / Full Time / Penalties / AET) the clock isn't
    // ticking, so a frozen "45:00" / "90:00" would be misleading — hide it and
    // let the period text (e.g. "Half Time") stand on its own.
    if (!clockRunning) { el.style.display = 'none'; return; }
    el.style.display = '';
    let totalSec;
    if (serverClock) {
      // Subtract the broadcast delay so the clock trails the TV like the rest.
      totalSec = serverClock.minute * 60 + Math.floor((Date.now() - serverClock.anchorMs - DISPLAY_DELAY_MS) / 1000);
    } else if (clockBaseMin !== null) {
      totalSec = clockBaseMin * 60 + Math.floor((Date.now() - clockBaseTs - DISPLAY_DELAY_MS) / 1000);
    } else {
      return;
    }
    if (totalSec < 0) totalSec = 0; // guard against a display clock running behind the server
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    el.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  // Update a number element, easing the new value in (slide up + fade) — but
  // only when it actually changes, so static polls don't re-animate.
  function setNum(el, value) {
    if (!el) return;
    const v = `${value ?? '–'}`;
    if (el.textContent === v) return;
    el.textContent = v;
    el.classList.remove('bump');
    void el.offsetWidth; // reflow so the CSS animation restarts
    el.classList.add('bump');
  }

  // ── Primary render ──────────────────────────────────────────────────────
  function renderPrimary(state) {
    homeId = state.home.id;
    awayId = state.away.id;

    setNum($('score-home'), state.scoreH);
    setNum($('score-away'), state.scoreA);
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
    setNum($('poss-home'), `${possH}%`);
    setNum($('poss-away'), `${possA}%`);
    $('poss-bar-home').style.width = `${possH}%`; // eased via CSS transition
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
      setNum($(`s-${id}-h`), pair?.[0]);
      setNum($(`s-${id}-a`), pair?.[1]);
    }

    updateTicker(state);
    renderFeed();

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
    const base = POLL_OVERRIDE_MS ? POLL_OVERRIDE_MS : (liveState?.isLive ? LIVE_POLL_MS : IDLE_POLL_MS);
    // ±12% jitter so multiple displays showing the same match don't fetch
    // /api/match in lockstep (spreads load, improves the proxy cache hit rate).
    return Math.round(base * (0.88 + Math.random() * 0.24));
  }

  async function tick() {
    try {
      const primary = await fetchMatch(primaryQuery());
      liveState = primary; // real-time — keeps the poll cadence correct

      let secondary; // undefined = not pair; null = none configured; 'error' = failed
      if (isPair) {
        const sq = secondaryQuery();
        if (sq) {
          try { secondary = await fetchMatch(sq); }
          catch (err) { secondary = 'error'; console.warn('[match-live] secondary fetch failed:', err); }
        } else {
          secondary = null;
        }
      }

      // Apply the data to the screen AFTER the broadcast delay so the display
      // trails the TV (which has its own delay) rather than leading it.
      const apply = () => {
        renderPrimary(primary);
        if (isPair) {
          if (secondary === 'error') clearSecondary('Second match unavailable');
          else if (secondary) renderSecondary(secondary);
          else clearSecondary('No second match configured');
        }
        const t = new Date(primary.fetchedAt).toLocaleTimeString();
        const cadence = primary.isLive ? '1min' : '5min';
        const tag = primary.resolvedAs ? ` · ${primary.resolvedAs}` : '';
        const delayTag = DISPLAY_DELAY_MS ? ` · +${DISPLAY_DELAY_MS / 1000}s` : '';
        setStatus(`Live · #${primary.fixtureId} · ${primary.home.name} v ${primary.away.name}${tag} · ${t} · poll ${cadence}${delayTag}`);
      };
      if (DISPLAY_DELAY_MS > 0) setTimeout(apply, DISPLAY_DELAY_MS);
      else apply();
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
