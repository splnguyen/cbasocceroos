/**
 * Match Coming Up — Quarter/Semi-final variant.
 * Office screen: Figma 2268-6152 ("state-comingup-singlematch-qfsf").
 * Foundry screen: Figma 2271-6838 ("match-comingup-qf-foundry").
 * Both reuse this script unchanged (same element ids).
 *
 * ROTATES through every not-yet-finished Quarter-final in kickoff order,
 * 10s per match: countdown + avatars + the bottom panel swap together.
 * Panel data for all fixtures is fetched once per 5-min poll; rotation
 * renders from memory, so the 10s cycle adds zero upstream API traffic.
 *
 * Bottom panel (SPLIT PROVENANCE — same principle as the earlier build):
 *
 *   1. "PAST 5 MATCHES | HEAD TO HEAD" — three card-stat tiles (Figma
 *      2271-6966): home wins / draws / away wins over the TRUE last 5
 *      meetings, CURATED per pairing. api-football's international h2h
 *      history is too shallow to trust: for these QFs it returns FRA-MAR 1
 *      meeting (truth: 5), ESP-BEL 0 (!), NOR-ENG 0 (!), ARG-SUI 1. The
 *      /api/h2h call still runs once per pairing as VALIDATION ONLY (logged,
 *      never rendered). An uncurated pairing falls back to the API tally
 *      labelled "RECENT MATCHES | HEAD TO HEAD" — a shallow count is never
 *      presented as the full record.
 *
 *   2. "WORLD CUP 2026" — LIVE per-team form strips + goal stats from
 *      /api/form + /api/topscorers. OFFICE ONLY — the foundry variant omits
 *      the #wc-label/#wc-rows elements and this script skips the fetches.
 *      No visible empty state: the whole section stays hidden until live
 *      data is available (a failed poll keeps the last good data).
 *
 * ?demo=1 renders the REAL four-QF snapshot (fixtures, kickoffs, curated
 * tallies, and form strips baked from /api/form on 2026-07-08) offline.
 */

(function () {
  const params = new URLSearchParams(location.search);
  const isDemo = params.get('demo') === '1';
  const POLL_MS = 5 * 60 * 1000;
  const ROTATE_MS = 10 * 1000;
  const QF_ROUND = 'Quarter-finals';

  const updatedBadge = document.getElementById('updatedBadge');
  const subhead    = document.getElementById('subhead');
  const cdClock    = document.getElementById('cd-clock');
  const cdKickoff  = document.getElementById('cd-kickoff');
  const flagHome   = document.getElementById('flag-home');
  const flagAway   = document.getElementById('flag-away');
  const nameHome   = document.getElementById('name-home');
  const nameAway   = document.getElementById('name-away');
  const h2hTitle   = document.getElementById('h2h-title');
  const tallyRow   = document.getElementById('tally-row');
  // WC2026 section is office-only — the foundry markup omits these elements.
  const wcLabel    = document.getElementById('wc-label');
  const wcRows     = document.getElementById('wc-rows');
  const hasWc      = Boolean(wcLabel && wcRows);

  let kickoffEpoch = null;
  const h2hValidated = new Set();  // one validation log per pairing per load

  // ── Cache (instant paint on carousel revisits / page reloads) ────────────
  const CACHE_KEY = 'cba:comingup-qf:v1';
  function readCache() {
    try {
      const p = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return p && p.entries && p.ts ? p : null;
    } catch (e) { return null; }
  }
  function writeCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ entries: data, ts: Date.now() })); }
    catch (e) { /* best-effort */ }
  }

  // ── Flag preloading (warm browser memory cache so rotation is instant) ───
  function preloadFlag(name) {
    return new Promise((resolve) => {
      const src = getFlagSVG(name);
      if (!src) { resolve(); return; }
      const img = new Image();
      img.onload = resolve;
      img.onerror = resolve;
      img.src = src;
    });
  }
  function preloadAllFlags() {
    const promises = [];
    for (const e of entries) {
      if (e.fix.home?.name) promises.push(preloadFlag(e.fix.home.name));
      if (e.fix.away?.name) promises.push(preloadFlag(e.fix.away.name));
    }
    return Promise.all(promises);
  }
  function imgReady(img) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const prev = img.onerror;
      img.onload = resolve;
      img.onerror = function () { if (prev) prev.call(this); resolve(); };
    });
  }

  const NAME_REMAP = { 'Cape Verde Islands': 'Cabo Verde' };
  const displayName = (name) => (NAME_REMAP[name] || name || '').toUpperCase();
  const ROUND_LABEL = { 'Quarter-finals': 'Quarter Finals', 'Semi-finals': 'Semi Finals' };

  // ── Curated last-5 head-to-head tallies ──────────────────────────────────
  // Keyed "<lowerTeamId>-<higherTeamId>"; wins keyed by team id. Shootout-only
  // results count as draws (the FRA-MAR 1998 Hassan II Cup); AET results count
  // as wins (ARG-SUI 2014). Verified 2026-07-08:
  //   FRA-MAR 3/2/0  — Olympics.com / Sports Mole (from the approved brief)
  //   ESP-BEL 5/0/0  — Olympics.com QF preview / MEXC ("won the previous five,
  //                    13 goals scored, one conceded")
  //   NOR-ENG 1/2/2  — 11v11 / bet365 (ENG won 2014 + 2012 both 1-0; draws
  //                    1995 + 1992; NOR won the 1993 WCQ 2-0)
  //   ARG-SUI 4/0/1  — AiScore / 11v11 ("last 5: Argentina 4W 0D 1L")
  const CURATED_H2H = {
    '2-31':    { wins: { 2: 3, 31: 0 },    draws: 2 },  // France v Morocco
    '1-9':     { wins: { 9: 5, 1: 0 },     draws: 0 },  // Spain v Belgium
    '10-1090': { wins: { 10: 2, 1090: 1 }, draws: 2 },  // England v Norway
    '15-26':   { wins: { 26: 4, 15: 1 },   draws: 0 },  // Argentina v Switzerland
  };
  const pairKey = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

  // ── Time helpers ─────────────────────────────────────────────────────────
  const AEST = 'Australia/Sydney';

  function aestKickoffLine(ms) {
    const fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone: AEST,
      weekday: 'long', day: 'numeric', month: 'long',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const period = (p.dayPeriod || '').toUpperCase().replace(/\./g, '');
    return `${(p.weekday || '').toUpperCase()} ${p.day} ${(p.month || '').toUpperCase()} ${p.hour}:${p.minute}${period} AEST`;
  }

  function pad2(n) { return String(Math.max(0, n)).padStart(2, '0'); }
  function clockHMS(remainMs) {
    const secs = Math.max(0, Math.floor(remainMs / 1000));
    return `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`;
  }
  function tick() {
    if (kickoffEpoch == null) return;
    cdClock.textContent = clockHMS(kickoffEpoch - Date.now());
  }

  // ── Renderers ────────────────────────────────────────────────────────────
  function statCard(label, value) {
    return `
      <div class="card-stat">
        <div class="stat-label">${label}</div>
        <div class="stat-val">${value}</div>
      </div>`;
  }
  function renderTally(fix, tally) {
    h2hTitle.textContent = tally.curated
      ? 'Past 5 Matches | Head to Head'
      : 'Recent Matches | Head to Head';
    tallyRow.innerHTML =
      statCard(`${displayName(fix.home.name)} WINS`, tally.homeWins) +
      statCard('DRAWS', tally.draws) +
      statCard(`${displayName(fix.away.name)} WINS`, tally.awayWins);
  }

  const STRIP_LEN = 5;
  function stripBoxes(formNewestFirst) {
    const seq = (formNewestFirst || []).slice(0, STRIP_LEN).reverse();
    const pad = STRIP_LEN - seq.length;
    return Array(pad).fill('<span class="fbox empty"></span>').join('')
      + seq.map((m) => `<span class="fbox ${m.result.toLowerCase()}">${m.result}</span>`).join('');
  }
  function statLine(formData, scorers) {
    const top = (scorers || []).find((s) => s.teamId === formData.team.id);
    if (top) return `${formData.goalsFor} GF · ${top.name.split(' ').pop().toUpperCase()} ${top.goals}`;
    if (formData.unbeaten) return `UNBEATEN IN ${formData.played}`;
    return `${formData.goalsFor} GF`;
  }
  function wcRow(name, boxesHtml, stat) {
    return `
      <div class="wc-row">
        <span class="wc-team">${displayName(name)}</span>
        <span class="wc-strip">${boxesHtml}</span>
        <span class="wc-stat">${stat}</span>
      </div>`;
  }
  function renderWc(fix, panel) {
    if (!hasWc) return;
    // No visible empty state — the whole section hides until data exists.
    const show = Boolean(panel.formH && panel.formA);
    wcLabel.style.display = show ? '' : 'none';
    wcRows.style.display = show ? '' : 'none';
    if (!show) return;
    wcRows.innerHTML =
      wcRow(fix.home.name, stripBoxes(panel.formH.form), panel.statH) +
      wcRow(fix.away.name, stripBoxes(panel.formA.form), panel.statA);
    wcLabel.classList.toggle('stale', Boolean(panel.stale));
  }

  // Elements that swap during rotation (hidden together, revealed together).
  const swapEls = [
    document.querySelector('.cd-block'),
    document.querySelector('.match-block'),
    document.querySelector('.h2h-block'),
  ].filter(Boolean);

  async function renderFixture(fix, panel, transition) {
    if (transition) {
      swapEls.forEach((el) => { el.style.opacity = '0'; });
      await new Promise((r) => requestAnimationFrame(r));
    }
    nameHome.textContent = displayName(fix.home.name);
    nameAway.textContent = displayName(fix.away.name);
    setFlag(flagHome, fix.home.name, fix.home.logo);
    setFlag(flagAway, fix.away.name, fix.away.logo);
    subhead.textContent = ROUND_LABEL[fix.leagueRound] || fix.leagueRound || 'Knockout';
    kickoffEpoch = fix.kickoffEpoch;
    cdKickoff.textContent = aestKickoffLine(fix.kickoffEpoch);
    tick();
    renderTally(fix, panel.tally);
    renderWc(fix, panel);
    if (transition) {
      await Promise.all([imgReady(flagHome), imgReady(flagAway)]);
      swapEls.forEach((el) => { el.style.opacity = '1'; });
    }
  }

  // ── Rotation state ───────────────────────────────────────────────────────
  // entries: [{ fix, panel: { tally, formH, formA, statH, statA, stale } }]
  let entries = [];
  let idx = 0;

  function renderCurrent(transition) {
    if (!entries.length) return;
    idx %= entries.length;
    const e = entries[idx];
    renderFixture(e.fix, e.panel, transition);
  }
  function rotate() {
    if (entries.length < 2) return;
    idx = (idx + 1) % entries.length;
    renderCurrent(true);
  }

  // ── Live data ────────────────────────────────────────────────────────────
  function validateApiH2H(fix, curated) {
    const key = pairKey(fix.home.id, fix.away.id);
    if (h2hValidated.has(key)) return;
    h2hValidated.add(key);
    fetch(`/api/h2h?home=${fix.home.id}&away=${fix.away.id}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((h) => console.info(
        `[comingup-qf] api h2h validation ${fix.home.name} v ${fix.away.name}: ${h.played ?? '?'} row(s); curated tally covers 5`,
        curated ? '' : '(NO curated entry — rendering API tally as RECENT)',
      ))
      .catch(() => { /* best-effort */ });
  }

  async function buildTally(fix) {
    const curated = CURATED_H2H[pairKey(fix.home.id, fix.away.id)];
    if (curated) {
      validateApiH2H(fix, true);
      return {
        curated: true,
        homeWins: curated.wins[fix.home.id] ?? 0,
        awayWins: curated.wins[fix.away.id] ?? 0,
        draws: curated.draws,
      };
    }
    validateApiH2H(fix, false);
    const res = await fetch(`/api/h2h?home=${fix.home.id}&away=${fix.away.id}`, { cache: 'no-store' });
    const h = await res.json();
    if (!res.ok || !h.ok) throw new Error(h.error || `h2h HTTP ${res.status}`);
    return { curated: false, homeWins: h.winsHome, awayWins: h.winsAway, draws: h.draws };
  }

  async function fetchForm(teamId, season) {
    const res = await fetch(`/api/form?team=${teamId}&season=${season}&count=${STRIP_LEN}`, { cache: 'no-store' });
    const f = await res.json();
    if (!res.ok || !f.ok) throw new Error(f.error || `form HTTP ${res.status}`);
    return f;
  }

  async function buildEntry(fix, scorers, prev) {
    const panel = { tally: null, formH: null, formA: null, statH: '–', statA: '–', stale: false };
    // Tally (curated path never throws; API fallback may).
    try {
      panel.tally = await buildTally(fix);
    } catch (err) {
      console.error('[comingup-qf] tally', err);
      panel.tally = prev?.panel.tally || { curated: false, homeWins: '–', awayWins: '–', draws: '–' };
    }
    // Live half — office only; degrades alone, keeping the previous poll's
    // data if any (renderWc hides the section while formH/formA are null).
    if (!hasWc) return { fix, panel };
    try {
      const season = fix.leagueSeason || 2026;
      const [formH, formA] = await Promise.all([
        fetchForm(fix.home.id, season),
        fetchForm(fix.away.id, season),
      ]);
      panel.formH = formH;
      panel.formA = formA;
      panel.statH = statLine(formH, scorers);
      panel.statA = statLine(formA, scorers);
    } catch (err) {
      console.error('[comingup-qf] wc2026 form', err);
      if (prev?.panel.formH) {
        Object.assign(panel, {
          formH: prev.panel.formH, formA: prev.panel.formA,
          statH: prev.panel.statH, statA: prev.panel.statA,
          stale: true,
        });
      }
    }
    return { fix, panel };
  }

  async function refresh() {
    updatedBadge.textContent = 'Updating…';
    try {
      const res = await fetch(`/api/upcoming-list?count=8&round=${encodeURIComponent(QF_ROUND)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const fixtures = (json.matches || [])
        .filter((m) => !m.isFinished)
        .sort((a, b) => a.kickoffEpoch - b.kickoffEpoch)
        .map((m) => ({ ...m, leagueRound: m.leagueRound || QF_ROUND }));
      if (!fixtures.length) {
        updatedBadge.textContent = 'No upcoming matches';
        return;
      }
      // Scorer leaderboard for the stat lines (office only — skip on foundry).
      const scorers = hasWc
        ? await fetch('/api/topscorers', { cache: 'no-store' })
            .then((r) => r.json()).then((s) => (s.ok ? s.scorers : [])).catch(() => [])
        : [];
      const prevById = new Map(entries.map((e) => [e.fix.fixtureId, e]));
      entries = await Promise.all(fixtures.map((f) => buildEntry(f, scorers, prevById.get(f.fixtureId))));
      writeCache(entries);
      await preloadAllFlags();
      renderCurrent();
      updatedBadge.textContent = 'Just updated';
    } catch (err) {
      console.error('[comingup-qf]', err);
      updatedBadge.textContent = 'Update failed';
    }
  }

  // ── Demo: the REAL four-QF snapshot (fixtures + kickoffs from api-football,
  //    curated tallies, forms baked from /api/form — all captured 2026-07-08).
  //    Stat lines follow the live rules; only FRA has a known leaderboard
  //    scorer (Mbappé 7). Form arrays are newest-first (Norway's L is their
  //    final group game — knockout losers can't be here). ───────────────────
  const DEMO = [
    {
      home: { id: 2, name: 'France' }, away: { id: 31, name: 'Morocco' },
      kickoffISO: '2026-07-09T20:00:00+00:00',
      formH: ['W', 'W', 'W', 'W', 'W'], statH: '14 GF · MBAPPÉ 7',
      formA: ['W', 'W', 'W', 'W', 'D'], statA: 'UNBEATEN IN 5',
    },
    {
      home: { id: 9, name: 'Spain' }, away: { id: 1, name: 'Belgium' },
      kickoffISO: '2026-07-10T19:00:00+00:00',
      formH: ['W', 'W', 'W', 'W', 'D'], statH: 'UNBEATEN IN 5',
      formA: ['W', 'W', 'W', 'D', 'D'], statA: 'UNBEATEN IN 5',
    },
    {
      home: { id: 1090, name: 'Norway' }, away: { id: 10, name: 'England' },
      kickoffISO: '2026-07-11T21:00:00+00:00',
      formH: ['W', 'W', 'L', 'W', 'W'], statH: '12 GF',
      formA: ['W', 'W', 'W', 'D', 'W'], statA: 'UNBEATEN IN 5',
    },
    {
      home: { id: 26, name: 'Argentina' }, away: { id: 15, name: 'Switzerland' },
      kickoffISO: '2026-07-12T01:00:00+00:00',
      formH: ['W', 'W', 'W', 'W', 'W'], statH: '14 GF',
      formA: ['W', 'W', 'W', 'W', 'D'], statA: 'UNBEATEN IN 5',
    },
  ];

  function demoEntries() {
    return DEMO.map((d) => {
      const curated = CURATED_H2H[pairKey(d.home.id, d.away.id)];
      return {
        fix: {
          home: d.home, away: d.away, leagueRound: QF_ROUND,
          kickoffEpoch: new Date(d.kickoffISO).getTime(),
        },
        panel: {
          tally: {
            curated: true,
            homeWins: curated.wins[d.home.id], awayWins: curated.wins[d.away.id],
            draws: curated.draws,
          },
          formH: { form: d.formH.map((r) => ({ result: r })) },
          formA: { form: d.formA.map((r) => ({ result: r })) },
          statH: d.statH, statA: d.statA, stale: false,
        },
      };
    });
  }

  // renderWc expects formH.form; demo panels satisfy that shape directly.

  // ── Boot ─────────────────────────────────────────────────────────────────
  if (isDemo) {
    entries = demoEntries();
    preloadAllFlags().then(() => renderCurrent());
    updatedBadge.textContent = 'Demo';
  } else {
    const cached = readCache();
    if (cached) {
      entries = cached.entries;
      preloadAllFlags().then(() => renderCurrent());
      const mins = Math.floor((Date.now() - cached.ts) / 60000);
      updatedBadge.textContent = mins <= 0 ? 'Just updated' : `Updated ${mins} min${mins > 1 ? 's' : ''} ago`;
    }
    refresh();
    setInterval(refresh, POLL_MS);
  }
  setInterval(rotate, ROTATE_MS);
  setInterval(tick, 1000);
})();
