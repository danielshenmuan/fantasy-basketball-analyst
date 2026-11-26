"""
Season-long (rest-of-season) luck for roto leagues, issue #14 phase 1. MEASURES only; nothing in the engine uses it yet.

For simulated leagues (12 teams x 13 distinct players drawn from the 182 best players by value on games before the
cut date), project each team's rest-of-season totals as  per-game average to date x games left, and compare with the
real rest-of-season totals. Cut dates: end of week 4, 8, 12, 16, 20, 24 of 2025-26 (weeks start Monday 2025-10-20).
Two ways to count games left:
  team   : the player's NBA team's real number of games after the cut (what the schedule says in advance; injuries, rest
           and trades are inside the error)
  played : games the player really played after the cut (isolates per-game luck; uses hindsight)
Export: bq query ... 'SELECT player_id, game_id, game_date, team_abbr, minutes, fgm,fga,ftm,fta,fg3m,fg3a,oreb,dreb,ast,stl,blk,turnovers,pf,pts,reb
        FROM `fantasy-survivor-app.nba_data.v_player_daily_game_stats` WHERE season="2025-26"' > games.csv
Run: python3 measure-season-luck.py games.csv [out.json]
"""
import csv, sys, json, datetime as dt, collections
import numpy as np
rows = list(csv.DictReader(open(sys.argv[1])))
OUT = sys.argv[2] if len(sys.argv) > 2 else None
S = ["fgm","fga","ftm","fta","fg3m","oreb","dreb","ast","stl","blk","turnovers","pts","reb"]
CATS = ["PTS","REB","AST","STL","BLK","3PM","TO","FG%","FT%"]
start = dt.date(2025,10,20)
def day(r): return (dt.date.fromisoformat(r["game_date"]) - start).days
pid = {p:i for i,p in enumerate(sorted({int(r["player_id"]) for r in rows}))}
N = len(pid); D = max(day(r) for r in rows)+1
G = np.zeros((N, D, len(S)))      # per player per day stats
PL = np.zeros((N, D))             # played flag
team_of = {}
teamdays = collections.defaultdict(set)
for r in rows:
    i = pid[int(r["player_id"])]; d = day(r)
    G[i,d] = [float(r[s]) for s in S]; PL[i,d] = 1
    team_of[(i)] = r["team_abbr"]; teamdays[r["team_abbr"]].add(d)
# each player's team games by day (use the team of the game: player may have been traded; use row team)
TG = np.zeros((N, D))
ptd = collections.defaultdict(set)
for r in rows: ptd[(int(r["player_id"]), r["team_abbr"])].add(day(r))
for (p,t) in ptd:
    for d in teamdays[t]: TG[pid[p], d] = 1   # days the player's team(s) played (traded players counted for both teams' calendars: overcount guarded below)
# guard: for traded players only count the calendar of the team he was on at the time -> approximate by games on team calendar between first and last day with that team
TG[:] = 0
for (p,t) in ptd:
    ds = sorted(ptd[(p,t)]); lo, hi = ds[0], ds[-1]
    for d in teamdays[t]:
        if lo <= d <= hi: TG[pid[p], d] = 1
# after a player's last appearance with team on the roster: extend to season end for the player's last team
last_team = {}
for (p,t) in ptd: 
    m = max(ptd[(p,t)]); 
    if p not in last_team or m > last_team[p][1]: last_team[p] = (t, m)
for p,(t,m) in last_team.items():
    for d in teamdays[t]:
        if d > m: TG[pid[p], d] = 1
ix = {s:k for k,s in enumerate(S)}
def totals(lo, hi, w=None):   # per player sums over days [lo,hi)
    return G[:, lo:hi, :].sum(1)
rng = np.random.default_rng(14)
CUTS = [4,8,12,16,20,24]
res = {}
for mode in ("team","share","played"):
  for wk in CUTS:
    cut = wk*7
    pre = totals(0, cut); gp = PL[:, :cut].sum(1)
    ok = gp >= 8
    avg = np.divide(pre, gp[:,None], out=np.zeros_like(pre), where=gp[:,None] > 0)
    sd7 = {}
    cs = ["pts","reb","ast","stl","blk","fg3m","turnovers"]
    z = 0
    for c in cs:
        v = avg[ok, ix[c]]; z = z + (avg[:, ix[c]] - v.mean())/v.std() * (-1 if c=="turnovers" else 1)
    z = np.where(ok, z, -1e9)
    pool = np.argsort(-z)[:182]
    post = totals(cut, D)
    tgpre = TG[:, :cut].sum(1)
    share = np.divide(gp, tgpre, out=np.ones_like(gp), where=tgpre > 0).clip(0,1)
    gl = TG[:, cut:].sum(1) if mode == "team" else (TG[:, cut:].sum(1)*share if mode == "share" else PL[:, cut:].sum(1))
    proj = avg * gl[:,None]
    rel = []; pct = []; fin = []; teamproj=[]; 
    for t in range(1500):
        pick = rng.permutation(pool)[:156].reshape(12,13)
        for tm in pick:
            a = post[tm].sum(0); p = proj[tm].sum(0); b = pre[tm].sum(0)
            def cat(v):  # 9 categories from base sums
                return np.array([v[ix["pts"]], v[ix["reb"]], v[ix["ast"]], v[ix["stl"]], v[ix["blk"]], v[ix["fg3m"]], v[ix["turnovers"]],
                                 v[ix["fgm"]]/v[ix["fga"]] if v[ix["fga"]] else np.nan, v[ix["ftm"]]/v[ix["fta"]] if v[ix["fta"]] else np.nan])
            ca, cp, cb = cat(a), cat(p), cat(b)
            fa, fp = cat(a+b), cat(p+b)
            rel.append((ca - cp)[:7] / cp[:7])         # error as a fraction of the projected rest-of-season total
            fin.append((fa - fp)[:7] / fp[:7])         # as a fraction of the projected FINAL total
            pct.append(np.r_[(ca-cp)[7:], (fa-fp)[7:], cp[7:]-ca[7:]*0])  # rest ratio error, final ratio error
            teamproj.append(cp[:7])
    rel = np.array(rel); fin = np.array(fin); pct = np.array(pct)
    res[(mode,wk)] = dict(
        n_teams=len(rel), games_left_mean=float(gl[pool].mean()),
        rest_sd=rel.std(0).tolist(), rest_bias=rel.mean(0).tolist(),
        final_sd=fin.std(0).tolist(),
        pct_rest_sd=pct[:,0:2].std(0).tolist(), pct_final_sd=pct[:,2:4].std(0).tolist(),
        corr=np.corrcoef(np.c_[rel, pct[:,0:2]].T).tolist())
for k,v in res.items(): print(k, "games left/player %.1f"%v["games_left_mean"], " rest sd%:", [round(100*x,1) for x in v["rest_sd"]], "pct sd (pts):", [round(100*x,2) for x in v["pct_rest_sd"]])
if OUT: json.dump({f"{m}-{w}":v for (m,w),v in res.items()}, open(OUT,"w"))

# ---- weekly luck on the same footing (played games, same 182-player pool logic, 13-player teams), for comparison
def weekly(modew):
    out = []
    for wk in range(5, 25):
        cut = wk*7
        pre = totals(0, cut); gp = PL[:, :cut].sum(1); ok = gp >= 8
        avg = np.divide(pre, gp[:,None], out=np.zeros_like(pre), where=gp[:,None] > 0)
        z = 0
        for c in ["pts","reb","ast","stl","blk","fg3m","turnovers"]:
            v = avg[ok, ix[c]]; z = z + (avg[:, ix[c]] - v.mean())/v.std() * (-1 if c=="turnovers" else 1)
        pool = np.argsort(-np.where(ok, z, -1e9))[:182]
        w = totals(cut, cut+7); g = (PL[:, cut:cut+7].sum(1) if modew=="played" else TG[:, cut:cut+7].sum(1))
        pr = avg*g[:,None]
        for t in range(40):
            for tm in rng.permutation(pool)[:156].reshape(12,13):
                a, p = w[tm].sum(0), pr[tm].sum(0)
                ci = [ix[c] for c in ["pts","reb","ast","stl","blk","fg3m","turnovers"]]
                out.append(np.r_[(a[ci]-p[ci])/np.maximum(p[ci],1e-9), a[ix["fgm"]]/a[ix["fga"]]-p[ix["fgm"]]/p[ix["fga"]], a[ix["ftm"]]/a[ix["fta"]]-p[ix["ftm"]]/p[ix["fta"]]])
    return np.array(out)
for m in ("played","team"):
    W = weekly(m); print("weekly", m, "sd%:", [round(100*x,1) for x in W.std(0)], "bias%:", [round(100*x,1) for x in W.mean(0)])
for k,v in res.items(): print(k, "bias% rest:", [round(100*x,1) for x in v["rest_bias"]], "final sd%:", [round(100*x,1) for x in v["final_sd"]], "pct final sd:", [round(100*x,2) for x in v["pct_final_sd"]])
for k in [("team",8),("played",8)]:
    c = np.array(res[k]["corr"]); print(k, "corr (PTS REB AST STL BLK 3PM TO FG FT)"); print(np.round(c,2))
