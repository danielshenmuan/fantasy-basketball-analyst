import { mondayOf } from "./matchup";
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
export interface SnapshotWeek { start: string; games: Record<string, number>; tbd_slots?: number }
export interface SnapshotSchedule {
  source: string;
  /** `tbd_slots`: games the source lists with a team not yet announced; those teams' counts for the week may be low. */
  weeks?: SnapshotWeek[];
  /**
   * Day by day: date (YYYY-MM-DD) -> team abbreviations playing that day. Optional so older files still load.
   * When `weeks` is absent it is derived from this (see `scheduleWeeks`). `tbd_days` counts games per date with a team not yet announced.
   */
  days?: Record<string, string[]>;
  tbd_days?: Record<string, number>;
}

/** Games per team per fantasy week: the file's `weeks`, else counted from `days`. Empty when there is no schedule. */
export function scheduleWeeks(s: Snapshot): SnapshotWeek[] {
  const sc = s.schedule;
  if (!sc) return [];
  if (sc.weeks && sc.weeks.length) return sc.weeks;
  const by = new Map<string, SnapshotWeek>();
  for (const date of Object.keys(sc.days ?? {}).sort()) {
    const start = mondayOf(date);
    const w = by.get(start) ?? { start, games: {} };
    for (const t of sc.days![date]!) w.games[t] = (w.games[t] ?? 0) + 1;
    const tbd = sc.tbd_days?.[date];
    if (tbd) w.tbd_slots = (w.tbd_slots ?? 0) + tbd;
    by.set(start, w);
  }
  return [...by.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/** Games each team plays from `from` to `to` inclusive (YYYY-MM-DD). Null when the file has no day-by-day schedule. */
export function gamesBetween(s: Snapshot, from: string, to: string): Record<string, number> | null {
  const days = s.schedule?.days;
  if (!days) return null;
  const out: Record<string, number> = {};
  for (const [d, teams] of Object.entries(days)) if (d >= from && d <= to) for (const t of teams) out[t] = (out[t] ?? 0) + 1;
  return out;
}

/** Dates (sorted) on which a team plays, from `from` to `to` inclusive. Null without a day-by-day schedule. */
export function gameDays(s: Snapshot, team: string, from: string, to: string): string[] | null {
  const days = s.schedule?.days;
  if (!days) return null;
  return Object.keys(days).filter((d) => d >= from && d <= to && days[d]!.includes(team)).sort();
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

const TEAM_ALIASES: Record<string, string> = {
  GS: "GSW", GOS: "GSW", NO: "NOP", NOR: "NOP", NY: "NYK", NYC: "NYK", SA: "SAS", SAN: "SAS", PHO: "PHX", WSH: "WAS",
  UTAH: "UTA", CHO: "CHA", BRK: "BKN", NJ: "BKN",
};
const POSITIONS = new Set(["PG", "SG", "SF", "PF", "C", "G", "F", "GF", "FC", "UTIL", "UT"]);
const isTeam = (t: string, teams: Set<string>) => teams.has(TEAM_ALIASES[t] ?? t);

/**
 * Split a host-style entry like "M. Johnson Jr. (DAL, PF)" or "M. Johnson Jr. DAL PF" into the name and the team.
 * Positions are dropped (the snapshot has none). Bare trailing codes are only read as team/position when written in capitals.
 */
function splitQuery(query: string, teams: Set<string>): { name: string; team?: string } {
  let name = query, team: string | undefined;
  const paren = name.match(/[(\[]([^)\]]*)[)\]]/);
  if (paren) {
    for (const t of paren[1]!.split(/[\s,/|-]+/).map((x) => x.toUpperCase()).filter(Boolean))
      if (isTeam(t, teams)) team = TEAM_ALIASES[t] ?? t;
    name = name.replace(paren[0], " ");
  }
  const words = name.trim().split(/\s+/);
  while (words.length > 1) {
    const w = words[words.length - 1]!;
    if (!/^[A-Z]{1,4}$/.test(w)) break;
    if (isTeam(w, teams)) team ??= TEAM_ALIASES[w] ?? w;
    else if (!POSITIONS.has(w)) break;
    words.pop();
  }
  // "M. Johnson Jr. PF/C" style position lists
  return { name: words.join(" "), team };
}

/** A one-letter first word is an initial: it must be the first letter of the first name, and the rest the start of the other words. */
function initialMatch(q: string[], cand: string[]): boolean {
  return cand.length > 1 && cand[0]!.startsWith(q[0]!) && prefixMatch(q.slice(1), cand.slice(1));
}

/**
 * Find a player by the name a user typed, optionally with the host's team and position ("M. Johnson Jr. (DAL, PF)").
 * Never guesses: more than one possible player is "ambiguous" and the caller must ask. No match is "not_found"
 * (a typo, or a rookie not in the data yet). An initial that matches nobody but whose surname exists is "ambiguous"
 * with the same-surname players as candidates. A team narrows several hits; it never rejects the only hit (the host's
 * team can be out of date after a trade), and when it leaves none the unnarrowed hits come back for the caller to ask about.
 */
export function resolvePlayer(query: string, players: SnapshotPlayer[]): NameMatch {
  const teams = new Set(players.map((p) => p.team).filter((t): t is string => !!t));
  const { name, team } = splitQuery(query, teams);
  const q = nameTokens(name);
  if (q.length === 0) return { status: "not_found" };
  const key = q.join(" ");
  const narrow = (hits: SnapshotPlayer[]) => {
    if (!team || hits.length < 2) return hits;
    const t = hits.filter((p) => p.team === team);
    return t.length ? t : hits;
  };
  const pick = (hits: SnapshotPlayer[]): NameMatch => {
    hits = narrow(hits);
    return hits.length === 1 ? { status: "matched", player: hits[0]! } : hits.length > 1 ? { status: "ambiguous", candidates: hits } : { status: "not_found" };
  };

  const alias = players.filter((p) => (p.aliases ?? []).some((a) => nameTokens(a).join(" ") === key));
  if (alias.length) return pick(alias);
  const exact = players.filter((p) => nameTokens(p.name).join(" ") === key);
  if (exact.length) return pick(exact);
  const isInitial = q.length > 1 && q[0]!.length === 1;
  const hits = players.filter((p) => (isInitial ? initialMatch(q, nameTokens(p.name)) : prefixMatch(q, nameTokens(p.name))));
  if (hits.length) return pick(hits);
  if (isInitial) {
    // No first name starts with that letter: offer everyone with that surname rather than dropping the player.
    const sur = q[q.length - 1]!;
    const same = players.filter((p) => nameTokens(p.name).slice(1).includes(sur));
    if (same.length) {
      const t = team ? same.filter((p) => p.team === team) : [];
      return { status: "ambiguous", candidates: t.length ? t : same };
    }
  }
  return { status: "not_found" };
}

export function historyOf(p: SnapshotPlayer): PlayerHistory {
  return { player_id: p.id, name: p.name, seasons: p.seasons };
}
