import type { LeagueBaselines, PlayerSeason } from "./types";

/** Population standard deviation. */
function std(xs: number[], mean: number): number {
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * League baseline from the ROSTERABLE POOL: the top `poolSize` players by total minutes (gp x mpg).
 * Design choice ("M2"): A cameo player with a few games cannot
 * pull the league average or spread, and a z-score reads as "better than the average rostered player".
 *
 * `poolSize` should be tied to the league: teams x roster spots (for example 14 x 13 = 182).
 * Equal weights, population std, per-game averages, exactly the method used to validate this in pandas.
 */
export function buildBaseline(players: PlayerSeason[], poolSize: number): LeagueBaselines {
  const pool = [...players].sort((a, b) => b.gp * b.mpg - a.gp * a.mpg).slice(0, poolSize);
  if (pool.length === 0) throw new Error("buildBaseline: no players");
  const col = (f: (p: PlayerSeason) => number) => pool.map(f);
  const pts = col((p) => p.averages.pts), reb = col((p) => p.averages.reb), ast = col((p) => p.averages.ast);
  const stl = col((p) => p.averages.stl), blk = col((p) => p.averages.blk), fg3m = col((p) => p.averages.fg3m);
  const fgp = col((p) => p.averages.fg_pct), ftp = col((p) => p.averages.ft_pct), tov = col((p) => p.averages.turnovers);
  const m = {
    m_pts: avg(pts), m_reb: avg(reb), m_ast: avg(ast), m_stl: avg(stl), m_blk: avg(blk), m_fg3m: avg(fg3m),
    m_fg_pct: avg(fgp), m_ft_pct: avg(ftp), m_tov: avg(tov),
  };
  const fgImpact = pool.map((p) => (p.averages.fg_pct - m.m_fg_pct) * p.averages.fga);
  const ftImpact = pool.map((p) => (p.averages.ft_pct - m.m_ft_pct) * p.averages.fta);
  return {
    means: m,
    stds: {
      s_pts: std(pts, m.m_pts), s_reb: std(reb, m.m_reb), s_ast: std(ast, m.m_ast), s_stl: std(stl, m.m_stl),
      s_blk: std(blk, m.m_blk), s_fg3m: std(fg3m, m.m_fg3m), s_tov: std(tov, m.m_tov),
      s_fg_imp: std(fgImpact, avg(fgImpact)), s_ft_imp: std(ftImpact, avg(ftImpact)),
    },
  };
}

/** Games-played constant of the season blend. Approved as D1 (PRD): w = g / (g + 40). */
export const BLEND_K = 40;

/** Share of THIS season in the baseline after `teamGames` games: 0 on opening night, 0.5 at 40, about 0.67 at 80. */
export function blendWeight(teamGames: number, k: number = BLEND_K): number {
  return Number.isFinite(teamGames) && teamGames > 0 ? teamGames / (teamGames + k) : 0;
}

/** (1 - w) x last season + w x this season, applied to every mean and standard deviation. */
export function blendBaselines(last: LeagueBaselines, current: LeagueBaselines, w: number): LeagueBaselines {
  const mix = <T extends Record<string, number>>(a: T, b: T): T =>
    Object.fromEntries(Object.keys(a).map((k) => [k, (1 - w) * a[k]! + w * b[k]!])) as T;
  return { means: mix(last.means, current.means), stds: mix(last.stds, current.stds) };
}
