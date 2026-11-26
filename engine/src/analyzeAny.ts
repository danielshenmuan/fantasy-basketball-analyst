import {
  anyTotals, anyValue, pointsOf, simulatePoints, type PointsSide, type Weights, baseOf, categoryValue, isLowerCategory, buildAnyBaseline, neededStats, scaledAny, simulateAny, typicalAnyOpponents,
  type AnyPlayer, type AnyTotals, type AnySide, type Baseline, type BaseKey, type BaseTotals, type PlayerBase,
} from "./anycat";
import {
  resolveList, tradeWith, waiverWith, type AnalyzeInput, type MoveSetup, type NameResult, type PlayerGames,
  type TradeOutput, type WaiverOutput,
  leftOutWarnings,
} from "./analyze";
import { blendWeight } from "./baseline";
import { estimateAverages, seasonLabel, startYear } from "./history";
import { DEFAULT_WEEKS, DEFAULT_WEEK_GAMES, mondayOf } from "./matchup";
import type { Entry, MoveEnv, ScoreEngine, WeekEnv } from "./moves";
import { historyOf, resolvePlayer, scheduleWeeks, type Snapshot } from "./snapshot";
import type { Band } from "./types";

/** Banked stats for a week under way, in base stats (made and attempted shots, not percentages). Missing stats count as 0. */
export type AnyBanked = Partial<Record<BaseKey, number>>;

export interface AnyMatchupOutput {
  week_start: string | null;
  games_source: "schedule" | "assumed";
  schedule_incomplete: boolean;
  opponent: "typical" | "roster";
  lineup_slots: number;
  weeks: number;
  so_far_counted: boolean;
  /** The league's categories, as codes. */
  categories_used: string[];
  /** Whole percent of simulated weeks you win each category outright. */
  categories: Record<string, number>;
  /** Whole percent of weeks you win more categories than the opponent, tie, and lose. */
  /** Points leagues only: average simulated week points (banked included) for you and for the opponent, and the margin. */
  expected_points?: { you: number; opponent: number; margin: number };
  week_win_pct: number;
  week_tie_pct: number;
  week_loss_pct: number;
  /** Whole percent of weeks you win exactly k categories, k = 0..N. */
  distribution_pct: number[];
  rosters: { you: PlayerGames[]; opponent?: PlayerGames[] };
  names: NameResult[];
  assumptions: string[];
}

export interface AnyAnalyzeOutput {
  /** True: this league is scored on categories other than the standard nine. */
  custom_categories: true;
  categories_used: string[];
  snapshot: { generated_at: string; reference_season: string };
  league: AnalyzeInput["league"];
  names: NameResult[];
  /** Players left out because their name was not found or could be more than one player. Mention these first, ahead of any number. */
  warnings: string[];
  /** Strongest to weakest: where your expected week total stands among typical teams (no luck). */
  ranking: { category: string; band: Band; percentile: number }[];
  /** Points leagues: the stat weights, and where your expected week sits among typical teams (no luck). */
  points?: { weights: Weights; expected_week_points: number; percentile: number; band: Band };
  assumptions: string[];
  matchup?: AnyMatchupOutput;
  waiver?: WaiverOutput;
  trade?: TradeOutput;
}

const band = (p: number): Band => (p >= 85 ? "elite" : p >= 60 ? "strong" : p >= 40 ? "neutral" : "weak");
const OPTIONAL_FIELD: Partial<Record<BaseKey, string>> = { fg3a: "fg3a", oreb: "oreb", dreb: "dreb", pf: "pf", dd: "dd_rate", td: "td_rate" };

/** Refuse early, and say why, when the data file lacks a stat the league's categories need. */
function requireData(snapshot: Snapshot, codes: string[]): void {
  for (const k of neededStats(codes)) {
    const f = OPTIONAL_FIELD[k];
    if (f && !snapshot.players.some((p) => p.seasons.some((s) => (s.averages as unknown as Record<string, number | undefined>)[f] !== undefined)))
      throw new Error(`the data file has no ${f} yet, which this league's categories need. It is added by the nightly update; try again after it runs.`);
  }
}

function mixBaseline(a: Baseline, b: Baseline, w: number): Baseline {
  return Object.fromEntries(Object.keys(a).map((c) => {
    const x = a[c]!, y = b[c]!;
    return [c, { mean: (1 - w) * x.mean + w * y.mean, std: (1 - w) * x.std + w * y.std, ...(x.ratio !== undefined ? { ratio: (1 - w) * x.ratio + w * (y.ratio ?? x.ratio) } : {}) }];
  }));
}

/** Everyone in the data estimated as in the nine-category path, with a ranking value for this league's categories. */
function estimateAll(snapshot: Snapshot, reference: string, current: string, valueOf: (b: PlayerBase) => number): Map<number, Entry> {
  const out = new Map<number, Entry>();
  for (const p of snapshot.players) {
    const e = estimateAverages(historyOf(p), reference, { current });
    if (!e.averages) continue;
    const base = baseOf(e.averages, []);
    out.set(p.id, { id: p.id, name: p.name, averages: e.averages, team: p.team, value: valueOf(base), confidence: e.confidence, effectiveGames: e.effectiveGames, base });
  }
  return out;
}

const engineFor = (codes: string[], weights?: Weights): ScoreEngine => ({
  codes,
  totals: (list, gamesFor, slots) => anyTotals(list.map((p) => ({ base: p.base!, games: gamesFor(p.team), value: p.value })), slots),
  simulate: (me, opps, o) => {
    if (weights) return { weekWin: simulatePoints(me as AnyTotals, opps as AnyTotals[], weights, o).weekWin, categories: Object.fromEntries(codes.map((c) => [c, 0])) };
    const r = simulateAny(me as AnyTotals, opps as AnyTotals[], codes, o);
    return { weekWin: r.weekWin, categories: r.categories };
  },
});

export function analyzeAny(input: AnalyzeInput, snapshot: Snapshot, codes: string[], weights?: Weights): AnyAnalyzeOutput {
  const { teams, roster_spots } = input.league;
  requireData(snapshot, codes);
  const reference = input.reference ?? snapshot.reference_season;
  const current = seasonLabel(startYear(reference) + 1);
  const poolSize = teams * roster_spots;

  // League baseline from the reference season, blended with the season in progress by games played (D1).
  const seasonPool = (season: string) => {
    const out: { base: PlayerBase; gp: number; mpg: number }[] = [];
    for (const p of snapshot.players) {
      const s = p.seasons.find((x) => x.season === season);
      if (s && s.mpg > 0 && s.gp > 0) out.push({ base: baseOf({ ...s.averages, min: s.mpg }, []), gp: s.gp, mpg: s.mpg });
    }
    return out;
  };
  const refPool = seasonPool(reference), curPool = seasonPool(current);
  if (refPool.length < poolSize) throw new Error(`snapshot has only ${refPool.length} players for ${reference}; need at least ${poolSize}`);
  let baseline: Baseline = weights ? {} : buildAnyBaseline(refPool, codes, poolSize);
  const teamGames = input.team_games ?? curPool.reduce((m, p) => Math.max(m, p.gp), 0);
  const w = !weights && curPool.length >= poolSize ? blendWeight(teamGames) : 0;
  if (w > 0) baseline = mixBaseline(baseline, buildAnyBaseline(curPool, codes, poolSize), w);

  // A points league has one number per player: weighted points per game. Otherwise the sum of category scores.
  const valueOf = weights ? (b: PlayerBase) => pointsOf(weights, b) : (b: PlayerBase) => anyValue(b, codes, baseline);
  const estimated = estimateAll(snapshot, reference, current, valueOf);
  const pool = [...estimated.values()].sort((a, b) => b.value - a.value);
  if (pool.length < poolSize) throw new Error(`snapshot has only ${pool.length} players; need at least ${poolSize}`);
  const engine = engineFor(codes, weights);
  const seed = input.seed ?? 1;
  const assumptions = [
    weights
      ? `This is a head-to-head points league. Points = ${Object.entries(weights).map(([c, x]) => `${x} x ${c}`).join(" + ")}. Players are valued, and typical opponents drafted, on fantasy points per game; the side with more points in the week wins.`
      : `This league scores ${codes.join(", ")}. Players are valued, and typical opponents drafted, on those categories only.`,
    `Players are estimated from their last three seasons, weighted by recency and games played. Positions are ignored. Week-to-week luck was measured on 2025-26 weekly results for each base stat (made and attempted shots, rebounds by kind, assists, steals, blocks, turnovers, fouls, minutes); double-doubles and triple-doubles are sampled game by game from each player's own rate.`,
    ...(w > 0 ? [`League baseline: ${Math.round((1 - w) * 100)}% ${reference}, ${Math.round(w * 100)}% ${current} (season blend after ${teamGames} games).`] : []),
  ];

  const scheduleWeek = (start: string) => scheduleWeeks(snapshot).find((x) => x.start === start);
  const gamesIn = (games: Record<string, number> | null) => (team?: string) => (games && team ? (games[team] ?? 0) : DEFAULT_WEEK_GAMES);
  const names: NameResult[] = [];

  // Team-check analogue: where your expected week sits among typical teams.
  const thisMonday = mondayOf(snapshot.generated_at);
  const wk0 = scheduleWeek(thisMonday);
  const slots0 = input.matchup?.lineup_slots ?? input.waiver?.lineup_slots ?? input.trade?.lineup_slots ?? roster_spots;
  const myEntries = resolveList(input.roster, snapshot, estimated, names);
  const typical0 = typicalAnyOpponents(pool as never, { teams, rosterSpots: roster_spots }, slots0, gamesIn(wk0?.games ?? null), { leagues: 300, seed });
  const mine0 = anyTotals(myEntries.map((e) => ({ base: e.base!, games: gamesIn(wk0?.games ?? null)(e.team), value: e.value })), slots0);
  const ranking = weights ? [] : codes.map((c) => {
    const mineV = categoryValue(c, mine0.t);
    const worse = typical0.filter((o) => (isLowerCategory(c) ? categoryValue(c, o.t) > mineV : categoryValue(c, o.t) < mineV)).length;
    const percentile = Math.round((100 * worse) / typical0.length);
    return { category: c, band: band(percentile), percentile };
  }).sort((a, b) => b.percentile - a.percentile);

  const out: AnyAnalyzeOutput = {
    custom_categories: true, categories_used: codes,
    snapshot: { generated_at: snapshot.generated_at, reference_season: snapshot.reference_season },
    league: input.league, names, ranking, assumptions, warnings: [],
  };

  if (weights) {
    const mine = pointsOf(weights, mine0.t);
    const percentile = Math.round((100 * typical0.filter((o) => pointsOf(weights, o.t) < mine).length) / typical0.length);
    out.points = { weights, expected_week_points: Math.round(mine * 10) / 10, percentile, band: band(percentile) };
  }
  if (input.matchup) out.matchup = runAnyMatchup(input, snapshot, codes, estimated, pool, engine, wk0, thisMonday, weights);
  if (input.waiver || input.trade) {
    const st = anyMoveSetup(input, snapshot, codes, estimated, pool, engine, seed);
    if (input.waiver) out.waiver = waiverWith(input, snapshot, st);
    if (input.trade) out.trade = tradeWith(input, snapshot, st);
  }
  out.warnings = leftOutWarnings([out.names, out.matchup?.names, out.waiver?.names, out.trade?.names]);
  return out;
}

function anyMoveSetup(
  input: AnalyzeInput, snapshot: Snapshot, codes: string[], estimated: Map<number, Entry>, pool: Entry[], engine: ScoreEngine, seed: number,
): MoveSetup {
  const { teams, roster_spots } = input.league;
  const common = (input.waiver ?? input.trade)!;
  const slots = common.lineup_slots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20) throw new Error("lineup_slots must be a whole number from 1 to 20");
  const horizon = Math.max(1, Math.min(4, common.horizon_weeks ?? 2));
  const simWeeks = common.weeks ?? 6000;
  const replacement = pool[teams * roster_spots - 1]!;
  const first = mondayOf(snapshot.generated_at);
  const scheduled = (scheduleWeeks(snapshot)).filter((x) => x.start >= first).slice(0, horizon);
  const assumptions: string[] = [`Categories scored: ${codes.join(", ")}.`];
  const mk = (start: string | null, games: Record<string, number> | null): WeekEnv => {
    const gamesFor = (team?: string) => (games && team ? (games[team] ?? 0) : DEFAULT_WEEK_GAMES);
    return { start, gamesFor, opponents: typicalAnyOpponents(pool as never, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 150, seed }) };
  };
  const weeks = scheduled.length > 0 ? scheduled.map((x) => mk(x.start, x.games)) : [mk(null, null)];
  const gamesSource = scheduled.length > 0 ? "schedule" : "assumed";
  for (const x of scheduled) if (x.tbd_slots) assumptions.push(`WARNING: ${x.tbd_slots} game slot(s) in the week of ${x.start} are still "TBD" in the NBA schedule, so some teams' game counts may be too low.`);
  assumptions.push(
    gamesSource === "schedule"
      ? `Averaged over ${weeks.length} week(s) starting ${weeks[0]!.start}, counting each player's real games from the NBA schedule.`
      : `No schedule in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`,
    `Each score is a weekly win chance (more categories won than lost) against typical opponents (${weeks[0]!.opponents.length} teams from simulated ${teams}-team drafts on this league's categories, positions ignored), ${simWeeks} simulated weeks with a fixed seed. ` +
      `A move is scored by re-running the same weeks with the roster changed. Injuries, rest days and lineup moves during the week are not modelled. An empty lineup spot is filled by a replacement-level player.`,
  );
  const env: MoveEnv = { slots, weeks, simWeeks, seed, replacement, engine };
  return { env, estimated, weeksUsed: weeks.map((x) => x.start ?? "assumed"), gamesSource, scheduleIncomplete: scheduled.some((x) => (x.tbd_slots ?? 0) > 0), assumptions };
}

const ZERO_BASE = (): BaseTotals => ({
  minutes: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, fg3m: 0, fg3a: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, turnovers: 0, pf: 0, dd: 0, td: 0,
});

function runAnyMatchup(
  input: AnalyzeInput, snapshot: Snapshot, codes: string[], estimated: Map<number, Entry>, pool: Entry[], engine: ScoreEngine,
  wk0: { games: Record<string, number>; tbd_slots?: number } | undefined, thisMonday: string, weights?: Weights,
): AnyMatchupOutput {
  const m = input.matchup!;
  const { teams, roster_spots } = input.league;
  const slots = m.lineup_slots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20) throw new Error("matchup.lineup_slots must be a whole number from 1 to 20");
  const assumptions: string[] = [];
  const sf = m.so_far as unknown as { you: AnyBanked & { points?: number }; opponent: AnyBanked & { points?: number }; games_left?: Record<string, number>; remaining_share?: number } | undefined;
  const need = weights ? [] : neededStats(codes);
  if (sf) {
    if (!m.opponent || m.opponent.length === 0) throw new Error("matchup.so_far needs a real matchup.opponent");
    if (sf.games_left) {
      for (const [t, n] of Object.entries(sf.games_left)) if (!(Number.isInteger(n) && n >= 0 && n <= 7)) throw new Error(`matchup.so_far.games_left: ${t} must be a whole number of games from 0 to 7`);
    } else if (!(sf.remaining_share! >= 0 && sf.remaining_share! <= 1)) throw new Error("matchup.so_far needs games_left, or remaining_share between 0 and 1");
    if (weights) for (const side of [sf.you, sf.opponent]) if (!(typeof side?.points === "number")) throw new Error("matchup.so_far: points must be a number for both sides (this is a points league)");
    for (const side of [sf.you, sf.opponent])
      for (const k of need) if (!(typeof side?.[k] === "number" && side[k]! >= 0)) throw new Error(`matchup.so_far: ${k} must be a number of 0 or more for both sides (this league's categories need it)`);
  }
  const weekStart = m.week_start ?? thisMonday;
  const week = scheduleWeeks(snapshot).find((x) => x.start === weekStart) ?? (weekStart === thisMonday ? wk0 : undefined);
  const gamesFor = (team?: string): number => (week && team ? (week.games[team] ?? 0) : DEFAULT_WEEK_GAMES);
  const tbd = week?.tbd_slots ?? 0;
  if (tbd > 0) assumptions.push(`WARNING: ${tbd} game slot(s) in the week of ${weekStart} are still "TBD" in the NBA schedule, so some teams' game counts may be too low. Treat these numbers as rougher.`);
  assumptions.push(week
    ? `Games per player come from the NBA schedule for the week of ${weekStart}. Injuries and rest days are not modelled.`
    : `No schedule for the week of ${weekStart} in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`);
  const leftFor = (team?: string) => (sf?.games_left && team ? (sf.games_left[team] ?? 0) : 0);

  const sideOf = (list: { name: string; status?: "IL" | "active" }[], label: string) => {
    const names: NameResult[] = [];
    const rows: (PlayerGames & { value: number })[] = [];
    const players: AnyPlayer[] = [], lefts: number[] = [];
    for (const r of list) {
      const hit = resolvePlayer(r.name, snapshot.players);
      if (hit.status === "matched") {
        names.push({ input: r.name, status: "matched", matched: hit.player.name });
        const e = estimated.get(hit.player.id);
        if (e) rows.push({ name: hit.player.name, team: e.team ?? null, games: gamesFor(e.team), ...(sf?.games_left ? { games_left: leftFor(e.team) } : {}), counted: false, ...(r.status === "IL" ? { status: "IL" as const } : {}), value: e.value });
        if (r.status !== "IL" && e) { players.push({ base: e.base!, games: gamesFor(e.team), value: e.value }); lefts.push(leftFor(e.team)); }
      } else if (hit.status === "ambiguous") names.push({ input: r.name, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
      else names.push({ input: r.name, status: "not_found" });
    }
    const missing = names.filter((n) => n.status !== "matched").length;
    if (missing > 0) assumptions.push(`${missing} player(s) in the ${label} roster could not be matched and are left out of the weekly totals.`);
    const totals = anyTotals(players, slots);
    const counted = new Set(rows.filter((x) => x.status !== "IL").sort((a, b) => b.value - a.value).slice(0, slots));
    const outRows: PlayerGames[] = rows.map(({ value: _v, ...x }, i) => ({ ...x, counted: counted.has(rows[i]!) })).sort((a, b) => Number(b.counted) - Number(a.counted) || b.games - a.games);
    let remaining = totals, share = 1;
    if (sf) {
      if (!sf.games_left) { remaining = scaledAny(totals, sf.remaining_share!); share = sf.remaining_share!; }
      else {
        remaining = anyTotals(players.map((p, i) => ({ ...p, games: lefts[i]! })), slots);
        const lineup = players.map((p, i) => ({ p, i })).sort((a, b) => b.p.value - a.p.value).slice(0, slots);
        const full = lineup.reduce((t, x) => t + x.p.games, 0), rest = lineup.reduce((t, x) => t + lefts[x.i]!, 0);
        share = full > 0 ? Math.min(1, rest / full) : 1;
      }
    }
    return { totals, remaining, share, names, rows: outRows };
  };

  const me = sideOf(input.roster, "your");
  let opponents: AnyTotals[];
  let names = me.names;
  let opp: ReturnType<typeof sideOf> | undefined;
  if (m.opponent && m.opponent.length > 0) {
    const o = (opp = sideOf(m.opponent, "opponent"));
    opponents = [o.totals];
    names = [...me.names, ...o.names.map((n) => ({ ...n, input: `${n.input} (opponent)` }))];
  } else {
    opponents = typicalAnyOpponents(pool as never, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 300, seed: input.seed ?? 1 });
    assumptions.push(`Typical opponents: ${opponents.length} teams from 300 simulated ${teams}-team drafts on this league's categories, each playing its best ${slots} players. Positions are ignored.`);
  }
  const weeks = m.weeks ?? DEFAULT_WEEKS;
  const bank = (b: AnyBanked): BaseTotals => ({ ...ZERO_BASE(), ...Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === "number")) });
  const progress: { me: AnySide; opponent: AnySide } | undefined = sf && opp
    ? { me: { banked: bank(sf.you), remaining: me.remaining, share: me.share }, opponent: { banked: bank(sf.opponent), remaining: opp.remaining, share: opp.share } }
    : undefined;
  const simOpts = { weeks, seed: input.seed ?? 1, slots };
  const pp: { me: PointsSide; opponent: PointsSide } | undefined = weights && sf && opp
    ? { me: { banked: sf.you.points!, remaining: me.remaining, share: me.share }, opponent: { banked: sf.opponent.points!, remaining: opp.remaining, share: opp.share } } : undefined;
  const pr = weights ? simulatePoints(me.totals, opponents, weights, { ...simOpts, ...(pp ? { progress: pp } : {}) }) : undefined;
  const r = pr
    ? { weekWin: pr.weekWin, weekTie: pr.weekTie, weekLoss: pr.weekLoss, categories: {} as Record<string, number>, distribution: [] as number[] }
    : simulateAny(me.totals, opponents, codes, { ...simOpts, ...(progress ? { progress } : {}) });
  if (sf)
    assumptions.push(sf.games_left
      ? `The week is under way: stats already banked are kept, and the games still to play (your lineup has ${Math.round(me.share * 100)}% of its week left, theirs ${Math.round(opp!.share * 100)}%) are simulated from each player's own team games left. Games in progress or already counted by the league site must not be in the games left.`
      : `The week is under way: stats already banked are kept, and the remaining ${Math.round(sf.remaining_share! * 100)}% of each team's games are simulated. Every player is assumed to have that same share of his week left, which is rough when a team's games are lopsided.`);
  assumptions.push(`Week-to-week luck is measured on 2025-26 weekly results after removing game counts. ${weeks} simulated weeks, fixed seed. The simulation does not model injuries, lineup moves or streaming during the week. ${weights ? "The side with more fantasy points wins; equal points are a tie." : "A week is won with more categories than the opponent; equal counts are a tie."}`);
  const pct = (x: number) => Math.round(x * 100);
  return {
    week_start: week ? weekStart : null,
    games_source: week ? "schedule" : "assumed",
    schedule_incomplete: tbd > 0,
    opponent: m.opponent && m.opponent.length > 0 ? "roster" : "typical",
    lineup_slots: slots, weeks, so_far_counted: Boolean(sf),
    categories_used: codes,
    categories: weights ? {} : Object.fromEntries(codes.map((c) => [c, pct(r.categories[c]!)])),
    ...(pr ? { expected_points: { you: Math.round(pr.expectedMe * 10) / 10, opponent: Math.round(pr.expectedOpponent * 10) / 10, margin: Math.round((pr.expectedMe - pr.expectedOpponent) * 10) / 10 } } : {}),
    week_win_pct: pct(r.weekWin), week_tie_pct: pct(r.weekTie), week_loss_pct: pct(r.weekLoss),
    distribution_pct: r.distribution.map(pct),
    rosters: { you: me.rows, ...(opp ? { opponent: opp.rows } : {}) },
    names, assumptions,
  };
}
