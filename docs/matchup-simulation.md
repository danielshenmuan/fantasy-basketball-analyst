# Weekly matchup simulation

How the analyst turns two rosters into "you win about N% of weeks". Code: `engine/src/matchup.ts`.

## The idea

In a head-to-head 9-category league you win a week by winning at least 5 of 9 categories. For each simulated week:

1. **Expected total** for each team and category = each lineup player's per-game average x the games his team plays that week. Game counts come from the NBA schedule in the nightly data file. They are known in advance, so they are **not** treated as luck. Without a schedule the engine assumes an average week (3.4 games) and says so.
2. **Add week-to-week luck**: how far a team's real weekly total lands from its expected total. This was measured, not assumed (below).
3. **Count the categories each side wins.** Fewer turnovers win TO. FG% and FT% are made / attempted.
4. Repeat 10,000 times with a fixed seed (same inputs, same answer). Report the share of weeks won overall and per category.

The opponent is either a real roster the user supplies, or a typical one: teams from simulated snake drafts of the league's size (each pick one of the best five remaining; positions ignored; each team plays its best N players).

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

Injuries and rest days during the week, lineup moves and streaming, positions, the opponent's moves. It is a probability for the rosters as they stand, not a prediction.

## Planned upgrade

One luck number per category ignores that some rosters swing more than others (across random rosters, 3PM luck ranged from 11.6% to 17.6% and BLK from 18% to 28%). The upgrade is per-player variance stored in the nightly data file, used when a prototype shows it moves a weekly win chance by more than a point or two.

## Scoring moves (waiver and trade)

A move is scored by re-running the same simulated weeks with the roster changed. The random draws are identical, so the difference in weekly win chance is the move's effect, not noise.

- **Waiver:** for each available player, try every drop and keep the one that helps most; rank adds by the gain in weekly win chance, averaged over the next two weeks of the schedule. The reported numbers for the top moves are re-scored at full length.
- **Trade:** remove the players given, add the players received, compare. With the other team's roster, the same for their side. Search tries every one-for-one swap and keeps those that help you without hurting them.
- **Empty lineup spots** are filled by a replacement-level player (the last player a league of this size would draft).

Everything here is a difference between two simulations. Skills must not add advice that was not measured.
