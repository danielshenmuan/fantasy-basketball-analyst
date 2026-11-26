# Roto method and calibration

Issue #14, ADR 0003. Roto has no weekly winner: each team is ranked in every category on season totals (best of N teams = N points, worst = 1, ties split), most points wins. The engine projects the rest of the season. Code: `engine/src/roto.ts` (math, simulation), `engine/src/analyzeRoto.ts` (inputs, skill paths), `engine/src/rotoluck.ts` (measured constants, generated).

## Model
- Final total = banked total + sum of (per-game average x games the player plays). Percentages and ratios use made and attempted counts (`(banked made + rest made) / (banked attempts + rest attempts)`).
- Per-game average: the engine's prior-season estimate blended with this season so far, weight `games / (games + 30)` (K chosen on 2025-26: sd of the error is lowest near K = 10, bias nearest zero near K = 60).
- Games: the team's real games left (day-by-day schedule). Share he plays = `(his games + 25 x league rate) / (team games so far + 25)`, the league rate falling through the season (0.68 early to about 0.3 late, floored). Measured: players in the top 182 play about 77% of remaining games after week 4 and 67% after week 20; regulars regress toward the league rate.
- Luck, all measured on 2025-26 (script `engine/scripts/measure-roto-model.py`): (1) one games-played draw per player, sd = `sqrt(1.94 G + 0.0053 G^2)` games for `G` team games left; (2) per-game luck on each base stat, sd as a fraction of the projected rest total `sqrt(a^2 / games per player + b^2)` (e.g. PTS parts fgm 0.126/0.040, ftm 0.229/0.071; BLK 0.361/0.083), scaled by `sqrt(13 / players)`, with the measured correlation matrix. Phase-1 summary (schedule games, 12 teams x 13 players, sd of rest-of-season total as % of projection): PTS 7.0 after week 4 to 10.2 after week 20; BLK 10.7 to 12.3; FG% 1.4 to 1.6 points; FT% 2.2 to 2.4 points. Weekly luck for the same teams is roughly twice as large (PTS 14.6%) but does not scale by `1/sqrt(weeks)`: a persistent part (injuries, role changes) remains.

## Back-test (2025-26, simulated leagues)
No real roto league exists to check against, so: for cut dates after weeks 4, 8, 12, 16 and 20, 40 random leagues each of 12 teams x 13 players from the 182 best players (by value on games before the cut), rosters held all season. Standings as at the cut; prior seasons from the data file; this season only up to the cut. The engine's roto path (1,000 simulated seasons) predicts; the real final totals, ranked by roto rules, are the truth. 2,400 team-seasons (480 per cut). Script: `engine/scripts/roto-backtest.ts`.

| Cut | Mean error of expected final roto points (naive: points today) | Brier, first place (12-team coin flip 0.076) | Brier, top 3 (coin flip 0.188) | Correlation, expected place vs real place |
|---|---|---|---|---|
| Week 4 | 7.1 (7.5) | 0.061 | 0.134 | 0.66 |
| Week 8 | 5.9 (6.5) | 0.045 | 0.112 | 0.72 |
| Week 12 | 4.9 (5.4) | 0.055 | 0.101 | 0.81 |
| Week 16 | 3.9 (4.0) | 0.042 | 0.071 | 0.88 |
| Week 20 | 2.8 (2.9) | 0.033 | 0.048 | 0.92 |

Expected points have no bias (mean error 0.00 at every cut). The place distribution is well calibrated: where the real place fell in the predicted distribution is flat across deciles (9.4, 9.8, 9.0, 9.7, 10.5, 10.0, 9.8, 10.0, 11.8, 10.1 percent).

Reliability, all cuts pooled (quoted -> actual):

| Chance of finishing first | n | Quote | Actual |
|---|---|---|---|
| 0-2% | 1547 | 0.2% | 0.5% |
| 2-5% | 217 | 3.2% | 1.8% |
| 5-10% | 160 | 7.0% | 6.3% |
| 10-20% | 152 | 14.4% | 15.8% |
| 20-35% | 122 | 26.8% | 32.8% |
| 35-50% | 70 | 41.7% | 28.6% |
| 50-100% | 132 | 71.6% | 59.1% |

| Chance of top 3 | n | Quote | Actual |
|---|---|---|---|
| 0-10% | 1250 | 2.0% | 2.4% |
| 10-25% | 323 | 17.0% | 19.5% |
| 25-40% | 194 | 31.6% | 29.9% |
| 40-60% | 211 | 50.0% | 34.6% |
| 60-80% | 160 | 69.7% | 71.3% |
| 80-90% | 92 | 85.3% | 88.0% |
| 90-100% | 170 | 96.4% | 92.4% |

Top half: quotes 40-60% won 49.7%; 90-100% won 95.6%. Projected final category totals of a sample team ran 0-7% low at week 4 (AST -7.3%, PTS -5.6%, 3PM -5.6%) and within about 1% from week 16.

**Reading it:** small and middling chances are good. The highest first-place quotes are overconfident (a quoted 50%+ won 59%, one in six top quotes in the 35-50% range won 29%), and top-3 quotes of 40-60% won 35%. Early in the season (week 4) the projection is 2-7% low in assists, points and threes (players improve and the prior is too low) and the tails are widest.
- **Shooting estimated vs exact:** when only FG% and FT% are given and banked attempts are estimated, expected points differ by 0.03 on average and the first-place chance by 0.07 points. The estimate costs almost nothing here, but the back-test rosters are held all season, so the estimate is better than it would be after many adds and drops; label it estimated anyway.

## Limits
The back-test uses simulated rosters held all season, not real roto leagues, 2025-26 only, the same season the luck was measured on (in-sample for the luck constants; the shape of luck by games left was fitted on the same cut dates). Not modelled: bench and daily lineup limits (every rostered player counts), games-played caps, positions, IL rules, trades and adds by other teams, the playoffs. Head-to-head, points and any-category results are unchanged.
