import { describe, expect, test } from "bun:test";
import { CONFIDENCE_MIN, GAMES_CAP, RECENCY_WEIGHTS, estimateAverages, seasonLabel, type PlayerHistory, type SeasonAverages } from "../src";

const avg = (pts: number): SeasonAverages => ({ pts, reb: 5, ast: 4, stl: 1, blk: 0.5, fg3m: 1, fg_pct: 0.45, ft_pct: 0.8, turnovers: 2, fga: 12, fta: 4 });
const season = (s: string, gp: number, pts: number) => ({ season: s, gp, mpg: 30, averages: avg(pts) });
const REF = "2025-26";

describe("estimateAverages (weighted history, D7)", () => {
  test("season labels", () => { expect(seasonLabel(2025)).toBe("2025-26"); expect(seasonLabel(2099)).toBe("2099-00"); });
  test("weights are recency x min(games, cap): checked by hand", () => {
    const h: PlayerHistory = { player_id: 1, name: "A", seasons: [season("2025-26", 70, 20), season("2024-25", 70, 10), season("2023-24", 70, 0)] };
    const e = estimateAverages(h, REF);
    const w = [1.0 * GAMES_CAP, 0.6 * GAMES_CAP, 0.3 * GAMES_CAP];
    expect(e.averages!.pts).toBeCloseTo((w[0]! * 20 + w[1]! * 10 + w[2]! * 0) / (w[0]! + w[1]! + w[2]!), 10);
    expect(e.effectiveGames).toBeCloseTo(w[0]! + w[1]! + w[2]!, 10);
    expect(e.seasonsUsed).toEqual(["2025-26", "2024-25", "2023-24"]);
  });
  test("the games cap stops one huge season dominating", () => {
    const a: PlayerHistory = { player_id: 1, name: "A", seasons: [season("2025-26", 82, 20), season("2024-25", 65, 10)] };
    const b: PlayerHistory = { player_id: 1, name: "A", seasons: [season("2025-26", 65, 20), season("2024-25", 65, 10)] };
    expect(estimateAverages(a, REF).averages!.pts).toBeCloseTo(estimateAverages(b, REF).averages!.pts, 10);
  });
  test("a returning injured star (16 games) is judged mostly on his full seasons", () => {
    const h: PlayerHistory = { player_id: 2, name: "T", seasons: [season("2025-26", 16, 10), season("2024-25", 65, 25), season("2023-24", 74, 25)] };
    const e = estimateAverages(h, REF);
    expect(e.averages!.pts).toBeGreaterThan(20);
    expect(e.averages!.pts).toBeLessThan(25);
  });
  test("a player who missed last season uses the earlier ones", () => {
    const h: PlayerHistory = { player_id: 3, name: "L", seasons: [season("2025-26", 0, 0), season("2024-25", 54, 24), season("2023-24", 73, 25)] };
    const e = estimateAverages(h, REF);
    expect(e.seasonsUsed).toEqual(["2024-25", "2023-24"]);
    expect(e.averages!.pts).toBeGreaterThan(24);
  });
  test("no history (a rookie): null averages, confidence none", () => {
    const e = estimateAverages({ player_id: null, name: "R", seasons: [] }, REF);
    expect(e.averages).toBeNull(); expect(e.confidence).toBe("none"); expect(e.effectiveGames).toBe(0);
  });
  test("seasons older than three back are ignored", () => {
    const h: PlayerHistory = { player_id: 4, name: "O", seasons: [season("2021-22", 70, 30)] };
    expect(estimateAverages(h, REF).averages).toBeNull();
  });
  test("confidence thresholds", () => {
    const full: PlayerHistory = { player_id: 5, name: "F", seasons: [season("2025-26", 70, 10), season("2024-25", 70, 10), season("2023-24", 70, 10)] };
    expect(estimateAverages(full, REF).confidence).toBe("high");
    const mid: PlayerHistory = { player_id: 6, name: "M", seasons: [season("2025-26", 60, 10)] };
    expect(estimateAverages(mid, REF).confidence).toBe("medium");
    const low: PlayerHistory = { player_id: 7, name: "S", seasons: [season("2025-26", 7, 10)] };
    expect(estimateAverages(low, REF).confidence).toBe("low");
    expect(CONFIDENCE_MIN.high).toBe(100); expect(RECENCY_WEIGHTS).toEqual([1, 0.6, 0.3]);
  });
});
