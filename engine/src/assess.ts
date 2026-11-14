import { categoryZ } from "./fantasyValue";
import { estimateAverages, GAMES_CAP, RECENCY_WEIGHTS } from "./history";
import type { Benchmark } from "./simulate";
import {
  CATEGORIES, type Band, type Category, type Confidence, type LeagueBaselines, type PlayerHistory,
} from "./types";
import { ENGINE_VERSION } from "./fantasyValue";

/** Percentile cutoffs for the bands (a design default). */
export interface Cutoffs { elite: number; strong: number; neutral: number }
export const DEFAULT_CUTOFFS: Cutoffs = { elite: 85, strong: 60, neutral: 40 };

export function bandFor(percentile: number, cut: Cutoffs = DEFAULT_CUTOFFS): Band {
  if (percentile >= cut.elite) return "elite";
  if (percentile >= cut.strong) return "strong";
  if (percentile >= cut.neutral) return "neutral";
  return "weak";
}

/** Share of the benchmark below `x` (ties count half), 0 to 100. `sortedAsc` must be ascending. */
export function percentileOf(sortedAsc: number[], x: number): number {
  let below = 0, equal = 0;
  for (const v of sortedAsc) { if (v < x) below++; else if (v === x) equal++; else break; }
  return ((below + 0.5 * equal) / sortedAsc.length) * 100;
}

export interface RosterPlayer {
  name: string;
  /** "IL" players are not counted. Default "active". */
  status?: "active" | "IL";
  history: PlayerHistory;
}
export interface PlayerAssessment {
  name: string;
  status: "active" | "IL";
  counted: boolean;
  confidence: Confidence;
  effectiveGames: number;
  seasonsUsed: string[];
  z: Record<Category, number> | null;
  note: string;
}
export interface CategoryAssessment {
  total: number;
  percentile: number;
  band: Band;
  /** What simulated teams look like in this category. */
  benchmark: { p15: number; median: number; p85: number };
}
export interface TeamAssessment {
  categories: Record<Category, CategoryAssessment>;
  players: PlayerAssessment[];
  /** Everything the result rests on, in plain words (the "receipts"). */
  assumptions: string[];
  engine_version: string;
}

const at = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

/**
 * Where a roster stands in each category versus the simulated league.
 * IL players are not counted. A roster slot with no usable data counts as an average rostered player
 * (the mean of the simulated pool in each category) and is labelled as such. Punt detection is NOT included yet.
 */
export function assessTeam(
  roster: RosterPlayer[],
  baseline: LeagueBaselines,
  benchmark: Benchmark,
  opts: { reference: string; cutoffs?: Cutoffs },
): TeamAssessment {
  const cut = opts.cutoffs ?? DEFAULT_CUTOFFS;
  const spots = benchmark.settings.rosterSpots;
  const zero = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const rows = roster.map((r) => {
    const est = estimateAverages(r.history, opts.reference);
    const z = est.averages ? categoryZ(est.averages, baseline) : null;
    const status = r.status ?? "active";
    const value = z ? CATEGORIES.reduce((s, c) => s + z[c], 0) : CATEGORIES.reduce((s, c) => s + benchmark.poolMean[c], 0);
    return { r, est, z, status, value };
  });
  const actives = rows.filter((x) => x.status === "active").sort((a, b) => b.value - a.value);
  const counted = new Set(actives.slice(0, spots));
  const assumptions: string[] = [];
  const players: PlayerAssessment[] = rows.map((x) => {
    let note = "";
    if (x.status === "IL") note = "On IL: not counted.";
    else if (!counted.has(x)) note = "More players than roster spots: not counted.";
    else if (x.est.confidence === "none") note = "No NBA data (rookie or no recent games): counted as an average rostered player.";
    else if (x.est.confidence === "low") note = `Small sample (${x.est.effectiveGames.toFixed(0)} effective games): treat with care.`;
    else if (!x.est.seasonsUsed.includes(opts.reference)) note = `Estimated from ${x.est.seasonsUsed.join(", ")}; he did not play ${opts.reference}.`;
    return {
      name: x.r.name, status: x.status, counted: x.status === "active" && counted.has(x),
      confidence: x.est.confidence, effectiveGames: x.est.effectiveGames, seasonsUsed: x.est.seasonsUsed, z: x.z, note,
    };
  });
  const sums = { ...zero };
  for (const x of actives.slice(0, spots)) for (const c of CATEGORIES) sums[c] += x.z ? x.z[c] : benchmark.poolMean[c];
  const empty = spots - Math.min(spots, actives.length);
  for (let i = 0; i < empty; i++) for (const c of CATEGORIES) sums[c] += benchmark.poolMean[c];
  if (empty > 0) assumptions.push(`${empty} empty roster slot(s) counted as an average rostered player.`);
  const noData = players.filter((p) => p.counted && p.confidence === "none").length;
  if (noData > 0) assumptions.push(`${noData} player(s) with no NBA data counted as an average rostered player.`);
  assumptions.push(
    `Players are estimated from their last three seasons, weighted by recency (${RECENCY_WEIGHTS.join(" / ")}) and games played (capped at ${GAMES_CAP} per season). Aging and role changes are not modelled.`,
    `Benchmark: ${benchmark.settings.teams} teams x ${spots} roster spots, ${benchmark.leagues} simulated snake drafts, each pick one of the best ${benchmark.pickWeights.length} remaining. Positions are ignored.`,
    "Every counted player's production is summed; daily lineup limits are not modelled.",
    `Bands by percentile among simulated teams: elite >= ${cut.elite}, strong >= ${cut.strong}, neutral >= ${cut.neutral}, otherwise weak.`,
  );
  const categories = {} as Record<Category, CategoryAssessment>;
  for (const c of CATEGORIES) {
    const b = benchmark.teamSums[c];
    const percentile = percentileOf(b, sums[c]);
    categories[c] = { total: sums[c], percentile, band: bandFor(percentile, cut), benchmark: { p15: at(b, 15), median: at(b, 50), p85: at(b, 85) } };
  }
  return { categories, players, assumptions, engine_version: ENGINE_VERSION };
}
