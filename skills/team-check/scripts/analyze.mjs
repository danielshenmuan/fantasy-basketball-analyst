#!/usr/bin/env node

// src/cli.ts
import { readFileSync } from "node:fs";

// src/types.ts
var CATEGORIES = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"];

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
var MADE = ["fgm", "ftm"];
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
  const made = { fgm: { acc: 0, w: 0 }, ftm: { acc: 0, w: 0 } };
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
      const v = s.averages[f];
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
  const spots = benchmark.settings.rosterSpots;
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
      note = "More players than roster spots: not counted.";
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
  const empty = spots - Math.min(spots, actives.length);
  for (let i = 0;i < empty; i++)
    for (const c of CATEGORIES)
      sums[c] += benchmark.poolMean[c];
  if (empty > 0)
    assumptions.push(`${empty} empty roster slot(s) counted as an average rostered player.`);
  const currentOnly = players.filter((p) => p.counted && rows.find((x) => x.r.name === p.name)?.est.currentSeasonOnly).length;
  if (currentOnly > 0)
    assumptions.push(`${currentOnly} player(s) with no completed NBA seasons are judged on this season only; small samples can swing.`);
  const noData = players.filter((p) => p.counted && p.confidence === "none").length;
  if (noData > 0)
    assumptions.push(`${noData} player(s) with no NBA data counted as an average rostered player.`);
  assumptions.push(`Players are estimated from their last three seasons, weighted by recency (${RECENCY_WEIGHTS.join(" / ")}) and games played (capped at ${GAMES_CAP} per season). Aging and role changes are not modelled.`, `Benchmark: ${benchmark.settings.teams} teams x ${spots} roster spots, ${benchmark.leagues} simulated snake drafts, each pick one of the best ${benchmark.pickWeights.length} remaining. Positions are ignored.`, "Every counted player's production is summed; daily lineup limits are not modelled.", `Bands by percentile among simulated teams: elite >= ${cut.elite}, strong >= ${cut.strong}, neutral >= ${cut.neutral}, otherwise weak.`);
  const categories = {};
  for (const c of CATEGORIES) {
    const b = benchmark.teamSums[c];
    const percentile = percentileOf(b, sums[c]);
    categories[c] = { total: sums[c], percentile, band: bandFor(percentile, cut), benchmark: { p15: at(b, 15), median: at(b, 50), p85: at(b, 85) } };
  }
  return { categories, players, assumptions, engine_version: ENGINE_VERSION };
}

// src/baseline.ts
function std(xs, mean) {
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}
var avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function buildBaseline(players, poolSize) {
  const pool = [...players].sort((a, b) => b.gp * b.mpg - a.gp * a.mpg).slice(0, poolSize);
  if (pool.length === 0)
    throw new Error("buildBaseline: no players");
  const col = (f) => pool.map(f);
  const pts = col((p) => p.averages.pts), reb = col((p) => p.averages.reb), ast = col((p) => p.averages.ast);
  const stl = col((p) => p.averages.stl), blk = col((p) => p.averages.blk), fg3m = col((p) => p.averages.fg3m);
  const fgp = col((p) => p.averages.fg_pct), ftp = col((p) => p.averages.ft_pct), tov = col((p) => p.averages.turnovers);
  const m = {
    m_pts: avg(pts),
    m_reb: avg(reb),
    m_ast: avg(ast),
    m_stl: avg(stl),
    m_blk: avg(blk),
    m_fg3m: avg(fg3m),
    m_fg_pct: avg(fgp),
    m_ft_pct: avg(ftp),
    m_tov: avg(tov)
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
      s_fg_imp: std(fgImpact, avg(fgImpact)),
      s_ft_imp: std(ftImpact, avg(ftImpact))
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

// src/simulate.ts
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
  const pool = [...players].sort((a, b) => b.total - a.total).slice(0, poolSize);
  if (pool.length < poolSize)
    throw new Error(`simulateBenchmark: need ${poolSize} players, got ${pool.length}`);
  const rand = mulberry32(opts.seed ?? 1);
  const sums = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  for (let l = 0;l < leagues; l++) {
    const remaining = pool.slice();
    const team = Array.from({ length: teams }, () => Object.fromEntries(CATEGORIES.map((c) => [c, 0])));
    for (let round = 0;round < rosterSpots; round++) {
      for (let k = 0;k < teams; k++) {
        const t = round % 2 === 0 ? k : teams - 1 - k;
        const [p] = remaining.splice(pickIndex(remaining.length, weights, rand), 1);
        for (const c of CATEGORIES)
          team[t][c] += p.z[c];
      }
    }
    for (const t of team)
      for (const c of CATEGORIES)
        sums[c].push(t[c]);
  }
  for (const c of CATEGORIES)
    sums[c].sort((a, b) => a - b);
  const poolMean = Object.fromEntries(CATEGORIES.map((c) => [c, pool.reduce((t, p) => t + p.z[c], 0) / pool.length]));
  return { settings, leagues, pickWeights: weights, teamSums: sums, poolMean };
}

// src/snapshot.ts
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
function resolvePlayer(query, players) {
  const q = nameTokens(query);
  if (q.length === 0)
    return { status: "not_found" };
  const key = q.join(" ");
  const pick = (hits) => hits.length === 1 ? { status: "matched", player: hits[0] } : hits.length > 1 ? { status: "ambiguous", candidates: hits } : { status: "not_found" };
  const alias = players.filter((p) => (p.aliases ?? []).some((a) => nameTokens(a).join(" ") === key));
  if (alias.length)
    return pick(alias);
  const exact = players.filter((p) => nameTokens(p.name).join(" ") === key);
  if (exact.length)
    return pick(exact);
  return pick(players.filter((p) => prefixMatch(q, nameTokens(p.name))));
}
function historyOf(p) {
  return { player_id: p.id, name: p.name, seasons: p.seasons };
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
  const lineup = [...players].sort((a, b) => b.value - a.value).slice(0, slots);
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
    const a = outcome(me, luck, g, scale), b = outcome(opp, luck, g, scale);
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

// src/moves.ts
function scoreRoster(roster, env, simWeeks = env.simWeeks) {
  const pad = Math.max(0, env.slots - roster.length);
  const list = pad > 0 ? [...roster, ...Array(pad).fill(env.replacement)] : roster;
  let week = 0;
  const cats = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const w of env.weeks) {
    const totals = weeklyTotals(list.map((p) => ({ averages: p.averages, games: w.gamesFor(p.team), value: p.value })), env.slots);
    const r = simulateWeeks(totals, w.opponents, { weeks: simWeeks, seed: env.seed, slots: env.slots });
    week += r.weekWin;
    for (const c of CATEGORIES)
      cats[c] += r.categories[c];
  }
  const n = env.weeks.length;
  for (const c of CATEGORIES)
    cats[c] /= n;
  return { weekWin: week / n, categories: cats };
}
var diff = (a, b) => Object.fromEntries(CATEGORIES.map((c) => [c, a.categories[c] - b.categories[c]]));
function rankWaiverMoves(roster, candidates, env, opts = {}) {
  const droppable = opts.droppable ?? roster;
  const top = opts.top ?? 8;
  const quick = opts.quickWeeks ?? Math.min(env.simWeeks, 3000);
  const base = scoreRoster(roster, env, quick);
  const best = [];
  for (const add of candidates) {
    let pick = null;
    for (const drop of droppable) {
      const next = roster.filter((p) => p.id !== drop.id).concat(add);
      const win = scoreRoster(next, env, quick).weekWin;
      if (!pick || win > pick.win || win === pick.win && drop.value < pick.drop.value)
        pick = { add, drop, win };
    }
    if (pick)
      best.push(pick);
  }
  best.sort((a, b) => b.win - a.win);
  const baseline = scoreRoster(roster, env);
  const moves = best.slice(0, top).map(({ add, drop }) => {
    const after = scoreRoster(roster.filter((p) => p.id !== drop.id).concat(add), env);
    return { add, drop, after, delta: after.weekWin - baseline.weekWin, categoryDelta: diff(after, baseline) };
  });
  moves.sort((a, b) => b.delta - a.delta);
  return { baseline, moves };
}
function evaluateTrade(roster, give, get, env) {
  const giveIds = new Set(give.map((p) => p.id));
  const before = scoreRoster(roster, env);
  const after = scoreRoster(roster.filter((p) => !giveIds.has(p.id)).concat(get), env);
  return { before, after, delta: after.weekWin - before.weekWin, categoryDelta: diff(after, before) };
}
function searchTrades(mine, theirs, env, opts = {}) {
  const quick = opts.quickWeeks ?? Math.min(env.simWeeks, 2000);
  const minTheirs = opts.minTheirDelta ?? 0;
  const baseMine = scoreRoster(mine, env, quick).weekWin, baseTheirs = scoreRoster(theirs, env, quick).weekWin;
  const found = [];
  for (const give of mine)
    for (const get of theirs) {
      const dm = scoreRoster(mine.filter((p) => p.id !== give.id).concat(get), env, quick).weekWin - baseMine;
      if (dm <= 0)
        continue;
      const dt = scoreRoster(theirs.filter((p) => p.id !== get.id).concat(give), env, quick).weekWin - baseTheirs;
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
function analyze(input, snapshot) {
  check(input);
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
    return { id: p.player_id, z, total: CATEGORIES.reduce((t, c) => t + z[c], 0) };
  });
  const benchmark = simulateBenchmark(sim, { teams, rosterSpots: roster_spots }, { leagues: input.leagues ?? 500, seed: input.seed ?? 1 });
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
    ...matchup ? { matchup } : {},
    ...waiver ? { waiver } : {},
    ...trade ? { trade } : {}
  };
}
function runMatchup(input, snapshot, reference, currentSeason, baseline, mineNames) {
  const m = input.matchup;
  const { teams, roster_spots } = input.league;
  const slots = m.lineup_slots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20)
    throw new Error("matchup.lineup_slots must be a whole number from 1 to 20");
  const assumptions = [];
  const weekStart = m.week_start ?? mondayOf(snapshot.generated_at);
  const week = snapshot.schedule?.weeks.find((w) => w.start === weekStart);
  const gamesFor = (team) => week && team ? week.games[team] ?? 0 : DEFAULT_WEEK_GAMES;
  const fromSchedule = Boolean(week);
  assumptions.push(fromSchedule ? `Games per player come from the NBA schedule for the week of ${weekStart}. Injuries and rest days are not modelled.` : `No schedule for the week of ${weekStart} in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games. A real week with more or fewer games changes the picture.`);
  const estimated = new Map;
  for (const p of snapshot.players) {
    const e = estimateAverages(historyOf(p), reference, { current: currentSeason });
    if (!e.averages)
      continue;
    const z = categoryZ(e.averages, baseline);
    estimated.set(p.id, { name: p.name, averages: e.averages, team: p.team, value: CATEGORIES.reduce((t, c) => t + z[c], 0) });
  }
  const weeklyOf = (list, label) => {
    const names2 = [];
    const players = [];
    for (const r2 of list) {
      const hit = resolvePlayer(r2.name, snapshot.players);
      if (hit.status === "matched") {
        names2.push({ input: r2.name, status: "matched", matched: hit.player.name });
        const e = estimated.get(hit.player.id);
        if (r2.status !== "IL" && e)
          players.push({ averages: e.averages, games: gamesFor(e.team), value: e.value });
      } else if (hit.status === "ambiguous") {
        names2.push({ input: r2.name, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
      } else
        names2.push({ input: r2.name, status: "not_found" });
    }
    const missing = names2.filter((n) => n.status !== "matched").length;
    if (missing > 0)
      assumptions.push(`${missing} player(s) in the ${label} roster could not be matched and are left out of the weekly totals.`);
    return { totals: weeklyTotals(players, slots), names: names2 };
  };
  const me = weeklyOf(input.roster, "your");
  let opponents;
  let names = me.names;
  if (m.opponent && m.opponent.length > 0) {
    const o = weeklyOf(m.opponent, "opponent");
    opponents = [o.totals];
    names = [...me.names, ...o.names.map((n) => ({ ...n, input: `${n.input} (opponent)` }))];
  } else {
    const pool = [...estimated.values()];
    opponents = typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 300, seed: input.seed ?? 1 });
    assumptions.push(`Typical opponents: ${opponents.length} teams from ${300} simulated ${teams}-team drafts, each playing its best ${slots} players. Positions are ignored.`);
  }
  const weeks = m.weeks ?? DEFAULT_WEEKS;
  const r = simulateWeeks(me.totals, opponents, { weeks, seed: input.seed ?? 1, slots });
  assumptions.push(`Week-to-week luck is measured on 2025-26 weekly results after removing game counts. ${weeks} simulated weeks, fixed seed, so the same inputs give the same answer. ` + `The simulation does not model injuries, lineup moves or streaming during the week.`);
  const pct = (x) => Math.round(x * 100);
  return {
    week_start: week ? weekStart : null,
    games_source: fromSchedule ? "schedule" : "assumed",
    opponent: m.opponent && m.opponent.length > 0 ? "roster" : "typical",
    lineup_slots: slots,
    weeks,
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, pct(r.categories[c])])),
    week_win_pct: pct(r.weekWin),
    distribution_pct: r.distribution.map(pct),
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
    out.set(p.id, { id: p.id, name: p.name, averages: e.averages, team: p.team, value: CATEGORIES.reduce((t, c) => t + z[c], 0) });
  }
  return out;
}
function moveSetup(input, common, snapshot, reference, currentSeason, baseline) {
  const { teams, roster_spots } = input.league;
  const slots = common.lineup_slots ?? roster_spots;
  if (!Number.isInteger(slots) || slots < 1 || slots > 20)
    throw new Error("lineup_slots must be a whole number from 1 to 20");
  const horizon = Math.max(1, Math.min(4, common.horizon_weeks ?? 2));
  const simWeeks = common.weeks ?? 6000;
  const estimated = estimatePlayers(snapshot, reference, currentSeason, baseline);
  const pool = [...estimated.values()].sort((a, b) => b.value - a.value);
  if (pool.length < teams * roster_spots)
    throw new Error(`snapshot has only ${pool.length} players; need at least ${teams * roster_spots}`);
  const replacement = pool[teams * roster_spots - 1];
  const first = mondayOf(snapshot.generated_at);
  const scheduled = (snapshot.schedule?.weeks ?? []).filter((w) => w.start >= first).slice(0, horizon);
  const assumptions = [];
  const seed = input.seed ?? 1;
  const mk = (start, games) => {
    const gamesFor = (team) => games && team ? games[team] ?? 0 : DEFAULT_WEEK_GAMES;
    return { start, gamesFor, opponents: typicalOpponents(pool, { teams, rosterSpots: roster_spots }, slots, gamesFor, { leagues: 150, seed }) };
  };
  const weeks = scheduled.length > 0 ? scheduled.map((w) => mk(w.start, w.games)) : [mk(null, null)];
  const gamesSource = scheduled.length > 0 ? "schedule" : "assumed";
  assumptions.push(gamesSource === "schedule" ? `Averaged over ${weeks.length} week(s) starting ${weeks[0].start}, counting each player's real games from the NBA schedule.` : `No schedule in the data, so every player gets an average week of ${DEFAULT_WEEK_GAMES} games.`, `Each score is a weekly win chance against typical opponents (${weeks[0].opponents.length} teams from simulated ${teams}-team drafts, positions ignored), ${simWeeks} simulated weeks with a fixed seed. ` + `A move is scored by re-running the same weeks with the roster changed, so the difference is the move's effect. Injuries, rest days and lineup moves during the week are not modelled. An empty lineup spot is filled by a replacement-level player.`);
  return { env: { slots, weeks, simWeeks, seed, replacement }, estimated, weeksUsed: weeks.map((w) => w.start ?? "assumed"), gamesSource, assumptions };
}
function resolveList(list, snapshot, estimated, names, suffix = "") {
  const out = [];
  for (const r of list) {
    const hit = resolvePlayer(r.name, snapshot.players);
    if (hit.status === "matched") {
      names.push({ input: r.name + suffix, status: "matched", matched: hit.player.name });
      const e = estimated.get(hit.player.id);
      if (e && r.status !== "IL")
        out.push(e);
    } else if (hit.status === "ambiguous") {
      names.push({ input: r.name + suffix, status: "ambiguous", candidates: hit.candidates.map((c) => ({ id: c.id, name: c.name, latest_season: c.seasons[0]?.season ?? "" })) });
    } else
      names.push({ input: r.name + suffix, status: "not_found" });
  }
  return out;
}
var pct1 = (x) => Math.round(x * 1000) / 10;
var catDelta = (d) => Object.fromEntries(CATEGORIES.map((c) => [c, pct1(d[c])]));
var side = (b, a, delta, cd) => ({
  before_week_win_pct: Math.round(b.weekWin * 100),
  after_week_win_pct: Math.round(a.weekWin * 100),
  delta_points: pct1(delta),
  categories_delta_points: catDelta(cd)
});
function runWaiver(input, snapshot, reference, currentSeason, baseline) {
  const w = input.waiver;
  if (!Array.isArray(w.candidates) || w.candidates.length === 0)
    throw new Error("waiver.candidates must list at least one available player");
  if (w.candidates.length > 60)
    throw new Error("waiver.candidates has more than 60 players; send the best available");
  const st = moveSetup(input, w, snapshot, reference, currentSeason, baseline);
  const names = [];
  const roster = resolveList(input.roster, snapshot, st.estimated, names);
  const mine = new Set(roster.map((p) => p.id));
  const cands = resolveList(w.candidates, snapshot, st.estimated, names, " (available)").filter((p) => !mine.has(p.id));
  if (roster.length === 0)
    throw new Error("none of the roster players could be matched");
  const { baseline: base, moves } = rankWaiverMoves(roster, cands, st.env, { top: w.top ?? 8 });
  return {
    weeks_used: st.weeksUsed,
    games_source: st.gamesSource,
    baseline_week_win_pct: Math.round(base.weekWin * 100),
    moves: moves.map((m) => ({ add: m.add.name, drop: m.drop.name, week_win_pct: Math.round(m.after.weekWin * 100), delta_points: pct1(m.delta), categories_delta_points: catDelta(m.categoryDelta) })),
    names,
    assumptions: st.assumptions
  };
}
function runTrade(input, snapshot, reference, currentSeason, baseline) {
  const t = input.trade;
  const st = moveSetup(input, t, snapshot, reference, currentSeason, baseline);
  const names = [];
  const mine = resolveList(input.roster, snapshot, st.estimated, names);
  const theirs = t.other_roster ? resolveList(t.other_roster, snapshot, st.estimated, names, " (other team)") : [];
  if (mine.length === 0)
    throw new Error("none of the roster players could be matched");
  const base = { weeks_used: st.weeksUsed, games_source: st.gamesSource, names };
  if (t.search) {
    if (theirs.length === 0)
      throw new Error("trade.search needs trade.other_roster");
    const offers = searchTrades(mine, theirs, st.env, { top: t.top ?? 5 });
    return {
      mode: "search",
      ...base,
      offers: offers.map((o) => ({
        give: o.give.name,
        get: o.get.name,
        you: side(o.mine.before, o.mine.after, o.mine.delta, o.mine.categoryDelta),
        other_team: side(o.theirs.before, o.theirs.after, o.theirs.delta, o.theirs.categoryDelta)
      })),
      assumptions: [...st.assumptions, "Offers are one-for-one swaps that raise your weekly win chance without lowering the other team's. They model the two rosters only: what the other owner actually values, and positions, are not modelled."]
    };
  }
  if (!t.give?.length || !t.get?.length)
    throw new Error("trade needs give and get (or search with other_roster)");
  const give = resolveList(t.give, snapshot, st.estimated, names, " (give)");
  const get = resolveList(t.get, snapshot, st.estimated, names, " (get)");
  const myIds = new Set(mine.map((p) => p.id));
  const notMine = give.filter((p) => !myIds.has(p.id));
  if (notMine.length > 0)
    throw new Error(`you do not have: ${notMine.map((p) => p.name).join(", ")}`);
  const you = evaluateTrade(mine, give, get, st.env);
  const out = { mode: "evaluate", ...base, you: side(you.before, you.after, you.delta, you.categoryDelta), assumptions: st.assumptions };
  if (theirs.length > 0) {
    const them = evaluateTrade(theirs, get, give, st.env);
    out.other_team = side(them.before, them.after, them.delta, them.categoryDelta);
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
    console.log(JSON.stringify(analyze(input, snapshot), null, 2));
  }
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), usage: USAGE }));
  process.exit(1);
}
