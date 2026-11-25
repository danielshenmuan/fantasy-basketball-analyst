---
name: team-check
description: Fantasy basketball team health check for head-to-head category leagues. Use when the user wants to know where their fantasy basketball team is strong or weak by category, how likely they are to win a typical week, or whether their roster is good. Takes a roster and league settings (from a saved league card or from the league site), compares the team with a simulated league, and returns elite / strong / neutral / weak for each category plus a win chance for each category and for the week. Works with any league host.
---

# Fantasy basketball analyst

Gives a category-by-category health check of a fantasy basketball roster. A script does all the math. Your job is to collect the inputs accurately, run it, and explain the result in plain language.

**Head-to-head category leagues with any mix of these categories** (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO, plus FGM, FGA, FTM, FTA, 3PA, 3P%, OREB, DREB, PF, A/T, MIN, DD (double-doubles) and TD (triple-doubles)) are supported. Put the league's categories, exactly as the host names them, in `league.categories` of the request (for example `["Points","Rebounds","3-pointers made","Double-doubles"]`). Leave it out only for the standard nine. If a category is not on the list, the script stops and names it: say so plainly and do not approximate. A tie in the week is reported as a tie, not a win. Roto is not supported yet; points leagues use `league.scoring` (see below).

## What you need

1. **League settings**: number of teams, **starters** (players who count each week), and active roster spots (starters plus bench, not IL).
2. **The roster**: every player on the team, marking anyone on IL.

**Look for a league card first.** If the user pasted a "FANTASY LEAGUE CARD", or `~/.fantasy-analyst/league.json` exists, take the settings from it and show them in one line. If there is no card, suggest running the `setup` skill (it saves a card for next time), but do not block on it: read the settings from the league site, or ask directly. If the user did not name a skill at all, the `analyst` skill is the entry point that routes here.

**Read the roster without asking the user to paste it.** Follow `../analyst/reading-a-league.md` (per-host recipes for Yahoo and ESPN, and the full fallback ladder). In short, the first route that works, in this order, saying in one line which one you are using:
1. A connected league tool for that site.
2. Claude in Chrome, in the user's own signed-in browser (open the roster page in a new tab).
3. The built-in browser or computer use; if a login is needed, ask the user to sign in themselves.
4. Text the user pastes from the roster page.
5. Screenshots of the roster page.
6. The user types the names.

Do not stop at the first failure: say why in a few words and try the next route. This skill is read-only. Never ask for a password, never type one, and never send adds, drops or trades.

**Before running anything, show the user the players you read and the league settings, and ask them to confirm.** Misread names are the most likely source of a wrong answer. Also confirm the league is head-to-head and read its category list or points scoring; roto is not supported, so say so instead of approximating. If fewer players are active than roster spots, ask whether someone is missing: an empty slot counts as an average player.

## Run the analysis

Write the request as JSON (`matchup.lineup_slots` is the number of starters; leave `matchup` out if it is unknown) and run the script with Node 18 or newer. Use the live data file first; it is refreshed every night.

```bash
echo '{"league":{"teams":12,"roster_spots":13},"matchup":{"lineup_slots":10},"roster":[{"name":"Nikola Jokic"},{"name":"Max Strus","status":"IL"}]}' \
  | node scripts/analyze.mjs --snapshot https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json
```

If the download fails (no internet access), run it again with `--snapshot data/snapshot.json`, the copy bundled in this skill, and **tell the user the data may be out of date** (see `snapshot.generated_at` in the result).

If the script cannot run at all (no Node, no file access), tell the user the analysis is unavailable. Do not estimate the numbers yourself.

## Read the result

- `ranking`: the league's categories from strongest to weakest, each with a band and a rounded percentile. Quote these, not the unrounded numbers elsewhere in the output.
- Bands compare the team with simulated leagues of the same size: **elite** (top 15%), **strong**, **neutral**, **weak** (bottom 40%).
- `names`: how each typed name was read. For any `ambiguous` or `not_found` entry, **ask the user** which player they meant. Do not guess. Until clarified, that player counts as an average player.
- `players`: each player's confidence. `none` means no usable NBA data, `low` means a small sample, and a player who missed last season is estimated from earlier seasons. A rookie, or anyone with no completed NBA season, is judged on this season's games alone (see the note on that player) and is always `low` until about 50 games. Mention these when they affect the answer.
- `baseline`: what the "average rostered player" yardstick is built from. Early in a season it blends last season with this one (`weight_current` is this season's share, which grows with games played). Mention it only if the user asks why numbers moved.
- `matchup`: the weekly head-to-head simulation against typical opponents. `categories` is the percent of simulated weeks you win each category, `week_win_pct` is the percent of weeks you win 5 or more of 9, and `distribution_pct` is how often you win exactly 0 to 9. These are whole percents: quote them as given. `games_source` says whether the games per player came from the NBA schedule or an assumed average week. Luck, game counts and the method are in `matchup.assumptions`; include the important ones. It does not model injuries, rest days, lineup moves or streaming.
- `assumptions`: the plain-language list of what the result rests on. Include the important ones in your answer.

## How to talk about it

- Lead with the picture: the categories the team is built to win, the categories it is losing, and the weekly win chance. Use the bands for strength and the percents from `matchup` for win chances. Do not mention z-scores or an internal score.
- To say which players drive a category, you may use each player's per-category values in `players` to rank them, but describe it in words ("Jokic and Sengun carry your rebounds"). Never quote those numbers.
- **Everything you say about strategy must be measured, never your own judgment.** Do not recommend punting a category, a build, a pickup, a drop or a trade. If the user asks, point them to the `waiver` or `trade` skill, which score a specific pickup, drop or trade by what it does to the weekly win chance. Punting or giving up a category is not measured yet: say so, and give the measured picture instead. Do not describe a category as "cheap to fix" or "easiest to win" unless a number in the result says it.
- Be honest that this is an estimate from past seasons: it does not model injuries, role changes, rest days or daily lineup limits.
- This is entertainment and strategy help. It is not betting or financial advice.

## Known limits (say so when they apply)

- **Players are valued from their last three completed seasons, not from this season's games.** The one exception is a player with no completed season (a rookie): he is judged on this season's games, which can swing a lot early on. A player with fewer than 5 games this season and no history counts as an average player (`none`). If the roster has a rookie or a returning player, say the number is less certain.
- A veteran who is playing far above or below his past seasons is not adjusted for it.
- Positions, injuries to starters, rest days and daily lineup limits are not modelled. The weekly simulation does use the real game counts when the data has the schedule.

## Data

The snapshot holds per-season averages for NBA players and the time it was generated (`snapshot.generated_at` in the result). It contains no game logs and no ownership data. If it is more than about two days old during the season, tell the user.


## Points leagues

For a head-to-head points league, give `league.scoring` instead of `league.categories`: the stat names exactly as the host's scoring page shows them, each with its weight (negative for a penalty), for example `{"Points":1,"Rebounds":1.2,"Assists":1.5,"Steals":3,"Blocks":3,"Turnovers":-1,"Field goals made":0.5,"Field goals attempted":-0.5}`. Read the league's scoring settings page for these; do not guess. Never send both. The script stops and names any stat it does not track, and refuses a weight on a percentage or ratio (weight the made and attempted counts instead).
- The result has `custom_categories: true` and a `points` block: the weights and where the user's expected week points sit among typical teams (percentile and band). There is no per-category ranking.
- `matchup` gives `week_win_pct`, `week_tie_pct`, `week_loss_pct` and `expected_points` (you, opponent, margin). Say all three chances.
- A week already under way needs `so_far` with `you.points`, `opponent.points` and `games_left` per team (as in a category league).
- Technical fouls, flagrant fouls, ejections and quad-doubles are not tracked: put them in `league.scoring` anyway and the script leaves them out and says `NOT SCORED` in `assumptions`. Tell the user.
- Games caps and minimum-games rules are not modelled; say so if the league has one.
