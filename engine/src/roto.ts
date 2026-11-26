import { categoryParts, zeroBase, isLowerCategory, categoryValue, type BaseKey, type BaseTotals, type PlayerBase } from "./anycat";
import { LUCK_STATS } from "./lucktable";
import { LUCK_REFERENCE_SLOTS } from "./matchup";
import { ROTO_GAMES_K, ROTO_GAMES_SD, ROTO_LEAGUE_RATE, ROTO_LUCK_AB, ROTO_LUCK_CORRELATION } from "./rotoluck";
import { mulberry32 } from "./simulate";

/**
 * Roto (ADR 0003). No weekly winner: every team is ranked in every category on season totals, a rank pays points (best of N
 * teams = N, worst = 1), tied teams split the points evenly, most points wins. The model projects each team's final totals as
 * banked totals + sum of per-game averages x games the player is expected to play, then adds measured season-long luck.
 */

/** Points for each team in one category: best = N, worst = 1, ties share the points of the places they cover (average rank). */
export function rankPoints(values: number[], lower: boolean): number[] {
  const better = (a: number, b: number) => (lower ? a < b : a > b);
  const eps = 1e-9;
  return values.map((v) => {
    let worse = 0, equal = 0;
    for (const w of values) {
      if (Math.abs(w - v) <= eps * Math.max(1, Math.abs(v))) equal++;
      else if (better(v, w)) worse++;
    }
    // `worse` teams are beaten, `equal` (including itself) tie: they cover places worse+1 .. worse+equal.
    return worse + (equal + 1) / 2;
  });
}

/** Roto points: `values[c][t]` is team t's total in category c. Returns each team's points per category and in all. */
export function rotoPoints(values: number[][], lower: boolean[]): { total: number[]; byCategory: number[][] } {
  const byCategory = values.map((v, c) => rankPoints(v, lower[c]!));
  const teams = values[0]?.length ?? 0;
  const total = Array.from({ length: teams }, (_, t) => byCategory.reduce((s, row) => s + row[t]!, 0));
  return { total, byCategory };
}

// ---- games -------------------------------------------------------------------------------------------------------------

const interp = (table: readonly (readonly [number, number])[], x: number): number => {
  if (x <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!, [x0, y0] = table[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return table[table.length - 1]![1];
};
/** Weight of this season's per-game averages against the prior seasons' estimate: games / (games + K). K chosen in the back-test (docs/roto-method.md). */
export const ROTO_CURRENT_K = 30;

/** The measured league rate can be negative very late in the year (rest, short samples); it is floored here. */
const MIN_LEAGUE_RATE = 0.3;

/**
 * Share of his team's remaining games a player is expected to play: his games so far shrunk toward the league rate for the
 * point in the season (an assumption measured on 2025-26, calibrated in the back-test, labelled in the output).
 */
export function expectedShare(gamesPlayed: number, teamGamesSoFar: number, teamGamesLeft: number): number {
  const total = teamGamesSoFar + teamGamesLeft;
  const frac = total > 0 ? teamGamesLeft / total : 1;
  const rate = Math.max(MIN_LEAGUE_RATE, interp(ROTO_LEAGUE_RATE, frac));
  const s = (gamesPlayed + ROTO_GAMES_K * rate) / (Math.max(0, teamGamesSoFar) + ROTO_GAMES_K);
  return Math.min(1, Math.max(0, s));
}
/** Spread (standard deviation) of the games a player really plays around the expectation, given his team's games left. */
export const gamesSd = (teamGamesLeft: number): number => (teamGamesLeft > 0 ? Math.sqrt(ROTO_GAMES_SD.a * teamGamesLeft + ROTO_GAMES_SD.b * teamGamesLeft ** 2) : 0);

// ---- model -------------------------------------------------------------------------------------------------------------

export interface RotoPlayer {
  id: number;
  /** Per-game base stats. */
  base: PlayerBase;
  /** Games his team has left that he could play (a known injury window already taken out). */
  teamGamesLeft: number;
  /** Expected share of those games he plays (see expectedShare). */
  expShare: number;
}
/** Banked season totals of one category: `num` alone for a counting category, `num` and `den` for a ratio (FG% = made / attempted). */
export interface RotoBanked { [category: string]: { num: number; den?: number } }
export interface RotoTeam { name: string; banked: RotoBanked; players: RotoPlayer[] }
export interface RotoOptions { sims?: number; seed?: number; /** false: no luck at all (every number is the plain projection). */ luck?: boolean }
export interface RotoTeamResult {
  name: string;
  expectedPoints: number;
  /** Mean place (1 = first). */
  expectedPlace: number;
  /** place[p] = chance of finishing in place p+1 (tied teams share the places they cover). */
  place: number[];
  /** Expected roto points in each category, in the order of `codes`. */
  categoryPoints: number[];
  /** Mean projected final value in each category. */
  finalValues: number[];
}
export interface RotoResult { sims: number; codes: string[]; teams: RotoTeamResult[] }

const hashInts = (...xs: number[]): number => {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
};
const gaussian = (rand: () => number): number => {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};
const idKey = (id: number): number => Math.floor(id * 1000003);

function cholesky(m: readonly (readonly number[])[]): number[][] {
  const n = m.length;
  const L = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = m[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) { if (s <= 0) throw new Error("ROTO_LUCK_CORRELATION is not positive definite"); L[i]![j] = Math.sqrt(s); }
      else L[i]![j] = s / L[j]![j]!;
    }
  return L;
}
const CHOL = cholesky(ROTO_LUCK_CORRELATION);
const BASE_KEYS = Object.keys(zeroBase()) as BaseKey[];

export interface RotoSim {
  codes: string[];
  /** Score the league. `overrides` replaces a team (by index) with another roster; everything else, including every random draw, stays the same. */
  evaluate(overrides?: Map<number, RotoTeam>): RotoResult;
}

/** Prepare a simulation of the rest of the season; `evaluate` can then be called with changed rosters at little cost. */
export function prepareRoto(teams: RotoTeam[], codes: string[], opts: RotoOptions = {}): RotoSim {
  if (teams.length < 2) throw new Error("a roto league needs at least 2 teams");
  const luck = opts.luck ?? true;
  const sims = luck ? (opts.sims ?? 3000) : 1;
  const seed = opts.seed ?? 1;
  const lower = codes.map((c) => isLowerCategory(c));
  const C = codes.length;

  /** One team's final value in every category for simulation `s`. */
  function row(team: RotoTeam, s: number, ti: number): number[] {
    const rest = zeroBase();
    let played = 0, n = 0;
    for (const p of team.players) {
      const G = p.teamGamesLeft, E = G * p.expShare;
      const games = luck && G > 0 ? Math.min(G, Math.max(0, E + gamesSd(G) * gaussian(mulberry32(hashInts(seed, s, 7, idKey(p.id))))) ) : E;
      for (const k of BASE_KEYS) rest[k] += p.base[k] * games;
      if (G > 0) { played += games; n++; }
    }
    if (luck && n > 0) {
      const rng = mulberry32(hashInts(seed, s, 11, ti));
      const z = LUCK_STATS.map(() => gaussian(rng));
      const perGame = Math.max(1, played / n);
      const scale = Math.sqrt(LUCK_REFERENCE_SLOTS / n);
      LUCK_STATS.forEach((k, i) => {
        const c = CHOL[i]!.reduce((sum, v, j) => sum + v * z[j]!, 0);
        const ab = ROTO_LUCK_AB[k]!;
        rest[k] = Math.max(0, rest[k] * (1 + Math.sqrt(ab.a * ab.a / perGame + ab.b * ab.b) * scale * c));
      });
      rest.dd = Math.max(0, rest.dd + Math.sqrt(rest.dd) * gaussian(rng));
      rest.td = Math.max(0, rest.td + Math.sqrt(rest.td) * gaussian(rng));
    }
    return codes.map((code) => {
      const b = team.banked[code] ?? { num: 0 };
      const part = categoryParts(code, rest as BaseTotals);
      if (part.den === undefined) return b.num + part.num;
      const den = (b.den ?? 0) + part.den;
      return den > 0 ? (b.num + part.num) / den : 0;
    });
  }

  const cache = teams.map((t, ti) => Array.from({ length: sims }, (_, s) => row(t, s, ti)));
  const T = teams.length;
  return {
    codes,
    evaluate(overrides) {
      const rows = teams.map((_, ti) => (overrides?.has(ti) ? Array.from({ length: sims }, (_, s) => row(overrides.get(ti)!, s, ti)) : cache[ti]!));
      const points = Array<number>(T).fill(0), place = Array.from({ length: T }, () => Array<number>(T).fill(0));
      const catPts = Array.from({ length: T }, () => Array<number>(C).fill(0)), finals = Array.from({ length: T }, () => Array<number>(C).fill(0));
      for (let s = 0; s < sims; s++) {
        const total = Array<number>(T).fill(0);
        for (let c = 0; c < C; c++) {
          const vals = rows.map((r) => r[s]![c]!);
          const rp = rankPoints(vals, lower[c]!);
          for (let t = 0; t < T; t++) { total[t]! += rp[t]!; catPts[t]![c]! += rp[t]!; finals[t]![c]! += vals[t]!; }
        }
        for (let t = 0; t < T; t++) {
          points[t]! += total[t]!;
          let above = 0, equal = 0;
          for (let u = 0; u < T; u++) { if (Math.abs(total[u]! - total[t]!) < 1e-9) equal++; else if (total[u]! > total[t]!) above++; }
          for (let p = above; p < above + equal; p++) place[t]![p]! += 1 / equal;
        }
      }
      return {
        sims, codes,
        teams: teams.map((t, ti) => {
          const name = (overrides?.get(ti) ?? t).name;
          const pl = place[ti]!.map((x) => x / sims);
          return {
            name, expectedPoints: points[ti]! / sims, expectedPlace: pl.reduce((s, x, p) => s + x * (p + 1), 0),
            place: pl, categoryPoints: catPts[ti]!.map((x) => x / sims), finalValues: finals[ti]!.map((x) => x / sims),
          };
        }),
      };
    },
  };
}

/** One-shot simulation of the rest of the season. */
export function simulateRoto(teams: RotoTeam[], codes: string[], opts: RotoOptions = {}): RotoResult {
  return prepareRoto(teams, codes, opts).evaluate();
}

export { categoryValue };
