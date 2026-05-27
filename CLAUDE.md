# CBA Socceroos — FIFA World Cup 2026 Live Screen Dashboard

Static HTML dashboard for the CommBank Socceroos at FIFA World Cup 2026.
Renders on a 1080×1920 portrait monitor, polls api-football via a Vercel proxy.
Tournament window: **11 June – 19 July 2026**.

Sponsor-branded for Commonwealth Bank of Australia (CBA), principal partner of Football Australia.

## Critical rules

- All Figma px values **divide by 2** for CSS (designs are at 2×)
- Polling: **1 call/min** per live fixture, never more
- Times displayed in **AEST/AEDT only** — never raw UTC
- **Vanilla JS only**, no frameworks
- Always include `?demo=1` fallback for offline / pre-tournament testing
- Use design tokens from `tokens.css` — no hardcoded hex
- Comment any api-football quirks inline (e.g. group letter mapping)

## Context files

- `context/deployment.md` — Vercel project, env vars, URLs
- `context/design-system.md` — Figma access, tokens, fonts, 2× rule
- `context/api-football.md` — API integration, team IDs, demo mode, group mapping
- `context/proxy-shape.md` — `/api/match` response contract + fixture resolution chain
- `context/screens.md` — screen-to-Figma-node mapping
- `context/conventions.md` — coding rules, polling, time zones, flag fallback

## Quick orientation

- **Live URL:** https://cbasocceroos.vercel.app/
- **Figma file key:** `eBWaSO7mwm2Ja5NiEFDHAo`
- **API:** api-football.com (`league=1&season=2026`)
- **Australia is in Group D** for WC 2026
