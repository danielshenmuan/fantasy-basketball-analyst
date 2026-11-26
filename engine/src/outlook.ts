import type { PlayerRef } from "./analyze";
import { addDays } from "./availability";
import { mulberry32 } from "./simulate";

/**
 * Rest-of-season and playoff outlook (issue #10). Each remaining week's win chance comes from the same weekly simulation as the
 * matchup tool (real opponent roster when known, typical opponent otherwise). The season is then played out many times:
 * your results from those chances, other teams' results as coin flips (their rosters are unknown), standings and playoff
 * bracket applied. The roster is held as it stands: no future adds, trades or injuries are assumed.
 */
export interface OutlookInput {
  /** Your record so far. */
  record: { wins: number; losses: number; ties?: number; /** Your current value of the league's tiebreaker (higher is better), to compare with the other teams'. */ tiebreak_value?: number };
  /** Matchups still to play, in order. `opponent`: that team's roster when you know it; otherwise a typical opponent is used. */
  remaining: { week_start: string; opponent?: PlayerRef[] }[];
  playoffs: {
    /** Teams that make the playoffs. */
    teams: number;
    /** Monday of the first playoff week. Later rounds follow a week apart. */
    first_week: string;
    /** The league's tiebreaker as the host states it (shown in the output). Standings with `tiebreak_value` use it for current standing only. */
    tiebreaker?: string;
  };
  /** Every other team's current record. Needed for seeding and the playoff chance; without it only your wins are projected. */
  standings?: { team: string; wins: number; losses: number; ties?: number; /** Current value of the league's tiebreaker (higher is better), e.g. category wins or points for. */ tiebreak_value?: number }[];
  /** Compare the outlook with this change to your roster. */
  move?: { add?: PlayerRef; drop?: string; give?: string[]; get?: PlayerRef[] };
  /** Simulated weeks per week's win chance (default 2000). */
  weeks?: number;
  /** Simulated seasons (default 5000). */
  runs?: number;
}

export interface OutlookSummary {
  expected_final_wins: number;
  playoffs?: {
    make_pct: number; bye_pct: number;
    /** Chance of each final seed 1..N (N = all teams). */
    seed_pct: number[];
    /** Share of simulated seasons in which your playoff spot depended on a tie that the tiebreaker (not the record) settled. */
    tiebreak_decides_pct: number;
    /** Chance of winning each playoff round you play, given you are in it. */
    round_win_pct: number[];
    title_pct: number;
  };
}
export interface OutlookOutput extends OutlookSummary {
  weeks_left: number;
  per_week: { week_start: string; opponent: "roster" | "typical"; win_pct: number; tie_pct: number; games_source: "schedule" | "assumed" | "unknown" }[];
  /** Chance of each final regular-season win total. */
  final_wins_pct: Record<string, number>;
  move?: { label: string; expected_final_wins: number; playoffs_make_pct?: number; title_pct?: number; delta_wins: number; delta_playoff_points?: number; delta_title_points?: number };
  tiebreaker?: string;
  assumptions: string[];
}

/** What the weekly simulation says for one week and roster: win and tie chance (0 to 1). */
export type WeekWin = (weekStart: string, roster: PlayerRef[], opponent: PlayerRef[] | undefined, weeks: number) => { win: number; tie: number; source: "schedule" | "assumed" };

const nextPow2 = (n: number) => { let b = 1; while (b < n) b *= 2; return b; };

function playOut(
  inp: OutlookInput, chances: { win: number; tie: number }[], playoffChances: number[], runs: number, seed: number,
): { summary: OutlookSummary; finalWins: Map<number, number> } {
  const rand = mulberry32(seed);
  const myW0 = inp.record.wins, myT0 = inp.record.ties ?? 0;
  const others = inp.standings ?? [];
  const n = others.length + 1;
  const P = inp.playoffs.teams;
  const B = nextPow2(P), byes = B - P, rounds = Math.log2(B);
  const left = chances.length;
  const finalWins = new Map<number, number>();
  let sumWins = 0, make = 0, bye = 0, tiebreak = 0, title = 0;
  const seeds = Array<number>(n).fill(0);
  const reach = Array<number>(rounds).fill(0), won = Array<number>(rounds).fill(0);
  for (let r = 0; r < runs; r++) {
    let w = myW0, t = myT0;
    for (const c of chances) { const u = rand(); if (u < c.win) w++; else if (u < c.win + c.tie) t++; }
    sumWins += w;
    finalWins.set(w, (finalWins.get(w) ?? 0) + 1);
    if (!inp.standings) continue;
    const mine = w + 0.5 * t;
    // Each other team: remaining games as fair coin flips (their rosters are unknown).
    let above = 0, tied = 0, aboveOnTie = 0;
    const myTb = inp.record.tiebreak_value;
    for (const o of others) {
      let ow = o.wins;
      for (let i = 0; i < left; i++) if (rand() < 0.5) ow++;
      const pts = ow + 0.5 * (o.ties ?? 0);
      if (pts > mine) above++;
      else if (pts === mine) {
        tied++;
        // Ties are settled by the current tiebreak value when both are known, otherwise by a coin flip.
        const tb = o.tiebreak_value;
        if (tb === undefined || myTb === undefined || tb === myTb) { if (rand() < 0.5) aboveOnTie++; } else if (tb > myTb) aboveOnTie++;
      }
    }
    const seed0 = above + aboveOnTie + 1;
    seeds[Math.min(seed0, n) - 1]!++;
    const inPlayoffs = seed0 <= P;
    if (tied > 0 && above + 1 <= P && above + tied + 1 > P) tiebreak++;
    if (!inPlayoffs) continue;
    make++;
    if (seed0 <= byes) bye++;
    let alive = true;
    for (let k = seed0 <= byes ? 1 : 0; k < rounds && alive; k++) { // a bye skips round one
      reach[k]!++;
      const p = playoffChances[k] ?? playoffChances[playoffChances.length - 1] ?? 0.5;
      if (rand() < p) { won[k]!++; if (k === rounds - 1) title++; } else alive = false;
    }
  }
  const pct = (x: number) => Math.round((x / runs) * 1000) / 10;
  return {
    finalWins,
    summary: {
      expected_final_wins: Math.round((sumWins / runs) * 100) / 100,
      ...(inp.standings ? { playoffs: {
        make_pct: pct(make), bye_pct: pct(bye), seed_pct: seeds.map(pct), tiebreak_decides_pct: pct(tiebreak),
        round_win_pct: reach.map((rc, k) => (rc > 0 ? Math.round((won[k]! / rc) * 1000) / 10 : 0)), title_pct: pct(title),
      } } : {}),
    },
  };
}

export function runOutlook(inp: OutlookInput, roster: PlayerRef[], weekWin: WeekWin, seed = 1): OutlookOutput {
  if (!inp.record || ![inp.record.wins, inp.record.losses].every((x) => Number.isInteger(x) && x >= 0)) throw new Error("outlook.record needs whole wins and losses");
  if (!Array.isArray(inp.remaining) || inp.remaining.length === 0) throw new Error("outlook.remaining must list the weeks you still play (week_start, and the opponent's roster when known)");
  if (inp.remaining.length > 30) throw new Error("outlook.remaining has more than 30 weeks");
  if (!inp.playoffs || !Number.isInteger(inp.playoffs.teams) || inp.playoffs.teams < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(inp.playoffs.first_week ?? "")) throw new Error("outlook.playoffs needs teams and first_week (YYYY-MM-DD, a Monday)");
  if (inp.standings && inp.playoffs.teams > inp.standings.length + 1) throw new Error("outlook.playoffs.teams is larger than the league (standings lists the other teams)");
  const weeks = inp.weeks ?? 2000;
  const runs = inp.runs ?? 5000;
  const assumptions: string[] = [];
  const rounds = Math.log2(nextPow2(inp.playoffs.teams));
  const sim = (r: PlayerRef[]) => {
    const per = inp.remaining.map((w) => ({ w, ...weekWin(w.week_start, r, w.opponent, weeks) }));
    // Playoff opponents are unknown: a typical opponent each round, in the weeks of the bracket.
    const playoff = Array.from({ length: rounds }, (_, k) => weekWin(addDays(inp.playoffs.first_week, 7 * k), r, undefined, weeks).win);
    const { summary, finalWins } = playOut(inp, per.map((x) => ({ win: x.win, tie: x.tie })), playoff, runs, seed);
    return { per, summary, finalWins };
  };
  const base = sim(roster);
  const total = [...base.finalWins.values()].reduce((a, b) => a + b, 0);
  const finalWinsPct = Object.fromEntries([...base.finalWins.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), Math.round((v / total) * 1000) / 10]));
  const out: OutlookOutput = {
    weeks_left: inp.remaining.length, ...base.summary,
    per_week: base.per.map((x) => ({
      week_start: x.w.week_start, opponent: x.w.opponent && x.w.opponent.length > 0 ? "roster" : "typical",
      win_pct: Math.round(x.win * 100), tie_pct: Math.round(x.tie * 100), games_source: x.source,
    })),
    final_wins_pct: finalWinsPct, ...(inp.playoffs.tiebreaker ? { tiebreaker: inp.playoffs.tiebreaker } : {}), assumptions,
  };
  if (inp.move) {
    const mv = inp.move;
    const drop = new Set([...(mv.drop ? [mv.drop] : []), ...(mv.give ?? [])].map((s) => s.toLowerCase()));
    const next = [...roster.filter((p) => !drop.has(p.name.toLowerCase())), ...(mv.add ? [mv.add] : []), ...(mv.get ?? [])];
    const m = sim(next);
    const label = [mv.add ? `add ${mv.add.name}` : "", mv.drop ? `drop ${mv.drop}` : "", mv.give?.length ? `give ${mv.give.join(", ")}` : "", mv.get?.length ? `get ${mv.get.map((g) => g.name).join(", ")}` : ""].filter(Boolean).join(", ");
    out.move = {
      label, expected_final_wins: m.summary.expected_final_wins, delta_wins: Math.round((m.summary.expected_final_wins - base.summary.expected_final_wins) * 100) / 100,
      ...(m.summary.playoffs ? {
        playoffs_make_pct: m.summary.playoffs.make_pct, title_pct: m.summary.playoffs.title_pct,
        delta_playoff_points: Math.round((m.summary.playoffs.make_pct - base.summary.playoffs!.make_pct) * 10) / 10,
        delta_title_points: Math.round((m.summary.playoffs.title_pct - base.summary.playoffs!.title_pct) * 10) / 10,
      } : {}),
    };
  }
  assumptions.push(
    `Each remaining week's win chance is the weekly simulation for your roster as it stands (${weeks} simulated weeks each): no future adds, drops, trades or injuries are assumed.`,
    `Season simulated ${runs} times with a fixed seed. Weeks with no schedule in the data use an average week of games and are marked "assumed".`,
  );
  if (inp.standings) {
    assumptions.push(
      "Other teams' remaining results are fair coin flips: their rosters are not known, so a team that is strong or weak this season is not credited for it. This understates the gap at the top and bottom of the table.",
      `Seeds are decided by record (a tie counts half). A tie in the record is settled by the league's tiebreaker${inp.playoffs.tiebreaker ? ` (${inp.playoffs.tiebreaker})` : ""} only as far as it is known now; otherwise by a coin flip. "tiebreak_decides_pct" is how often your spot hung on such a tie.`,
      `Playoff rounds use a typical opponent in each round's week (the real opponent is not known until seeding). ${nextPow2(inp.playoffs.teams) - inp.playoffs.teams} top seed(s) get a first-round bye in a bracket of ${nextPow2(inp.playoffs.teams)}.`,
    );
  } else assumptions.push("No standings were given, so only your regular-season wins are projected. Give every other team's record for the playoff chance.");
  return out;
}
