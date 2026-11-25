# Glossary

Terms used in the engine, skills and docs. Plain meanings; the method lives in [docs/matchup-simulation.md](docs/matchup-simulation.md).

- **League card**: plain text (and optional JSON at `~/.fantasy-analyst/<league>.json`) holding a league's settings: host, teams, slots, categories, add limit, playoffs, tiebreakers. The roster is never saved.
- **Category**: one scored stat in a head-to-head league. A *counting* category is a total (PTS, REB, DD); a *ratio* is made over attempted (FG%, FT%) or one stat over another (A/T); a *lower-is-better* category is won by the smaller total (TO, PF).
- **Base stat**: a stat luck is modelled on (made and attempted shots, OREB, DREB, AST, STL, BLK, TO, PF, MIN, DD, TD). Combined categories (PTS, REB, A/T, the percentages) are computed from base stats.
- **Week win**: winning more than half of the league's categories in a head-to-head week. A tie is reported separately and counts only where the league card says it does.
- **Luck**: the measured week-to-week spread of a stat after game counts are removed. Never guessed; a category without a measured luck is not supported.
- **Games basis**: how many games of history an estimate rests on (shown as `add_games_basis`).
- **Lineup**: the best `lineup_slots` players by internal value; the rest are bench. Positions are not modelled yet.
- **Snapshot**: the nightly public file (`snapshot.json`) of per-game averages, teams and the four-week schedule that the skills read.
- **Typical opponent**: a team from a simulated snake draft of a league of the same size and category list.
