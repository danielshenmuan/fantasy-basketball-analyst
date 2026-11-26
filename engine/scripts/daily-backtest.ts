/**
 * Back-test of the DAILY lineup model against the weekly one (issue #33). MEASURES only; changes nothing in the engine.
 * Same data, pool, pairs and pre-week information as scripts/calibration-backtest.ts (standard nine, schedule game counts).
 *
 * Quotes compared, all from pre-week information and the real day-by-day team schedule:
 *   weekly      each side's best 10 by value, per-game average x the team's games that week (the product's weekly number)
 *   daily_you   your side fielded day by day (best 10 of those whose team plays that day), opponent weekly (the product's daily number)
 *   daily_both  both sides fielded day by day
 * Outcomes (the real week), two ways because a league sets a lineup every day:
 *   R_all    every player on the roster counts for every game he played (as in docs/calibration.md; nobody is benched)
 *   R_daily  each day each side starts its 10 best (by the same pre-week value) among the players who really played that day
 * Run:  bun scripts/daily-backtest.ts games.csv [--out r.json] [--matchups 150] [--sims 1500]
 * (export games.csv as in calibration-backtest.ts)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { simulateWeeks, weeklyTotals, mondayOf, type WeeklyPlayer, type WeeklyTotals } from "../src/matchup";
import { mulberry32 } from "../src/simulate";
import type { SeasonAverages } from "../src/types";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1]! : d; };
const file = args.find((a) => a.endsWith(".csv"))!;
const MATCHUPS = Number(flag("--matchups", "150")), SIMS = Number(flag("--sims", "1500")), OUT = flag("--out", "");
const MIN_PRIOR_GAMES = 15, FIRST_WEEK_INDEX = 5, POOL = 182, SLOTS = 10, ROSTER = 13;

const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n");
const cols = head!.split(",");
interface G { pid: number; gid: string; date: string; week: string; team: string; v: Record<string, number> }
const KEYS = ["minutes", "fgm", "fga", "ftm", "fta", "fg3m", "fg3a", "oreb", "dreb", "ast", "stl", "blk", "turnovers", "pf", "pts", "reb"];
const games: G[] = lines.map((l) => {
  const f = l.split(","); const o: Record<string, string> = {};
  cols.forEach((c, i) => (o[c] = f[i]!));
  const v: Record<string, number> = {};
  for (const c of KEYS) v[c] = Number(o[c]);
  return { pid: Number(o.player_id), gid: o.game_id!, date: o.game_date!, week: mondayOf(o.game_date!), team: o.team_abbr!, v };
}).sort((a, b) => a.date.localeCompare(b.date));

const weeks = [...new Set(games.map((g) => g.week))].sort();
const fullWeeks = weeks.filter((w) => new Set(games.filter((g) => g.week === w).map((g) => g.date)).size >= 6);
const byPlayer = new Map<number, G[]>();
for (const g of games) (byPlayer.get(g.pid) ?? byPlayer.set(g.pid, []).get(g.pid)!).push(g);
const teamDays = new Map<string, Set<string>>(); // `${week}|${team}` -> dates the team plays
for (const g of games) { const k = `${g.week}|${g.team}`; (teamDays.get(k) ?? teamDays.set(k, new Set()).get(k)!).add(g.date); }

function averages(gs: G[]): SeasonAverages {
  const n = gs.length, s = (k: string) => gs.reduce((a, g) => a + g.v[k]!, 0) / n;
  const fgm = s("fgm"), fga = s("fga"), ftm = s("ftm"), fta = s("fta");
  return { pts: s("pts"), reb: s("reb"), ast: s("ast"), stl: s("stl"), blk: s("blk"), fg3m: s("fg3m"), turnovers: s("turnovers"),
    min: s("minutes"), oreb: s("oreb"), dreb: s("dreb"), pf: s("pf"), fg3a: s("fg3a"), dd_rate: 0, td_rate: 0,
    fgm, fga, ftm, fta, fg_pct: fga ? fgm / fga : 0, ft_pct: fta ? ftm / fta : 0 };
}
const sumTotals = (xs: WeeklyTotals[]): WeeklyTotals => {
  const t: WeeklyTotals = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
  for (const x of xs) for (const k of Object.keys(t) as (keyof WeeklyTotals)[]) t[k] += x[k];
  return t;
};
const rawTotals = (gs: G[]): WeeklyTotals => ({
  pts: gs.reduce((a, g) => a + g.v.pts!, 0), reb: gs.reduce((a, g) => a + g.v.reb!, 0), ast: gs.reduce((a, g) => a + g.v.ast!, 0), stl: gs.reduce((a, g) => a + g.v.stl!, 0),
  blk: gs.reduce((a, g) => a + g.v.blk!, 0), fg3m: gs.reduce((a, g) => a + g.v.fg3m!, 0), tov: gs.reduce((a, g) => a + g.v.turnovers!, 0),
  fgm: gs.reduce((a, g) => a + g.v.fgm!, 0), fga: gs.reduce((a, g) => a + g.v.fga!, 0), ftm: gs.reduce((a, g) => a + g.v.ftm!, 0), fta: gs.reduce((a, g) => a + g.v.fta!, 0),
});
/** categories won by A: 9-cat result; tov fewer wins. */
function catsWon(a: WeeklyTotals, b: WeeklyTotals): { w: number; l: number } {
  const cmp = (x: number, y: number) => (x === y ? 0 : x > y ? 1 : -1);
  const fg = (t: WeeklyTotals) => (t.fga ? t.fgm / t.fga : 0), ft = (t: WeeklyTotals) => (t.fta ? t.ftm / t.fta : 0);
  const r = [cmp(a.pts, b.pts), cmp(a.reb, b.reb), cmp(a.ast, b.ast), cmp(a.stl, b.stl), cmp(a.blk, b.blk), cmp(a.fg3m, b.fg3m), cmp(b.tov, a.tov), cmp(fg(a), fg(b)), cmp(ft(a), ft(b))];
  return { w: r.filter((x) => x > 0).length, l: r.filter((x) => x < 0).length };
}

interface Row { week: string; q: Record<string, number>; won: Record<string, boolean> }
const rows: Row[] = [];
const rand = mulberry32(2026);
const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
const dayList = (w: string) => Array.from({ length: 7 }, (_, i) => new Date(Date.parse(w + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
let skippedTies = 0;

fullWeeks.slice(FIRST_WEEK_INDEX).forEach((w) => {
  const info = new Map<number, { avg: SeasonAverages; team: string; real: G[]; value: number }>();
  for (const [pid, gs] of byPlayer) {
    const prior = gs.filter((g) => g.date < w);
    if (prior.length < MIN_PRIOR_GAMES) continue;
    info.set(pid, { avg: averages(prior), team: prior[prior.length - 1]!.team, real: gs.filter((g) => g.week === w), value: 0 });
  }
  const ids = [...info.keys()];
  const stat = (f: (a: SeasonAverages) => number) => { const xs = ids.map((i) => f(info.get(i)!.avg)); const m = xs.reduce((a, b) => a + b) / xs.length; return { m, s: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1 }; };
  const keys: [(a: SeasonAverages) => number, number][] = [[(a) => a.pts, 1], [(a) => a.reb, 1], [(a) => a.ast, 1], [(a) => a.stl, 1], [(a) => a.blk, 1], [(a) => a.fg3m, 1], [(a) => a.turnovers, -1]];
  const st = keys.map(([f]) => stat(f));
  for (const i of ids) { const p = info.get(i)!; p.value = keys.reduce((s, [f, sg], k) => s + sg * (f(p.avg) - st[k]!.m) / st[k]!.s, 0); }
  const pool = ids.sort((a, b) => info.get(b)!.value - info.get(a)!.value).slice(0, POOL);
  const days = dayList(w);
  const plays = (pid: number, d: string) => teamDays.get(`${w}|${info.get(pid)!.team}`)?.has(d) ?? false;
  const nGames = (pid: number) => teamDays.get(`${w}|${info.get(pid)!.team}`)?.size ?? 0;
  const wp = (pid: number, games: number): WeeklyPlayer => ({ averages: info.get(pid)!.avg, games, value: info.get(pid)!.value });
  const weeklyOf = (r: number[]) => weeklyTotals(r.map((p) => wp(p, nGames(p))), SLOTS);
  const dailyOf = (r: number[]) => sumTotals(days.map((d) => weeklyTotals(r.filter((p) => plays(p, d)).map((p) => wp(p, 1)), SLOTS)));
  const realAll = (r: number[]) => rawTotals(r.flatMap((p) => info.get(p)!.real));
  const realDaily = (r: number[]) => {
    const picked: G[] = [];
    for (const d of days) {
      const today = r.filter((p) => info.get(p)!.real.some((g) => g.date === d)).sort((a, b) => info.get(b)!.value - info.get(a)!.value).slice(0, SLOTS);
      for (const p of today) picked.push(...info.get(p)!.real.filter((g) => g.date === d));
    }
    return rawTotals(picked);
  };
  for (let m = 0; m < MATCHUPS; m++) {
    const s = shuffle(pool.slice()).slice(0, 26), A = s.slice(0, ROSTER), B = s.slice(ROSTER);
    const sim = (a: WeeklyTotals, b: WeeklyTotals) => simulateWeeks(a, [b], { weeks: SIMS, seed: 1 + m, slots: SLOTS }).weekWin;
    const wa = weeklyOf(A), wb = weeklyOf(B), da = dailyOf(A), db = dailyOf(B);
    const q = { weekly: sim(wa, wb), daily_you: sim(da, wb), daily_both: sim(da, db) };
    const won: Record<string, boolean> = {};
    let skip = false;
    for (const [name, f] of [["R_all", realAll], ["R_daily", realDaily]] as const) {
      const c = catsWon(f(A), f(B));
      if (c.w === c.l) { skip = true; break; }
      won[name] = c.w > c.l;
    }
    if (skip) { skippedTies++; continue; }
    rows.push({ week: w, q, won });
  }
});

const BUCKETS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
const brier = (ps: { q: number; y: number }[]) => ps.reduce((a, p) => a + (p.q - p.y) ** 2, 0) / ps.length;
const slope = (ps: { q: number; y: number }[]) => { let sxy = 0, sxx = 0; for (const p of ps) { sxy += (p.q - 0.5) * (p.y - 0.5); sxx += (p.q - 0.5) ** 2; } return sxy / sxx; };
const table = (ps: { q: number; y: number }[]) => BUCKETS.slice(0, -1).map((lo, i) => {
  const sub = ps.filter((p) => p.q >= lo && p.q < BUCKETS[i + 1]!); if (!sub.length) return null;
  return { bucket: `${Math.round(lo * 100)}-${Math.round(Math.min(BUCKETS[i + 1]!, 1) * 100)}%`, n: sub.length, meanQuote: sub.reduce((a, p) => a + p.q, 0) / sub.length, actual: sub.reduce((a, p) => a + p.y, 0) / sub.length };
}).filter(Boolean) as { bucket: string; n: number; meanQuote: number; actual: number }[];
// week-clustered bootstrap of Brier and slope (matchups in one week share players)
const weekIds = [...new Set(rows.map((r) => r.week))];
function boot(f: (ps: { q: number; y: number }[]) => number, all: Row[], qk: string, ok: string): number {
  const by = new Map<string, Row[]>(); for (const r of all) (by.get(r.week) ?? by.set(r.week, []).get(r.week)!).push(r);
  const xs: number[] = [];
  for (let b = 0; b < 300; b++) { const ps: { q: number; y: number }[] = []; for (let k = 0; k < weekIds.length; k++) for (const r of by.get(weekIds[Math.floor(rand() * weekIds.length)]!)!) ps.push({ q: r.q[qk]!, y: r.won[ok] ? 1 : 0 }); xs.push(f(ps)); }
  const mu = xs.reduce((a, b) => a + b) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / xs.length);
}
const pc = (x: number) => (x * 100).toFixed(1) + "%";
const result: any = { weeks: weekIds.length, first: weekIds[0], last: weekIds[weekIds.length - 1], matchups: rows.length, skippedTies, tables: {} };
console.log(`weeks=${weekIds.length} (${weekIds[0]}..${weekIds[weekIds.length - 1]}) matchups=${rows.length} (ties dropped ${skippedTies})`);
console.log(`mean quote: ${["weekly", "daily_you", "daily_both"].map((k) => `${k} ${pc(rows.reduce((a, r) => a + r.q[k]!, 0) / rows.length)}`).join("  ")}; mean |edge| ${["weekly", "daily_you", "daily_both"].map((k) => `${k} ${pc(rows.reduce((a, r) => a + Math.abs(r.q[k]! - 0.5), 0) / rows.length)}`).join("  ")}`);
for (const ok of ["R_daily", "R_all"]) {
  console.log(`\n### outcome ${ok}: base rate ${pc(rows.reduce((a, r) => a + (r.won[ok] ? 1 : 0), 0) / rows.length)}`);
  for (const qk of ["weekly", "daily_you", "daily_both"]) {
    const ps = rows.map((r) => ({ q: r.q[qk]!, y: r.won[ok] ? 1 : 0 }));
    const t = table(ps);
    result.tables[`${qk}|${ok}`] = { brier: brier(ps), slope: slope(ps), table: t };
    console.log(`${qk.padEnd(11)} Brier ${brier(ps).toFixed(4)} (±${boot(brier, rows, qk, ok).toFixed(4)})  slope ${slope(ps).toFixed(2)} (±${boot(slope, rows, qk, ok).toFixed(2)})  [coin flip 0.2500]`);
    console.log("   " + t.map((x) => `${x.bucket}: n${x.n} quote ${(x.meanQuote * 100).toFixed(0)} actual ${(x.actual * 100).toFixed(0)}`).join(" | "));
  }
}
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
