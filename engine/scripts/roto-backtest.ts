/**
 * Roto back-test on 2025-26 (issue #14). MEASURES only. Nobody had a real roto league, so: simulated leagues of 12 teams x 13
 * players drawn from the 182 best players (by value on games before the cut), rosters held all season, standings as they
 * stood at the cut date, the engine's roto path (analyzeLeague with league.format "roto") run with only information from before
 * the cut, and its predictions compared with the real final totals, ranked by the roto rules.
 *
 * Data (needs the bq CLI):
 *   bq query --use_legacy_sql=false --format=csv --max_rows=200000 --project_id=fantasy-survivor-app \
 *     'SELECT player_id, game_id, game_date, team_abbr, minutes, fgm,fga,ftm,fta,fg3m,fg3a,oreb,dreb,ast,stl,blk,turnovers,pf,pts,reb
 *      FROM `fantasy-survivor-app.nba_data.v_player_daily_game_stats` WHERE season="2025-26"' > games.csv
 *   curl -s https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json > snapshot.json   (prior seasons 2023-24 and 2024-25)
 * Run: bun scripts/roto-backtest.ts games.csv snapshot.json [--leagues 60] [--sims 1500] [--cuts 4,8,12,16,20] [--out roto-backtest.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeLeague, type Snapshot, type SnapshotPlayer } from "../src";
import type { RotoOutput } from "../src/analyzeRoto";
import { rankPoints } from "../src/roto";
import { mulberry32 } from "../src/simulate";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1]! : d; };
const [gamesFile, snapFile] = args.filter((a) => !a.startsWith("--") && a.endsWith(".csv") || a.endsWith(".json")) as [string, string];
const LEAGUES = Number(flag("--leagues", "60")), SIMS = Number(flag("--sims", "1500")), OUT = flag("--out", "");
const CUTS = flag("--cuts", "4,8,12,16,20").split(",").map(Number);
const T = 12, R = 13;
const S0 = Date.parse("2025-10-20T00:00:00Z");
const iso = (d: number) => new Date(S0 + d * 86400000).toISOString().slice(0, 10);

// ---- data
const lines = readFileSync(gamesFile, "utf8").trim().split("\n");
const head = lines[0]!.split(",");
interface G { pid: number; day: number; team: string; s: Record<string, number> }
const games: G[] = lines.slice(1).map((l) => {
  const c = l.split(","), row: Record<string, string> = {};
  head.forEach((h, i) => (row[h] = c[i]!));
  const s: Record<string, number> = {};
  for (const k of ["minutes", "fgm", "fga", "ftm", "fta", "fg3m", "fg3a", "oreb", "dreb", "ast", "stl", "blk", "turnovers", "pf", "pts", "reb"]) s[k] = Number(row[k]);
  return { pid: Number(row.player_id), day: Math.round((Date.parse(row.game_date + "T00:00:00Z") - S0) / 86400000), team: row.team_abbr!, s };
});
const snap = JSON.parse(readFileSync(snapFile, "utf8")) as Snapshot;
const priorOf = new Map<number, SnapshotPlayer>(snap.players.map((p) => [p.id, p]));
const players = [...new Set(games.map((g) => g.pid))];
const byPlayer = new Map<number, G[]>();
for (const g of games) (byPlayer.get(g.pid) ?? byPlayer.set(g.pid, []).get(g.pid)!).push(g);
const days = new Map<number, Set<string>>();
for (const g of games) (days.get(g.day) ?? days.set(g.day, new Set()).get(g.day)!).add(g.team);
const lastDay = Math.max(...days.keys());
const nameOf = (id: number) => `P${id}`;

const sum = (gs: G[], k: string) => gs.reduce((s, g) => s + g.s[k]!, 0);
const avgs = (gs: G[]) => {
  const n = gs.length, a = (k: string) => sum(gs, k) / n;
  return { pts: a("pts"), reb: a("reb"), ast: a("ast"), stl: a("stl"), blk: a("blk"), fg3m: a("fg3m"), turnovers: a("turnovers"), fga: a("fga"), fta: a("fta"), fgm: a("fgm"), ftm: a("ftm"), fg_pct: sum(gs, "fgm") / Math.max(1, sum(gs, "fga")), ft_pct: sum(gs, "ftm") / Math.max(1, sum(gs, "fta")), oreb: a("oreb"), dreb: a("dreb"), pf: a("pf"), fg3a: a("fg3a"), dd_rate: 0, td_rate: 0 };
};
const rng = mulberry32(14);
const shuffle = <X>(xs: X[]): X[] => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };

const CATS = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"];
const NAMES = ["Points", "Rebounds", "Assists", "Steals", "Blocks", "3-pointers made", "Field goal percentage", "Free throw percentage", "Turnovers"];
const catValues = (gs: G[]): number[] => {
  const t = (k: string) => sum(gs, k);
  return [t("pts"), t("reb"), t("ast"), t("stl"), t("blk"), t("fg3m"), t("fgm") / t("fga"), t("ftm") / t("fta"), t("turnovers")];
};
const rotoOf = (vals: number[][]) => {   // vals[team][cat] -> points per team
  const pts = Array<number>(vals.length).fill(0), perCat: number[][] = [];
  CATS.forEach((c, ci) => { const r = rankPoints(vals.map((v) => v[ci]!), c === "TO"); perCat.push(r); r.forEach((x, t) => (pts[t]! += x)); });
  return { pts, perCat };
};
const placeOf = (pts: number[], t: number): number => { const above = pts.filter((x) => x > pts[t]! + 1e-9).length, equal = pts.filter((x) => Math.abs(x - pts[t]!) < 1e-9).length; return above + (equal + 1) / 2; };

interface Row { cut: number; mode: string; pFirst: number; wonFirst: number; pTop3: number; inTop3: number; expPts: number; actPts: number; curPts: number; expPlace: number; actPlace: number; cdfAtActual: number; midCdf: number; pInTopHalf: number; inTopHalf: number }
const rows: Row[] = [];
const catBias: Record<string, { err: number; n: number }> = {};
let runs = 0;
for (const wk of CUTS) {
  const cut = wk * 7;
  // pool: best 182 by value to date
  const stat = players.map((id) => { const gs = byPlayer.get(id)!.filter((g) => g.day < cut); return { id, gs }; }).filter((x) => x.gs.length >= 8);
  const cats7 = ["pts", "reb", "ast", "stl", "blk", "fg3m", "turnovers"] as const;
  const a = stat.map((x) => avgs(x.gs));
  const mu = cats7.map((c) => a.reduce((s, x) => s + x[c], 0) / a.length), sd = cats7.map((c, i) => Math.sqrt(a.reduce((s, x) => s + (x[c] - mu[i]!) ** 2, 0) / a.length));
  const val = a.map((x) => cats7.reduce((s, c, i) => s + ((x[c] - mu[i]!) / sd[i]!) * (c === "turnovers" ? -1 : 1), 0));
  const pool = stat.map((x, i) => ({ ...x, v: val[i]! })).sort((p, q) => q.v - p.v).slice(0, T * R + 26);
  // the snapshot as it stood at the cut: prior seasons from the real file, this season so far from the games before the cut
  const schedDays: Record<string, string[]> = {};
  for (const [d, ts] of days) if (d >= cut) schedDays[iso(d)] = [...ts];
  const cutSnap: Snapshot = {
    version: 1, generated_at: iso(cut) + "T00:00:00Z", reference_season: "2024-25", schedule: { source: "back-test", days: schedDays },
    players: pool.map((p) => {
      const pr = priorOf.get(p.id);
      const team = p.gs[p.gs.length - 1]!.team;
      return { id: p.id, name: nameOf(p.id), team, seasons: [...(pr?.seasons.filter((s) => s.season !== "2025-26" && s.season !== "2026-27") ?? []), { season: "2025-26", gp: p.gs.length, mpg: sum(p.gs, "minutes") / p.gs.length, averages: avgs(p.gs) }] } as SnapshotPlayer;
    }),
  };
  for (let l = 0; l < LEAGUES; l++) {
    const top = pool.slice(0, T * R + 26);
    const drawn = shuffle(top).slice(0, T * R);
    const rosters = Array.from({ length: T }, (_, t) => drawn.slice(t * R, (t + 1) * R));
    const before = rosters.map((r) => r.flatMap((p) => p.gs));
    const full = rosters.map((r) => r.flatMap((p) => byPlayer.get(p.id)!));
    const finalVals = full.map(catValues), curVals = before.map(catValues);
    const actual = rotoOf(finalVals), cur = rotoOf(curVals);
    for (const mode of ["exact", "estimated"]) {
      const totals = (gs: G[]) => mode === "exact"
        ? { Points: sum(gs, "pts"), Rebounds: sum(gs, "reb"), Assists: sum(gs, "ast"), Steals: sum(gs, "stl"), Blocks: sum(gs, "blk"), "3-pointers made": sum(gs, "fg3m"), Turnovers: sum(gs, "turnovers"), FGM: sum(gs, "fgm"), FGA: sum(gs, "fga"), FTM: sum(gs, "ftm"), FTA: sum(gs, "fta") }
        : { Points: sum(gs, "pts"), Rebounds: sum(gs, "reb"), Assists: sum(gs, "ast"), Steals: sum(gs, "stl"), Blocks: sum(gs, "blk"), "3-pointers made": sum(gs, "fg3m"), Turnovers: sum(gs, "turnovers"), "FG%": sum(gs, "fgm") / sum(gs, "fga"), "FT%": sum(gs, "ftm") / sum(gs, "fta") };
      const input = {
        league: { teams: T, roster_spots: R, format: "roto" as const, categories: NAMES, standings: rosters.map((r, t) => ({ team: `T${t}`, totals: totals(before[t]!), ...(t === 0 ? { me: true } : { roster: r.map((p) => ({ name: nameOf(p.id) })) }) })) },
        roster: rosters[0]!.map((p) => ({ name: nameOf(p.id) })), roto: { sims: SIMS }, seed: 1 + l, as_of: iso(cut),
      };
      const out = analyzeLeague(input, cutSnap) as RotoOutput;
      runs++;
      const byTeam = new Map(out.team_check.table.map((r) => [r.team, r]));
      for (let t = 0; t < T; t++) {
        const r = byTeam.get(`T${t}`)!;
        const place = placeOf(actual.pts, t);
        const probs = r.finish_pct.map((x) => x / 100);
        const cdf = probs.slice(0, Math.ceil(place) - 1).reduce((s, x) => s + x, 0), mid = cdf + (probs[Math.ceil(place) - 1] ?? 0) / 2;
        rows.push({
          cut: wk, mode, pFirst: r.first_pct / 100, wonFirst: place === 1 ? 1 : place < 1.5 ? 0.5 : 0, pTop3: r.top_pct / 100, inTop3: place <= 3 ? 1 : 0,
          expPts: r.expected_points, actPts: actual.pts[t]!, curPts: cur.pts[t]!, expPlace: r.expected_place, actPlace: place, cdfAtActual: cdf, midCdf: mid,
          pInTopHalf: probs.slice(0, T / 2).reduce((s, x) => s + x, 0), inTopHalf: place <= T / 2 ? 1 : 0,
        });
      }
      if (mode === "exact") {
        // projected vs real final totals for team 0 (only "me" has categories)
        out.team_check.categories.forEach((c, ci) => {
          const b = (catBias[`${wk}|${c.category}`] ??= { err: 0, n: 0 });
          const actualV = finalVals[0]![ci]!;
          b.err += (c.projected_total - actualV) / actualV; b.n++;
        });
      }
    }
    if ((l + 1) % 10 === 0) console.error(`cut ${wk}: ${l + 1}/${LEAGUES}`);
  }
}
// ---- report
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const report: Record<string, unknown> = { leagues: LEAGUES, sims: SIMS, runs, byCut: {} as Record<string, unknown> };
const fmt = (x: number, d = 3) => x.toFixed(d);
for (const mode of ["exact", "estimated"]) {
  console.log(`\n=== ${mode} shooting input ===`);
  console.log("cut | teams | mean |pred-actual| pts (naive: current pts) | bias | Brier first (coin-flip 1/12) | Brier top3 | mean P(first) of winner | PIT mean | corr(expPlace, actPlace)");
  for (const wk of [...CUTS, 0]) {
    const rs = rows.filter((r) => r.mode === mode && (wk === 0 || r.cut === wk));
    const err = mean(rs.map((r) => Math.abs(r.expPts - r.actPts))), naive = mean(rs.map((r) => Math.abs(r.curPts - r.actPts)));
    const bias = mean(rs.map((r) => r.expPts - r.actPts));
    const b1 = mean(rs.map((r) => (r.pFirst - r.wonFirst) ** 2)), b3 = mean(rs.map((r) => (r.pTop3 - r.inTop3) ** 2));
    const pit = mean(rs.map((r) => r.midCdf));
    const mx = mean(rs.map((r) => r.expPlace)), my = mean(rs.map((r) => r.actPlace));
    const corr = rs.reduce((s, r) => s + (r.expPlace - mx) * (r.actPlace - my), 0) / Math.sqrt(rs.reduce((s, r) => s + (r.expPlace - mx) ** 2, 0) * rs.reduce((s, r) => s + (r.actPlace - my) ** 2, 0));
    const w = rs.filter((r) => r.wonFirst === 1);
    console.log(`${wk === 0 ? "all" : "wk" + wk} | ${rs.length} | ${fmt(err, 2)} (${fmt(naive, 2)}) | ${fmt(bias, 2)} | ${fmt(b1, 4)} | ${fmt(b3, 4)} | ${fmt(mean(w.map((r) => r.pFirst)), 3)} | ${fmt(pit, 3)} | ${fmt(corr, 3)}`);
    (report.byCut as Record<string, unknown>)[`${mode}-${wk}`] = { n: rs.length, mae: err, naive, bias, brierFirst: b1, brierTop3: b3, pit, corr };
  }
  const bucket = (key: "pFirst" | "pTop3" | "pInTopHalf", hit: "wonFirst" | "inTop3" | "inTopHalf", edges: number[]) => {
    console.log(`reliability ${key}: bucket | n | mean quote | actual rate`);
    const rs = rows.filter((r) => r.mode === mode);
    for (let i = 0; i < edges.length - 1; i++) {
      const b = rs.filter((r) => r[key] >= edges[i]! && r[key] < (i === edges.length - 2 ? 1.0001 : edges[i + 1]!));
      if (b.length) console.log(`  ${(edges[i]! * 100).toFixed(0)}-${(edges[i + 1]! * 100).toFixed(0)}% | ${b.length} | ${fmt(mean(b.map((r) => r[key])) * 100, 1)}% | ${fmt(mean(b.map((r) => r[hit])) * 100, 1)}%`);
    }
  };
  bucket("pFirst", "wonFirst", [0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 1]);
  bucket("pTop3", "inTop3", [0, 0.1, 0.25, 0.4, 0.6, 0.8, 0.9, 1]);
  bucket("pInTopHalf", "inTopHalf", [0, 0.1, 0.25, 0.4, 0.6, 0.8, 0.9, 1]);
}
console.log("\nprojected vs real final total of team T0 (mean relative error, projected - real)/real, by cut and category:");
for (const wk of CUTS) console.log(`wk${wk}: ` + CATS.map((c) => { const b = catBias[`${wk}|${c}`]!; return `${c} ${(100 * b.err / b.n).toFixed(1)}%`; }).join("  "));
// rank-histogram of the actual place within the predicted distribution: should be flat
const hist = Array<number>(10).fill(0);
for (const r of rows.filter((x) => x.mode === "exact")) hist[Math.min(9, Math.floor(r.midCdf * 10))]!++;
console.log("PIT histogram (deciles of the predicted cdf at the real place; flat = calibrated):", hist.map((x) => (x / rows.filter((r) => r.mode === "exact").length * 100).toFixed(1) + "%").join(" "));
const exact = rows.filter((r) => r.mode === "exact"), est = rows.filter((r) => r.mode === "estimated");
console.log(`estimated vs exact shooting: mean |difference in expected points| ${fmt(mean(exact.map((r, i) => Math.abs(r.expPts - est[i]!.expPts))), 3)}, in P(first) ${fmt(mean(exact.map((r, i) => Math.abs(r.pFirst - est[i]!.pFirst))) * 100, 2)} points`);
if (OUT) writeFileSync(OUT, JSON.stringify({ report, rows }, null, 1));
