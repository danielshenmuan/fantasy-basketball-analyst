import type { PlayerHistory, SeasonLine } from "./types";

/**
 * The daily data file the skill and the connector read. Derived numbers only: per-season averages per player,
 * no game logs and no ownership. The league baseline is computed from it at run time because it depends on league size.
 */
export interface Snapshot {
  version: 1;
  generated_at: string;
  /** Season used for the league baseline, e.g. "2025-26". */
  reference_season: string;
  players: SnapshotPlayer[];
  /** Games per team per fantasy week (Monday-Sunday), from the public NBA schedule. Absent in older files. */
  schedule?: SnapshotSchedule;
}
export interface SnapshotSchedule {
  source: string;
  /** `tbd_slots`: games the source lists with a team not yet announced; those teams' counts for the week may be low. */
  weeks: { start: string; games: Record<string, number>; tbd_slots?: number }[];
}
export interface SnapshotPlayer {
  id: number;
  name: string;
  /** Nicknames and short forms, e.g. "KPJ", "Dame". */
  aliases?: string[];
  /** Current team abbreviation (e.g. "HOU"), used to count games from the schedule. */
  team?: string;
  seasons: SeasonLine[];
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** Lowercase, no accents or punctuation, no generational suffix: "Kevin Porter Jr." -> ["kevin", "porter"]. */
export function nameTokens(s: string): string[] {
  const t = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’,]/g, "")
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return t.filter((x, i) => !(SUFFIXES.has(x) && i > 0));
}

export type NameMatch =
  | { status: "matched"; player: SnapshotPlayer }
  | { status: "ambiguous"; candidates: SnapshotPlayer[] }
  | { status: "not_found" };

/** Every query word must be the start of a different word in the candidate's name: "herb jones" finds Herbert Jones. */
function prefixMatch(q: string[], cand: string[]): boolean {
  const used = new Set<number>();
  return q.every((w) => {
    const i = cand.findIndex((c, k) => !used.has(k) && c.startsWith(w));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

/**
 * Find a player by the name a user typed. Never guesses: more than one possible player is "ambiguous"
 * and the caller must ask. No match is "not_found" (a typo, or a rookie not in the data yet).
 */
export function resolvePlayer(query: string, players: SnapshotPlayer[]): NameMatch {
  const q = nameTokens(query);
  if (q.length === 0) return { status: "not_found" };
  const key = q.join(" ");
  const pick = (hits: SnapshotPlayer[]): NameMatch =>
    hits.length === 1 ? { status: "matched", player: hits[0]! } : hits.length > 1 ? { status: "ambiguous", candidates: hits } : { status: "not_found" };

  const alias = players.filter((p) => (p.aliases ?? []).some((a) => nameTokens(a).join(" ") === key));
  if (alias.length) return pick(alias);
  const exact = players.filter((p) => nameTokens(p.name).join(" ") === key);
  if (exact.length) return pick(exact);
  return pick(players.filter((p) => prefixMatch(q, nameTokens(p.name))));
}

export function historyOf(p: SnapshotPlayer): PlayerHistory {
  return { player_id: p.id, name: p.name, seasons: p.seasons };
}
