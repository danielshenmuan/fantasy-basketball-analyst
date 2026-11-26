import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { analyze, assignLineup, parsePositions, parseSlots, unfilledSlots, type AnalyzeInput, type PlayerSeason, type Snapshot } from "../src";

describe("lineup slots", () => {
  const p = (value: number, positions?: string[], games?: number) => ({ value, positions, games });
  const SLOTS = parseSlots(["PG", "SG", "G", "SF", "PF", "F", "C", "C", "Util", "Util"]);
  test("slot names are read and bad ones named", () => {
    expect(SLOTS).toEqual(["PG", "SG", "G", "SF", "PF", "F", "C", "C", "UTIL", "UTIL"]);
    expect(() => parseSlots(["PG", "BN"])).toThrow("BN");
    expect(() => parseSlots(["PG", "XX"])).toThrow("XX");
  });
  test("positions: guard and forward shorthands expand, junk is dropped", () => {
    expect(parsePositions("PG,SG")).toEqual(["PG", "SG"]);
    expect(parsePositions(["G", "f"])).toEqual(["PG", "SG", "SF", "PF"]);
    expect(parsePositions("")).toBeUndefined();
    expect(parsePositions(undefined)).toBeUndefined();
  });
  test("a number keeps the original behaviour: best N by value", () => {
    const l = assignLineup([p(1), p(5), p(3)], 2).map((a) => a.player.value);
    expect(l).toEqual([5, 3]);
  });
  test("slots seat the best players who can all be seated, never two centres in one centre slot", () => {
    const players = [p(9, ["C"]), p(8, ["C"]), p(7, ["C"]), p(6, ["PG"]), p(1, ["SF"])];
    const l = assignLineup(players, ["C", "PG", "SF"]).map((a) => a.player.value).sort((a, b) => b - a);
    expect(l).toEqual([9, 6, 1]); // 8 and 7 cannot be seated: only one C slot
  });
  test("a player with no positions fills UTIL only", () => {
    const l = assignLineup([p(9), p(5, ["PG"])], ["PG", "UTIL"]);
    expect(l.map((a) => `${a.slot}:${a.player.value}`).sort()).toEqual(["PG:5", "UTIL:9"]);
    expect(assignLineup([p(9)], ["PG"]).length).toBe(0);
  });
  test("a player whose team has no game is not available in slot mode", () => {
    const l = assignLineup([p(9, ["C"], 0), p(2, ["C"], 3)], ["C"]);
    expect(l[0]!.player.value).toBe(2);
  });
  test("unfilled slots are named", () => {
    expect(unfilledSlots([p(1, ["PG"]), p(1, ["SG"])], ["PG", "C", "UTIL"])).toEqual(["C"]);
    expect(unfilledSlots([p(1, ["PG"])], ["PG", "G"])).toEqual(["G"]);
  });
});

const fixture = fx.players as unknown as PlayerSeason[];
const TEAMS = ["BOS", "NYK", "LAL", "DEN", "MIA", "PHX"];
const day = (n: number) => new Date(Date.UTC(2026, 10, 23 + n)).toISOString().slice(0, 10);
// Every team plays on days 0, 2, 4 of the week of 2026-11-23, except PHX which also plays day 5 and 6.
const days: Record<string, string[]> = {};
for (let i = 0; i < 7; i++) days[day(i)] = TEAMS.filter((t) => [0, 2, 4].includes(i) || (t === "PHX" && i >= 5));
const snapshot: Snapshot = {
  version: 1, generated_at: "2026-11-23T12:00:00Z", reference_season: "2025-26",
  players: fixture.map((p, i) => ({ id: p.player_id, name: p.name, team: TEAMS[i % TEAMS.length], seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: p.averages }] })),
  schedule: { source: "test", days },
};
const league = { teams: 14, roster_spots: 13 };
const SLOT10 = ["PG", "SG", "G", "SF", "PF", "F", "C", "C", "UTIL", "UTIL"];
const nm = (i: number) => fixture[i]!.name;
const top = fixture.map((p, i) => ({ i, v: p.averages.pts + p.averages.reb + p.averages.ast })).sort((a, b) => b.v - a.v).map((x) => x.i);

/** 12 players: only one has C. */
const roster = [
  { name: nm(top[0]!), positions: "PG,SG" }, { name: nm(top[1]!), positions: "SG,SF" }, { name: nm(top[2]!), positions: "C" },
  { name: nm(top[3]!), positions: "PG" }, { name: nm(top[4]!), positions: "SF,PF" }, { name: nm(top[5]!), positions: "PF" },
  { name: nm(top[6]!), positions: "SG" }, { name: nm(top[7]!), positions: "SF" }, { name: nm(top[8]!), positions: "PG,SG" },
  { name: nm(top[9]!), positions: "PF" }, { name: nm(top[10]!), positions: "SF,PF" }, { name: nm(top[11]!), positions: "PG" },
];

describe("slots in the matchup", () => {
  const input = (extra: Partial<AnalyzeInput> = {}): AnalyzeInput => ({ league: { ...league, slots: SLOT10 }, roster, matchup: { weeks: 2000 }, ...extra });
  const out = analyze(input(), snapshot);
  test("lineup_slots counts the slots and each starter shows his slot", () => {
    expect(out.matchup!.lineup_slots).toBe(10);
    const starters = out.matchup!.rosters.you.filter((r) => r.counted);
    expect(starters.length).toBeLessThanOrEqual(10);
    expect(starters.every((r) => r.slot)).toBe(true);
    expect(out.matchup!.lineup_source).toBe("recommended");
  });
  test("disagreeing lineup_slots and league.slots are refused, not guessed", () => {
    expect(() => analyze(input({ matchup: { lineup_slots: 9, weeks: 100 } }), snapshot)).toThrow("league.slots");
  });
  test("the user's own lineup is used, and a better one is recommended", () => {
    const worst = roster.slice(-5).map((r) => r.name).concat(roster.slice(0, 5).map((r) => r.name));
    const o = analyze(input({ matchup: { weeks: 2000, lineup: roster.slice(5, 11).map((r) => r.name) } }), snapshot).matchup!;
    expect(o.lineup_source).toBe("user");
    expect(o.rosters.you.filter((r) => r.counted).length).toBe(6);
    expect(o.recommended_lineup).toBeDefined();
    expect(o.recommended_lineup!.week_win_pct).toBeGreaterThanOrEqual(o.week_win_pct);
    void worst;
  });
  test("a lineup that cannot be seated is refused", () => {
    const r = roster.map((p) => (p.name === nm(top[3]!) ? { ...p, positions: "C" } : p));
    // two centres, one C slot (and the other slot is a guard slot)
    expect(() => analyze({ league: { ...league, slots: ["C", "PG"] }, roster: r, matchup: { weeks: 100, lineup: [nm(top[2]!), nm(top[3]!)] } }, snapshot)).toThrow("cannot be seated");
    expect(() => analyze({ league: { ...league, slots: ["C", "UTIL"] }, roster: r, matchup: { weeks: 100, lineup: [nm(top[2]!), nm(top[3]!)] } }, snapshot)).not.toThrow();
  });
});

describe("slots in waiver and trade", () => {
  const cands = [top[20]!, top[21]!, top[22]!, top[23]!, top[24]!, top[25]!].map((i) => ({ name: nm(i), positions: i % 2 ? "C" : "PG" }));
  test("a move that would leave the only centre slot-less is flagged breaks-slot, never ranked", () => {
    // Slots need one C and the roster has exactly one. Candidates without a C can only be added by dropping a non-centre.
    const o = analyze({ league: { ...league, slots: ["PG", "C", "UTIL"] }, roster: roster.slice(0, 3).map((r) => ({ ...r })), waiver: { candidates: cands.map((c) => ({ ...c, positions: "PG" })), top: 20 } }, snapshot).waiver!;
    for (const m of o.moves) expect(m.drop).not.toBe(nm(top[2]!));
  });
  test("when every drop would empty a required slot the candidate is listed as breaks-slot, with the slot named", () => {
    const five = [["PG"], ["SG"], ["SF"], ["PF"], ["C"]].map((p, i) => ({ name: nm(top[i]!), positions: p }));
    const o = analyze({ league: { teams: 14, roster_spots: 5, slots: ["PG", "SG", "SF", "PF", "C"] }, roster: five, waiver: { candidates: [{ name: nm(top[40]!) }, { name: nm(top[41]!), positions: "SF" }] } }, snapshot).waiver!;
    const nr = o.not_ranked.find((n) => n.add === nm(top[40]!))!;
    expect(nr.reason).toBe("breaks-slot");
    expect(nr.empty_slots!.length).toBeGreaterThan(0);
    expect(nr.explanation).toContain("Not recommended");
    expect(o.moves.every((m) => m.add !== nm(top[40]!))).toBe(true);
  });
  test("without positions on the roster the slot check is off and says so", () => {
    const o = analyze({ league: { ...league, slots: SLOT10 }, roster: roster.map((r) => ({ name: r.name })), waiver: { candidates: cands } }, snapshot).waiver!;
    expect(o.assumptions.some((a) => a.includes("check that a move leaves no required slot empty is OFF"))).toBe(true);
  });
  test("a trade that leaves a required slot empty is reported", () => {
    const give = [{ name: nm(top[2]!) }];
    const get = [{ name: nm(top[30]!), positions: "PG" }];
    const o = analyze({ league: { ...league, slots: SLOT10 }, roster, trade: { give, get } }, snapshot).trade!;
    expect(o.you!.empty_slots).toBeDefined();
  });
});
