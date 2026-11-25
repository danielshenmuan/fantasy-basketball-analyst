"""Weekly luck of a fantasy-points score, measured directly: sd(actual week points - expected from season averages) / mean week points.
Same setup as measure-luck.py (13-player rosters from the top 182 players, weekly sums over the player's own games in the week).
Usage: python3 measure-points-luck.py g3.csv   (the weekly game rows exported from BigQuery)"""
import csv, random, statistics as st, datetime as dt, collections, sys
rows = list(csv.DictReader(open(sys.argv[1])))
def wk(d):
    x = dt.date.fromisoformat(d); return (x - dt.timedelta(days=x.weekday())).isoformat()
# Scoring systems (weights on registry stats; missed shots already split into attempts and makes).
SYSTEMS = {
    "espn_league_994542812": {"pts": 1, "dreb": 1, "fga": -0.5, "fgm": 1, "turnovers": -1, "blk": 2, "dd": 10, "stl": 2, "td": 10, "oreb": 1.5, "fg3m": 3, "ast": 1, "fg3a": -1},
    "espn_default": {"pts": 1, "reb": 1, "ast": 2, "stl": 4, "blk": 4, "turnovers": -2, "fgm": 2, "fga": -1, "ftm": 1, "fta": -1, "fg3m": 1},
    "simple": {"pts": 1, "reb": 1.2, "ast": 1.5, "stl": 3, "blk": 3, "turnovers": -1},
    "dd_heavy": {"pts": 1, "reb": 1, "ast": 1, "stl": 2, "blk": 2, "turnovers": -1, "dd": 5, "td": 10},
}
COLS = ["fgm", "fga", "ftm", "fta", "fg3m", "fg3a", "oreb", "dreb", "ast", "stl", "blk", "turnovers", "pf", "pts", "reb", "dd", "td"]
P = collections.defaultdict(list)
for r in rows: P[int(r["player_id"])].append(r)
def score(g, w): return sum(w[k] * float(g[k]) for k in w)
avg = {p: {c: sum(float(g[c]) for g in gs) / len(gs) for c in COLS} for p, gs in P.items() if len(gs) >= 50}
cats = ["pts", "reb", "ast", "stl", "blk", "fg3m", "turnovers"]
mu = {c: st.mean(a[c] for a in avg.values()) for c in cats}; sd = {c: st.pstdev(a[c] for a in avg.values()) for c in cats}
val = {p: sum(((a[c] - mu[c]) / sd[c]) * (-1 if c == "turnovers" else 1) for c in cats) for p, a in avg.items()}
pool = sorted(val, key=val.get, reverse=True)[:182]
random.seed(7)
for name, w in SYSTEMS.items():
    PW = collections.defaultdict(dict)
    for p in pool:
        for g in P[p]:
            e = PW[p].setdefault(wk(g["game_date"]), [0, 0.0]); e[0] += 1; e[1] += score(g, w)
    per = {p: sum(score(g, w) for g in P[p]) / len(P[p]) for p in pool}
    weeks = sorted({x for p in pool for x in PW[p]}); weeks = [x for x in weeks if sum(1 for p in pool if x in PW[p]) > 100]
    res, tot = [], []
    for _ in range(1500):
        R = random.sample(pool, 13)
        for x in weeks:
            ps = [p for p in R if x in PW[p]]
            act = sum(PW[p][x][1] for p in ps); exp = sum(per[p] * PW[p][x][0] for p in ps)
            res.append(act - exp); tot.append(act)
    print(f"{name:24s} luck share {st.pstdev(res) / st.mean(tot) * 100:5.1f}%   mean week {st.mean(tot):7.1f}   sd {st.pstdev(res):6.1f}")
