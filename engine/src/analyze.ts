import { assessTeam, type RosterPlayer, type TeamAssessment } from "./assess";
import { blendBaselines, blendWeight, buildBaseline } from "./baseline";
import { categoryZ } from "./fantasyValue";
import { simulateBenchmark, type SimPlayer } from "./simulate";
import { historyOf, resolvePlayer, type Snapshot } from "./snapshot";
import { estimateAverages, seasonLabel, startYear } from "./history";
import {
  DEFAULT_WEEKS, DEFAULT_WEEK_GAMES, mondayOf, simulateWeeks, typicalOpponents, weeklyTotals,
  type DraftablePlayer, type WeeklyPlayer, type WeeklyTotals,
} from "./matchup";
import { CATEGORIES, type Band, type Category, type PlayerSeason } from "./types";

export interface AnalyzeInput {
  league: { teams: number; roster_spots: number };
  roster: { name: string; status?: "IL" | "active" }[];
  /** Season for the league baseline; defaults to the snapshot's. */
  reference?: string;
  /** Team games played this season. Default: the most games any player has played this season. */
  team_games?: number;
  /** Simulated leagues (default 500). */
  leagues?: number;
  seed?: number;
  /** Ask for the weekly head-to-head simulation too. */
  matchup?: MatchupInput;
}
export interface MatchupInput {
  /** A real opponent's roster. Omitted: typical opponents from simulated drafts. */
  opponent?: { name: string; status?: "IL" | "active" }[];
  /** Monday of the week (YYYY-MM-DD). Default: the week of the snapshot's generation date. */
  week_start?: string;
  /** Players who count each week (starters). Default: league.roster_spots. */
  lineup_slots?: number;
  /** Simulated weeks (default 10000). */
  weeks?: number;
}
export interface MatchupOutput {
  week_start: string | null;
  /** "schedule": games counted from the NBA schedule. "assumed": an average week (3.4 games) for everyone. */
  games_source: "schedule" | "assumed";
  opponent: "typical" | "roster";
  lineup_slots: number;
  weeks: number;
  /** Whole percent of simulated weeks you win each category. */
  categories: Record<Category, number>;
  /** Whole percent of simulated weeks you win 5 or more of 9. */
  week_win_pct: number;
  /** Whole percent of weeks you win exactly k categories, k = 0..9. */
  distribution_pct: number[];
  names: NameResult[];
  assumptions: string[];
}
export interface NameResult {
  input: string;
  status: "matched" | "ambiguous" | "not_found";
  matched?: string;
  candidates?: { id: number; name: string; latest_season: string }[];
}
export interface AnalyzeOutput extends TeamAssessment {
  snapshot: { generated_at: string; reference_season: string };
  /** How the league baseline was built: last season, blended with the season in progress by games played (D1). */
  baseline: { reference_season: string; current_season: string | null; team_games: number; weight_current: number };
  league: { teams: number; roster_spots: number };
  names: NameResult[];
  /** Plain list for the agent to speak from: strongest to weakest by percentile. */
  ranking: { category: Category; band: Band; percentile: number }[];
  matchup?: MatchupOutput;
}

function check(input: AnalyzeInput): void {
  const { teams, roster_spots } = input.league ?? ({} as AnalyzeInput["league"]);
  if (!Number.isInteger(teams) || teams < 4 || teams > 30) throw new Error("league.teams must be a whole number from 4 to 30");
  if (!Number.isInteger(roster_spots) || roster_spots < 5 || roster_spots > 20) throw new Error("league.roster_spots must be a whole number from 5 to 20 (active slots, not IL)");
  if (!Array.isArray(input.roster) || input.roster.length === 0) throw new Error("roster must list at least one player");
  if (input.roster.length > 40) throw new Error("roster has more than 40 players");
}

export function analyze(input: AnalyzeInput, snapshot: Snapshot): AnalyzeOutput {
  check(input);
  const reference = input.reference ?? snapshot.reference_season;
  const { teams, roster_spots } = input.league;

  const poolOf = (season: string): PlayerSeason[] => {
    const out: PlayerSeason[] = [];
    for (const p of snapshot.players) {
      const s = p.seasons.find((x) => x.season === season);
      if (s && s.mpg > 0 && s.gp > 0) out.push({ player_id: p.id, name: p.name, gp: s.gp, mpg: s.mpg, averages: s.averages });
    }
    return out;
  };
  const pool = poolOf(reference);
  if (pool.length < teams * roster_spots) throw new Error(`snapshot has only ${pool.length} players for ${reference}; need at least ${teams * roster_spots}`);
  let baseline = buildBaseline(pool, teams * roster_spots);

  // D1: blend in the season in progress, w = g / (g + 40). The baseline is the only thing blended; players are still
  // valued from their history (a separate decision), so only the yardstick moves with the season.
  const currentSeason = seasonLabel(startYear(reference) + 1);
  const currentPool = poolOf(currentSeason);
  const teamGames = input.team_games ?? currentPool.reduce((m, p) => Math.max(m, p.gp), 0);
  const w = currentPool.length >= teams * roster_spots ? blendWeight(teamGames) : 0;
  if (w > 0) baseline = blendBaselines(baseline, buildBaseline(currentPool, teams * roster_spots), w);
  const blendInfo = { reference_season: reference, current_season: w > 0 ? currentSeason : null, team_games: w > 0 ? teamGames : 0, weight_current: w };
  const sim: SimPlayer[] = pool.map((p) => {
    const z = categoryZ(p.averages, baseline);
    return { id: p.player_id, z, total: CATEGORIES.reduce((t, c) => t + z[c], 0) };
  });
  const benchmark = simulateBenchmark(sim, { teams, rosterSpots: roster_spots }, { leagues: input.leagues ?? 500, seed: input.seed ?? 1 });

  const names: NameResult[] = [];
  const roster: RosterPlayer[] = input.roster.map((r) => {
    const m = resolvePlayer(r.name, snapshot.players);
    const status = r.status === "IL" ? "IL" : undefined;
    if (m.status === "matched") {
      names.push({ input: r.name, status: "matched", matched: m.player.name });
      return { name: m.player.name, status, history: historyOf(m.player) };
    }
    if (m.status === "ambiguous") {
      names.push({
        input: r.name, status: "ambiguous",
        candidates: m.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })),
      });
    } else names.push({ input: r.name, status: "not_found" });
    return { name: r.name, status, history: { player_id: null, name: r.name, seasons: [] } };
  });

  const result = assessTeam(roster, baseline, benchmark, { reference, current: currentPool.length > 0 ? currentSeason : undefined });
  if (w > 0) result.assumptions.push(`League baseline: ${Math.round((1 - w) * 100)}% ${reference}, ${Math.round(w * 100)}% ${currentSeason} (season blend after ${teamGames} games, w = g/(g+40)).`);
  for (const n of names) {
    if (n.status === "ambiguous") result.assumptions.push(`"${n.input}" could be more than one player; counted as an average player until clarified.`);
    if (n.status === "not_found") result.assumptions.push(`"${n.input}" was not found (misspelled, or a rookie not in the data yet); counted as an average player.`);
  }
  const ranking = CATEGORIES.map((c) => ({ category: c, band: result.categories[c].band, percentile: Math.round(result.categories[c].percentile) }))
    .sort((a, b) => b.percentile - a.percentile);
  const matchup = input.matchup ? runMatchup(input, snapshot, reference, currentSeason, baseline, names) : undefined;
  return {
    ...result,
    snapshot: { generated_at: snapshot.generated_at, reference_season: snapshot.reference_season },
    baseline: blendInfo,
    league: input.league, names, ranking,
    ...(matchup ? { matchup } : {}),
  };
}

/** Weekly head-to-head simulation (D12). Every player is estimated the same way as in the team assessment. */
function runMatchup(
  input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string,
  baseline: ReturnType<typeof buildBaseline>, mineNames: NameResult[],
): MatchupOutput {
  const m = input.matchup!;
  const { teams, roster_spots } = input.league;
  const slots = m.lineup_slots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20) throw new Error("matchup.lineup_slots must be a whole number from 1 to 20");
  const assumptions: string[] = [];

  // Games per team this week, from the schedule in the snapshot.
  const weekStart = m.week_start ?? mondayOf(snapshot.generated_at);
  const week = snapshot.schedule?.weeks.find((w) => w.start === weekStart);
  const gamesFor = (team: string | undefined): number => (week && team ? (week.games[team] ?? 0) : DEFAULT_WEEK_GAMES);
  const fromSchedule = Boolean(week);
  assumptions.push(
    fromSchedule
      ? `Games per player come from the NBA schedule for the week of ${weekStart}. Injuries and rest days are not modelled.`
      : `No schedule for the week of ${weekStart} in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games. A real week with more or fewer games changes the picture.`,
  );

  // Everyone estimated once.
  const estimated = new Map<number, DraftablePlayer & { name: string }>();
  for (const p of snapshot.players) {
    const e = estimateAverages(historyOf(p), reference, { current: currentSeason });
    if (!e.averages) continue;
    const z = categoryZ(e.averages, baseline);
    estimated.set(p.id, { name: p.name, averages: e.averages, team: p.team, value: CATEGORIES.reduce((t, c) => t + z[c], 0) });
  }
  const weeklyOf = (list: { name: string; status?: "IL" | "active" }[], label: string): { totals: WeeklyTotals; names: NameResult[] } => {
    const names: NameResult[] = [];
    const players: WeeklyPlayer[] = [];
    for (const r of list) {
      const hit = resolvePlayer(r.name, snapshot.players);
      if (hit.status === "matched") {
        names.push({ input: r.name, status: "matched", matched: hit.player.name });
        const e = estimated.get(hit.player.id);
        if (r.status !== "IL" && e) players.push({ averages: e.averages, games: gamesFor(e.team), value: e.value });
      } else if (hit.status === "ambiguous") {
        names.push({ input: r.name, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
      } else names.push({ input: r.name, status: "not_found" });
    }
    const missing = names.filter((n) => n.status !== "matched").length;
    if (missing > 0) assumptions.push(`${missing} player(s) in the ${label} roster could not be matched and are left out of the weekly totals.`);
    return { totals: weeklyTotals(players, slots), names };
  };

  const me = weeklyOf(input.roster, "your");
  let opponents: WeeklyTotals[];
  let names = me.names;
  if (m.opponent && m.opponent.length > 0) {
    const o = weeklyOf(m.opponent, "opponent");
    opponents = [o.totals];
    names = [...me.names, ...o.names.map((n) => ({ ...n, input: `${n.input} (opponent)` }))];
  } else {
    const pool = [...estimated.values()];
    opponents = typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 300, seed: input.seed ?? 1 });
    assumptions.push(
      `Typical opponents: ${opponents.length} teams from ${300} simulated ${teams}-team drafts, each playing its best ${slots} players. Positions are ignored.`,
    );
  }
  const weeks = m.weeks ?? DEFAULT_WEEKS;
  const r = simulateWeeks(me.totals, opponents, { weeks, seed: input.seed ?? 1, slots });
  assumptions.push(
    `Week-to-week luck is measured on 2025-26 weekly results after removing game counts. ${weeks} simulated weeks, fixed seed, so the same inputs give the same answer. ` +
      `The simulation does not model injuries, lineup moves or streaming during the week.`,
  );
  const pct = (x: number) => Math.round(x * 100);
  return {
    week_start: week ? weekStart : null,
    games_source: fromSchedule ? "schedule" : "assumed",
    opponent: m.opponent && m.opponent.length > 0 ? "roster" : "typical",
    lineup_slots: slots,
    weeks,
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, pct(r.categories[c])])) as Record<Category, number>,
    week_win_pct: pct(r.weekWin),
    distribution_pct: r.distribution.map(pct),
    names,
    assumptions,
  };
}
