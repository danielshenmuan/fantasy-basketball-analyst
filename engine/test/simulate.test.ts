import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { CATEGORIES, buildBaseline, categoryZ, simulateBenchmark, type PlayerSeason, type SimPlayer } from "../src";

const players = fx.players as unknown as PlayerSeason[];
const baseline = buildBaseline(players, 182);
const sim: SimPlayer[] = players.map((p) => {
  const z = categoryZ(p.averages, baseline);
  return { id: p.player_id, z, total: CATEGORIES.reduce((s, c) => s + z[c], 0) };
});
const settings = { teams: 14, rosterSpots: 13 };

describe("simulateBenchmark", () => {
  const b = simulateBenchmark(sim, settings, { leagues: 200, seed: 7 });
  test("one total per simulated team in every category, sorted ascending", () => {
    for (const c of CATEGORIES) {
      expect(b.teamSums[c].length).toBe(200 * 14);
      for (let i = 1; i < b.teamSums[c].length; i++) expect(b.teamSums[c][i]!).toBeGreaterThanOrEqual(b.teamSums[c][i - 1]!);
    }
  });
  test("invariant: every pool player drafted once per league, so mean team total = pool total / teams", () => {
    const pool = [...sim].sort((a, c) => c.total - a.total).slice(0, 14 * 13);
    for (const c of CATEGORIES) {
      const poolSum = pool.reduce((s, p) => s + p.z[c], 0);
      const mean = b.teamSums[c].reduce((s, x) => s + x, 0) / b.teamSums[c].length;
      expect(Math.abs(mean - poolSum / 14)).toBeLessThan(1e-9);
    }
  });
  test("reproducible with same seed, different with another", () => {
    const again = simulateBenchmark(sim, settings, { leagues: 200, seed: 7 });
    expect(again.teamSums.PTS).toEqual(b.teamSums.PTS);
    expect(simulateBenchmark(sim, settings, { leagues: 200, seed: 8 }).teamSums.PTS).not.toEqual(b.teamSums.PTS);
  });
  test("not enough players is an error", () => {
    expect(() => simulateBenchmark(sim.slice(0, 50), settings)).toThrow();
  });
  test("pool mean equals the mean z of the drafted pool", () => {
    const pool = [...sim].sort((a, c) => c.total - a.total).slice(0, 14 * 13);
    for (const c of CATEGORIES) expect(b.poolMean[c]).toBeCloseTo(pool.reduce((s, p) => s + p.z[c], 0) / pool.length, 12);
  });
  test("robustness: the pick-randomness assumption moves team spread by under 25%", () => {
    const sd = (x: number[]) => { const m = x.reduce((s, v) => s + v, 0) / x.length; return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length); };
    const strict = sd(simulateBenchmark(sim, settings, { leagues: 200, seed: 3, pickWeights: [1] }).teamSums.PTS);
    const loose = sd(simulateBenchmark(sim, settings, { leagues: 200, seed: 3, pickWeights: [0.2, 0.2, 0.2, 0.2, 0.2] }).teamSums.PTS);
    expect(Math.abs(strict - loose) / strict).toBeLessThan(0.25);
  });
});
