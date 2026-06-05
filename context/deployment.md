# Deployment

## Vercel

- **Project name:** `cbasocceroos`
- **Live URL:** https://cbasocceroos-test.vercel.app/
- **Stack:** Static HTML + vanilla JS + serverless API route at `/api/match`

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `API_FOOTBALL_KEY` | Vercel env vars + local `.env.local` | api-football.com auth key |

The key is **server-side only** — never exposed to the client. All API calls go through the `/api/match` proxy which injects the header.

## Local development

```bash
vercel dev          # spins up serverless functions locally
```

`.env.local` must contain the API key for local proxy testing.

## File structure

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
│   └── typography.css        # Type scale + font weights (embedded base64 fonts)
├── screen-matchlive.html
├── screen-matchlive-pair.html
├── screen-comingup-single.html
├── screen-comingup-two.html
├── screen-matches-complete-group.html
├── screen-match-complete.html
└── (other screens — see context/screens.md)
```

## Tournament dates

| Date | Phase |
|---|---|
| 11 June 2026 | Tournament kickoff |
| 27 June 2026 | Group stage ends |
| 28 June – 3 July | Round of 32 |
| 4–7 July | Round of 16 |
| 9–11 July | Quarter-finals |
| 14–15 July | Semi-finals |
| 18 July | Third-place playoff |
| 19 July 2026 | Final |
