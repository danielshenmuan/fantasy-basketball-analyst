import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { analyze, analyzeLeague, type PlayerSeason, type Snapshot } from "../src";
import type { AnyAnalyzeOutput } from "../src/analyzeAny";
import { bankedShooting, liveScoreOf, shotRoute } from "../src/banked";

const fixture = fx.players as unknown as PlayerSeason[];
const teamOf = ["HOU", "BOS", "DEN"];
const snapshot: Snapshot = {
  version: 1, generated_at: "2026-11-25T06:00:00Z", reference_season: "2025-26",
  players: fixture.map((p, i) => ({ id: p.player_id, name: p.name, team: teamOf[i % 3], seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: p.averages }] })),
  schedule: { source: "test", weeks: [{ start: "2026-11-23", games: { HOU: 4, BOS: 4, DEN: 4 } }] },
};
const league = { teams: 12, roster_spots: 13 };
const names = ["James Harden", "Josh Giddey", "Darius Garland", "Jayson Tatum", "Quentin Grimes", "Onyeka Okongwu", "Kevin Porter", "Herb Jones", "Gui Santos"];
const opp = ["Nikola Jokic", "Jalen Williams", "Gui Santos"].map((name) => ({ name }));
const base = { league, roster: names.map((name) => ({ name })), matchup: { lineup_slots: 6, weeks: 1500, opponent: opp } };
const left = { HOU: 2, BOS: 2, DEN: 2 };
const counts = { pts: 100, reb: 40, ast: 25, stl: 8, blk: 5, fg3m: 12, tov: 15 };
const exactSide = { ...counts, fgm: 40, fga: 85, ftm: 20, fta: 26 };
const pctSide = { ...counts, fg_pct: 0.47, ft_pct: 0.77 };
const run = (so_far: unknown) => analyze({ ...base, matchup: { ...base.matchup, so_far } } as never, snapshot).matchup!;

describe("live score route (issue #22)", () => {
  test("no so_far is a fresh week and says so", () => {
    expect(analyze(base, snapshot).matchup!.live_score).toBe("fresh-week");
  });
  test("made and attempted counts are exact, and unchanged by the new fields", () => {
    const m = run({ you: exactSide, opponent: exactSide, games_left: left });
    expect(m.live_score).toBe("exact");
    expect(m.so_far_counted).toBe(true);
    expect(m.assumptions.join(" ")).not.toContain("ESTIMATED");
  });
  test("only FG% and FT% still give a result, labelled estimated, with the measured error", () => {
    const m = run({ you: pctSide, opponent: pctSide, games_left: left });
    expect(m.live_score).toBe("estimated");
    expect(m.so_far_counted).toBe(true);
    const note = m.assumptions.find((a) => a.startsWith("LIVE SCORE ESTIMATED"))!;
    expect(note).toContain("overstates");
    expect(note).toContain("28%");
  });
  test("percentages given as 47 and 77 read the same as 0.47 and 0.77", () => {
    const a = run({ you: pctSide, opponent: pctSide, games_left: left });
    const b = run({ you: { ...counts, fg_pct: 47, ft_pct: 77 }, opponent: { ...counts, fg_pct: 47, ft_pct: 77 }, games_left: left });
    expect(b.week_win_prob).toBe(a.week_win_prob);
  });
  test("with the whole week played, a big banked lead in counts and percentages wins on the estimate", () => {
    const big = { pts: 900, reb: 400, ast: 250, stl: 80, blk: 50, fg3m: 120, tov: 5, fg_pct: 0.6, ft_pct: 0.9 };
    const small = { pts: 10, reb: 10, ast: 10, stl: 1, blk: 1, fg3m: 1, tov: 90, fg_pct: 0.3, ft_pct: 0.5 };
    expect(run({ you: big, opponent: small, remaining_share: 0 }).week_win_pct).toBe(100);
    expect(run({ you: small, opponent: big, remaining_share: 0 }).week_win_pct).toBe(0);
  });
  test("a mix: one side exact, the other only percentages, is labelled estimated", () => {
    expect(run({ you: exactSide, opponent: pctSide, games_left: left }).live_score).toBe("estimated");
  });
  test("no shooting numbers at all falls back to a fresh week, same answer as no so_far, with a plain note", () => {
    const m = run({ you: counts, opponent: counts, games_left: left });
    expect(m.live_score).toBe("fresh-week");
    expect(m.so_far_counted).toBe(false);
    expect(m.assumptions.join(" ")).toContain("FRESH-WEEK");
    expect(m.week_win_prob).toBe(analyze(base, snapshot).matchup!.week_win_prob);
  });
  test("a bad number still stops with its name", () => {
    expect(() => run({ you: { ...exactSide, fga: -3 }, opponent: exactSide, games_left: left })).toThrow(/fga/);
  });
  test("helpers", () => {
    expect(shotRoute({ fgm: 3, fga: 6 }, "fg")).toBe("exact");
    expect(shotRoute({ ft_pct: 0.8 }, "ft")).toBe("estimated");
    expect(shotRoute({}, "ft")).toBe("missing");
    expect(liveScoreOf([{ fgm: 1, fga: 2, ftm: 1, fta: 2 }], { fg: true, ft: true })).toBe("exact");
    expect(liveScoreOf([{ fgm: 1, fga: 2 }], { fg: true, ft: false })).toBe("exact");
    expect(bankedShooting({ fg_pct: 0.5, ft_pct: 0.8 }, { fga: 100, fta: 50 })).toEqual({ fgm: 50, fga: 100, ftm: 40, fta: 50 });
  });
});

describe("live score route in a custom-category league", () => {
  const ext = (a: PlayerSeason["averages"]) => ({ ...a, oreb: a.reb * 0.25, dreb: a.reb * 0.75, pf: 2.1, fg3a: a.fg3m / 0.36, dd_rate: 0.1, td_rate: 0 });
  const extSnap: Snapshot = { ...snapshot, players: snapshot.players.map((p) => ({ ...p, seasons: p.seasons.map((s) => ({ ...s, averages: ext(s.averages) })) })) };
  const cats = ["Points", "Rebounds", "Assists", "Field goal percentage", "Free throw percentage", "Turnovers"];
  const any = (so_far?: unknown) => (analyzeLeague({ league: { ...league, categories: cats }, roster: base.roster, matchup: { weeks: 1500, opponent: opp, ...(so_far ? { so_far } : {}) } } as never, extSnap) as AnyAnalyzeOutput).matchup!;
  const side = { fg3m: 12, oreb: 10, dreb: 30, ast: 25, turnovers: 15 };
  test("percentages only: estimated; counts: exact; nothing: fresh-week", () => {
    expect(any({ you: { ...side, fg_pct: 0.47, ft_pct: 0.77 }, opponent: { ...side, fg_pct: 0.45, ft_pct: 0.8 }, games_left: left }).live_score).toBe("estimated");
    const ex = { ...side, fgm: 40, fga: 85, ftm: 20, fta: 26 };
    expect(any({ you: ex, opponent: ex, games_left: left }).live_score).toBe("exact");
    const m = any({ you: side, opponent: side, games_left: left });
    expect(m.live_score).toBe("fresh-week");
    expect(m.week_win_prob).toBe(any().week_win_prob);
    expect(any().live_score).toBe("fresh-week");
  });
});
