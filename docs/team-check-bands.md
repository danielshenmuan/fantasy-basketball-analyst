# How team-check bands are computed

Season-long strength of a roster, category by category, against simulated leagues (`engine/src/assess.ts`, `engine/src/simulate.ts`).

1. Simulate many snake drafts of `teams x roster_spots` players (each pick is one of the best few remaining). Each simulated team's best `lineup_slots` players, by total score, are its lineup.
2. For every category, each simulated team gets a number; the roster's number is placed among them (its percentile). Bands: elite >= 85, strong >= 60, neutral >= 40, otherwise weak.
3. The number is the sum of the lineup's category scores for PTS, REB, AST, STL, BLK, 3PM and TO.
4. **FG% and FT% are ranked by the team's rate** (made / attempted over the lineup), since 2026-11-25 (issue #24). Before, they were the sum of attempt-weighted impact scores, which rewards shot volume: a team with many free-throw attempts at a mediocre rate could rank high. The weekly matchup compares made / attempted, so the band now agrees with it. A player with no data, or an empty slot, shoots like the average drafted player. Callers that give no made/attempted shots to `simulateBenchmark` (older code) still get the impact sum.

## Effect of the change (150 simulated-draft rosters, 13 slots, flat 3.4 games, typical opponents)

Correlation between team-check percentile and matchup win chance per category, before -> after: FT% 0.39 -> 0.98, FG% 0.96 -> 0.98; PTS, REB, AST, STL, BLK, 3PM, TO unchanged (0.98 to 1.00, bands and percentiles identical). Bands changed: FT% 94 of 150, FG% 17 of 150. "Weak" categories whose matchup win chance was 50% or more: 73 of 754 before, 0 of 680 after. Reproduce with `engine/scripts/band-vs-matchup.ts` (header has the command).
