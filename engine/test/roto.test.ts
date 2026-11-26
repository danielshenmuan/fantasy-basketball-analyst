import { describe, expect, test } from "bun:test";
import { rankPoints, rotoPoints, expectedShare, gamesSd, prepareRoto, simulateRoto, type RotoPlayer, type RotoTeam } from "../src/roto";
import { baseOf, neededStats, type PlayerBase } from "../src/anycat";

const NEED = neededStats(["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO", "A/T"]);
const mk = (o: Partial<Record<string, number>> = {}): PlayerBase =>
  baseOf({ pts: 15, reb: 5, ast: 3, stl: 1, blk: 0.5, fg3m: 1.5, fg_pct: 0.46, ft_pct: 0.8, turnovers: 2, fga: 10, fta: 3, fgm: 5, ftm: 2.4, oreb: 1, dreb: 4, pf: 2, fg3a: 4, dd_rate: 0, td_rate: 0, min: 28, ...o } as never, NEED);
let nextId = 1;
const player = (o: Partial<Record<string, number>> = {}, games = 20, share = 1): RotoPlayer => ({ id: nextId++, base: mk(o), teamGamesLeft: games, expShare: share });
const team = (name: string, players: RotoPlayer[], banked: RotoTeam["banked"] = {}): RotoTeam => ({ name, players, banked });
const roster = (n: number, o: Partial<Record<string, number>> = {}, games = 20): RotoPlayer[] => Array.from({ length: n }, () => player(o, games));
/** Per-game stats of a player who scores `pts` points a game (PTS is counted from makes). */
const scorer = (pts: number, o: Partial<Record<string, number>> = {}) => ({ fgm: (pts - 3.9) / 2, ...o });
const BANK = (pts: number): RotoTeam["banked"] => ({ PTS: { num: pts }, REB: { num: 0 } });

describe("rank points", () => {
  test("best of N gets N, worst gets 1; lower-is-better flips", () => {
    expect(rankPoints([10, 20, 30], false)).toEqual([1, 2, 3]);
    expect(rankPoints([10, 20, 30], true)).toEqual([3, 2, 1]);
  });
  test("tied teams split the points evenly", () => {
    expect(rankPoints([10, 10, 30], false)).toEqual([1.5, 1.5, 3]);
    expect(rankPoints([30, 10, 10, 10], false)).toEqual([4, 2, 2, 2]);
    expect(rankPoints([5, 5, 5], true)).toEqual([2, 2, 2]);
  });
  test("a whole table always hands out N(N+1)/2 points per category", () => {
    const { total, byCategory } = rotoPoints([[3, 1, 2, 2], [9, 9, 1, 5]], [false, true]);
    expect(byCategory[0]).toEqual([4, 1, 2.5, 2.5]);
    expect(byCategory[1]).toEqual([1.5, 1.5, 4, 3]);
    expect(total.reduce((s, x) => s + x, 0)).toBe(20);
  });
});

describe("games", () => {
  test("a player with no games so far is expected at the league rate, a big sample keeps his own rate", () => {
    const r = expectedShare(0, 20, 60);
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0.9);
    expect(expectedShare(70, 70, 60)).toBeGreaterThan(0.85);
    expect(expectedShare(35, 70, 60)).toBeLessThan(0.65);
    expect(expectedShare(20, 20, 60)).toBeGreaterThan(expectedShare(5, 20, 60));
  });
  test("share stays between 0 and 1 and the spread grows with the games left", () => {
    for (const left of [1, 5, 30, 70]) { const s = expectedShare(3, 60, left); expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(1); }
    expect(gamesSd(0)).toBe(0);
    expect(gamesSd(60)).toBeGreaterThan(gamesSd(20));
  });
});

describe("final totals", () => {
  const codes = ["PTS", "REB"];
  test("a counting category is banked plus per-game average times games left", () => {
    const a = team("A", [player({ pts: 20, fgm: 8, fg3m: 0, ftm: 4 }, 10)], BANK(100));
    const b = team("B", [player({ pts: 0, fgm: 0, fg3m: 0, ftm: 0 }, 10)], BANK(150));
    const r = simulateRoto([a, b], ["PTS"], { luck: false });
    // A: 100 + (2*8 + 0 + 4) * 10 = 300 vs B: 150
    expect(r.teams[0]!.finalValues[0]).toBeCloseTo(300, 6);
    expect(r.teams[1]!.finalValues[0]).toBeCloseTo(150, 6);
    expect(r.teams[0]!.expectedPoints).toBe(2);
  });
  test("a percentage comes from made and attempted counts, not from averaging percentages", () => {
    const a: RotoTeam = team("A", [player({ fgm: 5, fga: 10 }, 10)], { "FG%": { num: 100, den: 200 } });
    const b: RotoTeam = team("B", [player({ fgm: 5, fga: 10 }, 10)], { "FG%": { num: 130, den: 200 } });
    const r = simulateRoto([a, b], ["FG%"], { luck: false });
    expect(r.teams[0]!.finalValues[0]).toBeCloseTo((100 + 50) / (200 + 100), 9);
    expect(r.teams[1]!.finalValues[0]).toBeCloseTo((130 + 50) / (200 + 100), 9);
    expect(r.teams[1]!.expectedPoints).toBe(2);
  });
  test("a ratio category (assist to turnover) uses banked assists and turnovers", () => {
    const a = team("A", [player({ ast: 5, turnovers: 1 }, 10)], { "A/T": { num: 100, den: 50 } });
    const r = simulateRoto([a, team("B", [player({ ast: 5, turnovers: 1 }, 10)], { "A/T": { num: 10, den: 100 } })], ["A/T"], { luck: false });
    expect(r.teams[0]!.finalValues[0]).toBeCloseTo((100 + 50) / (50 + 10), 9);
    expect(r.teams[0]!.expectedPoints).toBe(2);
  });
  test("lower-is-better: the team with fewer turnovers earns the points", () => {
    const a = team("A", [player({ turnovers: 1 }, 10)], { TO: { num: 100 } });
    const b = team("B", [player({ turnovers: 3 }, 10)], { TO: { num: 100 } });
    const r = simulateRoto([a, b], ["TO"], { luck: false });
    expect(r.teams[0]!.expectedPoints).toBe(2);
    expect(r.teams[1]!.expectedPoints).toBe(1);
  });
  test("games left are scaled by the expected share of games played", () => {
    const full = team("A", [player({ pts: 20, fgm: 8, fg3m: 0, ftm: 4 }, 10, 1)], BANK(0));
    const half = team("B", [player({ pts: 20, fgm: 8, fg3m: 0, ftm: 4 }, 10, 0.5)], BANK(0));
    const r = simulateRoto([full, half], ["PTS"], { luck: false });
    expect(r.teams[0]!.finalValues[0]).toBeCloseTo(200, 6);
    expect(r.teams[1]!.finalValues[0]).toBeCloseTo(100, 6);
  });
});

describe("simulation", () => {
  const league = (leader = 0) => [0, 1, 2, 3, 4, 5].map((i) => team(`T${i}`, roster(10, scorer(15 + (i === leader ? 5 : 0) + i * 0.3), 30), { PTS: { num: 1000 }, REB: { num: 1000 }, AST: { num: 500 } }));
  const codes = ["PTS", "REB", "AST"];
  test("finish chances add up: each team across places, each place across teams", () => {
    const r = simulateRoto(league(), codes, { sims: 600, seed: 3 });
    for (const t of r.teams) expect(t.place.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    for (let p = 0; p < 6; p++) expect(r.teams.reduce((s, t) => s + t.place[p]!, 0)).toBeCloseTo(1, 9);
    expect(r.teams.reduce((s, t) => s + t.expectedPoints, 0)).toBeCloseTo(3 * 21, 6);
  });
  test("identical teams split the points and the places", () => {
    const same = [0, 1, 2].map((i) => team(`S${i}`, [player({}, 10)], BANK(100)));
    const r = simulateRoto(same, ["PTS"], { luck: false });
    for (const t of r.teams) { expect(t.expectedPoints).toBeCloseTo(2, 9); expect(t.place[0]).toBeCloseTo(1 / 3, 9); }
  });
  test("without luck a clear leader is first for certain; with luck it is likely but not certain", () => {
    const sure = simulateRoto(league(), ["PTS"], { luck: false });
    expect(sure.teams[0]!.place[0]).toBe(1);
    const lucky = simulateRoto(league(), ["PTS"], { sims: 1500, seed: 5 });
    expect(lucky.teams[0]!.place[0]).toBeGreaterThan(0.5);
    expect(lucky.teams[0]!.place[0]).toBeLessThan(1);
  });
  test("deterministic for a seed; a different seed moves the estimate", () => {
    const l = league();
    const a = simulateRoto(l, codes, { sims: 500, seed: 9 }), b = simulateRoto(l, codes, { sims: 500, seed: 9 });
    expect(a).toEqual(b);
    expect(simulateRoto(l, codes, { sims: 500, seed: 10 })).not.toEqual(a);
  });
  test("less time left means less luck: the same lead is safer with 5 games left than with 60", () => {
    const mkLeague = (g: number) => [0, 1, 2, 3].map((i) => team(`T${i}`, roster(10, scorer(15 + i * 0.5), g), { PTS: { num: 1000 + (i === 0 ? 0 : -60) } }));
    const early = simulateRoto(mkLeague(60), ["PTS"], { sims: 1500, seed: 2 }).teams[0]!.place[0]!;
    const late = simulateRoto(mkLeague(5), ["PTS"], { sims: 1500, seed: 2 }).teams[0]!.place[0]!;
    expect(late).toBeGreaterThan(early);
  });
  test("evaluating a changed roster re-uses the other teams' draws, so a better player never hurts", () => {
    const base = league();
    const sim = prepareRoto(base, codes, { sims: 800, seed: 4 });
    const before = sim.evaluate().teams[5]!;
    const better = team("T5", [...base[5]!.players.slice(1), player({ fgm: 11, fg3m: 2, ftm: 6, oreb: 3, dreb: 7, ast: 6 }, 30)], base[5]!.banked);
    const after = sim.evaluate(new Map([[5, better]])).teams[5]!;
    expect(after.expectedPoints).toBeGreaterThan(before.expectedPoints);
    expect(sim.evaluate().teams[5]).toEqual(before);
  });
});
