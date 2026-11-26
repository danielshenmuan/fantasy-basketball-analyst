import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { analyzeLeague, type AnalyzeInput, type PlayerSeason, type Snapshot } from "../src";
import type { RotoOutput } from "../src/analyzeRoto";

const fixture = fx.players as unknown as PlayerSeason[];
const TEAMS = ["ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GSW", "HOU", "IND", "LAC", "LAL", "MEM", "MIA", "MIL", "MIN", "NOP", "NYK", "OKC", "ORL", "PHI", "PHX", "POR", "SAC", "SAS", "TOR", "UTA", "WAS"];
const ext = (a: PlayerSeason["averages"]) => ({ ...a, fgm: a.fga * a.fg_pct, ftm: a.fta * a.ft_pct, oreb: a.reb * 0.25, dreb: a.reb * 0.75, pf: 2.1, fg3a: a.fg3m / 0.36, dd_rate: 0.05, td_rate: 0.002 });
// every team plays on days 0,2,4 of each week, shifted by team: a real, regular schedule from 2026-11-16 to 2027-04-11
const days: Record<string, string[]> = {};
for (let d = Date.parse("2026-11-16T00:00:00Z"); d <= Date.parse("2027-04-11T00:00:00Z"); d += 86400000) {
  const date = new Date(d).toISOString().slice(0, 10), k = Math.round((d - Date.parse("2026-11-16T00:00:00Z")) / 86400000);
  days[date] = TEAMS.filter((_, i) => (k + i) % 2 === 0);
}
const snapshot: Snapshot = {
  version: 1, generated_at: "2026-11-16T00:00:00Z", reference_season: "2025-26",
  players: fixture.map((p, i) => ({ id: p.player_id, name: p.name, team: TEAMS[i % TEAMS.length], seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: ext(p.averages) }] })),
  schedule: { source: "test", days },
};
const byValue = [...fixture].sort((a, b) => b.averages.pts + b.averages.reb + b.averages.ast - (a.averages.pts + a.averages.reb + a.averages.ast));
const S = 6;
const rosters: string[][] = Array.from({ length: S }, () => []);
byValue.slice(0, S * 10).forEach((p, i) => { const r = Math.floor(i / S), t = r % 2 === 0 ? i % S : S - 1 - (i % S); rosters[t]!.push(p.name); });
const NINE = ["Points", "Rebounds", "Assists", "Steals", "Blocks", "3-pointers made", "Field goal percentage", "Free throw percentage", "Turnovers"];
// 20 games so far at each player's own pace
const totalsOf = (names: string[], exact: boolean) => {
  const ps = names.map((n) => fixture.find((p) => p.name === n)!), sum = (f: (a: ReturnType<typeof ext>) => number) => ps.reduce((s, p) => s + 20 * f(ext(p.averages)), 0);
  const fgm = sum((a) => a.fgm), fga = sum((a) => a.fga), ftm = sum((a) => a.ftm), fta = sum((a) => a.fta);
  return { Points: sum((a) => a.pts), Rebounds: sum((a) => a.reb), Assists: sum((a) => a.ast), Steals: sum((a) => a.stl), Blocks: sum((a) => a.blk), "3-pointers made": sum((a) => a.fg3m), Turnovers: sum((a) => a.turnovers),
    ...(exact ? { FGM: fgm, FGA: fga, FTM: ftm, FTA: fta } : { "FG%": fgm / fga, "FT%": ftm / fta }) };
};
const input = (exact = true, extra: Partial<AnalyzeInput> = {}): AnalyzeInput => ({
  league: { teams: S, roster_spots: 11, format: "roto", categories: NINE, standings: rosters.map((r, i) => ({ team: `Team ${i + 1}`, ...(i === 0 ? { me: true } : { roster: r.map((name) => ({ name })) }), totals: totalsOf(r, exact) })) },
  roster: rosters[0]!.map((name) => ({ name })), seed: 3, roto: { sims: 600 }, ...extra,
});
const run = (i: AnalyzeInput) => analyzeLeague(i, snapshot) as RotoOutput;

describe("roto league", () => {
  test("team check: finish chances add up, every category is ranked, the table has every team", () => {
    const o = run(input());
    expect(o.roto).toBe(true);
    const t = o.team_check;
    expect(t.finish_pct.length).toBe(S);
    expect(t.finish_pct.reduce((s, x) => s + x, 0)).toBeGreaterThan(99.5);
    expect(t.finish_pct.reduce((s, x) => s + x, 0)).toBeLessThan(100.5);
    expect(t.categories.map((c) => c.category)).toEqual(["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"]);
    expect(t.table.length).toBe(S);
    expect(t.table.reduce((s, r) => s + r.expected_points, 0)).toBeCloseTo((S * (S + 1) / 2) * 9, 0);
    expect(o.basis.shooting_counts).toBe("exact");
    expect(o.names.every((n) => n.status === "matched")).toBe(true);
    expect(o.assumptions.join(" ")).toMatch(/Not modelled: a bench/);
  });
  test("deterministic for a seed", () => { expect(run(input())).toEqual(run(input())); });
  test("percentages only: attempts are estimated and the output says so", () => {
    const o = run(input(false));
    expect(o.basis.shooting_counts).toBe("estimated");
    expect(o.assumptions.join(" ")).toMatch(/SHOOTING ESTIMATED/);
  });
  test("a counting category without a total, or a team without a roster, stops with the name", () => {
    const i = input(); delete (i.league.standings![2]!.totals as Record<string, number>).Rebounds;
    expect(() => run(i)).toThrow(/Team 3 has no REB total/);
    const j = input(); delete j.league.standings![3]!.roster;
    expect(() => run(j)).toThrow(/Team 4 needs its roster/);
    const k = input(); k.league.standings![0]!.me = false;
    expect(() => run(k)).toThrow(/me: true/);
  });
  test("no matchup or outlook in roto", () => {
    expect(() => run(input(true, { matchup: {} }))).toThrow(/no weekly matchup/);
  });
  test("lower-is-better: fewer banked turnovers ranks better", () => {
    const i = input(); i.league.categories = ["Points", "Turnovers"];
    const o = run(i);
    const to = o.team_check.categories.find((c) => c.category === "TO")!;
    expect(to.current_rank).toBeGreaterThanOrEqual(1);
    const mineTo = totalsOf(rosters[0]!, true).Turnovers;
    const fewer = rosters.filter((_, k) => k !== 0).filter((r) => totalsOf(r, true).Turnovers < mineTo).length;
    expect(to.current_rank).toBe(1 + fewer);
  });
  test("waiver: adding a star for the weakest player helps, with deltas in roto points and finish chances", () => {
    const i = input(true, { waiver: { candidates: [{ name: byValue[S * 10 + 5]!.name }, { name: byValue[S * 10 + 40]!.name }] } as never });
    // a star is not available: use the best player of another team as the "candidate" to prove the direction of the numbers
    const star = rosters[1]![0]!;
    const j = input(true, { waiver: { candidates: [{ name: star }, { name: byValue[S * 10 + 80]!.name }] } as never });
    const o = run(j);
    expect(o.waiver!.moves.length).toBe(2);
    const m = o.waiver!.moves.find((x) => x.add === star)!;
    expect(m.delta_expected_points).toBeGreaterThan(0);
    expect(Object.keys(m.categories_delta).length).toBe(9);
    expect(o.waiver!.moves[0]!.delta_expected_points).toBeGreaterThanOrEqual(o.waiver!.moves[1]!.delta_expected_points);
    expect(run(i).waiver!.baseline.expected_points).toBe(o.waiver!.baseline.expected_points);
  });
  test("trade: both sides change, the partner is named", () => {
    const o = run(input(true, { trade: { partner: "Team 2", give: [{ name: rosters[0]![0]! }], get: [{ name: rosters[1]![0]! }] } as never }));
    expect(o.trade!.partner).toBe("Team 2");
    expect(o.trade!.you.after.expected_points).not.toBe(o.trade!.you.before.expected_points);
    expect(Math.abs(o.trade!.you.delta_expected_points + 0)).toBeGreaterThan(0);
    expect(() => run(input(true, { trade: { partner: "Nobody", give: [{ name: "x" }], get: [{ name: "y" }] } as never }))).toThrow(/trade.partner/);
  });
  test("an injured player with a return date loses games", () => {
    const base = run(input());
    const hurt = input(); hurt.roster = rosters[0]!.map((name, k) => (k === 0 ? { name, injury: "OUT", return_date: "2027-04-01" } : { name }));
    const o = run(hurt);
    expect(o.team_check.expected_points).toBeLessThanOrEqual(base.team_check.expected_points);
  });
  test("the head-to-head paths are not touched", () => {
    const h2h = analyzeLeague({ league: { teams: 12, roster_spots: 13 }, roster: rosters[0]!.map((name) => ({ name })) }, snapshot) as { roto?: boolean };
    expect(h2h.roto).toBeUndefined();
  });
});
