---
name: waiver
description: Fantasy basketball waiver-wire and streaming help for head-to-head 9-category leagues. Use when the user asks who to pick up, who to drop, whether a free agent is worth adding, or how to stream a roster spot. Reads the user's roster and the list of available players, then ranks each add (with the best drop) by how much it changes the user's weekly win chance, counting each player's real games from the NBA schedule.
---

# Fantasy basketball: pickups and drops

Ranks available players by what adding each one does to the user's chance of winning a week. A script does all the math. Every number is a difference between two simulations of the same weeks, one with the move and one without. **Never recommend a move from your own judgment: only report what the script measured.**

Only **head-to-head, standard 9-category** leagues are supported (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO). Say so for anything else; never approximate.

This skill is read-only. Never ask for a password, and never make adds, drops or trades for the user.

## What you need

1. **League settings**: teams, starters (players who count each week) and active roster spots. Use the user's **league card** (a pasted "FANTASY LEAGUE CARD" or `~/.fantasy-analyst/league.json`) if there is one; otherwise suggest the `setup` skill and ask directly meanwhile. Also note the **weekly add limit** and how many adds are left this week.
2. **The user's roster**, IL players marked.
3. **The available players**: the best ones in the league's free-agent list. Send **at most 60**. Take them from the top of the list by percent rostered or recent production, and say which list you used. Mention any player the user is specifically thinking of adding, even if he is not at the top.

Get these by the first route that works, in this order, saying in one line which one you use: a connected league tool; Claude in Chrome in the user's own signed-in browser; the built-in browser or computer use (the user signs in themselves if needed); text the user pastes; screenshots; the user typing names. If a route fails, say why in a few words and try the next.

**Before running anything, show the roster, the league settings and the candidate list, and ask the user to confirm.**

## Run the analysis

Write the request as JSON and run the script with Node 18 or newer, using the live data file (refreshed every night):

```bash
echo '{"league":{"teams":14,"roster_spots":13},
  "roster":[{"name":"Jalen Brunson"},{"name":"Max Strus","status":"IL"}],
  "waiver":{"lineup_slots":10,"horizon_weeks":2,
            "candidates":[{"name":"Ryan Kalkbrenner"},{"name":"Isaiah Stewart"}],"top":8}}' \
  | node ../team-check/scripts/analyze.mjs --snapshot https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json
```

(Use the path of the bundled script that is installed with this plugin: `skills/team-check/scripts/analyze.mjs`.) `horizon_weeks` is how many upcoming weeks to average, this week first (default 2, at most 4). If the download fails, run with `--snapshot ../team-check/data/snapshot.json` and tell the user the data may be out of date. If the script cannot run, say the analysis is unavailable and do not estimate.

## Read the result

Look at the `waiver` object:

- `baseline_week_win_pct`: the user's weekly win chance as the roster stands, averaged over `weeks_used`.
- `moves`: best first. Each has `add`, the `drop` that serves it best, `week_win_pct` after the move, `delta_points` (the change in weekly win chance, in percentage points) and `categories_delta_points` (the change in each category's win chance).
- A `delta_points` under about 1 is not a meaningful change: say "no real change". Quote the others as "about +N points".
- `games_source`: `schedule` means real game counts; `assumed` means an average week for everyone, so say the numbers are rougher.
- `names`: for any `ambiguous` or `not_found` player, ask the user which player they meant. Do not guess.
- `assumptions`: include the important ones.

## How to talk about it

- Lead with the best measured moves and what they do to the weekly win chance. Then say which categories each one moves, using the category deltas, in words.
- **Do not add advice of your own**: do not say a player "fits your build", do not suggest punting a category, and do not recommend moves that were not in the result. If the user asks for something the script did not measure (for example giving up a category), say it was not measured.
- Tell the user about the weekly add limit if the best moves outnumber the adds left, and let them choose.
- A win chance is not a prediction. The simulation does not model injuries, rest days, lineup moves or streaming during the week, and positions are ignored.
- This is entertainment and strategy help. It is not betting or financial advice.
