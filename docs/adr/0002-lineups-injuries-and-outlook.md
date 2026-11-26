# 0002. Lineup slots, add limit and IL, scenarios, daily lineups, and the season outlook

Date: 2026-11-25. Status: accepted (design settled with the owner in a grilling round; issues #2, #3, #5, #6, #10).

## Decision
1. Build order: day-by-day schedule in the snapshot (optional `schedule.days`, weeks derived from it), then slots and positions (#2), add limit and IL (#3), injury scenarios (#6), daily lineups and streaming (#5), season and playoff outlook (#10).
2. Positions come from the league host (roster and free-agent lists), passed per player; the snapshot has no positions. The league card holds `slots`; `lineup_slots` stays as the fallback. The user's own lineup is used when given; the best fit is a recommendation. Simulated typical opponents stay position-free, so existing numbers do not change. A move that leaves a required slot empty is listed as `breaks-slot` and never recommended; with positions missing the engine warns and turns the check off.
3. Adds left and IL: the league's own IL-eligible statuses are read at setup and saved on the card; the user tells the analyst when they change. An add needs no drop while a roster spot is open. `best_use_of_adds` is found by re-simulating combined rosters.
4. Injuries: statuses are read live from the league page each run, never stored. OUT with a date uses it; OUT with no date is out for the rest of the week, back next week, flagged; GTD/DTD counts as playing, flagged. The user's statement overrides the page. After a return, 80% output for 3 games, labelled an assumption (measure it later if game logs are added).
5. Daily lineups: modelled day by day for daily-lock leagues; refused for weekly lock. Mid-week luck reuses the 1/sqrt(share) scaling, labelled rough under a third of the week left.
6. Outlook: the roster is held as it stands; other teams are coin flips; playoff opponents typical; tiebreakers applied only as far as today's values are known. Limits are stated in the output.

## Consequences
Existing nine-category and any-category results are unchanged (regression tests). The nightly data file should add `schedule.days`; until then the day schedule is passed as `schedule_days` (`skills/matchup/scripts/season-days.mjs`), and without it injury windows are approximate and daily lineups are refused.
