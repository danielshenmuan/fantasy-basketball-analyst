import csv, random, statistics as st, datetime as dt, collections, math, json
B=["minutes","fgm","fga","ftm","fta","fg3m","fg3a","oreb","dreb","ast","stl","blk","turnovers","pf","dd","td"]
rows=list(csv.DictReader(open("g3.csv")))
def wk(d):
    x=dt.date.fromisoformat(d); return (x-dt.timedelta(days=x.weekday())).isoformat()
P=collections.defaultdict(list)
for r in rows: P[int(r["player_id"])].append(r)
avg={p:{c:sum(float(g[c]) for g in gs)/len(gs) for c in B+["pts","reb"]} for p,gs in P.items() if len(gs)>=50}
cats7=["pts","reb","ast","stl","blk","fg3m","turnovers"]
mu={c:st.mean(a[c] for a in avg.values()) for c in cats7}; sd={c:st.pstdev(a[c] for a in avg.values()) for c in cats7}
val={p:sum(((a[c]-mu[c])/sd[c])*(-1 if c=="turnovers" else 1) for c in cats7) for p,a in avg.items()}
pool=sorted(val,key=val.get,reverse=True)[:182]
PW=collections.defaultdict(dict)
for p in pool:
    for g in P[p]:
        e=PW[p].setdefault(wk(g["game_date"]),[0]+[0.0]*(len(B)+2))
        e[0]+=1
        for i,c in enumerate(B+["pts","reb"]): e[i+1]+=float(g[c])
weeks=sorted({w for p in pool for w in PW[p]}); weeks=[w for w in weeks if sum(1 for p in pool if w in PW[p])>100]
K=len(B)+2; names=B+["pts","reb"]
random.seed(7)
res=[[] for _ in range(K)]; tot=[[] for _ in range(K)]
fgR=[];ftR=[]
for _ in range(1500):
    R=random.sample(pool,13)
    for w in weeks:
        ps=[p for p in R if w in PW[p]]
        act=[sum(PW[p][w][i+1] for p in ps) for i in range(K)]
        exp=[sum(avg[p][names[i]]*PW[p][w][0] for p in ps) for i in range(K)]
        for i in range(K): res[i].append(act[i]-exp[i]); tot[i].append(act[i])
        fgR.append((act[1]/act[2] if act[2] else 0)-(exp[1]/exp[2] if exp[2] else 0))
        ftR.append((act[3]/act[4] if act[4] else 0)-(exp[3]/exp[4] if exp[4] else 0))
share={names[i]:st.pstdev(res[i])/st.mean(tot[i]) for i in range(K)}
def corr(a,b):
    ma,mb=st.mean(a),st.mean(b); return sum((x-ma)*(y-mb) for x,y in zip(a,b))/math.sqrt(sum((x-ma)**2 for x in a)*sum((y-mb)**2 for y in b))
C=[[round(corr(res[i],res[j]),3) for j in range(len(B))] for i in range(len(B))]
print("share (sd of weekly luck / mean weekly total), 13-player rosters, 25 weeks, 1500 rosters")
for n in names: print(f"  {n:10s} {share[n]*100:5.1f}%  mean week {st.mean(tot[names.index(n)]):7.1f}")
print("FG pct luck sd %.2f  FT pct luck sd %.2f"%(100*st.pstdev(fgR),100*st.pstdev(ftR)))
# derived check: PTS = 2*fgm + fg3m + ftm  (identity on residuals), REB = oreb+dreb
def lin(coefs): 
    n=len(res[0]); v=[sum(c*res[names.index(k)][t] for k,c in coefs.items()) for t in range(n)]; return st.pstdev(v)/st.mean([sum(c*tot[names.index(k)][t] for k,c in coefs.items()) for t in range(n)])
print("derived PTS share %.3f (direct %.3f)"%(lin({"fgm":2,"fg3m":1,"ftm":1}),share["pts"]))
print("derived REB share %.3f (direct %.3f)"%(lin({"oreb":1,"dreb":1}),share["reb"]))
json.dump({"base":B,"share":{b:round(share[b],4) for b in B},"corr":C,"fg_pct_sd":round(st.pstdev(fgR),4),"ft_pct_sd":round(st.pstdev(ftR),4),"direct_pts":round(share["pts"],4),"direct_reb":round(share["reb"],4)},open("luck_all.json","w"))
# is the correlation matrix positive definite?
n=len(B); L=[[0]*n for _ in range(n)]; ok=True
for i in range(n):
    for j in range(i+1):
        s=C[i][j]-sum(L[i][k]*L[j][k] for k in range(j))
        if i==j:
            if s<=0: ok=False; print("not PD at",B[i],s); break
            L[i][j]=math.sqrt(s)
        else: L[i][j]=s/L[j][j]
    if not ok: break
print("positive definite:",ok)
