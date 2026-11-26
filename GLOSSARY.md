# Glossary

Terms used in the engine, skills and docs. Plain meanings; the method lives in [docs/matchup-simulation.md](docs/matchup-simulation.md).

- **League card**: plain text (and optional JSON at `~/.fantasy-analyst/<league>.json`) holding a league's settings: host, teams, slots, categories, add limit, playoffs, tiebreakers. The roster is never saved.
- **Category**: one scored stat in a head-to-head league. A *counting* category is a total (PTS, REB, DD); a *ratio* is made over attempted (FG%, FT%) or one stat over another (A/T); a *lower-is-better* category is won by the smaller total (TO, PF).
- **Base stat**: a stat luck is modelled on (made and attempted shots, OREB, DREB, AST, STL, BLK, TO, PF, MIN, DD, TD). Combined categories (PTS, REB, A/T, the percentages) are computed from base stats.
- **Week win**: winning more than half of the league's categories in a head-to-head week. A tie is reported separately and counts only where the league card says it does.
- **Luck**: the measured week-to-week spread of a stat after game counts are removed. Never guessed; a category without a measured luck is not supported.
- **Games basis**: how many games of history an estimate rests on (shown as `add_games_basis`).
- **Lineup**: the players who count in a week. With a number of starters: the best N by internal value. With **slots** (PG, SG, G, SF, PF, F, C, UTIL): the best-valued players who can all be seated, each in a slot he is eligible for (G takes PG or SG, F takes SF or PF, UTIL takes anyone); the user's own lineup is used when given, and the best fit is a recommendation.
- **Slots**: the league's starting lineup positions as the host lists them. Bench and injured-list slots are not lineup slots. A player with no positions given can fill UTIL only.
- **Adds left / IL**: the weekly add limit still unused, and the injured-list slots with the statuses the league lets into them. An add needs no drop while a roster spot is open; a player the league lets into IL moves there and frees his spot.
- **Scenario**: the user's assumption that a player is out, or back on a day. Always labelled an assumption. After a return the first 3 games count at 80% (assumed, not measured).
- **Daily lineup**: with a daily lock, each remaining day's lineup is the best fit among players whose teams play that day. Streaming = adding a player for the rest of the week.
- **Outlook**: the rest of the season played out many times from each week's win chance, with standings and the playoff bracket applied; the roster is held as it stands.
- **Snapshot**: the nightly public file (`snapshot.json`) of per-game averages, teams and the four-week schedule that the skills read.
- **Typical opponent**: a team from a simulated snake draft of a league of the same size and category list.
