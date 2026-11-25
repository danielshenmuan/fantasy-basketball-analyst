import { analyzeAny, type AnyAnalyzeOutput } from "./analyzeAny";
import { isStandardNine, parseCategories, parseWeights } from "./anycat";
import { assessTeam, type RosterPlayer, type TeamAssessment } from "./assess";
import { blendBaselines, blendWeight, buildBaseline } from "./baseline";
import { categoryZ } from "./fantasyValue";
import { simulateBenchmark, type SimPlayer } from "./simulate";
import { historyOf, resolvePlayer, type Snapshot } from "./snapshot";
import { estimateAverages, seasonLabel, startYear } from "./history";
import { evaluateTrade, rankWaiverMoves, scoreRoster, searchTrades, type Entry, type MoveEnv, type Score, type WeekEnv } from "./moves";
import {
  DEFAULT_WEEKS, DEFAULT_WEEK_GAMES, mondayOf, scaledTotals, simulateWeeks, typicalOpponents, weeklyTotals,
  type DraftablePlayer, type WeeklyPlayer, type WeeklyTotals,
} from "./matchup";
import { CATEGORIES, type Band, type Category, type PlayerSeason } from "./types";

export interface AnalyzeInput {
  /** `categories`: the league's scoring categories as the host names them ("Points", "3-pointers made", "Double-doubles"). Omit for the standard nine. */
  league: { teams: number; roster_spots: number; categories?: string[]; /** Head-to-head points league: the host's stat names and what each is worth (negative for a penalty). Use instead of `categories`. */ scoring?: Record<string, number> };
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
  /** Ranked by what the added player contributes beyond the drop (`add_effect_points`). Every move here enters the lineup. */
  moves: {
    add: string; drop: string; week_win_pct: number;
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
  /** Candidates not ranked: they would sit on the bench (no lineup effect), or add nothing beyond the drop. */
  not_ranked: { add: string; reason: "bench-only" | "no-gain-from-add" | "below-top" }[];
  /** True when a week in `weeks_used` still has schedule games with a team to be announced. */
  schedule_incomplete: boolean;
  names: NameResult[];
  assumptions: string[];
}
export interface TradeSide { before_week_win_pct: number; after_week_win_pct: number; delta_points: number; categories_delta_points: MoveCategoryDelta }
export interface TradeOutput {
  mode: "evaluate" | "search";
  weeks_used: string[];
  games_source: "schedule" | "assumed";
  /** True when a week in `weeks_used` still has schedule games with a team to be announced. */
  schedule_incomplete: boolean;
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
  /** True when he is in the counted lineup (best `lineup_slots` by value); false for bench and IL. */
  counted: boolean;
  status?: "IL";
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

/** The entry point: the standard nine take the original path, any other category list goes to the any-category engine. */
export function analyzeLeague(input: AnalyzeInput, snapshot: Snapshot): AnalyzeOutput | AnyAnalyzeOutput {
  check(input);
  if (input.league.scoring && input.league.categories) throw new Error("give league.categories or league.scoring, not both");
  if (input.league.scoring) {
    const w = parseWeights(input.league.scoring);
    return analyzeAny(input, snapshot, Object.keys(w), w);
  }
  if (input.league.categories) {
    const codes = parseCategories(input.league.categories);
    if (!isStandardNine(codes)) return analyzeAny(input, snapshot, codes);
  }
  return analyze(input, snapshot);
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
  const week = snapshot.schedule?.weeks.find((w) => w.start === weekStart);
  const gamesFor = (team: string | undefined): number => (week && team ? (week.games[team] ?? 0) : DEFAULT_WEEK_GAMES);
  const fromSchedule = Boolean(week);
  const tbd = week?.tbd_slots ?? 0;
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
  if (tbd > 0)
    assumptions.unshift(`WARNING: ${tbd} game slot(s) in the week of ${weekStart} are still "TBD" in the NBA schedule, so some teams' game counts may be too low. Check the real schedule and treat these numbers as rougher.`);
  const leftFor = (team: string | undefined): number => (sf?.games_left && team ? (sf.games_left[team] ?? 0) : 0);
  const weeklyOf = (list: { name: string; status?: "IL" | "active" }[], label: string): { totals: WeeklyTotals; remaining: WeeklyTotals; share: number; names: NameResult[]; rows: PlayerGames[] } => {
    const names: NameResult[] = [];
    const rows: (PlayerGames & { value: number })[] = [];
    const players: WeeklyPlayer[] = [];
    const lefts: number[] = [];
    for (const r of list) {
      const hit = resolvePlayer(r.name, snapshot.players);
      if (hit.status === "matched") {
        names.push({ input: r.name, status: "matched", matched: hit.player.name });
        const e = estimated.get(hit.player.id);
        if (e) rows.push({ name: hit.player.name, team: e.team ?? null, games: gamesFor(e.team), ...(sf?.games_left ? { games_left: leftFor(e.team) } : {}), counted: false, ...(r.status === "IL" ? { status: "IL" as const } : {}), value: e.value });
        if (r.status !== "IL" && e) { players.push({ averages: e.averages, games: gamesFor(e.team), value: e.value }); lefts.push(leftFor(e.team)); }
      } else if (hit.status === "ambiguous") {
        names.push({ input: r.name, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
      } else names.push({ input: r.name, status: "not_found" });
    }
    const missing = names.filter((n) => n.status !== "matched").length;
    if (missing > 0) assumptions.push(`${missing} player(s) in the ${label} roster could not be matched and are left out of the weekly totals.`);
    const totals = weeklyTotals(players, slots);
    const counted = new Set(rows.filter((x) => x.status !== "IL").sort((a, b) => b.value - a.value).slice(0, slots));
    const out = rows.map(({ value: _v, ...x }, i) => ({ ...x, counted: counted.has(rows[i]!) })).sort((a, b) => Number(b.counted) - Number(a.counted) || b.games - a.games);
    if (!sf) return { totals, remaining: totals, share: 1, names, rows: out };
    if (!sf.games_left) return { totals, remaining: scaledTotals(totals, sf.remaining_share!), share: sf.remaining_share!, names, rows: out };
    // Each player's remaining games are his own team's games left. The lineup is the best `slots` by value, as in weeklyTotals.
    const left = players.map((p, i) => ({ ...p, games: lefts[i]! }));
    const lineup = players.map((p, i) => ({ p, i })).sort((a, b) => b.p.value - a.p.value).slice(0, slots);
    const full = lineup.reduce((t, x) => t + x.p.games, 0), rest = lineup.reduce((t, x) => t + lefts[x.i]!, 0);
    return { totals, remaining: weeklyTotals(left, slots), share: full > 0 ? Math.min(1, rest / full) : 1, names, rows: out };
  };

  const me = weeklyOf(input.roster, "your");
  let opponents: WeeklyTotals[];
  let names = me.names;
  let opp: ReturnType<typeof weeklyOf> | undefined;
  if (m.opponent && m.opponent.length > 0) {
    const o = (opp = weeklyOf(m.opponent, "opponent"));
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
  const r = simulateWeeks(me.totals, opponents, {
    weeks, seed: input.seed ?? 1, slots,
    ...(sf && opp ? { progress: {
      me: { banked: sf.you, remaining: me.remaining, share: me.share },
      opponent: { banked: sf.opponent, remaining: opp.remaining, share: opp.share },
    } } : {}),
  });
  if (sf)
    assumptions.push(
      sf.games_left
        ? `The week is under way: stats already banked are kept, and the games still to play (your lineup has ${Math.round(me.share * 100)}% of its week left, theirs ${Math.round(opp!.share * 100)}%) are simulated from each player's own team games left, per-game averages and luck. Games in progress or already counted by the league site must not be in the games left.`
        : `The week is under way: stats already banked are kept, and the remaining ${Math.round(sf.remaining_share! * 100)}% of each team's games are simulated from per-game averages plus luck. Every player is assumed to have that same share of his week left, which is rough when a team's games are lopsided.`,
    );
  assumptions.push(
    `Week-to-week luck is measured on 2025-26 weekly results after removing game counts. ${weeks} simulated weeks, fixed seed, so the same inputs give the same answer. ` +
      `The simulation does not model injuries, lineup moves or streaming during the week.`,
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
  for (const w of scheduled) if (w.tbd_slots) assumptions.push(`WARNING: ${w.tbd_slots} game slot(s) in the week of ${w.start} are still "TBD" in the NBA schedule, so some teams' game counts may be too low.`);
  assumptions.push(
    gamesSource === "schedule"
      ? `Averaged over ${weeks.length} week(s) starting ${weeks[0]!.start}, counting each player's real games from the NBA schedule.`
      : `No schedule in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`,
    `Each score is a weekly win chance against typical opponents (${weeks[0]!.opponents.length} teams from simulated ${teams}-team drafts, positions ignored), ${simWeeks} simulated weeks with a fixed seed. ` +
      `A move is scored by re-running the same weeks with the roster changed, so the difference is the move's effect. Injuries, rest days and lineup moves during the week are not modelled. An empty lineup spot is filled by a replacement-level player.`,
  );
  return { env: { slots, weeks, simWeeks, seed, replacement }, estimated, weeksUsed: weeks.map((w) => w.start ?? "assumed"), gamesSource, scheduleIncomplete: scheduled.some((w) => (w.tbd_slots ?? 0) > 0), assumptions };
}

export function resolveList(
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

export const pct1 = (x: number) => Math.round(x * 1000) / 10;
const catDelta = (d: Record<Category, number>): MoveCategoryDelta => Object.fromEntries(CATEGORIES.map((c) => [c, pct1(d[c])]));
const side = (b: Score, a: Score, delta: number, cd: Record<Category, number>): TradeSide => ({
  before_week_win_pct: Math.round(b.weekWin * 100), after_week_win_pct: Math.round(a.weekWin * 100), delta_points: pct1(delta), categories_delta_points: catDelta(cd),
});

function runWaiver(input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>): WaiverOutput {
  const w = input.waiver!;
  if (!Array.isArray(w.candidates) || w.candidates.length === 0) throw new Error("waiver.candidates must list at least one available player");
  if (w.candidates.length > 60) throw new Error("waiver.candidates has more than 60 players; send the best available");
  return waiverWith(input, snapshot, moveSetup(input, w, snapshot, reference, currentSeason, baseline));
}

/** The waiver ranking for a prepared environment (shared by the nine-category and any-category paths). */
export function waiverWith(input: AnalyzeInput, snapshot: Snapshot, st: MoveSetup): WaiverOutput {
  const w = input.waiver!;
  const names: NameResult[] = [];
  const roster = resolveList(input.roster, snapshot, st.estimated, names);
  const mine = new Set(roster.map((p) => p.id));
  const cands = resolveList(w.candidates, snapshot, st.estimated, names, " (available)").filter((p) => !mine.has(p.id));
  if (roster.length === 0) throw new Error("none of the roster players could be matched");
  const { baseline: base, moves, unranked } = rankWaiverMoves(roster, cands, st.env, { top: w.top ?? 8 });
  return {
    weeks_used: st.weeksUsed, games_source: st.gamesSource, schedule_incomplete: st.scheduleIncomplete,
    baseline_week_win_pct: Math.round(base.weekWin * 100),
    moves: moves.map((m) => ({
      add: m.add.name, drop: m.drop.name, week_win_pct: Math.round(m.after.weekWin * 100),
      delta_points: pct1(m.delta), drop_only_points: pct1(m.dropOnlyDelta), add_effect_points: pct1(m.addDelta),
      add_confidence: m.add.confidence ?? "none", add_games_basis: Math.round(m.add.effectiveGames ?? 0), categories_delta_points: catDelta(m.categoryDelta),
    })),
    not_ranked: unranked.map((u) => ({ add: u.add.name, reason: u.reason })),
    names, assumptions: [...st.assumptions, "Moves are ranked by what the added player contributes beyond the drop. A player who would not enter your lineup, or who adds nothing beyond removing the drop, is listed as not ranked."],
  };
}

function runTrade(input: AnalyzeInput, snapshot: Snapshot, reference: string, currentSeason: string, baseline: ReturnType<typeof buildBaseline>): TradeOutput {
  return tradeWith(input, snapshot, moveSetup(input, input.trade!, snapshot, reference, currentSeason, baseline));
}

/** The trade evaluation or search for a prepared environment. */
export function tradeWith(input: AnalyzeInput, snapshot: Snapshot, st: MoveSetup): TradeOutput {
  const t = input.trade!;
  const names: NameResult[] = [];
  const mine = resolveList(input.roster, snapshot, st.estimated, names);
  const theirs = t.other_roster ? resolveList(t.other_roster, snapshot, st.estimated, names, " (other team)") : [];
  if (mine.length === 0) throw new Error("none of the roster players could be matched");
  const base = { weeks_used: st.weeksUsed, games_source: st.gamesSource, schedule_incomplete: st.scheduleIncomplete, names };
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
