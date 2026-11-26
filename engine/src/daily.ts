import type { Scenario, PlayerRef } from "./analyze";
import { addDays, gameWeights } from "./availability";
import { assignLineup, parsePositions, type Slots } from "./lineup";
import type { Entry } from "./moves";
import { resolvePlayer, type Snapshot } from "./snapshot";
import type { SideResult, SideRow } from "./sideutil";

/**
 * Daily lineups and streaming (issue #5). With a daily lineup lock you set your lineup every day, so the days left in the
 * week are modelled one by one: each day the best lineup among the players whose teams play that day. A difference between two
 * simulations, like every other move: start or bench a named player on named days, or add a streamer for the rest of the week.
 */
export interface DailyInput {
  /** First day not yet in the banked stats (YYYY-MM-DD). Default: `as_of`, or the week's first day when the week is not under way. */
  from?: string;
  /** Force a player into the lineup on these days (all remaining days when omitted), if he plays and fits a slot. */
  start?: { name: string; days?: string[] }[];
  /** Sit a player on these days (all remaining days when omitted). */
  bench?: { name: string; days?: string[] }[];
  /**
   * Lineups already set on the league site (My Team page) for days to come: the starters' names per day. Days with no entry use
   * the best lineup among the players who play. Starters whose team has no game that day add nothing.
   */
  set_lineup?: { date: string; starters: string[] }[];
  /** The same for the opponent's roster, when his page shows it. */
  opponent_set_lineup?: { date: string; starters: string[] }[];
  /** Rank free agents by what adding each for the rest of the week does to the weekly win chance. */
  stream?: {
    candidates: { name: string; positions?: string | string[]; injury?: string; return_date?: string }[];
    /** Adds you have left this week. 0: ranked for information, but none can be made. */
    adds_left?: number;
    /** Allow an add with no drop (an open roster spot). */
    open_spot?: boolean;
    top?: number;
  };
}

export interface DailyOutput {
  from: string;
  days: string[];
  /** Win chance with the best lineup set each remaining day. */
  baseline_week_win_pct: number;
  /** Share of the lineup's games left to play; under a third the number is rougher (luck was measured on whole weeks). */
  share_left: number;
  rough: boolean;
  lineup_by_day: { date: string; starters: { name: string; slot?: string }[]; bench_with_game: string[] }[];
  changes?: { label: string; week_win_pct: number; delta_points: number }[];
  streaming?: {
    adds_left?: number;
    moves: { add: string; drop: string | null; days_played: string[]; week_win_pct: number; delta_points: number; addable: boolean }[];
  };
  /**
   * Why this number can differ from the weekly `week_win_pct` (issue #33). Additive and measured; no other number depends on it.
   * The weekly model sums each lineup player's games over the week; the daily model fields the best lineup every day, so a
   * bench player starts on days when a starter has no game. When the opponent is a real roster, `opponent_daily_week_win_pct`
   * gives him the same day-by-day fielding (the headline daily number does not: it keeps his weekly total).
   */
  compare_with_weekly: {
    weekly_week_win_pct: number;
    /** The headline daily number: both sides fielded day by day (the opponent too, when a real roster is given). */
    daily_week_win_pct: number;
    /** What the daily number would be with only your side fielded day by day and the opponent kept at his weekly total (biased toward you; not for quoting). */
    you_only_daily_week_win_pct?: number;
    /** Games in the days modelled: the weekly model's lineup vs the best lineup each day. */
    your_games: { weekly_lineup: number; daily_lineup: number; from_bench: number };
    opponent_games?: { weekly_lineup: number; daily_lineup: number; from_bench: number };
  };
  notes: string[];
}

/** A player in a day's pick. `weight` is his output that day: 1, or the ramp share early in a return. */
export interface DayPlayer { entry: Entry; weight: number; positions?: string[]; name: string }

export interface DailyEngine<T> {
  empty(): T;
  plus(a: T, b: T): T;
  /** One day's lineup (already chosen) summed into totals. */
  dayTotals(players: DayPlayer[]): T;
  /** Weekly win chance with `remaining` still to play, `share` of the lineup's week left. */
  win(remaining: T, share: number, weeks: number, opponent?: { remaining: T; share: number }): number;
}

interface Row { entry: Entry; positions?: string[]; dates: Map<string, number>; active: boolean }

export function runDaily<T>(
  input: { as_of?: string; league: { lineup_lock?: "daily" | "weekly" } },
  snapshot: Snapshot, m: { daily?: DailyInput; scenarios?: Scenario[] },
  a: {
    me: SideResult; weekStart: string; lineupSlots: Slots; weeks: number; engine: DailyEngine<T>; estimated: Map<number, Entry>;
    gamesFor: (team?: string) => number; asOf: string; hasBanked: boolean; assumptions: string[];
    /** The real opponent's roster, when there is one. */
    opp?: SideResult;
    /** The weekly model's week win chance for the same inputs (0 to 1). */
    weeklyWin: number;
  },
): DailyOutput {
  const d = m.daily!;
  const notes: string[] = [];
  if (input.league.lineup_lock === "weekly") throw new Error("this league locks lineups weekly (league.lineup_lock): nothing can be changed after the week starts, so there is no daily lineup to model. Ask for next week's lineup instead.");
  if (!snapshot.schedule?.days) throw new Error("matchup.daily needs the day-by-day NBA schedule: pass it as `schedule_days` (skills/matchup/scripts/season-days.mjs prints it) or use a data file that has `schedule.days`.");
  const weekEnd = addDays(a.weekStart, 6);
  const from = d.from ?? (a.hasBanked ? a.asOf : a.weekStart);
  const days: string[] = [];
  for (let x = from < a.weekStart ? a.weekStart : from; x <= weekEnd; x = addDays(x, 1)) days.push(x);
  if (days.length === 0) throw new Error(`matchup.daily.from (${from}) is after the week ends (${weekEnd})`);

  const toRow = (r: SideRow): Row => {
    const w = gameWeights(snapshot, r.entry.team, a.weekStart, a.gamesFor(r.entry.team), r.av);
    return { entry: r.entry, positions: r.positions, dates: new Map(w.games.map((g) => [g.date, g.w])), active: r.active };
  };
  const base = a.me.rows.map(toRow);
  const byName = (n: string): number => {
    const h = resolvePlayer(n, snapshot.players);
    if (h.status !== "matched") throw new Error(`daily: "${n}" ${h.status === "ambiguous" ? "could be more than one player" : "was not found"}`);
    return h.player.id;
  };
  const idsOf = (list?: { name: string; days?: string[] }[]) => new Map((list ?? []).map((x) => [byName(x.name), new Set(x.days ?? days)]));
  const starts = idsOf(d.start), benches = idsOf(d.bench);
  for (const x of [...starts.values(), ...benches.values()]) for (const day of x) if (day < days[0]! || day > weekEnd) throw new Error(`daily: ${day} is outside the days left (${days[0]} to ${weekEnd})`);

  const BIG = 1e6;
  /** One day's lineup: players who play, minus those benched, forced starters first. */
  const setOf = (list: DailyInput["set_lineup"]) => new Map((list ?? []).map((x) => {
    if (x.date < a.weekStart || x.date > weekEnd) throw new Error(`daily: set lineup for ${x.date} is outside the week (${a.weekStart} to ${weekEnd})`);
    return [x.date, new Set(x.starters.map(byName))] as const;
  }));
  const mySet = setOf(d.set_lineup), oppSet = setOf(d.opponent_set_lineup);
  /** One day's lineup. Your side: forced starts first, benches out. A lineup set on the site that day: only those players. */
  const pickDay = (rows: Row[], day: string, mine = true) => {
    const set = (mine ? mySet : oppSet).get(day);
    const avail = rows.filter((r) => r.active && (r.dates.get(day) ?? 0) > 0 && (!set || set.has(r.entry.id)) && !(mine && benches.get(r.entry.id)?.has(day)))
      .map((r) => ({ r, value: r.entry.value + (mine && starts.get(r.entry.id)?.has(day) ? BIG : 0), positions: r.positions, games: r.dates.get(day)! }));
    return assignLineup(avail, a.lineupSlots);
  };
  const dayLineups = (rows: Row[], mine = true) => {
    let tot = a.engine.empty(), games = 0;
    for (const day of days) {
      const picks = pickDay(rows, day, mine);
      tot = a.engine.plus(tot, a.engine.dayTotals(picks.map((p) => ({ entry: p.player.r.entry, weight: p.player.r.dates.get(day)!, positions: p.player.r.positions, name: p.player.r.entry.name }))));
      games += picks.reduce((s, p) => s + p.player.r.dates.get(day)!, 0);
    }
    return { tot, games };
  };
  // A real opponent roster is fielded day by day too, like your side. `null`: keep his weekly total (the old, one-sided number).
  const orows = a.opp ? a.opp.rows.map(toRow) : undefined;
  const oppDay = (() => {
    if (!orows) return undefined;
    const od = dayLineups(orows, false);
    let g = 0;
    for (let x = a.weekStart; x <= weekEnd; x = addDays(x, 1)) g += pickDay(orows, x, false).reduce((u, p) => u + p.player.r.dates.get(x)!, 0);
    return { remaining: od.tot, share: g > 0 ? Math.min(1, od.games / g) : 1 };
  })();
  const evaluate = (rows: Row[], weeks: number, fullGames: number, opponent: { remaining: T; share: number } | null | undefined = oppDay) => {
    const { tot, games } = dayLineups(rows);
    const share = fullGames > 0 ? Math.min(1, games / fullGames) : 1;
    return { win: a.engine.win(tot, share, weeks, opponent ?? undefined), share, games };
  };
  // Games the lineup plays over the whole week (the denominator of the share left).
  const fullGames = (() => {
    let g = 0;
    for (let x = a.weekStart; x <= weekEnd; x = addDays(x, 1)) g += pickDay(base, x).reduce((s, p) => s + p.player.r.dates.get(x)!, 0);
    return g;
  })();
  const baseEval = evaluate(base, a.weeks, fullGames);
  const lineup_by_day = days.map((date) => {
    const picks = pickDay(base, date);
    const in_ = new Set(picks.map((p) => p.player.r));
    return {
      date,
      starters: picks.map((p) => ({ name: p.player.r.entry.name, ...(p.slot ? { slot: p.slot } : {}) })),
      bench_with_game: base.filter((r) => r.active && (r.dates.get(date) ?? 0) > 0 && !in_.has(r)).map((r) => r.entry.name),
    };
  });
  const out: DailyOutput = {
    from: days[0]!, days, baseline_week_win_pct: Math.round(baseEval.win * 100), share_left: Math.round(baseEval.share * 100) / 100,
    rough: baseEval.share < 1 / 3, lineup_by_day, notes, compare_with_weekly: undefined as never,
  };
  if (out.rough) notes.push("Less than a third of the lineup's games are left. Luck was measured on whole weeks and scaled down for the part left, so these numbers are rougher.");

  if (starts.size > 0 || benches.size > 0) {
    // Compare with the same roster and no forced starts or benches.
    const savedS = new Map(starts), savedB = new Map(benches);
    starts.clear(); benches.clear();
    const plain = evaluate(base, a.weeks, fullGames).win;
    for (const [k, v] of savedS) starts.set(k, v);
    for (const [k, v] of savedB) benches.set(k, v);
    out.changes = [{ label: "your starts and benches", week_win_pct: Math.round(baseEval.win * 100), delta_points: Math.round((baseEval.win - plain) * 1000) / 10 }];
    out.baseline_week_win_pct = Math.round(plain * 100);
    notes.push("baseline_week_win_pct is the best lineup each day with no forced starts or benches; the change shown is what your starts and benches do to it.");
    // With forced changes in place, lineup_by_day shows the lineup with them applied.
  }

  {
    // Explain the gap to the weekly number (issue #33), always on the plain roster: no forced starts or benches, no streamer.
    const savedS = new Map(starts), savedB = new Map(benches);
    starts.clear(); benches.clear();
    const gamesIn = (rs: Row[]) => rs.reduce((t, r) => t + days.reduce((u, x) => u + (r.dates.get(x) ?? 0), 0), 0);
    const round1 = (x: number) => Math.round(x * 10) / 10;
    const games = (chosen: SideRow[], rows: Row[], mine = true) => {
      const weekly = gamesIn(chosen.map((c) => rows.find((r) => r.entry.id === c.entry.id)!).filter((r) => r.active));
      const daily = dayLineups(rows, mine).games;
      return { weekly_lineup: round1(weekly), daily_lineup: round1(daily), from_bench: round1(daily - weekly) };
    };
    const plain = evaluate(base, a.weeks, fullGames).win;
    const cmp: DailyOutput["compare_with_weekly"] = {
      weekly_week_win_pct: Math.round(a.weeklyWin * 100), daily_week_win_pct: Math.round(plain * 100),
      your_games: games(a.me.chosen, base),
    };
    if (a.opp && orows) {
      const og = games(a.opp.chosen, orows, false);
      cmp.opponent_games = og;
      cmp.you_only_daily_week_win_pct = Math.round(evaluate(base, a.weeks, fullGames, null).win * 100);
    }
    for (const [k, v] of savedS) starts.set(k, v);
    for (const [k, v] of savedB) benches.set(k, v);
    out.compare_with_weekly = cmp;
    notes.push(`The weekly matchup number counts each lineup player's games all week; the daily number fields the best lineup every day, so bench players start on days when starters have no game (you: ${cmp.your_games.from_bench >= 0 ? "+" : ""}${cmp.your_games.from_bench} games${cmp.opponent_games ? `, opponent: ${cmp.opponent_games.from_bench >= 0 ? "+" : ""}${cmp.opponent_games.from_bench} games` : ""}). ${a.opp ? "Both rosters are fielded day by day. " : "No opponent roster was given: the typical opponents are weekly totals, so this number favours you; give the real opponent. "}See compare_with_weekly.`);
  }

  if (d.stream) {
    const s = d.stream;
    if (!Array.isArray(s.candidates) || s.candidates.length === 0) throw new Error("daily.stream.candidates must list at least one available player");
    const ref = starts.size === 0 && benches.size === 0 ? baseEval.win : evaluate(base, a.weeks, fullGames).win;
    // A pickup is made now: it cannot play on days before as_of (nor before the days modelled).
    const firstAdd = a.asOf > days[0]! ? a.asOf : days[0]!;
    const quick = Math.min(a.weeks, 2500);
    const drops: (Row | null)[] = [...base.filter((r) => r.active), ...(s.open_spot ? [null] : [])];
    const found: { c: Row; drop: Row | null; win: number }[] = [];
    for (const c of s.candidates) {
      const h = resolvePlayer(c.name, snapshot.players);
      if (h.status !== "matched") { notes.push(`WARNING: streaming candidate "${c.name}" ${h.status === "ambiguous" ? "could be more than one player" : "was not found"}; skipped.`); continue; }
      const e = a.estimated.get(h.player.id);
      if (!e || base.some((r) => r.entry.id === e.id)) continue;
      const w = gameWeights(snapshot, e.team, a.weekStart, a.gamesFor(e.team), undefined);
      const row: Row = { entry: e, positions: parsePositions(c.positions), dates: new Map(w.games.filter((g) => g.date >= firstAdd).map((g) => [g.date, 1])), active: true };
      if (row.dates.size === 0) continue;
      let best: { drop: Row | null; win: number } | null = null;
      for (const drop of drops) {
        const rows = base.filter((r) => r !== drop).concat(row);
        const win = evaluate(rows, quick, fullGames).win;
        if (!best || win > best.win) best = { drop, win };
      }
      if (best) found.push({ c: row, ...best });
    }
    found.sort((x, y) => y.win - x.win);
    const top = found.slice(0, s.top ?? 5).map((f) => {
      const rows = base.filter((r) => r !== f.drop).concat(f.c);
      const win = evaluate(rows, a.weeks, fullGames).win;
      return { add: f.c.entry.name, drop: f.drop ? f.drop.entry.name : null, days_played: [...f.c.dates.keys()].sort(), win };
    }).sort((x, y) => y.win - x.win);
    out.streaming = {
      ...(s.adds_left !== undefined ? { adds_left: s.adds_left } : {}),
      moves: top.map((f) => ({
        add: f.add, drop: f.drop, days_played: f.days_played, week_win_pct: Math.round(f.win * 100),
        delta_points: Math.round((f.win - ref) * 1000) / 10, addable: s.adds_left === undefined || s.adds_left > 0,
      })),
    };
    notes.push("A streamer is added now and kept for the rest of the week; dropping him again, and the add that takes, are not modelled. Positions are checked only when the league has slots and you gave them.");
    if (s.adds_left === 0) notes.push("You have no adds left this week: these are shown for information only.");
  }
  return out;
}
