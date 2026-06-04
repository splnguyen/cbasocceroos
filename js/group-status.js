/**
 * Renders the group-stage state-of-play screen.
 *
 *   data-page="1" → Groups A–F
 *   data-page="2" → Groups G–L  (demo: G–H + 4 'Available in 2026' placeholders)
 *
 * Polls /api/standings every 5 minutes. ?demo=1 swaps in WC 2022 final standings
 * so the screen can be previewed in a finished-stage state before the tournament.
 *
 * Caching: the last good standings payload is cached in localStorage so that
 * when the carousel revisits this screen (each visit reloads the iframe) the
 * table renders instantly from cache instead of flashing the skeleton again.
 * The pulsing skeleton only appears on a true cold load (no cache yet); fresh
 * values re-render whenever the API call returns.
 */

(function () {
  const PAGE_GROUPS = {
    1: ['A', 'B', 'C', 'D', 'E', 'F'],
    2: ['G', 'H', 'I', 'J', 'K', 'L'],
  };
  const POLL_MS = 5 * 60 * 1000; // 5 minutes
  const TEAMS_PER_GROUP = 4;     // WC group size (skeleton row count)
  // qualified at top, then contention, then eliminated — within each, by points desc
  const STATUS_RANK = { qualified: 0, contention: 1, eliminated: 2 };

  const grid = document.getElementById('grid');
  const badge = document.getElementById('updatedBadge');
  const page = Number(document.body.dataset.page || 1);
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  const letters = PAGE_GROUPS[page] || PAGE_GROUPS[1];
  const CACHE_KEY = `cba:standings:v1:demo=${isDemo ? 1 : 0}`;

  let hasData = false; // true once real (or cached) standings are on screen

  // ── Skeleton styles (injected once per document; shared by all 4 screens) ───
  function injectSkeletonStyle() {
    if (document.getElementById('gs-skeleton-style')) return;
    const css = `
      .grow--skeleton { background: rgba(255,255,255,0.04); }
      .grow--skeleton .grow-flag { background: rgba(255,255,255,0.10); }
      .gs-sk { display: inline-block; background: rgba(255,255,255,0.14); border-radius: 6px; }
      .gs-sk--code { width: 46px; height: 22px; }
      .gs-sk-cell { width: 37px; display: flex; justify-content: center; align-items: center; }
      .gs-sk--stat { width: 22px; height: 18px; border-radius: 4px; }
      @keyframes gs-skeleton-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
      .grow--skeleton .grow-flag,
      .grow--skeleton .gs-sk {
        animation: gs-skeleton-pulse 1.4s ease-in-out infinite;
      }`;
    const style = document.createElement('style');
    style.id = 'gs-skeleton-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function sortTeams(teams) {
    return [...teams].sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (s !== 0) return s;
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd  !== a.gd ) return b.gd  - a.gd;
      return b.gf - a.gf;
    });
  }

  function rowHtml(team) {
    const code = teamCode(team.name);
    const cls  = `grow grow--${team.status}`;
    return `
      <div class="${cls}">
        <div class="grow-left">
          <div class="grow-flag"><img alt="${team.name}"></div>
          <div class="grow-code">${code}</div>
        </div>
        <div class="grow-stats">
          <span class="gs-reg">${team.mp}</span>
          <span class="gs-reg">${team.w}</span>
          <span class="gs-reg">${team.d}</span>
          <span class="gs-reg">${team.l}</span>
          <span class="gs-pts">${team.pts}</span>
        </div>
      </div>`;
  }

  function cardHtml(letter, group) {
    const rows = sortTeams(group.teams).map(rowHtml).join('');
    return `
      <div class="gcard" data-group="${letter}">
        <div class="gtitle">Group ${letter}</div>
        <div class="gdivider"></div>
        <div class="gcols">
          <span>MP</span><span>W</span><span>D</span><span>L</span><span>PTS</span>
        </div>
        <div class="grows">${rows}</div>
      </div>`;
  }

  function placeholderHtml(letter) {
    return `
      <div class="gcard gcard--placeholder" data-group="${letter}">
        <div class="gtitle">Group ${letter}</div>
        <div class="gdivider"></div>
        <div class="placeholder-msg">Available in 2026</div>
      </div>`;
  }

  // A single pulsing skeleton row (matches .grow height so nothing jumps when
  // real data replaces it).
  function skeletonRowHtml() {
    const cells = `<span class="gs-sk-cell"><i class="gs-sk gs-sk--stat"></i></span>`.repeat(5);
    return `
      <div class="grow grow--skeleton">
        <div class="grow-left">
          <div class="grow-flag"></div>
          <i class="gs-sk gs-sk--code"></i>
        </div>
        <div class="grow-stats">${cells}</div>
      </div>`;
  }

  function skeletonCardHtml(letter) {
    const rows = Array.from({ length: TEAMS_PER_GROUP }, skeletonRowHtml).join('');
    return `
      <div class="gcard" data-group="${letter}">
        <div class="gtitle">Group ${letter}</div>
        <div class="gdivider"></div>
        <div class="gcols">
          <span>MP</span><span>W</span><span>D</span><span>L</span><span>PTS</span>
        </div>
        <div class="grows">${rows}</div>
      </div>`;
  }

  function paintFlags() {
    grid.querySelectorAll('.grow-flag img').forEach((img) => setFlag(img, img.alt, null));
  }

  function renderSkeleton() {
    grid.innerHTML = letters.map(skeletonCardHtml).join('');
    setBadge('Loading…');
  }

  function render(payload, badgeText = 'Just updated') {
    const byLetter = new Map((payload.groups || []).map((g) => [g.letter, g]));
    const cards = letters.map((L) => {
      const g = byLetter.get(L);
      return g ? cardHtml(L, g) : placeholderHtml(L);
    });
    grid.innerHTML = cards.join('');
    paintFlags();
    setBadge(badgeText);
    hasData = true;
  }

  function renderError(msg) {
    // Only wipe to placeholders if we have nothing real on screen — otherwise
    // keep the cached/previous values visible and just flag the failure.
    if (!hasData) {
      grid.innerHTML = letters.map(placeholderHtml).join('');
    }
    setBadge('Update failed');
    console.error('[group-status]', msg);
  }

  function setBadge(text) {
    if (badge) badge.textContent = text;
  }

  // ── Cache (localStorage, shared across all group-stage iframes) ─────────────

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.payload || !parsed.ts) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeCache(payload) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ payload, ts: Date.now() }));
    } catch (e) {
      /* storage unavailable / quota — caching is best-effort */
    }
  }

  function cacheBadge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins <= 0) return 'Just updated';
    if (mins === 1) return 'Updated 1 min ago';
    return `Updated ${mins} mins ago`;
  }

  // ── Fetching ───────────────────────────────────────────────────────────────

  async function fetchOnce() {
    setBadge('Updating…');
    try {
      const url = isDemo ? '/api/standings?demo=1' : '/api/standings';
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      writeCache(json);
      render(json); // reload values when the API call returns
    } catch (err) {
      renderError(err.message || String(err));
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  injectSkeletonStyle();

  const cached = readCache();
  if (cached) {
    // Carousel revisit (or warm load) → show cached values immediately, no
    // skeleton flash.
    render(cached.payload, cacheBadge(cached.ts));
  } else {
    // True cold load → pulsing skeleton while the first fetch lands.
    renderSkeleton();
  }

  // Only hit the network on mount if we have no cache or it's gone stale; this
  // is what stops a fresh reload on every carousel hit. The interval keeps it
  // current while the screen stays mounted.
  const isStale = !cached || (Date.now() - cached.ts) > POLL_MS;
  if (isStale) fetchOnce();
  setInterval(fetchOnce, POLL_MS);
})();
