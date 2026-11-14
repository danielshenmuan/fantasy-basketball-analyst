import { assessTeam, type RosterPlayer, type TeamAssessment } from "./assess";
import { buildBaseline } from "./baseline";
import { categoryZ } from "./fantasyValue";
import { simulateBenchmark, type SimPlayer } from "./simulate";
import { historyOf, resolvePlayer, type Snapshot } from "./snapshot";
import { CATEGORIES, type Band, type Category, type PlayerSeason } from "./types";

export interface AnalyzeInput {
  league: { teams: number; roster_spots: number };
  roster: { name: string; status?: "IL" | "active" }[];
  /** Season for the league baseline; defaults to the snapshot's. */
  reference?: string;
  /** Simulated leagues (default 500). */
  leagues?: number;
  seed?: number;
}
export interface NameResult {
  input: string;
  status: "matched" | "ambiguous" | "not_found";
  matched?: string;
  candidates?: { id: number; name: string; latest_season: string }[];
}
export interface AnalyzeOutput extends TeamAssessment {
  snapshot: { generated_at: string; reference_season: string };
  league: { teams: number; roster_spots: number };
  names: NameResult[];
  /** Plain list for the agent to speak from: strongest to weakest by percentile. */
  ranking: { category: Category; band: Band; percentile: number }[];
}

function check(input: AnalyzeInput): void {
  const { teams, roster_spots } = input.league ?? ({} as AnalyzeInput["league"]);
  if (!Number.isInteger(teams) || teams < 4 || teams > 30) throw new Error("league.teams must be a whole number from 4 to 30");
  if (!Number.isInteger(roster_spots) || roster_spots < 5 || roster_spots > 20) throw new Error("league.roster_spots must be a whole number from 5 to 20 (active slots, not IL)");
  if (!Array.isArray(input.roster) || input.roster.length === 0) throw new Error("roster must list at least one player");
  if (input.roster.length > 40) throw new Error("roster has more than 40 players");
}

export function analyze(input: AnalyzeInput, snapshot: Snapshot): AnalyzeOutput {
  check(input);
  const reference = input.reference ?? snapshot.reference_season;
  const { teams, roster_spots } = input.league;

  const pool: PlayerSeason[] = [];
  for (const p of snapshot.players) {
    const s = p.seasons.find((x) => x.season === reference);
    if (s && s.mpg > 0 && s.gp > 0) pool.push({ player_id: p.id, name: p.name, gp: s.gp, mpg: s.mpg, averages: s.averages });
  }
  if (pool.length < teams * roster_spots) throw new Error(`snapshot has only ${pool.length} players for ${reference}; need at least ${teams * roster_spots}`);
  const baseline = buildBaseline(pool, teams * roster_spots);
  const sim: SimPlayer[] = pool.map((p) => {
    const z = categoryZ(p.averages, baseline);
    return { id: p.player_id, z, total: CATEGORIES.reduce((t, c) => t + z[c], 0) };
  });
  const benchmark = simulateBenchmark(sim, { teams, rosterSpots: roster_spots }, { leagues: input.leagues ?? 500, seed: input.seed ?? 1 });

  const names: NameResult[] = [];
  const roster: RosterPlayer[] = input.roster.map((r) => {
    const m = resolvePlayer(r.name, snapshot.players);
    const status = r.status === "IL" ? "IL" : undefined;
    if (m.status === "matched") {
      names.push({ input: r.name, status: "matched", matched: m.player.name });
      return { name: m.player.name, status, history: historyOf(m.player) };
    }
    if (m.status === "ambiguous") {
      names.push({
        input: r.name, status: "ambiguous",
        candidates: m.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })),
      });
    } else names.push({ input: r.name, status: "not_found" });
    return { name: r.name, status, history: { player_id: null, name: r.name, seasons: [] } };
  });

  const result = assessTeam(roster, baseline, benchmark, { reference });
  for (const n of names) {
    if (n.status === "ambiguous") result.assumptions.push(`"${n.input}" could be more than one player; counted as an average player until clarified.`);
    if (n.status === "not_found") result.assumptions.push(`"${n.input}" was not found (misspelled, or a rookie not in the data yet); counted as an average player.`);
  }
  const ranking = CATEGORIES.map((c) => ({ category: c, band: result.categories[c].band, percentile: Math.round(result.categories[c].percentile) }))
    .sort((a, b) => b.percentile - a.percentile);
  return {
    ...result,
    snapshot: { generated_at: snapshot.generated_at, reference_season: snapshot.reference_season },
    league: input.league, names, ranking,
  };
}
