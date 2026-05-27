# Conventions

## JavaScript

- **Vanilla JS modules only** — no frameworks (no React, no Vue, no build step)
- ES6+ syntax, native `fetch`, native modules
- Keep client-side files small and split by responsibility (`match-live.js` for polling/render, `flag-global.js` for flag rendering, etc.)

## CSS

- **All Figma px ÷ 2** for CSS (designs are at 2×)
- Use design tokens from `tokens.css` — no hardcoded hex
- Embed fonts as base64 in `typography.css` — no FOUT/FOIT on first paint
- Comment any unusual layout decisions inline

## API

- Polling: never below 30s interval, never above 1/min during live matches
- Always include `?demo=1` fallback for offline / pre-tournament testing
- Comment api-football quirks inline (e.g. group letter mapping, `Group Stage - N` → `Group X`)
- Don't hardcode fixture IDs — resolve dynamically via team+season+last/next/date

## Time zones

All UTC kickoff times from api-football are converted to **Australia/Sydney (AEST/AEDT)** for display. Never display raw UTC.

Helpers in client code:

```js
const AEST = 'Australia/Sydney';

function aestDate(utcMs) {
  return new Date(utcMs).toLocaleDateString('en-AU', {
    weekday:'long', day:'numeric', month:'long', timeZone: AEST
  }).toUpperCase();
  // → "MONDAY 15 JUNE"
}

function aestTime(utcMs) {
  return new Date(utcMs).toLocaleTimeString('en-AU', {
    hour:'2-digit', minute:'2-digit', hour12:true, timeZone: AEST
  }).toUpperCase();
  // → "07:00AM"
}

function fmtUpdated() {
  const now = new Date();
  const t = now.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', timeZone:AEST, hour12:false });
  const d = now.toLocaleDateString('en-AU', { day:'numeric', month:'short', timeZone:AEST });
  return `Updated ${t} ${d}`;
  // → "Updated 14:32 22 May"
}
```

## Flag rendering — three-tier fallback

Defined in `js/flag-global.js`. Each team's flag/logo falls back through:

1. **Primary:** Local circular SVG flag (`FLAG_MAP[team.name]` → `${FLAG_BASE_SVG}{code}.svg`)
2. **Secondary:** Local PNG (same path, `.png` extension)
3. **Tertiary:** api-football team logo CDN — `https://media.api-sports.io/football/teams/{id}.png`

Some countries are in the `API_FALLBACK` set, skipping straight to step 3 (where the SVG flag doesn't render cleanly in a circle — e.g. complex coats of arms).

Helpers: `setFlag()`, `flagImg()`, `getFlagSVG()`.

## Australia at the World Cup

- **Group D** (confirmed)
- Captain: Mathew Ryan
- Head coach: Tony Popovic (appointed Sep 2024)
- 6th consecutive WC appearance
- Best result: Round of 16 (2006, 2022)

## Watch-outs

- The Figma MCP requires `tool_search` first in Claude Code to load
- Multiple Figma frames may have similar names — always use node IDs not names
- api-football fixture IDs are **not sequential by tournament** — never assume `855778` follows `855750`. Always resolve dynamically.
- Polling continues after `FT` status until `isFinished === true` and `period === 'FT'` for at least one cycle, then stops
