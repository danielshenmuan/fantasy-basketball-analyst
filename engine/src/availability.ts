import { gameDays, type Snapshot } from "./snapshot";

/**
 * Injury windows and return scenarios (issue #6).
 *
 * A player is unavailable from `outFrom` until `returnDate` (null: no return in sight, so out for the whole horizon). Games on
 * those days are lost. Games after he returns count at `ramp.share` of his normal output for the first `ramp.games` games back
 * (default 80% for 3 games). The ramp is an assumption, never a measurement, and the output says so.
 */
export interface Availability {
  /** First day he misses (YYYY-MM-DD). */
  outFrom: string;
  /** First day he can play again; null when unknown (out for everything the model looks at). */
  returnDate: string | null;
  /** Share of normal output in each of the first `games` games back. Absent: no ramp-up. */
  ramp?: { games: number; share: number };
  /** True when the return date is the model's own assumption (an OUT tag with no date), not something the user or the host gave. */
  assumedReturn?: boolean;
}

export const DEFAULT_RAMP = { games: 3, share: 0.8 } as const;

const DAY = 86400000;
export const addDays = (date: string, n: number): string => new Date(Date.parse(date + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string): number => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

/** Pretend game dates for a team when the data has no day-by-day schedule: `n` games spread evenly over the 7 days. */
function evenDates(weekStart: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(weekStart, Math.min(6, Math.floor(((i + 0.5) * 7) / n))));
}

export interface WeekGames {
  /** Games he plays that week, weighted: a game inside the ramp counts at the ramp share. */
  games: number;
  /** Games his team plays that week with nobody missing (the number he would play when healthy). */
  teamGames: number;
  /** True when dates were spread evenly because the data has no day-by-day schedule. */
  approximate: boolean;
}

/** Each game his team plays in the week with the weight he gets in it: 0 when he is out, the ramp share early in a return, else 1. */
export function gameWeights(snapshot: Snapshot, team: string | undefined, weekStart: string, teamGames: number, av: Availability | undefined): { games: { date: string; w: number }[]; approximate: boolean } {
  const weekEnd = addDays(weekStart, 6);
  const real = team ? gameDays(snapshot, team, weekStart, weekEnd) : null;
  const approximate = !real || (real.length === 0 && teamGames > 0);
  const dates = !approximate ? real! : evenDates(weekStart, Math.round(teamGames));
  const back = av?.returnDate ?? null;
  let played = 0;
  if (av && back && av.ramp && back < weekStart && team) {
    // Games he already played back before this week count toward his ramp-up.
    const priorDates = gameDays(snapshot, team, back, addDays(weekStart, -1));
    played = priorDates ? priorDates.length : Math.round((teamGames * diffDays(back, weekStart)) / 7);
  }
  const games = dates.map((date) => {
    if (!av || (date >= av.outFrom && (back === null || date < back))) return { date, w: av ? 0 : 1 };
    const inRamp = !!(av.ramp && back && date >= back && played < av.ramp.games);
    played++;
    return { date, w: inRamp ? av.ramp!.share : 1 };
  });
  return { games, approximate };
}

/**
 * Games one player plays in the week starting `weekStart`, given his team's games that week and his availability.
 * `teamGames` is the count from the weekly schedule; real game dates come from the day-by-day schedule when the data has it.
 */
export function gamesWithAvailability(snapshot: Snapshot, team: string | undefined, weekStart: string, teamGames: number, av: Availability | undefined): WeekGames {
  if (!av || !team) return { games: teamGames, teamGames, approximate: false };
  const { games, approximate } = gameWeights(snapshot, team, weekStart, teamGames, av);
  const sum = games.reduce((s, g) => s + g.w, 0);
  return { games: approximate ? sum * (teamGames / (games.length || 1)) : sum, teamGames, approximate };
}

/** Build the availability of a player the host tags OUT, per the rules agreed in grilling (Q12c). */
export function availabilityFromHost(
  tag: string | undefined, returnDate: string | undefined, asOf: string, ramp: Availability["ramp"] | null = DEFAULT_RAMP,
): { av?: Availability; flag?: string } {
  const t = (tag ?? "").trim().toUpperCase();
  if (t === "GTD" || t === "DTD" || t === "Q" || t === "QUESTIONABLE" || t === "DAY-TO-DAY") return { flag: `${t}: counted as playing (status as read from the league page)` };
  if (t !== "OUT" && t !== "O" && t !== "INJ" && t !== "IL" && !returnDate) return {};
  if (returnDate) return { av: { outFrom: asOf, returnDate, ...(ramp ? { ramp } : {}) } };
  // OUT with no date: out for the rest of the current week only, back at the start of next week, flagged.
  const next = addDays(asOf, 7 - ((new Date(asOf + "T00:00:00Z").getUTCDay() + 6) % 7));
  return { av: { outFrom: asOf, returnDate: next, ...(ramp ? { ramp } : {}), assumedReturn: true }, flag: "OUT with no return date: counted as out for the rest of this week and back next week (assumption)" };
}
