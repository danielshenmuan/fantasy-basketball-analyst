#!/usr/bin/env node
// Which NBA teams play on each day between two dates (inclusive), from the public ESPN scoreboard.
// Usage: node season-days.mjs 2026-11-23 2027-04-12   ->   {"from":"...","to":"...","days":{"2026-11-23":["ATL","BOS",...],...}}
// Paste the "days" object into the analyzer request as `schedule_days` (used for injury scenarios, daily lineups and the
// season outlook), or let the nightly data file carry it as `schedule.days`. Team codes match the analyst's data file.
const FIX = { WSH: "WAS", NY: "NYK", GS: "GSW", NO: "NOP", SA: "SAS", UTAH: "UTA" };
const [from, to] = process.argv.slice(2);
const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
if (!ok(from) || !ok(to) || from > to) {
  console.error("usage: node season-days.mjs YYYY-MM-DD YYYY-MM-DD");
  process.exit(1);
}
const dates = [];
for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
if (dates.length > 400) { console.error("range longer than 400 days"); process.exit(1); }
const days = {};
let next = 0, failed = 0;
async function worker() {
  while (next < dates.length) {
    const date = dates[next++];
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replaceAll("-", "")}`);
    if (!res.ok) { console.error(`schedule request failed for ${date}: ${res.status}`); failed++; continue; }
    const { events = [] } = await res.json();
    const teams = new Set();
    for (const e of events) for (const c of e.competitions?.[0]?.competitors ?? []) teams.add(FIX[c.team.abbreviation] ?? c.team.abbreviation);
    if (teams.size) days[date] = [...teams].sort();
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
if (failed) process.exit(2);
console.log(JSON.stringify({ from, to, days: Object.fromEntries(Object.entries(days).sort()) }));
