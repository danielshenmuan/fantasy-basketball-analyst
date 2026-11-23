import type { Confidence, Estimate, PlayerHistory, SeasonAverages } from "./types";

/**
 * Weight of a season by how long ago it was: 0 seasons back = 1.0, 1 back = 0.6, 2 back = 0.3.
 * Recency weights and the per-season games cap are design defaults, open to tuning.
 */
export const RECENCY_WEIGHTS: readonly number[] = [1.0, 0.6, 0.3];
/** One season can contribute at most this many games, so a single full year cannot swamp the others. */
export const GAMES_CAP = 65;
/** A player with no history needs at least this many games this season before it is used (my default, unreviewed). */
export const CURRENT_MIN_GAMES = 5;
/** Effective games needed for each confidence level. Defaults chosen here; open to adjustment. */
export const CONFIDENCE_MIN = { high: 100, medium: 50 } as const;

const FIELDS: (keyof SeasonAverages)[] = [
  "pts", "reb", "ast", "stl", "blk", "fg3m", "fg_pct", "ft_pct", "turnovers", "fga", "fta",
];
/** Made shots: blended the same way, but only from seasons that have them (older snapshots do not). */
const MADE = ["fgm", "ftm"] as const;

export function seasonLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
export function startYear(season: string): number {
  return Number(season.slice(0, 4));
}

/**
 * Blend a player's last three seasons into one set of per-game averages.
 * weight = recency x min(games, GAMES_CAP). A season with no games contributes nothing, so a player who
 * missed last year (Lillard) is estimated from the seasons before it, and a player who returned from injury
 * (Tatum, 16 games) is mostly judged on his full seasons. Aging and role changes are NOT modelled.
 * `reference` is the most recent COMPLETED season (e.g. "2025-26" during the 2026 preseason).
 */
export function estimateAverages(
  h: PlayerHistory,
  reference: string,
  opts: { recency?: readonly number[]; gamesCap?: number; current?: string } = {},
): Estimate {
  const recency = opts.recency ?? RECENCY_WEIGHTS;
  const cap = opts.gamesCap ?? GAMES_CAP;
  const ref = startYear(reference);
  const acc = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<keyof SeasonAverages, number>;
  let wSum = 0;
  const made: Record<(typeof MADE)[number], { acc: number; w: number }> = { fgm: { acc: 0, w: 0 }, ftm: { acc: 0, w: 0 } };
  const used: string[] = [];
  recency.forEach((r, back) => {
    const label = seasonLabel(ref - back);
    const s = h.seasons.find((x) => x.season === label);
    if (!s || !(s.gp > 0)) return;
    const w = r * Math.min(s.gp, cap);
    for (const f of FIELDS) acc[f] += w * s.averages[f];
    for (const f of MADE) {
      const v = s.averages[f];
      if (typeof v === "number") { made[f].acc += w * v; made[f].w += w; }
    }
    wSum += w;
    used.push(label);
  });
  if (wSum === 0) {
    // D10 option C: only a player with NO completed-season history is judged on this season, at full weight for his games.
    const cur = opts.current ? h.seasons.find((x) => x.season === opts.current) : undefined;
    if (cur && cur.gp >= CURRENT_MIN_GAMES) {
      const games = Math.min(cur.gp, cap);
      const confidence: Confidence = games >= CONFIDENCE_MIN.high ? "high" : games >= CONFIDENCE_MIN.medium ? "medium" : "low";
      return { averages: { ...cur.averages }, confidence, effectiveGames: games, seasonsUsed: [cur.season], currentSeasonOnly: true };
    }
    return { averages: null, confidence: "none", effectiveGames: 0, seasonsUsed: [] };
  }
  const averages = Object.fromEntries(FIELDS.map((f) => [f, acc[f] / wSum])) as unknown as SeasonAverages;
  for (const f of MADE) if (made[f].w > 0) averages[f] = made[f].acc / made[f].w;
  const confidence: Confidence = wSum >= CONFIDENCE_MIN.high ? "high" : wSum >= CONFIDENCE_MIN.medium ? "medium" : "low";
  return { averages, confidence, effectiveGames: wSum, seasonsUsed: used };
}
