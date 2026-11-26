import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { analyzeLeague, analyze, type PlayerSeason, type Snapshot } from "../src";
import { baseOf, parseWeights, pointsOf } from "../src/anycat";
import type { AnyAnalyzeOutput } from "../src/analyzeAny";

const fixture = fx.players as unknown as PlayerSeason[];
const ext = (a: PlayerSeason["averages"]) => ({
  ...a, oreb: a.reb * 0.25, dreb: a.reb * 0.75, pf: 2.1, fg3a: a.fg3m / 0.36, dd_rate: Math.min(0.9, a.reb * a.pts / 400), td_rate: a.ast > 7 ? 0.05 : 0,
});
const build = (extra: boolean): Snapshot => ({
  version: 1, generated_at: "2026-11-14T00:00:00Z", reference_season: "2025-26",
  players: fixture.map((p) => ({ id: p.player_id, name: p.name, seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: extra ? ext(p.averages) : p.averages }] })),
});
const snapshot = build(true);
const league = { teams: 12, roster_spots: 13 };
const roster = ["James Harden", "Josh Giddey", "Darius Garland", "Jayson Tatum", "Quentin Grimes", "Onyeka Okongwu", "Kevin Porter", "Herb Jones", "Gui Santos"].map((name) => ({ name }));
const cats = ["Points", "Rebounds", "Assists", "Steals", "Blocks", "3-pointers made", "Turnovers", "Double-doubles", "Field goal percentage", "Free throw percentage", "Personal fouls"];

describe("analyzeLeague", () => {
  test("the standard nine take the original path", () => {
    const nine = ["Points", "Rebounds", "Assists", "Steals", "Blocks", "3-pointers made", "Field goal percentage", "Free throw percentage", "Turnovers"];
    const a = analyzeLeague({ league: { ...league, categories: nine }, roster }, snapshot);
    expect("custom_categories" in a).toBe(false);
    const same = (x: unknown) => ({ ...(x as object), league });
    expect(same(a)).toEqual(same(analyze({ league, roster }, snapshot)));
  });
  test("a custom list is ranked, matched and deterministic", () => {
    const run = () => analyzeLeague({ league: { ...league, categories: cats }, roster, matchup: { weeks: 1500 } }, snapshot) as AnyAnalyzeOutput;
    const out = run();
    expect(out.custom_categories).toBe(true);
    expect(out.ranking.length).toBe(11);
    expect(out.names.every((n) => n.status === "matched")).toBe(true);
    const m = out.matchup!;
    expect(m.week_win_pct + m.week_tie_pct + m.week_loss_pct).toBeGreaterThanOrEqual(99);
    expect(m.week_win_pct + m.week_tie_pct + m.week_loss_pct).toBeLessThanOrEqual(101);
    expect(Object.keys(m.categories).length).toBe(11);
    expect(run()).toEqual(out);
  });
  test("an unknown category stops with its name", () => {
    expect(() => analyzeLeague({ league: { ...league, categories: ["Points", "Dunks"] }, roster }, snapshot)).toThrow(/Dunks/);
  });
  test("a data file without the needed stat is refused plainly", () => {
    expect(() => analyzeLeague({ league: { ...league, categories: ["Points", "Double-doubles"] }, roster }, build(false))).toThrow(/no dd_rate yet/);
  });
  test("waiver and trade run on a custom list", () => {
    const out = analyzeLeague({
      league: { ...league, categories: cats }, roster,
      waiver: { candidates: [{ name: "Herb Jones" }, { name: "Gui Santos" }], weeks: 800 } as never,
    }, snapshot) as AnyAnalyzeOutput;
    expect(out.waiver).toBeDefined();
  });
});

describe("points leagues", () => {
  const scoring = { Points: 1, Rebounds: 1.2, Assists: 1.5, Steals: 3, Blocks: 3, Turnovers: -1, "Field goals made": 0.5, "Field goals attempted": -0.5 };
  test("a player's points are the weighted sum of his stats", () => {
    const w = parseWeights({ Points: 1, Rebounds: 1.2, Assists: 1.5, Steals: 3, Blocks: 3, Turnovers: -1 });
    const b = baseOf({ pts: 30, reb: 10, ast: 5, stl: 2, blk: 1, fg3m: 3, fg_pct: 0.5, ft_pct: 0.8, turnovers: 3, fga: 20, fta: 6, fgm: 10, ftm: 5, oreb: 2, dreb: 8, pf: 2, fg3a: 8, min: 34 } as never, []);
    // pts from makes: 2*10 + 3 + 5 = 28 (the fixture's pts differs); weights apply to the registry's PTS
    expect(pointsOf(w, b)).toBeCloseTo(28 + 12 + 7.5 + 6 + 3 - 3, 6);
  });
  test("ratios cannot be weighted and unknown stats stop with their name", () => {
    expect(() => parseWeights({ "Field goal percentage": 5 })).toThrow(/percentage or ratio/);
    expect(() => parseWeights({ Points: 1, Deflections: 2 })).toThrow(/Deflections/);
    expect(() => parseWeights({ Points: 0 })).toThrow();
  });
  test("a points league reports points, win and tie chances, deterministically", () => {
    const run = () => analyzeLeague({ league: { ...league, scoring }, roster, matchup: { weeks: 1500 } }, snapshot) as AnyAnalyzeOutput;
    const out = run();
    expect(out.points!.percentile).toBeGreaterThanOrEqual(0);
    const m = out.matchup!;
    expect(m.expected_points!.you).toBeGreaterThan(0);
    expect(m.week_win_pct + m.week_tie_pct + m.week_loss_pct).toBeGreaterThanOrEqual(99);
    expect(run()).toEqual(out);
  });
  test("a lead already banked raises the win chance", () => {
    const base = { league: { ...league, scoring }, roster, matchup: { weeks: 1500, opponent: [{ name: "Herb Jones" }, { name: "Gui Santos" }, { name: "Kevin Porter" }] } };
    const go = (you: number, opp: number) => (analyzeLeague({ ...base, matchup: { ...base.matchup, so_far: { you: { points: you }, opponent: { points: opp }, games_left: {} } } } as never, snapshot) as AnyAnalyzeOutput).matchup!.week_win_pct;
    expect(go(300, 100)).toBe(100);
    expect(go(100, 300)).toBe(0);
  });
  test("waiver runs on a points league", () => {
    const out = analyzeLeague({ league: { ...league, scoring }, roster, waiver: { candidates: [{ name: "Herb Jones" }, { name: "Gui Santos" }], weeks: 800 } as never }, snapshot) as AnyAnalyzeOutput;
    expect(out.waiver).toBeDefined();
  });
  test("categories and scoring together are refused", () => {
    expect(() => analyzeLeague({ league: { ...league, scoring, categories: ["Points"] }, roster }, snapshot)).toThrow(/not both/);
  });
});

describe("missed shots in scoring", () => {
  test("a weight on missed shots is a weight on attempts minus makes", () => {
    expect(parseWeights({ "Field goals missed": -0.5, "Field goals made": 0.5 })).toEqual({ FGA: -0.5, FGM: 1 });
    expect(parseWeights({ "3-pointers missed": -1, "3-pointers made": 2 })).toEqual({ "3PA": -1, "3PM": 3 });
  });
});

describe("untracked scoring stats", () => {
  test("technical fouls, flagrants, ejections and quad-doubles are left out with a notice", () => {
    const sc = { Points: 1, "Technical fouls": -3, Ejections: -5, "Quadruple-doubles": 20 };
    expect(parseWeights(sc)).toEqual({ PTS: 1 });
    const out = analyzeLeague({ league: { ...league, scoring: sc }, roster }, snapshot) as AnyAnalyzeOutput;
    expect(out.assumptions.some((a) => a.startsWith("NOT SCORED: Technical fouls, Ejections, Quadruple-doubles"))).toBe(true);
  });
});

describe("trade output names only what the league scores (#30)", () => {
  const give = [{ name: "Quentin Grimes" }], get = [{ name: "Herb Jones" }];
  const other = [{ name: "Herb Jones" }, { name: "Gui Santos" }, { name: "Kevin Porter" }];
  const mineRoster = roster.filter((r) => r.name !== "Herb Jones" && r.name !== "Gui Santos");
  const NINE = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"];
  test("a points league gets the change in expected week points and no category block", () => {
    const scoring = { Points: 1, Rebounds: 1.2, Assists: 1.5, Steals: 3, Blocks: 3, Turnovers: -1 };
    const t = (analyzeLeague({ league: { ...league, scoring }, roster: mineRoster, trade: { give, get, other_roster: other, weeks: 600 } } as never, snapshot) as AnyAnalyzeOutput).trade!;
    for (const s of [t.you!, t.other_team!]) {
      expect("categories_delta_points" in s).toBe(false);
      expect(typeof s.expected_week_points_delta).toBe("number");
    }
    expect(t.you!.expected_week_points_delta).not.toBe(0);
    const search = (analyzeLeague({ league: { ...league, scoring }, roster: mineRoster, trade: { search: true, other_roster: other, weeks: 600 } } as never, snapshot) as AnyAnalyzeOutput).trade!;
    for (const o of search.offers ?? []) for (const s of [o.you, o.other_team]) { expect("categories_delta_points" in s).toBe(false); expect(typeof s.expected_week_points_delta).toBe("number"); }
  });
  test("a custom category list gets the league's own categories", () => {
    const t = (analyzeLeague({ league: { ...league, categories: cats }, roster: mineRoster, trade: { give, get, other_roster: other, weeks: 600 } } as never, snapshot) as AnyAnalyzeOutput).trade!;
    const keys = Object.keys(t.you!.categories_delta_points!).sort();
    expect(keys).toEqual([...new Set(["PTS", "REB", "AST", "STL", "BLK", "3PM", "TO", "DD", "FG%", "FT%", "PF"])].sort());
    expect(Object.keys(t.other_team!.categories_delta_points!).sort()).toEqual(keys);
    expect(Object.values(t.you!.categories_delta_points!).every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
    expect("expected_week_points_delta" in t.you!).toBe(false);
  });
  test("the standard nine keep their nine categories", () => {
    const t = analyze({ league, roster: mineRoster, trade: { give, get, other_roster: other, weeks: 600 } } as never, snapshot).trade!;
    expect(Object.keys(t.you!.categories_delta_points!)).toEqual(NINE);
    expect("expected_week_points_delta" in t.you!).toBe(false);
  });
});
