import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { CATEGORIES, analyze, type PlayerSeason, type Snapshot } from "../src";

const fixture = fx.players as unknown as PlayerSeason[];
const snapshot: Snapshot = {
  version: 1, generated_at: "2026-11-14T00:00:00Z", reference_season: "2025-26",
  players: fixture.map((p) => ({ id: p.player_id, name: p.name, seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: p.averages }] })),
};
const league = { teams: 14, roster_spots: 13 };
const roster = ["James Harden", "Josh Giddey", "Darius Garland", "Jayson Tatum", "Quentin Grimes", "Onyeka Okongwu", "Kevin Porter", "Herb Jones", "Gui Santos"];

describe("analyze", () => {
  const out = analyze({ league, roster: roster.map((name) => ({ name })) }, snapshot);
  test("assesses every category and ranks them strongest first", () => {
    expect(Object.keys(out.categories).sort()).toEqual([...CATEGORIES].sort());
    expect(out.ranking.length).toBe(9);
    for (let i = 1; i < out.ranking.length; i++) expect(out.ranking[i - 1]!.percentile).toBeGreaterThanOrEqual(out.ranking[i]!.percentile);
  });
  test("reports how each typed name was read", () => {
    expect(out.names.find((n) => n.input === "Herb Jones")!.matched).toBe("Herbert Jones");
    expect(out.names.every((n) => n.status === "matched")).toBe(true);
  });
  test("is deterministic", () => {
    const again = analyze({ league, roster: roster.map((name) => ({ name })) }, snapshot);
    expect(again.categories).toEqual(out.categories);
  });
  test("ambiguous and unknown names are flagged, counted as average, and never guessed", () => {
    const o = analyze({ league, roster: [{ name: "Porter" }, { name: "Nobody Atall" }, { name: "James Harden" }] }, snapshot);
    expect(o.names[0]!.status).toBe("ambiguous");
    expect(o.names[0]!.candidates!.length).toBeGreaterThan(1);
    expect(o.names[1]!.status).toBe("not_found");
    expect(o.assumptions.some((a) => a.includes('"Porter"'))).toBe(true);
    expect(o.players.find((p) => p.name === "Nobody Atall")!.confidence).toBe("none");
  });
  test("IL players are not counted", () => {
    const a = analyze({ league, roster: [{ name: "James Harden" }, { name: "Josh Giddey" }] }, snapshot);
    const b = analyze({ league, roster: [{ name: "James Harden" }, { name: "Josh Giddey" }, { name: "Jayson Tatum", status: "IL" }] }, snapshot);
    for (const c of CATEGORIES) expect(b.categories[c].total).toBeCloseTo(a.categories[c].total, 12);
  });
  test("league size changes the benchmark", () => {
    const small = analyze({ league: { teams: 8, roster_spots: 10 }, roster: roster.map((name) => ({ name })) }, snapshot);
    expect(small.categories.PTS.benchmark.median).not.toBe(out.categories.PTS.benchmark.median);
  });
  test("bad input gives a clear error", () => {
    expect(() => analyze({ league: { teams: 2, roster_spots: 13 }, roster: [{ name: "x" }] }, snapshot)).toThrow("league.teams");
    expect(() => analyze({ league, roster: [] }, snapshot)).toThrow("roster");
    expect(() => analyze({ league: { teams: 30, roster_spots: 20 }, roster: [{ name: "x" }] }, snapshot)).toThrow("snapshot has only");
  });
});

describe("analyze: season blend of the league baseline (D1)", () => {
  const withCurrent = (games: number, scale: number, keepGp = false): Snapshot => ({
    ...snapshot,
    players: snapshot.players.map((p) => {
      const s = p.seasons[0]!;
      return { ...p, seasons: [{ season: "2026-27", gp: keepGp ? s.gp : games, mpg: s.mpg, averages: { ...s.averages, pts: s.averages.pts * scale } }, ...p.seasons] };
    }),
  });
  const req = { league, roster: roster.map((name) => ({ name })) };

  test("without a season in progress the weight is 0 and nothing changes", () => {
    const o = analyze(req, snapshot);
    expect(o.baseline).toEqual({ reference_season: "2025-26", current_season: null, team_games: 0, weight_current: 0 });
  });
  test("reports the weight g/(g+40), with g read as the most games any player has played this season", () => {
    const o = analyze(req, withCurrent(15, 1));
    expect(o.baseline.current_season).toBe("2026-27");
    expect(o.baseline.team_games).toBe(15);
    expect(o.baseline.weight_current).toBeCloseTo(15 / 55, 10);
    expect(o.assumptions.some((a) => a.includes("blend"))).toBe(true);
  });
  test("a season identical to last season leaves every percentile unchanged", () => {
    const a = analyze(req, snapshot), b = analyze(req, withCurrent(15, 1, true));
    for (const c of CATEGORIES) {
      expect(b.categories[c].percentile).toBeCloseTo(a.categories[c].percentile, 6);
      expect(b.categories[c].band).toBe(a.categories[c].band);
    }
  });
  test("a higher-scoring season in progress moves the PTS baseline, not the other categories' means", () => {
    const a = analyze(req, snapshot), b = analyze(req, withCurrent(30, 1.2));
    expect(b.categories.PTS.percentile).not.toBe(a.categories.PTS.percentile);
  });
  test("team_games can be given explicitly", () => {
    const o = analyze({ ...req, team_games: 40 }, withCurrent(15, 1));
    expect(o.baseline.weight_current).toBeCloseTo(0.5, 10);
  });
});
