---
name: outlook
description: Rest-of-season and playoff outlook for head-to-head fantasy basketball leagues. Use when the user asks about making the playoffs, their seed, a bye, their title chances, how many wins they will finish with, or how a pickup or trade changes their playoff odds. Reads the league's standings, remaining matchups and playoff rules and returns projected wins, playoff chance, seed chances and a title chance. Measured, with the limits stated.
---

# Fantasy basketball: rest of season and playoffs

Plays the rest of the season out many times: each remaining week's win chance comes from the same weekly simulation the `matchup` skill uses, then standings and the playoff bracket are applied. A script does all the math. **Never estimate odds yourself.** Read-only: never send adds, drops, trades or lineup changes.

## What you need

Read these in one pass from the league (follow `../analyst/reading-a-league.md`; try every route in the usual order and say which you use); ask the user only for what cannot be read:

1. **League settings** (the league card or the `setup` skill): teams, slots, categories or scoring, **playoff teams, the first playoff week, tiebreaker** and the lineup lock.
2. **Your roster** (with `positions` when the league has slots, and each player's live injury tag and return date, as in the `matchup` skill).
3. **Your record** so far (wins, losses, ties) and, if the host shows it, your value of the league's tiebreaker (for example total category wins or points for).
4. **Every other team's record** (and tiebreaker value) from the standings page. Without them the output has only your projected wins, and says so.
5. **Your remaining regular-season matchups** from the schedule page: the Monday of each week and, where the host shows it, that opponent's roster. A week without a roster uses a typical opponent.
6. **The day-by-day NBA schedule** to the end of the season: `node skills/matchup/scripts/season-days.mjs <today> <last playoff day>` prints `{"days":{...}}`; pass that object as `schedule_days` at the top of the request. Without it, weeks beyond the data file's schedule use an average week of games and are marked `assumed`.

**Before running anything, show the roster, record, standings, remaining opponents and playoff rules and ask the user to confirm.**

## Run the analysis

```bash
echo '{"league":{"teams":12,"roster_spots":13,"slots":["PG","SG","G","SF","PF","F","C","C","UTIL","UTIL"]},
  "roster":[{"name":"Jalen Brunson","positions":"PG"}],
  "schedule_days":{"2026-11-23":["ATL","BOS"]},
  "outlook":{"record":{"wins":5,"losses":3,"tiebreak_value":41},
    "remaining":[{"week_start":"2026-12-07","opponent":[{"name":"Nikola Jokic","positions":"C"}]},{"week_start":"2026-12-14"}],
    "playoffs":{"teams":6,"first_week":"2027-03-08","tiebreaker":"total category wins"},
    "standings":[{"team":"Team A","wins":6,"losses":2,"tiebreak_value":47}],
    "move":{"add":{"name":"Isaiah Stewart","positions":"C"},"drop":"Max Strus"}}}' \
  | node ../team-check/scripts/analyze.mjs --snapshot https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json
```

(Use the bundled script: `skills/team-check/scripts/analyze.mjs`.) `outlook.move` accepts `add`/`drop` or `give`/`get` and re-runs the whole season with the change. `weeks` (default 2000 per week) and `runs` (default 5000) set the simulation size; a long season is slow, so keep the defaults. If the script cannot run, say the analysis is unavailable.

## Read the result

Look at the `outlook` object:

- `expected_final_wins` and `final_wins_pct` (chance of each final win total).
- `per_week`: each remaining week's win and tie chance, whether the opponent was a `roster` or `typical`, and `games_source` (`assumed` means no schedule for that week: say the number is rougher).
- `playoffs` (needs standings): `make_pct`, `bye_pct`, `seed_pct` (chance of each seed), `round_win_pct` (chance of winning each round you play, given you are in it), `title_pct`, and `tiebreak_decides_pct` (how often your spot hung on a tie in the record, which the tiebreaker or a coin flip settled).
- `move`: the same numbers with the change, `delta_wins`, `delta_playoff_points` and `delta_title_points`. Quote it as a difference between two simulations.
- `assumptions`: include the important ones, always these three: the roster is held as it stands (no future adds, trades or injuries); other teams' remaining games are coin flips because their rosters are not known, so the top and bottom of the table are understated; the playoff rounds use a typical opponent.

## How to talk about it

- Lead with the playoff chance and projected wins, then the seed and title chances, then the move if one was asked.
- These are probabilities for the roster as it stands, not predictions. Do not say a team is "safe" or "doomed"; say the chance.
- Do not add advice of your own (which category to give up, who to target): only what the script measured. A recommendation to punt is never made.
- If `tiebreak_decides_pct` is large, say the tiebreaker matters and quote it as the league states it; the model only knows today's tiebreak values.
- This is entertainment and strategy help. It is not betting or financial advice.
