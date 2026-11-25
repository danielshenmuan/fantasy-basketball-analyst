import { describe, expect, test } from "bun:test";
import {
  anyTotals, anyValue, baseOf, buildAnyBaseline, categoryValue, isStandardNine, neededStats, parseCategories, simulateAny, typicalAnyOpponents,
  type AnyPlayer, type PlayerBase,
} from "../src/anycat";
import { simulateWeeks, weeklyTotals } from "../src/matchup";
import type { SeasonAverages } from "../src/types";

const avg = (o: Partial<SeasonAverages> = {}): SeasonAverages => ({
  pts: 15, reb: 5, ast: 3, stl: 1, blk: 0.5, fg3m: 1.5, fg_pct: 0.46, ft_pct: 0.8, turnovers: 2, fga: 11, fta: 3, fgm: 5.06, ftm: 2.4,
  oreb: 1.2, dreb: 3.8, pf: 2.2, fg3a: 4, dd_rate: 0.05, td_rate: 0.002, min: 28, ...o,
});
const NEED = neededStats(["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO", "MIN", "PF", "DD", "TD", "OREB", "A/T", "3PA"]);
const base = (o: Partial<SeasonAverages> = {}): PlayerBase => baseOf(avg(o), NEED);
const team = (n: number, o: Partial<SeasonAverages> = {}, games = 3.4): AnyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ base: base(o), games, value: 10 - i }));
const NINE = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"];

describe("category names", () => {
  test("host names map to codes", () => {
    expect(parseCategories(["Field Goal Percentage (FG%)".replace(" (FG%)", ""), "3-point Shots Made", "Points Scored", "Steals", "Blocked Shots", "Assist/Turnover Ratio", "Minutes Played", "Personal Fouls", "Turnovers"]))
      .toEqual(["FG%", "3PM", "PTS", "STL", "BLK", "A/T", "MIN", "PF", "TO"]);
  });
  test("an unknown category stops it and names the category", () => {
    expect(() => parseCategories(["Points Scored", "Technical Fouls", "Ejections"])).toThrow(/Technical Fouls, Ejections/);
  });
  test("recognises the standard nine in any order", () => {
    expect(isStandardNine([...NINE].reverse())).toBe(true);
    expect(isStandardNine([...NINE.slice(0, 8), "PF"])).toBe(false);
  });
});

describe("category values", () => {
  const t = anyTotals(team(10), 10).t;
  test("points come from made shots, rebounds from both kinds", () => {
    expect(categoryValue("PTS", t)).toBeCloseTo(2 * t.fgm + t.fg3m + t.ftm);
    expect(categoryValue("REB", t)).toBeCloseTo(t.oreb + t.dreb);
  });
  test("percentages are made over attempted", () => {
    expect(categoryValue("FG%", t)).toBeCloseTo(t.fgm / t.fga);
    expect(categoryValue("A/T", t)).toBeCloseTo(t.ast / t.turnovers);
  });
  test("a stat the data file lacks is reported, not guessed", () => {
    const a = avg(); delete (a as { dd_rate?: number }).dd_rate;
    expect(() => baseOf(a, ["dd"])).toThrow(/dd/);
    expect(() => baseOf(a, ["fgm"])).not.toThrow();
  });
});

describe("simulateAny", () => {
  const me = anyTotals(team(10), 10);
  test("same seed gives the same answer", () => {
    expect(simulateAny(me, [me], NINE, { weeks: 1500, seed: 4 })).toEqual(simulateAny(me, [me], NINE, { weeks: 1500, seed: 4 }));
  });
  test("identical teams split about evenly, and win + tie + loss is 1", () => {
    const r = simulateAny(me, [me], [...NINE, "PF"], { weeks: 20000, seed: 1 });
    for (const v of Object.values(r.categories)) expect(Math.abs(v - 0.5)).toBeLessThan(0.03);
    expect(r.weekWin + r.weekTie + r.weekLoss).toBeCloseTo(1, 10);
    expect(r.distribution.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
  });
  test("with no luck, identical teams tie every category and the week", () => {
    const r = simulateAny(me, [me], ["PTS", "REB", "MIN", "PF"], { weeks: 50, luck: false });
    expect(r.weekTie).toBe(1);
    expect(r.weekWin).toBe(0);
  });
  test("fewer fouls and fewer turnovers win", () => {
    const clean = anyTotals(team(10, { pf: 1, turnovers: 1 }), 10);
    const r = simulateAny(clean, [me], ["PF", "TO"], { weeks: 4000 });
    expect(r.categories.PF).toBeGreaterThan(0.9);
    expect(r.categories.TO).toBeGreaterThan(0.9);
  });
  test("a team with more minutes and double-doubles wins those categories", () => {
    const busy = anyTotals(team(10, { min: 36, dd_rate: 0.5, td_rate: 0.1 }), 10);
    const r = simulateAny(busy, [me], ["MIN", "DD", "TD"], { weeks: 4000 });
    expect(r.categories.MIN).toBeGreaterThan(0.95);
    expect(r.categories.DD).toBeGreaterThan(0.95);
    expect(r.categories.TD).toBeGreaterThan(0.85);
  });
  test("a small shooting edge is a lean, not a lock: FG% luck is about 2.5 points a week", () => {
    // 2 points of FG% better. The difference of two teams' luck has sd ~ 2.5 x sqrt(2) = 3.5 points, so P = Phi(0.57) ~ 0.72.
    const better = anyTotals(team(10, { fgm: 5.06 + 0.22 }), 10); // +0.22 made on 11 attempts = +2.0 points
    const p = simulateAny(better, [me], ["FG%"], { weeks: 30000, seed: 9 }).categories["FG%"]!;
    expect(p).toBeGreaterThan(0.66);
    expect(p).toBeLessThan(0.78);
  });
});

describe("the new model agrees with the nine-category model on the nine categories", () => {
  // Same rosters through both paths: category win chances should agree closely (the luck models were measured the same way).
  const mk = (o: Partial<SeasonAverages>) => team(10, o);
  const mine = mk({ pts: 18, reb: 6, ast: 4, fgm: 6.4 }), theirs = mk({ pts: 16, reb: 5.5 });
  test("category and week win chances within a few points", () => {
    const a = simulateAny(anyTotals(mine, 10), [anyTotals(theirs, 10)], NINE, { weeks: 20000, seed: 3 });
    const toLegacy = (o: Partial<SeasonAverages>) => weeklyTotals(Array.from({ length: 10 }, (_, i) => ({ averages: avg(o), games: 3.4, value: 10 - i })), 10);
    const b = simulateWeeks(toLegacy({ pts: 18, reb: 6, ast: 4, fgm: 6.4 }), [toLegacy({ pts: 16, reb: 5.5 })], { weeks: 20000, seed: 3 });
    // the legacy path takes PTS/REB/AST from the averages; the new one derives PTS and REB from shots and rebound kinds, so compare the categories both read the same way
    for (const c of ["AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"] as const) expect(Math.abs(a.categories[c]! - b.categories[c])).toBeLessThan(0.05);
  });
});

describe("league-specific values and opponents", () => {
  const players = Array.from({ length: 80 }, (_, i) => ({ base: base({ pts: 10 + i * 0.2, pf: 1 + (i % 5) * 0.5 }), gp: 60, mpg: 25 }));
  test("values follow the league's categories: a foul-prone scorer is worth less when PF counts", () => {
    const withPF = ["PTS", "PF"], without = ["PTS"];
    const bl1 = buildAnyBaseline(players, withPF, 70), bl2 = buildAnyBaseline(players, without, 70);
    const fouler = base({ pts: 20, pf: 4 }), clean = base({ pts: 20, pf: 1 });
    expect(anyValue(fouler, withPF, bl1)).toBeLessThan(anyValue(clean, withPF, bl1));
    expect(anyValue(fouler, without, bl2)).toBeCloseTo(anyValue(clean, without, bl2), 10);
  });
  test("typical opponents are reproducible and one per team per league", () => {
    const pool = players.map((p, i) => ({ base: p.base, team: "AAA", value: 80 - i }));
    const a = typicalAnyOpponents(pool, { teams: 4, rosterSpots: 5 }, 3, () => 3, { leagues: 6, seed: 2 });
    expect(a.length).toBe(24);
    expect(typicalAnyOpponents(pool, { teams: 4, rosterSpots: 5 }, 3, () => 3, { leagues: 6, seed: 2 })).toEqual(a);
  });
});
