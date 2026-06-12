# api-football.com Integration

## Endpoints

- **Base:** `https://v3.football.api-sports.io`
- **Auth:** `x-apisports-key` header (server-side only via `/api/match` proxy)
- **Docs:** https://www.api-football.com/documentation-v3

## Key parameters for WC 2026

- `league=1` — FIFA World Cup
- `season=2026` — tournament season
- 104 fixtures populated, 48 teams
- All fixtures `status=NS` until kickoff on **11 June 2026**

## Polling rate

- **Plan limit: 450 req/min, 75,000/day** — verified live from the key's
  `x-ratelimit-limit` / `x-ratelimit-requests-limit` headers (surfaced in
  `/api/match` → `rateLimit`, also as `X-RateLimit-*` response headers).
- Live screens poll the proxy every **10s**. Upstream is NOT hit 6×/min: the
  proxy caches each api-football endpoint ~8s with single-flight, so upstream
  hits stay ~7/min per live fixture **regardless of how many displays poll**.
- api-football updates live data every ~15s, so 10s polling never misses an update.
- Day quota is comfortable: ~7/min × match minutes × concurrent matches stays well under 75k.

## Team IDs

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

> **Australia's team ID is NOT 26** — that's Argentina. Look up the correct AUS ID via `/teams?league=1&season=2026` filtered by `code === 'AUS'` if the codebase still has the old value.

## Group stage round mapping

api-football returns rounds as `"Group Stage - N"` where N is `1..12`. The proxy translates these to letters:

```
1→A   2→B   3→C   4→D   5→E   6→F
7→G   8→H   9→I   10→J  11→K  12→L
```

```js
const GROUP_LETTER = {
  '1':'A','2':'B','3':'C','4':'D','5':'E','6':'F',
  '7':'G','8':'H','9':'I','10':'J','11':'K','12':'L'
};
const groupNum = leagueRound.match(/Group Stage - (\d+)/)?.[1];
const metaGroup = groupNum
  ? `Group ${GROUP_LETTER[groupNum] ?? groupNum}`
  : leagueRound || f.league?.name || '–';
```

Knockout rounds (`Round of 32`, `Round of 16`, `Quarter-finals`, `Semi-finals`, `Final`) pass through unchanged.

## Demo mode

`?demo=1` resolves dynamically (no hardcoded fixture ID) by querying:

```
GET /fixtures?league=1&season=2022&team=26&last=1
```

This returns Argentina's last 2022 WC match — the **2022 Final vs France** (fixture `855750`). Gives a complete payload (events, stats, possession, lineups) for testing UI before tournament starts.

## Coverage flags for WC 2026

Confirmed via `GET /leagues?id=1&season=2026`:

```json
"coverage": {
  "fixtures": {
    "events": true,
    "lineups": true,
    "statistics_fixtures": true,
    "statistics_players": true
  },
  "standings": true,
  "players": true,
  "top_scorers": true
}
```

All required data is supported. Availability per-match may vary early in the tournament.
