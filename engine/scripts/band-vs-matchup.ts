/**
 * Team-check bands versus the weekly matchup, on the same footing (issue #24). MEASURES only.
 *
 * Builds simulated-draft rosters (10 teams x 13 spots, every pick one of the best few remaining) from a snapshot, runs analyze()
 * on each with a matchup against typical opponents (no schedule: every player gets 3.4 games, lineup = all 13 spots),
 * and writes each roster's team-check percentile / band and matchup win chance per category. Compare two runs (before and
 * after a change) with:  bun scripts/band-vs-matchup.ts --compare before.json after.json
 *
 * Run:  bun scripts/band-vs-matchup.ts snapshot.json [--n 100] [--out rows.json] [--weeks 4000] [--leagues 300]
 * Snapshot: https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { analyze, type AnalyzeInput } from "../src/analyze";
import { DEFAULT_PICK_WEIGHTS, mulberry32, pickIndex } from "../src/simulate";
import { CATEGORIES } from "../src/types";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1]! : d; };
const corr = (x: number[], y: number[]) => {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; syy += (y[i]! - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};

interface Row { names: string[]; pct: Record<string, number>; band: Record<string, string>; win: Record<string, number> }

if (args[0] === "--compare") {
  const a: Row[] = JSON.parse(readFileSync(args[1]!, "utf8")), b: Row[] = JSON.parse(readFileSync(args[2]!, "utf8"));
  console.log(`${a.length} rosters. Per category: correlation(percentile, matchup win %) before -> after; bands changed; mean |percentile change|; matchup win % identical rows`);
  for (const c of CATEGORIES) {
    const ca = corr(a.map((r) => r.pct[c]!), a.map((r) => r.win[c]!)), cb = corr(b.map((r) => r.pct[c]!), b.map((r) => r.win[c]!));
    const changed = a.filter((r, i) => r.band[c] !== b[i]!.band[c]).length;
    const dp = a.reduce((s, r, i) => s + Math.abs(r.pct[c]! - b[i]!.pct[c]!), 0) / a.length;
    const same = a.filter((r, i) => r.win[c] === b[i]!.win[c]).length;
    console.log(`${c.padEnd(4)} ${ca.toFixed(2)} -> ${cb.toFixed(2)}   bands changed ${changed}/${a.length}   mean |dpct| ${dp.toFixed(1)}   win% same ${same}/${a.length}`);
  }
  const contra = (rows: Row[]) => {
    let weak = 0, weakWin = 0, strong = 0, strongLose = 0;
    for (const r of rows) for (const c of CATEGORIES) {
      if (r.band[c] === "weak") { weak++; if (r.win[c]! >= 50) weakWin++; }
      if (r.band[c] === "strong" || r.band[c] === "elite") { strong++; if (r.win[c]! <= 50) strongLose++; }
    }
    return `weak-but-win>=50: ${weakWin}/${weak}, strong/elite-but-win<=50: ${strongLose}/${strong}`;
  };
  console.log("before:", contra(a)); console.log("after: ", contra(b));
  process.exit(0);
}

const snap = JSON.parse(readFileSync(args.find((x) => x.endsWith(".json"))!, "utf8"));
const N = Number(flag("--n", "100")), WEEKS = Number(flag("--weeks", "4000")), LEAGUES = Number(flag("--leagues", "300"));
const teams = 10, spots = 13;
// Draft pool: the best 130 players by last-season minutes x production proxy (points + rebounds + assists per game); the roster's
// own scoring is done by analyze(), so this only needs to give realistic mixes of players.
const ref = snap.reference_season;
const cand = snap.players.map((p: any) => ({ p, s: p.seasons.find((x: any) => x.season === ref) })).filter((x: any) => x.s && x.s.gp >= 30 && x.s.mpg >= 15);
cand.sort((a: any, b: any) => (b.s.averages.pts + b.s.averages.reb + b.s.averages.ast) - (a.s.averages.pts + a.s.averages.reb + a.s.averages.ast));
const pool = cand.slice(0, teams * spots).map((x: any) => x.p.name as string);
const rand = mulberry32(42);
const rows: Row[] = [];
for (let l = 0; l < N; l++) {
  const rem = pool.slice();
  const rs: string[][] = Array.from({ length: teams }, () => []);
  for (let r = 0; r < spots; r++) for (let k = 0; k < teams; k++) {
    const t = r % 2 === 0 ? k : teams - 1 - k;
    rs[t]!.push(rem.splice(pickIndex(rem.length, DEFAULT_PICK_WEIGHTS, rand), 1)[0]!);
  }
  const names = rs[Math.floor(rand() * teams)]!;
  const input: AnalyzeInput = { league: { teams, roster_spots: spots }, roster: names.map((name) => ({ name })), leagues: LEAGUES, seed: 1, matchup: { week_start: "1900-01-05", weeks: WEEKS } };
  const out = analyze(input, snap);
  rows.push({
    names,
    pct: Object.fromEntries(CATEGORIES.map((c) => [c, out.categories[c].percentile])),
    band: Object.fromEntries(CATEGORIES.map((c) => [c, out.categories[c].band])),
    win: Object.fromEntries(CATEGORIES.map((c) => [c, out.matchup!.categories[c]])),
  });
}
console.log(`${rows.length} rosters; correlation(team-check percentile, matchup win %) per category`);
for (const c of CATEGORIES) console.log(c.padEnd(4), corr(rows.map((r) => r.pct[c]!), rows.map((r) => r.win[c]!)).toFixed(2));
const out = flag("--out", "");
if (out) writeFileSync(out, JSON.stringify(rows));
