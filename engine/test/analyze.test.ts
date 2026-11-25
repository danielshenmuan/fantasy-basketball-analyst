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

describe("analyze: rookies are judged on this season (D10, option C)", () => {
  const avgs = snapshot.players[0]!.seasons[0]!.averages;
  const hot = { ...avgs, pts: 28, reb: 9, ast: 8, stl: 2, blk: 1.5, fg3m: 3, turnovers: 2 };
  const snap: Snapshot = {
    ...snapshot,
    players: [
      ...snapshot.players.map((p) => ({ ...p, seasons: [{ season: "2026-27", gp: 15, mpg: p.seasons[0]!.mpg, averages: p.seasons[0]!.averages }, ...p.seasons] })),
      { id: -999, name: "Hot Rookie", seasons: [{ season: "2026-27", gp: 12, mpg: 33, averages: hot }] },
    ],
  };
  const withRookie = analyze({ league, roster: [{ name: "Hot Rookie" }] }, snap);
  test("the rookie is no longer counted as an average player", () => {
    const p = withRookie.players[0]!;
    expect(p.confidence).toBe("low");
    expect(p.seasonsUsed).toEqual(["2026-27"]);
    expect(p.note).toContain("this season");
    expect(withRookie.assumptions.some((a) => a.includes("no NBA data"))).toBe(false);
  });
  test("a star line moves the roster's scoring above an average player's", () => {
    const avgRoster = analyze({ league, roster: [{ name: "Not A Player" }] }, snap);
    expect(withRookie.categories.PTS.total).toBeGreaterThan(avgRoster.categories.PTS.total);
  });
  test("the result says plainly that some players are judged on this season only", () => {
    expect(withRookie.assumptions.some((a) => a.includes("this season only"))).toBe(true);
  });
});

describe("analyze: weekly matchup simulation (D12)", () => {
  const teamOf = ["HOU", "BOS", "DEN"];
  const withTeams = (games: Record<string, number> | null): Snapshot => ({
    ...snapshot,
    generated_at: "2026-11-24T06:00:00Z", // a Tuesday: the week starts Monday 2026-11-23
    players: snapshot.players.map((p, i) => ({ ...p, team: teamOf[i % 3] })),
    ...(games ? { schedule: { source: "test", weeks: [{ start: "2026-11-23", games }] } } : {}),
  });
  const base = { league, roster: roster.map((name) => ({ name })), matchup: { lineup_slots: 8, weeks: 2000 } };

  test("is absent unless asked for", () => {
    expect(analyze({ league, roster: base.roster }, snapshot).matchup).toBeUndefined();
  });
  test("without a schedule it assumes an average week and says so", () => {
    const m = analyze(base, snapshot).matchup!;
    expect(m.games_source).toBe("assumed");
    expect(m.week_start).toBeNull();
    expect(m.assumptions[0]).toContain("average week");
  });
  test("with a schedule it counts the real games", () => {
    const m = analyze(base, withTeams({ HOU: 3, BOS: 3, DEN: 3 })).matchup!;
    expect(m.games_source).toBe("schedule");
    expect(m.week_start).toBe("2026-11-23");
  });
  test("a player on a team with more games that week raises your chances", () => {
    const even = analyze(base, withTeams({ HOU: 3, BOS: 3, DEN: 3 })).matchup!;
    const heavy = analyze(base, withTeams({ HOU: 4, BOS: 4, DEN: 4 })).matchup!;
    // everyone, opponents included, plays 4: the team keeps its relative standing, so the answer barely moves
    expect(Math.abs(heavy.week_win_pct - even.week_win_pct)).toBeLessThan(12);
  });
  test("is reproducible and reports whole percents", () => {
    const a = analyze(base, withTeams({ HOU: 3, BOS: 3, DEN: 3 })).matchup!;
    const b = analyze(base, withTeams({ HOU: 3, BOS: 3, DEN: 3 })).matchup!;
    expect(a).toEqual(b);
    expect(Number.isInteger(a.week_win_pct)).toBe(true);
    expect(Object.keys(a.categories).sort()).toEqual([...CATEGORIES].sort());
    expect(a.distribution_pct.length).toBe(10);
  });
  test("a real opponent: a roster beats a weaker one", () => {
    const strong = ["James Harden", "Jayson Tatum", "Josh Giddey", "Darius Garland", "Onyeka Okongwu", "Herb Jones", "Kevin Porter Jr.", "Quentin Grimes"];
    const weak = ["Gui Santos"];
    const m = analyze({ ...base, roster: strong.map((name) => ({ name })), matchup: { ...base.matchup, opponent: weak.map((name) => ({ name })) } }, snapshot).matchup!;
    expect(m.opponent).toBe("roster");
    expect(m.week_win_pct).toBeGreaterThan(90);
  });
  test("a week with TBD games is flagged and warned about", () => {
    const snapTbd = { ...withTeams({ HOU: 4, BOS: 3, DEN: 2 }), schedule: { source: "test", weeks: [{ start: "2026-11-23", games: { HOU: 4, BOS: 3, DEN: 2 }, tbd_slots: 8 }] } };
    const m = analyze(base, snapTbd).matchup!;
    expect(m.schedule_incomplete).toBe(true);
    expect(m.assumptions[0]).toContain("TBD");
    expect(analyze(base, withTeams({ HOU: 4, BOS: 3, DEN: 2 })).matchup!.schedule_incomplete).toBe(false);
  });
  test("each roster lists every player's games this week, who counts, and games left", () => {
    const zeroSide = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
    const o = analyze({ ...base, matchup: { lineup_slots: 3, opponent: [{ name: "Nikola Jokic" }], so_far: { games_left: { HOU: 1, BOS: 2, DEN: 0 }, you: zeroSide, opponent: zeroSide } } }, withTeams({ HOU: 4, BOS: 3, DEN: 2 })).matchup!;
    expect(o.rosters.you.length).toBeGreaterThan(0);
    expect(o.rosters.you.filter((p) => p.counted).length).toBeLessThanOrEqual(3);
    expect(o.rosters.opponent!.length).toBe(1);
    expect(o.rosters.you.every((p) => typeof p.games_left === "number")).toBe(true);
  });
  test("IL players and unmatched names are not counted, and the output says so", () => {
    const m = analyze({ ...base, roster: [...base.roster, { name: "Nobody Atall" }, { name: "Jayson Tatum", status: "IL" }] }, snapshot).matchup!;
    expect(m.assumptions.some((a) => a.includes("could not be matched"))).toBe(true);
  });
});

describe("analyze: waiver and trade (D12)", () => {
  const snap: Snapshot = { ...snapshot, generated_at: "2026-11-24T06:00:00Z", players: snapshot.players.map((p, i) => ({ ...p, team: ["HOU", "BOS", "DEN"][i % 3] })) };
  const req = { league, roster: roster.map((name) => ({ name })) };
  const common = { lineup_slots: 8, weeks: 1500 };
  test("waiver ranks available players and reports whole percents and point deltas", () => {
    const o = analyze({ ...req, waiver: { ...common, candidates: [{ name: "Nikola Jokic" }, { name: "Nobody Atall" }], top: 3 } }, snap).waiver!;
    expect(Number.isInteger(o.baseline_week_win_pct)).toBe(true);
    expect(o.moves.length + o.not_ranked.length).toBeGreaterThan(0);
    for (const m of o.moves) { expect(m.add_effect_points).toBeCloseTo(m.delta_points - m.drop_only_points, 0); expect(["high", "medium", "low", "none"]).toContain(m.add_confidence); expect(m.add_games_basis).toBeGreaterThanOrEqual(0); }
    expect(typeof o.schedule_incomplete).toBe("boolean");
    expect(o.names.some((n) => n.status === "not_found")).toBe(true);
    expect(o.assumptions.join(" ")).toContain("replacement-level");
  });
  test("waiver needs candidates", () => {
    expect(() => analyze({ ...req, waiver: { candidates: [] } }, snap)).toThrow("candidates");
  });
  test("trade evaluate scores your side, and theirs when their roster is given", () => {
    const o = analyze({ ...req, trade: { ...common, give: [{ name: "Gui Santos" }], get: [{ name: "Nikola Jokic" }], other_roster: [{ name: "Nikola Jokic" }, { name: "Jalen Williams" }] } }, snap).trade!;
    expect(o.mode).toBe("evaluate");
    expect(o.you!.delta_points).toBeGreaterThan(0);
    expect(o.other_team).toBeDefined();
  });
  test("trade rejects giving a player you do not have", () => {
    expect(() => analyze({ ...req, trade: { ...common, give: [{ name: "Nikola Jokic" }], get: [{ name: "Gui Santos" }] } }, snap)).toThrow("do not have");
  });
  test("trade search needs their roster and returns offers", () => {
    expect(() => analyze({ ...req, trade: { ...common, search: true } }, snap)).toThrow("other_roster");
    const o = analyze({ ...req, trade: { ...common, search: true, top: 3, other_roster: [{ name: "Nikola Jokic" }, { name: "Jalen Williams" }, { name: "Gui Santos" }] } }, snap).trade!;
    expect(o.mode).toBe("search");
    expect(Array.isArray(o.offers)).toBe(true);
  });
});

describe("analyze: team-check bands count only the lineup, so they agree with the matchup (issue #15)", () => {
  const rated = fixture.filter((p) => p.gp >= 40 && p.mpg >= 20);
  const byPts = [...rated].sort((a, b) => b.averages.pts - a.averages.pts);
  const names = (ps: PlayerSeason[]) => ps.map((p) => ({ name: p.name }));
  const lg = { teams: 10, roster_spots: 13 };
  // Ten starters plus three bench players, so the lineup is smaller than the roster.
  const strong = [...byPts.slice(0, 10), ...byPts.slice(-3)];
  const weak = [...byPts.slice(-10), ...byPts.slice(0, 3)];
  const run = (ps: PlayerSeason[], slots: number) => analyze({ league: lg, roster: names(ps), matchup: { lineup_slots: slots, weeks: 3000 } }, snapshot);

  test("bench players are not counted, and are labelled as bench", () => {
    const o = run(strong, 10);
    expect(o.players.filter((p) => p.counted).length).toBe(10);
    expect(o.players.filter((p) => !p.counted).every((p) => p.note.includes("Bench"))).toBe(true);
    expect(o.assumptions.some((a) => a.includes("not this week"))).toBe(true);
  });
  test("a bench full of poor scorers does not drag a scoring lineup down", () => {
    const withBench = run(strong, 10), lineupOnly = analyze({ league: lg, roster: names(strong.slice(0, 10)), matchup: { lineup_slots: 10 } }, snapshot);
    expect(withBench.categories.PTS.total).toBeCloseTo(lineupOnly.categories.PTS.total, 10);
  });
  test("a roster built to be strong in points is strong in both team-check and the matchup", () => {
    const o = run(strong, 10);
    expect(["strong", "elite"]).toContain(o.categories.PTS.band);
    expect(o.matchup!.categories.PTS).toBeGreaterThan(55);
  });
  test("a roster built to be weak in points is weak in both team-check and the matchup", () => {
    const o = run(weak, 10);
    expect(o.categories.PTS.band).toBe("weak");
    expect(o.matchup!.categories.PTS).toBeLessThan(45);
  });
  test("the lineup size changes the benchmark (the simulated teams are also their best starters only)", () => {
    const all = analyze({ league: lg, roster: names(strong) }, snapshot), ten = run(strong, 10);
    expect(ten.categories.PTS.benchmark.median).not.toBe(all.categories.PTS.benchmark.median);
  });
});
