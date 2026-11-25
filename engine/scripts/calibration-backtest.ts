/**
 * Win-chance calibration back-test for the standard-nine weekly matchup model (issue #9). MEASURES only; changes nothing.
 *
 * For every full week from week 6 of 2025-26, draw random 13-player rosters vs random opponents from the 182 best players
 * (by value on the games played BEFORE that week), have the engine quote a win chance using only pre-week information
 * (season-to-date per-game averages, the team's real number of games that week), then compare with what really happened
 * (sum of each player's real stats in that week).
 *
 * Export the data first (needs the bq CLI):
 *   bq query --use_legacy_sql=false --format=csv --max_rows=100000 --project_id=fantasy-survivor-app \
 *     'SELECT player_id, game_id, game_date, team_abbr, minutes, fgm,fga,ftm,fta,fg3m,fg3a,oreb,dreb,ast,stl,blk,turnovers,pf,pts,reb
 *      FROM `fantasy-survivor-app.nba_data.v_player_daily_game_stats` WHERE season="2025-26"' > games.csv
 * Run:  bun scripts/calibration-backtest.ts games.csv [--out results.json] [--matchups 300] [--sims 2000] [--games player|team]
 *   --games team   (default) each player gets his team's games that week (what the schedule says in advance)
 *   --mode std (default, the standard nine) | custom (a non-standard nine-category list, simulateAny) | points (ESPN league 994542812 scoring, simulatePoints)
 *   --games player each player gets the games he really played (how the engine's luck table was measured; injuries then are not luck)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { simulateWeeks, weeklyTotals, mondayOf, type WeeklyPlayer } from "../src/matchup";
import { mulberry32 } from "../src/simulate";
import { pointsOf, anyTotals, baseOf, categoryValue, isLowerCategory, neededStats, parseCategories, simulateAny, simulatePoints, type BaseKey, type BaseTotals, type Weights } from "../src/anycat";
import type { SeasonAverages } from "../src/types";

const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1]! : d; };
const file = args.find((a) => a.endsWith(".csv"))!;
const MATCHUPS = Number(flag("--matchups", "300")), SIMS = Number(flag("--sims", "2000"));
const GAMES = flag("--games", "team") as "team" | "player";
const OUT = flag("--out", "");
const MODE = flag("--mode", "std") as "std" | "custom" | "points";
const CUSTOM = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "TO", "FTM", "DD"];
// points scoring: weights per registry code (ESPN league 994542812, see scripts/measure-points-luck.py)
const POINTS_W: Weights = { PTS: 1, DREB: 1, FGA: -0.5, FGM: 1, TO: -1, BLK: 2, DD: 10, STL: 2, TD: 10, OREB: 1.5, "3PM": 3, AST: 1, "3PA": -1 };
const ANY_CODES = MODE === "custom" ? parseCategories(CUSTOM) : [];
const NEEDED = neededStats(MODE === "points" ? Object.keys(POINTS_W) : ANY_CODES);
const MIN_PRIOR_GAMES = 15, FIRST_WEEK_INDEX = 5, POOL = 182, SLOTS = 13;

const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n");
const cols = head!.split(",");
interface G { pid: number; gid: string; date: string; week: string; team: string; v: Record<string, number> }
const games: G[] = lines.map((l) => {
  const f = l.split(","); const o: Record<string, string> = {};
  cols.forEach((c, i) => (o[c] = f[i]!));
  const v: Record<string, number> = {};
  for (const c of ["minutes", "fgm", "fga", "ftm", "fta", "fg3m", "fg3a", "oreb", "dreb", "ast", "stl", "blk", "turnovers", "pf", "pts", "reb"]) v[c] = Number(o[c]);
  const dbl = [v.pts!, v.reb!, v.ast!, v.stl!, v.blk!].filter((x) => x >= 10).length;
  v.dd = dbl >= 2 ? 1 : 0; v.td = dbl >= 3 ? 1 : 0;
  return { pid: Number(o.player_id), gid: o.game_id!, date: o.game_date!, week: mondayOf(o.game_date!), team: o.team_abbr!, v };
}).sort((a, b) => a.date.localeCompare(b.date));

const weeks = [...new Set(games.map((g) => g.week))].sort();
// full weeks only: all 30 teams' weekly game counts exist and the week has 7 distinct game dates (drops the partial first/last week)
const fullWeeks = weeks.filter((w) => new Set(games.filter((g) => g.week === w).map((g) => g.date)).size >= 6);
const byPlayer = new Map<number, G[]>();
for (const g of games) (byPlayer.get(g.pid) ?? byPlayer.set(g.pid, []).get(g.pid)!).push(g);
const teamGames = new Map<string, Set<string>>(); // `${week}|${team}` -> game ids
for (const g of games) { const k = `${g.week}|${g.team}`; (teamGames.get(k) ?? teamGames.set(k, new Set()).get(k)!).add(g.gid); }

function averages(gs: G[]): SeasonAverages {
  const n = gs.length, s = (k: string) => gs.reduce((a, g) => a + g.v[k]!, 0) / n;
  const fgm = s("fgm"), fga = s("fga"), ftm = s("ftm"), fta = s("fta");
  return { pts: s("pts"), reb: s("reb"), ast: s("ast"), stl: s("stl"), blk: s("blk"), fg3m: s("fg3m"), turnovers: s("turnovers"),
    min: s("minutes"), oreb: s("oreb"), dreb: s("dreb"), pf: s("pf"), fg3a: s("fg3a"), dd_rate: s("dd"), td_rate: s("td"),
    fgm, fga, ftm, fta, fg_pct: fga ? fgm / fga : 0, ft_pct: fta ? ftm / fta : 0 };
}

const CATS: string[] = MODE === "custom" ? ANY_CODES : MODE === "points" ? [] : ["PTS", "REB", "AST", "STL", "BLK", "3PM", "TO", "FG%", "FT%"];
// quote key in engine output -> actual outcome; true = I win. TO: fewer wins.
function actualCats(me: Record<string, number>, op: Record<string, number>): (boolean | null)[] {
  const cmp = (a: number, b: number) => (a === b ? null : a > b);
  const fg = (t: Record<string, number>) => (t.fga ? t.fgm! / t.fga : 0), ft = (t: Record<string, number>) => (t.fta ? t.ftm! / t.fta : 0);
  return [cmp(me.pts!, op.pts!), cmp(me.reb!, op.reb!), cmp(me.ast!, op.ast!), cmp(me.stl!, op.stl!), cmp(me.blk!, op.blk!),
    cmp(me.fg3m!, op.fg3m!), cmp(op.turnovers!, me.turnovers!), cmp(fg(me), fg(op)), cmp(ft(me), ft(op))];
}

interface Row { week: string; q: number; won: boolean; cq: number[]; cw: (boolean | null)[] }
const rows: Row[] = [];
const rand = mulberry32(2026);
const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };

fullWeeks.slice(FIRST_WEEK_INDEX).forEach((w) => {
  // pre-week info only
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

  const gamesOf = (pid: number) => GAMES === "team" ? (teamGames.get(`${w}|${info.get(pid)!.team}`)?.size ?? 0) : info.get(pid)!.real.length;
  const toPlayers = (r: number[]): WeeklyPlayer[] => r.map((p) => ({ averages: info.get(p)!.avg, games: gamesOf(p), value: info.get(p)!.value }));
  const toAny = (r: number[]) => anyTotals(r.map((p) => ({ base: baseOf(info.get(p)!.avg, NEEDED), games: gamesOf(p), value: info.get(p)!.value })), SLOTS);
  const KEYS = ["minutes", "fgm", "fga", "ftm", "fta", "fg3m", "fg3a", "oreb", "dreb", "ast", "stl", "blk", "turnovers", "pf", "pts", "reb", "dd", "td"];
  const actual = (r: number[]) => {
    const t: Record<string, number> = Object.fromEntries(KEYS.map((k) => [k, 0]));
    for (const p of r) for (const g of info.get(p)!.real) for (const k of KEYS) t[k]! += g.v[k]!;
    return t;
  };
  for (let m = 0; m < MATCHUPS; m++) {
    const s = shuffle(pool.slice()).slice(0, 26), A = s.slice(0, 13), B = s.slice(13);
    if (MODE === "std") {
      const res = simulateWeeks(weeklyTotals(toPlayers(A), SLOTS), [weeklyTotals(toPlayers(B), SLOTS)], { weeks: SIMS, seed: 1 + m, slots: SLOTS });
      const cw = actualCats(actual(A), actual(B));
      rows.push({ week: w, q: res.weekWin, won: cw.filter((x) => x === true).length >= 5, cq: CATS.map((k) => (res.categories as any)[k]), cw });
    } else if (MODE === "custom") {
      const res = simulateAny(toAny(A), [toAny(B)], ANY_CODES, { weeks: SIMS, seed: 1 + m, slots: SLOTS });
      const a = actual(A) as unknown as BaseTotals, b = actual(B) as unknown as BaseTotals;
      const cw = ANY_CODES.map((c) => { const x = categoryValue(c, a), y = categoryValue(c, b); return x === y ? null : isLowerCategory(c) ? x < y : x > y; });
      const nw = cw.filter((x) => x === true).length, nl = cw.filter((x) => x === false).length;
      // quote = chance of winning the week outright; a drawn week counts as 0.5 won in neither the quote nor here, so drop it
      if (nw === nl) continue;
      rows.push({ week: w, q: res.weekWin / (res.weekWin + res.weekLoss), won: nw > nl, cq: ANY_CODES.map((c) => res.categories[c]!), cw });
    } else {
      const res = simulatePoints(toAny(A), [toAny(B)], POINTS_W, { weeks: SIMS, seed: 1 + m, slots: SLOTS });
      const a = pointsOf(POINTS_W, actual(A) as unknown as BaseTotals), b = pointsOf(POINTS_W, actual(B) as unknown as BaseTotals);
      rows.push({ week: w, q: res.weekWin / (res.weekWin + res.weekLoss), won: a > b, cq: [], cw: [] });
    }
  }
});

// ---- reporting ----
const BUCKETS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
const weekList = [...new Set(rows.map((r) => r.week))];
function table(pairs: { week: string; q: number; y: number }[]) {
  return BUCKETS.slice(0, -1).map((lo, i) => {
    const hi = BUCKETS[i + 1]!, sub = pairs.filter((p) => p.q >= lo && p.q < hi);
    const n = sub.length; if (!n) return null;
    const mq = sub.reduce((a, p) => a + p.q, 0) / n, rate = sub.reduce((a, p) => a + p.y, 0) / n;
    // week-clustered bootstrap SE: matchups within one week share players, so rows are not independent
    const byW = new Map<string, { n: number; w: number }>();
    for (const p of sub) { const e = byW.get(p.week) ?? byW.set(p.week, { n: 0, w: 0 }).get(p.week)!; e.n++; e.w += p.y; }
    const bs: number[] = [], bw = [...byW.values()];
    if (bw.length > 1) for (let b = 0; b < 300; b++) { let N = 0, W = 0; for (let k = 0; k < bw.length; k++) { const e = bw[Math.floor(rand() * bw.length)]!; N += e.n; W += e.w; } bs.push(W / N); }
    const sdv = bs.length ? Math.sqrt(bs.reduce((a, x) => a + (x - bs.reduce((s, y) => s + y, 0) / bs.length) ** 2, 0) / bs.length) : NaN;
    return { bucket: `${Math.round(lo * 100)}-${Math.round(Math.min(hi, 1) * 100)}%`, n, meanQuote: mq, actual: rate, seIndependent: Math.sqrt(rate * (1 - rate) / n), seWeekClustered: sdv, gap: rate - mq };
  }).filter(Boolean);
}
const brier = (ps: { q: number; y: number }[]) => ps.reduce((a, p) => a + (p.q - p.y) ** 2, 0) / ps.length;
// a quote of 70% for me is the same statement as 30% for the opponent, so calibration is symmetric; report each matchup once
const weekPairs = rows.map((r) => ({ week: r.week, q: r.q, y: r.won ? 1 : 0 }));
const out: any = { games: GAMES, matchups: MATCHUPS, sims: SIMS, weeksUsed: weekList.length, firstWeek: weekList[0], lastWeek: weekList[weekList.length - 1], matchupsTotal: rows.length };
out.week = { table: table(weekPairs), brier: brier(weekPairs), brierCoinFlip: 0.25, baseRate: weekPairs.reduce((a, p) => a + p.y, 0) / weekPairs.length };
// confidence slope: actual win rate as a function of quote, least squares of (y-0.5) on (q-0.5)
const slope = (ps: { q: number; y: number }[]) => { let sxy = 0, sxx = 0; for (const p of ps) { sxy += (p.q - 0.5) * (p.y - 0.5); sxx += (p.q - 0.5) ** 2; } return sxy / sxx; };
out.week.slope = slope(weekPairs);
out.week.meanAbsQuoteEdge = weekPairs.reduce((a, p) => a + Math.abs(p.q - 0.5), 0) / weekPairs.length;
out.categories = CATS.map((c: string, k: number) => {
  const ps: { week: string; q: number; y: number }[] = [];
  for (const r of rows) if (r.cw[k] !== null) ps.push({ week: r.week, q: r.cq[k]!, y: r.cw[k] ? 1 : 0 });
  return { cat: c, n: ps.length, meanQuote: ps.reduce((a, p) => a + p.q, 0) / ps.length, actualRate: ps.reduce((a, p) => a + p.y, 0) / ps.length,
    brier: brier(ps), slope: slope(ps), table: table(ps) };
});
const allCat = out.categories.flatMap((_: any, k: number) => rows.filter((r) => r.cw[k] !== null).map((r) => ({ week: r.week, q: r.cq[k]!, y: r.cw[k] ? 1 : 0 })));
out.allCategories = { n: allCat.length, brier: brier(allCat), slope: slope(allCat), table: table(allCat) };
// does the quote of a category that is certain-ish (>90% / <10%) come true? covered by buckets. Also category count distribution check:
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
const pc = (x: number) => (x * 100).toFixed(1) + "%";
console.log(`games=${GAMES} weeks=${out.weeksUsed} (${out.firstWeek}..${out.lastWeek}) matchups=${rows.length}`);
console.log("WEEK WIN: bucket  n  meanQuote  actual  SE(indep)  SE(week-clustered)");
for (const t of out.week.table) console.log(`  ${t.bucket.padEnd(8)} ${String(t.n).padStart(6)}  ${pc(t.meanQuote)}  ${pc(t.actual)}  ±${pc(t.seIndependent)}  ±${pc(t.seWeekClustered)}`);
console.log(`Brier ${out.week.brier.toFixed(4)} vs coin flip 0.25; slope ${out.week.slope.toFixed(3)} (1 = calibrated, <1 overconfident)`);
for (const c of out.categories) console.log(`${c.cat.padEnd(4)} n=${c.n} quote ${pc(c.meanQuote)} actual ${pc(c.actualRate)} brier ${c.brier.toFixed(4)} slope ${c.slope.toFixed(3)}`);
if (CATS.length) console.log(`ALL CATS brier ${out.allCategories.brier.toFixed(4)} slope ${out.allCategories.slope.toFixed(3)}`);
