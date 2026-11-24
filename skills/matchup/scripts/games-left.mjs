#!/usr/bin/env node
// Games each NBA team still plays between two dates (inclusive), from the public ESPN scoreboard.
// Usage: node games-left.mjs 2026-11-24 2026-11-29   ->   {"from":"...","to":"...","games":{"ATL":2,...}}
// Team codes match the analyst's data file (GSW, NYK, NOP, SAS, UTA, WAS ...).
const FIX = { WSH: "WAS", NY: "NYK", GS: "GSW", NO: "NOP", SA: "SAS", UTAH: "UTA" };
const [from, to] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? "")) {
  console.error("usage: node games-left.mjs YYYY-MM-DD YYYY-MM-DD");
  process.exit(1);
}
const games = {};
for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  const day = d.toISOString().slice(0, 10).replaceAll("-", "");
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day}`);
  if (!res.ok) { console.error(`schedule request failed for ${day}: ${res.status}`); process.exit(2); }
  const { events = [] } = await res.json();
  for (const e of events)
    for (const c of e.competitions?.[0]?.competitors ?? []) {
      const t = FIX[c.team.abbreviation] ?? c.team.abbreviation;
      games[t] = (games[t] ?? 0) + 1;
    }
}
console.log(JSON.stringify({ from, to, games }));
