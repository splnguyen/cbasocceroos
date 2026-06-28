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

  // Live: poll the PROXY every 10s so the screen updates frequently (stats,
  // clock, synthetic ticker). This does NOT translate to 6 upstream calls/min:
  // lib/match-service.js caches each api-football endpoint ~8s with single-flight,
  // so upstream hits for the live fixture stay ~7/min total regardless of how many
  // displays poll — well under the 450/min limit. Each render is still buffered by
  // DISPLAY_DELAY_MS (80s) so the screen trails the TV feed. Idle stays slow.
  const LIVE_POLL_MS = 10_000;
  const IDLE_POLL_MS = 5 * 60_000;
  const POLL_OVERRIDE_MS = P('poll')
    ? Math.max(2, Number(P('poll'))) * 1000
    : null;

  // Broadcast delay: shift the WHOLE display back so it lines up with the TV
  // feed (which has a built-in delay) instead of leading it — e.g. the goal
  // overlay firing before the broadcast shows the goal. Measured ~80s on the
  // venue feed. Override with ?delay= (seconds); 0 disables. Applies to
  // score/stats/feed/goal AND the clock.
  const DISPLAY_DELAY_MS = (P('delay') != null ? Math.max(0, Number(P('delay')) || 0) : 80) * 1000;

  const $ = (id) => document.getElementById(id);

  // ── Score / state for goal detection ─────────────────────────────────────
  let lastScoreH = null;
  let lastScoreA = null;
  let homeId = null;
  let awayId = null;

  // ── Match clock (mm:ss, ticks locally between API polls) ─────────────────
  // api-football reports `elapsed` in whole MINUTES only. We tick the seconds
  // locally and re-sync to the API minute on each poll — but FORWARD-ONLY: the
  // clock never rewinds. (An earlier version used a server-sent per-minute anchor,
  // but that anchor lives in memory PER serverless instance, so polls landing on
  // different instances returned different anchor times for the same minute and
  // the clock jumped/rewound by up to a minute. Ticking locally + forward-only
  // re-sync is monotonic, and because every display re-syncs to the same API
  // minute they stay within a poll interval of each other.)
  let clockSec     = null;   // displayed match-seconds (baselined at the API minute; the broadcast delay is applied to the paint timing, not here)
  let clockTickMs  = 0;      // Date.now() at the last local advance
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
  const seenEventKeys = new Set();
  const seenTickerIds = new Set();  // server synthetic-item ids already added
  let tickerFixtureId = null;
  let feedSeq = 0;                  // local id per feed item (for the enter animation)
  let renderedFeedIds = new Set();  // ids currently in the DOM, to detect new rows
  const TICKER_MAX = 60;

  function eventKey(ev) {
    return [ev.time?.elapsed, ev.time?.extra, ev.type, ev.detail, ev.team?.id, ev.player?.name].join('|');
  }

  function updateTicker(state) {
    // Reset when the fixture changes.
    if (state.fixtureId !== tickerFixtureId) {
      tickerFixtureId = state.fixtureId;
      liveFeed = []; seenEventKeys.clear(); seenTickerIds.clear(); renderedFeedIds = new Set();
    }

    const fresh = []; // new items this poll, each with a numeric minute for sorting

    // 1. New real events (Goal / Card / Sub / VAR) — these carry a team flag.
    for (const ev of (state.events || [])) {
      const key = eventKey(ev);
      if (seenEventKeys.has(key)) continue;
      seenEventKeys.add(key);
      const team = ev.team?.id === homeId ? state.home : state.away;
      const label = eventLabel(ev);
      let desc = eventDesc(ev);
      // Drop the white second line if it's empty or just repeats the yellow
      // label (e.g. a Yellow Card whose detail is also "Yellow Card").
      if (desc && desc.trim().toLowerCase() === label.trim().toLowerCase()) desc = '';
      fresh.push({ kind: 'real', goal: ev.type === 'Goal', side: eventSide(ev),
        min: eventMinute(ev), minNum: (ev.time?.elapsed || 0) * 100 + (ev.time?.extra || 0),
        type: label, who: ev.player?.name ?? '–', desc,
        flagName: team?.name, flagLogo: team?.logo });
    }

    // 2. Synthetic ticker — generated on the SERVER (state.ticker) so every
    // display and every reload shows the SAME list, regardless of load time.
    for (const t of (state.ticker || [])) {
      if (seenTickerIds.has(t.id)) continue;
      seenTickerIds.add(t.id);
      fresh.push({ kind: 'stat', side: t.side, min: t.min, minNum: t.minNum || 0,
        type: t.type, who: t.who, desc: '' });
    }

    if (fresh.length) {
      fresh.sort((a, b) => a.minNum - b.minNum); // oldest → newest by match minute
      for (const it of fresh) it.id = ++feedSeq;
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

    // Both single AND pair screens pack by MEASURED height (below). The pair
    // screen used to keep a fixed 3 rows, but a "real" event renders a TWO-line
    // row (title + description + flag) that's taller than the Figma 3-row budget
    // assumed — so 3+ of them overflowed the fixed-height card and the bottom row
    // was clipped mid-text. The packer keeps only rows that FULLY fit the card
    // (308px on pair), so a row is never trimmed; goals are still protected.

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
    const suppress = state.isFinished || /Half Time|AET|Penalt/i.test(state.period || '');
    return tick + (suppress ? '' : "'");
  }

  // Main mm:ss clock. Re-baselines whenever the API minute advances; paused
  // outside live in-play periods (HT / FT / Penalties / AET).
  function clockIsRunning(state) {
    return !!state.isLive && !/Half Time|Full Time|Penalties|AET/i.test(state.period || '');
  }
  // Displayed time at the START of the current API minute.
  // NOTE: do NOT subtract the broadcast delay here. The whole `state` (score,
  // feed, synthetic ticker rows AND this elapsed) is already held back by
  // DISPLAY_DELAY_MS via the setTimeout(apply, …) in tick(), so the delay is
  // applied once, to the timing of the paint. The ticker rows carry their raw
  // match minute (a corner at minute 11 is labelled 11'); subtracting the delay
  // here too would baseline the clock ~80s behind those labels, so the clock
  // would read 10:45 next to an 11' event. Baselining at elapsed*60 keeps the
  // clock minute ≥ every event minute in the same state (each event's
  // time.elapsed ≤ state.elapsed), so the ticker can never lead the clock.
  function clockFloorSec(state) {
    return (state.elapsed ?? 0) * 60;
  }
  function syncClock(state) {
    clockRunning = clockIsRunning(state);
    if (!clockRunning) { clockSec = null; renderClock(); return; }
    const floor = clockFloorSec(state);
    if (clockSec === null) {
      clockSec = Math.max(0, floor);          // first sight → start at the minute floor
    } else if (floor > clockSec) {
      clockSec = floor;                       // API minute advanced past us → catch up FORWARD
    } else if (clockSec - floor > 180) {
      clockSec = Math.max(0, floor);          // huge gap (period reset/correction) → resync
    }
    // Otherwise the API minute is at/just behind our ticking clock — keep ticking,
    // NEVER rewind. (Stoppage time naturally ticks past the minute floor.)
    clockTickMs = Date.now();
    renderClock();
  }
  function renderClock() {
    const el = $('match-clock');
    if (!el) return;
    // At breaks (Half Time / Full Time / Penalties / AET) the clock isn't
    // ticking, so a frozen "45:00" / "90:00" would be misleading — hide it and
    // let the period text (e.g. "Half Time") stand on its own.
    if (!clockRunning || clockSec === null) { el.style.display = 'none'; return; }
    el.style.display = '';
    // Advance by real elapsed wall-time since the last tick (smooth + drift-free
    // even if the 1 s interval fires irregularly).
    const now = Date.now();
    clockSec += (now - clockTickMs) / 1000;
    clockTickMs = now;
    const total = Math.max(0, Math.floor(clockSec));
    const mm = Math.floor(total / 60);
    const ss = total % 60;
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

  // Frozen clock shown during a penalty shootout — the shootout starts after the
  // 120' of extra time, so it reads "120:00" (api-football reports elapsed in
  // minutes; default to 120 if it isn't a sane in-shootout value).
  function penClock(state) {
    const m = Number.isFinite(state.elapsed) && state.elapsed >= 90 ? state.elapsed : 120;
    return `${m}:00`;
  }

  // ── Primary render ──────────────────────────────────────────────────────
  function renderPrimary(state) {
    homeId = state.home.id;
    awayId = state.away.id;

    setNum($('score-home'), state.scoreH);
    setNum($('score-away'), state.scoreA);

    // Penalty kick-off: during a live shootout (status 'P' → isLive + penH/penA),
    // show the running penalty-kick tally per team flanking the centre column,
    // freeze the clock at the end of extra time, and label the centre "Penalty
    // Kick-Off". Otherwise render the clock/period normally. (Figma 2112-4524.)
    const penLive = !!state.isLive && state.penH != null && state.penA != null;
    const section = $('score-home')?.closest('.score-section');
    if (section) section.classList.toggle('pens', penLive);
    setNum($('pen-home'), penLive ? state.penH : '');
    setNum($('pen-away'), penLive ? state.penA : '');
    if (penLive) {
      clockRunning = false;                       // freeze: the 1s ticker skips it
      const clk = $('match-clock');
      if (clk) { clk.style.display = ''; clk.textContent = penClock(state); }
      $('match-period').textContent = 'Penalty Kick-Off';
    } else {
      syncClock(state);
      $('match-period').textContent = state.period ?? '–';
    }
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

    // Live shootout: append the penalty-kick tally as a small superscript on each
    // score (the centre already reads "Penalty Kick-Off" via state.period).
    const penLive = !!state.isLive && state.penH != null && state.penA != null;
    const penH = penLive ? `<sup class="also-pen">${state.penH}</sup>` : '';
    const penA = penLive ? `<sup class="also-pen">${state.penA}</sup>` : '';

    card.innerHTML = `
      <div class="also-team home">
        <span class="also-team-code">${homeCode}</span>
        <div class="also-flag"><img id="also-flag-home" alt=""></div>
        <span class="also-score">${state.scoreH ?? '–'}${penH}</span>
      </div>
      <div class="also-centre">
        <div class="also-clock">${formatClock(state)}</div>
        <div class="also-period">${state.period ?? '–'}</div>
      </div>
      <div class="also-team away">
        <span class="also-score">${state.scoreA ?? '–'}${penA}</span>
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
  let firstRenderDone = false;   // first paint skips the broadcast delay (no blank warmup)

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
        const cadence = primary.isLive ? '10s' : '5min';
        const tag = primary.resolvedAs ? ` · ${primary.resolvedAs}` : '';
        const delayTag = DISPLAY_DELAY_MS ? ` · +${DISPLAY_DELAY_MS / 1000}s` : '';
        setStatus(`Live · #${primary.fixtureId} · ${primary.home.name} v ${primary.away.name}${tag} · ${t} · poll ${cadence}${delayTag}`);
      };
      // First paint renders immediately so a freshly-loaded screen (e.g. the
      // carousel switching in at kickoff) shows data right away instead of
      // sitting blank for the whole DISPLAY_DELAY_MS. Every later update keeps
      // the broadcast delay so the screen still trails the TV feed.
      if (DISPLAY_DELAY_MS > 0 && firstRenderDone) {
        setTimeout(apply, DISPLAY_DELAY_MS);
      } else {
        apply();
        firstRenderDone = true;
      }
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
