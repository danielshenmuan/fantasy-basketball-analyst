import { describe, expect, test } from "bun:test";
import fx from "./fixtures/players-2025-26.json";
import { nameTokens, resolvePlayer, type PlayerSeason, type SnapshotPlayer } from "../src";

const fixture = fx.players as unknown as PlayerSeason[];
const players: SnapshotPlayer[] = fixture.map((p) => ({
  id: p.player_id, name: p.name, seasons: [{ season: "2025-26", gp: p.gp, mpg: p.mpg, averages: p.averages }],
  aliases: p.name === "Kevin Porter Jr." ? ["KPJ"] : undefined,
}));
const name = (q: string) => { const m = resolvePlayer(q, players); return m.status === "matched" ? m.player.name : m.status; };

describe("name matching", () => {
  test("tokens drop accents, punctuation and suffixes", () => {
    expect(nameTokens("Kevin Porter Jr.")).toEqual(["kevin", "porter"]);
    expect(nameTokens("Dereck Lively II")).toEqual(["dereck", "lively"]);
    expect(nameTokens("Luka Dončić")).toEqual(["luka", "doncic"]);
    expect(nameTokens("Shai Gilgeous-Alexander")).toEqual(["shai", "gilgeous", "alexander"]);
  });
  test("exact, partial and shortened first names", () => {
    expect(name("James Harden")).toBe("James Harden");
    expect(name("harden")).toBe("James Harden");
    expect(name("Herb Jones")).toBe("Herbert Jones");
    expect(name("Kevin Porter")).toBe("Kevin Porter Jr.");
    expect(name("kevin porter jr")).toBe("Kevin Porter Jr.");
  });
  test("aliases", () => { expect(name("KPJ")).toBe("Kevin Porter Jr."); });
  test("never guesses: shared surnames are ambiguous", () => {
    expect(name("Porter")).toBe("ambiguous");
    expect(name("Jones")).toBe("ambiguous");
    const m = resolvePlayer("Porter", players);
    expect(m.status === "ambiguous" && m.candidates.length).toBeGreaterThan(2);
  });
  test("unknown names and empty input", () => {
    expect(name("Zzyzx Qwerty")).toBe("not_found");
    expect(name("   ")).toBe("not_found");
  });
});

describe("host-style abbreviated names (initial + surname + team)", () => {
  const mk = (id: number, n: string, team: string): SnapshotPlayer => ({ id, name: n, team, seasons: [] });
  const pool = [
    mk(1, "Morez Johnson Jr.", "DAL"), mk(2, "Keldon Johnson", "SAS"), mk(3, "Jalen Johnson", "ATL"),
    mk(4, "Jabari Smith Jr.", "HOU"), mk(5, "Jaylin Smith", "HOU"), mk(6, "Jaylin Smith", "DEN"), mk(7, "Tre Johnson", "WAS"),
  ];
  const r = (q: string) => { const m = resolvePlayer(q, pool); return m.status === "matched" ? m.player.name + "@" + m.player.team : m.status === "ambiguous" ? "amb:" + m.candidates.map((c) => c.id).join(",") : m.status; };
  test("initial + surname + suffix + team and position resolves", () => {
    expect(r("M. Johnson Jr. (DAL, PF)")).toBe("Morez Johnson Jr.@DAL");
    expect(r("M. Johnson Jr. DAL PF")).toBe("Morez Johnson Jr.@DAL");
    expect(r("M. Johnson")).toBe("Morez Johnson Jr.@DAL");
  });
  test("ambiguous initials are reported, never guessed", () => {
    expect(r("J. Johnson")).toBe("Jalen Johnson@ATL");
    expect(r("T. Johnson")).toBe("Tre Johnson@WAS");
    expect(r("J. Smith")).toBe("amb:4,5,6");
  });
  test("team narrows but never rejects", () => {
    expect(r("J. Smith (DEN, SF)")).toBe("Jaylin Smith@DEN");
    expect(r("J. Smith (HOU)")).toBe("amb:4,5");
    expect(r("J. Smith (LAL)")).toBe("amb:4,5,6");
    expect(r("M. Johnson (HOU)")).toBe("Morez Johnson Jr.@DAL");
  });
  test("host team codes are normalised", () => {
    expect(r("K. Johnson (SA)")).toBe("Keldon Johnson@SAS");
  });
  test("an initial that fits nobody lists the same-surname players", () => {
    expect(r("Z. Johnson")).toBe("amb:1,2,3,7");
    expect(r("Z. Johnson (ATL)")).toBe("amb:3");
    expect(r("Z. Nobodyson")).toBe("not_found");
  });
});
