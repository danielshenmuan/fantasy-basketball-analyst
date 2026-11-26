import { analyzeAny, type AnyAnalyzeOutput } from "./analyzeAny";
import { isStandardNine, parseCategories, parseWeights, untrackedScoring } from "./anycat";
import { assessTeam, type RosterPlayer, type TeamAssessment } from "./assess";
import { blendBaselines, blendWeight, buildBaseline } from "./baseline";
import { categoryZ } from "./fantasyValue";
import { simulateBenchmark, type SimPlayer } from "./simulate";
import { historyOf, resolvePlayer, scheduleWeeks, type Snapshot } from "./snapshot";
import { estimateAverages, seasonLabel, startYear } from "./history";
import { evaluateTrade, rankWaiverMoves, scoreRoster, searchTrades, type Entry, type MoveEnv, type Score, type WeekEnv } from "./moves";
import {
  DEFAULT_WEEKS, DEFAULT_WEEK_GAMES, mondayOf, scaledTotals, simulateWeeks, typicalOpponents, weeklyTotals,
  type DraftablePlayer, type WeeklyPlayer, type WeeklyTotals,
} from "./matchup";
import { CATEGORIES, type Band, type Category, type PlayerSeason } from "./types";
import { parsePositions, parseSlots, type Slots } from "./lineup";
import { availabilityFromHost, DEFAULT_RAMP, gamesWithAvailability } from "./availability";
import { runDaily, type DailyEngine } from "./daily";
import { runOutlook, type OutlookOutput, type WeekWin } from "./outlook";
import { resolveSide, type SideResult } from "./sideutil";

/** A player as the user or the host lists him. */
export interface PlayerRef {
  name: string;
  status?: "IL" | "active";
  /** Positions the league host shows for him ("PG,SG" or ["PG","SG"]). Used when the league has lineup slots. */
  positions?: string | string[];
  /** The host's injury tag for him ("OUT", "GTD", "DTD", ...), read from the league page when the model runs. */
  injury?: string;
  /** Day he is expected back (YYYY-MM-DD), when the host shows one. */
  return_date?: string;
}
/** Something the user assumes for one player in the matchup: out, or back on a day. The output labels it the user's assumption. */
export interface Scenario {
  name: string;
  /** Whose player he is. Default "you". */
  side?: "you" | "opponent";
  /** First day he misses (default: the first day the model looks at). */
  out_from?: string;
  /** Last day he misses (he plays again the day after). */
  out_until?: string;
  /** Day he plays again. Without out_until or returns he is out for the whole week. */
  returns?: string;
  /** Output in his first games back, e.g. {games: 3, share: 0.8}. Default 80% for 3 games. false: no ramp-up. */
  ramp?: { games: number; share: number } | false;
}

export interface AnalyzeInput {
  /** `categories`: the league's scoring categories as the host names them ("Points", "3-pointers made", "Double-doubles"). Omit for the standard nine. */
  league: { teams: number; roster_spots: number;
    /** Starting lineup slots as the host lists them (["PG","SG","G","SF","PF","F","C","C","UTIL","UTIL"]). Replaces `lineup_slots`; positions are then used. */
    slots?: string[];
    /** "daily": lineups are set every day (Yahoo, most ESPN leagues). "weekly": locked once the week starts. Needed for matchup.daily. */
    lineup_lock?: "daily" | "weekly";
    /** Injured-list slots in the league, and the statuses the league lets into one (read from the league settings), e.g. ["OUT"]. */
    il_slots?: number; il_eligible_statuses?: string[];
    categories?: string[]; /** Head-to-head points league: the host's stat names and what each is worth (negative for a penalty). Use instead of `categories`. */ scoring?: Record<string, number> };
  roster: PlayerRef[];
  /** Today (YYYY-MM-DD) for injury windows. Default: the snapshot's date. */
  as_of?: string;
  /** Output in a returning player's first games back. Default 80% for 3 games (an assumption). false: none. */
  ramp?: { games: number; share: number } | false;
  /** Day-by-day NBA schedule to use in place of the snapshot's: date -> team codes playing (see skills/matchup/scripts/season-days.mjs). */
  schedule_days?: Record<string, string[]>;
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
  /** Rest of the season and the playoffs (issue #10). */
  outlook?: import("./outlook").OutlookInput;
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
  /** Available players to consider (names read from the league's free-agent list, with positions when the league has slots). */
  candidates: { name: string; positions?: string | string[]; injury?: string; return_date?: string }[];
  /** Adds still allowed this week. Output adds the best use of them. Omitted: no limit applied. */
  adds_left?: number;
  /** Open injured-list slots right now. Default: league.il_slots minus the roster players marked IL. */
  il_open?: number;
  /** How many moves to return. Default 8. */
  top?: number;
}
export interface TradeInput extends MoveCommon {
  /** Players you would give / get (names). Omit both to search offers. */
  give?: PlayerRef[];
  get?: PlayerRef[];
  /** The other team's roster: needed to search offers and to score their side. */
  other_roster?: PlayerRef[];
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
  /** Ranked by what the added player contributes beyond the drop (`add_effect_points`). Every move here enters the lineup. */
  moves: {
    /** `drop` is null when an open roster spot or injured-list slot means nobody has to go. */
    add: string; drop: string | null; week_win_pct: number;
    /** Points of weekly win chance against the roster as it stands. */
    delta_points: number;
    /** Points from dropping that player alone, with nobody added. */
    drop_only_points: number;
    /** delta_points minus drop_only_points: what the added player contributes. */
    add_effect_points: number;
    /** How much history the add's estimate rests on. "low" means few games: treat with care. */
    add_confidence: "high" | "medium" | "low" | "none";
    /** Games of history behind the add's estimate (recency-weighted, capped per season). */
    add_games_basis: number;
    categories_delta_points: MoveCategoryDelta;
  }[];
  /**
   * Candidates not ranked. This is a limit of the model, not a verdict on the player: it counts only the best
   * `lineup_slots` players each week and treats everyone else as sitting all week; it does not model days when starters are off.
   */
  not_ranked: NotRanked[];
  /** Players assumed moved into open injured-list slots (their status is one the league lets into IL), which frees their spots. */
  il_moves: string[];
  /** Open active roster spots after those moves: an add needs no drop while one is open. */
  open_spots: number;
  /** When `adds_left` was given: the best use of those adds, found by re-simulating the combined roster (never a sum of single moves). */
  best_use_of_adds?: { adds_left: number; moves: { add: string; drop: string | null }[]; week_win_pct: number; delta_points: number; note?: string };
  /** Injury statuses read from the league page that changed a player's games, and tags counted as playing. */
  injury_notes: string[];
  /** True when a week in `weeks_used` still has schedule games with a team to be announced. */
  schedule_incomplete: boolean;
  names: NameResult[];
  assumptions: string[];
}
export interface NotRanked {
  add: string;
  reason: "bench-only" | "no-gain-from-add" | "below-top" | "breaks-slot";
  /** Always "not counted by this model": never "no lineup effect" or "worth nothing". */
  label: "not counted by this model";
  /** Where he would rank by weekly production among your roster with him added (1 = best). Absent for below-top. */
  rank_if_added?: number;
  roster_size_with_add?: number;
  lineup_slots: number;
  /** no-gain-from-add: the player he would replace and that player's rank among your roster (by the same production measure). */
  would_replace?: string;
  would_replace_rank?: number;
  /** breaks-slot: the required slots nobody on your roster could fill after the best-on-paper move. */
  empty_slots?: string[];
  /** Plain-words sentence to relay, including the model limit. */
  explanation: string;
}
export interface TradeSide { before_week_win_pct: number; after_week_win_pct: number; delta_points: number; categories_delta_points: MoveCategoryDelta; /** Required slots nobody can fill after the trade. Not recommended when this is not empty. */ empty_slots?: string[] }
export interface TradeOutput {
  mode: "evaluate" | "search";
  weeks_used: string[];
  games_source: "schedule" | "assumed";
  /** True when a week in `weeks_used` still has schedule games with a team to be announced. */
  schedule_incomplete: boolean;
  injury_notes: string[];
  you?: TradeSide;
  other_team?: TradeSide;
  offers?: { give: string; get: string; you: TradeSide; other_team: TradeSide }[];
  names: NameResult[];
  assumptions: string[];
}
export interface MatchupInput {
  /** A real opponent's roster. Omitted: typical opponents from simulated drafts. */
  opponent?: PlayerRef[];
  /** Players you start (names). Omitted: the model recommends the best lineup for the slots and uses it. */
  lineup?: string[];
  /** The user's own assumptions: a player out, or back on a given day, for either roster. Labelled as assumptions in the output. */
  scenarios?: Scenario[];
  /** Day-by-day lineups for the days left (issue #5). */
  daily?: import("./daily").DailyInput;
  /** Monday of the week (YYYY-MM-DD). Default: the week of the snapshot's generation date. */
  week_start?: string;
  /** Players who count each week (starters). Default: league.roster_spots. */
  lineup_slots?: number;
  /** Simulated weeks (default 10000). */
  weeks?: number;
  /**
   * The week is already under way: what each side has banked so far, and the share of the week's games still to play (0 to 1).
   * Needs a real `opponent`. Without it the whole week is simulated from 0-0.
   */
  so_far?: {
    you: BankedStats; opponent: BankedStats;
    /** Games each NBA team still plays this week, not yet in the banked stats (team code -> games). Preferred: each player gets his own team's games left. */
    games_left?: Record<string, number>;
    /** Fallback when `games_left` is not given: the share of games left (0 to 1), the same for every player. */
    remaining_share?: number;
  };
}
/** Stats already in the books this week. Made and attempted shots, not percentages. */
export interface BankedStats {
  pts: number; reb: number; ast: number; stl: number; blk: number; fg3m: number; tov: number;
  fgm: number; fga: number; ftm: number; fta: number;
}
export interface MatchupOutput {
  week_start: string | null;
  /** "schedule": games counted from the NBA schedule. "assumed": an average week (3.4 games) for everyone. */
  games_source: "schedule" | "assumed";
  /** True when the schedule for this week still has games with a team to be announced: some game counts may be low. */
  schedule_incomplete: boolean;
  opponent: "typical" | "roster";
  lineup_slots: number;
  weeks: number;
  /** True when the stats already banked this week were counted (`so_far`). */
  so_far_counted: boolean;
  /** Whole percent of simulated weeks you win each category. */
  categories: Record<Category, number>;
  /** Whole percent of simulated weeks you win 5 or more of 9. */
  week_win_pct: number;
  /** Whole percent of weeks you win exactly k categories, k = 0..9. */
  distribution_pct: number[];
  /** Who is on each roster, with his team's games this week (and left, when the week is under way). */
  rosters: { you: PlayerGames[]; opponent?: PlayerGames[] };
  /** "user": the lineup you gave. "recommended": the best fit for the slots, chosen by the model. */
  lineup_source: "user" | "recommended";
  /** When your lineup is not the best fit for the slots: the model's recommendation and what it would do. */
  recommended_lineup?: { players: { name: string; slot?: string }[]; week_win_pct: number };
  /** True when a scenario (the user's assumption) or an injury status changed anyone's games. */
  availability_applied: boolean;
  /** Day-by-day lineups for the days left (when `matchup.daily` was given). */
  daily?: import("./daily").DailyOutput;
  /** Exact win and tie chance (0 to 1), for programs: the whole-percent fields above are rounded. */
  week_win_prob: number;
  week_tie_prob: number;
  names: NameResult[];
  assumptions: string[];
}
export interface PlayerGames {
  name: string;
  team: string | null;
  /** Games his team plays this week (the average week when there is no schedule). */
  games: number;
  /** Games still to play, when `so_far.games_left` was given. */
  games_left?: number;
  /** True when he is in the counted lineup (your own, or the best fit for the slots); false for bench and IL. */
  counted: boolean;
  /** The lineup slot he fills (PG, SG, G, ..., UTIL) when the league has slots. */
  slot?: string;
  status?: "IL";
  /** Games lost to an injury window or a scenario this week (weighted when a ramp-up applies). */
  games_lost?: number;
  /** Where his availability comes from: your assumption, or the status read from the league page. */
  note?: string;
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
  /** Players left out because their name was not found or could be more than one player. Mention these first, ahead of any number. */
  warnings: string[];
  /** Plain list for the agent to speak from: strongest to weakest by percentile. */
  ranking: { category: Category; band: Band; percentile: number }[];
  matchup?: MatchupOutput;
  waiver?: WaiverOutput;
  trade?: TradeOutput;
  outlook?: import("./outlook").OutlookOutput;
}

function check(input: AnalyzeInput): void {
  const { teams, roster_spots } = input.league ?? ({} as AnalyzeInput["league"]);
  if (!Number.isInteger(teams) || teams < 4 || teams > 30) throw new Error("league.teams must be a whole number from 4 to 30");
  if (!Number.isInteger(roster_spots) || roster_spots < 5 || roster_spots > 20) throw new Error("league.roster_spots must be a whole number from 5 to 20 (active slots, not IL)");
  if (!Array.isArray(input.roster) || input.roster.length === 0) throw new Error("roster must list at least one player");
  if (input.roster.length > 40) throw new Error("roster has more than 40 players");
}

/** The entry point: the standard nine take the original path, any other category list goes to the any-category engine. */
export function analyzeLeague(input: AnalyzeInput, snapshotIn: Snapshot): AnalyzeOutput | AnyAnalyzeOutput {
  check(input);
  const snapshot = withScheduleDays(input, snapshotIn);
  const out = dispatch(input, snapshot);
  if (input.outlook) out.outlook = outlookFor(input, snapshot);
  return out;
}

/** Rest of season and playoffs: each week's win chance from the weekly simulation, then the season played out (outlook.ts). */
function outlookFor(input: AnalyzeInput, snapshot: Snapshot): OutlookOutput {
  const weekWin: WeekWin = (weekStart, roster, opponent, weeks) => {
    const o = analyzeLeague({
      ...input, outlook: undefined, waiver: undefined, trade: undefined, leagues: 30, roster,
      matchup: { week_start: weekStart, weeks, ...(opponent ? { opponent } : {}), ...(input.matchup?.lineup_slots ? { lineup_slots: input.matchup.lineup_slots } : {}) },
    }, snapshot) as { matchup: { week_win_prob: number; week_tie_prob?: number; games_source: "schedule" | "assumed" } };
    return { win: o.matchup.week_win_prob, tie: o.matchup.week_tie_prob ?? 0, source: o.matchup.games_source };
  };
  return runOutlook(input.outlook!, input.roster, weekWin, input.seed ?? 1);
}

function dispatch(input: AnalyzeInput, snapshot: Snapshot): AnalyzeOutput | AnyAnalyzeOutput {
  if (input.league.scoring && input.league.categories) throw new Error("give league.categories or league.scoring, not both");
  if (input.league.scoring) {
    const w = parseWeights(input.league.scoring);
    const out = analyzeAny(input, snapshot, Object.keys(w), w);
    const skipped = untrackedScoring(input.league.scoring);
    if (skipped.length) out.assumptions.push(`NOT SCORED: ${skipped.join(", ")}. We have no data for these rare events (about 0.4% of a typical week's points), so they are left out of every number here.`);
    return out;
  }
  if (input.league.categories) {
    const codes = parseCategories(input.league.categories);
    if (!isStandardNine(codes)) return analyzeAny(input, snapshot, codes);
  }
  return analyze(input, snapshot);
}

export function analyze(input: AnalyzeInput, snapshotIn: Snapshot): AnalyzeOutput {
  check(input);
  const snapshot = withScheduleDays(input, snapshotIn);
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
  const lineupSlots = lineupSetting(input, input.matchup?.lineup_slots ?? input.waiver?.lineup_slots ?? input.trade?.lineup_slots).slots;
  const benchmark = simulateBenchmark(sim, { teams, rosterSpots: roster_spots }, { leagues: input.leagues ?? 500, seed: input.seed ?? 1, lineupSlots });

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
    warnings: leftOutWarnings([names, matchup?.names, waiver?.names, trade?.names]),
    ...(matchup ? { matchup } : {}),
    ...(waiver ? { waiver } : {}),
    ...(trade ? { trade } : {}),
  };
}

/** One visible line per player left out of the numbers (not found, or could be several players), across every list of names. */
export function leftOutWarnings(lists: (NameResult[] | undefined)[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const n of lists.flatMap((l) => l ?? [])) {
    if (n.status === "matched" || seen.has(n.input)) continue;
    seen.add(n.input);
    out.push(n.status === "ambiguous"
      ? `WARNING: "${n.input}" could be ${n.candidates?.map((c) => c.name).join(", ") ?? "more than one player"}; left out of the numbers until you say which.`
      : `WARNING: "${n.input}" was not found; left out of the numbers.`);
  }
  return out;
}

/**
 * The lineup the user's league plays: a number of starters, or a list of slots. `slots` (count) is always set.
 * league.slots wins over lineup_slots; a lineup_slots that disagrees with it is refused rather than guessed.
 */
export function lineupSetting(input: AnalyzeInput, lineupSlots: number | undefined, label = "lineup_slots"): { slots: number; slotList?: string[] } {
  const { roster_spots } = input.league;
  if (input.league.slots) {
    const list = parseSlots(input.league.slots);
    if (lineupSlots !== undefined && lineupSlots !== list.length) throw new Error(`${label} (${lineupSlots}) does not match league.slots (${list.length} slots): give one or the other`);
    return { slots: list.length, slotList: list };
  }
  const slots = lineupSlots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20) throw new Error(`${label} must be a whole number from 1 to 20`);
  return { slots };
}

/** Today for injury windows: the user's `as_of`, else the snapshot's date. */
export const asOfOf = (input: AnalyzeInput, snapshot: Snapshot): string => input.as_of ?? snapshot.generated_at.slice(0, 10);

/** Snapshot with a day-by-day schedule from the request, when it has one. */
export function withScheduleDays(input: AnalyzeInput, snapshot: Snapshot): Snapshot {
  if (!input.schedule_days) return snapshot;
  return { ...snapshot, schedule: { source: snapshot.schedule?.source ?? "request", ...snapshot.schedule, days: input.schedule_days } };
}

/** Weekly head-to-head simulation (D12). Every player is estimated the same way as in the team assessment. */
function runMatchup(
  input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string,
  baseline: ReturnType<typeof buildBaseline>, mineNames: NameResult[],
): MatchupOutput {
  const m = input.matchup!;
  const { teams, roster_spots } = input.league;
  const { slots, slotList } = lineupSetting(input, m.lineup_slots, "matchup.lineup_slots");
  const lineupSlots: Slots = slotList ?? slots;
  const assumptions: string[] = [];
  const sf = m.so_far;
  if (sf) {
    if (!m.opponent || m.opponent.length === 0) throw new Error("matchup.so_far needs a real matchup.opponent");
    if (sf.games_left) {
      for (const [t, n] of Object.entries(sf.games_left))
        if (!(Number.isInteger(n) && n >= 0 && n <= 7)) throw new Error(`matchup.so_far.games_left: ${t} must be a whole number of games from 0 to 7`);
    } else if (!(sf.remaining_share! >= 0 && sf.remaining_share! <= 1))
      throw new Error("matchup.so_far needs games_left, or remaining_share between 0 and 1");
    for (const side of [sf.you, sf.opponent])
      for (const k of ["pts", "reb", "ast", "stl", "blk", "fg3m", "tov", "fgm", "fga", "ftm", "fta"] as const)
        if (!(typeof side?.[k] === "number" && side[k] >= 0)) throw new Error(`matchup.so_far: ${k} must be a number of 0 or more for both sides`);
  }

  // Games per team this week, from the schedule in the snapshot.
  const weekStart = m.week_start ?? mondayOf(snapshot.generated_at);
  const week = scheduleWeeks(snapshot).find((w) => w.start === weekStart);
  const gamesFor = (team: string | undefined): number => (week && team ? (week.games[team] ?? 0) : DEFAULT_WEEK_GAMES);
  const fromSchedule = Boolean(week);
  const tbd = week?.tbd_slots ?? 0;
  assumptions.push(
    fromSchedule
      ? `Games per player come from the NBA schedule for the week of ${weekStart}. Injuries and rest days are not modelled${m.scenarios?.length ? " except the scenarios you gave" : ""}.`
      : `No schedule for the week of ${weekStart} in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games. A real week with more or fewer games changes the picture.`,
  );

  // Everyone estimated once.
  const estimated = estimatePlayers(snapshot, reference, currentSeason, baseline);
  if (tbd > 0)
    assumptions.unshift(`WARNING: ${tbd} game slot(s) in the week of ${weekStart} are still "TBD" in the NBA schedule, so some teams' game counts may be too low. Check the real schedule and treat these numbers as rougher.`);
  const leftFor = (team: string | undefined): number => (sf?.games_left && team ? (sf.games_left[team] ?? 0) : 0);
  const ctx = {
    snapshot, estimated, gamesFor, weekStart: fromSchedule ? weekStart : null, asOf: asOfOf(input, snapshot), ramp: input.ramp,
    scenarios: m.scenarios ?? [], slots: lineupSlots, ...(sf?.games_left ? { leftFor } : {}), assumptions,
  };
  const toWeekly = (s: SideResult) => s.chosen.map((x) => ({ averages: x.entry.averages, games: x.games, value: x.entry.value, positions: x.positions }));
  const weeklyOf = (list: PlayerRef[], label: string, side: "you" | "opponent"): { totals: WeeklyTotals; remaining: WeeklyTotals; share: number; names: NameResult[]; rows: PlayerGames[]; res: SideResult } => {
    const res = resolveSide(list, label, side, { ...ctx, ...(side === "you" && m.lineup ? { lineup: m.lineup } : {}) });
    const players = toWeekly(res);
    const totals = weeklyTotals(players, lineupSlots);
    if (!sf) return { totals, remaining: totals, share: 1, names: res.names, rows: res.playerRows, res };
    if (!sf.games_left) return { totals, remaining: scaledTotals(totals, sf.remaining_share!), share: sf.remaining_share!, names: res.names, rows: res.playerRows, res };
    // Each player's remaining games are his own team games left. The lineup is the one that counts, as in weeklyTotals.
    const left = res.chosen.map((x, i) => ({ ...players[i]!, games: x.left }));
    const full = res.chosen.reduce((s, x) => s + x.games, 0), rest = res.chosen.reduce((s, x) => s + x.left, 0);
    return { totals, remaining: weeklyTotals(left, lineupSlots), share: full > 0 ? Math.min(1, rest / full) : 1, names: res.names, rows: res.playerRows, res };
  };

  const me = weeklyOf(input.roster, "your", "you");
  let opponents: WeeklyTotals[];
  let names = me.names;
  let opp: ReturnType<typeof weeklyOf> | undefined;
  if (m.opponent && m.opponent.length > 0) {
    const o = (opp = weeklyOf(m.opponent, "opponent", "opponent"));
    opponents = [o.totals];
    names = [...me.names, ...o.names.map((n) => ({ ...n, input: `${n.input} (opponent)` }))];
  } else {
    const pool = [...estimated.values()];
    opponents = typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 300, seed: input.seed ?? 1 });
    assumptions.push(
      `Typical opponents: ${opponents.length} teams from ${300} simulated ${teams}-team drafts, each playing its best ${slots} players. Positions are ignored for them${slotList ? "; your team uses the league's real slots" : ""}.`,
    );
  }
  const weeks = m.weeks ?? DEFAULT_WEEKS;
  const progressOf = (a: typeof me) => ({ me: { banked: sf!.you, remaining: a.remaining, share: a.share }, opponent: { banked: sf!.opponent, remaining: opp!.remaining, share: opp!.share } });
  const r = simulateWeeks(me.totals, opponents, {
    weeks, seed: input.seed ?? 1, slots,
    ...(sf && opp ? { progress: progressOf(me) } : {}),
  });
  let recommended: MatchupOutput["recommended_lineup"];
  if (me.res.recommended) {
    const altRes = resolveSide(input.roster, "your", "you", { ...ctx, assumptions: [] }); // same roster, model-chosen lineup
    const altTotals = weeklyTotals(toWeekly(altRes), lineupSlots);
    const altLeft = altRes.chosen.map((x, i) => ({ ...toWeekly(altRes)[i]!, games: x.left }));
    const altFull = altRes.chosen.reduce((s, x) => s + x.games, 0), altRest = altRes.chosen.reduce((s, x) => s + x.left, 0);
    const altSide = sf && opp
      ? { remaining: sf.games_left ? weeklyTotals(altLeft, lineupSlots) : scaledTotals(altTotals, sf.remaining_share!), share: sf.games_left ? (altFull > 0 ? Math.min(1, altRest / altFull) : 1) : sf.remaining_share! }
      : undefined;
    const ra = simulateWeeks(altTotals, opponents, {
      weeks, seed: input.seed ?? 1, slots,
      ...(sf && opp && altSide ? { progress: progressOf({ ...me, remaining: altSide.remaining, share: altSide.share }) } : {}),
    });
    recommended = { players: altRes.chosen.map((x) => ({ name: x.entry.name, ...(altRes.slotOf.has(x) ? { slot: altRes.slotOf.get(x) } : {}) })), week_win_pct: Math.round(ra.weekWin * 100) };
    assumptions.push(`Your lineup is not the best fit for the slots by this model. The recommendation is shown with its win chance; the numbers above use the lineup you gave.`);
  }
  if (sf)
    assumptions.push(
      sf.games_left
        ? `The week is under way: stats already banked are kept, and the games still to play (your lineup has ${Math.round(me.share * 100)}% of its week left, theirs ${Math.round(opp!.share * 100)}%) are simulated from each player's own team games left, per-game averages and luck. Games in progress or already counted by the league site must not be in the games left.`
        : `The week is under way: stats already banked are kept, and the remaining ${Math.round(sf.remaining_share! * 100)}% of each team's games are simulated from per-game averages plus luck. Every player is assumed to have that same share of his week left, which is rough when a team's games are lopsided.`,
    );
  const availabilityApplied = [...me.res.rows, ...(opp?.res.rows ?? [])].some((x) => x.lost > 0 || x.av);
  if (availabilityApplied)
    assumptions.push("Some players' games were changed by an injury status read from the league page or by a scenario you gave. Scenarios and a return day are your assumptions, not measured facts; a ramp-up after a return (default 80% output for 3 games) is also an assumption.");
  let daily: MatchupOutput["daily"];
  if (m.daily) {
    if (m.daily.from && m.daily.from > weekStart && !sf) throw new Error("matchup.daily.from is later than the week's start: give matchup.so_far with the stats already banked");
    const zero = (): WeeklyTotals => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
    const engine: DailyEngine<WeeklyTotals> = {
      empty: zero,
      plus: (x, y) => { const o = zero(); for (const k of Object.keys(o) as (keyof WeeklyTotals)[]) o[k] = x[k] + y[k]; return o; },
      dayTotals: (ps) => weeklyTotals(ps.map((p) => ({ averages: p.entry.averages, games: p.weight, value: p.entry.value, positions: p.positions })), lineupSlots),
      win: (remaining, share, n) => simulateWeeks(sf ? me.totals : remaining, opponents, {
        weeks: n, seed: input.seed ?? 1, slots,
        ...(sf && opp ? { progress: { me: { banked: sf.you, remaining, share }, opponent: { banked: sf.opponent, remaining: opp.remaining, share: opp.share } } } : {}),
      }).weekWin,
    };
    daily = runDaily(input, snapshot, m, { me: me.res, weekStart, lineupSlots, weeks, engine, estimated, gamesFor, asOf: ctx.asOf, hasBanked: Boolean(sf), assumptions });
  }
  assumptions.push(
    `Week-to-week luck is measured on 2025-26 weekly results after removing game counts. ${weeks} simulated weeks, fixed seed, so the same inputs give the same answer. ` +
      `The simulation does not model ${availabilityApplied ? "other injuries, " : "injuries, "}lineup moves or streaming during the week${daily ? " except in the daily section" : ""}.`,
  );
  const pct = (x: number) => Math.round(x * 100);
  return {
    week_start: week ? weekStart : null,
    games_source: fromSchedule ? "schedule" : "assumed",
    schedule_incomplete: tbd > 0,
    opponent: m.opponent && m.opponent.length > 0 ? "roster" : "typical",
    lineup_slots: slots,
    weeks,
    so_far_counted: Boolean(sf),
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, pct(r.categories[c])])) as Record<Category, number>,
    week_win_pct: pct(r.weekWin),
    distribution_pct: r.distribution.map(pct),
    rosters: { you: me.rows, ...(opp ? { opponent: opp.rows } : {}) },
    lineup_source: m.lineup && m.lineup.length > 0 ? "user" : "recommended",
    ...(recommended ? { recommended_lineup: recommended } : {}),
    availability_applied: availabilityApplied,
    ...(daily ? { daily } : {}),
    week_win_prob: r.weekWin,
    week_tie_prob: 0,
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
    out.set(p.id, { id: p.id, name: p.name, averages: e.averages, team: p.team, value: CATEGORIES.reduce((t, c) => t + z[c], 0), confidence: e.confidence, effectiveGames: e.effectiveGames });
  }
  return out;
}

export interface MoveSetup {
  env: MoveEnv;
  estimated: Map<number, Entry>;
  weeksUsed: string[];
  gamesSource: "schedule" | "assumed";
  scheduleIncomplete: boolean;
  assumptions: string[];
}

/** The weeks, schedule, typical opponents and replacement player shared by the waiver and trade tools. */
function moveSetup(
  input: AnalyzeInput, common: { lineup_slots?: number; horizon_weeks?: number; weeks?: number },
  snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>,
): MoveSetup {
  const { teams, roster_spots } = input.league;
  const { slots, slotList } = lineupSetting(input, common.lineup_slots);
  const horizon = Math.max(1, Math.min(4, common.horizon_weeks ?? 2));
  const simWeeks = common.weeks ?? 6000;
  const estimated = estimatePlayers(snapshot, reference, currentSeason, baseline);
  const pool = [...estimated.values()].sort((a, b) => b.value - a.value);
  if (pool.length < teams * roster_spots) throw new Error(`snapshot has only ${pool.length} players; need at least ${teams * roster_spots}`);
  const replacement = pool[teams * roster_spots - 1]!;

  const first = mondayOf(snapshot.generated_at);
  const scheduled = (scheduleWeeks(snapshot)).filter((w) => w.start >= first).slice(0, horizon);
  const assumptions: string[] = [];
  const seed = input.seed ?? 1;
  const mk = (start: string | null, games: Record<string, number> | null): WeekEnv => {
    const gamesFor = (team?: string) => (games && team ? (games[team] ?? 0) : DEFAULT_WEEK_GAMES);
    const gamesOf = (e: Entry) => (e.avail && start && games ? gamesWithAvailability(snapshot, e.team, start, gamesFor(e.team), e.avail).games : gamesFor(e.team));
    return { start, gamesFor, gamesOf, opponents: typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 150, seed }) };
  };
  const weeks = scheduled.length > 0 ? scheduled.map((w) => mk(w.start, w.games)) : [mk(null, null)];
  const gamesSource = scheduled.length > 0 ? "schedule" : "assumed";
  for (const w of scheduled) if (w.tbd_slots) assumptions.push(`WARNING: ${w.tbd_slots} game slot(s) in the week of ${w.start} are still "TBD" in the NBA schedule, so some teams' game counts may be too low.`);
  assumptions.push(
    gamesSource === "schedule"
      ? `Averaged over ${weeks.length} week(s) starting ${weeks[0]!.start}, counting each player's real games from the NBA schedule.`
      : `No schedule in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`,
    `Each score is a weekly win chance against typical opponents (${weeks[0]!.opponents.length} teams from simulated ${teams}-team drafts, positions ignored for them), ${simWeeks} simulated weeks with a fixed seed. ` +
      `A move is scored by re-running the same weeks with the roster changed, so the difference is the move's effect. Injuries, rest days and lineup moves during the week are not modelled (except an injury status read from the league page, below). An empty lineup spot is filled by a replacement-level player.` +
      (slotList ? ` Your lineup uses the league's slots (${slotList.join(" ")}); each week the best-fitting lineup is used.` : ""),
  );
  return { env: { slots, ...(slotList ? { slotList } : {}), weeks, simWeeks, seed, replacement }, estimated, weeksUsed: weeks.map((w) => w.start ?? "assumed"), gamesSource, scheduleIncomplete: scheduled.some((w) => (w.tbd_slots ?? 0) > 0), assumptions };
}

export interface ResolveCtx { asOf: string; ramp?: { games: number; share: number } | false; notes: string[] }

export function resolveList(
  list: PlayerRef[], snapshot: Snapshot, estimated: Map<number, Entry>, names: NameResult[], suffix = "", ctx?: ResolveCtx,
): Entry[] {
  const out: Entry[] = [];
  for (const r of list) {
    const hit = resolvePlayer(r.name, snapshot.players);
    if (hit.status === "matched") {
      names.push({ input: r.name + suffix, status: "matched", matched: hit.player.name });
      const e = estimated.get(hit.player.id);
      if (e && r.status !== "IL") {
        const positions = parsePositions(r.positions);
        let avail: Entry["avail"];
        if (ctx) {
          const h = availabilityFromHost(r.injury, r.return_date, ctx.asOf, ctx.ramp === false ? null : (ctx.ramp ?? DEFAULT_RAMP));
          avail = h.av;
          if (h.flag) ctx.notes.push(`${hit.player.name}: ${h.flag}`);
        }
        out.push(positions || avail ? { ...e, ...(positions ? { positions } : {}), ...(avail ? { avail } : {}) } : e);
      }
    } else if (hit.status === "ambiguous") {
      names.push({ input: r.name + suffix, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
    } else names.push({ input: r.name + suffix, status: "not_found" });
  }
  return out;
}

export const pct1 = (x: number) => Math.round(x * 1000) / 10;
const catDelta = (d: Record<Category, number>): MoveCategoryDelta => Object.fromEntries(CATEGORIES.map((c) => [c, pct1(d[c])]));
const side = (b: Score, a: Score, delta: number, cd: Record<Category, number>, empty: string[] = []): TradeSide => ({
  before_week_win_pct: Math.round(b.weekWin * 100), after_week_win_pct: Math.round(a.weekWin * 100), delta_points: pct1(delta), categories_delta_points: catDelta(cd),
  ...(empty.length ? { empty_slots: empty } : {}),
});

function runWaiver(input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>): WaiverOutput {
  const w = input.waiver!;
  if (!Array.isArray(w.candidates) || w.candidates.length === 0) throw new Error("waiver.candidates must list at least one available player");
  if (w.candidates.length > 60) throw new Error("waiver.candidates has more than 60 players; send the best available");
  return waiverWith(input, snapshot, moveSetup(input, w, snapshot, reference, currentSeason, baseline));
}

const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
const MODEL_LIMIT = "This model counts a bench player as sitting all week; it does not model days when starters are off, so any value he would give on those days is not counted.";

/** Plain-words description of a candidate the ranking did not score. Wording and output fields only: the ranking is unchanged. */
export function explainUnranked(u: { add: { name: string; value: number }; reason: NotRanked["reason"]; drop?: { name: string; value: number } | null; empty_slots?: string[] }, roster: { id?: number; name: string; value: number }[], slots: number): NotRanked {
  const base = { add: u.add.name, reason: u.reason, label: "not counted by this model" as const, lineup_slots: slots };
  if (u.reason === "below-top") {
    return { ...base, explanation: `${u.add.name} would help, but less than the moves listed; ask for a longer list to see him.` };
  }
  if (u.reason === "breaks-slot") {
    const e = u.empty_slots ?? [];
    return { ...base, empty_slots: e, explanation: `Not recommended: every drop that makes room for ${u.add.name} would leave your ${e.join(", ")} slot${e.length === 1 ? "" : "s"} with nobody eligible. Your league requires those slots to be filled.` };
  }
  const size = roster.length + 1;
  const rank = 1 + roster.filter((p) => p.value > u.add.value).length;
  const r = { ...base, rank_if_added: rank, roster_size_with_add: size };
  if (u.reason === "bench-only") {
    return { ...r, explanation: `He would rank ${ord(rank)} of ${size} on your roster by weekly production, outside your ${slots} counted lineup spots, so this model counts him as a bench player. ${MODEL_LIMIT}` };
  }
  if (u.drop === null) return { ...r, explanation: `He would fit on an open roster spot with nobody dropped, but in this model he does not improve your weekly win chance. ${MODEL_LIMIT}` };
  const drop = u.drop!;
  const dropRank = 1 + roster.filter((p) => p.value > drop.value).length + (u.add.value > drop.value ? 1 : 0);
  return { ...r, would_replace: drop.name, would_replace_rank: dropRank, explanation: `He would rank ${ord(rank)} of ${size} by weekly production. The player he would most plausibly replace, ${drop.name}, ranks ${ord(dropRank)}; in this model the swap does not improve your weekly win chance (his counted production is not above what you give up). ${MODEL_LIMIT}` };
}

/**
 * Players the league lets into an injured-list slot (their host status is one of `il_eligible_statuses`) move there while IL
 * slots are open, which frees their roster spots (grilling Q9: the league's own settings decide who is eligible).
 */
export function planIL(input: AnalyzeInput, ilOpenGiven?: number): { roster: PlayerRef[]; moved: string[]; openSpots: number } {
  const { roster_spots, il_slots, il_eligible_statuses } = input.league;
  const inIL = input.roster.filter((r) => r.status === "IL").length;
  let open = ilOpenGiven ?? (il_slots !== undefined ? Math.max(0, il_slots - inIL) : 0);
  const eligible = new Set((il_eligible_statuses ?? []).map((s) => s.trim().toUpperCase()));
  const moved: string[] = [];
  const roster = input.roster.map((r) => {
    if (r.status !== "IL" && open > 0 && r.injury && eligible.has(r.injury.trim().toUpperCase())) { open--; moved.push(r.name); return { ...r, status: "IL" as const }; }
    return r;
  });
  const active = roster.filter((r) => r.status !== "IL").length;
  return { roster, moved, openSpots: Math.max(0, roster_spots - active) };
}

/** The waiver ranking for a prepared environment (shared by the nine-category and any-category paths). */
export function waiverWith(input: AnalyzeInput, snapshot: Snapshot, st: MoveSetup): WaiverOutput {
  const w = input.waiver!;
  const names: NameResult[] = [];
  const notes: string[] = [];
  const asOf = asOfOf(input, snapshot);
  const plan = planIL(input, w.il_open);
  const ctx: ResolveCtx = { asOf, ramp: input.ramp, notes };
  const roster = resolveList(plan.roster, snapshot, st.estimated, names, "", ctx);
  const mine = new Set(roster.map((p) => p.id));
  const cands = resolveList(w.candidates, snapshot, st.estimated, names, " (available)", ctx).filter((p) => !mine.has(p.id));
  if (roster.length === 0) throw new Error("none of the roster players could be matched");
  const extra: string[] = [];
  const slotMode = Boolean(st.env.slotList);
  const noPos = roster.filter((p) => !p.positions).map((p) => p.name);
  const checkSlots = slotMode && noPos.length === 0;
  if (slotMode && noPos.length > 0) extra.push(`WARNING: no positions were given for ${noPos.join(", ")}, so they can only fill a UTIL slot and the check that a move leaves no required slot empty is OFF. Give each player's positions from your league page.`);
  const noPosC = cands.filter((p) => !p.positions).map((p) => p.name);
  if (slotMode && noPosC.length > 0) extra.push(`WARNING: no positions were given for ${noPosC.length} available player(s) (${noPosC.slice(0, 5).join(", ")}${noPosC.length > 5 ? ", ..." : ""}): they can only fill a UTIL slot.`);
  if (plan.moved.length > 0) extra.push(`Assumed moved to your injured list (the league lets their status in, and slots are open): ${plan.moved.join(", ")}. That frees ${plan.moved.length} roster spot(s).`);
  const env = { ...st.env, openSpots: plan.openSpots, checkSlots };
  const { baseline: base, moves, unranked } = rankWaiverMoves(roster, cands, env, { top: w.top ?? 8 });
  const winPct = (x: number) => Math.round(x * 100);
  let bestUse: WaiverOutput["best_use_of_adds"];
  if (w.adds_left !== undefined) {
    if (!Number.isInteger(w.adds_left) || w.adds_left < 0) throw new Error("waiver.adds_left must be a whole number of 0 or more");
    if (w.adds_left === 0) bestUse = { adds_left: 0, moves: [], week_win_pct: winPct(base.weekWin), delta_points: 0, note: "You have no adds left this week. The ranked moves below can wait for next week." };
    else {
      // Greedy, measured: apply the best move, re-rank the rest against the changed roster, repeat. The combined roster is re-simulated at the end.
      let cur = roster, left = cands.slice(), spots = plan.openSpots;
      const picked: { add: Entry; drop: Entry | null }[] = [];
      for (let i = 0; i < Math.min(w.adds_left, 5); i++) {
        const r = rankWaiverMoves(cur, left, { ...env, openSpots: spots }, { top: 1 });
        const m = r.moves[0];
        if (!m) break;
        picked.push({ add: m.add, drop: m.drop });
        cur = (m.drop ? cur.filter((p) => p.id !== m.drop!.id) : cur).concat(m.add);
        if (!m.drop) spots--;
        left = left.filter((p) => p.id !== m.add.id);
      }
      const after = scoreRoster(cur, env);
      bestUse = {
        adds_left: w.adds_left, moves: picked.map((p) => ({ add: p.add.name, drop: p.drop?.name ?? null })),
        week_win_pct: winPct(after.weekWin), delta_points: pct1(after.weekWin - base.weekWin),
        ...(moves.length > w.adds_left ? { note: `You have ${w.adds_left} add(s) left and ${moves.length} ranked moves: this is the best group of moves within your adds, chosen by re-simulating the combined roster.` } : {}),
      };
    }
  }
  return {
    weeks_used: st.weeksUsed, games_source: st.gamesSource, schedule_incomplete: st.scheduleIncomplete,
    baseline_week_win_pct: winPct(base.weekWin),
    moves: moves.map((m) => ({
      add: m.add.name, drop: m.drop?.name ?? null, week_win_pct: winPct(m.after.weekWin),
      delta_points: pct1(m.delta), drop_only_points: pct1(m.dropOnlyDelta), add_effect_points: pct1(m.addDelta),
      add_confidence: m.add.confidence ?? "none", add_games_basis: Math.round(m.add.effectiveGames ?? 0), categories_delta_points: catDelta(m.categoryDelta),
    })),
    ...(bestUse ? { best_use_of_adds: bestUse } : {}),
    il_moves: plan.moved, open_spots: plan.openSpots, injury_notes: notes,
    not_ranked: unranked.map((u) => explainUnranked(u, roster, st.env.slots)),
    names, assumptions: [...st.assumptions, ...extra, "Moves are ranked by what the added player contributes beyond the drop. A player who would not enter your lineup, or who adds nothing beyond removing the drop, is listed as not ranked."],
  };
}

function runTrade(input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>): TradeOutput {
  return tradeWith(input, snapshot, moveSetup(input, input.trade!, snapshot, reference, currentSeason, baseline));
}

/** The trade evaluation or search for a prepared environment. */
export function tradeWith(input: AnalyzeInput, snapshot: Snapshot, st: MoveSetup): TradeOutput {
  const t = input.trade!;
  const names: NameResult[] = [];
  const notes: string[] = [];
  const ctx: ResolveCtx = { asOf: asOfOf(input, snapshot), ramp: input.ramp, notes };
  const mine = resolveList(input.roster, snapshot, st.estimated, names, "", ctx);
  const theirs = t.other_roster ? resolveList(t.other_roster, snapshot, st.estimated, names, " (other team)", ctx) : [];
  if (mine.length === 0) throw new Error("none of the roster players could be matched");
  const slotMode = Boolean(st.env.slotList);
  const noPos = [...mine, ...theirs].filter((p) => !p.positions).map((p) => p.name);
  const checkSlots = slotMode && noPos.length === 0;
  const env = { ...st.env, checkSlots };
  const slotNote = slotMode ? [checkSlots ? "Trades that would leave a required lineup slot with nobody eligible are not recommended." : `WARNING: no positions were given for ${noPos.slice(0, 6).join(", ")}${noPos.length > 6 ? ", ..." : ""}, so they only fill UTIL and the check for empty required slots is OFF.`] : [];
  const base = { weeks_used: st.weeksUsed, games_source: st.gamesSource, schedule_incomplete: st.scheduleIncomplete, injury_notes: notes, names };
  if (t.search) {
    if (theirs.length === 0) throw new Error("trade.search needs trade.other_roster");
    const offers = searchTrades(mine, theirs, env, { top: t.top ?? 5 });
    return {
      mode: "search", ...base,
      offers: offers.map((o) => ({
        give: o.give.name, get: o.get.name,
        you: side(o.mine.before, o.mine.after, o.mine.delta, o.mine.categoryDelta, o.mine.emptySlots),
        other_team: side(o.theirs.before, o.theirs.after, o.theirs.delta, o.theirs.categoryDelta, o.theirs.emptySlots),
      })),
      assumptions: [...st.assumptions, ...slotNote, "Offers are one-for-one swaps that raise your weekly win chance without lowering the other team's. They model the two rosters only: what the other owner actually values, and positions, are not modelled."],
    };
  }
  if (!t.give?.length || !t.get?.length) throw new Error("trade needs give and get (or search with other_roster)");
  const give = resolveList(t.give, snapshot, st.estimated, names, " (give)");
  const get = resolveList(t.get, snapshot, st.estimated, names, " (get)", ctx);
  // An IL player is not in `mine` (he counts for nothing), but he can still be given away.
  const myIds = new Set(resolveList(input.roster.map((r) => ({ name: r.name })), snapshot, st.estimated, []).map((p) => p.id));
  const notMine = give.filter((p) => !myIds.has(p.id));
  if (notMine.length > 0) throw new Error(`you do not have: ${notMine.map((p) => p.name).join(", ")}`);
  const you = evaluateTrade(mine, give, get, env);
  const out: TradeOutput = { mode: "evaluate", ...base, you: side(you.before, you.after, you.delta, you.categoryDelta, you.emptySlots), assumptions: [...st.assumptions, ...slotNote] };
  if (theirs.length > 0) {
    const them = evaluateTrade(theirs, get, give, env);
    out.other_team = side(them.before, them.after, them.delta, them.categoryDelta, them.emptySlots);
  }
  return out;
}
