import { DEFAULT_PICK_WEIGHTS, mulberry32, pickIndex } from "./simulate";
import type { Category, SeasonAverages } from "./types";

/**
 * Weekly head-to-head simulation (decision D12). Expected weekly total = per-game average x the games that week
 * (known from the schedule, never treated as luck), plus week-to-week luck measured on real weekly results.
 * Count the categories each side wins; 5 of 9 wins the week. Repeat thousands of times with a fixed seed.
 */

/** Games per player in a week when the schedule is not available: 82 games x 7 days / 170-day regular season. */
export const DEFAULT_WEEK_GAMES = 3.4;
export const DEFAULT_WEEKS = 10000;

/**
 * Week-to-week luck, measured on 1,500 random 13-player rosters over the 25 full weeks of 2025-26 (D12, 2026-11-23),
 * AFTER removing the effect of how many games each player played. Counting stats: the standard deviation of a roster's
 * weekly total as a share of that total. FG% and FT%: standard deviation in percentage points of the weekly percentage.
 * Option 2 (one number per category). FUTURE UPGRADE: Option 3, per-player variance in the snapshot (the roster-to-roster
 * spread is wide, e.g. 3PM 11.6%-17.6%, BLK 18%-28%).
 */
export const LUCK_REFERENCE_SLOTS = 13;
/** Luck shrinks with the square root of the number of players: re-measured 2026-11-23 at 10 players, it came out 1.15x (sqrt(13/10) = 1.14). */
export const luckScale = (slots: number): number => Math.sqrt(LUCK_REFERENCE_SLOTS / slots);
export const WEEKLY_LUCK = { pts: 0.08, reb: 0.09, ast: 0.11, stl: 0.17, blk: 0.23, fg3m: 0.14, tov: 0.13 } as const;
export const WEEKLY_LUCK_PCT = { fg: 0.024, ft: 0.041 } as const;
/** Correlation of that luck across the counting categories (same data). Order: pts, reb, ast, stl, blk, fg3m, tov. */
export const LUCK_CORRELATION: readonly (readonly number[])[] = [
  [1.0, 0.29, 0.2, 0.1, 0.11, 0.63, 0.14],
  [0.29, 1.0, 0.24, 0.1, 0.17, 0.11, 0.18],
  [0.2, 0.24, 1.0, 0.08, 0.1, 0.12, 0.1],
  [0.1, 0.1, 0.08, 1.0, 0.07, 0.03, 0.1],
  [0.11, 0.17, 0.1, 0.07, 1.0, 0.05, 0.02],
  [0.63, 0.11, 0.12, 0.03, 0.05, 1.0, 0.08],
  [0.14, 0.18, 0.1, 0.1, 0.02, 0.08, 1.0],
];
const COUNT_KEYS = ["pts", "reb", "ast", "stl", "blk", "fg3m", "tov"] as const;

function cholesky(m: readonly (readonly number[])[]): number[][] {
  const n = m.length;
  const L = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = m[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (s <= 0) throw new Error("LUCK_CORRELATION is not positive definite");
        L[i]![j] = Math.sqrt(s);
      } else L[i]![j] = s / L[j]![j]!;
    }
  return L;
}
const LUCK_L = cholesky(LUCK_CORRELATION);

/** What one team produces in a week before luck. */
export interface WeeklyTotals {
  pts: number; reb: number; ast: number; stl: number; blk: number; fg3m: number; tov: number;
  fgm: number; fga: number; ftm: number; fta: number;
}
export interface WeeklyPlayer {
  averages: SeasonAverages;
  /** Games this player's team plays in the week. */
  games: number;
  /** Ranking value (sum of category scores): the best `slots` by value fill the lineup. */
  value: number;
}

/** Sum of the best `slots` players by value, each at per-game average x games. Made shots fall back to attempts x percentage. */
export function weeklyTotals(players: WeeklyPlayer[], slots: number): WeeklyTotals {
  const lineup = [...players].sort((a, b) => b.value - a.value).slice(0, slots);
  const t: WeeklyTotals = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
  for (const p of lineup) {
    const a = p.averages, g = p.games;
    t.pts += a.pts * g; t.reb += a.reb * g; t.ast += a.ast * g; t.stl += a.stl * g; t.blk += a.blk * g;
    t.fg3m += a.fg3m * g; t.tov += a.turnovers * g;
    t.fgm += (a.fgm ?? a.fga * a.fg_pct) * g; t.fga += a.fga * g;
    t.ftm += (a.ftm ?? a.fta * a.ft_pct) * g; t.fta += a.fta * g;
  }
  return t;
}

export type CategoryWins = Record<Category, number>;
export interface MatchupResult {
  weeks: number;
  /** Share of simulated weeks in which the first team wins each category. */
  categories: CategoryWins;
  /** Share of simulated weeks in which the first team wins 5 or more of 9. */
  weekWin: number;
  /** distribution[k] = share of weeks the first team wins exactly k categories (k = 0..9). */
  distribution: number[];
}

/** `slots`: players who count in each lineup. Luck was measured at 13 and scales with sqrt(13 / slots). */
export interface SimulateWeeksOptions {
  weeks?: number; seed?: number; luck?: boolean; slots?: number;
  /**
   * A week already under way. `me` and `opponent` passed to simulateWeeks stay the FULL-week expected totals; `remainingShare`
   * (0 to 1) is the part of that week still to play, and `me` / `opponent` here are the stats already banked.
   * Only the remaining part is expected-plus-luck; the banked part is fixed.
   */
  progress?: { remainingShare: number; me: WeeklyTotals; opponent: WeeklyTotals };
}

function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

interface Outcome { cnt: number[]; fg: number; ft: number }
function outcome(t: WeeklyTotals, luck: boolean, g: () => number, scale: number): Outcome {
  const cnt = COUNT_KEYS.map((k) => t[k]);
  let fg = t.fga > 0 ? t.fgm / t.fga : 0, ft = t.fta > 0 ? t.ftm / t.fta : 0;
  if (luck) {
    const z = COUNT_KEYS.map(() => g());
    COUNT_KEYS.forEach((k, i) => {
      const c = LUCK_L[i]!.reduce((s, v, j) => s + v * z[j]!, 0);
      cnt[i] = Math.max(0, cnt[i]! * (1 + WEEKLY_LUCK[k] * scale * c));
    });
    fg = Math.min(1, Math.max(0, fg + WEEKLY_LUCK_PCT.fg * scale * g()));
    ft = Math.min(1, Math.max(0, ft + WEEKLY_LUCK_PCT.ft * scale * g()));
  }
  return { cnt, fg, ft };
}

function scaled(t: WeeklyTotals, k: number): WeeklyTotals {
  const o = { ...t };
  for (const key of Object.keys(o) as (keyof WeeklyTotals)[]) o[key] = t[key] * k;
  return o;
}

/**
 * One team's final week when `banked` is already in the books: the banked stats plus the remaining share of the expected
 * week with luck. Luck is measured on a whole week, so on a part of a week it is larger in relative terms by
 * 1 / sqrt(share) (a game's randomness adds like independent draws: the swing of the whole is sqrt(share) times the swing of
 * the full week, while the remaining part is only `share` of the total). FG% and FT% are re-weighted by attempts.
 */
function finalOutcome(
  full: WeeklyTotals, banked: WeeklyTotals | undefined, share: number, luck: boolean, g: () => number, scale: number,
): Outcome {
  if (!banked) return outcome(full, luck, g, scale);
  const rem = scaled(full, share);
  const o = outcome(rem, luck && share > 0, g, share > 0 ? scale / Math.sqrt(share) : scale);
  const cnt = o.cnt.map((v, i) => v + banked[COUNT_KEYS[i]!]);
  const fga = banked.fga + rem.fga, fta = banked.fta + rem.fta;
  return {
    cnt,
    fg: fga > 0 ? (banked.fgm + o.fg * rem.fga) / fga : 0,
    ft: fta > 0 ? (banked.ftm + o.ft * rem.fta) / fta : 0,
  };
}

const CAT_ORDER: Category[] = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "TO", "FG%", "FT%"];

/**
 * Simulate `weeks` head-to-head weeks. `opponents` is one real opponent, or many typical ones: each simulated week
 * draws one of them at random. Ties in a category count for neither side (they do not happen once luck is on).
 */
export function simulateWeeks(me: WeeklyTotals, opponents: WeeklyTotals[], opts: SimulateWeeksOptions = {}): MatchupResult {
  if (opponents.length === 0) throw new Error("simulateWeeks: no opponents");
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  const luck = opts.luck ?? true;
  const rand = mulberry32(opts.seed ?? 1);
  const g = gaussian(rand);
  const scale = luckScale(opts.slots ?? LUCK_REFERENCE_SLOTS);
  const wins = Array<number>(9).fill(0);
  const dist = Array<number>(10).fill(0);
  let weekWins = 0;
  for (let w = 0; w < weeks; w++) {
    const opp = opponents[opponents.length === 1 ? 0 : Math.floor(rand() * opponents.length)]!;
    const pr = opts.progress;
    const a = finalOutcome(me, pr?.me, pr?.remainingShare ?? 1, luck, g, scale);
    const b = finalOutcome(opp, pr?.opponent, pr?.remainingShare ?? 1, luck, g, scale);
    let won = 0;
    for (let i = 0; i < 7; i++) {
      const isTO = i === 6; // lower turnovers wins
      if (isTO ? a.cnt[i]! < b.cnt[i]! : a.cnt[i]! > b.cnt[i]!) { wins[i]!++; won++; }
    }
    if (a.fg > b.fg) { wins[7]!++; won++; }
    if (a.ft > b.ft) { wins[8]!++; won++; }
    dist[won]!++;
    if (won >= 5) weekWins++;
  }
  const categories = Object.fromEntries(CAT_ORDER.map((c, i) => [c, wins[i]! / weeks])) as CategoryWins;
  return { weeks, categories, weekWin: weekWins / weeks, distribution: dist.map((x) => x / weeks) };
}

export interface DraftablePlayer { averages: SeasonAverages; team?: string; value: number }

/**
 * Typical opponents: simulated snake drafts of the best teams x rosterSpots players (every pick one of the best few
 * remaining, as in the benchmark), each team's week totalled with `gamesFor(team)` and the best `slots` as its lineup.
 * Positions are ignored. A modelling choice, not a fact about any real league.
 */
export function typicalOpponents(
  players: DraftablePlayer[],
  settings: { teams: number; rosterSpots: number },
  slots: number,
  gamesFor: (team: string | undefined) => number,
  opts: { leagues?: number; seed?: number; pickWeights?: number[] } = {},
): WeeklyTotals[] {
  const { teams, rosterSpots } = settings;
  const poolSize = teams * rosterSpots;
  const pool = [...players].sort((a, b) => b.value - a.value).slice(0, poolSize);
  if (pool.length < poolSize) throw new Error(`typicalOpponents: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32((opts.seed ?? 1) + 7919);
  const weights = opts.pickWeights ?? DEFAULT_PICK_WEIGHTS;
  const out: WeeklyTotals[] = [];
  for (let l = 0; l < (opts.leagues ?? 300); l++) {
    const remaining = pool.slice();
    const rosters: DraftablePlayer[][] = Array.from({ length: teams }, () => []);
    for (let round = 0; round < rosterSpots; round++)
      for (let k = 0; k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k;
        rosters[t]!.push(remaining.splice(pickIndex(remaining.length, weights, rand), 1)[0]!);
      }
    for (const r of rosters)
      out.push(weeklyTotals(r.map((p) => ({ averages: p.averages, games: gamesFor(p.team), value: p.value })), slots));
  }
  return out;
}

/** Monday (YYYY-MM-DD) of the week containing an ISO date or timestamp. Weeks run Monday to Sunday. */
export function mondayOf(isoDate: string): string {
  const d = new Date(isoDate.slice(0, 10) + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
