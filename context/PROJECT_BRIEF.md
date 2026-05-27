# CBA Socceroos — FIFA World Cup 2026 Live Screen Dashboard

## Purpose

A suite of static HTML screens that broadcast live FIFA World Cup 2026 match information for the **CommBank Socceroos** (Australia men's national football team). Screens render full-screen on a **1080×1920 portrait monitor**, polling a serverless proxy for real-time match data from api-football.com during Socceroos fixtures and surrounding matches in Group D.

The dashboard is sponsor-branded for **Commonwealth Bank of Australia (CBA)**, the principal partner of Football Australia. It needs to be rock-solid from **11 June 2026** (tournament kickoff) through **19 July 2026** (final).

## Deployment

- **Hosting:** Vercel
- **Live URL:** https://cbasocceroos.vercel.app/
- **Project name:** `cbasocceroos`
- **Stack:** Static HTML + vanilla JS + serverless API route at `/api/match`

## Display Specs

| Property | Value |
|---|---|
| Output resolution | 1080 × 1920 (portrait) |
| Figma design scale | 2× (designed at 2160 × 3840) |
| **All Figma values must be divided by 2 for CSS px** | |
| Font family | CBABeaconSans (weights 400/700/800/900, embedded base64) |
| Design tokens | `tokens.css`, `typography.css` |

### Key colour tokens

- `--dark-grey` `#727272`
- `--purple-bright` `#6951ff` (away team accent)

## Design Source

- **Figma file key:** `eBWaSO7mwm2Ja5NiEFDHAo`
- **Page:** 2026 Mens World Cup – Schematics
- **Access:** Figma MCP (`Figma:get_design_context`) — must call `tool_search` first to load Figma tools

### Screens built

| Screen | Figma node | Purpose |
|---|---|---|
| `state-matchlive_01` | `2016:3326` (current) | Single live match — score, possession, stats, events feed |
| `state-matchlive_pair` | `830:7714` | Two simultaneous live matches |
| `state-comingup-singlematch` | `770:905` | Pre-match countdown — one match |
| `state-comingup-2matches` | `770:994` | Pre-match countdown — two matches |
| `state-matches-complete-group` | `830:6316` | Group stage results summary |
| `state-match-complete` | `830:6854` | Single full-time recap |
| Goal overlay animation | `2012:3016` | Goal celebration overlay |
| Knockout coming-up variants | `2012:3131`, `2012:3278` | Knockout-round pre-match |
| Group stage tables | `770:4016` | Live group standings |

## Data Source — api-football.com

### Endpoints

- Base: `https://v3.football.api-sports.io`
- Auth: `x-apisports-key` header (stored in Vercel env vars + `.env.local`)
- Proxy: `/api/match` on the Vercel deployment (server-side, hides key)

### Key parameters for WC 2026

- `league=1` — FIFA World Cup
- `season=2026` — tournament season
- 104 fixtures populated, 48 teams, status=NS until 11 June 2026
- Live data starts flowing from kickoff: 11 June 2026

### Polling

- Recommended rate: **1 call/minute per fixture in progress**
- API update frequency: every 15 seconds
- Watch quota on busy match days (multiple groups playing simultaneously) — roughly 2–4k requests possible

### Team IDs (confirmed)

| Team | api-football ID |
|---|---|
| France | 2 |
| Brazil | 6 |
| Serbia | 14 |
| Switzerland | 15 |
| Denmark | 21 |
| Argentina | 26 |
| Tunisia | 29 |
| Cameroon | 111 |

### ⚠️ KNOWN ISSUE — Australia team ID

The codebase currently has `australia: { id: 26 }` in the `TEAMS` const — but **26 is Argentina**, not Australia. This is a leftover bug. The demo mode (`?demo=1`) uses `team=26` to look up "Argentina's last match in WC 2022" which correctly returns the 2022 Final.

**Action required:** Look up the correct Australia team ID before live tournament, then update:

1. `lib/match-service.js` — `DEFAULT_TEAM` constant
2. `js/match-live.js` — `TEAMS.australia.id` and all logo URLs derived from it
3. Any scenario data using `TEAMS.australia.id` for events, lineups, player stats

To find the correct ID, run in a browser console with API key available:

```js
fetch('https://v3.football.api-sports.io/teams?league=1&season=2026', {
  headers: { 'x-apisports-key': 'YOUR_KEY' }
})
  .then(r => r.json())
  .then(d => {
    const aus = d.response.find(t => t.team.code === 'AUS');
    console.log('Australia ID:', aus?.team.id);
  });
```

### Group stage round mapping

api-football returns rounds as `"Group Stage - N"` where N is `1..12`. The proxy translates these to letters:

```
1→A  2→B  3→C  4→D  5→E  6→F
7→G  8→H  9→I  10→J 11→K 12→L
```

Knockout rounds (`Round of 32`, `Round of 16`, `Quarter-finals`, `Semi-finals`, `Final`) pass through unchanged.

### Demo mode

`?demo=1` resolves dynamically (no hardcoded fixture ID) by querying:

```
GET /fixtures?league=1&season=2022&team=26&last=1
```

This returns Argentina's last 2022 WC match — the Final vs France (fixture **855750**). This gives a complete payload (events, stats, possession, lineups) for testing UI before tournament starts.

## File Structure

```
/
├── api/
│   └── match.js              # Vercel serverless proxy entry
├── lib/
│   └── match-service.js      # API resolution + data shaping
├── js/
│   ├── match-live.js         # Client-side polling + render
│   └── flag-global.js        # Flag SVG/PNG/api-logo fallback chain
├── css/
│   ├── tokens.css            # Design tokens (colours, spacing)
│   └── typography.css        # Type scale + font weights
├── screen-matchlive.html
├── screen-matchlive-pair.html
├── screen-comingup-single.html
├── screen-comingup-two.html
├── screen-matches-complete-group.html
├── screen-match-complete.html
└── (other screens)
```

## API Proxy Response Shape

The client (`match-live.js`) expects the proxy to return:

```js
{
  ok: true,
  scoreH, scoreA,                      // numbers
  elapsed, extra,                      // minute counters
  period,                              // "1H" | "HT" | "2H" | "ET" | "P" | etc.
  isFinished,                          // boolean
  metaGroup,                           // "Group D" | "Quarter-finals" | etc.
  metaVenue,                           // venue name
  possH, possA,                        // possession %
  shots: [home, away],                 // array of [home, away]
  target: [home, away],
  corners: [home, away],
  fouls: [home, away],
  home: { id, name, logo },
  away: { id, name, logo },
  events: [],                          // goals, cards, subs, VAR
  fixtureId,
  fetchedAt,                           // ISO timestamp
  leagueSeason,                        // 2026
  resolvedAs                           // "live" | "today" | "next" | "demo-2022-final"
}
```

### Fixture resolution chain (in priority order)

1. `?demo=1` → 2022 ARG vs FRA final
2. `?fixture=<id>` → specific fixture
3. Live Socceroos match (`/fixtures?live=all` filtered to AUS team ID)
4. Today's Socceroos match (`/fixtures?team=AUS_ID&date=today`)
5. Next Socceroos match (`/fixtures?team=AUS_ID&next=1`)
6. Otherwise: error `"No 2026 fixture found"`

## Flag Rendering Strategy

Three-tier fallback for each team's flag/logo:

1. **Primary:** Local circular SVG flag from `FLAG_MAP`
2. **Secondary:** Local PNG (same path, `.png` extension)
3. **Tertiary:** api-football team logo CDN — `https://media.api-sports.io/football/teams/{id}.png`

Defined in `flag-global.js` — `setFlag()`, `flagImg()`, `getFlagSVG()`. Some countries are in the `API_FALLBACK` set, skipping straight to step 3 (where the SVG flag doesn't render cleanly in a circle, e.g. complex coats of arms).

## Time Zone

All UTC kickoff times from api-football are converted to **Australia/Sydney (AEST/AEDT)** for display.

Helpers in client code:
- `aestDate(utcMs)` — formats `"MONDAY 15 JUNE"`
- `aestTime(utcMs)` — formats `"07:00AM"`
- `fmtUpdated()` — small "Updated 14:32 22 May" stamp for footer

## Australia at the World Cup

- **Group D** (confirmed)
- Captain: Mathew Ryan
- Head coach: Tony Popovic (appointed Sep 2024)
- 6th consecutive WC appearance
- Best result: Round of 16 (2006, 2022)

## Coding Conventions

- Vanilla JS modules only — no framework
- All Figma px values must be divided by 2 for CSS
- Use design tokens from `tokens.css` — no hardcoded hex
- Embed fonts as base64 in `typography.css` (no FOUT/FOIT on first paint)
- Comment any api-football quirks inline (e.g. group letter mapping)
- Polling: never below 30s interval, never above 1/min during live matches
- Always include `?demo=1` fallback path for offline / pre-tournament testing
- Date formatting: AEST/AEDT only — never raw UTC

## Tournament Dates

- **11 June 2026** — Tournament kickoff (USA vs ?)
- **27 June 2026** — Group stage ends
- **28 June – 3 July** — Round of 32
- **4–7 July** — Round of 16
- **9–11 July** — Quarter-finals
- **14–15 July** — Semi-finals
- **18 July** — Third-place playoff
- **19 July 2026** — Final
