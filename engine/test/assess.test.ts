import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import {
  CATEGORIES, assessTeam, bandFor, buildBaseline, categoryZ, percentileOf, simulateBenchmark,
  type PlayerHistory, type PlayerSeason, type RosterPlayer, type SimPlayer,
} from "../src";

const players = fx.players as unknown as PlayerSeason[];
const baseline = buildBaseline(players, 182);
const hist = (p: PlayerSeason): PlayerHistory => ({ player_id: p.player_id, name: p.name, seasons: [{ season: "2025-26", gp: Math.max(p.gp, 65), mpg: p.mpg, averages: p.averages }] });
const sim: SimPlayer[] = players.map((p) => {
  const z = categoryZ(p.averages, baseline);
  return { id: p.player_id, z, total: CATEGORIES.reduce((s, c) => s + z[c], 0) };
});
const settings = { teams: 14, rosterSpots: 13 };
const bench = simulateBenchmark(sim, settings, { leagues: 300, seed: 11 });
const REF = "2025-26";
const byValue = [...players].sort((a, b) => sim.find((s) => s.id === b.player_id)!.total - sim.find((s) => s.id === a.player_id)!.total);
const top = (n: number): RosterPlayer[] => byValue.slice(0, n).map((p) => ({ name: p.name, history: hist(p) }));

describe("bands and percentiles", () => {
  test("bandFor cutoffs", () => {
    expect([90, 85, 70, 60, 50, 40, 20].map((p) => bandFor(p))).toEqual(["elite", "elite", "strong", "strong", "neutral", "neutral", "weak"]);
  });
  test("percentileOf: ties count half", () => {
    expect(percentileOf([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileOf([1, 2, 3, 4], 5)).toBe(100);
    expect(percentileOf([1, 2, 2, 3], 2)).toBe(50);
  });
});

describe("assessTeam", () => {
  test("13 best players are elite in several categories", () => {
    const a = assessTeam(top(13), baseline, bench, { reference: REF });
    expect(CATEGORIES.filter((c) => a.categories[c].band === "elite").length).toBeGreaterThanOrEqual(4);
  });
  test("an empty roster counts as average players: near the middle", () => {
    const a = assessTeam([], baseline, bench, { reference: REF });
    for (const c of CATEGORIES) {
      expect(a.categories[c].percentile).toBeGreaterThan(30);
      expect(a.categories[c].percentile).toBeLessThan(70);
    }
  });
  test("an IL player is not counted", () => {
    const base = top(12);
    const withIL: RosterPlayer[] = [...base, { ...top(13)[12]!, status: "IL" }];
    const a = assessTeam(base, baseline, bench, { reference: REF });
    const b = assessTeam(withIL, baseline, bench, { reference: REF });
    for (const c of CATEGORIES) expect(b.categories[c].total).toBeCloseTo(a.categories[c].total, 12);
    expect(b.players.find((p) => p.status === "IL")!.counted).toBe(false);
  });
  test("a player with no data is flagged and counts as zero", () => {
    const rookie: RosterPlayer = { name: "Rookie", history: { player_id: null, name: "Rookie", seasons: [] } };
    const a = assessTeam([...top(12), rookie], baseline, bench, { reference: REF });
    const p = a.players.find((x) => x.name === "Rookie")!;
    expect(p.confidence).toBe("none"); expect(p.counted).toBe(true);
    const b = assessTeam(top(12), baseline, bench, { reference: REF });
    for (const c of CATEGORIES) expect(a.categories[c].total).toBeCloseTo(b.categories[c].total, 12);
  });
  test("more players than spots: best 13 count", () => {
    const a = assessTeam(top(15), baseline, bench, { reference: REF });
    expect(a.players.filter((p) => p.counted).length).toBe(13);
  });
  test("result carries assumptions and engine version", () => {
    const a = assessTeam(top(13), baseline, bench, { reference: REF });
    expect(a.assumptions.length).toBeGreaterThanOrEqual(4);
    expect(a.engine_version).toBe("0.3.0");
  });
});
