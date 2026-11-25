# Win-chance calibration back-test

Does a quoted 60% win about 60% of the time? This back-tests the weekly matchup model (`engine/src/matchup.ts`, `anycat.ts`) on the real 2025-26 season. It only **measures**: nothing in the engine was tuned. Script: `engine/scripts/calibration-backtest.ts` (data export command in its header). Closes issue #9.

## Method

- Data: every player game of 2025-26 (`nba_data.v_player_daily_game_stats`), 18 full weeks from 2025-11-24 to 2026-04-06 (the first 5 weeks only feed the season-to-date averages; the first and last part-weeks are dropped).
- For each week, the 182 best players by value on games **before** that week (at least 15 prior games) form the pool. 1,000 random pairs of 13-player rosters per week, 18,000 matchups per scoring system. Players on the same roster are never shared, and every roster plays all 13 (no benching).
- The quote uses only pre-week information: each player's season-to-date per-game averages and a game count. The engine runs its normal 2,000 simulated weeks per matchup.
- The outcome is the real week: each side's sum of its players' actual stats that week. Win = more categories (5 of 9 for the standard nine) or more points.
- Two ways to count games, because they answer different questions:
  - **schedule** (`--games team`): each player gets his NBA team's real number of games that week. This is exactly what the product does, so it is the honest end-to-end test. Missed games (injury, rest, trade) are not modelled.
  - **played** (`--games player`): each player gets the games he really played. The luck numbers in the engine were measured this way (after removing games played), so this isolates the luck model. It uses hindsight about who played, so it is **not** a forecast, only a check that the luck table is right.
- Standard errors are by week (resampling the 18 weeks), because matchups in the same week share players and are not independent. The plain binomial SE is about the same or smaller, but understates the uncertainty.
- Caveat: the luck table was measured on this same season, so the "played" result is partly in-sample. The "schedule" result is not tuned on anything but the luck table.

**Calibration slope**: the least-squares slope of (actual - 0.5) on (quote - 0.5). 1.0 is perfectly calibrated, below 1 means the quotes are overconfident (a quoted 80% really wins less than 80%).

## Result in one paragraph

With real schedule game counts, quotes are **overconfident**: slope 0.61 for the standard nine (0.60 custom categories, 0.57 points). A quoted 90-100% won 81%, a quoted 80-90% won 71%, a quoted 60-70% won 55%, and a quoted 0-10% won 19%. Close calls (40-60%) are fine. The quotes beat a coin flip (Brier 0.235 vs 0.250) but only barely. When the real games played are used instead, the same model is close to calibrated (slope 0.94-0.96; a quoted 90-100% won 94-96%), with a small residual overconfidence of 2 to 5 points in the high buckets. So the **luck table is about right; the gap comes from not knowing who plays** (injuries, rest, and players who miss part of a week), which the engine deliberately treats as outside the model.

## Standard nine, week win chance

**Schedule games (what the product does)**. Brier 0.2348 vs 0.2500 for a coin flip, slope 0.61.

| Quoted chance | Matchups | Mean quote | Actual win rate | SE (by week) |
|---|---|---|---|---|
| 0-10% | 1110 | 5.7% | 19.1% | ±2.2 |
| 10-20% | 1682 | 15.2% | 28.6% | ±1.7 |
| 20-30% | 1933 | 25.1% | 35.7% | ±1.2 |
| 30-40% | 2078 | 35.0% | 38.5% | ±1.1 |
| 40-50% | 2148 | 44.9% | 45.7% | ±1.1 |
| 50-60% | 2147 | 55.0% | 51.1% | ±0.8 |
| 60-70% | 2161 | 65.0% | 55.3% | ±1.2 |
| 70-80% | 1896 | 74.8% | 61.0% | ±1.2 |
| 80-90% | 1797 | 84.8% | 70.5% | ±1.6 |
| 90-100% | 1048 | 94.3% | 80.7% | ±2.3 |

**Games actually played (luck model only)**. Brier 0.1493, slope 0.94.

| Quoted chance | Matchups | Mean quote | Actual win rate | SE (by week) |
|---|---|---|---|---|
| 0-10% | 3231 | 3.8% | 5.4% | ±0.6 |
| 10-20% | 1720 | 14.9% | 16.3% | ±1.1 |
| 20-30% | 1464 | 24.8% | 26.4% | ±0.9 |
| 30-40% | 1290 | 34.9% | 34.2% | ±1.8 |
| 40-50% | 1295 | 45.1% | 44.2% | ±1.3 |
| 50-60% | 1298 | 54.9% | 50.5% | ±1.6 |
| 60-70% | 1365 | 65.1% | 60.9% | ±1.3 |
| 70-80% | 1440 | 75.1% | 70.3% | ±1.0 |
| 80-90% | 1769 | 85.2% | 81.5% | ±0.8 |
| 90-100% | 3128 | 96.3% | 93.7% | ±0.5 |

## Per category (standard nine)

Win chance of each category, all 18,000 matchups pooled (ties in a category are left out). Mean quotes and actual rates agree to within 1 point in every category: there is no bias, only too much confidence. Brier for a 50-50 coin is 0.250.

| Category | Actual rate | Brier, schedule | Slope, schedule | Brier, played | Slope, played |
|---|---|---|---|---|---|
| PTS | 49.8% | 0.222 | 0.61 | 0.098 | 0.98 |
| REB | 50.0% | 0.211 | 0.67 | 0.106 | 0.98 |
| AST | 50.0% | 0.192 | 0.73 | 0.103 | 0.99 |
| STL | 49.3% | 0.228 | 0.71 | 0.178 | 0.91 |
| BLK | 49.6% | 0.202 | 0.81 | 0.165 | 0.94 |
| 3PM | 49.5% | 0.196 | 0.77 | 0.135 | 0.95 |
| TO | 50.0% | 0.211 | 0.71 | 0.132 | 0.98 |
| FG% | 50.4% | 0.226 | 0.75 | 0.218 | 0.80 |
| FT% | 49.8% | 0.228 | 0.73 | 0.217 | 0.81 |

Under schedule games, every category is overconfident (slopes 0.61 to 0.81); BLK is the best calibrated and PTS the worst (a category with small luck and large games-played influence). With games played, PTS, REB, AST, TO sit at 0.98-0.99, while STL, BLK, 3PM are at 0.91-0.95 and **FG% and FT% at 0.80-0.81**, the one place the luck model itself is overconfident (percentage luck, measured at 2.4 and 4.1 points, looks too small). The earlier miss that opened the issue (AST quoted at 50%, real week 0-5) is a single week, consistent with these numbers: AST is well calibrated in the aggregate.

## Other scoring systems

Same method, same 18 weeks, 13 players per side.

| System | Games | Brier | Slope |
|---|---|---|---|
| custom | team | 0.231 | 0.60 |
| custom | player | 0.119 | 0.96 |
| points | team | 0.235 | 0.57 |
| points | player | 0.110 | 0.95 |

(`custom` = nine categories PTS REB AST STL BLK 3PM TO FTM DD, through `simulateAny`; drawn weeks are dropped. `points` = ESPN league 994542812 weights, through `simulatePoints`. Coin-flip Brier is 0.25.)

Custom categories, schedule games (slope 0.60):

| Quoted chance | Matchups | Mean quote | Actual win rate | SE (by week) |
|---|---|---|---|---|
| 0-10% | 2349 | 4.3% | 19.5% | ±1.9 |
| 10-20% | 1749 | 14.9% | 31.3% | ±1.6 |
| 20-30% | 1545 | 24.9% | 37.9% | ±1.4 |
| 30-40% | 1546 | 34.9% | 41.3% | ±1.3 |
| 40-50% | 1513 | 44.9% | 47.3% | ±1.1 |
| 50-60% | 1503 | 55.0% | 51.8% | ±0.9 |
| 60-70% | 1560 | 64.9% | 55.5% | ±1.4 |
| 70-80% | 1584 | 75.1% | 61.0% | ±1.4 |
| 80-90% | 1723 | 85.1% | 68.0% | ±1.7 |
| 90-100% | 2344 | 95.6% | 80.5% | ±2.0 |

Points, schedule games (slope 0.57):

| Quoted chance | Matchups | Mean quote | Actual win rate | SE (by week) |
|---|---|---|---|---|
| 0-10% | 3200 | 3.6% | 21.7% | ±1.6 |
| 10-20% | 1660 | 14.6% | 31.6% | ±1.2 |
| 20-30% | 1471 | 24.8% | 40.9% | ±1.9 |
| 30-40% | 1357 | 35.0% | 43.8% | ±1.8 |
| 40-50% | 1263 | 45.1% | 49.0% | ±1.5 |
| 50-60% | 1309 | 54.9% | 51.6% | ±1.4 |
| 60-70% | 1379 | 65.0% | 56.3% | ±1.1 |
| 70-80% | 1440 | 75.0% | 59.2% | ±1.7 |
| 80-90% | 1702 | 85.2% | 64.6% | ±2.1 |
| 90-100% | 3219 | 96.3% | 79.5% | ±1.7 |

Points with games played (slope 0.95): a quoted 90-100% won 95.7% and 80-90% won 83.3%, so the points model is calibrated apart from the games-played uncertainty. The DD category's mean quote (about 45%) is below its actual rate (49.6%) only because 0-0 ties are dropped from the outcomes but counted as not-a-win in the quote.

## What this means

- Do not present the quoted percentages in the high or low tails as measured frequencies. Roughly, in this sample, quoted 90% means about 80%, 80% about 70%, 70% about 60%; this holds for all three scoring systems.
- The cause is games played, not luck. The likely reason: a rostered player misses some games in a typical week, while the engine credits him with every team game.
- Not done here (would change the method, so needs approval): shrinking the tails toward 50% by about a third, a per-player games-played (availability) factor, and larger FG% / FT% luck. A re-run of this script after any such change gives the new calibration in under ten minutes.

## Limits

One season; the weeks are not independent of the season-to-date averages that feed them; random rosters from the top 182 are not real league teams (real rosters have injured and benched players, which probably makes the real gap larger, not smaller); no prior-season blending was used (season-to-date only, from week 6).

## Reproduce

```bash
cd engine
bun scripts/calibration-backtest.ts games.csv --games team   --mode std      --out std_team.json
bun scripts/calibration-backtest.ts games.csv --games player --mode std      --out std_player.json
bun scripts/calibration-backtest.ts games.csv --games team   --mode custom  --out custom_team.json
bun scripts/calibration-backtest.ts games.csv --games team   --mode points  --out points_team.json
```

Each run takes one to ten minutes (points are slowest).
