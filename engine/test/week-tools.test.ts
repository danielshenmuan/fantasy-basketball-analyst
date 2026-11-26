import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { analyze, analyzeLeague, type AnalyzeInput, type PlayerSeason, type Snapshot } from "../src";

const fixture = fx.players as unknown as PlayerSeason[];
const TEAMS = ["BOS", "NYK", "LAL", "DEN", "MIA", "PHX"];
const day = (n: number) => new Date(Date.UTC(2026, 10, 23 + n)).toISOString().slice(0, 10);
const days: Record<string, string[]> = {};
for (let i = 0; i < 7; i++) days[day(i)] = TEAMS.filter((t) => [0, 2, 4].includes(i) || (t === "PHX" && i >= 5));
for (let i = 7; i < 14; i++) days[day(i)] = TEAMS.filter(() => [0, 2, 4].includes(i - 7));
const ext = (a: PlayerSeason["averages"]) => ({ ...a, oreb: a.reb * 0.25, dreb: a.reb * 0.75, pf: 2.1, fg3a: a.fg3m / 0.36, dd_rate: Math.min(0.9, a.reb * a.pts / 400), td_rate: a.ast > 7 ? 0.05 : 0 });
const snapshot: Snapshot = {
  version: 1, generated_at: "2026-11-23T12:00:00Z", reference_season: "2025-26",
  players: fixture.map((p, i) => ({ id: p.player_id, name: p.name, team: TEAMS[i % TEAMS.length], seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: ext(p.averages) }] })),
  schedule: { source: "test", days },
};
const league = { teams: 14, roster_spots: 13 };
const nm = (i: number) => fixture[i]!.name;
const teamOf = (i: number) => TEAMS[i % TEAMS.length]!;
const rank = fixture.map((p, i) => ({ i, v: p.averages.pts + p.averages.reb + p.averages.ast })).sort((a, b) => b.v - a.v).map((x) => x.i);
const weak = rank.slice(15, 27); // 12 mid players
const strong = rank.slice(0, 6);

describe("injury statuses and scenarios (#6)", () => {
  const roster = weak.map((i) => ({ name: nm(i) }));
  const base = analyze({ league, roster, matchup: { weeks: 3000 } }, snapshot).matchup!;
  const star = rank.slice(0, 1)[0]!;
  const withStar = [{ name: nm(star) }, ...roster.slice(0, 11)];
  const m0 = analyze({ league, roster: withStar, matchup: { weeks: 3000 } }, snapshot).matchup!;
  test("a scenario that takes a star out for the week lowers the win chance and is labelled the user's assumption", () => {
    const o = analyze({ league, roster: withStar, matchup: { weeks: 3000, scenarios: [{ name: nm(star) }] } }, snapshot).matchup!;
    expect(o.week_win_pct).toBeLessThan(m0.week_win_pct);
    const row = o.rosters.you.find((r) => r.name === nm(star))!;
    expect(row.games).toBe(0);
    expect(row.games_lost).toBeGreaterThan(0);
    expect(row.note).toContain("YOUR ASSUMPTION");
    expect(o.availability_applied).toBe(true);
    expect(o.assumptions.join(" ")).toContain("your assumptions, not measured facts");
  });
  test("returns on a day: games before it are lost and the first games back are at 80%", () => {
    // Wednesday 2026-11-25: team plays Wed (day 2) and Fri (day 4) = 2 games, both inside the 3-game ramp = 1.6
    const o = analyze({ league, roster: withStar, matchup: { weeks: 500, scenarios: [{ name: nm(star), returns: day(2) }] } }, snapshot).matchup!;
    const g = teamOf(star) === "PHX" ? 4 : 2; // PHX also plays on days 5 and 6
    const row = o.rosters.you.find((r) => r.name === nm(star))!;
    const expected = teamOf(star) === "PHX" ? 0.8 * 3 + 1 : 1.6;
    expect(row.games).toBeCloseTo(expected, 5);
    expect(g).toBeGreaterThan(0);
  });
  test("returns after the week ends (mid-week as_of): all of this week's games are lost (#29)", () => {
    const row = (o: ReturnType<typeof analyze>["matchup"]) => o!.rosters.you.find((r) => r.name === nm(star))!;
    const o = analyze({ league, roster: withStar, as_of: day(2), matchup: { weeks: 200, scenarios: [{ name: nm(star), returns: day(10) }] } }, snapshot).matchup!;
    const r = row(o);
    const healthy = row(analyze({ league, roster: withStar, as_of: day(2), matchup: { weeks: 200 } }, snapshot).matchup!);
    expect(r.games).toBe(0);
    expect(r.games_lost).toBe(healthy.games);
  });
  test("ramp can be switched off, or changed, by the user", () => {
    const o = analyze({ league, roster: withStar, matchup: { weeks: 500, scenarios: [{ name: nm(star), returns: day(2), ramp: false }] } }, snapshot).matchup!;
    expect(o.rosters.you.find((r) => r.name === nm(star))!.games).toBe(teamOf(star) === "PHX" ? 4 : 2);
    const o2 = analyze({ league, roster: withStar, ramp: { games: 1, share: 0.5 }, matchup: { weeks: 500, scenarios: [{ name: nm(star), returns: day(2) }] } }, snapshot).matchup!;
    expect(o2.rosters.you.find((r) => r.name === nm(star))!.games).toBe(teamOf(star) === "PHX" ? 3.5 : 1.5);
  });
  test("an opponent's player can be taken out", () => {
    const opp = strong.map((i) => ({ name: nm(i) }));
    const a = analyze({ league, roster: withStar, matchup: { weeks: 3000, opponent: opp } }, snapshot).matchup!;
    const b = analyze({ league, roster: withStar, matchup: { weeks: 3000, opponent: opp, scenarios: [{ side: "opponent", name: nm(strong[0]!) }] } }, snapshot).matchup!;
    expect(b.week_win_pct).toBeGreaterThanOrEqual(a.week_win_pct);
    expect(b.rosters.opponent!.find((r) => r.name === nm(strong[0]!))!.games).toBe(0);
  });
  test("a host OUT tag with a return date is used; without one he is out for the rest of the week and the output says it is assumed; GTD counts as playing", () => {
    const run = (extra: object) => analyze({ league, roster: [{ name: nm(star), ...extra }, ...roster.slice(0, 11)], matchup: { weeks: 300 } }, snapshot).matchup!.rosters.you.find((r) => r.name === nm(star))!;
    expect(run({ injury: "OUT", return_date: day(4) }).games).toBeCloseTo(teamOf(star) === "PHX" ? 0.8 * 3 : 0.8, 5);
    const noDate = run({ injury: "OUT" });
    expect(noDate.games).toBe(0);
    expect(noDate.note).toContain("assumption");
    const gtd = run({ injury: "GTD" });
    expect(gtd.games).toBe(teamOf(star) === "PHX" ? 5 : 3);
    expect(gtd.note).toContain("GTD");
  });
  test("a scenario on a player not found is ignored with a warning", () => {
    const o = analyze({ league, roster: withStar, matchup: { weeks: 200, scenarios: [{ name: "Nobody Atall" }] } }, snapshot).matchup!;
    expect(o.assumptions.join(" ")).toContain("scenario for \"Nobody Atall\" ignored");
  });
  test("without a day-by-day schedule games lost are spread evenly and flagged approximate", () => {
    const noDays: Snapshot = { ...snapshot, schedule: { source: "t", weeks: [{ start: "2026-11-23", games: Object.fromEntries(TEAMS.map((t) => [t, 3])) }] } };
    const o = analyze({ league, roster: withStar, matchup: { weeks: 200, scenarios: [{ name: nm(star), out_until: day(2) }] } }, noDays).matchup!;
    expect(o.assumptions.join(" ")).toContain("approximate");
    void base;
  });
  test("schedule_days in the request is used in place of the data file's", () => {
    const o = analyze({ league, roster: withStar, schedule_days: days, matchup: { weeks: 200, scenarios: [{ name: nm(star), returns: day(2), ramp: false }] } }, { ...snapshot, schedule: undefined }).matchup!;
    expect(o.rosters.you.find((r) => r.name === nm(star))!.games).toBe(teamOf(star) === "PHX" ? 4 : 2);
  });
});

describe("weekly add limit and injured list (#3)", () => {
  const roster12 = weak.map((i) => ({ name: nm(i) }));
  const cands = strong.map((i) => ({ name: nm(i) }));
  test("with an open roster spot an add needs no drop", () => {
    const o = analyze({ league, roster: roster12, waiver: { candidates: cands, weeks: 1500, top: 6 } }, snapshot).waiver!;
    expect(o.open_spots).toBe(1);
    expect(o.moves.some((m) => m.drop === null)).toBe(true);
  });
  test("a full roster needs a drop for every add", () => {
    const o = analyze({ league: { ...league, roster_spots: 12 }, roster: roster12, waiver: { candidates: cands, weeks: 1500, top: 6 } }, snapshot).waiver!;
    expect(o.open_spots).toBe(0);
    expect(o.moves.every((m) => m.drop !== null)).toBe(true);
  });
  test("adds_left limits the best use of adds, re-simulated as a group", () => {
    const o = analyze({ league: { ...league, roster_spots: 12 }, roster: roster12, waiver: { candidates: cands, weeks: 1500, adds_left: 2 } }, snapshot).waiver!;
    const b = o.best_use_of_adds!;
    expect(b.moves.length).toBeLessThanOrEqual(2);
    expect(b.moves.length).toBeGreaterThan(0);
    expect(new Set(b.moves.map((m) => m.add)).size).toBe(b.moves.length);
    expect(b.delta_points).toBeGreaterThan(0);
    const one = analyze({ league: { ...league, roster_spots: 12 }, roster: roster12, waiver: { candidates: cands, weeks: 1500, adds_left: 1 } }, snapshot).waiver!.best_use_of_adds!;
    expect(one.moves.length).toBe(1);
    expect(one.moves[0]!.add).toBe(o.moves[0]!.add);
  });
  test("no adds left: nothing to do this week, and it says so", () => {
    const o = analyze({ league, roster: roster12, waiver: { candidates: cands, weeks: 500, adds_left: 0 } }, snapshot).waiver!;
    expect(o.best_use_of_adds!.moves).toEqual([]);
    expect(o.best_use_of_adds!.note).toContain("no adds left");
  });
  test("a player whose status the league lets into the injured list moves there, freeing his spot", () => {
    const full = [...roster12, { name: nm(rank[27]!), injury: "OUT" }];
    const o = analyze({ league: { ...league, il_slots: 1, il_eligible_statuses: ["OUT"] }, roster: full, waiver: { candidates: cands, weeks: 800 } }, snapshot).waiver!;
    expect(o.il_moves).toEqual([nm(rank[27]!)]);
    expect(o.open_spots).toBe(1);
    expect(o.assumptions.join(" ")).toContain("Assumed moved to your injured list");
  });
  test("a status the league does not let in, or no open IL slot, leaves him on the roster", () => {
    const full = [...roster12, { name: nm(rank[27]!), injury: "DTD" }];
    const a = analyze({ league: { ...league, il_slots: 1, il_eligible_statuses: ["OUT"] }, roster: full, waiver: { candidates: cands, weeks: 300 } }, snapshot).waiver!;
    expect(a.il_moves).toEqual([]);
    const b = analyze({ league: { ...league, il_slots: 1, il_eligible_statuses: ["OUT"] }, roster: [{ name: nm(rank[28]!), status: "IL" as const }, ...roster12, { name: nm(rank[27]!), injury: "OUT" }], waiver: { candidates: cands, weeks: 300 } }, snapshot).waiver!;
    expect(b.il_moves).toEqual([]);
  });
  test("without the league's IL rules nothing is guessed", () => {
    const full = [...roster12, { name: nm(rank[27]!), injury: "OUT" }];
    const o = analyze({ league, roster: full, waiver: { candidates: cands, weeks: 300 } }, snapshot).waiver!;
    expect(o.il_moves).toEqual([]);
  });
});

describe("daily lineups and streaming (#5)", () => {
  const roster13 = [...weak, rank[27]!].map((i) => ({ name: nm(i) }));
  const input = (daily: object, extra: Partial<AnalyzeInput> = {}): AnalyzeInput => ({
    league: { ...league, lineup_lock: "daily" }, roster: roster13, matchup: { weeks: 1500, lineup_slots: 5, daily }, ...extra,
  });
  test("lists the best lineup for each remaining day and a baseline win chance", () => {
    const o = analyze(input({}), snapshot).matchup!.daily!;
    expect(o.days.length).toBe(7);
    expect(o.lineup_by_day.every((d) => d.starters.length <= 5)).toBe(true);
    expect(o.baseline_week_win_pct).toBeGreaterThanOrEqual(0);
    expect(o.rough).toBe(false);
  });
  test("benching a player on all days changes the result, labelled against the baseline", () => {
    const o = analyze(input({ bench: [{ name: nm(weak[0]!) }] }), snapshot).matchup!.daily!;
    expect(o.changes![0]!.label).toContain("benches");
  });
  test("streaming ranks free agents by what adding them for the rest of the week does, within adds left", () => {
    const o = analyze(input({ stream: { candidates: strong.map((i) => ({ name: nm(i) })), adds_left: 1, top: 3 } }), snapshot).matchup!.daily!;
    expect(o.streaming!.moves.length).toBeGreaterThan(0);
    expect(o.streaming!.moves[0]!.delta_points).toBeGreaterThan(0);
    expect(o.streaming!.moves[0]!.addable).toBe(true);
    const none = analyze(input({ stream: { candidates: strong.map((i) => ({ name: nm(i) })), adds_left: 0 } }), snapshot).matchup!.daily!;
    expect(none.streaming!.moves.every((m) => !m.addable)).toBe(true);
    expect(none.notes.join(" ")).toContain("no adds left");
  });
  test("streamers are only credited with days on or after as_of, with a full-week schedule and no banked stats (#32)", () => {
    const o = analyze({ ...input({ stream: { candidates: strong.map((i) => ({ name: nm(i) })), adds_left: 1, top: 6 } }), as_of: day(2) }, snapshot).matchup!.daily!;
    expect(o.streaming!.moves.length).toBeGreaterThan(0);
    for (const m of o.streaming!.moves) {
      expect(m.days_played.length).toBeGreaterThan(0);
      expect(m.days_played.every((d) => d >= day(2))).toBe(true);
    }
  });
  test("a weekly lock refuses, and so does missing day-by-day data", () => {
    expect(() => analyze({ ...input({}), league: { ...league, lineup_lock: "weekly" } }, snapshot)).toThrow("locks lineups weekly");
    expect(() => analyze(input({}), { ...snapshot, schedule: { source: "t", weeks: [{ start: "2026-11-23", games: { BOS: 3 } }] } })).toThrow("day-by-day");
  });
  test("a week under way: only the days left are modelled and the share left is reported", () => {
    const banked = { pts: 100, reb: 40, ast: 25, stl: 8, blk: 5, fg3m: 12, tov: 15, fgm: 40, fga: 90, ftm: 20, fta: 25 };
    const o = analyze({
      ...input({ from: day(4) }), as_of: day(4),
      matchup: { weeks: 1000, lineup_slots: 5, opponent: strong.map((i) => ({ name: nm(i) })), so_far: { you: banked, opponent: banked, games_left: Object.fromEntries(TEAMS.map((t) => [t, t === "PHX" ? 3 : 1])) }, daily: { from: day(4) } },
    }, snapshot).matchup!.daily!;
    expect(o.days).toEqual([day(4), day(5), day(6)]);
    expect(o.share_left).toBeLessThan(0.6);
  });
});

describe("analyzeLeague routes all of it", () => {
  test("positions and slots work in a custom-category league", () => {
    const o = analyzeLeague({
      league: { teams: 12, roster_spots: 13, categories: ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%"], slots: ["PG", "SG", "SF", "PF", "C", "UTIL"] },
      roster: weak.map((i, k) => ({ name: nm(i), positions: ["PG", "SG", "SF", "PF", "C"][k % 5] })),
      matchup: { weeks: 500 },
    }, snapshot) as { matchup: { lineup_slots: number; rosters: { you: { slot?: string; counted: boolean }[] } } };
    expect(o.matchup.lineup_slots).toBe(6);
    expect(o.matchup.rosters.you.filter((r) => r.counted).every((r) => r.slot)).toBe(true);
  });
  test("scenarios, daily lineups and the add limit work in a custom-category league too", () => {
    const cats = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%"];
    const roster = [...weak, rank[27]!].map((i) => ({ name: nm(i) }));
    const o = analyzeLeague({
      league: { teams: 12, roster_spots: 13, categories: cats, lineup_lock: "daily" }, roster,
      matchup: { weeks: 600, lineup_slots: 5, scenarios: [{ name: nm(weak[0]!) }], daily: { stream: { candidates: strong.map((i) => ({ name: nm(i) })), top: 2 } } },
      waiver: { candidates: strong.map((i) => ({ name: nm(i) })), adds_left: 2, weeks: 600 },
    }, snapshot) as { matchup: { availability_applied: boolean; daily: { streaming: { moves: unknown[] } } }; waiver: { best_use_of_adds: { moves: unknown[] } } };
    expect(o.matchup.availability_applied).toBe(true);
    expect(o.matchup.daily.streaming.moves.length).toBeGreaterThan(0);
    expect(o.waiver.best_use_of_adds.moves.length).toBeGreaterThan(0);
  });
});
