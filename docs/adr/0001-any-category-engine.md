# 0001. The engine supports any category list, then points leagues

Date: 2026-11-24. Status: accepted (design settled with the owner; build tracked in issue #14).

## Context
The engine handled only standard 9-category head-to-head. A real Yahoo account had a league scoring 11 categories (MIN, PF added) and one scoring FGM, OREB and A/T. Setup correctly refused both.

## Decision
1. Build order: head-to-head with any category list, then points leagues. Roto only on request.
2. Supported categories are those computable from a box score: MIN, FGM, FGA, FG%, FTM, FTA, FT%, 3PM, 3PA, 3P%, PTS, REB, OREB, DREB, AST, STL, BLK, TO, PF, A/T, plus double-doubles (any two of PTS, REB, AST, STL, BLK at 10 or more) and triple-doubles (three), taken from each player's rate of such games. Any other category: setup stops and names it.
3. Luck is measured from real weekly results for each base stat; combined categories are computed from their parts. The new model must reproduce the measured luck of the existing nine within a tight tolerance, otherwise the nine keep their numbers and only new categories use it. A category with no measured luck is not supported.
4. The league's own category list drives the baseline, player values and the simulated drafts.
5. Ties: output reports win, tie and loss chances separately; the tie rule is on the league card (setup asks, because hosts do not show it).
6. Points leagues derive weekly luck from the per-stat luck and correlations.
7. The nightly snapshot adds MIN, OREB, DREB, PF, 3PA, `dd_rate` and `td_rate` (optional fields, estimated with the same recency and games blend).

## Consequences
Existing 9-category results must not change (regression test). Every new category needs its luck measured before it is offered.
