#!/usr/bin/env node

// src/cli.ts
import { readFileSync } from "node:fs";

// src/types.ts
var CATEGORIES = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"];

// src/simulate.ts
var RATE_CATEGORIES = [["FG%", "fgm", "fga"], ["FT%", "ftm", "fta"]];
var DEFAULT_PICK_WEIGHTS = [0.45, 0.25, 0.15, 0.1, 0.05];
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pickIndex(n, weights, rand) {
  const k = Math.min(n, weights.length);
  let total = 0;
  for (let i = 0;i < k; i++)
    total += weights[i];
  let r = rand() * total;
  for (let i = 0;i < k; i++) {
    r -= weights[i];
    if (r <= 0)
      return i;
  }
  return k - 1;
}
function simulateBenchmark(players, settings, opts = {}) {
  const { teams, rosterSpots } = settings;
  const leagues = opts.leagues ?? 500;
  const weights = opts.pickWeights ?? DEFAULT_PICK_WEIGHTS;
  const poolSize = teams * rosterSpots;
  const lineupSlots = Math.max(1, Math.min(rosterSpots, opts.lineupSlots ?? rosterSpots));
  const pool = [...players].sort((a, b) => b.total - a.total).slice(0, poolSize);
  if (pool.length < poolSize)
    throw new Error(`simulateBenchmark: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32(opts.seed ?? 1);
  const sums = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  const ratesAsRates = pool.every((p) => p.shots !== undefined);
  for (let l = 0;l < leagues; l++) {
    const remaining = pool.slice();
    const team = Array.from({ length: teams }, () => []);
    for (let round = 0;round < rosterSpots; round++) {
      for (let k = 0;k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k;
        const [p] = remaining.splice(pickIndex(remaining.length, weights, rand), 1);
        team[t].push(p);
      }
    }
    for (const t of team) {
      const lineup = t.sort((a, b) => b.total - a.total).slice(0, lineupSlots);
      for (const c of CATEGORIES)
        sums[c].push(lineup.reduce((s, p) => s + p.z[c], 0));
      if (ratesAsRates)
        for (const [c, made, att] of RATE_CATEGORIES) {
          const a = lineup.reduce((s, p) => s + p.shots[att], 0);
          sums[c][sums[c].length - 1] = a > 0 ? lineup.reduce((s, p) => s + p.shots[made], 0) / a : 0;
        }
    }
  }
  for (const c of CATEGORIES)
    sums[c].sort((a, b) => a - b);
  const poolMean = Object.fromEntries(CATEGORIES.map((c) => [c, pool.reduce((t, p) => t + p.z[c], 0) / pool.length]));
  const mean = (k) => pool.reduce((t, p) => t + p.shots[k], 0) / pool.length;
  return {
    settings,
    leagues,
    pickWeights: weights,
    lineupSlots,
    teamSums: sums,
    poolMean,
    ratesAsRates,
    ...ratesAsRates ? { poolMeanShots: { fgm: mean("fgm"), fga: mean("fga"), ftm: mean("ftm"), fta: mean("fta") } } : {}
  };
}

// src/lineup.ts
var ANY_POSITION = "*";
var norm = (s) => s.trim().toUpperCase().replace(/[^A-Z]/g, "");
var NON_LINEUP = new Set(["BN", "BENCH", "IL", "ILP", "IR", "NA"]);
function slotCount(s) {
  return typeof s === "number" ? s : s.length;
}
function parseSlots(raw) {
  const out = [];
  const bad = [];
  for (const r of raw) {
    const n = norm(r);
    if (NON_LINEUP.has(n)) {
      bad.push(`${r} (bench and injured-list slots are not lineup slots)`);
      continue;
    }
    const canon = n === "UTILITY" || n === "FLEX" || n === "UT" ? "UTIL" : n === "CTR" ? "C" : n;
    if (!KNOWN.has(canon)) {
      bad.push(r);
      continue;
    }
    out.push(canon);
  }
  if (bad.length)
    throw new Error(`unsupported lineup slots: ${bad.join(", ")}. Supported: PG SG G SF PF F C UTIL`);
  if (out.length < 1 || out.length > 20)
    throw new Error("lineup slots must list from 1 to 20 starting slots");
  return out;
}
var KNOWN = new Set(["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL"]);
var FILLS = {
  PG: ["PG"],
  SG: ["SG"],
  G: ["PG", "SG"],
  SF: ["SF"],
  PF: ["PF"],
  F: ["SF", "PF"],
  C: ["C"]
};
function parsePositions(raw) {
  if (raw === undefined)
    return;
  const list = Array.isArray(raw) ? raw : raw.split(/[,/\s]+/);
  const out = [];
  for (const r of list) {
    const n = r === ANY_POSITION ? r : norm(r);
    if (n === ANY_POSITION || ["PG", "SG", "SF", "PF", "C"].includes(n)) {
      if (!out.includes(n))
        out.push(n);
    } else if (n === "G")
      for (const x of ["PG", "SG"]) {
        if (!out.includes(x))
          out.push(x);
      }
    else if (n === "F")
      for (const x of ["SF", "PF"]) {
        if (!out.includes(x))
          out.push(x);
      }
  }
  return out.length ? out : undefined;
}
function eligible(slot, positions) {
  if (slot === "UTIL")
    return true;
  if (!positions || positions.length === 0)
    return false;
  if (positions.includes(ANY_POSITION))
    return true;
  const ok = FILLS[slot];
  return !!ok && positions.some((p) => ok.includes(p));
}
function seat(players, idx, slots) {
  const slotOf = Array(slots.length).fill(-1);
  const tryPlayer = (p, seen) => {
    for (let s = 0;s < slots.length; s++) {
      if (seen[s] || !eligible(slots[s], players[p].positions))
        continue;
      seen[s] = true;
      if (slotOf[s] < 0 || tryPlayer(slotOf[s], seen)) {
        slotOf[s] = p;
        return true;
      }
    }
    return false;
  };
  for (const p of idx)
    if (!tryPlayer(p, Array(slots.length).fill(false)))
      return null;
  return slotOf;
}
function assignLineup(players, slots) {
  if (typeof slots === "number")
    return [...players].sort((a, b) => b.value - a.value).slice(0, slots).map((p) => ({ player: p, slot: "" }));
  const order = players.map((_, i) => i).filter((i) => !(players[i].games !== undefined && players[i].games <= 0)).sort((a, b) => players[b].value - players[a].value);
  const kept = [];
  for (const i of order) {
    if (kept.length >= slots.length)
      break;
    if (seat(players, [...kept, i], slots))
      kept.push(i);
  }
  const slotOf = seat(players, kept, slots) ?? [];
  const out = [];
  slotOf.forEach((p, s) => {
    if (p >= 0)
      out.push({ player: players[p], slot: slots[s] });
  });
  return out.sort((a, b) => b.player.value - a.player.value);
}
function pickLineup(players, slots) {
  return assignLineup(players, slots).map((a) => a.player);
}
function unfilledSlots(players, slots) {
  const slotOf = Array(slots.length).fill(-1);
  const tryPlayer = (p, seen) => {
    for (let s = 0;s < slots.length; s++) {
      if (seen[s] || !eligible(slots[s], players[p].positions))
        continue;
      seen[s] = true;
      if (slotOf[s] < 0 || tryPlayer(slotOf[s], seen)) {
        slotOf[s] = p;
        return true;
      }
    }
    return false;
  };
  for (let p = 0;p < players.length; p++)
    tryPlayer(p, Array(slots.length).fill(false));
  return slots.filter((_, s) => slotOf[s] < 0);
}

// src/matchup.ts
var DEFAULT_WEEK_GAMES = 3.4;
var DEFAULT_WEEKS = 1e4;
var LUCK_REFERENCE_SLOTS = 13;
var luckScale = (slots) => Math.sqrt(LUCK_REFERENCE_SLOTS / slots);
var WEEKLY_LUCK = { pts: 0.08, reb: 0.09, ast: 0.11, stl: 0.17, blk: 0.23, fg3m: 0.14, tov: 0.13 };
var WEEKLY_LUCK_PCT = { fg: 0.024, ft: 0.041 };
var LUCK_CORRELATION = [
  [1, 0.29, 0.2, 0.1, 0.11, 0.63, 0.14],
  [0.29, 1, 0.24, 0.1, 0.17, 0.11, 0.18],
  [0.2, 0.24, 1, 0.08, 0.1, 0.12, 0.1],
  [0.1, 0.1, 0.08, 1, 0.07, 0.03, 0.1],
  [0.11, 0.17, 0.1, 0.07, 1, 0.05, 0.02],
  [0.63, 0.11, 0.12, 0.03, 0.05, 1, 0.08],
  [0.14, 0.18, 0.1, 0.1, 0.02, 0.08, 1]
];
var COUNT_KEYS = ["pts", "reb", "ast", "stl", "blk", "fg3m", "tov"];
function cholesky(m) {
  const n = m.length;
  const L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0;i < n; i++)
    for (let j = 0;j <= i; j++) {
      let s = m[i][j];
      for (let k = 0;k < j; k++)
        s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0)
          throw new Error("LUCK_CORRELATION is not positive definite");
        L[i][j] = Math.sqrt(s);
      } else
        L[i][j] = s / L[j][j];
    }
  return L;
}
var LUCK_L = cholesky(LUCK_CORRELATION);
function weeklyTotals(players, slots) {
  const lineup = pickLineup(players, slots);
  const t = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
  for (const p of lineup) {
    const { averages: a, games: g } = p;
    t.pts += a.pts * g;
    t.reb += a.reb * g;
    t.ast += a.ast * g;
    t.stl += a.stl * g;
    t.blk += a.blk * g;
    t.fg3m += a.fg3m * g;
    t.tov += a.turnovers * g;
    t.fgm += (a.fgm ?? a.fga * a.fg_pct) * g;
    t.fga += a.fga * g;
    t.ftm += (a.ftm ?? a.fta * a.ft_pct) * g;
    t.fta += a.fta * g;
  }
  return t;
}
function gaussian(rand) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0)
      u = rand();
    const v = rand(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}
function outcome(t, luck, g, scale) {
  const cnt = COUNT_KEYS.map((k) => t[k]);
  let fg = t.fga > 0 ? t.fgm / t.fga : 0, ft = t.fta > 0 ? t.ftm / t.fta : 0;
  if (luck) {
    const z = COUNT_KEYS.map(() => g());
    COUNT_KEYS.forEach((k, i) => {
      const c = LUCK_L[i].reduce((s, v, j) => s + v * z[j], 0);
      cnt[i] = Math.max(0, cnt[i] * (1 + WEEKLY_LUCK[k] * scale * c));
    });
    fg = Math.min(1, Math.max(0, fg + WEEKLY_LUCK_PCT.fg * scale * g()));
    ft = Math.min(1, Math.max(0, ft + WEEKLY_LUCK_PCT.ft * scale * g()));
  }
  return { cnt, fg, ft };
}
function scaledTotals(t, k) {
  const o = { ...t };
  for (const key of Object.keys(o))
    o[key] = t[key] * k;
  return o;
}
function finalOutcome(side, luck, g, scale) {
  const { banked, remaining: rem, share } = side;
  const o = outcome(rem, luck && share > 0, g, share > 0 ? scale / Math.sqrt(share) : scale);
  const cnt = o.cnt.map((v, i) => v + banked[COUNT_KEYS[i]]);
  const fga = banked.fga + rem.fga, fta = banked.fta + rem.fta;
  return {
    cnt,
    fg: fga > 0 ? (banked.fgm + o.fg * rem.fga) / fga : 0,
    ft: fta > 0 ? (banked.ftm + o.ft * rem.fta) / fta : 0
  };
}
var CAT_ORDER = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "TO", "FG%", "FT%"];
function simulateWeeks(me, opponents, opts = {}) {
  if (opponents.length === 0)
    throw new Error("simulateWeeks: no opponents");
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  const luck = opts.luck ?? true;
  const rand = mulberry32(opts.seed ?? 1);
  const g = gaussian(rand);
  const scale = luckScale(opts.slots ?? LUCK_REFERENCE_SLOTS);
  const wins = Array(9).fill(0);
  const dist = Array(10).fill(0);
  let weekWins = 0;
  for (let w = 0;w < weeks; w++) {
    const opp = opponents[opponents.length === 1 ? 0 : Math.floor(rand() * opponents.length)];
    const pr = opts.progress;
    const a = pr ? finalOutcome(pr.me, luck, g, scale) : outcome(me, luck, g, scale);
    const b = pr ? finalOutcome(pr.opponent, luck, g, scale) : outcome(opp, luck, g, scale);
    let won = 0;
    for (let i = 0;i < 7; i++) {
      const isTO = i === 6;
      if (isTO ? a.cnt[i] < b.cnt[i] : a.cnt[i] > b.cnt[i]) {
        wins[i]++;
        won++;
      }
    }
    if (a.fg > b.fg) {
      wins[7]++;
      won++;
    }
    if (a.ft > b.ft) {
      wins[8]++;
      won++;
    }
    dist[won]++;
    if (won >= 5)
      weekWins++;
  }
  const categories = Object.fromEntries(CAT_ORDER.map((c, i) => [c, wins[i] / weeks]));
  return { weeks, categories, weekWin: weekWins / weeks, distribution: dist.map((x) => x / weeks) };
}
function typicalOpponents(players, settings, slots, gamesFor, opts = {}) {
  const { teams, rosterSpots } = settings;
  const poolSize = teams * rosterSpots;
  const pool = [...players].sort((a, b) => b.value - a.value).slice(0, poolSize);
  if (pool.length < poolSize)
    throw new Error(`typicalOpponents: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32((opts.seed ?? 1) + 7919);
  const weights = opts.pickWeights ?? DEFAULT_PICK_WEIGHTS;
  const out = [];
  for (let l = 0;l < (opts.leagues ?? 300); l++) {
    const remaining = pool.slice();
    const rosters = Array.from({ length: teams }, () => []);
    for (let round = 0;round < rosterSpots; round++)
      for (let k = 0;k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k;
        rosters[t].push(remaining.splice(pickIndex(remaining.length, weights, rand), 1)[0]);
      }
    for (const r of rosters)
      out.push(weeklyTotals(r.map((p) => ({ averages: p.averages, games: gamesFor(p.team), value: p.value })), slots));
  }
  return out;
}
function mondayOf(isoDate) {
  const d = new Date(isoDate.slice(0, 10) + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// src/lucktable.ts
var LUCK_STATS = ["minutes", "fgm", "fga", "ftm", "fta", "fg3m", "fg3a", "oreb", "dreb", "ast", "stl", "blk", "turnovers", "pf"];
var BASE_LUCK_SHARE = { minutes: 0.0425, fgm: 0.0819, fga: 0.0653, ftm: 0.1633, fta: 0.1523, fg3m: 0.1442, fg3a: 0.0914, oreb: 0.1657, dreb: 0.0987, ast: 0.1088, stl: 0.1749, blk: 0.2295, turnovers: 0.1344, pf: 0.1195 };
var BASE_LUCK_CORRELATION = [
  [1, 0.514, 0.622, 0.25, 0.259, 0.325, 0.459, 0.251, 0.47, 0.354, 0.202, 0.19, 0.255, 0.196],
  [0.514, 1, 0.791, 0.199, 0.204, 0.552, 0.458, 0.2, 0.245, 0.211, 0.105, 0.112, 0.103, 0.065],
  [0.622, 0.791, 1, 0.236, 0.239, 0.417, 0.648, 0.283, 0.306, 0.232, 0.155, 0.13, 0.167, 0.062],
  [0.25, 0.199, 0.236, 1, 0.951, 0.044, 0.121, 0.091, 0.106, 0.062, 0.033, 0.045, 0.145, 0.219],
  [0.259, 0.204, 0.239, 0.951, 1, 0.038, 0.113, 0.103, 0.124, 0.043, 0.037, 0.042, 0.155, 0.219],
  [0.325, 0.552, 0.417, 0.044, 0.038, 1, 0.717, 0.02, 0.121, 0.116, 0.028, 0.048, 0.08, 0.044],
  [0.459, 0.458, 0.648, 0.121, 0.113, 0.717, 1, 0.062, 0.174, 0.141, 0.096, 0.079, 0.119, 0.055],
  [0.251, 0.2, 0.283, 0.091, 0.103, 0.02, 0.062, 1, 0.156, 0.057, 0.083, 0.041, 0.12, 0.07],
  [0.47, 0.245, 0.306, 0.106, 0.124, 0.121, 0.174, 0.156, 1, 0.255, 0.078, 0.179, 0.15, 0.029],
  [0.354, 0.211, 0.232, 0.062, 0.043, 0.116, 0.141, 0.057, 0.255, 1, 0.084, 0.103, 0.102, -0.013],
  [0.202, 0.105, 0.155, 0.033, 0.037, 0.028, 0.096, 0.083, 0.078, 0.084, 1, 0.072, 0.102, 0.072],
  [0.19, 0.112, 0.13, 0.045, 0.042, 0.048, 0.079, 0.041, 0.179, 0.103, 0.072, 1, 0.022, 0.02],
  [0.255, 0.103, 0.167, 0.145, 0.155, 0.08, 0.119, 0.12, 0.15, 0.102, 0.102, 0.022, 1, 0.2],
  [0.196, 0.065, 0.062, 0.219, 0.219, 0.044, 0.055, 0.07, 0.029, -0.013, 0.072, 0.02, 0.2, 1]
];

// src/anycat.ts
var ZERO = () => ({
  minutes: 0,
  fgm: 0,
  fga: 0,
  ftm: 0,
  fta: 0,
  fg3m: 0,
  fg3a: 0,
  oreb: 0,
  dreb: 0,
  ast: 0,
  stl: 0,
  blk: 0,
  turnovers: 0,
  pf: 0,
  dd: 0,
  td: 0
});
var BASE_KEYS = Object.keys(ZERO());
var def = (code, label, num, extra = {}) => ({ code, label, num, ...extra });
var REGISTRY = [
  def("MIN", "Minutes played", { minutes: 1 }),
  def("FGM", "Field goals made", { fgm: 1 }),
  def("FGA", "Field goals attempted", { fga: 1 }),
  def("FG%", "Field goal percentage", { fgm: 1 }, { den: { fga: 1 } }),
  def("FTM", "Free throws made", { ftm: 1 }),
  def("FTA", "Free throws attempted", { fta: 1 }),
  def("FT%", "Free throw percentage", { ftm: 1 }, { den: { fta: 1 } }),
  def("3PM", "3-pointers made", { fg3m: 1 }),
  def("3PA", "3-pointers attempted", { fg3a: 1 }),
  def("3P%", "3-point percentage", { fg3m: 1 }, { den: { fg3a: 1 } }),
  def("PTS", "Points", { fgm: 2, fg3m: 1, ftm: 1 }),
  def("REB", "Rebounds", { oreb: 1, dreb: 1 }),
  def("OREB", "Offensive rebounds", { oreb: 1 }),
  def("DREB", "Defensive rebounds", { dreb: 1 }),
  def("AST", "Assists", { ast: 1 }),
  def("STL", "Steals", { stl: 1 }),
  def("BLK", "Blocks", { blk: 1 }),
  def("TO", "Turnovers", { turnovers: 1 }, { lower: true }),
  def("PF", "Personal fouls", { pf: 1 }, { lower: true }),
  def("A/T", "Assist to turnover ratio", { ast: 1 }, { den: { turnovers: 1 } }),
  def("DD", "Double-doubles", { dd: 1 }),
  def("TD", "Triple-doubles", { td: 1 })
];
var BY_CODE = new Map(REGISTRY.map((d) => [d.code, d]));
var SUPPORTED_CATEGORIES = REGISTRY.map((d) => d.code);
var ALIASES = {};
var alias = (code, ...names) => {
  for (const n of [code, ...names])
    ALIASES[norm2(n)] = code;
};
function norm2(s) {
  return s.toUpperCase().replace(/[^A-Z0-9%/]/g, "");
}
alias("MIN", "Minutes", "Minutes Played");
alias("FGM", "Field Goals Made", "FG Made");
alias("FGA", "Field Goals Attempted", "FG Attempted");
alias("FG%", "Field Goal Percentage", "FG Pct");
alias("FTM", "Free Throws Made");
alias("FTA", "Free Throws Attempted");
alias("FT%", "Free Throw Percentage", "FT Pct");
alias("3PM", "3PTM", "3PT", "3-point Shots Made", "3-Pointers Made", "Three Pointers Made", "Threes", "3PTS");
alias("3PA", "3PTA", "3-point Shots Attempted", "3-Pointers Attempted");
alias("3P%", "3PT%", "3-point Percentage", "3-Point Field Goal Percentage");
alias("PTS", "Points", "Points Scored");
alias("REB", "Rebounds", "Total Rebounds");
alias("OREB", "Offensive Rebounds");
alias("DREB", "Defensive Rebounds");
alias("AST", "Assists");
alias("STL", "ST", "Steals");
alias("BLK", "BS", "Blocks", "Blocked Shots");
alias("TO", "TOV", "Turnovers");
alias("PF", "Fouls", "Personal Fouls");
alias("A/T", "AST/TO", "Assist/Turnover Ratio", "Assist to Turnover Ratio");
alias("DD", "Double Doubles", "Double-Doubles", "Double Double");
alias("TD", "Triple Doubles", "Triple-Doubles", "Triple Double");
function parseCategories(names) {
  const unknown = [];
  const out = [];
  for (const n of names) {
    const code = ALIASES[norm2(n)];
    if (!code)
      unknown.push(n);
    else if (!out.includes(code))
      out.push(code);
  }
  if (unknown.length)
    throw new Error(`unsupported categories: ${unknown.join(", ")}. Supported: ${SUPPORTED_CATEGORIES.join(" ")}`);
  if (out.length < 2)
    throw new Error("a league needs at least 2 categories");
  return out;
}
var STANDARD_NINE = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"];
var isStandardNine = (codes) => codes.length === 9 && STANDARD_NINE.every((c) => codes.includes(c));
var lin = (c, t) => {
  let s = 0;
  for (const k of Object.keys(c))
    s += c[k] * t[k];
  return s;
};
var defOf = (code) => {
  const d = BY_CODE.get(code);
  if (!d)
    throw new Error(`unknown category ${code}`);
  return d;
};
var isLowerCategory = (code) => Boolean(defOf(code).lower);
function categoryValue(code, t) {
  const d = defOf(code);
  const n = lin(d.num, t);
  if (!d.den)
    return n;
  const m = lin(d.den, t);
  return m > 0 ? n / m : 0;
}
function neededStats(codes) {
  const s = new Set;
  for (const c of codes) {
    const d = defOf(c);
    for (const k of Object.keys(d.num))
      s.add(k);
    for (const k of Object.keys(d.den ?? {}))
      s.add(k);
  }
  return [...s];
}
function baseOf(a, needed) {
  const b = ZERO();
  const get = {
    minutes: a.min,
    fgm: a.fgm ?? a.fga * a.fg_pct,
    fga: a.fga,
    ftm: a.ftm ?? a.fta * a.ft_pct,
    fta: a.fta,
    fg3m: a.fg3m,
    fg3a: a.fg3a,
    oreb: a.oreb,
    dreb: a.dreb,
    ast: a.ast,
    stl: a.stl,
    blk: a.blk,
    turnovers: a.turnovers,
    pf: a.pf,
    dd: a.dd_rate,
    td: a.td_rate
  };
  for (const k of BASE_KEYS) {
    const v = get[k];
    if (v === undefined && needed.includes(k))
      throw new Error(`the data file has no ${k} yet (needed for this league's categories)`);
    b[k] = v ?? 0;
  }
  return b;
}
var avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
var stdOf = (xs, m) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) || 1;
function buildAnyBaseline(pool, codes, poolSize) {
  const top = [...pool].sort((a, b) => b.gp * b.mpg - a.gp * a.mpg).slice(0, poolSize);
  if (top.length === 0)
    throw new Error("buildAnyBaseline: no players");
  const out = {};
  for (const c of codes) {
    const d = defOf(c);
    if (!d.den) {
      const xs = top.map((p) => lin(d.num, p.base)), m = avg(xs);
      out[c] = { mean: m, std: stdOf(xs, m) };
    } else {
      const num = top.reduce((s, p) => s + lin(d.num, p.base), 0), den = top.reduce((s, p) => s + lin(d.den, p.base), 0);
      const r = den > 0 ? num / den : 0;
      const imp = top.map((p) => lin(d.num, p.base) - r * lin(d.den, p.base));
      out[c] = { mean: 0, std: stdOf(imp, avg(imp)), ratio: r };
    }
  }
  return out;
}
function anyValue(base, codes, bl) {
  let v = 0;
  for (const c of codes) {
    const d = defOf(c), b = bl[c];
    const z = d.den ? (lin(d.num, base) - b.ratio * lin(d.den, base)) / b.std : (lin(d.num, base) - b.mean) / b.std;
    v += d.lower ? -z : z;
  }
  return v;
}
function chances(p, games, into) {
  if (!(p > 0) || !(games > 0))
    return;
  const n = Math.floor(games), frac = games - n;
  for (let i = 0;i < n; i++)
    into.push(p);
  if (frac > 0.000000001)
    into.push(p * frac);
}
function anyTotals(players, slots) {
  const lineup = pickLineup(players, slots);
  const t = ZERO();
  const ddGames = [], tdGames = [];
  for (const p of lineup) {
    for (const k of BASE_KEYS)
      t[k] += p.base[k] * p.games;
    chances(p.base.dd, p.games, ddGames);
    chances(p.base.td, p.games, tdGames);
  }
  return { t, ddGames, tdGames };
}
function scaledAny(a, k) {
  const t = ZERO();
  for (const key of BASE_KEYS)
    t[key] = a.t[key] * k;
  return { t, ddGames: a.ddGames.map((p) => p * k), tdGames: a.tdGames.map((p) => p * k) };
}
function gaussianFrom(rand) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0)
      u = rand();
    const v = rand(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}
function choleskyOf(m) {
  const n = m.length;
  const L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0;i < n; i++)
    for (let j = 0;j <= i; j++) {
      let s = m[i][j];
      for (let k = 0;k < j; k++)
        s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0)
          throw new Error("BASE_LUCK_CORRELATION is not positive definite");
        L[i][j] = Math.sqrt(s);
      } else
        L[i][j] = s / L[j][j];
    }
  return L;
}
var LUCK_CHOL = choleskyOf(BASE_LUCK_CORRELATION);
function anyOutcome(a, luck, g, rand, scale, needDD, needTD, extra) {
  const t = { ...a.t };
  if (luck) {
    const z = LUCK_STATS.map(() => g());
    LUCK_STATS.forEach((k, i) => {
      const c = LUCK_CHOL[i].reduce((s, v, j) => s + v * z[j], 0);
      t[k] = Math.max(0, t[k] * (1 + BASE_LUCK_SHARE[k] * scale * c));
    });
    if (needDD) {
      let n = 0;
      for (const p of a.ddGames)
        if (rand() < p)
          n++;
      t.dd = n;
    }
    if (needTD) {
      let n = 0;
      for (const p of a.tdGames)
        if (rand() < p)
          n++;
      t.td = n;
    }
  }
  if (extra)
    for (const k of BASE_KEYS)
      t[k] += extra[k];
  return t;
}
function simulateAny(me, opponents, codes, opts = {}) {
  if (opponents.length === 0)
    throw new Error("simulateAny: no opponents");
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  const luck = opts.luck ?? true;
  const rand = mulberry32(opts.seed ?? 1);
  const g = gaussianFrom(rand);
  const scale = luckScale(opts.slots ?? LUCK_REFERENCE_SLOTS);
  const needDD = codes.includes("DD"), needTD = codes.includes("TD");
  const defs = codes.map(defOf);
  const wins = Array(codes.length).fill(0);
  const dist = Array(codes.length + 1).fill(0);
  let win = 0, tie = 0;
  const side = (a, s) => s ? anyOutcome(s.remaining, luck && s.share > 0, g, rand, s.share > 0 ? scale / Math.sqrt(s.share) : scale, needDD, needTD, s.banked) : anyOutcome(a, luck, g, rand, scale, needDD, needTD);
  for (let w = 0;w < weeks; w++) {
    const opp = opponents[opponents.length === 1 ? 0 : Math.floor(rand() * opponents.length)];
    const a = side(me, opts.progress?.me), b = side(opp, opts.progress?.opponent);
    let won = 0, lost = 0;
    defs.forEach((d, i) => {
      const x = categoryValue(d.code, a), y = categoryValue(d.code, b);
      const better = d.lower ? x < y : x > y, worse = d.lower ? x > y : x < y;
      if (better) {
        wins[i]++;
        won++;
      } else if (worse)
        lost++;
    });
    dist[won]++;
    if (won > lost)
      win++;
    else if (won === lost)
      tie++;
  }
  return {
    weeks,
    categories: Object.fromEntries(codes.map((c, i) => [c, wins[i] / weeks])),
    weekWin: win / weeks,
    weekTie: tie / weeks,
    weekLoss: (weeks - win - tie) / weeks,
    distribution: dist.map((x) => x / weeks)
  };
}
var MISSED = {};
for (const [att, made, ...names] of [["FGA", "FGM", "Field goals missed", "Missed field goals", "FG missed", "FGMISS"], ["FTA", "FTM", "Free throws missed", "Missed free throws", "FT missed", "FTMISS"], ["3PA", "3PM", "3-pointers missed", "Missed 3-pointers", "3P missed", "3PMISS"]])
  for (const n of names)
    MISSED[norm2(n)] = { att, made };
var UNTRACKED = new Set(["technical fouls", "flagrant fouls", "ejections", "quadruple doubles", "quadruple-doubles", "technical foul", "flagrant foul", "ejection", "quad doubles", "quad-doubles"].map((n) => norm2(n)));
var untrackedScoring = (raw) => Object.keys(raw).filter((n) => UNTRACKED.has(norm2(n)));
function parseWeights(raw) {
  const unknown = [], ratios = [];
  const out = {};
  for (const [name, w] of Object.entries(raw)) {
    if (!Number.isFinite(w))
      throw new Error(`scoring weight for ${name} must be a number`);
    if (UNTRACKED.has(norm2(name)))
      continue;
    const missed = MISSED[norm2(name)];
    if (missed) {
      out[missed.att] = (out[missed.att] ?? 0) + w;
      out[missed.made] = (out[missed.made] ?? 0) - w;
      continue;
    }
    const code = ALIASES[norm2(name)];
    if (!code) {
      unknown.push(name);
      continue;
    }
    if (BY_CODE.get(code).den) {
      ratios.push(name);
      continue;
    }
    out[code] = (out[code] ?? 0) + w;
  }
  if (unknown.length)
    throw new Error(`unsupported scoring stats: ${unknown.join(", ")}. Supported: ${SUPPORTED_CATEGORIES.join(" ")}`);
  if (ratios.length)
    throw new Error(`a points league cannot weight a percentage or ratio (${ratios.join(", ")}): weight the made and attempted counts instead`);
  if (!Object.values(out).some((w) => w !== 0))
    throw new Error("scoring needs at least one stat with a weight other than 0");
  return out;
}
function pointsOf(w, t) {
  let s = 0;
  for (const c of Object.keys(w))
    s += w[c] * categoryValue(c, t);
  return s;
}
function simulatePoints(me, opponents, w, opts = {}) {
  if (opponents.length === 0)
    throw new Error("simulatePoints: no opponents");
  const weeks = opts.weeks ?? DEFAULT_WEEKS;
  const luck = opts.luck ?? true;
  const rand = mulberry32(opts.seed ?? 1);
  const g = gaussianFrom(rand);
  const scale = luckScale(opts.slots ?? LUCK_REFERENCE_SLOTS);
  const needDD = (w.DD ?? 0) !== 0, needTD = (w.TD ?? 0) !== 0;
  const side = (a, s) => s ? s.banked + pointsOf(w, anyOutcome(s.remaining, luck && s.share > 0, g, rand, s.share > 0 ? scale / Math.sqrt(s.share) : scale, needDD, needTD)) : pointsOf(w, anyOutcome(a, luck, g, rand, scale, needDD, needTD));
  let win = 0, tie = 0, sumMe = 0, sumOpp = 0;
  for (let k = 0;k < weeks; k++) {
    const opp = opponents[opponents.length === 1 ? 0 : Math.floor(rand() * opponents.length)];
    const a = side(me, opts.progress?.me), b = side(opp, opts.progress?.opponent);
    sumMe += a;
    sumOpp += b;
    if (a > b)
      win++;
    else if (a === b)
      tie++;
  }
  return { weeks, weekWin: win / weeks, weekTie: tie / weeks, weekLoss: (weeks - win - tie) / weeks, expectedMe: sumMe / weeks, expectedOpponent: sumOpp / weeks };
}
function typicalAnyOpponents(players, settings, slots, gamesFor, opts = {}) {
  const { teams, rosterSpots } = settings;
  const poolSize = teams * rosterSpots;
  const pool = [...players].sort((a, b) => b.value - a.value).slice(0, poolSize);
  if (pool.length < poolSize)
    throw new Error(`typicalAnyOpponents: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32((opts.seed ?? 1) + 7919);
  const weights = opts.pickWeights ?? DEFAULT_PICK_WEIGHTS;
  const out = [];
  for (let l = 0;l < (opts.leagues ?? 300); l++) {
    const remaining = pool.slice();
    const rosters = Array.from({ length: teams }, () => []);
    for (let round = 0;round < rosterSpots; round++)
      for (let k = 0;k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k;
        rosters[t].push(remaining.splice(pickIndex(remaining.length, weights, rand), 1)[0]);
      }
    for (const r of rosters)
      out.push(anyTotals(r.map((p) => ({ base: p.base, games: gamesFor(p.team), value: p.value })), slots));
  }
  return out;
}

// src/snapshot.ts
function scheduleWeeks(s) {
  const sc = s.schedule;
  if (!sc)
    return [];
  if (sc.weeks && sc.weeks.length)
    return sc.weeks;
  const by = new Map;
  for (const date of Object.keys(sc.days ?? {}).sort()) {
    const start = mondayOf(date);
    const w = by.get(start) ?? { start, games: {} };
    for (const t of sc.days[date])
      w.games[t] = (w.games[t] ?? 0) + 1;
    const tbd = sc.tbd_days?.[date];
    if (tbd)
      w.tbd_slots = (w.tbd_slots ?? 0) + tbd;
    by.set(start, w);
  }
  return [...by.values()].sort((a, b) => a.start.localeCompare(b.start));
}
function gameDays(s, team, from, to) {
  const days = s.schedule?.days;
  if (!days)
    return null;
  return Object.keys(days).filter((d) => d >= from && d <= to && days[d].includes(team)).sort();
}
var SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
function nameTokens(s) {
  const t = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.'’,]/g, "").replace(/[-_]/g, " ").split(/\s+/).filter(Boolean);
  return t.filter((x, i) => !(SUFFIXES.has(x) && i > 0));
}
function prefixMatch(q, cand) {
  const used = new Set;
  return q.every((w) => {
    const i = cand.findIndex((c, k) => !used.has(k) && c.startsWith(w));
    if (i < 0)
      return false;
    used.add(i);
    return true;
  });
}
var TEAM_ALIASES = {
  GS: "GSW",
  GOS: "GSW",
  NO: "NOP",
  NOR: "NOP",
  NY: "NYK",
  NYC: "NYK",
  SA: "SAS",
  SAN: "SAS",
  PHO: "PHX",
  WSH: "WAS",
  UTAH: "UTA",
  CHO: "CHA",
  BRK: "BKN",
  NJ: "BKN"
};
var POSITIONS = new Set(["PG", "SG", "SF", "PF", "C", "G", "F", "GF", "FC", "UTIL", "UT"]);
var isTeam = (t, teams) => teams.has(TEAM_ALIASES[t] ?? t);
function splitQuery(query, teams) {
  let name = query, team;
  const paren = name.match(/[(\[]([^)\]]*)[)\]]/);
  if (paren) {
    for (const t of paren[1].split(/[\s,/|-]+/).map((x) => x.toUpperCase()).filter(Boolean))
      if (isTeam(t, teams))
        team = TEAM_ALIASES[t] ?? t;
    name = name.replace(paren[0], " ");
  }
  const words = name.trim().split(/\s+/);
  while (words.length > 1) {
    const w = words[words.length - 1];
    if (!/^[A-Z]{1,4}$/.test(w))
      break;
    if (isTeam(w, teams))
      team ??= TEAM_ALIASES[w] ?? w;
    else if (!POSITIONS.has(w))
      break;
    words.pop();
  }
  return { name: words.join(" "), team };
}
function initialMatch(q, cand) {
  return cand.length > 1 && cand[0].startsWith(q[0]) && prefixMatch(q.slice(1), cand.slice(1));
}
function resolvePlayer(query, players) {
  const teams = new Set(players.map((p) => p.team).filter((t) => !!t));
  const { name, team } = splitQuery(query, teams);
  const q = nameTokens(name);
  if (q.length === 0)
    return { status: "not_found" };
  const key = q.join(" ");
  const narrow = (hits2) => {
    if (!team || hits2.length < 2)
      return hits2;
    const t = hits2.filter((p) => p.team === team);
    return t.length ? t : hits2;
  };
  const pick = (hits2) => {
    hits2 = narrow(hits2);
    return hits2.length === 1 ? { status: "matched", player: hits2[0] } : hits2.length > 1 ? { status: "ambiguous", candidates: hits2 } : { status: "not_found" };
  };
  const alias2 = players.filter((p) => (p.aliases ?? []).some((a) => nameTokens(a).join(" ") === key));
  if (alias2.length)
    return pick(alias2);
  const exact = players.filter((p) => nameTokens(p.name).join(" ") === key);
  if (exact.length)
    return pick(exact);
  const isInitial = q.length > 1 && q[0].length === 1;
  const hits = players.filter((p) => isInitial ? initialMatch(q, nameTokens(p.name)) : prefixMatch(q, nameTokens(p.name)));
  if (hits.length)
    return pick(hits);
  if (isInitial) {
    const sur = q[q.length - 1];
    const same = players.filter((p) => nameTokens(p.name).slice(1).includes(sur));
    if (same.length) {
      const t = team ? same.filter((p) => p.team === team) : [];
      return { status: "ambiguous", candidates: t.length ? t : same };
    }
  }
  return { status: "not_found" };
}
function historyOf(p) {
  return { player_id: p.id, name: p.name, seasons: p.seasons };
}

// src/availability.ts
var DEFAULT_RAMP = { games: 3, share: 0.8 };
var DAY = 86400000;
var addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
var diffDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
function evenDates(weekStart, n) {
  return Array.from({ length: n }, (_, i) => addDays(weekStart, Math.min(6, Math.floor((i + 0.5) * 7 / n))));
}
function gameWeights(snapshot, team, weekStart, teamGames, av) {
  const weekEnd = addDays(weekStart, 6);
  const real = team ? gameDays(snapshot, team, weekStart, weekEnd) : null;
  const approximate = !real || real.length === 0 && teamGames > 0;
  const dates = !approximate ? real : evenDates(weekStart, Math.round(teamGames));
  const back = av?.returnDate ?? null;
  let played = 0;
  if (av && back && av.ramp && back < weekStart && team) {
    const priorDates = gameDays(snapshot, team, back, addDays(weekStart, -1));
    played = priorDates ? priorDates.length : Math.round(teamGames * diffDays(back, weekStart) / 7);
  }
  const games = dates.map((date) => {
    if (!av || date >= av.outFrom && (back === null || date < back))
      return { date, w: av ? 0 : 1 };
    const inRamp = !!(av.ramp && back && date >= back && played < av.ramp.games);
    played++;
    return { date, w: inRamp ? av.ramp.share : 1 };
  });
  return { games, approximate };
}
function gamesWithAvailability(snapshot, team, weekStart, teamGames, av) {
  if (!av || !team)
    return { games: teamGames, teamGames, approximate: false };
  const { games, approximate } = gameWeights(snapshot, team, weekStart, teamGames, av);
  const sum = games.reduce((s, g) => s + g.w, 0);
  return { games: approximate ? sum * (teamGames / (games.length || 1)) : sum, teamGames, approximate };
}
function availabilityFromHost(tag, returnDate, asOf, ramp = DEFAULT_RAMP) {
  const t = (tag ?? "").trim().toUpperCase();
  if (t === "GTD" || t === "DTD" || t === "Q" || t === "QUESTIONABLE" || t === "DAY-TO-DAY")
    return { flag: `${t}: counted as playing (status as read from the league page)` };
  if (t !== "OUT" && t !== "O" && t !== "INJ" && t !== "IL" && !returnDate)
    return {};
  if (returnDate)
    return { av: { outFrom: asOf, returnDate, ...ramp ? { ramp } : {} } };
  const next = addDays(asOf, 7 - (new Date(asOf + "T00:00:00Z").getUTCDay() + 6) % 7);
  return { av: { outFrom: asOf, returnDate: next, ...ramp ? { ramp } : {}, assumedReturn: true }, flag: "OUT with no return date: counted as out for the rest of this week and back next week (assumption)" };
}

// src/daily.ts
function runDaily(input, snapshot, m, a) {
  const d = m.daily;
  const notes = [];
  if (input.league.lineup_lock === "weekly")
    throw new Error("this league locks lineups weekly (league.lineup_lock): nothing can be changed after the week starts, so there is no daily lineup to model. Ask for next week's lineup instead.");
  if (!snapshot.schedule?.days)
    throw new Error("matchup.daily needs the day-by-day NBA schedule: pass it as `schedule_days` (skills/matchup/scripts/season-days.mjs prints it) or use a data file that has `schedule.days`.");
  const weekEnd = addDays(a.weekStart, 6);
  const from = d.from ?? (a.hasBanked ? a.asOf : a.weekStart);
  const days = [];
  for (let x = from < a.weekStart ? a.weekStart : from;x <= weekEnd; x = addDays(x, 1))
    days.push(x);
  if (days.length === 0)
    throw new Error(`matchup.daily.from (${from}) is after the week ends (${weekEnd})`);
  const toRow = (r) => {
    const w = gameWeights(snapshot, r.entry.team, a.weekStart, a.gamesFor(r.entry.team), r.av);
    return { entry: r.entry, positions: r.positions, dates: new Map(w.games.map((g) => [g.date, g.w])), active: r.active };
  };
  const base = a.me.rows.map(toRow);
  const byName = (n) => {
    const h = resolvePlayer(n, snapshot.players);
    if (h.status !== "matched")
      throw new Error(`daily: "${n}" ${h.status === "ambiguous" ? "could be more than one player" : "was not found"}`);
    return h.player.id;
  };
  const idsOf = (list) => new Map((list ?? []).map((x) => [byName(x.name), new Set(x.days ?? days)]));
  const starts = idsOf(d.start), benches = idsOf(d.bench);
  for (const x of [...starts.values(), ...benches.values()])
    for (const day of x)
      if (day < days[0] || day > weekEnd)
        throw new Error(`daily: ${day} is outside the days left (${days[0]} to ${weekEnd})`);
  const BIG = 1e6;
  const pickDay = (rows, day) => {
    const avail = rows.filter((r) => r.active && (r.dates.get(day) ?? 0) > 0 && !benches.get(r.entry.id)?.has(day)).map((r) => ({ r, value: r.entry.value + (starts.get(r.entry.id)?.has(day) ? BIG : 0), positions: r.positions, games: r.dates.get(day) }));
    return assignLineup(avail, a.lineupSlots);
  };
  const evaluate = (rows, weeks, fullGames2) => {
    let tot = a.engine.empty(), games = 0;
    for (const day of days) {
      const picks = pickDay(rows, day);
      tot = a.engine.plus(tot, a.engine.dayTotals(picks.map((p) => ({ entry: p.player.r.entry, weight: p.player.r.dates.get(day), positions: p.player.r.positions, name: p.player.r.entry.name }))));
      games += picks.reduce((s, p) => s + p.player.r.dates.get(day), 0);
    }
    const share = fullGames2 > 0 ? Math.min(1, games / fullGames2) : 1;
    return { win: a.engine.win(tot, share, weeks), share, games };
  };
  const fullGames = (() => {
    let g = 0;
    for (let x = a.weekStart;x <= weekEnd; x = addDays(x, 1))
      g += pickDay(base, x).reduce((s, p) => s + p.player.r.dates.get(x), 0);
    return g;
  })();
  const baseEval = evaluate(base, a.weeks, fullGames);
  const lineup_by_day = days.map((date) => {
    const picks = pickDay(base, date);
    const in_ = new Set(picks.map((p) => p.player.r));
    return {
      date,
      starters: picks.map((p) => ({ name: p.player.r.entry.name, ...p.slot ? { slot: p.slot } : {} })),
      bench_with_game: base.filter((r) => r.active && (r.dates.get(date) ?? 0) > 0 && !in_.has(r)).map((r) => r.entry.name)
    };
  });
  const out = {
    from: days[0],
    days,
    baseline_week_win_pct: Math.round(baseEval.win * 100),
    share_left: Math.round(baseEval.share * 100) / 100,
    rough: baseEval.share < 1 / 3,
    lineup_by_day,
    notes
  };
  if (out.rough)
    notes.push("Less than a third of the lineup's games are left. Luck was measured on whole weeks and scaled down for the part left, so these numbers are rougher.");
  if (starts.size > 0 || benches.size > 0) {
    const savedS = new Map(starts), savedB = new Map(benches);
    starts.clear();
    benches.clear();
    const plain = evaluate(base, a.weeks, fullGames).win;
    for (const [k, v] of savedS)
      starts.set(k, v);
    for (const [k, v] of savedB)
      benches.set(k, v);
    out.changes = [{ label: "your starts and benches", week_win_pct: Math.round(baseEval.win * 100), delta_points: Math.round((baseEval.win - plain) * 1000) / 10 }];
    out.baseline_week_win_pct = Math.round(plain * 100);
    notes.push("baseline_week_win_pct is the best lineup each day with no forced starts or benches; the change shown is what your starts and benches do to it.");
  }
  if (d.stream) {
    const s = d.stream;
    if (!Array.isArray(s.candidates) || s.candidates.length === 0)
      throw new Error("daily.stream.candidates must list at least one available player");
    const ref = starts.size === 0 && benches.size === 0 ? baseEval.win : evaluate(base, a.weeks, fullGames).win;
    const quick = Math.min(a.weeks, 2500);
    const drops = [...base.filter((r) => r.active), ...s.open_spot ? [null] : []];
    const found = [];
    for (const c of s.candidates) {
      const h = resolvePlayer(c.name, snapshot.players);
      if (h.status !== "matched") {
        notes.push(`WARNING: streaming candidate "${c.name}" ${h.status === "ambiguous" ? "could be more than one player" : "was not found"}; skipped.`);
        continue;
      }
      const e = a.estimated.get(h.player.id);
      if (!e || base.some((r) => r.entry.id === e.id))
        continue;
      const w = gameWeights(snapshot, e.team, a.weekStart, a.gamesFor(e.team), undefined);
      const row = { entry: e, positions: parsePositions(c.positions), dates: new Map(w.games.filter((g) => g.date >= days[0]).map((g) => [g.date, 1])), active: true };
      if (row.dates.size === 0)
        continue;
      let best = null;
      for (const drop of drops) {
        const rows = base.filter((r) => r !== drop).concat(row);
        const win = evaluate(rows, quick, fullGames).win;
        if (!best || win > best.win)
          best = { drop, win };
      }
      if (best)
        found.push({ c: row, ...best });
    }
    found.sort((x, y) => y.win - x.win);
    const top = found.slice(0, s.top ?? 5).map((f) => {
      const rows = base.filter((r) => r !== f.drop).concat(f.c);
      const win = evaluate(rows, a.weeks, fullGames).win;
      return { add: f.c.entry.name, drop: f.drop ? f.drop.entry.name : null, days_played: [...f.c.dates.keys()].sort(), win };
    }).sort((x, y) => y.win - x.win);
    out.streaming = {
      ...s.adds_left !== undefined ? { adds_left: s.adds_left } : {},
      moves: top.map((f) => ({
        add: f.add,
        drop: f.drop,
        days_played: f.days_played,
        week_win_pct: Math.round(f.win * 100),
        delta_points: Math.round((f.win - ref) * 1000) / 10,
        addable: s.adds_left === undefined || s.adds_left > 0
      }))
    };
    notes.push("A streamer is added now and kept for the rest of the week; dropping him again, and the add that takes, are not modelled. Positions are checked only when the league has slots and you gave them.");
    if (s.adds_left === 0)
      notes.push("You have no adds left this week: these are shown for information only.");
  }
  return out;
}

// src/sideutil.ts
var rampOf = (r) => r === false ? null : r ?? DEFAULT_RAMP;
function scenarioAvailability(s, firstDay, ramp) {
  const outFrom = s.out_from ?? firstDay;
  const back = s.returns ?? (s.out_until ? addDays(s.out_until, 1) : null);
  const rp = s.ramp === false ? null : s.ramp ?? rampOf(ramp);
  return { outFrom, returnDate: back, ...rp && back ? { ramp: rp } : {} };
}
function resolveSide(list, label, side, ctx) {
  const names = [];
  const rows = [];
  const scenarioById = new Map;
  for (const s of ctx.scenarios) {
    if ((s.side ?? "you") !== side)
      continue;
    const h = resolvePlayer(s.name, ctx.snapshot.players);
    if (h.status === "matched")
      scenarioById.set(h.player.id, s);
    else
      ctx.assumptions.push(`WARNING: scenario for "${s.name}" ignored: ${h.status === "ambiguous" ? "could be more than one player" : "not found"}.`);
  }
  const firstDay = ctx.weekStart ?? ctx.asOf;
  const windowStart = ctx.weekStart && ctx.asOf > ctx.weekStart ? ctx.asOf : firstDay;
  for (const r of list) {
    const hit = resolvePlayer(r.name, ctx.snapshot.players);
    if (hit.status === "ambiguous") {
      names.push({ input: r.name, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
      continue;
    }
    if (hit.status !== "matched") {
      names.push({ input: r.name, status: "not_found" });
      continue;
    }
    names.push({ input: r.name, status: "matched", matched: hit.player.name });
    const e = ctx.estimated.get(hit.player.id);
    if (!e)
      continue;
    const scen = scenarioById.get(hit.player.id);
    const host = availabilityFromHost(r.injury, r.return_date, windowStart, rampOf(ctx.ramp));
    const av = scen ? scenarioAvailability(scen, windowStart, ctx.ramp) : host.av;
    const teamGames = ctx.gamesFor(e.team);
    let games = teamGames, lost = 0, note;
    if (av && ctx.weekStart) {
      const g = gamesWithAvailability(ctx.snapshot, e.team, ctx.weekStart, teamGames, av);
      games = g.games;
      lost = Math.max(0, teamGames - g.games);
      if (g.approximate)
        ctx.assumptions.push(`${hit.player.name}: the data has no day-by-day schedule, so his games lost are spread evenly over the week (approximate).`);
    } else if (av)
      ctx.assumptions.push(`${hit.player.name}: no schedule for this week, so his injury window is not applied.`);
    if (scen)
      note = `YOUR ASSUMPTION (not a measured fact): ${scen.returns ? `back ${scen.returns}` : scen.out_until ? `out through ${scen.out_until}` : "out for the week"}${av?.ramp ? `, output ${Math.round(av.ramp.share * 100)}% for his first ${av.ramp.games} games back (also an assumption)` : ""}`;
    else if (host.flag)
      note = host.flag;
    const left = ctx.leftFor ? teamGames > 0 ? ctx.leftFor(e.team) * (games / teamGames) : 0 : 0;
    rows.push({ entry: e, positions: parsePositions(r.positions), games, left, active: r.status !== "IL", lost, note, av });
  }
  const missing = names.filter((n) => n.status !== "matched").length;
  if (missing > 0)
    ctx.assumptions.push(`${missing} player(s) in the ${label} roster could not be matched and are left out of the weekly totals.`);
  const active = rows.filter((x) => x.active);
  const seatable = active.map((x) => ({ x, value: x.entry.value, positions: x.positions, games: x.games }));
  const best = pickLineup(seatable, ctx.slots).map((s) => s.x);
  let chosen = best, recommended;
  if (ctx.lineup && ctx.lineup.length > 0) {
    const ids = new Set;
    for (const n of ctx.lineup) {
      const h = resolvePlayer(n, ctx.snapshot.players);
      if (h.status === "matched")
        ids.add(h.player.id);
      else
        ctx.assumptions.push(`WARNING: lineup player "${n}" ${h.status === "ambiguous" ? "could be more than one player" : "was not found"}; left out of your lineup.`);
    }
    const mine = active.filter((x) => ids.has(x.entry.id)).sort((a, b) => b.entry.value - a.entry.value);
    if (mine.length > slotCount(ctx.slots))
      throw new Error(`matchup.lineup lists ${mine.length} players but the league has ${slotCount(ctx.slots)} lineup slots`);
    if (typeof ctx.slots !== "number") {
      const seated = assignLineup(mine.map((x) => ({ x, value: x.entry.value, positions: x.positions })), ctx.slots);
      if (seated.length < mine.length)
        throw new Error(`matchup.lineup cannot be seated in the league's slots: ${mine.filter((x) => !seated.some((s) => s.player.x === x)).map((x) => x.entry.name).join(", ")} fit no open slot`);
    }
    chosen = mine;
    if (best.length !== mine.length || best.some((b) => !mine.includes(b)))
      recommended = best;
  }
  const slotOf = new Map;
  if (typeof ctx.slots !== "number")
    for (const a of assignLineup(chosen.map((x) => ({ x, value: x.entry.value, positions: x.positions })), ctx.slots))
      slotOf.set(a.player.x, a.slot);
  const counted = new Set(chosen);
  const playerRows = rows.map((x) => ({
    name: x.entry.name,
    team: x.entry.team ?? null,
    games: Math.round(x.games * 100) / 100,
    ...ctx.leftFor ? { games_left: Math.round(x.left * 100) / 100 } : {},
    counted: counted.has(x),
    ...slotOf.has(x) ? { slot: slotOf.get(x) } : {},
    ...x.active ? {} : { status: "IL" },
    ...x.lost > 0 ? { games_lost: Math.round(x.lost * 100) / 100 } : {},
    ...x.note ? { note: x.note } : {}
  })).sort((a, b) => Number(b.counted) - Number(a.counted) || b.games - a.games);
  return { names, rows, chosen, recommended, slotOf, playerRows };
}

// src/baseline.ts
function std(xs, mean) {
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}
var avg2 = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function buildBaseline(players, poolSize) {
  const pool = [...players].sort((a, b) => b.gp * b.mpg - a.gp * a.mpg).slice(0, poolSize);
  if (pool.length === 0)
    throw new Error("buildBaseline: no players");
  const col = (f) => pool.map(f);
  const pts = col((p) => p.averages.pts), reb = col((p) => p.averages.reb), ast = col((p) => p.averages.ast);
  const stl = col((p) => p.averages.stl), blk = col((p) => p.averages.blk), fg3m = col((p) => p.averages.fg3m);
  const fgp = col((p) => p.averages.fg_pct), ftp = col((p) => p.averages.ft_pct), tov = col((p) => p.averages.turnovers);
  const m = {
    m_pts: avg2(pts),
    m_reb: avg2(reb),
    m_ast: avg2(ast),
    m_stl: avg2(stl),
    m_blk: avg2(blk),
    m_fg3m: avg2(fg3m),
    m_fg_pct: avg2(fgp),
    m_ft_pct: avg2(ftp),
    m_tov: avg2(tov)
  };
  const fgImpact = pool.map((p) => (p.averages.fg_pct - m.m_fg_pct) * p.averages.fga);
  const ftImpact = pool.map((p) => (p.averages.ft_pct - m.m_ft_pct) * p.averages.fta);
  return {
    means: m,
    stds: {
      s_pts: std(pts, m.m_pts),
      s_reb: std(reb, m.m_reb),
      s_ast: std(ast, m.m_ast),
      s_stl: std(stl, m.m_stl),
      s_blk: std(blk, m.m_blk),
      s_fg3m: std(fg3m, m.m_fg3m),
      s_tov: std(tov, m.m_tov),
      s_fg_imp: std(fgImpact, avg2(fgImpact)),
      s_ft_imp: std(ftImpact, avg2(ftImpact))
    }
  };
}
var BLEND_K = 40;
function blendWeight(teamGames, k = BLEND_K) {
  return Number.isFinite(teamGames) && teamGames > 0 ? teamGames / (teamGames + k) : 0;
}
function blendBaselines(last, current, w) {
  const mix = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, (1 - w) * a[k] + w * b[k]]));
  return { means: mix(last.means, current.means), stds: mix(last.stds, current.stds) };
}

// src/history.ts
var RECENCY_WEIGHTS = [1, 0.6, 0.3];
var GAMES_CAP = 65;
var CURRENT_MIN_GAMES = 5;
var CONFIDENCE_MIN = { high: 100, medium: 50 };
var FIELDS = [
  "pts",
  "reb",
  "ast",
  "stl",
  "blk",
  "fg3m",
  "fg_pct",
  "ft_pct",
  "turnovers",
  "fga",
  "fta"
];
var MADE = ["fgm", "ftm", "oreb", "dreb", "pf", "fg3a", "dd_rate", "td_rate", "min"];
function seasonLabel(startYear) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
function startYear(season) {
  return Number(season.slice(0, 4));
}
function estimateAverages(h, reference, opts = {}) {
  const recency = opts.recency ?? RECENCY_WEIGHTS;
  const cap = opts.gamesCap ?? GAMES_CAP;
  const ref = startYear(reference);
  const acc = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let wSum = 0;
  const made = Object.fromEntries(MADE.map((f) => [f, { acc: 0, w: 0 }]));
  const used = [];
  recency.forEach((r, back) => {
    const label = seasonLabel(ref - back);
    const s = h.seasons.find((x) => x.season === label);
    if (!s || !(s.gp > 0))
      return;
    const w = r * Math.min(s.gp, cap);
    for (const f of FIELDS)
      acc[f] += w * s.averages[f];
    for (const f of MADE) {
      const v = f === "min" ? s.mpg > 0 ? s.mpg : undefined : s.averages[f];
      if (typeof v === "number") {
        made[f].acc += w * v;
        made[f].w += w;
      }
    }
    wSum += w;
    used.push(label);
  });
  if (wSum === 0) {
    const cur = opts.current ? h.seasons.find((x) => x.season === opts.current) : undefined;
    if (cur && cur.gp >= CURRENT_MIN_GAMES) {
      const games = Math.min(cur.gp, cap);
      const confidence2 = games >= CONFIDENCE_MIN.high ? "high" : games >= CONFIDENCE_MIN.medium ? "medium" : "low";
      return { averages: { ...cur.averages }, confidence: confidence2, effectiveGames: games, seasonsUsed: [cur.season], currentSeasonOnly: true };
    }
    return { averages: null, confidence: "none", effectiveGames: 0, seasonsUsed: [] };
  }
  const averages = Object.fromEntries(FIELDS.map((f) => [f, acc[f] / wSum]));
  for (const f of MADE)
    if (made[f].w > 0)
      averages[f] = made[f].acc / made[f].w;
  const confidence = wSum >= CONFIDENCE_MIN.high ? "high" : wSum >= CONFIDENCE_MIN.medium ? "medium" : "low";
  return { averages, confidence, effectiveGames: wSum, seasonsUsed: used };
}

// src/banked.ts
var ATTEMPTS_ESTIMATE_NOTE = "Banked attempts are estimated (each counted player's per-game attempts x team games already played, from the game counts you gave), then turned into made shots with the percentage you gave. " + "Measured on 2025-26 weeks: this overstates banked field-goal attempts by about 16% (typical miss 15%) and free-throw attempts by about 28% (typical miss 24%), because rest days and short absences are not known; " + "the effect on the week's final FG% is typically under 0.1 points and on FT% about 0.2 points (9 weeks in 10 within 0.4 and 1.0). Give made and attempted counts if the host shows them to make it exact.";
var FRESH_WEEK_NOTE = "The live score was not usable (the host gave neither made/attempted shots nor FG% and FT%, or other banked stats were missing), so this is a FRESH-WEEK estimate: the whole week is simulated from 0-0 and ignores what has already happened.";
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
var asFraction = (p) => p > 1 ? p / 100 : p;
function shotRoute(side, kind) {
  const made = side?.[`${kind}m`], att = side?.[`${kind}a`], pct = side?.[`${kind}_pct`];
  if (isNum(made) && isNum(att))
    return "exact";
  if (isNum(pct) && pct >= 0 && pct <= 100)
    return "estimated";
  return "missing";
}
function liveScoreOf(sides, need) {
  let label = "exact";
  for (const s of sides)
    for (const k of ["fg", "ft"]) {
      if (!need[k])
        continue;
      const r = shotRoute(s, k);
      if (r === "missing")
        return "fresh-week";
      if (r === "estimated")
        label = "estimated";
    }
  return label;
}
function bankedShooting(side, played) {
  const one = (kind, att) => {
    if (shotRoute(side, kind) === "exact")
      return [side[`${kind}m`], side[`${kind}a`]];
    const pct = side[`${kind}_pct`];
    return isNum(pct) ? [asFraction(pct) * att, att] : [0, 0];
  };
  const [fgm, fga] = one("fg", played.fga), [ftm, fta] = one("ft", played.fta);
  return { fgm, fga, ftm, fta };
}

// src/analyzeAny.ts
var band = (p) => p >= 85 ? "elite" : p >= 60 ? "strong" : p >= 40 ? "neutral" : "weak";
var OPTIONAL_FIELD = { fg3a: "fg3a", oreb: "oreb", dreb: "dreb", pf: "pf", dd: "dd_rate", td: "td_rate" };
function requireData(snapshot, codes) {
  for (const k of neededStats(codes)) {
    const f = OPTIONAL_FIELD[k];
    if (f && !snapshot.players.some((p) => p.seasons.some((s) => s.averages[f] !== undefined)))
      throw new Error(`the data file has no ${f} yet, which this league's categories need. It is added by the nightly update; try again after it runs.`);
  }
}
function mixBaseline(a, b, w) {
  return Object.fromEntries(Object.keys(a).map((c) => {
    const x = a[c], y = b[c];
    return [c, { mean: (1 - w) * x.mean + w * y.mean, std: (1 - w) * x.std + w * y.std, ...x.ratio !== undefined ? { ratio: (1 - w) * x.ratio + w * (y.ratio ?? x.ratio) } : {} }];
  }));
}
function estimateAll(snapshot, reference, current, valueOf) {
  const out = new Map;
  for (const p of snapshot.players) {
    const e = estimateAverages(historyOf(p), reference, { current });
    if (!e.averages)
      continue;
    const base = baseOf(e.averages, []);
    out.set(p.id, { id: p.id, name: p.name, averages: e.averages, team: p.team, value: valueOf(base), confidence: e.confidence, effectiveGames: e.effectiveGames, base });
  }
  return out;
}
var engineFor = (codes, weights) => ({
  codes,
  totals: (list, gamesOf, slots) => anyTotals(list.map((p) => ({ base: p.base, games: gamesOf(p), value: p.value, positions: p.positions })), slots),
  simulate: (me, opps, o) => {
    if (weights)
      return { weekWin: simulatePoints(me, opps, weights, o).weekWin, categories: Object.fromEntries(codes.map((c) => [c, 0])) };
    const r = simulateAny(me, opps, codes, o);
    return { weekWin: r.weekWin, categories: r.categories };
  }
});
function analyzeAny(input, snapshotIn, codes, weights) {
  const snapshot = withScheduleDays(input, snapshotIn);
  const { teams, roster_spots } = input.league;
  requireData(snapshot, codes);
  const reference = input.reference ?? snapshot.reference_season;
  const current = seasonLabel(startYear(reference) + 1);
  const poolSize = teams * roster_spots;
  const seasonPool = (season) => {
    const out2 = [];
    for (const p of snapshot.players) {
      const s = p.seasons.find((x) => x.season === season);
      if (s && s.mpg > 0 && s.gp > 0)
        out2.push({ base: baseOf({ ...s.averages, min: s.mpg }, []), gp: s.gp, mpg: s.mpg });
    }
    return out2;
  };
  const refPool = seasonPool(reference), curPool = seasonPool(current);
  if (refPool.length < poolSize)
    throw new Error(`snapshot has only ${refPool.length} players for ${reference}; need at least ${poolSize}`);
  let baseline = weights ? {} : buildAnyBaseline(refPool, codes, poolSize);
  const teamGames = input.team_games ?? curPool.reduce((m, p) => Math.max(m, p.gp), 0);
  const w = !weights && curPool.length >= poolSize ? blendWeight(teamGames) : 0;
  if (w > 0)
    baseline = mixBaseline(baseline, buildAnyBaseline(curPool, codes, poolSize), w);
  const valueOf = weights ? (b) => pointsOf(weights, b) : (b) => anyValue(b, codes, baseline);
  const estimated = estimateAll(snapshot, reference, current, valueOf);
  const pool = [...estimated.values()].sort((a, b) => b.value - a.value);
  if (pool.length < poolSize)
    throw new Error(`snapshot has only ${pool.length} players; need at least ${poolSize}`);
  const engine = engineFor(codes, weights);
  const seed = input.seed ?? 1;
  const assumptions = [
    weights ? `This is a head-to-head points league. Points = ${Object.entries(weights).map(([c, x]) => `${x} x ${c}`).join(" + ")}. Players are valued, and typical opponents drafted, on fantasy points per game; the side with more points in the week wins.` : `This league scores ${codes.join(", ")}. Players are valued, and typical opponents drafted, on those categories only.`,
    `Players are estimated from their last three seasons, weighted by recency and games played. Positions are ignored. Week-to-week luck was measured on 2025-26 weekly results for each base stat (made and attempted shots, rebounds by kind, assists, steals, blocks, turnovers, fouls, minutes); double-doubles and triple-doubles are sampled game by game from each player's own rate.`,
    ...w > 0 ? [`League baseline: ${Math.round((1 - w) * 100)}% ${reference}, ${Math.round(w * 100)}% ${current} (season blend after ${teamGames} games).`] : []
  ];
  const scheduleWeek = (start) => scheduleWeeks(snapshot).find((x) => x.start === start);
  const gamesIn = (games) => (team) => games && team ? games[team] ?? 0 : DEFAULT_WEEK_GAMES;
  const names = [];
  const thisMonday = mondayOf(snapshot.generated_at);
  const wk0 = scheduleWeek(thisMonday);
  const set0 = lineupSetting(input, input.matchup?.lineup_slots ?? input.waiver?.lineup_slots ?? input.trade?.lineup_slots);
  const slots0 = set0.slots;
  const myEntries = resolveList(input.roster, snapshot, estimated, names);
  const typical0 = typicalAnyOpponents(pool, { teams, rosterSpots: roster_spots }, slots0, gamesIn(wk0?.games ?? null), { leagues: 300, seed });
  const mine0 = anyTotals(myEntries.map((e) => ({ base: e.base, games: gamesIn(wk0?.games ?? null)(e.team), value: e.value, positions: e.positions })), set0.slotList ?? slots0);
  const ranking = weights ? [] : codes.map((c) => {
    const mineV = categoryValue(c, mine0.t);
    const worse = typical0.filter((o) => isLowerCategory(c) ? categoryValue(c, o.t) > mineV : categoryValue(c, o.t) < mineV).length;
    const percentile = Math.round(100 * worse / typical0.length);
    return { category: c, band: band(percentile), percentile };
  }).sort((a, b) => b.percentile - a.percentile);
  const out = {
    custom_categories: true,
    categories_used: codes,
    snapshot: { generated_at: snapshot.generated_at, reference_season: snapshot.reference_season },
    league: input.league,
    names,
    ranking,
    assumptions,
    warnings: []
  };
  if (weights) {
    const mine = pointsOf(weights, mine0.t);
    const percentile = Math.round(100 * typical0.filter((o) => pointsOf(weights, o.t) < mine).length / typical0.length);
    out.points = { weights, expected_week_points: Math.round(mine * 10) / 10, percentile, band: band(percentile) };
  }
  if (input.matchup)
    out.matchup = runAnyMatchup(input, snapshot, codes, estimated, pool, engine, wk0, thisMonday, weights);
  if (input.waiver || input.trade) {
    const st = anyMoveSetup(input, snapshot, codes, estimated, pool, engine, seed);
    if (input.waiver)
      out.waiver = waiverWith(input, snapshot, st);
    if (input.trade)
      out.trade = tradeWith(input, snapshot, st);
  }
  out.warnings = leftOutWarnings([out.names, out.matchup?.names, out.waiver?.names, out.trade?.names]);
  return out;
}
function anyMoveSetup(input, snapshot, codes, estimated, pool, engine, seed) {
  const { teams, roster_spots } = input.league;
  const common = input.waiver ?? input.trade;
  const { slots, slotList } = lineupSetting(input, common.lineup_slots);
  const horizon = Math.max(1, Math.min(4, common.horizon_weeks ?? 2));
  const simWeeks = common.weeks ?? 6000;
  const replacement = pool[teams * roster_spots - 1];
  const first = mondayOf(snapshot.generated_at);
  const scheduled = scheduleWeeks(snapshot).filter((x) => x.start >= first).slice(0, horizon);
  const assumptions = [`Categories scored: ${codes.join(", ")}.`];
  const mk = (start, games) => {
    const gamesFor = (team) => games && team ? games[team] ?? 0 : DEFAULT_WEEK_GAMES;
    const gamesOf = (e) => e.avail && start && games ? gamesWithAvailability(snapshot, e.team, start, gamesFor(e.team), e.avail).games : gamesFor(e.team);
    return { start, gamesFor, gamesOf, opponents: typicalAnyOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 150, seed }) };
  };
  const weeks = scheduled.length > 0 ? scheduled.map((x) => mk(x.start, x.games)) : [mk(null, null)];
  const gamesSource = scheduled.length > 0 ? "schedule" : "assumed";
  for (const x of scheduled)
    if (x.tbd_slots)
      assumptions.push(`WARNING: ${x.tbd_slots} game slot(s) in the week of ${x.start} are still "TBD" in the NBA schedule, so some teams' game counts may be too low.`);
  assumptions.push(gamesSource === "schedule" ? `Averaged over ${weeks.length} week(s) starting ${weeks[0].start}, counting each player's real games from the NBA schedule.` : `No schedule in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`, `Each score is a weekly win chance (more categories won than lost) against typical opponents (${weeks[0].opponents.length} teams from simulated ${teams}-team drafts on this league's categories, positions ignored for them), ${simWeeks} simulated weeks with a fixed seed. ` + `A move is scored by re-running the same weeks with the roster changed. Injuries, rest days and lineup moves during the week are not modelled (except an injury status read from the league page). An empty lineup spot is filled by a replacement-level player.` + (slotList ? ` Your lineup uses the league's slots (${slotList.join(" ")}); each week the best-fitting lineup is used.` : ""));
  const env = { slots, ...slotList ? { slotList } : {}, weeks, simWeeks, seed, replacement, engine };
  return { env, estimated, weeksUsed: weeks.map((x) => x.start ?? "assumed"), gamesSource, scheduleIncomplete: scheduled.some((x) => (x.tbd_slots ?? 0) > 0), assumptions };
}
var ZERO_BASE = () => ({
  minutes: 0,
  fgm: 0,
  fga: 0,
  ftm: 0,
  fta: 0,
  fg3m: 0,
  fg3a: 0,
  oreb: 0,
  dreb: 0,
  ast: 0,
  stl: 0,
  blk: 0,
  turnovers: 0,
  pf: 0,
  dd: 0,
  td: 0
});
function runAnyMatchup(input, snapshot, codes, estimated, pool, engine, wk0, thisMonday, weights) {
  const m = input.matchup;
  const { teams, roster_spots } = input.league;
  const { slots, slotList } = lineupSetting(input, m.lineup_slots, "matchup.lineup_slots");
  const lineupSlots = slotList ?? slots;
  const assumptions = [];
  const sfIn = m.so_far;
  const need = weights ? [] : neededStats(codes);
  const needShots = { fg: need.includes("fgm") || need.includes("fga"), ft: need.includes("ftm") || need.includes("fta") };
  const needOther = need.filter((k) => !["fgm", "fga", "ftm", "fta"].includes(k));
  if (sfIn) {
    if (!m.opponent || m.opponent.length === 0)
      throw new Error("matchup.so_far needs a real matchup.opponent");
    if (sfIn.games_left) {
      for (const [t, n] of Object.entries(sfIn.games_left))
        if (!(Number.isInteger(n) && n >= 0 && n <= 7))
          throw new Error(`matchup.so_far.games_left: ${t} must be a whole number of games from 0 to 7`);
    } else if (!(sfIn.remaining_share >= 0 && sfIn.remaining_share <= 1))
      throw new Error("matchup.so_far needs games_left, or remaining_share between 0 and 1");
    if (weights) {
      for (const side of [sfIn.you, sfIn.opponent])
        if (!(typeof side?.points === "number"))
          throw new Error("matchup.so_far: points must be a number for both sides (this is a points league)");
    }
    for (const side of [sfIn.you, sfIn.opponent])
      for (const k of ["fgm", "fga", "ftm", "fta"])
        if (side?.[k] !== undefined && !(typeof side[k] === "number" && side[k] >= 0))
          throw new Error(`matchup.so_far: ${k} must be a number of 0 or more`);
  }
  const otherOk = sfIn ? [sfIn.you, sfIn.opponent].every((side) => needOther.every((k) => typeof side?.[k] === "number" && side[k] >= 0) && (!weights || typeof side?.points === "number")) : false;
  const liveScore = sfIn && otherOk ? liveScoreOf([sfIn.you, sfIn.opponent], needShots) : "fresh-week";
  const sf = liveScore === "fresh-week" ? undefined : sfIn;
  if (sfIn && !sf)
    assumptions.push(FRESH_WEEK_NOTE);
  const weekStart = m.week_start ?? thisMonday;
  const week = scheduleWeeks(snapshot).find((x) => x.start === weekStart) ?? (weekStart === thisMonday ? wk0 : undefined);
  const gamesFor = (team) => week && team ? week.games[team] ?? 0 : DEFAULT_WEEK_GAMES;
  const tbd = week?.tbd_slots ?? 0;
  if (tbd > 0)
    assumptions.push(`WARNING: ${tbd} game slot(s) in the week of ${weekStart} are still "TBD" in the NBA schedule, so some teams' game counts may be too low. Treat these numbers as rougher.`);
  assumptions.push(week ? `Games per player come from the NBA schedule for the week of ${weekStart}. Injuries and rest days are not modelled.` : `No schedule for the week of ${weekStart} in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`);
  const leftFor = (team) => sf?.games_left && team ? sf.games_left[team] ?? 0 : 0;
  const ctx = {
    snapshot,
    estimated,
    gamesFor,
    weekStart: week ? weekStart : null,
    asOf: asOfOf(input, snapshot),
    ramp: input.ramp,
    scenarios: m.scenarios ?? [],
    slots: lineupSlots,
    ...sf?.games_left ? { leftFor } : {},
    assumptions
  };
  const toAny = (r2, games) => r2.chosen.map((x) => ({ base: x.entry.base, games: games(x), value: x.entry.value, positions: x.positions }));
  const sideOf = (list, label, side, lineup) => {
    const res = resolveSide(list, label, side, { ...ctx, ...lineup ? { lineup } : {} });
    const players = toAny(res, (x) => x.games);
    const totals = anyTotals(players, lineupSlots);
    let remaining = totals, share = 1;
    if (sf) {
      if (!sf.games_left) {
        remaining = scaledAny(totals, sf.remaining_share);
        share = sf.remaining_share;
      } else {
        remaining = anyTotals(toAny(res, (x) => x.left), lineupSlots);
        const full = res.chosen.reduce((s, x) => s + x.games, 0), rest = res.chosen.reduce((s, x) => s + x.left, 0);
        share = full > 0 ? Math.min(1, rest / full) : 1;
      }
    }
    let banked;
    if (sf) {
      const given = side === "you" ? sf.you : sf.opponent;
      const playedGames = sf.games_left ? (x) => Math.max(0, x.games - x.left) : (x) => x.games * (1 - sf.remaining_share);
      const played = anyTotals(toAny(res, playedGames), lineupSlots).t;
      const { fg_pct: _a, ft_pct: _b, ...rest } = given;
      banked = { ...rest, ...bankedShooting(given, { fga: played.fga, fta: played.fta }) };
    }
    return { totals, remaining, share, names: res.names, rows: res.playerRows, res, banked };
  };
  const me = sideOf(input.roster, "your", "you", m.lineup);
  let opponents;
  let names = me.names;
  let opp;
  if (m.opponent && m.opponent.length > 0) {
    const o = opp = sideOf(m.opponent, "opponent", "opponent");
    opponents = [o.totals];
    names = [...me.names, ...o.names.map((n) => ({ ...n, input: `${n.input} (opponent)` }))];
  } else {
    opponents = typicalAnyOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 300, seed: input.seed ?? 1 });
    assumptions.push(`Typical opponents: ${opponents.length} teams from 300 simulated ${teams}-team drafts on this league's categories, each playing its best ${slots} players. Positions are ignored for them${slotList ? "; your team uses the league's real slots" : ""}.`);
  }
  const weeks = m.weeks ?? DEFAULT_WEEKS;
  const bank = (b) => ({ ...ZERO_BASE(), ...Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === "number")) });
  const simOpts = { weeks, seed: input.seed ?? 1, slots };
  const simulate = (totals, remaining, share, n = weeks) => {
    const o = { ...simOpts, weeks: n };
    if (weights) {
      const pp = sf && opp ? { me: { banked: sf.you.points, remaining, share }, opponent: { banked: sf.opponent.points, remaining: opp.remaining, share: opp.share } } : undefined;
      const pr2 = simulatePoints(totals, opponents, weights, { ...o, ...pp ? { progress: pp } : {} });
      return { weekWin: pr2.weekWin, weekTie: pr2.weekTie, weekLoss: pr2.weekLoss, categories: {}, distribution: [], pr: pr2 };
    }
    const progress = sf && opp ? { me: { banked: bank(me.banked), remaining, share }, opponent: { banked: bank(opp.banked), remaining: opp.remaining, share: opp.share } } : undefined;
    return { ...simulateAny(totals, opponents, codes, { ...o, ...progress ? { progress } : {} }), pr: undefined };
  };
  const r = simulate(me.totals, me.remaining, me.share);
  const pr = r.pr;
  let recommended;
  if (me.res.recommended) {
    const alt = resolveSide(input.roster, "your", "you", { ...ctx, assumptions: [] });
    const altTotals = anyTotals(toAny(alt, (x) => x.games), lineupSlots);
    let altRemaining = altTotals, altShare = 1;
    if (sf) {
      if (!sf.games_left) {
        altRemaining = scaledAny(altTotals, sf.remaining_share);
        altShare = sf.remaining_share;
      } else {
        altRemaining = anyTotals(toAny(alt, (x) => x.left), lineupSlots);
        const full = alt.chosen.reduce((s, x) => s + x.games, 0), rest = alt.chosen.reduce((s, x) => s + x.left, 0);
        altShare = full > 0 ? Math.min(1, rest / full) : 1;
      }
    }
    const ra = simulate(altTotals, altRemaining, altShare);
    recommended = { players: alt.chosen.map((x) => ({ name: x.entry.name, ...alt.slotOf.has(x) ? { slot: alt.slotOf.get(x) } : {} })), week_win_pct: Math.round(ra.weekWin * 100) };
    assumptions.push("Your lineup is not the best fit for the slots by this model. The recommendation is shown with its win chance; the numbers above use the lineup you gave.");
  }
  if (sf)
    assumptions.push(sf.games_left ? `The week is under way: stats already banked are kept, and the games still to play (your lineup has ${Math.round(me.share * 100)}% of its week left, theirs ${Math.round(opp.share * 100)}%) are simulated from each player's own team games left. Games in progress or already counted by the league site must not be in the games left.` : `The week is under way: stats already banked are kept, and the remaining ${Math.round(sf.remaining_share * 100)}% of each team's games are simulated. Every player is assumed to have that same share of his week left, which is rough when a team's games are lopsided.`);
  if (liveScore === "estimated") {
    const madeCount = neededStats(codes.filter((c) => c !== "FG%" && c !== "FT%")).some((k) => k === "fgm" || k === "ftm");
    assumptions.push(`LIVE SCORE ESTIMATED: ${ATTEMPTS_ESTIMATE_NOTE}${madeCount ? " Points and made-shot categories in this league are counted from those estimated made shots, so they are rougher than the other banked stats." : ""}`);
  }
  const availabilityApplied = [...me.res.rows, ...opp?.res.rows ?? []].some((x) => x.lost > 0 || x.av);
  if (availabilityApplied)
    assumptions.push("Some players' games were changed by an injury status read from the league page or by a scenario you gave. Scenarios and a return day are your assumptions, not measured facts; a ramp-up after a return (default 80% output for 3 games) is also an assumption.");
  let daily;
  if (m.daily) {
    if (m.daily.from && m.daily.from > weekStart && !sf)
      throw new Error("matchup.daily.from is later than the week's start: give matchup.so_far with the stats already banked");
    const zero = () => ({ t: ZERO_BASE(), ddGames: [], tdGames: [] });
    const engine2 = {
      empty: zero,
      plus: (x, y) => {
        const o = zero();
        for (const k of Object.keys(o.t))
          o.t[k] = x.t[k] + y.t[k];
        o.ddGames = [...x.ddGames, ...y.ddGames];
        o.tdGames = [...x.tdGames, ...y.tdGames];
        return o;
      },
      dayTotals: (ps) => anyTotals(ps.map((p) => ({ base: p.entry.base, games: p.weight, value: p.entry.value, positions: p.positions })), lineupSlots),
      win: (remaining, share, n) => simulate(sf ? me.totals : remaining, remaining, share, n).weekWin
    };
    daily = runDaily(input, snapshot, m, { me: me.res, weekStart, lineupSlots, weeks, engine: engine2, estimated, gamesFor, asOf: ctx.asOf, hasBanked: Boolean(sf), assumptions });
  }
  assumptions.push(`Week-to-week luck is measured on 2025-26 weekly results after removing game counts. ${weeks} simulated weeks, fixed seed. The simulation does not model ${availabilityApplied ? "other injuries, " : "injuries, "}lineup moves or streaming during the week${daily ? " except in the daily section" : ""}. ${weights ? "The side with more fantasy points wins; equal points are a tie." : "A week is won with more categories than the opponent; equal counts are a tie."}`);
  const pct = (x) => Math.round(x * 100);
  return {
    week_start: week ? weekStart : null,
    games_source: week ? "schedule" : "assumed",
    schedule_incomplete: tbd > 0,
    opponent: m.opponent && m.opponent.length > 0 ? "roster" : "typical",
    lineup_slots: slots,
    weeks,
    so_far_counted: Boolean(sf),
    live_score: liveScore,
    categories_used: codes,
    categories: weights ? {} : Object.fromEntries(codes.map((c) => [c, pct(r.categories[c])])),
    ...pr ? { expected_points: { you: Math.round(pr.expectedMe * 10) / 10, opponent: Math.round(pr.expectedOpponent * 10) / 10, margin: Math.round((pr.expectedMe - pr.expectedOpponent) * 10) / 10 } } : {},
    week_win_pct: pct(r.weekWin),
    week_tie_pct: pct(r.weekTie),
    week_loss_pct: pct(r.weekLoss),
    distribution_pct: r.distribution.map(pct),
    rosters: { you: me.rows, ...opp ? { opponent: opp.rows } : {} },
    lineup_source: m.lineup && m.lineup.length > 0 ? "user" : "recommended",
    ...recommended ? { recommended_lineup: recommended } : {},
    availability_applied: availabilityApplied,
    ...daily ? { daily } : {},
    week_win_prob: r.weekWin,
    week_tie_prob: r.weekTie,
    names,
    assumptions
  };
}

// src/fantasyValue.ts
var ENGINE_VERSION = "0.3.0";
function safeDivide(num, den) {
  return Number.isFinite(den) && den !== 0 && Number.isFinite(num) ? num / den : 0;
}
function categoryZ(a, b) {
  const { means: m, stds: s } = b;
  return {
    PTS: safeDivide(a.pts - m.m_pts, s.s_pts),
    REB: safeDivide(a.reb - m.m_reb, s.s_reb),
    AST: safeDivide(a.ast - m.m_ast, s.s_ast),
    STL: safeDivide(a.stl - m.m_stl, s.s_stl),
    BLK: safeDivide(a.blk - m.m_blk, s.s_blk),
    "3PM": safeDivide(a.fg3m - m.m_fg3m, s.s_fg3m),
    "FG%": safeDivide((a.fg_pct - m.m_fg_pct) * a.fga, s.s_fg_imp),
    "FT%": safeDivide((a.ft_pct - m.m_ft_pct) * a.fta, s.s_ft_imp),
    TO: -safeDivide(a.turnovers - m.m_tov, s.s_tov)
  };
}

// src/assess.ts
var DEFAULT_CUTOFFS = { elite: 85, strong: 60, neutral: 40 };
function bandFor(percentile, cut = DEFAULT_CUTOFFS) {
  if (percentile >= cut.elite)
    return "elite";
  if (percentile >= cut.strong)
    return "strong";
  if (percentile >= cut.neutral)
    return "neutral";
  return "weak";
}
function percentileOf(sortedAsc, x) {
  let below = 0, equal = 0;
  for (const v of sortedAsc) {
    if (v < x)
      below++;
    else if (v === x)
      equal++;
    else
      break;
  }
  return (below + 0.5 * equal) / sortedAsc.length * 100;
}
var at = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p / 100 * xs.length))];
function assessTeam(roster, baseline, benchmark, opts) {
  const cut = opts.cutoffs ?? DEFAULT_CUTOFFS;
  const spots = benchmark.lineupSlots;
  const zero = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const rows = roster.map((r) => {
    const est = estimateAverages(r.history, opts.reference, { current: opts.current });
    const z = est.averages ? categoryZ(est.averages, baseline) : null;
    const status = r.status ?? "active";
    const value = z ? CATEGORIES.reduce((s, c) => s + z[c], 0) : CATEGORIES.reduce((s, c) => s + benchmark.poolMean[c], 0);
    return { r, est, z, status, value };
  });
  const actives = rows.filter((x) => x.status === "active").sort((a, b) => b.value - a.value);
  const counted = new Set(actives.slice(0, spots));
  const assumptions = [];
  const players = rows.map((x) => {
    let note = "";
    if (x.status === "IL")
      note = "On IL: not counted.";
    else if (!counted.has(x))
      note = "Bench: not counted (only your best lineup players count, as in the weekly matchup).";
    else if (x.est.confidence === "none")
      note = "No NBA data (rookie or no recent games): counted as an average rostered player.";
    else if (x.est.currentSeasonOnly)
      note = `No completed NBA seasons: judged on this season only (${x.est.effectiveGames.toFixed(0)} games, ${x.est.seasonsUsed[0]}). Small sample, treat with care.`;
    else if (x.est.confidence === "low")
      note = `Small sample (${x.est.effectiveGames.toFixed(0)} effective games): treat with care.`;
    else if (!x.est.seasonsUsed.includes(opts.reference))
      note = `Estimated from ${x.est.seasonsUsed.join(", ")}; he did not play ${opts.reference}.`;
    return {
      name: x.r.name,
      status: x.status,
      counted: x.status === "active" && counted.has(x),
      confidence: x.est.confidence,
      effectiveGames: x.est.effectiveGames,
      seasonsUsed: x.est.seasonsUsed,
      z: x.z,
      note
    };
  });
  const sums = { ...zero };
  for (const x of actives.slice(0, spots))
    for (const c of CATEGORIES)
      sums[c] += x.z ? x.z[c] : benchmark.poolMean[c];
  if (benchmark.ratesAsRates) {
    const avg3 = benchmark.poolMeanShots;
    const shots = (x) => x.est.averages ? { fgm: x.est.averages.fgm ?? x.est.averages.fga * x.est.averages.fg_pct, fga: x.est.averages.fga, ftm: x.est.averages.ftm ?? x.est.averages.fta * x.est.averages.ft_pct, fta: x.est.averages.fta } : avg3;
    const lineup = actives.slice(0, spots).map(shots);
    for (let i = 0;i < spots - lineup.length; i++)
      lineup.push(avg3);
    for (const [c, made, att] of RATE_CATEGORIES) {
      const a = lineup.reduce((t, x) => t + x[att], 0);
      sums[c] = a > 0 ? lineup.reduce((t, x) => t + x[made], 0) / a : 0;
    }
  }
  const empty = spots - Math.min(spots, actives.length);
  if (!benchmark.ratesAsRates)
    for (let i = 0;i < empty; i++)
      for (const c of CATEGORIES)
        sums[c] += benchmark.poolMean[c];
  else
    for (let i = 0;i < empty; i++)
      for (const c of CATEGORIES)
        if (c !== "FG%" && c !== "FT%")
          sums[c] += benchmark.poolMean[c];
  if (empty > 0)
    assumptions.push(`${empty} empty lineup slot(s) counted as an average rostered player.`);
  const currentOnly = players.filter((p) => p.counted && rows.find((x) => x.r.name === p.name)?.est.currentSeasonOnly).length;
  if (currentOnly > 0)
    assumptions.push(`${currentOnly} player(s) with no completed NBA seasons are judged on this season only; small samples can swing.`);
  const noData = players.filter((p) => p.counted && p.confidence === "none").length;
  if (noData > 0)
    assumptions.push(`${noData} player(s) with no NBA data counted as an average rostered player.`);
  assumptions.push(`Players are estimated from their last three seasons, weighted by recency (${RECENCY_WEIGHTS.join(" / ")}) and games played (capped at ${GAMES_CAP} per season). Aging and role changes are not modelled.`, `Benchmark: ${benchmark.settings.teams} teams x ${benchmark.settings.rosterSpots} roster spots, ${benchmark.leagues} simulated snake drafts, each pick one of the best ${benchmark.pickWeights.length} remaining. Positions are ignored.`, `Season-long strength, not this week: only each team's best ${spots} players (by total score) are summed, the same lineup size the weekly matchup uses. No schedule, game counts or luck are included, so a category's band can differ from this week's matchup win chance, most when a heavy or light week of games or luck is involved.`, "Daily lineup limits are not modelled.", ...benchmark.ratesAsRates ? ["FG% and FT% are ranked by the team's rate (made / attempted over the counted lineup), the same footing the weekly matchup uses, not by a sum of per-player scores."] : [], `Bands by percentile among simulated teams: elite >= ${cut.elite}, strong >= ${cut.strong}, neutral >= ${cut.neutral}, otherwise weak.`);
  const categories = {};
  for (const c of CATEGORIES) {
    const b = benchmark.teamSums[c];
    const percentile = percentileOf(b, sums[c]);
    categories[c] = { total: sums[c], percentile, band: bandFor(percentile, cut), benchmark: { p15: at(b, 15), median: at(b, 50), p85: at(b, 85) } };
  }
  return { categories, players, assumptions, engine_version: ENGINE_VERSION };
}

// src/moves.ts
var lineupOf = (env) => env.slotList ?? env.slots;
var fillerOf = (env) => env.slotList ? { ...env.replacement, positions: [ANY_POSITION] } : env.replacement;
var gamesIn = (w) => (e) => w.gamesOf ? w.gamesOf(e) : w.gamesFor(e.team);
function scoreRoster(roster, env, simWeeks = env.simWeeks) {
  const pad = Math.max(0, env.slots - roster.length);
  const list = pad > 0 ? [...roster, ...Array(pad).fill(fillerOf(env))] : roster;
  let week = 0;
  const codes = env.engine?.codes ?? [...CATEGORIES];
  const cats = Object.fromEntries(codes.map((c) => [c, 0]));
  for (const w of env.weeks) {
    const r = env.engine ? env.engine.simulate(env.engine.totals(list, gamesIn(w), lineupOf(env)), w.opponents, { weeks: simWeeks, seed: env.seed, slots: env.slots }) : simulateWeeks(weeklyTotals(list.map((p) => ({ averages: p.averages, games: gamesIn(w)(p), value: p.value, positions: p.positions })), lineupOf(env)), w.opponents, { weeks: simWeeks, seed: env.seed, slots: env.slots });
    week += r.weekWin;
    for (const c of codes)
      cats[c] += r.categories[c];
  }
  const n = env.weeks.length;
  for (const c of codes)
    cats[c] /= n;
  return { weekWin: week / n, categories: cats };
}
var diff = (a, b) => Object.fromEntries(Object.keys(a.categories).map((c) => [c, a.categories[c] - b.categories[c]]));
function entersLineup(roster, entry, env) {
  const pad = Math.max(0, env.slots - roster.length);
  const list = pad > 0 ? [...roster, ...Array(pad).fill(fillerOf(env))] : roster;
  const seatable = list.map((p) => ({ p, value: p.value, positions: p.positions, games: Math.max(...env.weeks.map((w) => gamesIn(w)(p))) }));
  return pickLineup(seatable, lineupOf(env)).some((s) => s.p === entry);
}
function slotsBroken(before, after, env) {
  if (!env.slotList || !env.checkSlots)
    return [];
  const b = unfilledSlots(before, env.slotList), a = unfilledSlots(after, env.slotList);
  return a.length > b.length ? a : [];
}
function rankWaiverMoves(roster, candidates, env, opts = {}) {
  const droppable = opts.droppable ?? roster;
  const top = opts.top ?? 8;
  const quick = opts.quickWeeks ?? Math.min(env.simWeeks, 3000);
  const drops = [...droppable, ...(env.openSpots ?? 0) > 0 ? [null] : []];
  const without = (drop) => drop ? roster.filter((p) => p.id !== drop.id) : roster;
  const unranked = [];
  const dropOnlyQuick = new Map;
  const dropOnlyAt = (drop, weeks, cache) => {
    const k = drop ? drop.id : 0;
    if (!cache.has(k))
      cache.set(k, scoreRoster(without(drop), env, weeks).weekWin);
    return cache.get(k);
  };
  const picks = [];
  for (const add of candidates) {
    let pick = null;
    let broke = null;
    for (const drop of drops) {
      const next = without(drop).concat(add);
      const empty = slotsBroken(roster, next, env);
      if (empty.length > 0) {
        broke = broke ?? empty;
        continue;
      }
      if (!entersLineup(next, add, env))
        continue;
      const win = scoreRoster(next, env, quick).weekWin;
      if (!pick || win > pick.win || win === pick.win && (drop?.value ?? -Infinity) < (pick.drop?.value ?? -Infinity))
        pick = { add, drop, win };
    }
    if (!pick) {
      unranked.push(broke ? { add, reason: "breaks-slot", empty_slots: broke } : { add, reason: "bench-only" });
      continue;
    }
    const addGain = pick.win - dropOnlyAt(pick.drop, quick, dropOnlyQuick);
    if (addGain <= 0) {
      unranked.push({ add, reason: "no-gain-from-add", drop: pick.drop });
      continue;
    }
    picks.push({ ...pick, addGain });
  }
  picks.sort((a, b) => b.addGain - a.addGain);
  const baseline = scoreRoster(roster, env);
  const dropOnlyFull = new Map;
  const moves = [];
  for (const { add, drop } of picks) {
    if (moves.length >= top) {
      unranked.push({ add, reason: "below-top" });
      continue;
    }
    const after = scoreRoster(without(drop).concat(add), env);
    const only = dropOnlyAt(drop, env.simWeeks, dropOnlyFull);
    const addDelta = after.weekWin - only;
    if (addDelta <= 0) {
      unranked.push({ add, reason: "no-gain-from-add", drop });
      continue;
    }
    if (after.weekWin - baseline.weekWin <= 0) {
      unranked.push({ add, reason: "no-gain-from-add", drop });
      continue;
    }
    moves.push({ add, drop, after, delta: after.weekWin - baseline.weekWin, dropOnlyDelta: only - baseline.weekWin, addDelta, categoryDelta: diff(after, baseline) });
  }
  moves.sort((a, b) => b.addDelta - a.addDelta);
  return { baseline, moves, unranked };
}
function evaluateTrade(roster, give, get, env) {
  const giveIds = new Set(give.map((p) => p.id));
  const before = scoreRoster(roster, env);
  const next = roster.filter((p) => !giveIds.has(p.id)).concat(get);
  const after = scoreRoster(next, env);
  return { before, after, delta: after.weekWin - before.weekWin, categoryDelta: diff(after, before), emptySlots: slotsBroken(roster, next, env) };
}
function searchTrades(mine, theirs, env, opts = {}) {
  const quick = opts.quickWeeks ?? Math.min(env.simWeeks, 2000);
  const minTheirs = opts.minTheirDelta ?? 0;
  const baseMine = scoreRoster(mine, env, quick).weekWin, baseTheirs = scoreRoster(theirs, env, quick).weekWin;
  const found = [];
  for (const give of mine)
    for (const get of theirs) {
      const nextMine = mine.filter((p) => p.id !== give.id).concat(get), nextTheirs = theirs.filter((p) => p.id !== get.id).concat(give);
      if (slotsBroken(mine, nextMine, env).length > 0 || slotsBroken(theirs, nextTheirs, env).length > 0)
        continue;
      const dm = scoreRoster(nextMine, env, quick).weekWin - baseMine;
      if (dm <= 0)
        continue;
      const dt = scoreRoster(nextTheirs, env, quick).weekWin - baseTheirs;
      if (dt >= minTheirs)
        found.push({ give, get, dm, dt });
    }
  found.sort((a, b) => b.dm - a.dm);
  return found.slice(0, opts.top ?? 5).map(({ give, get }) => ({
    give,
    get,
    mine: evaluateTrade(mine, [give], [get], env),
    theirs: evaluateTrade(theirs, [get], [give], env)
  }));
}

// src/outlook.ts
var nextPow2 = (n) => {
  let b = 1;
  while (b < n)
    b *= 2;
  return b;
};
function playOut(inp, chances2, playoffChances, runs, seed) {
  const rand = mulberry32(seed);
  const myW0 = inp.record.wins, myT0 = inp.record.ties ?? 0;
  const others = inp.standings ?? [];
  const n = others.length + 1;
  const P = inp.playoffs.teams;
  const B = nextPow2(P), byes = B - P, rounds = Math.log2(B);
  const left = chances2.length;
  const finalWins = new Map;
  let sumWins = 0, make = 0, bye = 0, tiebreak = 0, title = 0;
  const seeds = Array(n).fill(0);
  const reach = Array(rounds).fill(0), won = Array(rounds).fill(0);
  for (let r = 0;r < runs; r++) {
    let w = myW0, t = myT0;
    for (const c of chances2) {
      const u = rand();
      if (u < c.win)
        w++;
      else if (u < c.win + c.tie)
        t++;
    }
    sumWins += w;
    finalWins.set(w, (finalWins.get(w) ?? 0) + 1);
    if (!inp.standings)
      continue;
    const mine = w + 0.5 * t;
    let above = 0, tied = 0, aboveOnTie = 0;
    const myTb = inp.record.tiebreak_value;
    for (const o of others) {
      let ow = o.wins;
      for (let i = 0;i < left; i++)
        if (rand() < 0.5)
          ow++;
      const pts = ow + 0.5 * (o.ties ?? 0);
      if (pts > mine)
        above++;
      else if (pts === mine) {
        tied++;
        const tb = o.tiebreak_value;
        if (tb === undefined || myTb === undefined || tb === myTb) {
          if (rand() < 0.5)
            aboveOnTie++;
        } else if (tb > myTb)
          aboveOnTie++;
      }
    }
    const seed0 = above + aboveOnTie + 1;
    seeds[Math.min(seed0, n) - 1]++;
    const inPlayoffs = seed0 <= P;
    if (tied > 0 && above + 1 <= P && above + tied + 1 > P)
      tiebreak++;
    if (!inPlayoffs)
      continue;
    make++;
    if (seed0 <= byes)
      bye++;
    let alive = true;
    for (let k = seed0 <= byes ? 1 : 0;k < rounds && alive; k++) {
      reach[k]++;
      const p = playoffChances[k] ?? playoffChances[playoffChances.length - 1] ?? 0.5;
      if (rand() < p) {
        won[k]++;
        if (k === rounds - 1)
          title++;
      } else
        alive = false;
    }
  }
  const pct = (x) => Math.round(x / runs * 1000) / 10;
  return {
    finalWins,
    summary: {
      expected_final_wins: Math.round(sumWins / runs * 100) / 100,
      ...inp.standings ? { playoffs: {
        make_pct: pct(make),
        bye_pct: pct(bye),
        seed_pct: seeds.map(pct),
        tiebreak_decides_pct: pct(tiebreak),
        round_win_pct: reach.map((rc, k) => rc > 0 ? Math.round(won[k] / rc * 1000) / 10 : 0),
        title_pct: pct(title)
      } } : {}
    }
  };
}
function runOutlook(inp, roster, weekWin, seed = 1) {
  if (!inp.record || ![inp.record.wins, inp.record.losses].every((x) => Number.isInteger(x) && x >= 0))
    throw new Error("outlook.record needs whole wins and losses");
  if (!Array.isArray(inp.remaining) || inp.remaining.length === 0)
    throw new Error("outlook.remaining must list the weeks you still play (week_start, and the opponent's roster when known)");
  if (inp.remaining.length > 30)
    throw new Error("outlook.remaining has more than 30 weeks");
  if (!inp.playoffs || !Number.isInteger(inp.playoffs.teams) || inp.playoffs.teams < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(inp.playoffs.first_week ?? ""))
    throw new Error("outlook.playoffs needs teams and first_week (YYYY-MM-DD, a Monday)");
  if (inp.standings && inp.playoffs.teams > inp.standings.length + 1)
    throw new Error("outlook.playoffs.teams is larger than the league (standings lists the other teams)");
  const weeks = inp.weeks ?? 2000;
  const runs = inp.runs ?? 5000;
  const assumptions = [];
  const rounds = Math.log2(nextPow2(inp.playoffs.teams));
  const sim = (r) => {
    const per = inp.remaining.map((w) => ({ w, ...weekWin(w.week_start, r, w.opponent, weeks) }));
    const playoff = Array.from({ length: rounds }, (_, k) => weekWin(addDays(inp.playoffs.first_week, 7 * k), r, undefined, weeks).win);
    const { summary, finalWins } = playOut(inp, per.map((x) => ({ win: x.win, tie: x.tie })), playoff, runs, seed);
    return { per, summary, finalWins };
  };
  const base = sim(roster);
  const total = [...base.finalWins.values()].reduce((a, b) => a + b, 0);
  const finalWinsPct = Object.fromEntries([...base.finalWins.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), Math.round(v / total * 1000) / 10]));
  const out = {
    weeks_left: inp.remaining.length,
    ...base.summary,
    per_week: base.per.map((x) => ({
      week_start: x.w.week_start,
      opponent: x.w.opponent && x.w.opponent.length > 0 ? "roster" : "typical",
      win_pct: Math.round(x.win * 100),
      tie_pct: Math.round(x.tie * 100),
      games_source: x.source
    })),
    final_wins_pct: finalWinsPct,
    ...inp.playoffs.tiebreaker ? { tiebreaker: inp.playoffs.tiebreaker } : {},
    assumptions
  };
  if (inp.move) {
    const mv = inp.move;
    const drop = new Set([...mv.drop ? [mv.drop] : [], ...mv.give ?? []].map((s) => s.toLowerCase()));
    const next = [...roster.filter((p) => !drop.has(p.name.toLowerCase())), ...mv.add ? [mv.add] : [], ...mv.get ?? []];
    const m = sim(next);
    const label = [mv.add ? `add ${mv.add.name}` : "", mv.drop ? `drop ${mv.drop}` : "", mv.give?.length ? `give ${mv.give.join(", ")}` : "", mv.get?.length ? `get ${mv.get.map((g) => g.name).join(", ")}` : ""].filter(Boolean).join(", ");
    out.move = {
      label,
      expected_final_wins: m.summary.expected_final_wins,
      delta_wins: Math.round((m.summary.expected_final_wins - base.summary.expected_final_wins) * 100) / 100,
      ...m.summary.playoffs ? {
        playoffs_make_pct: m.summary.playoffs.make_pct,
        title_pct: m.summary.playoffs.title_pct,
        delta_playoff_points: Math.round((m.summary.playoffs.make_pct - base.summary.playoffs.make_pct) * 10) / 10,
        delta_title_points: Math.round((m.summary.playoffs.title_pct - base.summary.playoffs.title_pct) * 10) / 10
      } : {}
    };
  }
  assumptions.push(`Each remaining week's win chance is the weekly simulation for your roster as it stands (${weeks} simulated weeks each): no future adds, drops, trades or injuries are assumed.`, `Season simulated ${runs} times with a fixed seed. Weeks with no schedule in the data use an average week of games and are marked "assumed".`);
  if (inp.standings) {
    assumptions.push("Other teams' remaining results are fair coin flips: their rosters are not known, so a team that is strong or weak this season is not credited for it. This understates the gap at the top and bottom of the table.", `Seeds are decided by record (a tie counts half). A tie in the record is settled by the league's tiebreaker${inp.playoffs.tiebreaker ? ` (${inp.playoffs.tiebreaker})` : ""} only as far as it is known now; otherwise by a coin flip. "tiebreak_decides_pct" is how often your spot hung on such a tie.`, `Playoff rounds use a typical opponent in each round's week (the real opponent is not known until seeding). ${nextPow2(inp.playoffs.teams) - inp.playoffs.teams} top seed(s) get a first-round bye in a bracket of ${nextPow2(inp.playoffs.teams)}.`);
  } else
    assumptions.push("No standings were given, so only your regular-season wins are projected. Give every other team's record for the playoff chance.");
  return out;
}

// src/analyze.ts
function check(input) {
  const { teams, roster_spots } = input.league ?? {};
  if (!Number.isInteger(teams) || teams < 4 || teams > 30)
    throw new Error("league.teams must be a whole number from 4 to 30");
  if (!Number.isInteger(roster_spots) || roster_spots < 5 || roster_spots > 20)
    throw new Error("league.roster_spots must be a whole number from 5 to 20 (active slots, not IL)");
  if (!Array.isArray(input.roster) || input.roster.length === 0)
    throw new Error("roster must list at least one player");
  if (input.roster.length > 40)
    throw new Error("roster has more than 40 players");
}
function analyzeLeague(input, snapshotIn) {
  check(input);
  const snapshot = withScheduleDays(input, snapshotIn);
  const out = dispatch(input, snapshot);
  if (input.outlook)
    out.outlook = outlookFor(input, snapshot);
  return out;
}
function outlookFor(input, snapshot) {
  const weekWin = (weekStart, roster, opponent, weeks) => {
    const o = analyzeLeague({
      ...input,
      outlook: undefined,
      waiver: undefined,
      trade: undefined,
      leagues: 30,
      roster,
      matchup: { week_start: weekStart, weeks, ...opponent ? { opponent } : {}, ...input.matchup?.lineup_slots ? { lineup_slots: input.matchup.lineup_slots } : {} }
    }, snapshot);
    return { win: o.matchup.week_win_prob, tie: o.matchup.week_tie_prob ?? 0, source: o.matchup.games_source };
  };
  return runOutlook(input.outlook, input.roster, weekWin, input.seed ?? 1);
}
function dispatch(input, snapshot) {
  if (input.league.scoring && input.league.categories)
    throw new Error("give league.categories or league.scoring, not both");
  if (input.league.scoring) {
    const w = parseWeights(input.league.scoring);
    const out = analyzeAny(input, snapshot, Object.keys(w), w);
    const skipped = untrackedScoring(input.league.scoring);
    if (skipped.length)
      out.assumptions.push(`NOT SCORED: ${skipped.join(", ")}. We have no data for these rare events (about 0.4% of a typical week's points), so they are left out of every number here.`);
    return out;
  }
  if (input.league.categories) {
    const codes = parseCategories(input.league.categories);
    if (!isStandardNine(codes))
      return analyzeAny(input, snapshot, codes);
  }
  return analyze(input, snapshot);
}
function analyze(input, snapshotIn) {
  check(input);
  const snapshot = withScheduleDays(input, snapshotIn);
  const reference = input.reference ?? snapshot.reference_season;
  const { teams, roster_spots } = input.league;
  const poolOf = (season) => {
    const out = [];
    for (const p of snapshot.players) {
      const s = p.seasons.find((x) => x.season === season);
      if (s && s.mpg > 0 && s.gp > 0)
        out.push({ player_id: p.id, name: p.name, gp: s.gp, mpg: s.mpg, averages: s.averages });
    }
    return out;
  };
  const pool = poolOf(reference);
  if (pool.length < teams * roster_spots)
    throw new Error(`snapshot has only ${pool.length} players for ${reference}; need at least ${teams * roster_spots}`);
  let baseline = buildBaseline(pool, teams * roster_spots);
  const currentSeason = seasonLabel(startYear(reference) + 1);
  const currentPool = poolOf(currentSeason);
  const teamGames = input.team_games ?? currentPool.reduce((m, p) => Math.max(m, p.gp), 0);
  const w = currentPool.length >= teams * roster_spots ? blendWeight(teamGames) : 0;
  if (w > 0)
    baseline = blendBaselines(baseline, buildBaseline(currentPool, teams * roster_spots), w);
  const blendInfo = { reference_season: reference, current_season: w > 0 ? currentSeason : null, team_games: w > 0 ? teamGames : 0, weight_current: w };
  const sim = pool.map((p) => {
    const z = categoryZ(p.averages, baseline);
    const a = p.averages;
    return {
      id: p.player_id,
      z,
      total: CATEGORIES.reduce((t, c) => t + z[c], 0),
      shots: { fgm: a.fgm ?? a.fga * a.fg_pct, fga: a.fga, ftm: a.ftm ?? a.fta * a.ft_pct, fta: a.fta }
    };
  });
  const lineupSlots = lineupSetting(input, input.matchup?.lineup_slots ?? input.waiver?.lineup_slots ?? input.trade?.lineup_slots).slots;
  const benchmark = simulateBenchmark(sim, { teams, rosterSpots: roster_spots }, { leagues: input.leagues ?? 500, seed: input.seed ?? 1, lineupSlots });
  const names = [];
  const roster = input.roster.map((r) => {
    const m = resolvePlayer(r.name, snapshot.players);
    const status = r.status === "IL" ? "IL" : undefined;
    if (m.status === "matched") {
      names.push({ input: r.name, status: "matched", matched: m.player.name });
      return { name: m.player.name, status, history: historyOf(m.player) };
    }
    if (m.status === "ambiguous") {
      names.push({
        input: r.name,
        status: "ambiguous",
        candidates: m.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" }))
      });
    } else
      names.push({ input: r.name, status: "not_found" });
    return { name: r.name, status, history: { player_id: null, name: r.name, seasons: [] } };
  });
  const result = assessTeam(roster, baseline, benchmark, { reference, current: currentPool.length > 0 ? currentSeason : undefined });
  if (w > 0)
    result.assumptions.push(`League baseline: ${Math.round((1 - w) * 100)}% ${reference}, ${Math.round(w * 100)}% ${currentSeason} (season blend after ${teamGames} games, w = g/(g+40)).`);
  for (const n of names) {
    if (n.status === "ambiguous")
      result.assumptions.push(`"${n.input}" could be more than one player; counted as an average player until clarified.`);
    if (n.status === "not_found")
      result.assumptions.push(`"${n.input}" was not found (misspelled, or a rookie not in the data yet); counted as an average player.`);
  }
  const ranking = CATEGORIES.map((c) => ({ category: c, band: result.categories[c].band, percentile: Math.round(result.categories[c].percentile) })).sort((a, b) => b.percentile - a.percentile);
  const matchup = input.matchup ? runMatchup(input, snapshot, reference, currentSeason, baseline, names) : undefined;
  const waiver = input.waiver ? runWaiver(input, snapshot, reference, currentSeason, baseline) : undefined;
  const trade = input.trade ? runTrade(input, snapshot, reference, currentSeason, baseline) : undefined;
  return {
    ...result,
    snapshot: { generated_at: snapshot.generated_at, reference_season: snapshot.reference_season },
    baseline: blendInfo,
    league: input.league,
    names,
    ranking,
    warnings: leftOutWarnings([names, matchup?.names, waiver?.names, trade?.names]),
    ...matchup ? { matchup } : {},
    ...waiver ? { waiver } : {},
    ...trade ? { trade } : {}
  };
}
function leftOutWarnings(lists) {
  const seen = new Set, out = [];
  for (const n of lists.flatMap((l) => l ?? [])) {
    if (n.status === "matched" || seen.has(n.input))
      continue;
    seen.add(n.input);
    out.push(n.status === "ambiguous" ? `WARNING: "${n.input}" could be ${n.candidates?.map((c) => c.name).join(", ") ?? "more than one player"}; left out of the numbers until you say which.` : `WARNING: "${n.input}" was not found; left out of the numbers.`);
  }
  return out;
}
function lineupSetting(input, lineupSlots, label = "lineup_slots") {
  const { roster_spots } = input.league;
  if (input.league.slots) {
    const list = parseSlots(input.league.slots);
    if (lineupSlots !== undefined && lineupSlots !== list.length)
      throw new Error(`${label} (${lineupSlots}) does not match league.slots (${list.length} slots): give one or the other`);
    return { slots: list.length, slotList: list };
  }
  const slots = lineupSlots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20)
    throw new Error(`${label} must be a whole number from 1 to 20`);
  return { slots };
}
var asOfOf = (input, snapshot) => input.as_of ?? snapshot.generated_at.slice(0, 10);
function withScheduleDays(input, snapshot) {
  if (!input.schedule_days)
    return snapshot;
  return { ...snapshot, schedule: { source: snapshot.schedule?.source ?? "request", ...snapshot.schedule, days: input.schedule_days } };
}
function runMatchup(input, snapshot, reference, currentSeason, baseline, mineNames) {
  const m = input.matchup;
  const { teams, roster_spots } = input.league;
  const { slots, slotList } = lineupSetting(input, m.lineup_slots, "matchup.lineup_slots");
  const lineupSlots = slotList ?? slots;
  const assumptions = [];
  const sfIn = m.so_far;
  if (sfIn) {
    if (!m.opponent || m.opponent.length === 0)
      throw new Error("matchup.so_far needs a real matchup.opponent");
    if (sfIn.games_left) {
      for (const [t, n] of Object.entries(sfIn.games_left))
        if (!(Number.isInteger(n) && n >= 0 && n <= 7))
          throw new Error(`matchup.so_far.games_left: ${t} must be a whole number of games from 0 to 7`);
    } else if (!(sfIn.remaining_share >= 0 && sfIn.remaining_share <= 1))
      throw new Error("matchup.so_far needs games_left, or remaining_share between 0 and 1");
    for (const side of [sfIn.you, sfIn.opponent])
      for (const k of ["pts", "reb", "ast", "stl", "blk", "fg3m", "tov", "fgm", "fga", "ftm", "fta"])
        if (side?.[k] !== undefined && !(typeof side[k] === "number" && side[k] >= 0))
          throw new Error(`matchup.so_far: ${k} must be a number of 0 or more for both sides`);
  }
  const countKeys = ["pts", "reb", "ast", "stl", "blk", "fg3m", "tov"];
  const usable = Boolean(sfIn) && ["you", "opponent"].every((w) => countKeys.every((k) => typeof sfIn[w]?.[k] === "number"));
  const liveScore = sfIn && usable ? liveScoreOf([sfIn.you, sfIn.opponent], { fg: true, ft: true }) : "fresh-week";
  const sf = liveScore === "fresh-week" ? undefined : sfIn;
  if (sfIn && !sf)
    assumptions.push(FRESH_WEEK_NOTE);
  const weekStart = m.week_start ?? mondayOf(snapshot.generated_at);
  const week = scheduleWeeks(snapshot).find((w) => w.start === weekStart);
  const gamesFor = (team) => week && team ? week.games[team] ?? 0 : DEFAULT_WEEK_GAMES;
  const fromSchedule = Boolean(week);
  const tbd = week?.tbd_slots ?? 0;
  assumptions.push(fromSchedule ? `Games per player come from the NBA schedule for the week of ${weekStart}. Injuries and rest days are not modelled${m.scenarios?.length ? " except the scenarios you gave" : ""}.` : `No schedule for the week of ${weekStart} in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games. A real week with more or fewer games changes the picture.`);
  const estimated = estimatePlayers(snapshot, reference, currentSeason, baseline);
  if (tbd > 0)
    assumptions.unshift(`WARNING: ${tbd} game slot(s) in the week of ${weekStart} are still "TBD" in the NBA schedule, so some teams' game counts may be too low. Check the real schedule and treat these numbers as rougher.`);
  const leftFor = (team) => sf?.games_left && team ? sf.games_left[team] ?? 0 : 0;
  const ctx = {
    snapshot,
    estimated,
    gamesFor,
    weekStart: fromSchedule ? weekStart : null,
    asOf: asOfOf(input, snapshot),
    ramp: input.ramp,
    scenarios: m.scenarios ?? [],
    slots: lineupSlots,
    ...sf?.games_left ? { leftFor } : {},
    assumptions
  };
  const toWeekly = (s) => s.chosen.map((x) => ({ averages: x.entry.averages, games: x.games, value: x.entry.value, positions: x.positions }));
  const weeklyOf = (list, label, side) => {
    const res = resolveSide(list, label, side, { ...ctx, ...side === "you" && m.lineup ? { lineup: m.lineup } : {} });
    const players = toWeekly(res);
    const totals = weeklyTotals(players, lineupSlots);
    if (!sf)
      return { totals, remaining: totals, share: 1, names: res.names, rows: res.playerRows, res };
    const given = side === "you" ? sf.you : sf.opponent;
    const bankedOf = (playedGames) => {
      const pl = weeklyTotals(res.chosen.map((x, i) => ({ ...players[i], games: playedGames(x) })), lineupSlots);
      const { fg_pct: _a, ft_pct: _b, ...rest2 } = given;
      return { ...rest2, ...bankedShooting(given, pl) };
    };
    if (!sf.games_left)
      return { totals, remaining: scaledTotals(totals, sf.remaining_share), share: sf.remaining_share, names: res.names, rows: res.playerRows, res, banked: bankedOf((x) => x.games * (1 - sf.remaining_share)) };
    const left = res.chosen.map((x, i) => ({ ...players[i], games: x.left }));
    const full = res.chosen.reduce((s, x) => s + x.games, 0), rest = res.chosen.reduce((s, x) => s + x.left, 0);
    return { totals, remaining: weeklyTotals(left, lineupSlots), share: full > 0 ? Math.min(1, rest / full) : 1, names: res.names, rows: res.playerRows, res, banked: bankedOf((x) => Math.max(0, x.games - x.left)) };
  };
  const me = weeklyOf(input.roster, "your", "you");
  let opponents;
  let names = me.names;
  let opp;
  if (m.opponent && m.opponent.length > 0) {
    const o = opp = weeklyOf(m.opponent, "opponent", "opponent");
    opponents = [o.totals];
    names = [...me.names, ...o.names.map((n) => ({ ...n, input: `${n.input} (opponent)` }))];
  } else {
    const pool = [...estimated.values()];
    opponents = typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 300, seed: input.seed ?? 1 });
    assumptions.push(`Typical opponents: ${opponents.length} teams from ${300} simulated ${teams}-team drafts, each playing its best ${slots} players. Positions are ignored for them${slotList ? "; your team uses the league's real slots" : ""}.`);
  }
  const weeks = m.weeks ?? DEFAULT_WEEKS;
  const progressOf = (a) => ({ me: { banked: a.banked, remaining: a.remaining, share: a.share }, opponent: { banked: opp.banked, remaining: opp.remaining, share: opp.share } });
  const r = simulateWeeks(me.totals, opponents, {
    weeks,
    seed: input.seed ?? 1,
    slots,
    ...sf && opp ? { progress: progressOf(me) } : {}
  });
  let recommended;
  if (me.res.recommended) {
    const altRes = resolveSide(input.roster, "your", "you", { ...ctx, assumptions: [] });
    const altTotals = weeklyTotals(toWeekly(altRes), lineupSlots);
    const altLeft = altRes.chosen.map((x, i) => ({ ...toWeekly(altRes)[i], games: x.left }));
    const altFull = altRes.chosen.reduce((s, x) => s + x.games, 0), altRest = altRes.chosen.reduce((s, x) => s + x.left, 0);
    const altSide = sf && opp ? { remaining: sf.games_left ? weeklyTotals(altLeft, lineupSlots) : scaledTotals(altTotals, sf.remaining_share), share: sf.games_left ? altFull > 0 ? Math.min(1, altRest / altFull) : 1 : sf.remaining_share } : undefined;
    const ra = simulateWeeks(altTotals, opponents, {
      weeks,
      seed: input.seed ?? 1,
      slots,
      ...sf && opp && altSide ? { progress: progressOf({ ...me, remaining: altSide.remaining, share: altSide.share }) } : {}
    });
    recommended = { players: altRes.chosen.map((x) => ({ name: x.entry.name, ...altRes.slotOf.has(x) ? { slot: altRes.slotOf.get(x) } : {} })), week_win_pct: Math.round(ra.weekWin * 100) };
    assumptions.push(`Your lineup is not the best fit for the slots by this model. The recommendation is shown with its win chance; the numbers above use the lineup you gave.`);
  }
  if (sf)
    assumptions.push(sf.games_left ? `The week is under way: stats already banked are kept, and the games still to play (your lineup has ${Math.round(me.share * 100)}% of its week left, theirs ${Math.round(opp.share * 100)}%) are simulated from each player's own team games left, per-game averages and luck. Games in progress or already counted by the league site must not be in the games left.` : `The week is under way: stats already banked are kept, and the remaining ${Math.round(sf.remaining_share * 100)}% of each team's games are simulated from per-game averages plus luck. Every player is assumed to have that same share of his week left, which is rough when a team's games are lopsided.`);
  if (liveScore === "estimated")
    assumptions.push(`LIVE SCORE ESTIMATED: ${ATTEMPTS_ESTIMATE_NOTE}`);
  const availabilityApplied = [...me.res.rows, ...opp?.res.rows ?? []].some((x) => x.lost > 0 || x.av);
  if (availabilityApplied)
    assumptions.push("Some players' games were changed by an injury status read from the league page or by a scenario you gave. Scenarios and a return day are your assumptions, not measured facts; a ramp-up after a return (default 80% output for 3 games) is also an assumption.");
  let daily;
  if (m.daily) {
    if (m.daily.from && m.daily.from > weekStart && !sf)
      throw new Error("matchup.daily.from is later than the week's start: give matchup.so_far with the stats already banked (counts, or at least FG% and FT%)");
    const zero = () => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fg3m: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
    const engine = {
      empty: zero,
      plus: (x, y) => {
        const o = zero();
        for (const k of Object.keys(o))
          o[k] = x[k] + y[k];
        return o;
      },
      dayTotals: (ps) => weeklyTotals(ps.map((p) => ({ averages: p.entry.averages, games: p.weight, value: p.entry.value, positions: p.positions })), lineupSlots),
      win: (remaining, share, n) => simulateWeeks(sf ? me.totals : remaining, opponents, {
        weeks: n,
        seed: input.seed ?? 1,
        slots,
        ...sf && opp ? { progress: { me: { banked: me.banked, remaining, share }, opponent: { banked: opp.banked, remaining: opp.remaining, share: opp.share } } } : {}
      }).weekWin
    };
    daily = runDaily(input, snapshot, m, { me: me.res, weekStart, lineupSlots, weeks, engine, estimated, gamesFor, asOf: ctx.asOf, hasBanked: Boolean(sf), assumptions });
  }
  assumptions.push(`Week-to-week luck is measured on 2025-26 weekly results after removing game counts. ${weeks} simulated weeks, fixed seed, so the same inputs give the same answer. ` + `The simulation does not model ${availabilityApplied ? "other injuries, " : "injuries, "}lineup moves or streaming during the week${daily ? " except in the daily section" : ""}.`);
  const pct = (x) => Math.round(x * 100);
  return {
    week_start: week ? weekStart : null,
    games_source: fromSchedule ? "schedule" : "assumed",
    schedule_incomplete: tbd > 0,
    opponent: m.opponent && m.opponent.length > 0 ? "roster" : "typical",
    lineup_slots: slots,
    weeks,
    so_far_counted: Boolean(sf),
    live_score: liveScore,
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, pct(r.categories[c])])),
    week_win_pct: pct(r.weekWin),
    distribution_pct: r.distribution.map(pct),
    rosters: { you: me.rows, ...opp ? { opponent: opp.rows } : {} },
    lineup_source: m.lineup && m.lineup.length > 0 ? "user" : "recommended",
    ...recommended ? { recommended_lineup: recommended } : {},
    availability_applied: availabilityApplied,
    ...daily ? { daily } : {},
    week_win_prob: r.weekWin,
    week_tie_prob: 0,
    names,
    assumptions
  };
}
function estimatePlayers(snapshot, reference, currentSeason, baseline) {
  const out = new Map;
  for (const p of snapshot.players) {
    const e = estimateAverages(historyOf(p), reference, { current: currentSeason });
    if (!e.averages)
      continue;
    const z = categoryZ(e.averages, baseline);
    out.set(p.id, { id: p.id, name: p.name, averages: e.averages, team: p.team, value: CATEGORIES.reduce((t, c) => t + z[c], 0), confidence: e.confidence, effectiveGames: e.effectiveGames });
  }
  return out;
}
function moveSetup(input, common, snapshot, reference, currentSeason, baseline) {
  const { teams, roster_spots } = input.league;
  const { slots, slotList } = lineupSetting(input, common.lineup_slots);
  const horizon = Math.max(1, Math.min(4, common.horizon_weeks ?? 2));
  const simWeeks = common.weeks ?? 6000;
  const estimated = estimatePlayers(snapshot, reference, currentSeason, baseline);
  const pool = [...estimated.values()].sort((a, b) => b.value - a.value);
  if (pool.length < teams * roster_spots)
    throw new Error(`snapshot has only ${pool.length} players; need at least ${teams * roster_spots}`);
  const replacement = pool[teams * roster_spots - 1];
  const first = mondayOf(snapshot.generated_at);
  const scheduled = scheduleWeeks(snapshot).filter((w) => w.start >= first).slice(0, horizon);
  const assumptions = [];
  const seed = input.seed ?? 1;
  const mk = (start, games) => {
    const gamesFor = (team) => games && team ? games[team] ?? 0 : DEFAULT_WEEK_GAMES;
    const gamesOf = (e) => e.avail && start && games ? gamesWithAvailability(snapshot, e.team, start, gamesFor(e.team), e.avail).games : gamesFor(e.team);
    return { start, gamesFor, gamesOf, opponents: typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 150, seed }) };
  };
  const weeks = scheduled.length > 0 ? scheduled.map((w) => mk(w.start, w.games)) : [mk(null, null)];
  const gamesSource = scheduled.length > 0 ? "schedule" : "assumed";
  for (const w of scheduled)
    if (w.tbd_slots)
      assumptions.push(`WARNING: ${w.tbd_slots} game slot(s) in the week of ${w.start} are still "TBD" in the NBA schedule, so some teams' game counts may be too low.`);
  assumptions.push(gamesSource === "schedule" ? `Averaged over ${weeks.length} week(s) starting ${weeks[0].start}, counting each player's real games from the NBA schedule.` : `No schedule in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`, `Each score is a weekly win chance against typical opponents (${weeks[0].opponents.length} teams from simulated ${teams}-team drafts, positions ignored for them), ${simWeeks} simulated weeks with a fixed seed. ` + `A move is scored by re-running the same weeks with the roster changed, so the difference is the move's effect. Injuries, rest days and lineup moves during the week are not modelled (except an injury status read from the league page, below). An empty lineup spot is filled by a replacement-level player.` + (slotList ? ` Your lineup uses the league's slots (${slotList.join(" ")}); each week the best-fitting lineup is used.` : ""));
  return { env: { slots, ...slotList ? { slotList } : {}, weeks, simWeeks, seed, replacement }, estimated, weeksUsed: weeks.map((w) => w.start ?? "assumed"), gamesSource, scheduleIncomplete: scheduled.some((w) => (w.tbd_slots ?? 0) > 0), assumptions };
}
function resolveList(list, snapshot, estimated, names, suffix = "", ctx) {
  const out = [];
  for (const r of list) {
    const hit = resolvePlayer(r.name, snapshot.players);
    if (hit.status === "matched") {
      names.push({ input: r.name + suffix, status: "matched", matched: hit.player.name });
      const e = estimated.get(hit.player.id);
      if (e && r.status !== "IL") {
        const positions = parsePositions(r.positions);
        let avail;
        if (ctx) {
          const h = availabilityFromHost(r.injury, r.return_date, ctx.asOf, ctx.ramp === false ? null : ctx.ramp ?? DEFAULT_RAMP);
          avail = h.av;
          if (h.flag)
            ctx.notes.push(`${hit.player.name}: ${h.flag}`);
        }
        out.push(positions || avail ? { ...e, ...positions ? { positions } : {}, ...avail ? { avail } : {} } : e);
      }
    } else if (hit.status === "ambiguous") {
      names.push({ input: r.name + suffix, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
    } else
      names.push({ input: r.name + suffix, status: "not_found" });
  }
  return out;
}
var pct1 = (x) => Math.round(x * 1000) / 10;
var catDelta = (d) => Object.fromEntries(CATEGORIES.map((c) => [c, pct1(d[c])]));
var side = (b, a, delta, cd, empty = []) => ({
  before_week_win_pct: Math.round(b.weekWin * 100),
  after_week_win_pct: Math.round(a.weekWin * 100),
  delta_points: pct1(delta),
  categories_delta_points: catDelta(cd),
  ...empty.length ? { empty_slots: empty } : {}
});
function runWaiver(input, snapshot, reference, currentSeason, baseline) {
  const w = input.waiver;
  if (!Array.isArray(w.candidates) || w.candidates.length === 0)
    throw new Error("waiver.candidates must list at least one available player");
  if (w.candidates.length > 60)
    throw new Error("waiver.candidates has more than 60 players; send the best available");
  return waiverWith(input, snapshot, moveSetup(input, w, snapshot, reference, currentSeason, baseline));
}
var ord = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
var MODEL_LIMIT = "This model counts a bench player as sitting all week; it does not model days when starters are off, so any value he would give on those days is not counted.";
function explainUnranked(u, roster, slots) {
  const base = { add: u.add.name, reason: u.reason, label: "not counted by this model", lineup_slots: slots };
  if (u.reason === "below-top") {
    return { ...base, explanation: `${u.add.name} would help, but less than the moves listed; ask for a longer list to see him.` };
  }
  if (u.reason === "breaks-slot") {
    const e = u.empty_slots ?? [];
    return { ...base, empty_slots: e, explanation: `Not recommended: every drop that makes room for ${u.add.name} would leave your ${e.join(", ")} slot${e.length === 1 ? "" : "s"} with nobody eligible. Your league requires those slots to be filled.` };
  }
  const size = roster.length + 1;
  const rank = 1 + roster.filter((p) => p.value > u.add.value).length;
  const r = { ...base, rank_if_added: rank, roster_size_with_add: size };
  if (u.reason === "bench-only") {
    return { ...r, explanation: `He would rank ${ord(rank)} of ${size} on your roster by weekly production, outside your ${slots} counted lineup spots, so this model counts him as a bench player. ${MODEL_LIMIT}` };
  }
  if (u.drop === null)
    return { ...r, explanation: `He would fit on an open roster spot with nobody dropped, but in this model he does not improve your weekly win chance. ${MODEL_LIMIT}` };
  const drop = u.drop;
  const dropRank = 1 + roster.filter((p) => p.value > drop.value).length + (u.add.value > drop.value ? 1 : 0);
  return { ...r, would_replace: drop.name, would_replace_rank: dropRank, explanation: `He would rank ${ord(rank)} of ${size} by weekly production. The player he would most plausibly replace, ${drop.name}, ranks ${ord(dropRank)}; in this model the swap does not improve your weekly win chance (his counted production is not above what you give up). ${MODEL_LIMIT}` };
}
function planIL(input, ilOpenGiven) {
  const { roster_spots, il_slots, il_eligible_statuses } = input.league;
  const inIL = input.roster.filter((r) => r.status === "IL").length;
  let open = ilOpenGiven ?? (il_slots !== undefined ? Math.max(0, il_slots - inIL) : 0);
  const eligible2 = new Set((il_eligible_statuses ?? []).map((s) => s.trim().toUpperCase()));
  const moved = [];
  const roster = input.roster.map((r) => {
    if (r.status !== "IL" && open > 0 && r.injury && eligible2.has(r.injury.trim().toUpperCase())) {
      open--;
      moved.push(r.name);
      return { ...r, status: "IL" };
    }
    return r;
  });
  const active = roster.filter((r) => r.status !== "IL").length;
  return { roster, moved, openSpots: Math.max(0, roster_spots - active) };
}
function waiverWith(input, snapshot, st) {
  const w = input.waiver;
  const names = [];
  const notes = [];
  const asOf = asOfOf(input, snapshot);
  const plan = planIL(input, w.il_open);
  const ctx = { asOf, ramp: input.ramp, notes };
  const roster = resolveList(plan.roster, snapshot, st.estimated, names, "", ctx);
  const mine = new Set(roster.map((p) => p.id));
  const cands = resolveList(w.candidates, snapshot, st.estimated, names, " (available)", ctx).filter((p) => !mine.has(p.id));
  if (roster.length === 0)
    throw new Error("none of the roster players could be matched");
  const extra = [];
  const slotMode = Boolean(st.env.slotList);
  const noPos = roster.filter((p) => !p.positions).map((p) => p.name);
  const checkSlots = slotMode && noPos.length === 0;
  if (slotMode && noPos.length > 0)
    extra.push(`WARNING: no positions were given for ${noPos.join(", ")}, so they can only fill a UTIL slot and the check that a move leaves no required slot empty is OFF. Give each player's positions from your league page.`);
  const noPosC = cands.filter((p) => !p.positions).map((p) => p.name);
  if (slotMode && noPosC.length > 0)
    extra.push(`WARNING: no positions were given for ${noPosC.length} available player(s) (${noPosC.slice(0, 5).join(", ")}${noPosC.length > 5 ? ", ..." : ""}): they can only fill a UTIL slot.`);
  if (plan.moved.length > 0)
    extra.push(`Assumed moved to your injured list (the league lets their status in, and slots are open): ${plan.moved.join(", ")}. That frees ${plan.moved.length} roster spot(s).`);
  const env = { ...st.env, openSpots: plan.openSpots, checkSlots };
  const { baseline: base, moves, unranked } = rankWaiverMoves(roster, cands, env, { top: w.top ?? 8 });
  const winPct = (x) => Math.round(x * 100);
  let bestUse;
  if (w.adds_left !== undefined) {
    if (!Number.isInteger(w.adds_left) || w.adds_left < 0)
      throw new Error("waiver.adds_left must be a whole number of 0 or more");
    if (w.adds_left === 0)
      bestUse = { adds_left: 0, moves: [], week_win_pct: winPct(base.weekWin), delta_points: 0, note: "You have no adds left this week. The ranked moves below can wait for next week." };
    else {
      let cur = roster, left = cands.slice(), spots = plan.openSpots;
      const picked = [];
      for (let i = 0;i < Math.min(w.adds_left, 5); i++) {
        const r = rankWaiverMoves(cur, left, { ...env, openSpots: spots }, { top: 8 });
        const m = r.moves.slice().sort((a, b) => b.delta - a.delta)[0];
        if (!m)
          break;
        picked.push({ add: m.add, drop: m.drop });
        cur = (m.drop ? cur.filter((p) => p.id !== m.drop.id) : cur).concat(m.add);
        if (!m.drop)
          spots--;
        left = left.filter((p) => p.id !== m.add.id);
      }
      const after = scoreRoster(cur, env);
      const none = picked.length === 0 ? { note: "No add helps this week: every candidate move lowers or leaves unchanged your weekly win chance." } : {};
      bestUse = {
        adds_left: w.adds_left,
        moves: picked.map((p) => ({ add: p.add.name, drop: p.drop?.name ?? null })),
        week_win_pct: winPct(after.weekWin),
        delta_points: pct1(after.weekWin - base.weekWin),
        ...none,
        ...picked.length > 0 && moves.length > w.adds_left ? { note: `You have ${w.adds_left} add(s) left and ${moves.length} ranked moves: this is the best group of moves within your adds, chosen by re-simulating the combined roster.` } : {}
      };
    }
  }
  return {
    weeks_used: st.weeksUsed,
    games_source: st.gamesSource,
    schedule_incomplete: st.scheduleIncomplete,
    baseline_week_win_pct: winPct(base.weekWin),
    moves: moves.map((m) => ({
      add: m.add.name,
      drop: m.drop?.name ?? null,
      week_win_pct: winPct(m.after.weekWin),
      delta_points: pct1(m.delta),
      drop_only_points: pct1(m.dropOnlyDelta),
      add_effect_points: pct1(m.addDelta),
      add_confidence: m.add.confidence ?? "none",
      add_games_basis: Math.round(m.add.effectiveGames ?? 0),
      categories_delta_points: catDelta(m.categoryDelta)
    })),
    ...bestUse ? { best_use_of_adds: bestUse } : {},
    il_moves: plan.moved,
    open_spots: plan.openSpots,
    injury_notes: notes,
    not_ranked: unranked.map((u) => explainUnranked(u, roster, st.env.slots)),
    names,
    assumptions: [...st.assumptions, ...extra, "Moves are ranked by what the added player contributes beyond the drop. A player who would not enter your lineup, or who adds nothing beyond removing the drop, is listed as not ranked."]
  };
}
function runTrade(input, snapshot, reference, currentSeason, baseline) {
  return tradeWith(input, snapshot, moveSetup(input, input.trade, snapshot, reference, currentSeason, baseline));
}
function tradeWith(input, snapshot, st) {
  const t = input.trade;
  const names = [];
  const notes = [];
  const ctx = { asOf: asOfOf(input, snapshot), ramp: input.ramp, notes };
  const mine = resolveList(input.roster, snapshot, st.estimated, names, "", ctx);
  const theirs = t.other_roster ? resolveList(t.other_roster, snapshot, st.estimated, names, " (other team)", ctx) : [];
  if (mine.length === 0)
    throw new Error("none of the roster players could be matched");
  const slotMode = Boolean(st.env.slotList);
  const noPos = [...mine, ...theirs].filter((p) => !p.positions).map((p) => p.name);
  const checkSlots = slotMode && noPos.length === 0;
  const env = { ...st.env, checkSlots };
  const slotNote = slotMode ? [checkSlots ? "Trades that would leave a required lineup slot with nobody eligible are not recommended." : `WARNING: no positions were given for ${noPos.slice(0, 6).join(", ")}${noPos.length > 6 ? ", ..." : ""}, so they only fill UTIL and the check for empty required slots is OFF.`] : [];
  const base = { weeks_used: st.weeksUsed, games_source: st.gamesSource, schedule_incomplete: st.scheduleIncomplete, injury_notes: notes, names };
  if (t.search) {
    if (theirs.length === 0)
      throw new Error("trade.search needs trade.other_roster");
    const offers = searchTrades(mine, theirs, env, { top: t.top ?? 5 });
    return {
      mode: "search",
      ...base,
      offers: offers.map((o) => ({
        give: o.give.name,
        get: o.get.name,
        you: side(o.mine.before, o.mine.after, o.mine.delta, o.mine.categoryDelta, o.mine.emptySlots),
        other_team: side(o.theirs.before, o.theirs.after, o.theirs.delta, o.theirs.categoryDelta, o.theirs.emptySlots)
      })),
      assumptions: [...st.assumptions, ...slotNote, "Offers are one-for-one swaps that raise your weekly win chance without lowering the other team's. They model the two rosters only: what the other owner actually values, and positions, are not modelled."]
    };
  }
  if (!t.give?.length || !t.get?.length)
    throw new Error("trade needs give and get (or search with other_roster)");
  const give = resolveList(t.give, snapshot, st.estimated, names, " (give)");
  const get = resolveList(t.get, snapshot, st.estimated, names, " (get)", ctx);
  const myIds = new Set(resolveList(input.roster.map((r) => ({ name: r.name })), snapshot, st.estimated, []).map((p) => p.id));
  const notMine = give.filter((p) => !myIds.has(p.id));
  if (notMine.length > 0)
    throw new Error(`you do not have: ${notMine.map((p) => p.name).join(", ")}`);
  const you = evaluateTrade(mine, give, get, env);
  const out = { mode: "evaluate", ...base, you: side(you.before, you.after, you.delta, you.categoryDelta, you.emptySlots), assumptions: [...st.assumptions, ...slotNote] };
  if (theirs.length > 0) {
    const them = evaluateTrade(theirs, get, give, env);
    out.other_team = side(them.before, them.after, them.delta, them.categoryDelta, them.emptySlots);
  }
  return out;
}

// src/cli.ts
var USAGE = `Usage: analyze.mjs --snapshot <snapshot.json | https://url> [--input <request.json>]
Reads a request as JSON from --input or stdin:
  {"league":{"teams":12,"roster_spots":13},"roster":[{"name":"Nikola Jokic"},{"name":"Max Strus","status":"IL"}]}
Prints the team assessment as JSON.`;
async function loadSnapshot(src) {
  if (!src.startsWith("https://"))
    return JSON.parse(readFileSync(src, "utf8"));
  const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
  if (!r.ok)
    throw new Error(`could not download the snapshot (HTTP ${r.status})`);
  return await r.json();
}
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
try {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
  } else {
    const snapPath = arg("--snapshot");
    if (!snapPath)
      throw new Error("missing --snapshot <file>");
    const snapshot = await loadSnapshot(snapPath);
    const inputPath = arg("--input");
    const input = JSON.parse(readFileSync(inputPath ?? 0, "utf8"));
    console.log(JSON.stringify(analyzeLeague(input, snapshot), null, 2));
  }
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), usage: USAGE }));
  process.exit(1);
}
