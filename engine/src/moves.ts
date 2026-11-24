import { simulateWeeks, weeklyTotals, type WeeklyTotals } from "./matchup";
import { CATEGORIES, type Category, type SeasonAverages } from "./types";

/**
 * Moves are scored by what they do to the weekly win chance (D12): swap the players, re-run the same simulated weeks
 * (same seed, so the random draws are identical and only the roster differs), compare. No judgment: every number is a
 * difference between two simulations.
 */

/** A player as the simulation needs him. */
export interface Entry {
  id: number; name: string; averages: SeasonAverages; team?: string; value: number;
  /** How much history the estimate rests on (from estimateAverages). */
  confidence?: "high" | "medium" | "low" | "none";
}

/** One scheduled week: games per team and the opponents the roster is simulated against. */
export interface WeekEnv { start: string | null; gamesFor: (team?: string) => number; opponents: WeeklyTotals[] }

export interface MoveEnv {
  /** Players who count each week. */
  slots: number;
  /** Weeks averaged together (this week, and next, ...). */
  weeks: WeekEnv[];
  simWeeks: number;
  seed: number;
  /** Fills a lineup spot nobody fills: the last player a league of this size would draft. */
  replacement: Entry;
}

export interface Score { weekWin: number; categories: Record<Category, number> }

/** Weekly win chance and per-category win chance of a roster, averaged over the environment's weeks. */
export function scoreRoster(roster: Entry[], env: MoveEnv, simWeeks = env.simWeeks): Score {
  const pad = Math.max(0, env.slots - roster.length);
  const list = pad > 0 ? [...roster, ...Array<Entry>(pad).fill(env.replacement)] : roster;
  let week = 0;
  const cats = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const w of env.weeks) {
    const totals = weeklyTotals(list.map((p) => ({ averages: p.averages, games: w.gamesFor(p.team), value: p.value })), env.slots);
    const r = simulateWeeks(totals, w.opponents, { weeks: simWeeks, seed: env.seed, slots: env.slots });
    week += r.weekWin;
    for (const c of CATEGORIES) cats[c] += r.categories[c];
  }
  const n = env.weeks.length;
  for (const c of CATEGORIES) cats[c] /= n;
  return { weekWin: week / n, categories: cats };
}

const diff = (a: Score, b: Score): Record<Category, number> =>
  Object.fromEntries(CATEGORIES.map((c) => [c, a.categories[c] - b.categories[c]])) as Record<Category, number>;

export interface Move {
  add: Entry; drop: Entry; after: Score;
  /** Weekly win chance gained against the roster as it stands. */
  delta: number;
  /** What dropping that player alone would do (nobody added; his lineup spot goes to the next player). */
  dropOnlyDelta: number;
  /** delta minus dropOnlyDelta: what the added player contributes. Only moves where this is above zero are ranked. */
  addDelta: number;
  categoryDelta: Record<Category, number>;
}
export interface Unranked { add: Entry; reason: "bench-only" | "no-gain-from-add" }

/** Does `entry` count in the lineup of `roster` (padded with the replacement player like scoreRoster)? Same pick as weeklyTotals. */
export function entersLineup(roster: Entry[], entry: Entry, env: MoveEnv): boolean {
  const pad = Math.max(0, env.slots - roster.length);
  const list = pad > 0 ? [...roster, ...Array<Entry>(pad).fill(env.replacement)] : roster;
  return [...list].sort((a, b) => b.value - a.value).slice(0, env.slots).includes(entry);
}

/**
 * Best add for each candidate (with the drop that serves it best), ranked by what the ADDED player contributes beyond
 * the drop itself. A candidate who would not enter the lineup, or whose gain is only the drop, is not ranked: its
 * numbers would be the effect of removing a player, identical for every such candidate.
 * Rank with a quick pass, then re-score the top few at full length so the reported numbers are steady.
 */
export function rankWaiverMoves(
  roster: Entry[], candidates: Entry[], env: MoveEnv,
  opts: { droppable?: Entry[]; top?: number; quickWeeks?: number } = {},
): { baseline: Score; moves: Move[]; unranked: Unranked[] } {
  const droppable = opts.droppable ?? roster;
  const top = opts.top ?? 8;
  const quick = opts.quickWeeks ?? Math.min(env.simWeeks, 3000);
  const base = scoreRoster(roster, env, quick);
  const without = (drop: Entry) => roster.filter((p) => p.id !== drop.id);
  const unranked: Unranked[] = [];
  const best: { add: Entry; drop: Entry; win: number }[] = [];
  for (const add of candidates) {
    let pick: { add: Entry; drop: Entry; win: number } | null = null;
    for (const drop of droppable) {
      const next = without(drop).concat(add);
      if (!entersLineup(next, add, env)) continue;
      const win = scoreRoster(next, env, quick).weekWin;
      if (!pick || win > pick.win || (win === pick.win && drop.value < pick.drop.value)) pick = { add, drop, win };
    }
    if (pick) best.push(pick);
    else unranked.push({ add, reason: "bench-only" });
  }
  best.sort((a, b) => b.win - a.win);
  const baseline = scoreRoster(roster, env);
  const dropOnly = new Map<number, number>();
  const moves: Move[] = [];
  for (const { add, drop } of best.slice(0, top * 2)) {
    if (!dropOnly.has(drop.id)) dropOnly.set(drop.id, scoreRoster(without(drop), env).weekWin);
    const after = scoreRoster(without(drop).concat(add), env);
    const addDelta = after.weekWin - dropOnly.get(drop.id)!;
    if (addDelta <= 0) { unranked.push({ add, reason: "no-gain-from-add" }); continue; }
    moves.push({ add, drop, after, delta: after.weekWin - baseline.weekWin, dropOnlyDelta: dropOnly.get(drop.id)! - baseline.weekWin, addDelta, categoryDelta: diff(after, baseline) });
  }
  moves.sort((a, b) => b.addDelta - a.addDelta);
  return { baseline, moves: moves.slice(0, top), unranked };
}

export interface TradeResult { before: Score; after: Score; delta: number; categoryDelta: Record<Category, number> }

/** What a trade does to one side: remove `give`, add `get`. */
export function evaluateTrade(roster: Entry[], give: Entry[], get: Entry[], env: MoveEnv): TradeResult {
  const giveIds = new Set(give.map((p) => p.id));
  const before = scoreRoster(roster, env);
  const after = scoreRoster(roster.filter((p) => !giveIds.has(p.id)).concat(get), env);
  return { before, after, delta: after.weekWin - before.weekWin, categoryDelta: diff(after, before) };
}

export interface Offer { give: Entry; get: Entry; mine: TradeResult; theirs: TradeResult }

/**
 * One-for-one offers between two rosters that raise the user's weekly win chance without lowering the other
 * team's (by more than `minTheirDelta`, default: not at all), best for the user first. A model of the two rosters only:
 * it knows nothing about what the other owner values.
 */
export function searchTrades(
  mine: Entry[], theirs: Entry[], env: MoveEnv, opts: { top?: number; minTheirDelta?: number; quickWeeks?: number } = {},
): Offer[] {
  const quick = opts.quickWeeks ?? Math.min(env.simWeeks, 2000);
  const minTheirs = opts.minTheirDelta ?? 0;
  const baseMine = scoreRoster(mine, env, quick).weekWin, baseTheirs = scoreRoster(theirs, env, quick).weekWin;
  const found: { give: Entry; get: Entry; dm: number; dt: number }[] = [];
  for (const give of mine)
    for (const get of theirs) {
      const dm = scoreRoster(mine.filter((p) => p.id !== give.id).concat(get), env, quick).weekWin - baseMine;
      if (dm <= 0) continue;
      const dt = scoreRoster(theirs.filter((p) => p.id !== get.id).concat(give), env, quick).weekWin - baseTheirs;
      if (dt >= minTheirs) found.push({ give, get, dm, dt });
    }
  found.sort((a, b) => b.dm - a.dm);
  return found.slice(0, opts.top ?? 5).map(({ give, get }) => ({
    give, get, mine: evaluateTrade(mine, [give], [get], env), theirs: evaluateTrade(theirs, [get], [give], env),
  }));
}
