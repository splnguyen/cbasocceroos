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

## Group stage round mapping — ⚠️ the round is the MATCHDAY, not the group

For a **fixture**, api-football's `league.round` is `"Group Stage - N"` where **N is the matchday (1–3), NOT the group letter**. Mapping N→letter (e.g. `2`→`B`) is WRONG — it shows a matchday-2 Group E game as "Group B". (This was a real bug in the live screen's `metaGroup`, fixed 2026-06-21.)

There is **no group letter on the fixture object**. Resolve the real group from `/standings`, where each team row carries `group: "Group A".."Group L"` — look it up by team id:

```js
// lib/match-service.js — groupFromStandings(standingsJson, homeId, awayId)
const groups = standingsJson?.response?.[0]?.league?.standings ?? [];
const arr = groups.find((g) => g.some((t) => t.team?.id === homeId || t.team?.id === awayId));
const m = String(arr?.[0]?.group || '').match(/Group\s+([A-L])/i);
return m ? `Group ${m[1].toUpperCase()}` : null;
```

Where the group can't be resolved, emit a neutral `"Group Stage"` / `null` — never a guessed letter. Applied in `fetchMatch` (metaGroup), `fetchUpcoming` + `fetchUpcomingList` (fixture `group`). Knockout rounds (`Round of 32`, `Round of 16`, `Quarter-finals`, `Semi-finals`, `Final`) have no group and pass through as the round name.

(The `GROUP_LETTER` number→letter table IS valid for the **standings** service, where api can return the group as `"Group Stage - N"` and there N really is the group index — see `lib/standings-service.js`.)

## Demo mode

`?demo=1` resolves dynamically (no hardcoded fixture ID) by querying:

```
GET /fixtures?league=1&season=2022&team=26&last=1
```

This returns Argentina's last 2022 WC match — the **2022 Final vs France** (fixture `855750`). Gives a complete payload (events, stats, possession, lineups) for testing UI before tournament starts.

## Head-to-head — ⚠️ record only covers api-football's history window

`GET /fixtures/headtohead?h2h=A-B` returns every meeting **in api-football's
database**, which for national teams only goes back to ~2008 — e.g. France vs
Morocco returns just the 2022 WC semi, not their pre-2008 friendlies. Treat the
aggregate (`/api/h2h`, built in `lib/h2h-service.js`) as "recent record", never
label it "all-time". Shootout (PEN) fixtures are level on `goals.*`; the winner
is in `score.penalty.*` — the service counts shootout wins as wins
(`COUNT_SHOOTOUT_AS_WIN`), unlike FIFA's official records which count draws.
Home/away flip per historical meeting, so the service re-maps every fixture's
sides onto the queried team ids before aggregating.

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
