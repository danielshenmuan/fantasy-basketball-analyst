---
name: matchup
description: Weekly fantasy basketball head-to-head matchup for head-to-head category leagues. Use when the user asks about this week's matchup, whether they will beat their opponent, or which categories they are likely to win or lose this week. Reads the user's roster and their opponent's roster, counts the real games each player has this week from the NBA schedule, and returns a win chance for each category and for the week.
---

# Fantasy basketball: this week's matchup

Compares the user's roster with their real opponent's for one week. A script does all the math: your job is to collect the rosters accurately, run it, and explain the result in plain words.

**Head-to-head category leagues with any mix of these categories** (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO, plus FGM, FGA, FTM, FTA, 3PA, 3P%, OREB, DREB, PF, A/T, MIN, DD (double-doubles) and TD (triple-doubles)) are supported. Put the league's categories, exactly as the host names them, in `league.categories` of the request (for example `["Points","Rebounds","3-pointers made","Double-doubles"]`). Leave it out only for the standard nine. If a category is not on the list, the script stops and names it: say so plainly and do not approximate. A tie in the week is reported as a tie, not a win. Roto is not supported yet; points leagues use `league.scoring` (see below).

This skill is read-only. Never ask for a password and never send adds, drops, trades or lineup changes.

## What you need

1. **League settings**: number of teams, starters (players who count each week) and active roster spots. Use the user's **league card** (a pasted "FANTASY LEAGUE CARD", or `~/.fantasy-analyst/league.json`) if there is one; otherwise suggest the `setup` skill, and ask directly in the meantime.
2. **The user's roster**, IL players marked.
3. **The opponent's roster** for the week: find who the user plays this week on the matchup page, then that team's roster page. If the opponent is not known or cannot be read, run without one: the script then uses typical opponents, and you must say so.
4. **Which week.** Default is the current week (Monday to Sunday). For a future week, pass its Monday as `week_start`; the data covers about four weeks.

## Getting the rosters: try every route, in this order

Read both rosters, the opponent and the live score **in one pass without asking for pasted text**: follow `../analyst/reading-a-league.md` (Yahoo matchup and team pages; ESPN `view=mMatchup` for the opponent and banked stats, and `view=mRoster` for both rosters). Ask the user to paste only when those routes fail. Say in one line which route you use. Move on only when the one before fails, and say why in a few words.

1. A connected league tool for that site.
2. Claude in Chrome, in the user's own signed-in browser (open the pages in a new tab).
3. The built-in browser or computer use; if a login is needed, ask the user to sign in themselves.
4. Text the user pastes from the roster and matchup pages.
5. Screenshots of those pages.
6. The user types the names.

**Before running anything, show both rosters and the league settings and ask the user to confirm.** Misread names are the most likely source of a wrong answer.

## A week already under way

Mid-week, read the live score from the matchup page (or ESPN's `scoreByStat`, see the reading guide) and pass it in, or the result restarts from 0-0 and ignores what is already banked. Also pass each team's games still to play, so every player gets his own team's remaining games (a player whose team plays four more times counts for more than one whose team plays once).

1. Get games left with the helper, from the first day not yet counted in the banked stats through Sunday (today, if today's games have not started and the page does not show them):
   `node skills/matchup/scripts/games-left.mjs 2026-11-24 2026-11-29`  (prints `{"games":{"ATL":2,...}}`, team codes as in the data file; reads the public NBA scoreboard).
2. Add `so_far` inside `matchup` (needs a real opponent): made/attempted shots, not percentages, for both sides, plus that `games`:

```json
"so_far":{"games_left":{"ATL":2,"BKN":3},
  "you":{"pts":154,"reb":40,"ast":36,"stl":2,"blk":7,"fg3m":22,"tov":14,"fgm":48,"fga":114,"ftm":36,"fta":37},
  "opponent":{"pts":129,"reb":35,"ast":26,"stl":9,"blk":6,"fg3m":17,"tov":20,"fgm":49,"fga":102,"ftm":14,"fta":15}}
```

If the helper cannot run, use `"remaining_share"` instead of `games_left` (the page's games remaining divided by total, e.g. 34 of 43 = 0.79): rougher, because it gives every player the same share. Games in progress are in neither the banked stats nor the games left; say so.

Check `matchup.so_far_counted` is true and say the live score was counted. A player who returns mid-week is handled with a scenario (below); the engine does not guess it.

## Your lineup, scenarios and daily lineups

- **Your lineup**: if the user sets their own lineup (most do), pass the starters' names as `matchup.lineup`. The numbers then use exactly that lineup (`lineup_source: "user"`), and when the model's best fit would do better it is returned as `recommended_lineup` with its win chance: report it as a recommendation, not as what they must do. Without `matchup.lineup` the best-fit lineup is used (`"recommended"`). A lineup that cannot be seated in the league's slots is refused with the names that do not fit.
- **Scenarios** ("what if Embiid is out", "what if Giannis is back Thursday"): add `matchup.scenarios`, for example `[{"name":"Joel Embiid","returns":"2026-11-27"}, {"side":"opponent","name":"Nikola Jokic","out_until":"2026-11-26"}]`. Each player's games are reduced by the games his team plays while he is out (exact when the day-by-day schedule is available, spread evenly and flagged otherwise). **Always say these are the user's assumptions, not measured facts**; each affected player carries a `note` saying so. `games_lost` shows what was taken away.
- **Daily lineups and streaming** (daily-lock leagues): add `matchup.daily` with `start`/`bench` (name and the days), and/or `stream.candidates` (free agents, with `adds_left`). It models each day left, with the best lineup among the players whose teams play that day, and reports `lineup_by_day`, the effect of your starts and benches, and a ranked list of streamers (what each does to the weekly win chance if added now and kept for the rest of the week). Needs the day-by-day schedule: run `node skills/matchup/scripts/season-days.mjs <first day> <last day>` and pass its `days` object as `schedule_days` at the top of the request. A weekly-lock league has no daily lineup: the engine refuses and says so. When `daily.rough` is true (under a third of the week left) say the numbers are rougher. A streamer is assumed to stay to the end of the week.

## Positions, slots, injuries and statuses

- If the league card has `slots`, send them as `league.slots` (this replaces `lineup_slots`; send one or the other, never both with different numbers). Then every player on your roster, every opponent player and every candidate needs `positions` exactly as the host shows his eligibility (`"positions":"PG,SG"`), read in the same pass as the roster. The engine then fills the lineup by position, picks the best fit each week and shows each starter's `slot`. A player with no positions can only fill a UTIL slot, and the output warns that the empty-slot check is off.
- Send each player's host injury tag as `"injury":"OUT"` (or GTD, DTD) and the date the host shows for his return as `"return_date":"2026-11-27"`. **Read these live every time and never reuse them from an earlier run**: a status can be cleared at any time. OUT with a return date uses that date; OUT with no date is counted as out for the rest of this week and back next week, and the output says that is an assumption; GTD/DTD counts as playing and is flagged. If a player's status changed since the page was read, the user tells the analyst and you correct the request.
- After a return, a player's first 3 games count at 80% (an assumption, not measured; the user can change it with `ramp`, or turn it off with `"ramp":false`).
- Today's date for these windows is `as_of` (default: the data file's date).

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
- `schedule_incomplete`: true means the NBA schedule for this week still has games with a team to be announced, so some game counts may be low. Say so before quoting numbers.
- `rosters.you` and `rosters.opponent`: every matched player with his team's `games` this week, `games_left` (when the week is under way), and `counted` (true if he is in the counted lineup; false for bench and IL). When the user asks who has how many games left, answer from this list.
- `names` (top level and inside `matchup`): for any `ambiguous` or `not_found` player, ask the user which player they meant. Do not guess. That player is left out of the totals until clarified.
- `warnings`: players left out of the numbers (name not found or ambiguous). Say these first, before any result, and ask which player was meant. Hosts' short names ("M. Johnson Jr. (DAL, PF)") are accepted as typed; pass the team and position when the host shows them.
- `matchup.assumptions`: include the important ones.

## How to talk about it

- Lead with the weekly win chance, then the categories that decide it: the closest ones and the clear wins and losses. Describe a 50% category as a toss-up.
- A win chance is not a prediction. It is the share of simulated weeks in which the rosters, as they stand, win. It does not model injuries, rest days, lineup moves or streaming during the week, except the injury statuses, scenarios and daily options above, which are labelled.
- **Do not suggest moves** (pickups, drops, trades, which category to give up) as your own judgment. If the user asks what to do, point them to the `waiver` skill (pickups and drops) or the `trade` skill, which measure a move. Giving up a category is not measured yet: say so, and give the measured picture instead.
- Use plain words. Do not mention z-scores or an internal score.
- This is entertainment and strategy help. It is not betting or financial advice.

## Custom category lists

When `league.categories` is not the standard nine, the result has `custom_categories: true` and these differences apply:
- `matchup.week_win_pct`, `week_tie_pct` and `week_loss_pct` are reported separately. Say all three; a tie is not a win.
- `matchup.categories` is keyed by the league's own category codes.
- A week already under way needs `so_far` with `you` and `opponent` in base stats: made and attempted shots (`fgm`, `fga`, `ftm`, `fta`, `fg3m`, `fg3a`), `oreb`, `dreb`, `ast`, `stl`, `blk`, `turnovers`, `pf`, `minutes`, `dd`, `td`. Percentages and ratios are rebuilt from those, so read the made and attempted numbers, not the displayed percentage. Only the stats this league's categories use are required. The script names any that are missing.
- If the script says the data file has no stat yet (for example `dd_rate`), report that plainly; the nightly update adds it.


## Points leagues

For a head-to-head points league, give `league.scoring` instead of `league.categories`: the stat names exactly as the host's scoring page shows them, each with its weight (negative for a penalty), for example `{"Points":1,"Rebounds":1.2,"Assists":1.5,"Steals":3,"Blocks":3,"Turnovers":-1,"Field goals made":0.5,"Field goals attempted":-0.5}`. Read the league's scoring settings page for these; do not guess. Never send both. The script stops and names any stat it does not track, and refuses a weight on a percentage or ratio (weight the made and attempted counts instead).
- The result has `custom_categories: true` and a `points` block: the weights and where the user's expected week points sit among typical teams (percentile and band). There is no per-category ranking.
- `matchup` gives `week_win_pct`, `week_tie_pct`, `week_loss_pct` and `expected_points` (you, opponent, margin). Say all three chances.
- A week already under way needs `so_far` with `you.points`, `opponent.points` and `games_left` per team (as in a category league).
- Technical fouls, flagrant fouls, ejections and quad-doubles are not tracked: put them in `league.scoring` anyway and the script leaves them out and says `NOT SCORED` in `assumptions`. Tell the user.
- Games caps and minimum-games rules are not modelled; say so if the league has one.
