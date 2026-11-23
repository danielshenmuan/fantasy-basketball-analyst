import { describe, expect, test } from "bun:test";
import {
  LUCK_CORRELATION, luckScale, mondayOf, simulateWeeks, typicalOpponents, weeklyTotals, WEEKLY_LUCK,
  type WeeklyPlayer, type WeeklyTotals,
} from "../src/matchup";
import type { SeasonAverages } from "../src/types";

const avg = (over: Partial<SeasonAverages> = {}): SeasonAverages => ({
  pts: 15, reb: 5, ast: 3, stl: 1, blk: 0.5, fg3m: 1.5, fg_pct: 0.46, ft_pct: 0.8, turnovers: 2, fga: 11, fta: 3, fgm: 5.06, ftm: 2.4, ...over,
});
const player = (over: Partial<SeasonAverages> = {}, games = 3.4, value = 0): WeeklyPlayer => ({ averages: avg(over), games, value });
const team = (n: number, over: Partial<SeasonAverages> = {}, games = 3.4): WeeklyPlayer[] =>
  Array.from({ length: n }, (_, i) => player(over, games, 10 - i));

describe("weeklyTotals", () => {
  test("sums per-game averages times games for the best players only", () => {
    const t = weeklyTotals([player({ pts: 10 }, 4, 5), player({ pts: 20 }, 3, 9), player({ pts: 99 }, 4, -1)], 2);
    expect(t.pts).toBeCloseTo(10 * 4 + 20 * 3);
  });
  test("a player with more games counts more", () => {
    expect(weeklyTotals([player({ pts: 10 }, 4)], 1).pts).toBe(40);
    expect(weeklyTotals([player({ pts: 10 }, 2)], 1).pts).toBe(20);
  });
  test("made shots fall back to attempts x percentage when missing", () => {
    const a = avg({ fga: 10, fg_pct: 0.5 });
    delete (a as { fgm?: number }).fgm;
    expect(weeklyTotals([{ averages: a, games: 2, value: 0 }], 1).fgm).toBeCloseTo(10);
  });
});

describe("luck model", () => {
  test("the measured luck correlation matrix is valid (positive definite)", () => {
    expect(() => simulateWeeks(weeklyTotals(team(10), 10), [weeklyTotals(team(10), 10)], { weeks: 10 })).not.toThrow();
    expect(LUCK_CORRELATION.length).toBe(7);
    LUCK_CORRELATION.forEach((row, i) => row.forEach((v, j) => expect(v).toBe(LUCK_CORRELATION[j]![i]!)));
  });
  test("luck scale is 1 at the 13 players it was measured on", () => {
    expect(luckScale(13)).toBe(1);
    expect(luckScale(10)).toBeCloseTo(1.14, 2);
  });
  test("luck table is the measured one", () => {
    expect(WEEKLY_LUCK.blk).toBe(0.23);
    expect(WEEKLY_LUCK.pts).toBe(0.08);
  });
});

describe("simulateWeeks", () => {
  const me = weeklyTotals(team(10), 10);
  test("same seed gives the same answer", () => {
    const a = simulateWeeks(me, [me], { weeks: 2000, seed: 5 });
    const b = simulateWeeks(me, [me], { weeks: 2000, seed: 5 });
    expect(a).toEqual(b);
  });
  test("identical teams split about evenly", () => {
    const r = simulateWeeks(me, [me], { weeks: 20000, seed: 1 });
    for (const v of Object.values(r.categories)) expect(Math.abs(v - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(r.weekWin - 0.5)).toBeLessThan(0.02);
  });
  test("a much stronger team wins nearly every week", () => {
    const strong = weeklyTotals(team(10, { pts: 30, reb: 10, ast: 8, stl: 2, blk: 2, fg3m: 3, turnovers: 1, fg_pct: 0.55, fgm: 6.05, ft_pct: 0.9, ftm: 2.7 }), 10);
    expect(simulateWeeks(strong, [me], { weeks: 5000 }).weekWin).toBeGreaterThan(0.99);
    expect(simulateWeeks(me, [strong], { weeks: 5000 }).weekWin).toBeLessThan(0.01);
  });
  test("fewer turnovers win the turnover category", () => {
    const careful = weeklyTotals(team(10, { turnovers: 1 }), 10);
    expect(simulateWeeks(careful, [me], { weeks: 5000 }).categories.TO).toBeGreaterThan(0.95);
  });
  test("FG% is made over attempted, not the mean of game percentages", () => {
    const better = weeklyTotals(team(10, { fgm: 6.5 }), 10); // same attempts, more makes
    expect(simulateWeeks(better, [me], { weeks: 5000 }).categories["FG%"]).toBeGreaterThan(0.95);
  });
  test("without luck a small edge always wins; with luck it is a lean, not a lock", () => {
    const edge: WeeklyTotals = { ...me, pts: me.pts * 1.05 };
    expect(simulateWeeks(edge, [me], { weeks: 2000, luck: false }).categories.PTS).toBe(1);
    const lucky = simulateWeeks(edge, [me], { weeks: 20000 }).categories.PTS;
    expect(lucky).toBeGreaterThan(0.55);
    expect(lucky).toBeLessThan(0.8);
  });
  test("more games for the same players is a real edge", () => {
    const more = weeklyTotals(team(10, {}, 4), 10);
    const fewer = weeklyTotals(team(10, {}, 3), 10);
    expect(simulateWeeks(more, [fewer], { weeks: 5000 }).categories.PTS).toBeGreaterThan(0.9);
  });
  test("distribution sums to 1 and week win is the share at 5 or more", () => {
    const r = simulateWeeks(me, [me], { weeks: 3000 });
    expect(r.distribution.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
    expect(r.distribution.slice(5).reduce((s, x) => s + x, 0)).toBeCloseTo(r.weekWin, 10);
  });
  test("rejects an empty opponent list", () => {
    expect(() => simulateWeeks(me, [])).toThrow();
  });
});

describe("typicalOpponents", () => {
  const players = Array.from({ length: 60 }, (_, i) => ({ averages: avg({ pts: 10 + i * 0.2 }), team: i % 2 ? "AAA" : "BBB", value: 60 - i }));
  test("returns one entry per team per league and is reproducible", () => {
    const a = typicalOpponents(players, { teams: 4, rosterSpots: 5 }, 3, () => 3, { leagues: 10, seed: 2 });
    expect(a.length).toBe(40);
    expect(typicalOpponents(players, { teams: 4, rosterSpots: 5 }, 3, () => 3, { leagues: 10, seed: 2 })).toEqual(a);
  });
  test("uses each player's team games", () => {
    const four = typicalOpponents(players, { teams: 4, rosterSpots: 5 }, 3, () => 4, { leagues: 5, seed: 2 });
    const three = typicalOpponents(players, { teams: 4, rosterSpots: 5 }, 3, () => 3, { leagues: 5, seed: 2 });
    expect(four[0]!.pts).toBeCloseTo((three[0]!.pts * 4) / 3, 8);
  });
  test("needs enough players", () => {
    expect(() => typicalOpponents(players.slice(0, 5), { teams: 4, rosterSpots: 5 }, 3, () => 3)).toThrow();
  });
});

describe("luck scales with the lineup size", () => {
  test("fewer starters means more luck, so the same edge is less certain", () => {
    const me = weeklyTotals(team(10), 10);
    const edge: WeeklyTotals = { ...me, pts: me.pts * 1.05 };
    const at13 = simulateWeeks(edge, [me], { weeks: 20000, slots: 13 }).categories.PTS;
    const at5 = simulateWeeks(edge, [me], { weeks: 20000, slots: 5 }).categories.PTS;
    expect(at5).toBeLessThan(at13);
  });
});

describe("mondayOf", () => {
  test("weeks run Monday to Sunday", () => {
    expect(mondayOf("2026-11-23")).toBe("2026-11-23"); // Monday
    expect(mondayOf("2026-11-29")).toBe("2026-11-23"); // Sunday
    expect(mondayOf("2026-11-22T20:15:00Z")).toBe("2026-11-16"); // Sunday of the week before
    expect(mondayOf("2026-12-01")).toBe("2026-11-30");
  });
});
