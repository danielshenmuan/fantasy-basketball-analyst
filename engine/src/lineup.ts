/**
 * Lineup slots and positions (issue #2).
 *
 * A league's starting lineup is either a number (the best N players by value, positions ignored: the original model) or a
 * list of slot names such as ["PG","SG","G","SF","PF","F","C","C","UTIL","UTIL"]. With a list, every player fills one slot
 * he is eligible for. The pick maximises total value: a transversal matroid, so taking players best-first and keeping each one
 * only if everyone kept can still be seated gives the optimal lineup.
 */
export type Slots = number | string[];

/** Wildcard position: eligible anywhere. Used for the replacement-level filler player, never for a real player. */
export const ANY_POSITION = "*";

const norm = (s: string): string => s.trim().toUpperCase().replace(/[^A-Z]/g, "");

/** Bench and injured-list slots are not lineup slots. */
const NON_LINEUP = new Set(["BN", "BENCH", "IL", "ILP", "IR", "NA"]);

export function slotCount(s: Slots): number {
  return typeof s === "number" ? s : s.length;
}

/** Normalised slot names. Throws on a name this model does not know, naming it. */
export function parseSlots(raw: string[]): string[] {
  const out: string[] = [];
  const bad: string[] = [];
  for (const r of raw) {
    const n = norm(r);
    if (NON_LINEUP.has(n)) { bad.push(`${r} (bench and injured-list slots are not lineup slots)`); continue; }
    const canon = n === "UTILITY" || n === "FLEX" || n === "UT" ? "UTIL" : n === "CTR" ? "C" : n;
    if (!KNOWN.has(canon)) { bad.push(r); continue; }
    out.push(canon);
  }
  if (bad.length) throw new Error(`unsupported lineup slots: ${bad.join(", ")}. Supported: PG SG G SF PF F C UTIL`);
  if (out.length < 1 || out.length > 20) throw new Error("lineup slots must list from 1 to 20 starting slots");
  return out;
}

const KNOWN = new Set(["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL"]);
/** Which player positions can fill each slot. */
const FILLS: Record<string, string[]> = {
  PG: ["PG"], SG: ["SG"], G: ["PG", "SG"], SF: ["SF"], PF: ["PF"], F: ["SF", "PF"], C: ["C"],
};

/** Normalise a player's positions ("PG,SG", ["pg","SG"]). Unknown labels are dropped; the wildcard is kept. */
export function parsePositions(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : raw.split(/[,/\s]+/);
  const out: string[] = [];
  for (const r of list) {
    const n = r === ANY_POSITION ? r : norm(r);
    if (n === ANY_POSITION || ["PG", "SG", "SF", "PF", "C"].includes(n)) { if (!out.includes(n)) out.push(n); }
    else if (n === "G") for (const x of ["PG", "SG"]) { if (!out.includes(x)) out.push(x); }
    else if (n === "F") for (const x of ["SF", "PF"]) { if (!out.includes(x)) out.push(x); }
  }
  return out.length ? out : undefined;
}

/** Can a player with these positions sit in this slot? No positions given: UTIL only (the model never guesses a position). */
export function eligible(slot: string, positions: string[] | undefined): boolean {
  if (slot === "UTIL") return true;
  if (!positions || positions.length === 0) return false;
  if (positions.includes(ANY_POSITION)) return true;
  const ok = FILLS[slot];
  return !!ok && positions.some((p) => ok.includes(p));
}

export interface Seatable { value: number; positions?: string[]; games?: number }

/** Seat players in slots; returns slot index -> player index, or null when someone cannot be seated (augmenting-path matching). */
function seat(players: Seatable[], idx: number[], slots: string[]): number[] | null {
  const slotOf = Array<number>(slots.length).fill(-1);
  const tryPlayer = (p: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slots.length; s++) {
      if (seen[s] || !eligible(slots[s]!, players[p]!.positions)) continue;
      seen[s] = true;
      if (slotOf[s]! < 0 || tryPlayer(slotOf[s]!, seen)) { slotOf[s] = p; return true; }
    }
    return false;
  };
  for (const p of idx) if (!tryPlayer(p, Array<boolean>(slots.length).fill(false))) return null;
  return slotOf;
}

export interface Assigned<T> { player: T; slot: string }

/**
 * The best lineup for `slots`: with a number, the best N by value. With slot names, the best-valued players who can all be
 * seated, each in a slot he is eligible for. A player whose team has no game (`games` of 0) is not available and is skipped
 * when slot names are given (a number keeps the original behaviour). Players are returned best first; slot is "" for a number.
 */
export function assignLineup<T extends Seatable>(players: T[], slots: Slots): Assigned<T>[] {
  if (typeof slots === "number") return [...players].sort((a, b) => b.value - a.value).slice(0, slots).map((p) => ({ player: p, slot: "" }));
  const order = players.map((_, i) => i).filter((i) => !(players[i]!.games !== undefined && players[i]!.games! <= 0)).sort((a, b) => players[b]!.value - players[a]!.value);
  const kept: number[] = [];
  for (const i of order) {
    if (kept.length >= slots.length) break;
    if (seat(players, [...kept, i], slots)) kept.push(i);
  }
  const slotOf = seat(players, kept, slots) ?? [];
  const out: Assigned<T>[] = [];
  slotOf.forEach((p, s) => { if (p >= 0) out.push({ player: players[p]!, slot: slots[s]! }); });
  return out.sort((a, b) => b.player.value - a.player.value);
}

export function pickLineup<T extends Seatable>(players: T[], slots: Slots): T[] {
  return assignLineup(players, slots).map((a) => a.player);
}

/**
 * Slots that nobody on the roster can fill (the largest set of slots that can be seated is found, the rest are returned).
 * Only real position data counts: used to refuse moves that would leave a required slot empty.
 */
export function unfilledSlots(players: Seatable[], slots: string[]): string[] {
  const slotOf = Array<number>(slots.length).fill(-1);
  const tryPlayer = (p: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slots.length; s++) {
      if (seen[s] || !eligible(slots[s]!, players[p]!.positions)) continue;
      seen[s] = true;
      if (slotOf[s]! < 0 || tryPlayer(slotOf[s]!, seen)) { slotOf[s] = p; return true; }
    }
    return false;
  };
  for (let p = 0; p < players.length; p++) tryPlayer(p, Array<boolean>(slots.length).fill(false));
  return slots.filter((_, s) => slotOf[s]! < 0);
}
