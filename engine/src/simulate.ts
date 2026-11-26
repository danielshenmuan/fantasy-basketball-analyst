import { CATEGORIES, type Category, type LeagueSettings } from "./types";

/** A draftable player: his category scores (higher = better) and their sum. */
export interface SimPlayer {
  id: number | string;
  z: Record<Category, number>;
  total: number;
  /**
   * Made and attempted shots per game. When every player has them, FG% and FT% are ranked by the team's rate (made / attempted, the
   * matchup's footing) instead of by the sum of attempt-weighted impact scores (issue #24).
   */
  shots?: Shots;
}
export interface Shots { fgm: number; fga: number; ftm: number; fta: number }
/** The two rate categories and the shots behind each. */
export const RATE_CATEGORIES = [["FG%", "fgm", "fga"], ["FT%", "ftm", "fta"]] as const;
export interface SimOptions {
  /** Number of simulated leagues. */
  leagues?: number;
  seed?: number;
  /** Chance of taking the 1st, 2nd, ... best remaining player at each pick. */
  pickWeights?: number[];
  /** Players who count per team: each simulated team's best `lineupSlots` by total score. Default: all roster spots. */
  lineupSlots?: number;
}
/** Take the best remaining player 45% of the time, the 2nd 25%, 3rd 15%, 4th 10%, 5th 5%. */
export const DEFAULT_PICK_WEIGHTS = [0.45, 0.25, 0.15, 0.1, 0.05];

export interface Benchmark {
  settings: LeagueSettings;
  leagues: number;
  pickWeights: number[];
  /** Players counted per team (the best by total score); the rest are bench. */
  lineupSlots: number;
  /** Every simulated team's total in each category, sorted ascending. */
  teamSums: Record<Category, number[]>;
  /** The average drafted player's score in each category: what an unknown or missing player is assumed to be. */
  poolMean: Record<Category, number>;
  /** True when teamSums for FG% and FT% are team rates (made / attempted), not sums of impact scores. */
  ratesAsRates: boolean;
  /** The average drafted player's made and attempted shots per game (what an unknown or missing player is assumed to shoot). Set with ratesAsRates. */
  poolMeanShots?: Shots;
}

/** Small seedable PRNG so a benchmark is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickIndex(n: number, weights: number[], rand: () => number): number {
  const k = Math.min(n, weights.length);
  let total = 0;
  for (let i = 0; i < k; i++) total += weights[i]!;
  let r = rand() * total;
  for (let i = 0; i < k; i++) {
    r -= weights[i]!;
    if (r <= 0) return i;
  }
  return k - 1;
}

/**
 * The benchmark a roster is compared with: many simulated leagues, each a snake draft of the best
 * (teams x rosterSpots) players, where every pick is one of the best few remaining, not always the best.
 * Positions are ignored. The draft mechanics are a modelling choice, not a fact about any real league.
 */
export function simulateBenchmark(players: SimPlayer[], settings: LeagueSettings, opts: SimOptions = {}): Benchmark {
  const { teams, rosterSpots } = settings;
  const leagues = opts.leagues ?? 500;
  const weights = opts.pickWeights ?? DEFAULT_PICK_WEIGHTS;
  const poolSize = teams * rosterSpots;
  const lineupSlots = Math.max(1, Math.min(rosterSpots, opts.lineupSlots ?? rosterSpots));
  const pool = [...players].sort((a, b) => b.total - a.total).slice(0, poolSize);
  if (pool.length < poolSize) throw new Error(`simulateBenchmark: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32(opts.seed ?? 1);
  const sums = Object.fromEntries(CATEGORIES.map((c) => [c, [] as number[]])) as Record<Category, number[]>;
  const ratesAsRates = pool.every((p) => p.shots !== undefined);
  for (let l = 0; l < leagues; l++) {
    const remaining = pool.slice();
    const team: SimPlayer[][] = Array.from({ length: teams }, () => []);
    for (let round = 0; round < rosterSpots; round++) {
      for (let k = 0; k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k; // snake order
        const [p] = remaining.splice(pickIndex(remaining.length, weights, rand), 1);
        team[t]!.push(p!);
      }
    }
    // Only the best `lineupSlots` by total score count, as in the weekly matchup.
    for (const t of team) {
      const lineup = t.sort((a, b) => b.total - a.total).slice(0, lineupSlots);
      for (const c of CATEGORIES) sums[c].push(lineup.reduce((s, p) => s + p.z[c], 0));
      if (ratesAsRates) for (const [c, made, att] of RATE_CATEGORIES) {
        const a = lineup.reduce((s, p) => s + p.shots![att], 0);
        sums[c][sums[c].length - 1] = a > 0 ? lineup.reduce((s, p) => s + p.shots![made], 0) / a : 0;
      }
    }
  }
  for (const c of CATEGORIES) sums[c].sort((a, b) => a - b);
  const poolMean = Object.fromEntries(CATEGORIES.map((c) => [c, pool.reduce((t, p) => t + p.z[c], 0) / pool.length])) as Record<Category, number>;
  const mean = (k: keyof Shots) => pool.reduce((t, p) => t + p.shots![k], 0) / pool.length;
  return {
    settings, leagues, pickWeights: weights, lineupSlots, teamSums: sums, poolMean, ratesAsRates,
    ...(ratesAsRates ? { poolMeanShots: { fgm: mean("fgm"), fga: mean("fga"), ftm: mean("ftm"), fta: mean("fta") } } : {}),
  };
}
