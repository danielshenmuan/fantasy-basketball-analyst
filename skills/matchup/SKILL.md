---
name: matchup
description: Weekly fantasy basketball head-to-head matchup for 9-category leagues. Use when the user asks about this week's matchup, whether they will beat their opponent, or which categories they are likely to win or lose this week. Reads the user's roster and their opponent's roster, counts the real games each player has this week from the NBA schedule, and returns a win chance for each category and for the week.
---

# Fantasy basketball: this week's matchup

Compares the user's roster with their real opponent's for one week. A script does all the math: your job is to collect the rosters accurately, run it, and explain the result in plain words.

Only **head-to-head, standard 9-category** leagues are supported (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO). Say so for anything else; never approximate.

This skill is read-only. Never ask for a password and never send adds, drops, trades or lineup changes.

## What you need

1. **League settings**: number of teams, starters (players who count each week) and active roster spots. Use the user's **league card** (a pasted "FANTASY LEAGUE CARD", or `~/.fantasy-analyst/league.json`) if there is one; otherwise suggest the `setup` skill, and ask directly in the meantime.
2. **The user's roster**, IL players marked.
3. **The opponent's roster** for the week: find who the user plays this week on the matchup page, then that team's roster page. If the opponent is not known or cannot be read, run without one: the script then uses typical opponents, and you must say so.
4. **Which week.** Default is the current week (Monday to Sunday). For a future week, pass its Monday as `week_start`; the data covers about four weeks.

## Getting the rosters: try every route, in this order

Say in one line which route you use. Move on only when the one before fails, and say why in a few words.

1. A connected league tool for that site.
2. Claude in Chrome, in the user's own signed-in browser (open the pages in a new tab).
3. The built-in browser or computer use; if a login is needed, ask the user to sign in themselves.
4. Text the user pastes from the roster and matchup pages.
5. Screenshots of those pages.
6. The user types the names.

**Before running anything, show both rosters and the league settings and ask the user to confirm.** Misread names are the most likely source of a wrong answer.

## A week already under way

Mid-week, read the live score from the matchup page and pass it in, or the result restarts from 0-0 and ignores what is already banked. Also pass each team's games still to play, so every player gets his own team's remaining games (a player whose team plays four more times counts for more than one whose team plays once).

1. Get games left with the helper, from the first day not yet counted in the banked stats through Sunday (today, if today's games have not started and the page does not show them):
   `node skills/matchup/scripts/games-left.mjs 2026-11-24 2026-11-29`  (prints `{"games":{"ATL":2,...}}`, team codes as in the data file; reads the public NBA scoreboard).
2. Add `so_far` inside `matchup` (needs a real opponent): made/attempted shots, not percentages, for both sides, plus that `games`:

```json
"so_far":{"games_left":{"ATL":2,"BKN":3},
  "you":{"pts":154,"reb":40,"ast":36,"stl":2,"blk":7,"fg3m":22,"tov":14,"fgm":48,"fga":114,"ftm":36,"fta":37},
  "opponent":{"pts":129,"reb":35,"ast":26,"stl":9,"blk":6,"fg3m":17,"tov":20,"fgm":49,"fga":102,"ftm":14,"fta":15}}
```

If the helper cannot run, use `"remaining_share"` instead of `games_left` (the page's games remaining divided by total, e.g. 34 of 43 = 0.79): rougher, because it gives every player the same share. Games in progress are in neither the banked stats nor the games left; say so.

Check `matchup.so_far_counted` is true and say the live score was counted. Injured players are still not modelled, including ones who return mid-week.

## Run the analysis

Write the request as JSON and run the script with Node 18 or newer, using the live data file (refreshed every night):

```bash
echo '{"league":{"teams":14,"roster_spots":13},
  "matchup":{"lineup_slots":10,"opponent":[{"name":"Nikola Jokic"},{"name":"Some Player","status":"IL"}]},
  "roster":[{"name":"Jalen Brunson"},{"name":"Max Strus","status":"IL"}]}' \
  | node ../team-check/scripts/analyze.mjs --snapshot https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json
```

(Use the path of the bundled script that is installed with this plugin: `skills/team-check/scripts/analyze.mjs`.) Add `"week_start":"YYYY-MM-DD"` inside `matchup` for a week other than the current one. If the download fails, run with `--snapshot ../team-check/data/snapshot.json` and tell the user the data may be out of date.

If the script cannot run at all, say the analysis is unavailable. Do not estimate the numbers yourself.

## Read the result

Look at the `matchup` object:

- `categories`: whole percent of simulated weeks the user wins each category. `week_win_pct`: the percent of weeks they win 5 or more of 9. `distribution_pct`: how often they win exactly 0 to 9. Quote these as given.
- `opponent`: `roster` means the real opponent was used; `typical` means no opponent was read and these are typical opponents.
- `games_source`: `schedule` means each player's games this week come from the NBA schedule; `assumed` means an average week (3.4 games) for everyone, so say the numbers are rougher.
- `names` (top level and inside `matchup`): for any `ambiguous` or `not_found` player, ask the user which player they meant. Do not guess. That player is left out of the totals until clarified.
- `matchup.assumptions`: include the important ones.

## How to talk about it

- Lead with the weekly win chance, then the categories that decide it: the closest ones and the clear wins and losses. Describe a 50% category as a toss-up.
- A win chance is not a prediction. It is the share of simulated weeks in which the rosters, as they stand, win. It does not model injuries, rest days, lineup moves or streaming during the week.
- **Do not suggest moves** (pickups, drops, trades, which category to give up) as your own judgment. If the user asks what to do, say that this recommendation is not available yet because it has to be measured, and give the measured picture instead.
- Use plain words. Do not mention z-scores or an internal score.
- This is entertainment and strategy help. It is not betting or financial advice.
