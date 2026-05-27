# Screens

Each screen is a standalone HTML file rendered full-screen at 1080×1920 portrait. All link `tokens.css` + `typography.css` externally and use a scenario dropdown (top-right) for demo / state preview.

## Screen ↔ Figma node mapping

| Screen | Figma node | Purpose |
|---|---|---|
| `screen-matchlive.html` | `2016:3326` | Single live match — score, possession, stats, events feed |
| `screen-matchlive-pair.html` | `830:7714` | Two simultaneous live matches |
| `screen-comingup-single.html` | `770:905` | Pre-match countdown — one match |
| `screen-comingup-two.html` | `770:994` | Pre-match countdown — two matches |
| `screen-matches-complete-group.html` | `830:6316` | Group stage results summary |
| `screen-match-complete.html` | `830:6854` | Single full-time recap |
| Goal overlay animation | `2012:3016` | Goal celebration overlay |
| Knockout coming-up (single) | `2012:3131` | Knockout-round pre-match variant |
| Knockout coming-up (pair) | `2012:3278` | Knockout-round pre-match variant |
| Group stage tables | `770:4016` | Live group standings |

## Demo scenarios

The matchlive screen embeds 2022 WC Final scenarios for offline testing:

- `h1_23` — Di María goal at 23'
- `h1_36` — Messi penalty at 36'
- `halftime` — HT 2–0
- `h2_80` — Mbappé hat-trick at 80'
- `h2_90` — FT 2–2
- `extra_time` — Messi scores in ET
- `full_time` — Final state with all events

Real `REAL_EVENTS` array has Di María, Messi penalty, Mbappé hat-trick, Montiel yellow card, Messi extra time goal, etc.

## Figma access workflow

1. Call `tool_search` first to load Figma MCP tools in Claude Code
2. Use `Figma:get_design_context` with the node ID
3. All returned px values are at 2× — divide by 2 for CSS
