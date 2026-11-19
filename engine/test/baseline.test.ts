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

import { blendBaselines, blendWeight } from "../src/baseline";

describe("season blend (D1: w = g / (g + 40))", () => {
  test("weight is the share of this season: 0 at opening night, 0.5 at 40 games, about 0.67 at 80", () => {
    expect(blendWeight(0)).toBe(0);
    expect(blendWeight(40)).toBeCloseTo(0.5, 10);
    expect(blendWeight(80)).toBeCloseTo(2 / 3, 10);
    expect(blendWeight(15)).toBeCloseTo(15 / 55, 10);
  });
  test("negative or non-finite games count as zero", () => {
    expect(blendWeight(-3)).toBe(0);
    expect(blendWeight(Number.NaN)).toBe(0);
  });
  const mk = (v: number): ReturnType<typeof buildBaseline> => ({
    means: { m_pts: v, m_reb: v, m_ast: v, m_stl: v, m_blk: v, m_fg3m: v, m_fg_pct: v, m_ft_pct: v, m_tov: v },
    stds: { s_pts: v, s_reb: v, s_ast: v, s_stl: v, s_blk: v, s_fg3m: v, s_tov: v, s_fg_imp: v, s_ft_imp: v },
  });
  test("blends every mean and std linearly: (1 - w) x last season + w x this season", () => {
    const b = blendBaselines(mk(10), mk(20), 0.25);
    expect(b.means.m_pts).toBeCloseTo(12.5, 10);
    expect(b.stds.s_fg_imp).toBeCloseTo(12.5, 10);
    expect(Object.keys(b.means).length).toBe(9);
    expect(Object.keys(b.stds).length).toBe(9);
  });
  test("w = 0 returns last season unchanged, w = 1 returns this season", () => {
    expect(blendBaselines(mk(10), mk(20), 0)).toEqual(mk(10));
    expect(blendBaselines(mk(10), mk(20), 1)).toEqual(mk(20));
  });
});
