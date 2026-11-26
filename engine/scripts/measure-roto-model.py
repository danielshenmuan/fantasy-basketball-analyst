"""
Roto model constants, issue #14 phase 2. MEASURES the three pieces the roto projection needs, on 2025-26 (nothing here tunes a result):
  1. games: share of the team's remaining games a player plays, as a function of his share so far (shrunk toward the league rate).
  2. games-lost spread: sd of (games played - expected games) as a function of team games left.
  3. per-game luck: sd of (real rest-of-season base total - sum of per-game average x games really played), per base stat,
     as a function of games left, with the correlation between stats.
Also compares projection averages: season-to-date only vs blended with prior seasons by games played (K).
Run: python3 measure-roto-model.py games.csv snapshot.json [out.json]
"""
import csv, sys, json, datetime as dt, collections
import numpy as np
rows = list(csv.DictReader(open(sys.argv[1]))); snap = json.load(open(sys.argv[2]))
OUT = sys.argv[3] if len(sys.argv) > 3 else None
B = ["minutes","fgm","fga","ftm","fta","fg3m","fg3a","oreb","dreb","ast","stl","blk","turnovers","pf"]
EXTRA = ["pts","reb"]
S = B + EXTRA
start = dt.date(2025,10,20)
day = lambda r: (dt.date.fromisoformat(r["game_date"]) - start).days
pid = {p:i for i,p in enumerate(sorted({int(r["player_id"]) for r in rows}))}
N = len(pid); D = max(day(r) for r in rows)+1
G = np.zeros((N,D,len(S))); PL = np.zeros((N,D)); TG = np.zeros((N,D))
teamdays = collections.defaultdict(set); ptd = collections.defaultdict(set)
for r in rows:
    i = pid[int(r["player_id"])]; d = day(r)
    G[i,d] = [float(r[s]) for s in S]; PL[i,d] = 1
    teamdays[r["team_abbr"]].add(d); ptd[(int(r["player_id"]), r["team_abbr"])].add(day(r))
last = {}
for (p,t),ds in ptd.items():
    lo,hi = min(ds),max(ds)
    for d in teamdays[t]:
        if lo <= d <= hi: TG[pid[p],d] = 1
    if p not in last or hi > last[p][1]: last[p] = (t,hi)
for p,(t,m) in last.items():
    for d in teamdays[t]:
        if d > m: TG[pid[p],d] = 1
# prior seasons from the snapshot (as known before 2025-26): 2024-25 weight 1.0, 2023-24 weight 0.6, x min(gp,65)
prior = np.full((N,len(B)), np.nan)
FIELD = {"minutes":None,"fgm":"fgm","fga":"fga","ftm":"ftm","fta":"fta","fg3m":"fg3m","fg3a":"fg3a","oreb":"oreb","dreb":"dreb","ast":"ast","stl":"stl","blk":"blk","turnovers":"turnovers","pf":"pf"}
for p in snap["players"]:
    if p["id"] not in pid: continue
    acc = np.zeros(len(B)); w = 0
    for season, r in (("2024-25",1.0),("2023-24",0.6),("2022-23",0.3)):
        for x in p["seasons"]:
            if x["season"] == season and x["gp"] > 0:
                ww = r*min(x["gp"],65); w += ww
                acc += ww*np.array([x["mpg"] if FIELD[b] is None else x["averages"][FIELD[b]] for b in B])
    if w > 0: prior[pid[p["id"]]] = acc/w
ix = {s:k for k,s in enumerate(S)}
rng = np.random.default_rng(14)
CUTS = [4,8,12,16,20,24]
def pool_at(cut, avg, ok):
    z = 0
    for c in ["pts","reb","ast","stl","blk","fg3m","turnovers"]:
        a = avg[:,ix[c]]; v = a[ok]; z = z + (a - v.mean())/v.std()*(-1 if c=="turnovers" else 1)
    return np.argsort(-np.where(ok,z,-1e9))[:182]
RATE_BY_CUT = {}; SD_POINTS = []
out = {"games":{}, "games_sd":{}, "luck":{}, "blend":{}}
allres = {K:[] for K in (0,10,20,40,80,1e9)}
errs = collections.defaultdict(list)   # per cut: (Gbar, rel err vectors) for played-mode luck
for wk in CUTS:
    cut = wk*7
    pre = G[:,:cut,:].sum(1); gp = PL[:,:cut].sum(1); tgpre = TG[:,:cut].sum(1); post = G[:,cut:,:].sum(1)
    P = PL[:,cut:].sum(1); Gl = TG[:,cut:].sum(1)
    ok = gp >= 8
    avg = np.divide(pre, gp[:,None], out=np.zeros_like(pre), where=gp[:,None]>0)
    pool = pool_at(cut, avg, ok)
    pool = pool[Gl[pool] > 0]
    s0 = gp[pool]/tgpre[pool]; y = P[pool]/Gl[pool]
    beta, alpha = np.polyfit(s0, y, 1)
    n0 = tgpre[pool].mean()
    k = n0*(1/beta - 1) if 0 < beta < 1 else float("nan"); r = alpha/(1-beta) if beta < 1 else float("nan")
    resid = P[pool] - Gl[pool]*(alpha+beta*s0)
    _k = 25; _r = (y.mean()*(tgpre[pool].mean()+_k) - gp[pool].mean())/_k
    RATE_BY_CUT[wk] = (float(Gl[pool].mean()/82), float(_r))
    SD_POINTS.append((float(Gl[pool].mean()), float(resid.std())))
    out["games"][wk] = dict(alpha=alpha, beta=beta, n0=n0, k=k, r=r, mean_share=float(y.mean()), G=float(Gl[pool].mean()))
    out["games_sd"][wk] = dict(G=float(Gl[pool].mean()), sd=float(resid.std()), sd_over_G=float(resid.std()/Gl[pool].mean()))
    print(f"wk{wk}: games left/player {Gl[pool].mean():.1f} share-so-far->rest slope {beta:.2f} intercept {alpha:.2f} (k={k:.1f}, league rate r={r:.2f}) mean rest share {y.mean():.2f}; games sd {resid.std():.1f} = {resid.std()/Gl[pool].mean():.2f} of games left")
    # per-game luck on base stats, played games, to-date average
    for t in range(1500):
        for tm in rng.permutation(pool)[:156].reshape(12,13):
            a = post[tm][:,:len(B)].sum(0); p = (avg[tm][:,:len(B)]*P[tm][:,None]).sum(0)
            errs[wk].append((a-p)/np.maximum(p,1e-9))
    out["luck"][wk] = dict(Gbar=float(P[pool].mean()), sd=np.array(errs[wk]).std(0).tolist())
    # which average to project with: to-date vs prior blend (K), games from the fitted rule, error of CATEGORY totals vs real
    for K in allres:
        w = (gp/np.maximum(gp+K,1e-9)) if K < 1e8 else np.zeros(N)
        pr = np.where(np.isnan(prior), avg[:,:len(B)], prior)
        wcur = np.where(np.isnan(prior).any(1), 1.0, w)
        bl = wcur[:,None]*avg[:,:len(B)] + (1-wcur[:,None])*pr
        E = Gl*(alpha+beta*np.divide(gp,tgpre,out=np.ones(N),where=tgpre>0)).clip(0,1)
        sdp = []
        for t in range(300):
            for tm in rng.permutation(pool)[:156].reshape(12,13):
                a = post[tm][:,[ix["pts"],ix["reb"],ix["ast"],ix["stl"],ix["blk"],ix["fg3m"],ix["turnovers"]]].sum(0)
                p = np.array([(bl[tm][:,[B.index("fgm")]]*2 + bl[tm][:,[B.index("fg3m")]] + bl[tm][:,[B.index("ftm")]]).T@E[tm],
                              ((bl[tm][:,[B.index("oreb")]]+bl[tm][:,[B.index("dreb")]]).T@E[tm]),
                              bl[tm][:,[B.index("ast")]].T@E[tm], bl[tm][:,[B.index("stl")]].T@E[tm], bl[tm][:,[B.index("blk")]].T@E[tm],
                              bl[tm][:,[B.index("fg3m")]].T@E[tm], bl[tm][:,[B.index("turnovers")]].T@E[tm]]).ravel()
                sdp.append((a-p)/p)
        sdp = np.array(sdp)
        allres[K].append((wk, sdp.std(0).mean(), sdp.mean(0).mean()))
print("\nprojection average: mean over 7 counting cats of sd (bias) of rest-of-season error, schedule games with fitted availability")
for K,v in allres.items(): print("K=",K, " ".join(f"wk{w}: {s*100:.1f}% ({b*100:+.1f})" for w,s,b in v))
out["blend"] = {str(K):[dict(wk=w,sd=s,bias=b) for w,s,b in v] for K,v in allres.items()}
_A = np.array([[g, g*g] for g,_ in SD_POINTS]); _y = np.array([sd*sd for _,sd in SD_POINTS])
_c,_,_,_ = np.linalg.lstsq(_A, _y, rcond=None); SD_FIT = (max(float(_c[0]),0), max(float(_c[1]),0)); print("games sd fit: a=%.3f b=%.4f" % SD_FIT, "rates", RATE_BY_CUT)
# fit var = a^2/G + b^2 per base stat across cuts (G = mean games per player really played)
Gs = np.array([out["luck"][w]["Gbar"] for w in CUTS]); sds = np.array([out["luck"][w]["sd"] for w in CUTS])  # cuts x stats
fit = {}
for j,b in enumerate(B):
    A = np.c_[1/Gs, np.ones(len(Gs))]
    coef,_,_,_ = np.linalg.lstsq(A, sds[:,j]**2, rcond=None)
    a2,b2 = max(coef[0],0), max(coef[1],0)
    fit[b] = dict(a=float(np.sqrt(a2)), b=float(np.sqrt(b2)))
out["luck_fit"] = fit
allerr = np.array([e for wk in CUTS for e in errs[wk] ])
# correlation of luck pooled over cuts, standardised per cut
Z = np.vstack([ (np.array(errs[wk]) - np.array(errs[wk]).mean(0))/np.array(errs[wk]).std(0) for wk in CUTS ])
out["corr"] = np.corrcoef(Z.T).tolist()
for b in B: print(f"{b:10s} a={fit[b]['a']:.3f} b={fit[b]['b']:.3f}  sd by cut:", [round(out['luck'][w]['sd'][B.index(b)],3) for w in CUTS])
if OUT: json.dump(out, open(OUT,"w"), indent=1)

# ---- write src/rotoluck.ts when asked:  python3 measure-roto-model.py games.csv snapshot.json out.json --ts ../src/rotoluck.ts
if "--ts" in sys.argv:
    corr = np.array(out["corr"])
    np.linalg.cholesky(corr)  # raises when not positive definite
    K_GAMES = 25
    RATE_TABLE = [(RATE_BY_CUT[wk][0], RATE_BY_CUT[wk][1]) for wk in CUTS][::-1]
    SDA, SDB = SD_FIT
    lines = []
    lines.append("/**")
    lines.append(" * Roto rest-of-season constants (issue #14). GENERATED by engine/scripts/measure-roto-model.py from 2025-26 game logs")
    lines.append(" * (simulated 12-team leagues of 13 players from the 182 best, cut dates after weeks 4, 8, 12, 16, 20, 24).")
    lines.append(" * Games: a player's expected share of his team's remaining games is (games played + K x league rate) / (team games so far + K);")
    lines.append(" * the league rate falls through the season (more rest and injuries late). Per-game luck: sd of the rest-of-season base total")
    lines.append(" * over the games actually played is sqrt(a^2 / games per player + b^2), a fraction of the projected total.")
    lines.append(" */")
    lines.append("export const ROTO_GAMES_K = %d;" % K_GAMES)
    lines.append("/** [share of the season left, league rate of games played in the rest of it], measured per cut date. */")
    lines.append("export const ROTO_LEAGUE_RATE: readonly (readonly [number, number])[] = [" + ", ".join("[%.2f, %.2f]" % (a,b) for a,b in RATE_TABLE) + "];")
    lines.append("/** Spread of games played around the expectation: sd = sqrt(A x G + B x G^2), G = team games left. */")
    lines.append("export const ROTO_GAMES_SD = { a: %.3f, b: %.4f } as const;" % (SDA, SDB))
    lines.append("export const ROTO_LUCK_AB: Record<string, { a: number; b: number }> = {")
    for b in B: lines.append("  %s: { a: %.3f, b: %.3f }," % (b, fit[b]["a"], fit[b]["b"]))
    lines.append("};")
    lines.append("/** Correlation of the per-game luck across base stats, same order as LUCK_STATS. */")
    lines.append("export const ROTO_LUCK_CORRELATION: readonly (readonly number[])[] = [")
    for row in corr: lines.append("  [" + ", ".join("%.3f" % x for x in row) + "],")
    lines.append("];")
    open(sys.argv[sys.argv.index("--ts")+1], "w").write("\n".join(lines) + "\n")
