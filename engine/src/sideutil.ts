import type { NameResult, PlayerGames, PlayerRef, Scenario } from "./analyze";
import { addDays, availabilityFromHost, DEFAULT_RAMP, gamesWithAvailability, type Availability } from "./availability";
import { assignLineup, parsePositions, pickLineup, slotCount, type Slots } from "./lineup";
import type { Entry } from "./moves";
import { resolvePlayer, type Snapshot } from "./snapshot";

/** One roster player as a weekly matchup sees him. */
export interface SideRow {
  entry: Entry;
  positions?: string[];
  /** Games he plays in the week (injury window and ramp-up applied). */
  games: number;
  /** Games still to play when the week is under way. */
  left: number;
  active: boolean;
  /** Games lost to the injury window or scenario, and the note to relay. */
  lost: number;
  note?: string;
  av?: Availability;
}

export interface SideContext {
  snapshot: Snapshot;
  estimated: Map<number, Entry>;
  gamesFor: (team?: string) => number;
  /** Monday of the week, or null when the week has no schedule (games are an average, injury windows cannot be placed). */
  weekStart: string | null;
  asOf: string;
  ramp: { games: number; share: number } | false | undefined;
  scenarios: Scenario[];
  slots: Slots;
  /** Names the user says they start. Only for the user's own side. */
  lineup?: string[];
  leftFor?: (team?: string) => number;
  assumptions: string[];
}

export interface SideResult {
  names: NameResult[];
  rows: SideRow[];
  /** The lineup that counts: the user's own when given, otherwise the best fit. */
  chosen: SideRow[];
  /** When the user gave a lineup: the model's best-fit lineup, if it differs. */
  recommended?: SideRow[];
  slotOf: Map<SideRow, string>;
  playerRows: PlayerGames[];
}

const rampOf = (r: SideContext["ramp"]) => (r === false ? null : (r ?? DEFAULT_RAMP));

/** The availability a scenario implies for the week being looked at. */
export function scenarioAvailability(s: Scenario, firstDay: string, ramp: SideContext["ramp"]): Availability {
  const outFrom = s.out_from ?? firstDay;
  const back = s.returns ?? (s.out_until ? addDays(s.out_until, 1) : null);
  const rp = s.ramp === false ? null : (s.ramp ?? rampOf(ramp));
  return { outFrom, returnDate: back, ...(rp && back ? { ramp: rp } : {}) };
}

/**
 * Resolve one roster for a weekly matchup: names, games per player (with injury windows), who is in the lineup and in which slot.
 * A scenario or the host's injury tag shortens his games; the ramp-up after a return is an assumption and is labelled so.
 */
export function resolveSide(list: PlayerRef[], label: string, side: "you" | "opponent", ctx: SideContext): SideResult {
  const names: NameResult[] = [];
  const rows: SideRow[] = [];
  const scenarioById = new Map<number, Scenario>();
  for (const s of ctx.scenarios) {
    if ((s.side ?? "you") !== side) continue;
    const h = resolvePlayer(s.name, ctx.snapshot.players);
    if (h.status === "matched") scenarioById.set(h.player.id, s);
    else ctx.assumptions.push(`WARNING: scenario for "${s.name}" ignored: ${h.status === "ambiguous" ? "could be more than one player" : "not found"}.`);
  }
  const firstDay = ctx.weekStart ?? ctx.asOf;
  const windowStart = ctx.weekStart && ctx.asOf > ctx.weekStart ? ctx.asOf : firstDay;
  for (const r of list) {
    const hit = resolvePlayer(r.name, ctx.snapshot.players);
    if (hit.status === "ambiguous") { names.push({ input: r.name, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) }); continue; }
    if (hit.status !== "matched") { names.push({ input: r.name, status: "not_found" }); continue; }
    names.push({ input: r.name, status: "matched", matched: hit.player.name });
    const e = ctx.estimated.get(hit.player.id);
    if (!e) continue;
    const scen = scenarioById.get(hit.player.id);
    const host = availabilityFromHost(r.injury, r.return_date, windowStart, rampOf(ctx.ramp));
    const av = scen ? scenarioAvailability(scen, windowStart, ctx.ramp) : host.av;
    const teamGames = ctx.gamesFor(e.team);
    let games = teamGames, lost = 0, note: string | undefined;
    if (av && ctx.weekStart) {
      const g = gamesWithAvailability(ctx.snapshot, e.team, ctx.weekStart, teamGames, av);
      games = g.games; lost = Math.max(0, teamGames - g.games);
      if (g.approximate) ctx.assumptions.push(`${hit.player.name}: the data has no day-by-day schedule, so his games lost are spread evenly over the week (approximate).`);
    } else if (av) ctx.assumptions.push(`${hit.player.name}: no schedule for this week, so his injury window is not applied.`);
    if (scen) note = `YOUR ASSUMPTION (not a measured fact): ${scen.returns ? `back ${scen.returns}` : scen.out_until ? `out through ${scen.out_until}` : "out for the week"}${av?.ramp ? `, output ${Math.round(av.ramp.share * 100)}% for his first ${av.ramp.games} games back (also an assumption)` : ""}`;
    else if (host.flag) note = host.flag;
    const left = ctx.leftFor ? (teamGames > 0 ? ctx.leftFor(e.team) * (games / teamGames) : 0) : 0;
    rows.push({ entry: e, positions: parsePositions(r.positions), games, left, active: r.status !== "IL", lost, note, av });
  }
  const missing = names.filter((n) => n.status !== "matched").length;
  if (missing > 0) ctx.assumptions.push(`${missing} player(s) in the ${label} roster could not be matched and are left out of the weekly totals.`);

  const active = rows.filter((x) => x.active);
  const seatable = active.map((x) => ({ x, value: x.entry.value, positions: x.positions, games: x.games }));
  const best = pickLineup(seatable, ctx.slots).map((s) => s.x);
  let chosen = best, recommended: SideRow[] | undefined;
  if (ctx.lineup && ctx.lineup.length > 0) {
    const ids = new Set<number>();
    for (const n of ctx.lineup) {
      const h = resolvePlayer(n, ctx.snapshot.players);
      if (h.status === "matched") ids.add(h.player.id);
      else ctx.assumptions.push(`WARNING: lineup player "${n}" ${h.status === "ambiguous" ? "could be more than one player" : "was not found"}; left out of your lineup.`);
    }
    const mine = active.filter((x) => ids.has(x.entry.id)).sort((a, b) => b.entry.value - a.entry.value);
    if (mine.length > slotCount(ctx.slots)) throw new Error(`matchup.lineup lists ${mine.length} players but the league has ${slotCount(ctx.slots)} lineup slots`);
    if (typeof ctx.slots !== "number") {
      const seated = assignLineup(mine.map((x) => ({ x, value: x.entry.value, positions: x.positions })), ctx.slots);
      if (seated.length < mine.length) throw new Error(`matchup.lineup cannot be seated in the league's slots: ${mine.filter((x) => !seated.some((s) => s.player.x === x)).map((x) => x.entry.name).join(", ")} fit no open slot`);
    }
    chosen = mine;
    if (best.length !== mine.length || best.some((b) => !mine.includes(b))) recommended = best;
  }
  const slotOf = new Map<SideRow, string>();
  if (typeof ctx.slots !== "number") for (const a of assignLineup(chosen.map((x) => ({ x, value: x.entry.value, positions: x.positions })), ctx.slots)) slotOf.set(a.player.x, a.slot);
  const counted = new Set(chosen);
  const playerRows: PlayerGames[] = rows.map((x) => ({
    name: x.entry.name, team: x.entry.team ?? null, games: Math.round(x.games * 100) / 100,
    ...(ctx.leftFor ? { games_left: Math.round(x.left * 100) / 100 } : {}),
    counted: counted.has(x),
    ...(slotOf.has(x) ? { slot: slotOf.get(x) } : {}),
    ...(x.active ? {} : { status: "IL" as const }),
    ...(x.lost > 0 ? { games_lost: Math.round(x.lost * 100) / 100 } : {}),
    ...(x.note ? { note: x.note } : {}),
  })).sort((a, b) => Number(b.counted) - Number(a.counted) || b.games - a.games);
  return { names, rows, chosen, recommended, slotOf, playerRows };
}
