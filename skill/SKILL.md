---
name: fantasy-basketball-analyst
description: Fantasy basketball team health check for category leagues. Use when the user wants to know where their fantasy basketball team is strong or weak by category, whether their roster is good, or who to target. Takes a roster and league size, compares the team with a simulated league, and returns elite / strong / neutral / weak for each category. Works with any league host; read the roster from the user's league or have them paste it.
---

# Fantasy basketball analyst

Gives a category-by-category health check of a fantasy basketball roster. A script does all the math. Your job is to collect the inputs accurately, run it, and explain the result in plain language.

Scope today: **9-category leagues** (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO). Points leagues and other category sets are not supported; say so instead of approximating.

## What you need from the user

1. **League size**: number of teams.
2. **Active roster spots**: slots that count toward the weekly totals. Do not count injured-list (IL) slots.
3. **The roster**: every player on the team, marking anyone on IL.

Read these from the user's league yourself if you can browse it while they are logged in (roster page and league settings). Otherwise ask them to paste the roster. Never ask for a password or log in on their behalf.

**Before running anything, show the user the players you read and the league size, and ask them to confirm.** Misread names are the most likely source of a wrong answer.

## Run the analysis

Write the request as JSON and run the script with Node 18 or newer. Use the live data file first; it is refreshed every night.

```bash
echo '{"league":{"teams":12,"roster_spots":13},"roster":[{"name":"Nikola Jokic"},{"name":"Max Strus","status":"IL"}]}' \
  | node scripts/analyze.mjs --snapshot https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json
```

If the download fails (no internet access), run it again with `--snapshot data/snapshot.json`, the copy bundled in this skill, and **tell the user the data may be out of date** (see `snapshot.generated_at` in the result).

If the script cannot run at all (no Node, no file access), tell the user the analysis is unavailable. Do not estimate the numbers yourself.

## Read the result

- `ranking`: the nine categories from strongest to weakest, each with a band and a percentile.
- Bands compare the team with simulated leagues of the same size: **elite** (top 15%), **strong**, **neutral**, **weak** (bottom 40%).
- `names`: how each typed name was read. For any `ambiguous` or `not_found` entry, **ask the user** which player they meant. Do not guess. Until clarified, that player counts as an average player.
- `players`: each player's confidence. `none` means no NBA data (usually a rookie), `low` means a small sample, and a player who missed last season is estimated from earlier seasons. Mention these when they affect the answer.
- `baseline`: what the "average rostered player" yardstick is built from. Early in a season it blends last season with this one (`weight_current` is this season's share, which grows with games played). Mention it only if the user asks why numbers moved.
- `assumptions`: the plain-language list of what the result rests on. Include the important ones in your answer.

## How to talk about it

- Lead with the picture: which categories are strengths, which are holes, and which hole is the cheapest to fix. Turnovers (TO) and FG% are usually the hardest to move.
- Use the bands and plain stats. Do not mention z-scores or an internal score.
- Be honest that this is an estimate from past seasons: it does not model injuries, role changes, schedules, or daily lineup limits.
- Suggestions for pickups and trades should come from the user's own league data (free agents, other rosters) that you read, aimed at the weak categories. Say which suggestions come from the analysis and which are your own judgment.
- This is entertainment and strategy help. It is not betting or financial advice.

## Known limits (say so when they apply)

- **Rookies and players with no recent NBA seasons** show confidence `none` and count as an average player, even if they are playing well this season. If the roster has one, say that the team may be stronger or weaker than shown.
- Players are valued from their last three completed seasons, not from this season's games.
- Positions, injuries to starters, schedules and daily lineup limits are not modelled.

## Data

The snapshot holds per-season averages for NBA players and the time it was generated (`snapshot.generated_at` in the result). It contains no game logs and no ownership data. If it is more than about two days old during the season, tell the user.
