import { CATEGORIES, type Category, type LeagueSettings } from "./types";

/** A draftable player: his category scores (higher = better) and their sum. */
export interface SimPlayer {
  id: number | string;
  z: Record<Category, number>;
  total: number;
}
export interface SimOptions {
  /** Number of simulated leagues. */
  leagues?: number;
  seed?: number;
  /** Chance of taking the 1st, 2nd, ... best remaining player at each pick. */
  pickWeights?: number[];
}
/** Take the best remaining player 45% of the time, the 2nd 25%, 3rd 15%, 4th 10%, 5th 5%. */
export const DEFAULT_PICK_WEIGHTS = [0.45, 0.25, 0.15, 0.1, 0.05];

export interface Benchmark {
  settings: LeagueSettings;
  leagues: number;
  pickWeights: number[];
  /** Every simulated team's total in each category, sorted ascending. */
  teamSums: Record<Category, number[]>;
  /** The average drafted player's score in each category: what an unknown or missing player is assumed to be. */
  poolMean: Record<Category, number>;
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
  const pool = [...players].sort((a, b) => b.total - a.total).slice(0, poolSize);
  if (pool.length < poolSize) throw new Error(`simulateBenchmark: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32(opts.seed ?? 1);
  const sums = Object.fromEntries(CATEGORIES.map((c) => [c, [] as number[]])) as Record<Category, number[]>;
  for (let l = 0; l < leagues; l++) {
    const remaining = pool.slice();
    const team = Array.from({ length: teams }, () => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>);
    for (let round = 0; round < rosterSpots; round++) {
      for (let k = 0; k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k; // snake order
        const [p] = remaining.splice(pickIndex(remaining.length, weights, rand), 1);
        for (const c of CATEGORIES) team[t]![c] += p!.z[c];
      }
    }
    for (const t of team) for (const c of CATEGORIES) sums[c].push(t[c]);
  }
  for (const c of CATEGORIES) sums[c].sort((a, b) => a - b);
  const poolMean = Object.fromEntries(CATEGORIES.map((c) => [c, pool.reduce((t, p) => t + p.z[c], 0) / pool.length])) as Record<Category, number>;
  return { settings, leagues, pickWeights: weights, teamSums: sums, poolMean };
}
