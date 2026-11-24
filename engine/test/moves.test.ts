import { describe, expect, test } from "bun:test";
import { weeklyTotals } from "../src/matchup";
import { evaluateTrade, rankWaiverMoves, scoreRoster, searchTrades, type Entry, type MoveEnv } from "../src/moves";
import type { SeasonAverages } from "../src/types";

const avg = (o: Partial<SeasonAverages> = {}): SeasonAverages => ({
  pts: 15, reb: 5, ast: 3, stl: 1, blk: 0.5, fg3m: 1.5, fg_pct: 0.46, ft_pct: 0.8, turnovers: 2, fga: 11, fta: 3, fgm: 5.06, ftm: 2.4, ...o,
});
let nextId = 1;
const entry = (name: string, o: Partial<SeasonAverages> = {}, value = 0): Entry => ({ id: nextId++, name, averages: avg(o), team: "AAA", value });
const lineup = (n: number, o: Partial<SeasonAverages> = {}, tag = "p"): Entry[] => Array.from({ length: n }, (_, i) => entry(`${tag}${i}`, o, 10 - i));

const opp = weeklyTotals(lineup(10, { pts: 16, reb: 5.5 }).map((p) => ({ averages: p.averages, games: 3.4, value: p.value })), 10);
const env: MoveEnv = {
  slots: 10, simWeeks: 3000, seed: 3, replacement: entry("repl", { pts: 8, reb: 3, ast: 1.5 }),
  weeks: [{ start: "2026-11-23", gamesFor: () => 3.4, opponents: [opp] }],
};

describe("scoreRoster", () => {
  test("is reproducible", () => {
    const r = lineup(10);
    expect(scoreRoster(r, env)).toEqual(scoreRoster(r, env));
  });
  test("a stronger roster scores higher", () => {
    expect(scoreRoster(lineup(10, { pts: 22 }), env).weekWin).toBeGreaterThan(scoreRoster(lineup(10, { pts: 12 }), env).weekWin);
  });
  test("an unfilled lineup spot is filled by the replacement player, not left empty", () => {
    const nine = scoreRoster(lineup(9), env).weekWin;
    const ten = scoreRoster([...lineup(9), env.replacement], env).weekWin;
    expect(nine).toBeCloseTo(ten, 10);
  });
  test("averages over the weeks in the environment", () => {
    const two: MoveEnv = { ...env, weeks: [env.weeks[0]!, { ...env.weeks[0]!, gamesFor: () => 4 }] };
    const r = lineup(10);
    const a = scoreRoster(r, env).weekWin, b = scoreRoster(r, { ...env, weeks: [two.weeks[1]!] }).weekWin;
    expect(scoreRoster(r, two).weekWin).toBeCloseTo((a + b) / 2, 10);
  });
});

describe("rankWaiverMoves", () => {
  const roster = [...lineup(9), entry("weak", { pts: 4, reb: 1, ast: 0.5, fg3m: 0 }, -5)];
  const good = entry("good", { pts: 24, reb: 9, ast: 6, blk: 1.5 }, 20);
  const bad = entry("bad", { pts: 3, reb: 1, ast: 0.5, fg3m: 0 }, -9);
  test("adds the better player, dropping the weakest, and ranks by gain", () => {
    const { baseline, moves } = rankWaiverMoves(roster, [bad, good], env);
    expect(moves[0]!.add.name).toBe("good");
    expect(moves[0]!.drop.name).toBe("weak");
    expect(moves[0]!.delta).toBeGreaterThan(0.05);
    expect(moves[0]!.after.weekWin).toBeCloseTo(baseline.weekWin + moves[0]!.delta, 10);
    expect(moves.length).toBe(1); // the worse player is left unranked, not ranked last
  });
  test("a clearly worse player is not ranked at all", () => {
    const { moves, unranked } = rankWaiverMoves(roster, [bad], env);
    expect(moves.length).toBe(0);
    expect(unranked.length).toBe(1);
  });
  test("a move's gain splits into the drop alone and what the add contributes", () => {
    const { moves } = rankWaiverMoves(roster, [good], env);
    const m = moves[0]!;
    expect(m.addDelta).toBeCloseTo(m.delta - m.dropOnlyDelta, 10);
    expect(m.addDelta).toBeGreaterThan(0);
  });
  test("regression: two different bench-level adds are not ranked on a gain that comes from the drop", () => {
    // A deep roster: 14 players for 10 slots. Dropping the one player who hurts (turnovers, poor shooting) helps by itself.
    const deep = [...lineup(10, {}, "d"), entry("hurts", { pts: 12, turnovers: 5, fg_pct: 0.38, fgm: 4.2, ft_pct: 0.6, ftm: 1.8 }, 9.5), ...lineup(3, { pts: 6, reb: 2 }, "b")];
    const a = entry("benchA", { pts: 7, reb: 6, blk: 1 }, -3), b = entry("benchB", { pts: 6, ast: 4, stl: 1.5 }, -4);
    const r = rankWaiverMoves(deep, [a, b], env);
    expect(r.moves.length).toBe(0);
    expect(r.unranked.map((u) => u.reason).sort()).toEqual(["bench-only", "bench-only"]);
  });
  test("an add who enters the lineup and helps is ranked with a positive add effect", () => {
    const deep = [...lineup(10, {}, "d"), ...lineup(3, { pts: 6, reb: 2 }, "b")];
    const r = rankWaiverMoves(deep, [good], env);
    expect(r.moves[0]!.add.name).toBe("good");
    expect(r.moves[0]!.addDelta).toBeGreaterThan(0);
  });
  test("category changes add up to something that moves the way the player does", () => {
    const { moves } = rankWaiverMoves(roster, [good], env);
    expect(moves[0]!.categoryDelta.PTS).toBeGreaterThan(0);
    expect(moves[0]!.categoryDelta.REB).toBeGreaterThan(0);
  });
  test("respects droppable", () => {
    const { moves } = rankWaiverMoves(roster, [good], env, { droppable: [roster[0]!] });
    expect(moves[0]!.drop.name).toBe(roster[0]!.name);
  });
});

describe("trades", () => {
  const mine = [...lineup(8, {}, "m"), entry("bigman", { pts: 10, reb: 11, blk: 2, fg_pct: 0.55, fgm: 6.05, ast: 1, fg3m: 0 }, 1), entry("guard", { pts: 22, reb: 3, ast: 8, fg3m: 3 }, 6)];
  const theirs = [...lineup(8, {}, "t"), entry("star", { pts: 32, reb: 12, ast: 10, fg3m: 4, stl: 2, blk: 2 }, 24), entry("wing", { pts: 9, reb: 3, ast: 2 }, -2)];
  test("evaluateTrade shows both categories and weekly win chance moving", () => {
    const star = theirs.find((p) => p.name === "star")!, guard = mine.find((p) => p.name === "guard")!;
    const r = evaluateTrade(mine, [guard], [star], env);
    expect(r.delta).toBeCloseTo(r.after.weekWin - r.before.weekWin, 12);
    expect(r.delta).toBeGreaterThan(0); // the star is better than the guard
  });
  test("searchTrades returns only offers that help you and do not hurt them", () => {
    const offers = searchTrades(mine, theirs, env, { top: 5 });
    for (const o of offers) {
      expect(o.mine.delta).toBeGreaterThan(0);
      expect(o.theirs.delta).toBeGreaterThanOrEqual(-0.01);
    }
  });
  test("searchTrades is reproducible", () => {
    const a = searchTrades(mine, theirs, env).map((o) => `${o.give.name}>${o.get.name}`);
    expect(searchTrades(mine, theirs, env).map((o) => `${o.give.name}>${o.get.name}`)).toEqual(a);
  });
});
