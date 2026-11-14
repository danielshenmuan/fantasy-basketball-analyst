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
