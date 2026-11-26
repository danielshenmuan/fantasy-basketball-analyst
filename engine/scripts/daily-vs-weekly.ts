/**
 * Daily vs weekly week-win chance on realistic rosters (issue #33). MEASURES only; changes nothing.
 * Run: bun scripts/daily-vs-weekly.ts snapshot.json [--pairs 60] [--week 2026-11-23] [--sims 1500]
 * snapshot.json: https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json (it has schedule.days).
 * For each random pair of 13-player rosters from the 150 best players it reports the weekly number, the daily number with only
 * your side fielded day by day (the old headline), and the daily number with both fielded day by day (now the headline),
 * once with a bare 10-starter lineup and once with positions and slots; plus games the bench adds on idle days.
 */
import { readFileSync } from "node:fs";
import { analyze, type Snapshot } from "../src";
import { mulberry32 } from "../src/simulate";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1]! : d; };
const snap = JSON.parse(readFileSync(args.find((a) => a.endsWith(".json"))!, "utf8")) as Snapshot;
const PAIRS = Number(flag("--pairs", "60")), WEEK = flag("--week", "2026-11-23"), SIMS = Number(flag("--sims", "1500"));
const SLOTS = ["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "UTIL", "UTIL"];
const latest = (p: Snapshot["players"][number]) => p.seasons[p.seasons.length - 1]!;
const score = (p: Snapshot["players"][number]) => { const a = latest(p).averages; return a.pts + 1.2 * a.reb + 1.5 * a.ast + 2 * a.stl + 2 * a.blk + a.fg3m; };
const pool = snap.players.filter((p) => latest(p).gp >= 20 && latest(p).mpg >= 20).sort((a, b) => score(b) - score(a)).slice(0, 150);
// Positions are not in the snapshot: a rough guess from the stat line, enough to give a realistic slot-fit problem.
const posOf = (p: Snapshot["players"][number]): string => {
  const a = latest(p).averages;
  if (a.reb >= 8.5 && a.ast < 4) return "C";
  if (a.reb >= 6.5 && a.ast < 3.5) return "PF,C";
  if (a.ast >= 6.5) return "PG";
  if (a.ast >= 4.5) return "PG,SG";
  if (a.reb >= 5.5) return "SF,PF";
  if (a.fg3m >= 2) return "SG,SF";
  return "SF";
};
const rand = mulberry32(33);
const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

interface R { W: number; D: number; S: number; yg: number; og: number; ygd: number; ogd: number }
function run(pos: boolean) {
  const rs: R[] = [];
  const r2 = mulberry32(33);
  const sh = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
  for (let k = 0; k < PAIRS; k++) {
    const s = sh(pool.slice()).slice(0, 26);
    const side = (xs: typeof pool) => xs.map((p) => ({ name: p.name, ...(pos ? { positions: posOf(p) } : {}) }));
    const league = { teams: 12, roster_spots: 13, lineup_lock: "daily" as const, ...(pos ? { slots: SLOTS } : {}) };
    const o = analyze({ league, roster: side(s.slice(0, 13)), matchup: { week_start: WEEK, weeks: SIMS, ...(pos ? {} : { lineup_slots: 10 }), opponent: side(s.slice(13)), daily: {} }, as_of: WEEK }, snap).matchup!;
    const c = o.daily!.compare_with_weekly;
    rs.push({ W: c.weekly_week_win_pct, D: c.you_only_daily_week_win_pct!, S: c.daily_week_win_pct, yg: c.your_games.weekly_lineup, ygd: c.your_games.from_bench, og: c.opponent_games!.weekly_lineup, ogd: c.opponent_games!.from_bench });
  }
  return rs;
}
for (const pos of [false, true]) {
  const rs = run(pos);
  console.log(`\n== ${pos ? "positions + slots" : "10 starters, no positions"}; week ${WEEK}; ${rs.length} pairs ==`);
  console.log(`mean weekly ${mean(rs.map((r) => r.W)).toFixed(1)}  daily(you only) ${mean(rs.map((r) => r.D)).toFixed(1)}  daily(both) ${mean(rs.map((r) => r.S)).toFixed(1)}`);
  console.log(`mean |edge| weekly ${mean(rs.map((r) => Math.abs(r.W - 50))).toFixed(1)}  daily(you only) ${mean(rs.map((r) => Math.abs(r.D - 50))).toFixed(1)}  daily(both) ${mean(rs.map((r) => Math.abs(r.S - 50))).toFixed(1)}`);
  console.log(`bench games added: you +${mean(rs.map((r) => r.ygd)).toFixed(2)}, opponent +${mean(rs.map((r) => r.ogd)).toFixed(2)} (weekly lineup games ${mean(rs.map((r) => r.yg)).toFixed(1)} / ${mean(rs.map((r) => r.og)).toFixed(1)})`);
  console.log(`source 1, your bench fills idle days: D-W = ${mean(rs.map((r) => r.D - r.W)).toFixed(1)} pts   (mean abs ${mean(rs.map((r) => Math.abs(r.D - r.W))).toFixed(1)})`);
  console.log(`source 2, opponent bench fills too:   S-D = ${mean(rs.map((r) => r.S - r.D)).toFixed(1)} pts   (mean abs ${mean(rs.map((r) => Math.abs(r.S - r.D))).toFixed(1)})`);
  console.log(`net gap S-W ${mean(rs.map((r) => r.S - r.W)).toFixed(1)} pts (mean abs ${mean(rs.map((r) => Math.abs(r.S - r.W))).toFixed(1)}); largest |D-W| ${Math.max(...rs.map((r) => Math.abs(r.D - r.W)))}`);
  const big = rs.filter((r) => r.D - r.W >= 20).length;
  console.log(`pairs where D-W >= 20 pts: ${big} of ${rs.length}`);
}
