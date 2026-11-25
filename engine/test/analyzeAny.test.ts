import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { analyzeLeague, analyze, type PlayerSeason, type Snapshot } from "../src";
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
