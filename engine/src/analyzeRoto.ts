import { asOfOf, resolveList, withScheduleDays, leftOutWarnings, type AnalyzeInput, type NameResult, type PlayerRef } from "./analyze";
import { baseOf, categoryCode, isLowerCategory, parseCategories, ratioKeys, STANDARD_NINE, type BaseKey, type PlayerBase } from "./anycat";
import { availabilityFromHost, DEFAULT_RAMP, type Availability } from "./availability";
import { asFraction } from "./banked";
import { estimateAverages, seasonLabel, startYear } from "./history";
import type { Entry } from "./moves";
import { expectedShare, prepareRoto, rotoPoints, ROTO_CURRENT_K, type RotoPlayer, type RotoResult, type RotoTeam, type RotoBanked } from "./roto";
import { gameDays, historyOf, type Snapshot, type SnapshotPlayer } from "./snapshot";
import type { Band, SeasonAverages } from "./types";

/** One team's line in the standings, as the host shows it. */
export interface RotoStandingInput {
  team: string;
  /** True for your own team (exactly one). Its roster is `AnalyzeInput.roster`. */
  me?: boolean;
  /**
   * Season totals so far, by the host's category names ("Points", "3PM", "FG%"). Counting categories need their total.
   * A percentage or ratio category needs the made and attempted counts (`FGM` and `FGA`, `FTM` and `FTA`, `3PM` and `3PA`,
   * `AST` and `TO`) or, when the host only shows the percentage, that value: the banked attempts are then estimated and labelled.
   */
  totals: Record<string, number>;
  /** Every other team's roster (names, with injury tags when the host shows them). */
  roster?: PlayerRef[];
}
export interface RotoInput {
  /** Last day of the regular season (YYYY-MM-DD). Default: the last day in the NBA schedule. */
  season_end?: string;
  /** Games left per NBA team, when the data has no day-by-day schedule. */
  games_left?: Record<string, number>;
  /** Simulated seasons (default 3000; moves use 1500). */
  sims?: number;
  /** "Top few" for the finish chances (default 3). */
  top?: number;
}

export interface RotoCategoryRow {
  category: string; current_total: number; current_rank: number; projected_total: number; expected_rank: number; expected_points: number; band: Band;
}
export interface RotoTableRow { team: string; current_points: number; expected_points: number; expected_place: number; first_pct: number; top_pct: number; /** Chance of each finishing place, first to last (percent). */ finish_pct: number[] }
export interface RotoFinish { expected_points: number; expected_place: number; first_pct: number; top_pct: number }
export interface RotoMove {
  add: string; drop: string | null; expected_points: number; delta_expected_points: number; delta_first_pct: number; delta_top_pct: number;
  /** Change in expected roto points by category (code -> points). */
  categories_delta: Record<string, number>;
}
export interface RotoOutput {
  roto: true;
  categories_used: string[];
  snapshot: { generated_at: string; reference_season: string };
  league: { teams: number; roster_spots: number; format: "roto" };
  basis: { as_of: string; season_end: string; top: number; sims: number; shooting_counts: "exact" | "estimated"; games_source: "schedule" | "given" };
  names: NameResult[];
  warnings: string[];
  assumptions: string[];
  team_check: {
    team: string; current_points: number; expected_points: number; expected_place: number;
    /** Whole percent chance of each finishing place, first to last. */
    finish_pct: number[]; first_pct: number; top_pct: number;
    categories: RotoCategoryRow[];
    table: RotoTableRow[];
  };
  waiver?: { baseline: RotoFinish; moves: RotoMove[]; none_improve: boolean };
  trade?: { partner: string; you: { before: RotoFinish; after: RotoFinish; delta_expected_points: number; delta_first_pct: number; delta_top_pct: number; categories_delta: Record<string, number> }; partner_side: { before: RotoFinish; after: RotoFinish; delta_expected_points: number; delta_first_pct: number; delta_top_pct: number } };
}

const band = (frac: number): Band => (frac >= 0.85 ? "elite" : frac >= 0.6 ? "strong" : frac >= 0.4 ? "neutral" : "weak");
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const COMPONENT: Record<BaseKey, string> = {
  minutes: "MIN", fgm: "FGM", fga: "FGA", ftm: "FTM", fta: "FTA", fg3m: "3PM", fg3a: "3PA", oreb: "OREB", dreb: "DREB", ast: "AST", stl: "STL", blk: "BLK", turnovers: "TO", pf: "PF", dd: "DD", td: "TD",
};
const NUMERIC_FIELDS = ["pts", "reb", "ast", "stl", "blk", "fg3m", "fg_pct", "ft_pct", "turnovers", "fga", "fta", "fgm", "ftm", "oreb", "dreb", "pf", "fg3a", "dd_rate", "td_rate", "min"] as const;

/** Per-game averages for the rest of the season: the prior seasons (as everywhere in the engine) blended with this season so far by games played. */
export function roto_projectAverages(p: SnapshotPlayer, reference: string, current: string): { averages: SeasonAverages; confidence: Entry["confidence"]; effectiveGames: number } | null {
  const e = estimateAverages(historyOf(p), reference, { current });
  const cur = p.seasons.find((s) => s.season === current);
  if (!e.averages) return null;
  if (e.currentSeasonOnly || !cur || !(cur.gp > 0)) return { averages: e.averages, confidence: e.confidence, effectiveGames: e.effectiveGames };
  const w = cur.gp / (cur.gp + ROTO_CURRENT_K);
  const mine = { ...cur.averages, min: cur.mpg } as unknown as Record<string, number | undefined>, prior = e.averages as unknown as Record<string, number | undefined>;
  const out: Record<string, number | undefined> = { ...prior };
  for (const f of NUMERIC_FIELDS) {
    const a = prior[f], b = mine[f];
    if (typeof a === "number" && typeof b === "number") out[f] = (1 - w) * a + w * b;
    else if (typeof b === "number" && a === undefined) out[f] = b;
  }
  return { averages: out as unknown as SeasonAverages, confidence: e.confidence, effectiveGames: e.effectiveGames };
}

const lastDay = (snapshot: Snapshot): string | null => {
  const days = Object.keys(snapshot.schedule?.days ?? {}).sort();
  return days.length ? days[days.length - 1]! : null;
};

/** Weighted games a player can play from `from` to `to`: games on days he is out are lost, the first games back count at the ramp share. */
function gamesLeftWith(dates: string[], av: Availability | undefined): number {
  if (!av) return dates.length;
  const back = av.returnDate;
  let n = 0, played = 0;
  for (const d of dates) {
    if (d >= av.outFrom && (back === null || d < back)) continue;
    const inRamp = !!(av.ramp && back && d >= back && played < av.ramp.games);
    played++;
    n += inRamp ? av.ramp!.share : 1;
  }
  return n;
}

export function analyzeRoto(input: AnalyzeInput, snapshotIn: Snapshot): RotoOutput {
  const lg = input.league;
  if (lg.scoring) throw new Error("roto leagues score categories: give league.categories (or none for the standard nine), not league.scoring");
  if (input.matchup) throw new Error("a roto league has no weekly matchup: ask for the team check, a waiver add or a trade");
  if (input.outlook) throw new Error("outlook is for head-to-head leagues; the roto team check already gives the finish chances for the rest of the season");
  const codes = lg.categories ? parseCategories(lg.categories) : [...STANDARD_NINE];
  const standings = lg.standings;
  if (!Array.isArray(standings) || standings.length < 4) throw new Error("a roto league needs league.standings: every team's name and season totals (at least 4 teams)");
  const meIdx = standings.findIndex((s) => s.me);
  if (meIdx < 0 || standings.filter((s) => s.me).length !== 1) throw new Error("mark your own team in league.standings with me: true (exactly one)");
  if (new Set(standings.map((s) => s.team)).size !== standings.length) throw new Error("league.standings: team names must be different");
  for (const [i, s] of standings.entries()) if (i !== meIdx && (!Array.isArray(s.roster) || s.roster.length === 0)) throw new Error(`league.standings: ${s.team} needs its roster (every team's roster is read to project the rest of the season)`);

  const snapshot = withScheduleDays(input, snapshotIn);
  const asOf = asOfOf(input, snapshot);
  const reference = input.reference ?? snapshot.reference_season;
  const current = seasonLabel(startYear(reference) + 1);
  const opt = input.roto ?? {};
  const top = Math.max(1, Math.min(standings.length, Math.floor(opt.top ?? 3)));
  const sims = Math.max(200, Math.floor(opt.sims ?? 3000));
  const moveSims = Math.max(200, Math.min(sims, 1500));
  const seed = input.seed ?? 1;

  // Games each NBA team has left.
  const seasonEnd = opt.season_end ?? lastDay(snapshot);
  let gamesSource: "schedule" | "given" = "schedule";
  const hasDays = !!snapshot.schedule?.days && seasonEnd !== null;
  if (!hasDays && !opt.games_left) throw new Error("roto needs the games left: the data file's day-by-day NBA schedule (schedule.days) or roto.games_left per team");
  if (!hasDays) gamesSource = "given";
  const teamDates = (team: string | undefined): string[] | number | null => {
    if (!team) return null;
    if (hasDays) return gameDays(snapshot, team, asOf, seasonEnd!) ?? [];
    return opt.games_left![team] ?? null;
  };
  const teamLeft = (team: string | undefined): number => { const d = teamDates(team); return d === null ? 0 : typeof d === "number" ? d : d.length; };
  const teamsWithGames = [...new Set(snapshot.players.map((p) => p.team).filter((t): t is string => !!t))];
  const avgLeft = teamsWithGames.length ? teamsWithGames.reduce((s, t) => s + teamLeft(t), 0) / teamsWithGames.length : 0;

  // Games each NBA team has played this season: the most games any of its players has.
  const played = new Map<string, number>();
  for (const p of snapshot.players) { const c = p.seasons.find((s) => s.season === current); if (p.team && c) played.set(p.team, Math.max(played.get(p.team) ?? 0, c.gp)); }
  const gpOf = new Map<number, number>();
  for (const p of snapshot.players) gpOf.set(p.id, p.seasons.find((s) => s.season === current)?.gp ?? 0);

  const estimated = new Map<number, Entry>();
  for (const p of snapshot.players) {
    const e = roto_projectAverages(p, reference, current);
    if (!e) continue;
    estimated.set(p.id, { id: p.id, name: p.name, averages: e.averages, team: p.team, value: 0, confidence: e.confidence, effectiveGames: e.effectiveGames, base: baseOf(e.averages, []) });
  }
  const names: NameResult[] = [];
  const notes: string[] = [];
  const noTeam = new Set<string>();

  const toPlayer = (e: Entry): RotoPlayer => {
    const dates = teamDates(e.team);
    let left: number, teamLeftN: number;
    if (dates === null) { left = teamLeftN = Math.round(avgLeft); if (!e.team) noTeam.add(e.name); }
    else if (typeof dates === "number") { left = teamLeftN = dates; if (e.avail) notes.push(`${e.name}: no day-by-day schedule, so his injury window is not applied`); }
    else { left = gamesLeftWith(dates, e.avail); teamLeftN = dates.length; }
    const n0 = (e.team && played.get(e.team)) || input.team_games || 0;
    const share = expectedShare(gpOf.get(e.id) ?? 0, n0, teamLeftN);
    return { id: e.id, base: e.base as PlayerBase, teamGamesLeft: left, expShare: share };
  };

  const ctx = { asOf, ramp: input.ramp, notes };
  const rosterOf = (list: PlayerRef[], suffix = ""): Entry[] => resolveList(list, snapshot, estimated, names, suffix, ctx);
  const entries: Entry[][] = standings.map((s, i) => rosterOf(i === meIdx ? input.roster : s.roster!, i === meIdx ? "" : ` (${s.team})`));

  // Banked totals per team and category.
  let estimatedShooting = false;
  const bankedOf = (ti: number): RotoBanked => {
    const s = standings[ti]!;
    const totals = new Map<string, number>();
    for (const [k, v] of Object.entries(s.totals ?? {})) {
      const c = categoryCode(k);
      if (!c) continue;
      if (!Number.isFinite(v)) throw new Error(`league.standings: ${s.team}: ${k} must be a number`);
      totals.set(c, v);
    }
    const out: RotoBanked = {};
    for (const c of codes) {
      const rk = ratioKeys(c);
      if (!rk) {
        if (!totals.has(c)) throw new Error(`league.standings: ${s.team} has no ${c} total`);
        out[c] = { num: totals.get(c)! };
        continue;
      }
      const nC = COMPONENT[rk.num], dC = COMPONENT[rk.den];
      if (totals.has(nC) && totals.has(dC)) { out[c] = { num: totals.get(nC)!, den: totals.get(dC)! }; continue; }
      if (!totals.has(c)) throw new Error(`league.standings: ${s.team} needs ${nC} and ${dC} (or the ${c} value) for ${c}`);
      // Only the ratio is shown: estimate the banked denominator from the roster's per-game rate x games played this season.
      const den = entries[ti]!.reduce((sum, e) => sum + e.base![rk.den] * (gpOf.get(e.id) ?? 0), 0);
      const raw = totals.get(c)!;
      const ratio = c.endsWith("%") ? asFraction(raw) : raw;
      out[c] = { num: ratio * den, den };
      estimatedShooting = true;
    }
    return out;
  };

  const teams: RotoTeam[] = standings.map((s, ti) => ({ name: s.team, banked: bankedOf(ti), players: entries[ti]!.map(toPlayer) }));
  const lowerFlags = codes.map((c) => isLowerCategory(c));
  const N = teams.length;

  // Current standing from the banked totals.
  const value = (t: RotoTeam, c: string) => { const b = t.banked[c]!; return b.den !== undefined ? (b.den > 0 ? b.num / b.den : 0) : b.num; };
  const current_ = rotoPoints(codes.map((c) => teams.map((t) => value(t, c))), lowerFlags);

  const sim = prepareRoto(teams, codes, { sims, seed });
  const base = sim.evaluate();
  const finish = (r: RotoResult, ti: number): RotoFinish => ({
    expected_points: r1(r.teams[ti]!.expectedPoints), expected_place: r1(r.teams[ti]!.expectedPlace),
    first_pct: r1(100 * r.teams[ti]!.place[0]!), top_pct: r1(100 * r.teams[ti]!.place.slice(0, top).reduce((s, x) => s + x, 0)),
  });
  const me = base.teams[meIdx]!;
  const categories: RotoCategoryRow[] = codes.map((c, ci) => ({
    category: c,
    current_total: r2(value(teams[meIdx]!, c)), current_rank: N + 1 - current_.byCategory[ci]![meIdx]!,
    projected_total: r2(me.finalValues[ci]!), expected_rank: r1(N + 1 - me.categoryPoints[ci]!), expected_points: r1(me.categoryPoints[ci]!),
    band: band((me.categoryPoints[ci]! - 1) / (N - 1)),
  }));
  const table: RotoTableRow[] = base.teams.map((t, ti) => ({ team: t.name, current_points: r1(current_.total[ti]!), ...(() => { const f = finish(base, ti); return { expected_points: f.expected_points, expected_place: f.expected_place, first_pct: f.first_pct, top_pct: f.top_pct, finish_pct: t.place.map((x) => r1(100 * x)) }; })() }))
    .sort((a, b) => b.expected_points - a.expected_points);

  const assumptions = [
    `Roto: every team is ranked in each of ${codes.join(", ")} on season totals; best of ${N} teams earns ${N} points, worst 1, tied teams split the points, most points wins. Finish chances come from ${sims} simulated rest-of-seasons with a fixed seed.`,
    `Each team's final totals = the totals so far + each player's per-game averages x games he is expected to play. Averages are the prior seasons blended with this season so far (this season's weight = games / (games + ${ROTO_CURRENT_K})). Percentages and ratios are computed from made and attempted counts.`,
    `Games left come from the NBA schedule (${gamesSource === "schedule" ? `${asOf} to ${seasonEnd}` : "the games_left you gave"}). Each player is expected to play a share of them: his games so far shrunk toward the league rate for this point of the season (an ASSUMPTION measured on 2025-26 and calibrated in the back-test, not a prediction about any one player). A known injury window or return date from the league page removes those games; a ramp-up after a return (default 80% output for 3 games) is also an assumption.`,
    `Luck was measured on 2025-26: how many games each player really plays, and per-game variation of each base stat, with their correlations. It shrinks as fewer games remain, but a large part stays (injuries and role changes).`,
    `Other teams hold the rosters you gave: no trades, adds or drops by them are modelled. Not modelled: a bench or daily lineup limits (every rostered player counts), games-played caps, positions, injured-list rules, and the playoffs.`,
    estimatedShooting
      ? `SHOOTING ESTIMATED: the host gave only percentages for some teams, so banked attempts were estimated as each rostered player's per-game attempts x games played this season. This is rougher than the made and attempted counts; the back-test measures how rough.`
      : `Made and attempted counts were given, so percentage categories are exact up to now.`,
    ...(noTeam.size ? [`No NBA team in the data for ${[...noTeam].join(", ")}: an average number of games left is used for them.`] : []),
    ...notes,
  ];

  const out: RotoOutput = {
    roto: true, categories_used: codes,
    snapshot: { generated_at: snapshot.generated_at, reference_season: snapshot.reference_season },
    league: { teams: N, roster_spots: lg.roster_spots, format: "roto" },
    basis: { as_of: asOf, season_end: seasonEnd ?? "given", top, sims, shooting_counts: estimatedShooting ? "estimated" : "exact", games_source: gamesSource },
    names, warnings: [], assumptions,
    team_check: {
      team: teams[meIdx]!.name, current_points: r1(current_.total[meIdx]!), expected_points: r1(me.expectedPoints), expected_place: r1(me.expectedPlace),
      finish_pct: me.place.map((x) => r1(100 * x)), first_pct: finish(base, meIdx).first_pct, top_pct: finish(base, meIdx).top_pct, categories, table,
    },
  };

  const moveSim = input.waiver || input.trade ? prepareRoto(teams, codes, { sims: moveSims, seed }) : null;
  const moveBase = moveSim?.evaluate();
  const delta = (a: RotoResult, ti: number, b: RotoResult) => {
    const x = finish(a, ti), y = finish(b, ti);
    return { delta_expected_points: r2(x.expected_points - y.expected_points), delta_first_pct: r1(x.first_pct - y.first_pct), delta_top_pct: r1(x.top_pct - y.top_pct) };
  };
  const catDelta = (a: RotoResult, ti: number, b: RotoResult): Record<string, number> => Object.fromEntries(codes.map((c, ci) => [c, r2(a.teams[ti]!.categoryPoints[ci]! - b.teams[ti]!.categoryPoints[ci]!)]));

  if (input.waiver && moveSim && moveBase) {
    const w = input.waiver;
    const mine = entries[meIdx]!, myPlayers = teams[meIdx]!.players;
    const openSpot = mine.length < lg.roster_spots;
    const moves: RotoMove[] = [];
    const wNames: NameResult[] = [];
    for (const cand of w.candidates ?? []) {
      const [ce] = resolveList([cand], snapshot, estimated, wNames, " (candidate)", ctx);
      if (!ce) continue;
      const add = toPlayer(ce);
      let best: RotoMove | null = null;
      const options: (number | null)[] = [...(openSpot ? [null] : []), ...mine.map((_, i) => i)];
      for (const d of options) {
        const roster = d === null ? [...myPlayers, add] : myPlayers.map((p, i) => (i === d ? add : p));
        const r = moveSim.evaluate(new Map([[meIdx, { ...teams[meIdx]!, players: roster }]]));
        const dl = delta(r, meIdx, moveBase);
        const mv: RotoMove = { add: ce.name, drop: d === null ? null : mine[d]!.name, expected_points: finish(r, meIdx).expected_points, ...dl, categories_delta: catDelta(r, meIdx, moveBase) };
        if (!best || mv.delta_expected_points > best.delta_expected_points) best = mv;
      }
      if (best) moves.push(best);
    }
    names.push(...wNames);
    moves.sort((a, b) => b.delta_expected_points - a.delta_expected_points);
    out.waiver = { baseline: finish(moveBase, meIdx), moves: moves.slice(0, Math.max(1, w.top ?? 8)), none_improve: moves.every((m) => m.delta_expected_points <= 0) };
  }

  if (input.trade && moveSim && moveBase) {
    const t = input.trade;
    const partnerIdx = standings.findIndex((s) => s.team === t.partner);
    if (!t.partner || partnerIdx < 0 || partnerIdx === meIdx) throw new Error("trade.partner must be the name of another team in league.standings (its roster is changed by the trade too)");
    if (!t.give?.length || !t.get?.length) throw new Error("trade needs give and get (names)");
    const tNames: NameResult[] = [];
    const give = resolveList(t.give, snapshot, estimated, tNames, " (give)", ctx), get = resolveList(t.get, snapshot, estimated, tNames, " (get)", ctx);
    names.push(...tNames);
    const wanted = (list: Entry[], from: Entry[], team: string) => list.filter((e) => !from.some((x) => x.id === e.id)).map((e) => `WARNING: ${e.name} is not on ${team}'s roster as given.`);
    out.warnings.push(...wanted(give, entries[meIdx]!, teams[meIdx]!.name), ...wanted(get, entries[partnerIdx]!, teams[partnerIdx]!.name));
    const gone = (rosterEntries: Entry[], players: RotoPlayer[], out_: Entry[]) => players.filter((_, i) => !out_.some((x) => x.id === rosterEntries[i]!.id));
    const mineAfter = [...gone(entries[meIdx]!, teams[meIdx]!.players, give), ...get.map(toPlayer)];
    const theirsAfter = [...gone(entries[partnerIdx]!, teams[partnerIdx]!.players, get), ...give.map(toPlayer)];
    const r = moveSim.evaluate(new Map([[meIdx, { ...teams[meIdx]!, players: mineAfter }], [partnerIdx, { ...teams[partnerIdx]!, players: theirsAfter }]]));
    out.trade = {
      partner: teams[partnerIdx]!.name,
      you: { before: finish(moveBase, meIdx), after: finish(r, meIdx), ...delta(r, meIdx, moveBase), categories_delta: catDelta(r, meIdx, moveBase) },
      partner_side: { before: finish(moveBase, partnerIdx), after: finish(r, partnerIdx), ...delta(r, partnerIdx, moveBase) },
    };
  }

  out.warnings = [...out.warnings, ...leftOutWarnings([names])];
  return out;
}

export { DEFAULT_RAMP, availabilityFromHost };
