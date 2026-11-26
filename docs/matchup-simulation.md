# Weekly matchup simulation

How the analyst turns two rosters into "you win about N% of weeks". Code: `engine/src/matchup.ts`.

## The idea

In a head-to-head 9-category league you win a week by winning at least 5 of 9 categories. For each simulated week:

1. **Expected total** for each team and category = each lineup player's per-game average x the games his team plays that week. Game counts come from the NBA schedule in the nightly data file. They are known in advance, so they are **not** treated as luck. Without a schedule the engine assumes an average week (3.4 games) and says so.
2. **Add week-to-week luck**: how far a team's real weekly total lands from its expected total. This was measured, not assumed (below).
3. **Count the categories each side wins.** Fewer turnovers win TO. FG% and FT% are made / attempted.
4. Repeat 10,000 times with a fixed seed (same inputs, same answer). Report the share of weeks won overall and per category.

The opponent is either a real roster the user supplies, or a typical one: teams from simulated snake drafts of the league's size (each pick one of the best five remaining; positions ignored; each team plays its best N players).

## A week already under way

With `so_far` (stats banked by each side, plus the games each NBA team still plays) only the games left are expected-plus-luck; banked stats are fixed. Each player's remaining games are his own team's games left, so a side whose steal players have not played yet is credited with those steals still to come. The per-day game counts come from the public NBA scoreboard (`skills/matchup/scripts/games-left.mjs`; checked against the data file's weekly counts for all 30 teams). Luck was measured on whole weeks, so on a part of a week it is scaled by 1 / sqrt(share), where share is the lineup's games left over its games that week. FG% and FT% are re-weighted by attempts across banked and remaining. With nothing banked and the whole week left it reproduces the fresh-week result exactly. Without `games_left`, `remaining_share` gives every player the same share (rougher).

## Measured luck

Measured on 1,500 random 13-player rosters over the 25 full weeks of 2025-26, **after** removing the effect of how many games each player played:

| Category | Weekly swing, as % of the weekly total |
|---|---|
| PTS | 8% |
| REB | 9% |
| AST | 11% |
| STL | 17% |
| BLK | 23% |
| 3PM | 14% |
| TO | 13% |

FG% swings about 2.4 percentage points and FT% about 4.1. Luck is correlated across the counting categories at 0.1 to 0.3, except PTS and 3PM at 0.63 (threes are points). Luck shrinks with the square root of the number of players in the lineup: it was re-measured at 10 players and came out 1.15x, so the engine scales by sqrt(13 / lineup slots).

## What it does not model

The opponent's moves, future injuries, and (unless a scenario or the daily option is asked for) injuries and rest days during the week, lineup moves and streaming. Positions are used only when the league's slots are given. It is a probability for the rosters as they stand, not a prediction.

## Planned upgrade

One luck number per category ignores that some rosters swing more than others (across random rosters, 3PM luck ranged from 11.6% to 17.6% and BLK from 18% to 28%). The upgrade is per-player variance stored in the nightly data file, used when a prototype shows it moves a weekly win chance by more than a point or two.

## Scoring moves (waiver and trade)

A move is scored by re-running the same simulated weeks with the roster changed. The random draws are identical, so the difference in weekly win chance is the move's effect, not noise.

- **Waiver:** for each available player, try every drop and keep the one that helps most; rank adds by what the added player contributes beyond the drop, averaged over the next two weeks of the schedule. A candidate who would not enter the lineup (`bench-only`), or whose gain is only the drop (`no-gain-from-add`), is not ranked: dropping a player alone changes the week, and that effect would otherwise be credited to whoever is added. Candidates ranked below the number shown are listed as `below-top`, so none disappears. Each move reports the total change, the drop-only change and the add's own effect, and the data behind the add's estimate. The reported numbers for the top moves are re-scored at full length. When a week in the schedule still has games with a team to be announced (`TBD`), output carries `schedule_incomplete` and a warning: some teams' game counts may be low.
- **Trade:** remove the players given, add the players received, compare. With the other team's roster, the same for their side. Search tries every one-for-one swap and keeps those that help you without hurting them.
- **Empty lineup spots** are filled by a replacement-level player (the last player a league of this size would draft).

Everything here is a difference between two simulations. Skills must not add advice that was not measured.

## Back-test: does a quoted 60% win 60% of the time?

Measured on 18 real weeks of 2025-26 (issue #9; full tables in `docs/calibration.md`, script `engine/scripts/calibration-backtest.ts`). Quotes with each team's real schedule game counts are **overconfident in the tails**: a quoted 90-100% won about 81%, 80-90% won 70%, 70-80% won 61%; quotes of 40-60% are fine (calibration slope 0.61; Brier 0.235 against 0.250 for a coin flip). With the games players really played, the same model is nearly calibrated (slope 0.94), so the luck table is about right and the gap comes from injuries and rest, which the model does not include. Custom category lists and points leagues behave the same. Until that is addressed, treat quotes above about 80% or below about 20% as less certain than they look.

## Lineup slots and positions

With `league.slots` the lineup is filled by position instead of "best N". Players are taken best-first and kept if everyone kept can still be seated (the best lineup for any such slot set, because seating is a matching problem where best-first is optimal). A player whose team has no game that week is not available. Players with no positions fill UTIL only; the engine warns and turns the empty-slot check off rather than guess. Typical (simulated-draft) opponents stay position-free, so team-check numbers do not move; your team and a real opponent use real slots. In move ranking, a move that leaves a required slot with nobody eligible is listed as `breaks-slot` and never recommended. A lineup the user gives is used as given; the best fit is shown next to it with its win chance.

## Add limit and injured list

A roster player whose host status is one the league lets into an IL slot moves there while slots are open, freeing his spot; an add needs no drop while a roster spot is open (a move with a null drop is scored against the roster as it stands). With `adds_left`, the best group of moves is found greedily (apply the best, re-rank against the changed roster, repeat) and the combined roster is re-simulated, so the number is a measured difference, not a sum.

## Injury windows and scenarios

A player is out from a day until a return day (or for the whole horizon). Games on those days are lost, using the day-by-day schedule (spread evenly over the week and flagged when only weekly counts exist). After a return the first 3 games count at 80% of normal output: an assumption, not measured, user-adjustable; the real figure can be measured if game logs are added. A host OUT tag with no date means out for the rest of this week and back next week (flagged); GTD/DTD counts as playing. Statuses are read live each run and never stored.

## Daily lineups and streaming

With a daily lock the days left are modelled one by one: each day the best lineup among players whose teams play that day. Start and bench changes, and adding a streamer for the rest of the week, are differences between two simulations. Luck was measured on whole weeks and is scaled by 1 / sqrt(share left) for the part left; under a third of the lineup's games left the output is labelled rougher.

## Rest of season and playoffs

Each remaining week's win and tie chance comes from the weekly simulation (real opponent roster when given, typical otherwise). The season is then played out thousands of times: your results from those chances; other teams' remaining games as fair coin flips (their rosters are unknown); seeds by record with ties settled by the tiebreaker only as far as today's values are known, else a coin flip; a bracket padded to a power of two with byes for the top seeds; each round's win chance from the weekly simulation against a typical opponent. Output states these limits, and `tiebreak_decides_pct` says how often a tie settled your spot.
