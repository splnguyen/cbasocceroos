# Project Status — CBA Socceroos WC2026 Live Dashboard

_Quick-context handoff doc for Claude. Last reviewed: 2026-06-21 (tournament is LIVE — kicked off 11 June, group stage ends ~27/28 June)._

Read this first, then `CLAUDE.md` + the `context/*.md` files for detail. This doc summarizes **where the code is** and **what you need to know to keep working**.

---

## What this is

Static HTML dashboard for the CommBank Socceroos at FIFA World Cup 2026. Renders on **1080×1920 portrait** monitors in CBA offices + the "Foundry" displays. Polls api-football through Vercel serverless proxies. **Vanilla JS only, no build step, no frameworks.**

- **Live URL:** https://cbasocceroos-test.vercel.app/
- **Vercel project:** `cbasocceroos` · env var `API_FOOTBALL_KEY` (server-side only)
- **Figma file key:** `eBWaSO7mwm2Ja5NiEFDHAo`
- **API:** api-football.com, `league=1 season=2026`. Plan = **450 req/min, 75,000/day**.
- **Australia is Group D.** AUS team ID is **NOT 26** (that's Argentina) — resolve via `/teams` if needed.

## Run / deploy

```bash
npm run dev          # node server.js → http://localhost:3000 (loads .env.local)
npm run dev:vercel   # vercel dev (real serverless emulation)
npm run deploy       # vercel
```

`server.js` is a hand-rolled local mirror of the Vercel functions — it must stay in sync with `api/*.js` (both call the same `lib/*-service.js`). `.env.local` needs `API_FOOTBALL_KEY`.

---

## Architecture

```
Browser screen (HTML + js/*.js)  ──poll──>  /api/* (Vercel fn or server.js)
                                                 └──> lib/*-service.js ──> api-football v3
```

### Backend (proxies + services)
| Endpoint (`api/*.js`) | Service (`lib/*.js`) | Purpose |
|---|---|---|
| `/api/match` | `match-service.js::fetchMatch` | Single fixture, reshaped (score/stats/events). Fixture resolution chain (demo → fixture → live → today → next). |
| `/api/live` | `match-service.js::fetchLive` | `{count, fixtures[]}` of live WC2026 fixtures, **Australia-first**. Drives the carousels' live override. |
| `/api/upcoming`, `/api/upcoming-list` | `match-service.js` | Next kickoff(s). |
| `/api/standings` | `standings-service.js` | Group tables. |
| `/api/topscorers` | `topscorers-service.js` | Golden Boot. |
| `/api/topkeepers` | `topkeepers-service.js` | Golden Glove (sweeps `/players`; throttled to avoid 429; `maxDuration:30` in vercel.json). |

`lib/match-service.js` (~34KB) is the heart: fixture resolution, ~8s response cache + single-flight (keeps upstream ~7/min per live fixture regardless of display count), group-letter mapping (`Group Stage - N` → `Group A..L`), rate-limit snapshot (`getLastRateLimit()`), synthetic event ticker for the live feed. The `?demo=1` path resolves the **2022 ARG–FRA final dynamically** (never hardcode fixture IDs — we've been burned by wrong IDs).

### Frontend
- **`index.html`** (~300KB, the office orchestrator) — inline controller runs a **phase carousel + live state machine**. See "Orchestration" below. This is the main display; most screens are also embedded inline as carousel slides.
- **`js/*.js`** — per-screen render/poll logic (`match-live.js` is the big one ~24KB; others per screen).
- **`screen-*.html`** — standalone full-screen versions of each screen (also used directly by the carousel via iframe-like `goToScreen` src-swap, and for QA via the scenario dropdown).
- **`foundry-1.html`** — second orchestrator for Foundry-branded displays (mirrors the office live state machine, standalone, no `?office`). `foundry-2/3.html` are still dumb carousels (group tables), **not yet wired for live**.
- **`tokens.css`** (design tokens — white/grey/brand-yellow `#ffff00`, no hardcoded hex), **`fonts.css`** / **`typography.css`** (base64-embedded fonts, no FOUT).

---

## Orchestration (index.html controller) — the part to understand

Polls `/api/live`; a live match **overrides** the idle carousel.

- **Phases** (`getPhase()`): `pre-tournament` → `group-stage` (until `GROUP_STAGE_END` = ~28 Jun) → `knockout`. Each maps to a playlist in `PHASE_PLAYLISTS` / `GROUP_STAGE_PLAYLISTS` (45s/screen).
- **Live override:** 0 live → rotate carousel, idle poll (`IDLE_POLL_MS` 5min); 1 live → full-screen `screen-matchlive.html?poll=10`; 2+ live → `screen-matchlivepair.html` with primary/secondary pinned (`?fixture=&other=`), poll `LIVE_POLL_MS` 10s.
- **Pre-kickoff ramp:** within `PREKICKOFF_WINDOW_MS` (60s) of next scheduled kickoff, idle polling ramps to `PREKICKOFF_POLL_MS` (5s) so the flip is instant. `nextPollDelay(count)` picks cadence; `refreshNextKickoff()` pulls next KO from `/api/upcoming` (falls back to `FIRST_MATCH_KICKOFF`). Note: actual live switch is driven by `/api/live`, **not the clock** — the clock is only a phase/ramp proxy.
- **Two offices, one file:** `?office=1` (default) / `?office=2`. In dual-live, office 2 swaps primary/secondary so both matches are covered. `PRIMARY_OVERRIDES` (keyed by sorted `"<idA>-<idB>"`) pins a specific match as office-1 primary for a known pairing.
- **Testing params:** `?demo=1` (propagates 2022-final demo to every screen), `?simulate=0|1|2` (force live count using 2022 fixtures), `?office=1|2`.

Constants live near the top of the `<script>` in `index.html` (search `PHASE_PLAYLISTS`, `IDLE_POLL_MS`, `nextPollDelay`).

---

## Conventions (non-negotiable)

- **Figma px ÷ 2** for CSS (designs are at 2×).
- **Vanilla JS only**, ES6, native `fetch`. No frameworks/build.
- **Times in AEST/AEDT only** (`Australia/Sydney`) — never raw UTC. Helpers in `context/conventions.md`.
- **Design tokens only** — no hardcoded hex; pull from `tokens.css`.
- **Always support `?demo=1`** for offline testing.
- **Never hardcode fixture IDs** — resolve dynamically (team+season+last/next/date).
- **Flags:** three-tier fallback in `js/flag-global.js` (local SVG → local PNG → api-football logo CDN); `API_FALLBACK` set skips straight to CDN for complex crests.
- Figma MCP needs `tool_search` to load first; always reference nodes by **ID, not name**.

---

## Screens (standalone files + Figma nodes)

`context/screens.md` has the full node map. Key ones: `screen-matchlive.html` (`2016:3326`), `screen-matchlivepair.html` (`830:7714`), `screen-comingup*.html` (`770:905`/`770:994`), `screen-matchcomplete.html` (`830:6854`), `screen-matchescomplete.html` (`830:6316`), `screen-groupstatus-1/2.html` (`770:4016`), `screen-topscorers.html` / `screen-topkeepers.html`, `screen-tournament-countdown.html`, `screen-tournament-draw.html`, plus `-foundry` clones. Each has a top-right scenario dropdown for state preview.

## QA scripts (`scripts/`, untracked)
- `check-screens.js` — Playwright sweep of every `screen-*.html?demo=1`, flags error/loading text. Needs a local server (hardcoded port `65268` — adjust to your `npm run dev` port).
- `export-screens.js`, `recapture-comingup.js` — screenshot capture → `screenshots/`.

---

## Recent work (last commits)
Top Scorers/Keepers co-leader highlighting · group tables Goal Difference column · LIVE badge / yellow subheaders polish · local-ticking match clock with forward-only re-sync · carousels switch to Match Live at scheduled kickoff. The trajectory has been **live-match UX polish + leaderboards**.

## Group-stage qualification logic (`lib/standings-service.js`)
`computeStatuses()` labels each team `qualified` / `contention` / `eliminated` for the group tables. As of the latest pass it is **fixture-aware**: `fetchStandings` also pulls unplayed (`NS`) fixtures and `computeStatusesByFixtures()` enumerates every W/D/L outcome of the group's *actual* remaining matches (3^k scenarios), then:
- `qualified` → guaranteed top-2 in **every** scenario,
- `eliminated` → guaranteed 4th (last) in every scenario,
- else `contention`.

Why fixture-aware matters: two chasers who play each other can't both win, so a leader can be safe earlier than a per-rival points-ceiling model can prove (e.g. USA qualified once AUS & PAR were left playing each other on the final day). Ties on points are resolved **adversarially** (assume tiebreakers go against the team) → a side safe only on goal difference shows `contention`, never a false `qualified`. Fixtures map to groups via each group's own team-ID set (the round string is the matchday, not the group letter). If the `/fixtures` call fails, it degrades to the conservative `computeStatusesByCeiling()` fallback. **Server-side — needs `npm run deploy` to reach live screens.**

Still open (all require **cross-group** best-third math, i.e. "option 2"):
- `qualified` means "locked top 2," **not** "definitely in the Round of 32" (ignores the 8 best-third slots, so a strong 3rd-place team still shows `contention`).
- A **GD-aware** refinement would let `qualified`/`eliminated` resolve the on-points ties the adversarial model leaves open (would likely flip Group B to CAN/SUI qualified).
- The **all-matches-played branch** (`computeStatuses`, defers to api `rank`) still marks rank 3 **and** 4 as `eliminated` once a group finishes — so the "no two eliminated per group" invariant holds only mid-tournament, not in the finished state.

api-football has **no endpoint** that returns mathematical qualification — `/standings` only has a per-team `description` ("Round of 32" for whoever's currently rank 1-2, `null` otherwise), which is position-based, ignores best-thirds, and can't distinguish "locked" from "currently 2nd." The math must stay ours.

## Known open items / watch-outs
- **`screen-topscorers.html` never reconciled against Figma node `2055-9000`** (Figma was rate-limited when built). Layout choices (Golden Boot meta-row, yellow #1 tint, 8×160px tiles) are guesses — reconcile when Figma access is up. See memory `topscorers-figma-alignment`.
- **`foundry-2/3.html` not wired for live** — only `foundry-1.html` mirrors the office live machine.
- `server.js` and `api/*.js` are parallel implementations over the same services — **change both** when adding/altering an endpoint.
- Working tree currently has untracked `scripts/` + `screenshots/` and a deleted `.claude/scheduled_tasks.lock` — not committed.
- Polling continues after `FT` until `isFinished===true && period==='FT'` for one cycle, then stops.

## Smoke test
```js
// in browser console on live URL
fetch('/api/match?demo=1').then(r=>r.json()).then(console.log)
// expect: home.name==='Argentina', away.name==='France', metaGroup==='Final',
//         resolvedAs==='demo-2022-final', events.length===15
```
