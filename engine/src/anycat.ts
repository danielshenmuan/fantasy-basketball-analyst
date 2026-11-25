import { LUCK_REFERENCE_SLOTS, luckScale, DEFAULT_WEEKS } from "./matchup";
import { BASE_LUCK_CORRELATION, BASE_LUCK_SHARE, LUCK_STATS, type LuckStat } from "./lucktable";
import { DEFAULT_PICK_WEIGHTS, mulberry32, pickIndex } from "./simulate";
import type { SeasonAverages } from "./types";

/**
 * Head-to-head leagues with any list of box-score categories (ADR 0001). The nine-category path in matchup.ts is left
 * untouched; this module handles every other category list with the same ideas: expected weekly total (per-game
 * average x games), measured week-to-week luck, count the categories won.
 *
 * Luck is modelled on BASE stats (made and attempted shots, rebounds by kind, assists, ...). A category is a function of
 * the base totals, so PTS, REB, FG%, A/T and the rest cannot disagree with their own parts.
 */

/** Stats per game a player is described by. Double- and triple-doubles are rates (share of games). */
export type BaseKey = LuckStat | "dd" | "td";
export type BaseTotals = Record<BaseKey, number>;
const ZERO = (): BaseTotals => ({
  minutes: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, fg3a: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, turnovers: 0, pf: 0, dd: 0, td: 0,
});
const BASE_KEYS = Object.keys(ZERO()) as BaseKey[];

type Lin = Partial<Record<BaseKey, number>>;
export interface CategoryDef {
  code: string;
  label: string;
  /** Lower total wins (turnovers, fouls). */
  lower?: boolean;
  /** The category's value is lin(num), or lin(num) / lin(den) for a ratio. */
  num: Lin;
  den?: Lin;
}
const def = (code: string, label: string, num: Lin, extra: Partial<CategoryDef> = {}): CategoryDef => ({ code, label, num, ...extra });
const REGISTRY: CategoryDef[] = [
  def("MIN", "Minutes played", { minutes: 1 }),
  def("FGM", "Field goals made", { fgm: 1 }),
  def("FGA", "Field goals attempted", { fga: 1 }),
  def("FG%", "Field goal percentage", { fgm: 1 }, { den: { fga: 1 } }),
  def("FTM", "Free throws made", { ftm: 1 }),
  def("FTA", "Free throws attempted", { fta: 1 }),
  def("FT%", "Free throw percentage", { ftm: 1 }, { den: { fta: 1 } }),
  def("3PM", "3-pointers made", { fg3m: 1 }),
  def("3PA", "3-pointers attempted", { fg3a: 1 }),
  def("3P%", "3-point percentage", { fg3m: 1 }, { den: { fg3a: 1 } }),
  def("PTS", "Points", { fgm: 2, fg3m: 1, ftm: 1 }),
  def("REB", "Rebounds", { oreb: 1, dreb: 1 }),
  def("OREB", "Offensive rebounds", { oreb: 1 }),
  def("DREB", "Defensive rebounds", { dreb: 1 }),
  def("AST", "Assists", { ast: 1 }),
  def("STL", "Steals", { stl: 1 }),
  def("BLK", "Blocks", { blk: 1 }),
  def("TO", "Turnovers", { turnovers: 1 }, { lower: true }),
  def("PF", "Personal fouls", { pf: 1 }, { lower: true }),
  def("A/T", "Assist to turnover ratio", { ast: 1 }, { den: { turnovers: 1 } }),
  def("DD", "Double-doubles", { dd: 1 }),
  def("TD", "Triple-doubles", { td: 1 }),
];
const BY_CODE = new Map(REGISTRY.map((d) => [d.code, d]));
export const SUPPORTED_CATEGORIES: readonly string[] = REGISTRY.map((d) => d.code);

/** Names hosts use, normalised (upper case, letters, digits, % and /), mapped to a category code. */
const ALIASES: Record<string, string> = {};
const alias = (code: string, ...names: string[]) => { for (const n of [code, ...names]) ALIASES[norm(n)] = code; };
function norm(s: string): string { return s.toUpperCase().replace(/[^A-Z0-9%/]/g, ""); }
alias("MIN", "Minutes", "Minutes Played");
alias("FGM", "Field Goals Made", "FG Made");
alias("FGA", "Field Goals Attempted", "FG Attempted");
alias("FG%", "Field Goal Percentage", "FG Pct");
alias("FTM", "Free Throws Made");
alias("FTA", "Free Throws Attempted");
alias("FT%", "Free Throw Percentage", "FT Pct");
alias("3PM", "3PTM", "3PT", "3-point Shots Made", "3-Pointers Made", "Three Pointers Made", "Threes", "3PTS");
alias("3PA", "3PTA", "3-point Shots Attempted", "3-Pointers Attempted");
alias("3P%", "3PT%", "3-point Percentage", "3-Point Field Goal Percentage");
alias("PTS", "Points", "Points Scored");
alias("REB", "Rebounds", "Total Rebounds");
alias("OREB", "Offensive Rebounds");
alias("DREB", "Defensive Rebounds");
alias("AST", "Assists");
alias("STL", "ST", "Steals");
alias("BLK", "BS", "Blocks", "Blocked Shots");
alias("TO", "TOV", "Turnovers");
alias("PF", "Fouls", "Personal Fouls");
alias("A/T", "AST/TO", "Assist/Turnover Ratio", "Assist to Turnover Ratio");
alias("DD", "Double Doubles", "Double-Doubles", "Double Double");
alias("TD", "Triple Doubles", "Triple-Doubles", "Triple Double");

/** Turn the names a host shows into category codes. Throws, naming every one it does not know. */
export function parseCategories(names: string[]): string[] {
  const unknown: string[] = [];
  const out: string[] = [];
  for (const n of names) {
    const code = ALIASES[norm(n)];
    if (!code) unknown.push(n);
    else if (!out.includes(code)) out.push(code);
  }
  if (unknown.length) throw new Error(`unsupported categories: ${unknown.join(", ")}. Supported: ${SUPPORTED_CATEGORIES.join(" ")}`);
  if (out.length < 2) throw new Error("a league needs at least 2 categories");
  return out;
}

export const STANDARD_NINE = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"] as const;
export const isStandardNine = (codes: string[]): boolean => codes.length === 9 && STANDARD_NINE.every((c) => codes.includes(c));

const lin = (c: Lin, t: BaseTotals): number => { let s = 0; for (const k of Object.keys(c) as BaseKey[]) s += c[k]! * t[k]; return s; };
const defOf = (code: string): CategoryDef => {
  const d = BY_CODE.get(code);
  if (!d) throw new Error(`unknown category ${code}`);
  return d;
};
/** True when a lower total wins the category (turnovers, fouls). */
export const isLowerCategory = (code: string): boolean => Boolean(defOf(code).lower);
/** The value of a category for a set of base totals. */
export function categoryValue(code: string, t: BaseTotals): number {
  const d = defOf(code);
  const n = lin(d.num, t);
  if (!d.den) return n;
  const m = lin(d.den, t);
  return m > 0 ? n / m : 0;
}
/** Base stats a list of categories needs. */
export function neededStats(codes: string[]): BaseKey[] {
  const s = new Set<BaseKey>();
  for (const c of codes) { const d = defOf(c); for (const k of Object.keys(d.num) as BaseKey[]) s.add(k); for (const k of Object.keys(d.den ?? {}) as BaseKey[]) s.add(k); }
  return [...s];
}

// ---- players ---------------------------------------------------------------------------------------------------

export type PlayerBase = BaseTotals;
/** A player's per-game base stats from his estimated averages. Throws when a needed stat is missing from the data. */
export function baseOf(a: SeasonAverages, needed: BaseKey[]): PlayerBase {
  const b = ZERO();
  const get: Record<BaseKey, number | undefined> = {
    minutes: a.min, fgm: a.fgm ?? a.fga * a.fg_pct, fga: a.fga, ftm: a.ftm ?? a.fta * a.ft_pct, fta: a.fta,
    fg3m: a.fg3m, fg3a: a.fg3a, oreb: a.oreb, dreb: a.dreb, ast: a.ast, stl: a.stl, blk: a.blk, turnovers: a.turnovers, pf: a.pf,
    dd: a.dd_rate, td: a.td_rate,
  };
  for (const k of BASE_KEYS) {
    const v = get[k];
    if (v === undefined && needed.includes(k)) throw new Error(`the data file has no ${k} yet (needed for this league's categories)`);
    b[k] = v ?? 0;
  }
  return b;
}

export interface CategoryBaseline { mean: number; std: number; ratio?: number }
export type Baseline = Record<string, CategoryBaseline>;
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdOf = (xs: number[], m: number) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) || 1;

/** League baseline for a category list from the rosterable pool (best `poolSize` by total minutes), as the nine-category one does. */
export function buildAnyBaseline(pool: { base: PlayerBase; gp: number; mpg: number }[], codes: string[], poolSize: number): Baseline {
  const top = [...pool].sort((a, b) => b.gp * b.mpg - a.gp * a.mpg).slice(0, poolSize);
  if (top.length === 0) throw new Error("buildAnyBaseline: no players");
  const out: Baseline = {};
  for (const c of codes) {
    const d = defOf(c);
    if (!d.den) {
      const xs = top.map((p) => lin(d.num, p.base)), m = avg(xs);
      out[c] = { mean: m, std: stdOf(xs, m) };
    } else {
      const num = top.reduce((s, p) => s + lin(d.num, p.base), 0), den = top.reduce((s, p) => s + lin(d.den!, p.base), 0);
      const r = den > 0 ? num / den : 0;
      const imp = top.map((p) => lin(d.num, p.base) - r * lin(d.den!, p.base));
      out[c] = { mean: 0, std: stdOf(imp, avg(imp)), ratio: r };
    }
  }
  return out;
}

/** A player's ranking value: the sum of his category scores, higher always better (lower-is-better categories flipped). */
export function anyValue(base: PlayerBase, codes: string[], bl: Baseline): number {
  let v = 0;
  for (const c of codes) {
    const d = defOf(c), b = bl[c]!;
    const z = d.den ? (lin(d.num, base) - b.ratio! * lin(d.den, base)) / b.std : (lin(d.num, base) - b.mean) / b.std;
    v += d.lower ? -z : z;
  }
  return v;
}

// ---- weekly totals -----------------------------------------------------------------------------------------------

export interface AnyPlayer { base: PlayerBase; games: number; value: number }
/** What one team produces in a week before luck: expected base totals, and per-game chances of a double- and triple-double. */
export interface AnyTotals { t: BaseTotals; ddGames: number[]; tdGames: number[] }

/** Chance list for `games` games at probability p: whole games plus a fractional last one that keeps the expectation. */
function chances(p: number, games: number, into: number[]): void {
  if (!(p > 0) || !(games > 0)) return;
  const n = Math.floor(games), frac = games - n;
  for (let i = 0; i < n; i++) into.push(p);
  if (frac > 1e-9) into.push(p * frac);
}

export function anyTotals(players: AnyPlayer[], slots: number): AnyTotals {
  const lineup = [...players].sort((a, b) => b.value - a.value).slice(0, slots);
  const t = ZERO();
  const ddGames: number[] = [], tdGames: number[] = [];
  for (const p of lineup) {
    for (const k of BASE_KEYS) t[k] += p.base[k] * p.games;
    chances(p.base.dd, p.games, ddGames);
    chances(p.base.td, p.games, tdGames);
  }
  return { t, ddGames, tdGames };
}

export function scaledAny(a: AnyTotals, k: number): AnyTotals {
  const t = ZERO();
  for (const key of BASE_KEYS) t[key] = a.t[key] * k;
  return { t, ddGames: a.ddGames.map((p) => p * k), tdGames: a.tdGames.map((p) => p * k) };
}

// ---- simulation --------------------------------------------------------------------------------------------------

function gaussianFrom(rand: () => number): () => number {
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
function choleskyOf(m: readonly (readonly number[])[]): number[][] {
  const n = m.length;
  const L = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = m[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (s <= 0) throw new Error("BASE_LUCK_CORRELATION is not positive definite");
        L[i]![j] = Math.sqrt(s);
      } else L[i]![j] = s / L[j]![j]!;
    }
  return L;
}
const LUCK_CHOL = choleskyOf(BASE_LUCK_CORRELATION);

/** One side's base totals after luck. Double- and triple-doubles are sampled game by game from each player's own rate. */
function anyOutcome(a: AnyTotals, luck: boolean, g: () => number, rand: () => number, scale: number, needDD: boolean, needTD: boolean, extra?: BaseTotals): BaseTotals {
  const t = { ...a.t };
  if (luck) {
    const z = LUCK_STATS.map(() => g());
    LUCK_STATS.forEach((k, i) => {
      const c = LUCK_CHOL[i]!.reduce((s, v, j) => s + v * z[j]!, 0);
      t[k] = Math.max(0, t[k] * (1 + BASE_LUCK_SHARE[k] * scale * c));
    });
    if (needDD) { let n = 0; for (const p of a.ddGames) if (rand() < p) n++; t.dd = n; }
    if (needTD) { let n = 0; for (const p of a.tdGames) if (rand() < p) n++; t.td = n; }
  }
  if (extra) for (const k of BASE_KEYS) t[k] += extra[k];
  return t;
}

/** A week already under way: what is banked, what is expected over the games left, and the part of the week left. */
export interface AnySide { banked: BaseTotals; remaining: AnyTotals; share: number }
export interface AnySimOptions {
  weeks?: number; seed?: number; luck?: boolean; slots?: number;
  progress?: { me: AnySide; opponent: AnySide };
}
export interface AnyResult {
  weeks: number;
  /** Share of simulated weeks in which you win each category outright. */
  categories: Record<string, number>;
  /** Share of weeks you win more categories than the opponent, tie it, or lose it. */
  weekWin: number; weekTie: number; weekLoss: number;
  /** distribution[k] = share of weeks you win exactly k categories. */
  distribution: number[];
}

export function simulateAny(me: AnyTotals, opponents: AnyTotals[], codes: string[], opts: AnySimOptions = {}): AnyResult {
  if (opponents.length === 0) throw new Error("simulateAny: no opponents");
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  const luck = opts.luck ?? true;
  const rand = mulberry32(opts.seed ?? 1);
  const g = gaussianFrom(rand);
  const scale = luckScale(opts.slots ?? LUCK_REFERENCE_SLOTS);
  const needDD = codes.includes("DD"), needTD = codes.includes("TD");
  const defs = codes.map(defOf);
  const wins = Array<number>(codes.length).fill(0);
  const dist = Array<number>(codes.length + 1).fill(0);
  let win = 0, tie = 0;
  const side = (a: AnyTotals, s: AnySide | undefined): BaseTotals =>
    s ? anyOutcome(s.remaining, luck && s.share > 0, g, rand, s.share > 0 ? scale / Math.sqrt(s.share) : scale, needDD, needTD, s.banked)
      : anyOutcome(a, luck, g, rand, scale, needDD, needTD);
  for (let w = 0; w < weeks; w++) {
    const opp = opponents[opponents.length === 1 ? 0 : Math.floor(rand() * opponents.length)]!;
    const a = side(me, opts.progress?.me), b = side(opp, opts.progress?.opponent);
    let won = 0, lost = 0;
    defs.forEach((d, i) => {
      const x = categoryValue(d.code, a), y = categoryValue(d.code, b);
      const better = d.lower ? x < y : x > y, worse = d.lower ? x > y : x < y;
      if (better) { wins[i]!++; won++; } else if (worse) lost++;
    });
    dist[won]!++;
    if (won > lost) win++; else if (won === lost) tie++;
  }
  return {
    weeks,
    categories: Object.fromEntries(codes.map((c, i) => [c, wins[i]! / weeks])),
    weekWin: win / weeks, weekTie: tie / weeks, weekLoss: (weeks - win - tie) / weeks,
    distribution: dist.map((x) => x / weeks),
  };
}

// ---- points leagues ----------------------------------------------------------------------------------------------

/** Stat weights by category code. A points league's score is the sum of weight x category total, so only counting categories qualify. */
export type Weights = Record<string, number>;

/** Missed shots are attempts minus makes, so a weight on one splits into a weight on each. */
const MISSED: Record<string, { att: string; made: string }> = {};
for (const [att, made, ...names] of [["FGA", "FGM", "Field goals missed", "Missed field goals", "FG missed", "FGMISS"], ["FTA", "FTM", "Free throws missed", "Missed free throws", "FT missed", "FTMISS"], ["3PA", "3PM", "3-pointers missed", "Missed 3-pointers", "3P missed", "3PMISS"]] as [string, string, ...string[]][])
  for (const n of names) MISSED[norm(n)] = { att: att!, made: made! };

/** Rare events we have no data for. A weight on one is left out of the model (their effect is about 0.4% of a week's score); the output says so. */
const UNTRACKED = new Set(["technical fouls", "flagrant fouls", "ejections", "quadruple doubles", "quadruple-doubles", "technical foul", "flagrant foul", "ejection", "quad doubles", "quad-doubles"].map((n) => norm(n)));
/** The names in a scoring list that parseWeights leaves out because we do not track them. */
export const untrackedScoring = (raw: Record<string, number>): string[] => Object.keys(raw).filter((n) => UNTRACKED.has(norm(n)));

/** Turn the stat names and weights a host shows into code weights. Throws, naming every stat it does not know or cannot weigh. */
export function parseWeights(raw: Record<string, number>): Weights {
  const unknown: string[] = [], ratios: string[] = [];
  const out: Weights = {};
  for (const [name, w] of Object.entries(raw)) {
    if (!Number.isFinite(w)) throw new Error(`scoring weight for ${name} must be a number`);
    if (UNTRACKED.has(norm(name))) continue;
    const missed = MISSED[norm(name)];
    if (missed) { out[missed.att] = (out[missed.att] ?? 0) + w; out[missed.made] = (out[missed.made] ?? 0) - w; continue; }
    const code = ALIASES[norm(name)];
    if (!code) { unknown.push(name); continue; }
    if (BY_CODE.get(code)!.den) { ratios.push(name); continue; }
    out[code] = (out[code] ?? 0) + w;
  }
  if (unknown.length) throw new Error(`unsupported scoring stats: ${unknown.join(", ")}. Supported: ${SUPPORTED_CATEGORIES.join(" ")}`);
  if (ratios.length) throw new Error(`a points league cannot weight a percentage or ratio (${ratios.join(", ")}): weight the made and attempted counts instead`);
  if (!Object.values(out).some((w) => w !== 0)) throw new Error("scoring needs at least one stat with a weight other than 0");
  return out;
}
/** Fantasy points for a set of base totals. */
export function pointsOf(w: Weights, t: BaseTotals): number {
  let s = 0;
  for (const c of Object.keys(w)) s += w[c]! * categoryValue(c, t);
  return s;
}

export interface PointsSide { banked: number; remaining: AnyTotals; share: number }
export interface PointsResult {
  weeks: number; weekWin: number; weekTie: number; weekLoss: number;
  /** Average simulated points for you and for the opponent(s), banked points included. */
  expectedMe: number; expectedOpponent: number;
}
/** Head-to-head points: the side with more points in the week wins. Luck as in `simulateAny`. */
export function simulatePoints(
  me: AnyTotals, opponents: AnyTotals[], w: Weights,
  opts: { weeks?: number; seed?: number; luck?: boolean; slots?: number; progress?: { me: PointsSide; opponent: PointsSide } } = {},
): PointsResult {
  if (opponents.length === 0) throw new Error("simulatePoints: no opponents");
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  const luck = opts.luck ?? true;
  const rand = mulberry32(opts.seed ?? 1);
  const g = gaussianFrom(rand);
  const scale = luckScale(opts.slots ?? LUCK_REFERENCE_SLOTS);
  const needDD = (w.DD ?? 0) !== 0, needTD = (w.TD ?? 0) !== 0;
  const side = (a: AnyTotals, s: PointsSide | undefined): number =>
    s ? s.banked + pointsOf(w, anyOutcome(s.remaining, luck && s.share > 0, g, rand, s.share > 0 ? scale / Math.sqrt(s.share) : scale, needDD, needTD))
      : pointsOf(w, anyOutcome(a, luck, g, rand, scale, needDD, needTD));
  let win = 0, tie = 0, sumMe = 0, sumOpp = 0;
  for (let k = 0; k < weeks; k++) {
    const opp = opponents[opponents.length === 1 ? 0 : Math.floor(rand() * opponents.length)]!;
    const a = side(me, opts.progress?.me), b = side(opp, opts.progress?.opponent);
    sumMe += a; sumOpp += b;
    if (a > b) win++; else if (a === b) tie++;
  }
  return { weeks, weekWin: win / weeks, weekTie: tie / weeks, weekLoss: (weeks - win - tie) / weeks, expectedMe: sumMe / weeks, expectedOpponent: sumOpp / weeks };
}

export interface AnyDraftable { base: PlayerBase; team?: string; value: number }
/** Typical opponents for a category list: simulated snake drafts as in `typicalOpponents`, ranked by the league's own category value. */
export function typicalAnyOpponents(
  players: AnyDraftable[], settings: { teams: number; rosterSpots: number }, slots: number,
  gamesFor: (team: string | undefined) => number, opts: { leagues?: number; seed?: number; pickWeights?: number[] } = {},
): AnyTotals[] {
  const { teams, rosterSpots } = settings;
  const poolSize = teams * rosterSpots;
  const pool = [...players].sort((a, b) => b.value - a.value).slice(0, poolSize);
  if (pool.length < poolSize) throw new Error(`typicalAnyOpponents: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32((opts.seed ?? 1) + 7919);
  const weights = opts.pickWeights ?? DEFAULT_PICK_WEIGHTS;
  const out: AnyTotals[] = [];
  for (let l = 0; l < (opts.leagues ?? 300); l++) {
    const remaining = pool.slice();
    const rosters: AnyDraftable[][] = Array.from({ length: teams }, () => []);
    for (let round = 0; round < rosterSpots; round++)
      for (let k = 0; k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k;
        rosters[t]!.push(remaining.splice(pickIndex(remaining.length, weights, rand), 1)[0]!);
      }
    for (const r of rosters) out.push(anyTotals(r.map((p) => ({ base: p.base, games: gamesFor(p.team), value: p.value })), slots));
  }
  return out;
}
