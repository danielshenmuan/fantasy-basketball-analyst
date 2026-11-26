import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { analyzeLeague, type PlayerSeason, type Snapshot } from "../src";
import { runOutlook, type OutlookInput, type WeekWin } from "../src/outlook";

describe("outlook (the season played out)", () => {
  const flat = (win: number, tie = 0): WeekWin => () => ({ win, tie, source: "schedule" });
  const weeks = (n: number) => Array.from({ length: n }, (_, i) => ({ week_start: new Date(Date.UTC(2026, 10, 23 + 7 * i)).toISOString().slice(0, 10) }));
  const others = (n: number, wins: number, losses: number) => Array.from({ length: n }, (_, i) => ({ team: `T${i}`, wins, losses }));
  const base = (over: Partial<OutlookInput> = {}): OutlookInput => ({
    record: { wins: 5, losses: 5 }, remaining: weeks(10), playoffs: { teams: 6, first_week: "2027-02-01" },
    standings: others(11, 5, 5), runs: 4000, ...over,
  });
  const roster = [{ name: "a" }];

  test("expected wins are the record plus the sum of the weekly win chances", () => {
    const o = runOutlook(base({ standings: undefined }), roster, flat(0.6));
    expect(o.expected_final_wins).toBeGreaterThan(10.7);
    expect(o.expected_final_wins).toBeLessThan(11.3);
    expect(o.playoffs).toBeUndefined();
    expect(o.assumptions.join(" ")).toContain("No standings");
    expect(Object.values(o.final_wins_pct).reduce((a, b) => a + b, 0)).toBeGreaterThan(99);
  });
  test("a dominant team makes the playoffs, usually with a bye, and wins the title more often than a weak one", () => {
    const strong = runOutlook(base(), roster, flat(0.9)).playoffs!;
    const weak = runOutlook(base(), roster, flat(0.2)).playoffs!;
    expect(strong.make_pct).toBeGreaterThan(90);
    expect(strong.bye_pct).toBeGreaterThan(40);
    expect(weak.make_pct).toBeLessThan(10);
    expect(strong.title_pct).toBeGreaterThan(weak.title_pct);
    expect(strong.seed_pct.length).toBe(12);
    expect(strong.seed_pct.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    expect(strong.round_win_pct.length).toBe(3); // 6 teams -> bracket of 8, three rounds
  });
  test("a league of exactly the playoff field: everybody is in, no bye", () => {
    const o = runOutlook(base({ playoffs: { teams: 12, first_week: "2027-02-01" } }), roster, flat(0.5)).playoffs!;
    expect(o.make_pct).toBe(100);
  });
  test("moves are compared by re-running the season", () => {
    let calls = 0;
    const ww: WeekWin = (_w, r) => { calls++; return { win: r.length > 1 ? 0.7 : 0.4, tie: 0, source: "schedule" }; };
    const o = runOutlook(base({ move: { add: { name: "b" } } }), roster, ww);
    expect(o.move!.delta_wins).toBeGreaterThan(1.5);
    expect(o.move!.delta_playoff_points).toBeGreaterThan(0);
    expect(o.move!.label).toBe("add b");
    expect(calls).toBeGreaterThan(20);
  });
  test("ties in the record are settled by the tiebreaker when both values are known", () => {
    const o = runOutlook({ record: { wins: 5, losses: 5, tiebreak_value: 9 }, remaining: weeks(1), playoffs: { teams: 1, first_week: "2027-02-01" }, standings: [{ team: "X", wins: 5, losses: 5, tiebreak_value: 1 }], runs: 6000 }, roster, flat(0.5, 0)).playoffs!;
    const o2 = runOutlook({ record: { wins: 5, losses: 5, tiebreak_value: 1 }, remaining: weeks(1), playoffs: { teams: 1, first_week: "2027-02-01" }, standings: [{ team: "X", wins: 5, losses: 5, tiebreak_value: 9 }], runs: 6000 }, roster, flat(0.5, 0)).playoffs!;
    expect(o.make_pct).toBeGreaterThan(o2.make_pct + 10);
    expect(o.tiebreak_decides_pct).toBeGreaterThan(0);
  });
  test("bad input is explained", () => {
    expect(() => runOutlook(base({ remaining: [] }), roster, flat(0.5))).toThrow("remaining");
    expect(() => runOutlook(base({ playoffs: { teams: 30, first_week: "2027-02-01" } }), roster, flat(0.5))).toThrow("larger than the league");
    expect(() => runOutlook(base({ playoffs: { teams: 6, first_week: "soon" } }), roster, flat(0.5))).toThrow("first_week");
  });
});

describe("outlook through the analyzer", () => {
  const fixture = fx.players as unknown as PlayerSeason[];
  const TEAMS = ["BOS", "NYK", "LAL", "DEN", "MIA", "PHX"];
  const snapshot: Snapshot = {
    version: 1, generated_at: "2026-11-23T12:00:00Z", reference_season: "2025-26",
    players: fixture.map((p, i) => ({ id: p.player_id, name: p.name, team: TEAMS[i % TEAMS.length], seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: p.averages }] })),
    schedule: { source: "t", weeks: [{ start: "2026-11-23", games: Object.fromEntries(TEAMS.map((t) => [t, 3])) }, { start: "2026-11-30", games: Object.fromEntries(TEAMS.map((t) => [t, 4])) }] },
  };
  const rank = fixture.map((p, i) => ({ i, v: p.averages.pts + p.averages.reb + p.averages.ast })).sort((a, b) => b.v - a.v).map((x) => x.i);
  const roster = rank.slice(0, 12).map((i) => ({ name: fixture[i]!.name }));
  test("runs the weekly model for each remaining week, marking weeks with no schedule as assumed", () => {
    const o = analyzeLeague({
      league: { teams: 12, roster_spots: 13 }, roster,
      outlook: {
        record: { wins: 4, losses: 3 }, weeks: 400, runs: 1500,
        remaining: [{ week_start: "2026-11-23" }, { week_start: "2026-11-30" }, { week_start: "2026-12-07" }],
        playoffs: { teams: 4, first_week: "2026-12-21" },
        standings: Array.from({ length: 11 }, (_, i) => ({ team: `T${i}`, wins: 3 + (i % 3), losses: 4 - (i % 3) })),
        move: { drop: roster[11]!.name, add: { name: fixture[rank[40]!]!.name } },
      },
    }, snapshot).outlook!;
    expect(o.per_week.map((w) => w.games_source)).toEqual(["schedule", "schedule", "assumed"]);
    expect(o.per_week.every((w) => w.win_pct > 50)).toBe(true); // a top-12 roster against typical opponents
    expect(o.playoffs!.make_pct).toBeGreaterThan(40);
    expect(o.move!.label).toContain("add");
  });
});
