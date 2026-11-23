---
name: setup
description: One-time fantasy basketball league setup. Use when the user wants to set up their fantasy basketball league, connect or import their Yahoo or ESPN league, or has no saved league profile yet. Reads the full league settings and roster, runs a first team check, and saves a league card (and a profile file where files are allowed) that the other fantasy basketball skills read. Reports measured strengths and weaknesses only; it never proposes a punt as judgment.
---

# Fantasy basketball: league setup

Run this once per league. It reads the user's league, shows them what it found, reports what was measured, and saves a **league card** so later questions ("check my team", "who should I pick up") start from the right settings.

This skill is **read-only**. Never send adds, drops, trades or lineup changes. Never ask for a password, and never type one. If a site needs a login, ask the user to sign in themselves.

## 1. Existing profile

Look for `~/.fantasy-analyst/league.json`. If it exists, show the user its contents in plain words (host, league name, teams, roster spots, IL slots, strategy) and ask whether it is still right. If yes, stop here and tell them they can ask for a team check. If they have more than one league, keep one file per league: `~/.fantasy-analyst/<league-name>.json`, and ask which one they mean.

If you cannot read files, skip this step and go on.

## 2. Find out where the league lives

Ask which site hosts it (Yahoo, ESPN, Sleeper, CBS, or other) and ask them to name the league or paste its URL. If they have several, ask which one.

## 3. Read the league and roster: try every route, in this order

Move to the next route only when the one before is unavailable or fails. Tell the user in one line which route you are using.

1. **A connected league tool** (an MCP connector or plugin for that site), if one is available in this session.
2. **Claude in Chrome**, which works in the user's own signed-in browser. If its tools are not loaded, load them first. Open the league in a new tab, and read the settings page and the roster page.
3. **The built-in browser or computer use**, if the session has one. If the site needs a login, ask the user to sign in in that window, then continue.
4. **Pasted text.** Ask the user to open the league's settings page and roster page, select all, copy, and paste.
5. **Screenshots.** Ask for screenshots of the same pages and read them.
6. **Typing it out.** Last resort: ask the questions in step 4 one at a time.

Do not stop at the first failure. If a route fails, say why in a few words and try the next one. If every route fails, say so and give the user exactly what to paste.

## 4. What to collect

Read the whole settings page, not just the roster size. Write down what is there and leave out what the league does not have.

**Scoring** (read first)
- Category league, points league, or roto. The analysis supports only **head-to-head, standard 9 categories** (PTS, REB, AST, STL, BLK, 3PM, FG%, FT%, TO). If the league is points, roto or a different category list, say so plainly, still save the profile, and stop there. Do not approximate.
- The category list and how many there are; whether a week is won by most categories.

**Structure**
- League name, host, URL or league id, your team name
- Number of teams
- Starting spots (players who count each week), bench spots, and IL slots
- Lineup lock: daily or weekly
- Weekly add limit
- Matchup length (usually one week)

**Season end**
- Playoffs: how many teams, which week they start, how many weeks they last
- Tiebreakers (for a tied category and for the standings)
- Waiver type and the trade deadline

**Your roster**
- Every player, with IL players marked

## 5. Confirm

Show what you read: the league settings as a short list, and the full roster. Ask the user to confirm. Misread names and a wrong spot count are the most likely sources of a wrong answer. Fix what they correct.

## 6. First team check

Run the team-check skill on this roster (the script is `skills/team-check/scripts/analyze.mjs` in this plugin). Give the user the picture in plain words: the strengths, the holes, and which holes look cheapest to fix. Quote rounded numbers and say how the numbers were measured.

## 7. Strategy and punts: measured only

Never offer a punt, a build, or a "give up this category" suggestion as your own judgment. A statistical punt recommendation comes from comparing the best roster the user could build with a category conceded against without it, and that needs the waiver and trade tools, which are not available in this skill.

So at this step:
- Report only what was measured: which categories the team is built to win and which it is losing.
- If the user asks whether to punt something, say the analysis cannot measure that yet, and give the measured view instead.
- Do not store a punt in the profile unless the user states one themselves, and then save it as their stated choice, not as a finding.

## 8. Save the league card

Print the **league card**: a short block of plain text the user can save and paste back later. This is the portable form and it works in any chat app:

```
FANTASY LEAGUE CARD
Host: Yahoo
League: Example League (id 12345)
Team: My Team
Format: head-to-head, 9 categories (PTS REB AST STL BLK 3PM FG% FT% TO)
Teams: 14   Starters: 10   Bench: 3   IL: 4
Lineup: daily   Weekly adds: 4   Matchup: 1 week
Playoffs: 8 teams, from week 21, 3 weeks
Tiebreakers: category tie = no win for either side
Waivers: priority   Trade deadline: Feb 20
Stated strategy: none
Card date: 2026-11-23
```

Tell the user to save it in their app's custom instructions, memory or project notes, and to paste it at the start of a chat if the app does not remember it.

If you can write files (Claude Code, Cowork), also save the same facts as JSON to `~/.fantasy-analyst/league.json` (create the folder if needed; one file per league, named after it, when there are several):

```json
{
  "version": 1,
  "host": "yahoo",
  "league_name": "Example League",
  "league_url": "https://...",
  "team_name": "My Team",
  "teams": 14,
  "roster_spots": 13,
  "starters": 10,
  "bench_spots": 3,
  "il_slots": 4,
  "categories": "9cat",
  "format": "h2h",
  "lineup": "daily",
  "weekly_add_limit": 4,
  "matchup_weeks": 1,
  "playoffs": { "teams": 8, "start_week": 21, "weeks": 3 },
  "tiebreakers": "...",
  "waivers": "priority",
  "trade_deadline": "2027-02-20",
  "strategy": null,
  "updated_at": "2026-11-23"
}
```

`roster_spots` is the number of non-IL players on the roster (starters plus bench); `starters` is how many count each week. **Do not save the roster**: it changes daily, so read it fresh each time. Do not save passwords or tokens.

Finish by telling the user what was saved, that they can now ask for a team check any time, and where the card is.
