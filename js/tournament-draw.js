/**
 * Tournament Draw — full vertical bracket.
 *
 *   R32 (top)  →  R16 (top)  →  QF (top)  →  SF1
 *                                              ↓
 *                                            FINAL
 *                                              ↑
 *   R32 (bot)  ←  R16 (bot)  ←  QF (bot)  ←  SF2
 *
 * Modes
 *   default (live) — pre-tournament, every slot is TBC.
 *   ?demo=1        — 2022 WC actual bracket (R16 onward; 2022 had no R32 so
 *                    the R32 strips stay TBC).
 *
 * Winner/loser styling per Figma annotation:
 *   - winner side: white flag + white/yellow code
 *   - loser side:  mid-grey code + desaturated flag (greyscale 1 + opacity)
 */

(function () {
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';

  // ── 2022 WC bracket data ─────────────────────────────────────────────────
  // winner: 'home' | 'away' | null (TBC).  PEN/AET decided handled by the
  // visual treatment only — we just record who advanced.
  const BLANK = { home: null, away: null, winner: null };
  const blanks = (n) => Array(n).fill(0).map(() => ({ ...BLANK }));

  const DEMO_2022 = {
    // 2022 World Cup had no Round of 32 — keep blank.
    r32_top: blanks(8),
    r16_top: [
      { home: 'Netherlands', away: 'USA',         winner: 'home' },
      { home: 'Argentina',   away: 'Australia',   winner: 'home' },
      { home: 'France',      away: 'Poland',      winner: 'home' },
      { home: 'England',     away: 'Senegal',     winner: 'home' },
    ],
    qf_top: [
      { home: 'Netherlands', away: 'Argentina',   winner: 'away' }, // ARG on pens
      { home: 'France',      away: 'England',     winner: 'home' },
    ],
    sf_top: { home: 'Argentina',   away: 'Croatia', winner: 'home' }, // ARG 3-0
    final:  { home: 'Argentina',   away: 'France',  winner: 'home' }, // ARG 4-2 on pens
    sf_bot: { home: 'France',      away: 'Morocco', winner: 'home' }, // FRA 2-0
    qf_bot: [
      { home: 'Croatia',     away: 'Brazil',      winner: 'home' }, // CRO on pens
      { home: 'Morocco',     away: 'Portugal',    winner: 'home' }, // MAR 1-0
    ],
    r16_bot: [
      { home: 'Japan',       away: 'Croatia',     winner: 'away' }, // CRO on pens
      { home: 'Brazil',      away: 'South Korea', winner: 'home' },
      { home: 'Morocco',     away: 'Spain',       winner: 'home' }, // MAR on pens
      { home: 'Portugal',    away: 'Switzerland', winner: 'home' },
    ],
    r32_bot: blanks(8),
  };

  const LIVE_TBC = {
    r32_top: blanks(8),  r16_top: blanks(4),  qf_top:  blanks(2),  sf_top: { ...BLANK },
    final:   { ...BLANK },
    sf_bot:  { ...BLANK },  qf_bot:  blanks(2),  r16_bot: blanks(4),  r32_bot: blanks(8),
  };

  const data = isDemo ? DEMO_2022 : LIVE_TBC;

  // ── Cell renderers ───────────────────────────────────────────────────────
  function cellSmall(match) {
    // R32 card (small): flag — VS — flag, vertically stacked
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--small">
        ${cellSmallSide(match.home, homeLoser, tbc)}
        <div class="vs">VS</div>
        ${cellSmallSide(match.away, awayLoser, tbc)}
      </div>`;
  }
  function cellSmallSide(name, loser, tbc) {
    if (!name) {
      return `<div class="bteam-small ${tbc ? 'tbc' : ''}"><div class="bflag bflag--xs"></div></div>`;
    }
    return `
      <div class="bteam-small ${loser ? 'loser' : ''}">
        <div class="bflag bflag--xs"><img alt="${name}"></div>
      </div>`;
  }

  function cellMid(match) {
    // R16 / R32-bot card (horizontal): [flag CODE] VS [flag CODE]
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--mid">
        ${cellMidSide(match.home, homeLoser, tbc, 'home')}
        <div class="vs ${tbc ? 'tbc' : ''}">VS</div>
        ${cellMidSide(match.away, awayLoser, tbc, 'away')}
      </div>`;
  }
  function cellMidSide(name, loser, tbc, side) {
    if (!name) {
      return `
        <div class="bteam-mid ${side} tbc">
          <div class="bflag bflag--sm"></div>
          <span class="bcode">TBC</span>
        </div>`;
    }
    return `
      <div class="bteam-mid ${side} ${loser ? 'loser' : ''}">
        <div class="bflag bflag--sm"><img alt="${name}"></div>
        <span class="bcode">${teamCode(name)}</span>
      </div>`;
  }

  function cellLarge(match) {
    // QF / SF card: [CODE flag] VS [flag CODE], bigger flags + codes
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--large">
        ${cellLargeSide(match.home, homeLoser, tbc, 'home')}
        <div class="vs vs--lg ${tbc ? 'tbc' : ''}">VS</div>
        ${cellLargeSide(match.away, awayLoser, tbc, 'away')}
      </div>`;
  }
  function cellLargeSide(name, loser, tbc, side) {
    if (!name) {
      return `
        <div class="bteam-lg ${side} tbc">
          ${side === 'home' ? `<span class="bcode bcode--lg">TBC</span>` : ''}
          <div class="bflag bflag--md"></div>
          ${side === 'away' ? `<span class="bcode bcode--lg">TBC</span>` : ''}
        </div>`;
    }
    return `
      <div class="bteam-lg ${side} ${loser ? 'loser' : ''}">
        ${side === 'home' ? `<span class="bcode bcode--lg">${teamCode(name)}</span>` : ''}
        <div class="bflag bflag--md"><img alt="${name}"></div>
        ${side === 'away' ? `<span class="bcode bcode--lg">${teamCode(name)}</span>` : ''}
      </div>`;
  }

  function cellFinal(match) {
    const homeLoser = match.winner === 'away';
    const awayLoser = match.winner === 'home';
    const tbc = !match.home && !match.away;
    return `
      <div class="bcard bcard--final">
        ${cellFinalSide(match.home, homeLoser, tbc, 'home')}
        <div class="vs vs--final">VS</div>
        ${cellFinalSide(match.away, awayLoser, tbc, 'away')}
      </div>`;
  }
  function cellFinalSide(name, loser, tbc, side) {
    if (!name) {
      return `
        <div class="bteam-final ${side} tbc">
          ${side === 'home' ? `<span class="bcode bcode--xl">TBC</span>` : ''}
          <div class="bflag bflag--xl"></div>
          ${side === 'away' ? `<span class="bcode bcode--xl">TBC</span>` : ''}
        </div>`;
    }
    return `
      <div class="bteam-final ${side} ${loser ? 'loser' : ''}">
        ${side === 'home' ? `<span class="bcode bcode--xl">${teamCode(name)}</span>` : ''}
        <div class="bflag bflag--xl"><img alt="${name}"></div>
        ${side === 'away' ? `<span class="bcode bcode--xl">${teamCode(name)}</span>` : ''}
      </div>`;
  }

  // ── Render full bracket ──────────────────────────────────────────────────
  function rowOf(matches, kind, columns) {
    const cells = matches.map(kind === 'small' ? cellSmall : kind === 'mid' ? cellMid : cellLarge);
    if (columns === 'pairs') {
      // 8 → 4 pairs of 2; 4 → 2 pairs of 2
      const out = [];
      for (let i = 0; i < cells.length; i += 2) {
        out.push(`<div class="bpair">${cells[i]}${cells[i+1] || ''}</div>`);
      }
      return out.join('');
    }
    return cells.join('');
  }

  function render() {
    const root = document.getElementById('bracket');
    root.innerHTML = `
      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 32</span><span class="bline"></span></div>
        <div class="brow brow--r32">${rowOf(data.r32_top, 'small', 'pairs')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 16</span><span class="bline"></span></div>
        <div class="brow brow--r16">${rowOf(data.r16_top, 'mid')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">QUARTER FINALS</span><span class="bline"></span></div>
        <div class="brow brow--qf">${rowOf(data.qf_top, 'large')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">SEMI FINAL 1</span><span class="bline"></span></div>
        <div class="brow brow--sf">${cellLarge(data.sf_top)}</div>
      </section>

      <section class="bround bround--final">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">FINAL</span><span class="bline"></span></div>
        <div class="brow brow--final">${cellFinal(data.final)}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">SEMI FINAL 2</span><span class="bline"></span></div>
        <div class="brow brow--sf">${cellLarge(data.sf_bot)}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">QUARTER FINALS</span><span class="bline"></span></div>
        <div class="brow brow--qf">${rowOf(data.qf_bot, 'large')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 16</span><span class="bline"></span></div>
        <div class="brow brow--r16">${rowOf(data.r16_bot, 'mid')}</div>
      </section>

      <section class="bround">
        <div class="bround-label"><span class="bline"></span><span class="bround-name">ROUND OF 32</span><span class="bline"></span></div>
        <div class="brow brow--r32">${rowOf(data.r32_bot, 'small', 'pairs')}</div>
      </section>`;

    // Paint flags (3-tier fallback handled by flag-global.js)
    root.querySelectorAll('.bflag img').forEach((img) => setFlag(img, img.alt, null));
    document.getElementById('updatedBadge').textContent = isDemo ? 'Demo · 2022' : 'Just updated';
  }

  render();
})();
