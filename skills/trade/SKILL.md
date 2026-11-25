---
name: trade
description: Fantasy basketball trade help for head-to-head category leagues. Use when the user has a trade offer to evaluate, wants to know whether a trade helps them, or wants trade ideas with another team. Scores a trade by how it changes the user's weekly win chance (and the other team's, when their roster is known), counting each player's real games from the NBA schedule, and can search one-for-one offers that help the user without hurting the other team.
---

# Fantasy basketball: trades

Scores trades by what they do to a team's chance of winning a week. A script does all the math. Every number is a difference between two simulations of the same weeks, one with the trade and one without. **Never judge a trade from your own opinion: only report what the script measured.**

**Head-to-head category leagues with any mix of these categories** (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO, plus FGM, FGA, FTM, FTA, 3PA, 3P%, OREB, DREB, PF, A/T, MIN, DD (double-doubles) and TD (triple-doubles)) are supported. Put the league's categories, exactly as the host names them, in `league.categories` of the request (for example `["Points","Rebounds","3-pointers made","Double-doubles"]`). Leave it out only for the standard nine. If a category is not on the list, the script stops and names it: say so plainly and do not approximate. A tie in the week is reported as a tie, not a win. Points leagues and roto are not supported yet.

This skill is read-only. Never ask for a password, never propose or accept a trade in the league for the user, and never send messages for them.

## What you need

1. **League settings**: teams, starters and active roster spots, from the user's **league card** (a pasted "FANTASY LEAGUE CARD" or `~/.fantasy-analyst/league.json`), or from the `setup` skill, or by asking.
2. **The user's roster**, IL players marked.
3. **For evaluating a trade**: the players the user would give and get.
4. **For scoring the other side, or searching offers**: the other team's roster. Without it you can only score the user's side.

Get these by the first route that works, in this order, saying in one line which one you use: a connected league tool; Claude in Chrome in the user's own signed-in browser; the built-in browser or computer use (the user signs in themselves if needed); text the user pastes; screenshots; the user typing names. If a route fails, say why in a few words and try the next.

**Before running anything, show the roster(s), the players in the trade and the league settings, and ask the user to confirm.**

## Run the analysis

**Evaluate a trade** (any number of players each way):

```bash
echo '{"league":{"teams":14,"roster_spots":13},
  "roster":[{"name":"Jalen Brunson"},{"name":"Andrew Wiggins"}],
  "trade":{"lineup_slots":10,"give":[{"name":"Andrew Wiggins"}],"get":[{"name":"Isaiah Hartenstein"}],
           "other_roster":[{"name":"Isaiah Hartenstein"},{"name":"Some Player"}]}}' \
  | node ../team-check/scripts/analyze.mjs --snapshot https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json
```

**Search one-for-one offers** with another team: send `"search":true` and `other_roster`, and leave out `give` and `get`:

```bash
... "trade":{"lineup_slots":10,"search":true,"top":5,"other_roster":[ ... ]} ...
```

(Use the path of the bundled script that is installed with this plugin: `skills/team-check/scripts/analyze.mjs`.) `horizon_weeks` (default 2, at most 4) is how many upcoming weeks to average. If the download fails, run with `--snapshot ../team-check/data/snapshot.json` and tell the user the data may be out of date. If the script cannot run, say the analysis is unavailable and do not estimate.

## Read the result

Look at the `trade` object:

- `you`: `before_week_win_pct`, `after_week_win_pct`, `delta_points` (the change in your weekly win chance, in percentage points) and `categories_delta_points` (the change in each category's win chance). A `delta_points` under about 1 is not a meaningful change: say "no real change".
- `other_team`: the same for the other side, when their roster was given.
- `offers` (search mode): one-for-one swaps that raise your weekly win chance without lowering theirs, best for the user first, each with both sides' numbers.
- `games_source`: `schedule` means real game counts; `assumed` means an average week for everyone, so say the numbers are rougher.
- `schedule_incomplete`: true means a week still has NBA games with a team to be announced, so some game counts may be low. Say so before quoting numbers.
- `names`: for any `ambiguous` or `not_found` player, ask which player was meant. Do not guess. A trade involving someone the user does not have is rejected.
- `assumptions`: include the important ones.

## How to talk about it

- Lead with what the trade does to the user's weekly win chance, then which categories gain and lose, in words. If the other team's numbers are available, say whether the trade helps both sides, one side, or neither. A trade that helps the other team more than you is a measured fact, not a verdict: the user decides.
- **Do not add advice of your own**: no "you should accept", no guesses about what the other owner will want, no suggestions that were not in the result. If the user asks for something the script did not measure (for example giving up a category), say it was not measured.
- A search finds swaps that look good on paper for both rosters. It does not know what the other owner values, positions, or injuries. Say so.
- A win chance is not a prediction. The simulation does not model injuries, rest days, lineup moves or streaming during the week.
- This is entertainment and strategy help. It is not betting or financial advice.
