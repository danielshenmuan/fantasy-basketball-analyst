import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { buildBaseline, type PlayerSeason } from "../src";

const players = fx.players as unknown as PlayerSeason[];
const EPS = 1e-9;

describe("buildBaseline (M2: the rosterable pool) reproduces the independent pandas computation", () => {
  for (const [pool, expected] of Object.entries(fx.expected)) {
    test(`pool of ${pool}: every mean and spread`, () => {
      const b = buildBaseline(players, Number(pool));
      for (const [k, v] of Object.entries(expected.means)) expect(Math.abs((b.means as Record<string, number>)[k]! - (v as number))).toBeLessThan(EPS);
      for (const [k, v] of Object.entries(expected.stds)) expect(Math.abs((b.stds as Record<string, number>)[k]! - (v as number))).toBeLessThan(EPS);
    });
  }
  test("a smaller pool means a higher average (it is the better players)", () => {
    expect(buildBaseline(players, 100).means.m_pts).toBeGreaterThan(buildBaseline(players, 300).means.m_pts);
  });
  test("cameo players cannot move the baseline: dropping them from the input changes nothing", () => {
    const real = players.filter((p) => p.gp * p.mpg >= 400);
    const a = buildBaseline(players, 182), b = buildBaseline(real, 182);
    expect(Math.abs(a.means.m_pts - b.means.m_pts)).toBeLessThan(EPS);
    expect(Math.abs(a.stds.s_pts - b.stds.s_pts)).toBeLessThan(EPS);
  });
  test("an empty player list is an error, not NaN", () => {
    expect(() => buildBaseline([], 182)).toThrow();
  });
});
