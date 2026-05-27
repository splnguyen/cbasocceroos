# `/api/match` Proxy

Server-side proxy at `/api/match` (Vercel serverless function). Hides the api-football key, resolves which fixture to fetch, and reshapes the response to what the client expects.

Implementation in `lib/match-service.js`.

## Response shape

The client (`js/match-live.js`) reads these fields:

```js
{
  ok: true,
  scoreH, scoreA,                      // numbers
  elapsed, extra,                      // minute counters
  period,                              // "1H" | "HT" | "2H" | "ET" | "P" | "FT" | etc.
  isFinished,                          // boolean
  metaGroup,                           // "Group D" | "Quarter-finals" | etc.
  metaVenue,                           // venue name
  possH, possA,                        // possession %
  shots:   [home, away],
  target:  [home, away],
  corners: [home, away],
  fouls:   [home, away],
  home: { id, name, logo },
  away: { id, name, logo },
  events: [],                          // goals, cards, subs, VAR
  fixtureId,
  fetchedAt,                           // ISO timestamp
  leagueSeason,                        // 2026
  resolvedAs                           // "live" | "today" | "next" | "demo-2022-final"
}
```

If the proxy returns a different shape, the screen will silently show `–` for missing fields without throwing — debug by inspecting the proxy response in DevTools.

## Fixture resolution chain

The proxy tries these in priority order:

1. `?demo=1` → 2022 ARG vs FRA Final (dynamic lookup via `team=26&season=2022&last=1`)
2. `?fixture=<id>` → specific fixture override
3. **Live** Socceroos match — `/fixtures?live=all` filtered to AUS team ID
4. **Today's** Socceroos match — `/fixtures?team=AUS_ID&date=today`
5. **Next** Socceroos match — `/fixtures?team=AUS_ID&next=1`
6. Otherwise: error `"No 2026 fixture found"`

## Demo lookup pattern

Rather than hardcoding a fixture ID (we've burnt ourselves on wrong IDs before — `855778` is a Kyrgyzstan match, not the WC final), the demo resolves dynamically:

```js
async function resolveFixtureId(query, apiKey) {
  if (query.demo === '1' || query.demo === 'true') {
    // Look up Argentina's last match in WC 2022 — always the final
    const demoJson = await apiGet('/fixtures', {
      league: 1, season: 2022, team: 26, last: 1,
    }, apiKey);
    const demoFixture = demoJson.response?.[0];
    if (!demoFixture) throw new Error('Could not resolve 2022 WC Final fixture');
    return { fixtureId: pickFixtureId(demoFixture), resolvedAs: 'demo-2022-final' };
  }
  // ... rest of resolution chain
}
```

## Smoke test

In browser console on the live URL:

```js
fetch('/api/match?demo=1').then(r => r.json()).then(console.log)
```

Expected output: `home.name === 'Argentina'`, `away.name === 'France'`, `metaGroup === 'Final'`, `resolvedAs === 'demo-2022-final'`, `events.length === 15`.
