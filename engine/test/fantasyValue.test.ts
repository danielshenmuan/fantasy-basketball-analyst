import { describe, expect, test } from "bun:test";
import golden from "./fixtures/golden-2025-26.json";
import {
  CATEGORIES, DEFAULT_TO_WEIGHT, ENGINE_VERSION, categoryZ, fantasyValue,
  type Category, type LeagueBaselines, type SeasonAverages,
} from "../src";

const baselines = golden.baselines as LeagueBaselines;
const players = golden.players as unknown as {
  name: string; inputs: SeasonAverages;
  expected: { z: Record<Category, number>; z_total_season: number };
}[];
const EPS = 1e-6;

describe("golden: reproduces production GET /v1/player_baselines", () => {
  for (const p of players) {
    test(`${p.name}: every category z`, () => {
      const z = categoryZ(p.inputs, baselines);
      for (const c of CATEGORIES) {
        // The API returns the RAW turnover z (more turnovers = higher). The engine negates it so that
        // higher is better everywhere.
        const expected = c === "TO" ? -p.expected.z[c] : p.expected.z[c];
        expect(Math.abs(z[c] - expected)).toBeLessThan(EPS);
      }
    });
    test(`${p.name}: total at toWeight=1 equals the API's z_total_season`, () => {
      const fv = fantasyValue(p.inputs, baselines, { toWeight: 1 });
      // The API returns z_total_season rounded to 3 decimals, so compare at that precision.
      expect(Math.abs(fv.total - p.expected.z_total_season)).toBeLessThanOrEqual(0.0006);
      expect(Math.round(fv.total * 1000) / 1000).toBeCloseTo(p.expected.z_total_season, 3);
    });
  }
});

describe("turnover weight", () => {
  const jokic = players.find((p) => p.name.includes("Joki"))!;
  test("default is 0.2", () => {
    expect(DEFAULT_TO_WEIGHT).toBe(0.2);
    expect(fantasyValue(jokic.inputs, baselines).categories.TO.weight).toBe(0.2);
  });
  test("total = (sum of the other 8) - w x TO z", () => {
    const eight = CATEGORIES.filter((c) => c !== "TO").reduce((s, c) => s + jokic.expected.z[c], 0);
    for (const w of [0, 0.2, 0.5, 1]) {
      const fv = fantasyValue(jokic.inputs, baselines, { toWeight: w });
      expect(Math.abs(fv.total - (eight - w * jokic.expected.z.TO))).toBeLessThan(EPS); // raw API TO z, subtracted
    }
  });
  test("weights.TO wins over toWeight", () => {
    const fv = fantasyValue(jokic.inputs, baselines, { toWeight: 1, weights: { TO: 0 } });
    expect(fv.categories.TO.weight).toBe(0);
    expect(fv.categories.TO.contribution).toBe(0);
  });
  test("a turnover-prone player gains as the weight falls; a careful one loses relatively", () => {
    const westbrook = players.find((p) => p.name.includes("Westbrook"))!; // TO z +2.68
    const wade = players.find((p) => p.name.includes("Wade"))!;           // TO z -1.07
    const gainW = fantasyValue(westbrook.inputs, baselines, { toWeight: 0.2 }).total - fantasyValue(westbrook.inputs, baselines, { toWeight: 1 }).total;
    const gainD = fantasyValue(wade.inputs, baselines, { toWeight: 0.2 }).total - fantasyValue(wade.inputs, baselines, { toWeight: 1 }).total;
    expect(gainW).toBeGreaterThan(0);
    expect(gainD).toBeLessThan(0);
  });
});

describe("league-aware weights", () => {
  const edwards = players.find((p) => p.name.includes("Edwards"))!;
  test("a punted category (weight 0) contributes nothing and is removed from the total", () => {
    const full = fantasyValue(edwards.inputs, baselines, { toWeight: 1 });
    const punt = fantasyValue(edwards.inputs, baselines, { toWeight: 1, weights: { "FT%": 0 } });
    expect(punt.categories["FT%"].contribution).toBe(0);
    expect(Math.abs(full.total - punt.total - full.categories["FT%"].contribution)).toBeLessThan(EPS);
  });
  test("a category weighted 2 counts double", () => {
    const base = fantasyValue(edwards.inputs, baselines, { toWeight: 1 });
    const dbl = fantasyValue(edwards.inputs, baselines, { toWeight: 1, weights: { BLK: 2 } });
    expect(Math.abs(dbl.categories.BLK.contribution - 2 * base.categories.BLK.contribution)).toBeLessThan(EPS);
  });
});

describe("robustness", () => {
  test("a zero or missing league std yields 0, never NaN or Infinity", () => {
    const broken: LeagueBaselines = { ...baselines, stds: { ...baselines.stds, s_fg_imp: 0, s_ft_imp: 0, s_blk: 0 } };
    const fv = fantasyValue(players[0]!.inputs, broken);
    for (const c of CATEGORIES) expect(Number.isFinite(fv.categories[c].z)).toBe(true);
    expect(fv.categories["FG%"].z).toBe(0);
    expect(Number.isFinite(fv.total)).toBe(true);
  });
  test("results carry the engine version (receipts principle)", () => {
    expect(fantasyValue(players[0]!.inputs, baselines).engine_version).toBe(ENGINE_VERSION);
  });
});

describe("sign convention: higher is better in every category", () => {
  test("a turnover-prone player has a NEGATIVE TO score, a careful one a positive score", () => {
    const westbrook = players.find((p) => p.name.includes("Westbrook"))!; // raw TO z +2.68 (very turnover-prone)
    const wade = players.find((p) => p.name.includes("Wade"))!;           // raw TO z -1.07 (very careful)
    expect(categoryZ(westbrook.inputs, baselines).TO).toBeLessThan(0);
    expect(categoryZ(wade.inputs, baselines).TO).toBeGreaterThan(0);
  });
  test("contribution of TO equals weight x z (already signed)", () => {
    const w = players.find((p) => p.name.includes("Westbrook"))!;
    const fv = fantasyValue(w.inputs, baselines, { toWeight: 1 });
    expect(fv.categories.TO.contribution).toBeCloseTo(fv.categories.TO.z, 12);
    expect(fv.categories.TO.contribution).toBeLessThan(0);
  });
});
