/**
 * The live score of a week under way (issue #22). Hosts differ in what they show: some give made and attempted shots,
 * Yahoo's matchup page gives only FG% and FT%. Three routes, always labelled in the output:
 *  - exact: made and attempted counts were given.
 *  - estimated: only FG% / FT% were given. Banked attempts are estimated as the sum over the counted players of
 *    per-game attempts x games already played, then turned into made shots with the given percentage.
 *  - fresh-week: the live score could not be used (percentages missing too): the whole week is simulated from 0-0.
 */
export type LiveScore = "exact" | "estimated" | "fresh-week";

/**
 * Measured 2026-11-25 on the 2025-26 season (ESPN box scores, 32,000 player-games; about 1,300 random 10-player rosters per
 * cut-off, season-to-date per-game attempts, every player assumed to play every team game, long injuries excluded), after Tue to Fri:
 * banked FGA is overstated by about 16% (typical miss 15%, 9 in 10 within 40%) and FTA by about 28% (typical miss 24%, 9 in 10 within 75%).
 * The effect on the week's final FG% is a median 0.07 points (9 in 10 within 0.4); on FT% a median 0.2 (9 in 10 within 1.0).
 */
export const ATTEMPTS_ESTIMATE_NOTE =
  "Banked attempts are estimated (each counted player's per-game attempts x team games already played, from the game counts you gave), then turned into made shots with the percentage you gave. " +
  "Measured on 2025-26 weeks: this overstates banked field-goal attempts by about 16% (typical miss 15%) and free-throw attempts by about 28% (typical miss 24%), because rest days and short absences are not known; " +
  "the effect on the week's final FG% is typically under 0.1 points and on FT% about 0.2 points (9 weeks in 10 within 0.4 and 1.0). Give made and attempted counts if the host shows them to make it exact.";

export const FRESH_WEEK_NOTE =
  "The live score was not usable (the host gave neither made/attempted shots nor FG% and FT%, or other banked stats were missing), so this is a FRESH-WEEK estimate: the whole week is simulated from 0-0 and ignores what has already happened.";

export interface ShootingInput { fgm?: number; fga?: number; ftm?: number; fta?: number; fg_pct?: number; ft_pct?: number }
export interface ShootingBanked { fgm: number; fga: number; ftm: number; fta: number }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A percentage given as 0.47 or as 47. */
export const asFraction = (p: number): number => (p > 1 ? p / 100 : p);

/** Per shot type: counts given, only a percentage given, or nothing usable. Zero attempts with a percentage is not usable as exact. */
export function shotRoute(side: ShootingInput | undefined, kind: "fg" | "ft"): "exact" | "estimated" | "missing" {
  const made = side?.[`${kind}m`], att = side?.[`${kind}a`], pct = side?.[`${kind}_pct`];
  if (isNum(made) && isNum(att)) return "exact";
  if (isNum(pct) && pct >= 0 && pct <= 100) return "estimated";
  return "missing";
}

/** Whole-week label for the sides given (the least exact route wins). `need`: which shot types the league's categories use. */
export function liveScoreOf(sides: (ShootingInput | undefined)[], need: { fg: boolean; ft: boolean }): LiveScore {
  let label: LiveScore = "exact";
  for (const s of sides)
    for (const k of ["fg", "ft"] as const) {
      if (!need[k]) continue;
      const r = shotRoute(s, k);
      if (r === "missing") return "fresh-week";
      if (r === "estimated") label = "estimated";
    }
  return label;
}

/** Banked shooting for one side: given counts kept as they are, the rest estimated from the players' attempts so far. */
export function bankedShooting(side: ShootingInput, played: { fga: number; fta: number }): ShootingBanked {
  const one = (kind: "fg" | "ft", att: number): [number, number] => {
    if (shotRoute(side, kind) === "exact") return [side[`${kind}m`]!, side[`${kind}a`]!];
    const pct = side[`${kind}_pct`];
    return isNum(pct) ? [asFraction(pct) * att, att] : [0, 0];
  };
  const [fgm, fga] = one("fg", played.fga), [ftm, fta] = one("ft", played.fta);
  return { fgm, fga, ftm, fta };
}
