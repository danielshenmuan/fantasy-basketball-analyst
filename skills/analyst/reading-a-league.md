# Reading a league automatically (shared by every fantasy basketball skill)

Goal: after the user names a league, read **everything the question needs in one pass, without asking them to paste anything**: league settings, their roster, this week's opponent and the opponent's roster, the stats banked so far this week, and the free-agent list. Ask the user only when every route below has failed for that item.

Read-only, always: never ask for or type a password, never click add, drop, trade, propose, accept, lineup or any save button. If a page needs a login, ask the user to sign in themselves in that window, then carry on.

Say in **one line** which route you are using. If a route fails, say why in a few words and try the next.

## Fallback ladder (same order for every item)

1. A connected league tool (an MCP connector or plugin for that host), if this session has one.
2. **Claude in Chrome** (the user's own signed-in browser). Load its tools in one ToolSearch call first, open a new tab, and read with `get_page_text` or `javascript_tool`.
3. **The built-in browser** (the in-app pane, or computer use). Same recipes; `get_page_text` reads a page without screenshots.
4. Text the user pastes (ask them to open the page, select all, copy, paste).
5. Screenshots.
6. Typing it out, one question at a time.

Read what you need **in parallel where you can** (settings, roster, matchup, free agents are independent pages). Do not read pages the question does not need: a team check needs settings and roster only.

## What each skill needs

| Item | setup | team-check | matchup | waiver | trade |
|---|---|---|---|---|---|
| League settings (or the saved card) | yes | card | card | card | card |
| Your roster | yes | yes | yes | yes | yes |
| This week's opponent and their roster | no | no | yes | no | for a trade partner |
| Banked stats so far this week | no | no | mid-week | no | no |
| Free-agent list (at most 60) | no | no | no | yes | no |

A saved league card replaces the settings read. Re-read settings only in `setup`, or if the user says the league changed.

## Yahoo (basketball.fantasysports.yahoo.com/nba/<league-id>/...)

Ask for the league name or URL only if the card does not give the id. With the user signed in, open these in Chrome or the built-in browser and read the page text:

- **Settings:** `/nba/<league-id>/settings`. Scoring type, the category list (copy names exactly), roster positions (starters, bench, IL), weekly add limit, waiver type, trade deadline, playoffs, tie-break. A points league lists a stat weight for each stat.
- **Your roster:** `/nba/<league-id>/<your-team-id>`. The league home page links to your team. IL players are in the IL slots.
- **This week's matchup and opponent:** `/nba/<league-id>/matchup`. It names the opponent and shows each category side by side with the stats banked so far. For percentage categories read the made and attempted numbers (for example 48/114) when the page shows them; Yahoo's matchup page shows only FG% and FT%: read those and pass them as `fg_pct` and `ft_pct`; the matchup then labels the live score estimated and gives the measured error (see the matchup skill).
- **Opponent roster:** the opponent's team link on the matchup page, `/nba/<league-id>/<opponent-team-id>`.
- **Free agents:** `/nba/<league-id>/players` with the status filter on **Available** and the list sorted by percent rostered (or rank). Read the first page or two; stop at 60 names. Note which sort you used.
- **Trade partner roster:** any team's page, the same way.

Yahoo shows the week's day-by-day totals on the matchup page; use the weekly totals row.

## ESPN (fantasy.espn.com/basketball)

ESPN's page is a script app, so the rendered text is poor. Its own data endpoints are JSON and work from the user's signed-in browser session. Run the requests **from a tab already on fantasy.espn.com** (Chrome or built-in browser, `javascript_tool`), with `credentials: "include"`, so the user's own login cookies go along. Never copy cookies out or ask the user for them.

Base URL (the league id is in the league page URL as `leagueId=`; the year is the season's end year, for example 2027 for 2026-27):

```
https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/<year>/segments/0/leagues/<id>?view=mSettings
```

Add several views in one call with repeated `view=` parameters. Example:

```js
const base = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/12345";
const get = (q, h) => fetch(base + q, {credentials: "include", headers: h}).then(r => r.json());
const settings = await get("?view=mSettings&view=mTeam&view=mStatus");
const roster   = await get("?view=mRoster");
const matchups = await get("?view=mMatchup&view=mMatchupScore");
```

A 401/403 means the user is not signed in (or the league is private to another account): ask them to sign in on that tab, then retry. A page of login HTML instead of JSON means the same.

**Settings (`view=mSettings`)**
- `settings.name`, `settings.size` (teams), `status.currentMatchupPeriod` (the current week; needs `view=mStatus`).
- `settings.scoringSettings.scoringType`: `H2H_CATEGORY`, `H2H_POINTS`, `H2H_MOST_CATEGORIES` or a roto type. Roto: use the Roto section below (standings and every roster).
- `settings.scoringSettings.scoringItems`: one item per scored stat, `{statId, points, isReverseItem, ...}`. Map the stat ids to the host names the engine knows:

| statId | stat | statId | stat |
|---|---|---|---|
| 0 | Points | 13 | Field goals made |
| 1 | Blocks | 14 | Field goals attempted |
| 2 | Steals | 15 | Free throws made |
| 3 | Assists | 16 | Free throws attempted |
| 4 | Offensive rebounds | 17 | 3-pointers made |
| 5 | Defensive rebounds | 18 | 3-pointers attempted |
| 6 | Rebounds | 37 | Double-doubles |
| 7 | Ejections | 38 | Triple-doubles |
| 8 | Flagrant fouls | 39 | Quadruple-doubles |
| 9 | Personal fouls | 10 | Technical fouls |
| 11 | Turnovers | | |

Percentages and a few others (field goal %, free throw %, 3-point %, minutes, assist-to-turnover) have their own ids that were not verified here: if an id is not in the table, **do not guess**; read the league's scoring page text for the name, or ask. Never invent a mapping.

- **Category league** (`H2H_CATEGORY` or `H2H_MOST_CATEGORIES`): the scored items are the categories. Put their names in `league.categories` in the order ESPN lists them. `isReverseItem: true` means lower is better (turnovers); the engine already knows turnovers and personal fouls are reverse categories.
- **Points league** (`H2H_POINTS`): each item's `points` is the weight. Put them in `league.scoring`, for example `{"Points":1,"Rebounds":1.2,"Assists":1.5,"Turnovers":-1}`. Items with `pointsOverrides` for specific lineup slots are rare; if any exist, say the weights are approximate. Ejections, flagrant fouls, technical fouls and quadruple-doubles are not tracked: keep them in `league.scoring`; the script marks them `NOT SCORED` and you tell the user.
- Roster size: `settings.rosterSettings.lineupSlotCounts` maps a lineup slot id to a count. Starters are the slots that are not the bench or the injured reserve; check the sum against what the league's settings page says before trusting it, because the bench and IR ids were not verified here.
- Also read `settings.scheduleSettings` (matchup length, playoff teams and weeks), `settings.acquisitionSettings.acquisitionLimit` (weekly adds), `settings.tradeSettings.deadlineDate`.

**Your roster and any team's roster (`view=mRoster`)**
- `teams[]` has one team per entry; `teams[i].roster.entries[]` are its players. Name: `playerPoolEntry.player.fullName`; injury: `playerPoolEntry.player.injuryStatus`; slot: `lineupSlotId`.
- Find the user's team: `settings` with `view=mTeam` lists each team's `id`, name and `primaryOwner`; the user's is the one whose owner matches the signed-in user (compare with the team name the user gave, or ask which team is theirs if it is unclear).
- A player in the injured-reserve lineup slot is IL. If you cannot tell which slot id is IR, use `injuryStatus` as a hint only and ask the user which players are in their IL slots.

**This week's opponent and banked stats (`view=mMatchup&view=mMatchupScore`)**
- `schedule[]` holds every matchup. Take the entries with `matchupPeriodId === status.currentMatchupPeriod` where `home.teamId` or `away.teamId` is the user's team id. The other side is the opponent; fetch its roster from `view=mRoster`.
- Banked stats: `home.cumulativeScore.scoreByStat` and `away.cumulativeScore.scoreByStat`, keyed by statId (use the table above), each `{score, result}`. In a points league `home.totalPoints` and `away.totalPoints` are the banked points.
- `scoreByStat` holds the scored categories only, and for a percentage category it holds the percentage. The engine needs made and attempted numbers for percentages (`fgm`, `fga`, `ftm`, `fta`): when the response does not give them, read them from the league's matchup page text, or from `view=mBoxscore` if it carries them for the week, and if neither does, pass the percentages as `fg_pct` and `ft_pct`: the result is labelled `estimated`, with the measured error. If even the percentages are missing the result is `fresh-week` (the whole week from 0-0); say so.
- For a future week use that week's `matchupPeriodId` and set `week_start` to its Monday.

**Free agents (`view=kona_player_info`)**
This one needs a filter header. Fetch from the same signed-in tab:

```js
const filter = {players: {filterStatus: {value: ["FREEAGENT","WAIVERS"]}, limit: 60,
                sortPercOwned: {sortPriority: 1, sortAsc: false}}};
const fa = await get("?view=kona_player_info", {"x-fantasy-filter": JSON.stringify(filter)});
// fa.players[].player.fullName
```

That is the 60 most-rostered available players. Say which list you used. If the user has a specific player in mind, add him by name.

If any ESPN call fails, fall back to the league's ordinary pages through the same ladder (text of settings, roster and matchup pages), then pasted text.

## Other hosts (Sleeper, CBS, Fantrax, and so on)

No recipe is bundled. Use the same ladder: a connected tool, then the pages in the browser (settings, team roster, matchup, available players), then paste. Read what the page shows and map it to the engine's names; never guess.

## After reading

1. Show the user what you read in compact form: settings (a one-line card summary), their roster, the opponent and roster if relevant, the banked score if relevant, the candidate list if relevant. Ask **one** confirmation. Misread names and a wrong spot count are the most likely source of a wrong answer.
2. If an item could not be read by any route, name it and ask for exactly that item.
3. Do not save the roster. Only the league card is saved (see `setup`).

## Roto leagues (standings and every roster)

A roto question needs the **standings** (every team's season totals) and **every team's roster**, not a weekly matchup.

- **Yahoo:** standings at `/nba/<league-id>` (league home) or the "Standings" tab: read every team's total for each scored category. Yahoo shows season totals for counting categories and only FG% and FT% for shooting: pass the percentages (the result is labelled `SHOOTING ESTIMATED`). Each team's roster is its team page, `/nba/<league-id>/<team-id>`; read all of them (one page per team, in parallel).
- **ESPN:** the `mTeam`, `mRoster` and `mStandings` views of the league endpoint return every team's roster and each team's season totals per category, including made and attempted counts for FG and FT (use them: the result is then exact). Read from a tab on fantasy.espn.com as above.
- Put each team's totals under the host's category names, add `FGM`/`FGA`/`FTM`/`FTA` when available, and mark the user's own team `me: true`. Tell the user which teams or rosters you could not read; the script needs all of them.
