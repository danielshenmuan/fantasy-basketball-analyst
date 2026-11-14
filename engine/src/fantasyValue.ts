import {
  CATEGORIES,
  type Category,
  type CategoryValue,
  type FantasyValue,
  type FantasyValueOptions,
  type LeagueBaselines,
  type SeasonAverages,
} from "./types";

export const ENGINE_VERSION = "0.3.0"; // 0.3.0: weighted history, simulated benchmark, assessTeam; 0.2.0: TO sign, M2 baseline

/**
 * Default turnover weight for the league-agnostic headline Fantasy Value.
 * Design decision: Turnovers correlate 0.82 with assists and 0.80 with shot
 * attempts, so full weight mostly re-penalises usage. League-aware calls pass the league's real weights.
 */
export const DEFAULT_TO_WEIGHT = 0.2;

/** Divide, returning 0 instead of NaN/Infinity when the denominator is 0 or missing (BigQuery SAFE_DIVIDE -> NULL -> 0). */
function safeDivide(num: number, den: number): number {
  return Number.isFinite(den) && den !== 0 && Number.isFinite(num) ? num / den : 0;
}

/**
 * Per-category z-scores. The formulas are the ones behind GET /v1/player_baselines, reproduced exactly:
 *  - counting stats: (avg - league mean) / league std
 *  - FG% and FT%: ((pct - league mean pct) x attempts per game) / std of that "impact", so a high-volume
 *    shooter moves the needle more than a low-volume one
 *  - TO: the z is NEGATED, so every category reads "higher = better". (The API's /v1/player_baselines still
 *    returns the raw turnover z, where more turnovers = higher; the golden tests flip it.)
 */
export function categoryZ(a: SeasonAverages, b: LeagueBaselines): Record<Category, number> {
  const { means: m, stds: s } = b;
  return {
    PTS: safeDivide(a.pts - m.m_pts, s.s_pts),
    REB: safeDivide(a.reb - m.m_reb, s.s_reb),
    AST: safeDivide(a.ast - m.m_ast, s.s_ast),
    STL: safeDivide(a.stl - m.m_stl, s.s_stl),
    BLK: safeDivide(a.blk - m.m_blk, s.s_blk),
    "3PM": safeDivide(a.fg3m - m.m_fg3m, s.s_fg3m),
    "FG%": safeDivide((a.fg_pct - m.m_fg_pct) * a.fga, s.s_fg_imp),
    "FT%": safeDivide((a.ft_pct - m.m_ft_pct) * a.fta, s.s_ft_imp),
    TO: -safeDivide(a.turnovers - m.m_tov, s.s_tov),
  };
}

/**
 * Fantasy Value: the weighted sum of category z-scores (turnovers already negated, so they subtract).
 *
 * With no options this is the league-agnostic headline value (TO at DEFAULT_TO_WEIGHT).
 * With `toWeight: 1` and default weights it reproduces the API's `z_total_season` (to its 3-decimal rounding).
 */
export function fantasyValue(
  a: SeasonAverages,
  b: LeagueBaselines,
  opts: FantasyValueOptions = {},
): FantasyValue {
  const z = categoryZ(a, b);
  const toWeight = opts.weights?.TO ?? opts.toWeight ?? DEFAULT_TO_WEIGHT;
  const categories = {} as Record<Category, CategoryValue>;
  let total = 0;
  for (const c of CATEGORIES) {
    const weight = c === "TO" ? toWeight : (opts.weights?.[c] ?? 1);
    const contribution = weight * z[c] + 0; // `+ 0` turns -0 into 0
    categories[c] = { z: z[c], weight, contribution };
    total += contribution;
  }
  return { total, categories, engine_version: ENGINE_VERSION };
}
