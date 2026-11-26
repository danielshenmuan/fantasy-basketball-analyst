# Daily vs weekly week-win chance (issue #33)

Measured on 2025-26 data and the live schedule. Nothing in the engine was tuned. Scripts: `engine/scripts/daily-vs-weekly.ts` (decomposition on the live snapshot), `engine/scripts/daily-backtest.ts` (calibration, same data export and pool/pair method as `calibration-backtest.ts`). The daily output now carries `compare_with_weekly` (additive; no existing number changed).

## Why the two numbers differ

The weekly model counts each of your best 10 players' games all week. The daily model fields the best 10 every day among players whose team plays, so a bench player starts on days when a starter is idle (about +9 games per side per week, 13 players and 10 slots). **But the headline daily number gives that to your side only: the opponent stays at his weekly total.** So it is biased toward you.

100 random 13-player rosters vs 13-player rosters (150 best players of the live snapshot), week of 2026-11-23, 10 starters:

| Source | Win-chance points |
|---|---|
| Weekly number (reference) | 48.4% mean |
| Your bench starts on idle days (+9.0 games), opponent kept weekly = the headline daily number | +27.6 |
| Opponent's bench also starts on idle days (+9.1 games) | -27.4 |
| Net, both sides fielded day by day, vs weekly | +0.1 (mean abs per pair 7.2) |
| Games counted differently (weekly schedule vs day schedule) | 0 (118 team-weeks checked, identical) |
| Positions and slots (guessed from stat lines) vs 10 bare starters | about 0: bench games +9.0 vs +9.1; net gap 0.0 |

The 63% vs 88% case in the issue is this: about +25 from your bench alone. With both sides fielded day by day the average gap vanishes; individual pairs still differ by about 7 points because the idle days of your starters and theirs differ (real signal about who has the better-timed bench).

## Calibration (2025-26, 18 weeks, 5,271 matchups, week-clustered SE)

Quotes use pre-week information and the real day-by-day team schedule. Outcome R_daily: each day each side starts its 10 best (by pre-week value) among players who really played that day; R_all: every player counts for every game played (as in `calibration.md`). Quote coin flip Brier is 0.2500; slope 1 is calibrated.

| Quote | Mean quote | Brier vs R_daily | Slope vs R_daily | Brier vs R_all | Slope vs R_all |
|---|---|---|---|---|---|
| Weekly | 49.7% | 0.2289 ±0.006 | 0.65 ±0.04 | 0.2294 | 0.65 |
| Daily, your side only (the current headline) | 77.1% | 0.3012 ±0.009 | 0.28 ±0.04 | 0.3006 | 0.28 |
| Daily, both sides day by day | 49.8% | 0.2256 ±0.005 | 0.70 ±0.04 | 0.2264 | 0.69 |

The base rate of "you win" is 50.0%. The headline daily number is worse than a coin flip (a quoted 90-100% won 70%). Fielding both sides day by day is slightly better than the weekly number (Brier 0.2256 vs 0.2289, inside one standard error of each other; slope 0.70 vs 0.65) and is still overconfident, like the weekly one, mainly because injuries and rest are not known in advance.

Caveat: the realised daily lineup uses hindsight on who played each day (real managers see most inactives before lock); rosters are random draws from the 182 best players with 13 players and 10 slots, no positions.

## Decision and fix (owner, 2026-11-26)
Use the daily model for daily-lineup leagues. The headline `daily.baseline_week_win_pct` now fields both rosters day by day when a real opponent is given (the old one-sided number is kept as `compare_with_weekly.you_only_daily_week_win_pct`, not for quoting). The lineup already set on My Team can be passed as `daily.set_lineup` / `opponent_set_lineup`. Back-test row "Daily, both sides day by day" above is the number now quoted.
