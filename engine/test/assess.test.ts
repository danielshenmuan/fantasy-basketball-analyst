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

describe("FG% and FT% are ranked by the team's rate (issue #24)", () => {
  const shotsOf = (p: PlayerSeason) => { const a = p.averages; return { fgm: a.fgm ?? a.fga * a.fg_pct, fga: a.fga, ftm: a.ftm ?? a.fta * a.ft_pct, fta: a.fta }; };
  const simRate: SimPlayer[] = sim.map((s, i) => ({ ...s, shots: shotsOf(players[i]!) }));
  const benchRate = simulateBenchmark(simRate, settings, { leagues: 300, seed: 11 });

  test("without shots the old impact sum is used; with shots the benchmark holds rates", () => {
    expect(bench.ratesAsRates).toBe(false);
    expect(benchRate.ratesAsRates).toBe(true);
    for (const c of ["FG%", "FT%"] as const) {
      expect(benchRate.teamSums[c][0]!).toBeGreaterThan(0);
      expect(benchRate.teamSums[c].at(-1)!).toBeLessThan(1);
    }
  });
  test("the other seven categories are identical with or without shots", () => {
    for (const c of CATEGORIES.filter((x) => x !== "FG%" && x !== "FT%")) expect(benchRate.teamSums[c]).toEqual(bench.teamSums[c]);
  });
  test("a team's FT% total is made / attempted over the counted lineup", () => {
    const roster = top(13);
    const a = assessTeam(roster, baseline, benchRate, { reference: REF });
    const counted = a.players.filter((p) => p.counted).map((p) => players.find((x) => x.name === p.name)!);
    const made = counted.reduce((t, p) => t + shotsOf(p).ftm, 0), att = counted.reduce((t, p) => t + shotsOf(p).fta, 0);
    expect(a.categories["FT%"].total).toBeCloseTo(made / att, 10);
    expect(a.categories["FT%"].total).toBeGreaterThan(0);
    expect(a.categories["FT%"].total).toBeLessThan(1);
  });
  test("free-throw volume alone does not make a poor shooting team strong", () => {
    // the 13 players with the most free-throw attempts, versus the 13 best free-throw shooters among players who take some
    const byAtt = [...players].sort((a, b) => b.averages.fta - a.averages.fta).slice(0, 13);
    const rate = (ps: PlayerSeason[]) => ps.reduce((t, p) => t + shotsOf(p).ftm, 0) / ps.reduce((t, p) => t + shotsOf(p).fta, 0);
    const asRoster = (ps: PlayerSeason[]): RosterPlayer[] => ps.map((p) => ({ name: p.name, history: hist(p) }));
    const a = assessTeam(asRoster(byAtt), baseline, benchRate, { reference: REF });
    // percentile follows the rate: a team shooting below the simulated median rate is not above the 50th percentile
    const median = benchRate.teamSums["FT%"][Math.floor(benchRate.teamSums["FT%"].length / 2)]!;
    if (rate(byAtt) < median) expect(a.categories["FT%"].percentile).toBeLessThanOrEqual(50);
    else expect(a.categories["FT%"].percentile).toBeGreaterThanOrEqual(50);
  });
  test("an empty roster is still near the middle in FG% and FT%", () => {
    const a = assessTeam([], baseline, benchRate, { reference: REF });
    for (const c of ["FG%", "FT%"] as const) {
      expect(a.categories[c].percentile).toBeGreaterThan(25);
      expect(a.categories[c].percentile).toBeLessThan(75);
    }
  });
});
