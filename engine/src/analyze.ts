import { assessTeam, type RosterPlayer, type TeamAssessment } from "./assess";
import { blendBaselines, blendWeight, buildBaseline } from "./baseline";
import { categoryZ } from "./fantasyValue";
import { simulateBenchmark, type SimPlayer } from "./simulate";
import { historyOf, resolvePlayer, type Snapshot } from "./snapshot";
import { estimateAverages, seasonLabel, startYear } from "./history";
import { evaluateTrade, rankWaiverMoves, scoreRoster, searchTrades, type Entry, type MoveEnv, type Score, type WeekEnv } from "./moves";
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
  /** Rank free agents by what adding each does to your weekly win chance. */
  waiver?: WaiverInput;
  /** Evaluate a trade, or search one-for-one offers with another roster. */
  trade?: TradeInput;
}
interface MoveCommon {
  /** Players who count each week. Default: league.roster_spots. */
  lineup_slots?: number;
  /** Upcoming weeks averaged together, this week first. Default 2 (fewer if the data has fewer). */
  horizon_weeks?: number;
  /** Simulated weeks per score. Default 6000. */
  weeks?: number;
}
export interface WaiverInput extends MoveCommon {
  /** Available players to consider (names read from the league's free-agent list). */
  candidates: { name: string }[];
  /** How many moves to return. Default 8. */
  top?: number;
}
export interface TradeInput extends MoveCommon {
  /** Players you would give / get (names). Omit both to search offers. */
  give?: { name: string }[];
  get?: { name: string }[];
  /** The other team's roster: needed to search offers and to score their side. */
  other_roster?: { name: string; status?: "IL" | "active" }[];
  /** Search one-for-one offers with `other_roster` that help you without hurting them. */
  search?: boolean;
  top?: number;
}
export interface MoveCategoryDelta { [category: string]: number }
export interface WaiverOutput {
  weeks_used: string[];
  games_source: "schedule" | "assumed";
  /** Whole percent: weekly win chance as it stands. */
  baseline_week_win_pct: number;
  moves: { add: string; drop: string; week_win_pct: number; delta_points: number; categories_delta_points: MoveCategoryDelta }[];
  names: NameResult[];
  assumptions: string[];
}
export interface TradeSide { before_week_win_pct: number; after_week_win_pct: number; delta_points: number; categories_delta_points: MoveCategoryDelta }
export interface TradeOutput {
  mode: "evaluate" | "search";
  weeks_used: string[];
  games_source: "schedule" | "assumed";
  you?: TradeSide;
  other_team?: TradeSide;
  offers?: { give: string; get: string; you: TradeSide; other_team: TradeSide }[];
  names: NameResult[];
  assumptions: string[];
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
  waiver?: WaiverOutput;
  trade?: TradeOutput;
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
  const waiver = input.waiver ? runWaiver(input, snapshot, reference, currentSeason, baseline) : undefined;
  const trade = input.trade ? runTrade(input, snapshot, reference, currentSeason, baseline) : undefined;
  return {
    ...result,
    snapshot: { generated_at: snapshot.generated_at, reference_season: snapshot.reference_season },
    baseline: blendInfo,
    league: input.league, names, ranking,
    ...(matchup ? { matchup } : {}),
    ...(waiver ? { waiver } : {}),
    ...(trade ? { trade } : {}),
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


/** Everyone in the snapshot estimated the same way as in the team assessment, with a ranking value. */
function estimatePlayers(snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>): Map<number, Entry> {
  const out = new Map<number, Entry>();
  for (const p of snapshot.players) {
    const e = estimateAverages(historyOf(p), reference, { current: currentSeason });
    if (!e.averages) continue;
    const z = categoryZ(e.averages, baseline);
    out.set(p.id, { id: p.id, name: p.name, averages: e.averages, team: p.team, value: CATEGORIES.reduce((t, c) => t + z[c], 0) });
  }
  return out;
}

interface MoveSetup {
  env: MoveEnv;
  estimated: Map<number, Entry>;
  weeksUsed: string[];
  gamesSource: "schedule" | "assumed";
  assumptions: string[];
}

/** The weeks, schedule, typical opponents and replacement player shared by the waiver and trade tools. */
function moveSetup(
  input: AnalyzeInput, common: { lineup_slots?: number; horizon_weeks?: number; weeks?: number },
  snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>,
): MoveSetup {
  const { teams, roster_spots } = input.league;
  const slots = common.lineup_slots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20) throw new Error("lineup_slots must be a whole number from 1 to 20");
  const horizon = Math.max(1, Math.min(4, common.horizon_weeks ?? 2));
  const simWeeks = common.weeks ?? 6000;
  const estimated = estimatePlayers(snapshot, reference, currentSeason, baseline);
  const pool = [...estimated.values()].sort((a, b) => b.value - a.value);
  if (pool.length < teams * roster_spots) throw new Error(`snapshot has only ${pool.length} players; need at least ${teams * roster_spots}`);
  const replacement = pool[teams * roster_spots - 1]!;

  const first = mondayOf(snapshot.generated_at);
  const scheduled = (snapshot.schedule?.weeks ?? []).filter((w) => w.start >= first).slice(0, horizon);
  const assumptions: string[] = [];
  const seed = input.seed ?? 1;
  const mk = (start: string | null, games: Record<string, number> | null): WeekEnv => {
    const gamesFor = (team?: string) => (games && team ? (games[team] ?? 0) : DEFAULT_WEEK_GAMES);
    return { start, gamesFor, opponents: typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 150, seed }) };
  };
  const weeks = scheduled.length > 0 ? scheduled.map((w) => mk(w.start, w.games)) : [mk(null, null)];
  const gamesSource = scheduled.length > 0 ? "schedule" : "assumed";
  assumptions.push(
    gamesSource === "schedule"
      ? `Averaged over ${weeks.length} week(s) starting ${weeks[0]!.start}, counting each player's real games from the NBA schedule.`
      : `No schedule in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`,
    `Each score is a weekly win chance against typical opponents (${weeks[0]!.opponents.length} teams from simulated ${teams}-team drafts, positions ignored), ${simWeeks} simulated weeks with a fixed seed. ` +
      `A move is scored by re-running the same weeks with the roster changed, so the difference is the move's effect. Injuries, rest days and lineup moves during the week are not modelled. An empty lineup spot is filled by a replacement-level player.`,
  );
  return { env: { slots, weeks, simWeeks, seed, replacement }, estimated, weeksUsed: weeks.map((w) => w.start ?? "assumed"), gamesSource, assumptions };
}

function resolveList(
  list: { name: string; status?: "IL" | "active" }[], snapshot: Snapshot, estimated: Map<number, Entry>, names: NameResult[], suffix = "",
): Entry[] {
  const out: Entry[] = [];
  for (const r of list) {
    const hit = resolvePlayer(r.name, snapshot.players);
    if (hit.status === "matched") {
      names.push({ input: r.name + suffix, status: "matched", matched: hit.player.name });
      const e = estimated.get(hit.player.id);
      if (e && r.status !== "IL") out.push(e);
    } else if (hit.status === "ambiguous") {
      names.push({ input: r.name + suffix, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
    } else names.push({ input: r.name + suffix, status: "not_found" });
  }
  return out;
}

const pct1 = (x: number) => Math.round(x * 1000) / 10;
const catDelta = (d: Record<Category, number>): MoveCategoryDelta => Object.fromEntries(CATEGORIES.map((c) => [c, pct1(d[c])]));
const side = (b: Score, a: Score, delta: number, cd: Record<Category, number>): TradeSide => ({
  before_week_win_pct: Math.round(b.weekWin * 100), after_week_win_pct: Math.round(a.weekWin * 100), delta_points: pct1(delta), categories_delta_points: catDelta(cd),
});

function runWaiver(input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>): WaiverOutput {
  const w = input.waiver!;
  if (!Array.isArray(w.candidates) || w.candidates.length === 0) throw new Error("waiver.candidates must list at least one available player");
  if (w.candidates.length > 60) throw new Error("waiver.candidates has more than 60 players; send the best available");
  const st = moveSetup(input, w, snapshot, reference, currentSeason, baseline);
  const names: NameResult[] = [];
  const roster = resolveList(input.roster, snapshot, st.estimated, names);
  const mine = new Set(roster.map((p) => p.id));
  const cands = resolveList(w.candidates, snapshot, st.estimated, names, " (available)").filter((p) => !mine.has(p.id));
  if (roster.length === 0) throw new Error("none of the roster players could be matched");
  const { baseline: base, moves } = rankWaiverMoves(roster, cands, st.env, { top: w.top ?? 8 });
  return {
    weeks_used: st.weeksUsed, games_source: st.gamesSource,
    baseline_week_win_pct: Math.round(base.weekWin * 100),
    moves: moves.map((m) => ({ add: m.add.name, drop: m.drop.name, week_win_pct: Math.round(m.after.weekWin * 100), delta_points: pct1(m.delta), categories_delta_points: catDelta(m.categoryDelta) })),
    names, assumptions: st.assumptions,
  };
}

function runTrade(input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>): TradeOutput {
  const t = input.trade!;
  const st = moveSetup(input, t, snapshot, reference, currentSeason, baseline);
  const names: NameResult[] = [];
  const mine = resolveList(input.roster, snapshot, st.estimated, names);
  const theirs = t.other_roster ? resolveList(t.other_roster, snapshot, st.estimated, names, " (other team)") : [];
  if (mine.length === 0) throw new Error("none of the roster players could be matched");
  const base = { weeks_used: st.weeksUsed, games_source: st.gamesSource, names };
  if (t.search) {
    if (theirs.length === 0) throw new Error("trade.search needs trade.other_roster");
    const offers = searchTrades(mine, theirs, st.env, { top: t.top ?? 5 });
    return {
      mode: "search", ...base,
      offers: offers.map((o) => ({
        give: o.give.name, get: o.get.name,
        you: side(o.mine.before, o.mine.after, o.mine.delta, o.mine.categoryDelta),
        other_team: side(o.theirs.before, o.theirs.after, o.theirs.delta, o.theirs.categoryDelta),
      })),
      assumptions: [...st.assumptions, "Offers are one-for-one swaps that raise your weekly win chance without lowering the other team's. They model the two rosters only: what the other owner actually values, and positions, are not modelled."],
    };
  }
  if (!t.give?.length || !t.get?.length) throw new Error("trade needs give and get (or search with other_roster)");
  const give = resolveList(t.give, snapshot, st.estimated, names, " (give)");
  const get = resolveList(t.get, snapshot, st.estimated, names, " (get)");
  const myIds = new Set(mine.map((p) => p.id));
  const notMine = give.filter((p) => !myIds.has(p.id));
  if (notMine.length > 0) throw new Error(`you do not have: ${notMine.map((p) => p.name).join(", ")}`);
  const you = evaluateTrade(mine, give, get, st.env);
  const out: TradeOutput = { mode: "evaluate", ...base, you: side(you.before, you.after, you.delta, you.categoryDelta), assumptions: st.assumptions };
  if (theirs.length > 0) {
    const them = evaluateTrade(theirs, get, give, st.env);
    out.other_team = side(them.before, them.after, them.delta, them.categoryDelta);
  }
  return out;
}
