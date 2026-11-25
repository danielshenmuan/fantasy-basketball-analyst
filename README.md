# fantasy-basketball-analyst

A free, open-source fantasy basketball analyst for AI agents (ChatGPT, Claude, and others).

It turns your league's rosters into plain answers: where your team is strong and weak in each category, who to pick up, and what trades make sense. Your agent reads your league; this project supplies the numbers and the method.

**Status:** early work in progress. The engine, the data file (published nightly) and six skills (`analyst`, the single entry point, plus `setup`, `team-check`, `matchup`, `waiver`, `trade`) exist as a Claude plugin. Draft and daily-lineup help are not built yet. To try the plugin: `/plugin marketplace add danielshenmuan/fantasy-basketball-analyst`, then install `fantasy-basketball-analyst`.

## Layout

- `engine/`: TypeScript engine (league baselines, simulated-league benchmark, team assessment) with tests. `bun test` runs them; `bun run build` writes the single-file script below. It also holds the weekly head-to-head matchup simulation and move scoring, used by the `matchup`, `waiver` and `trade` skills.
- `skills/`: the agent skills, packaged as one Claude plugin (`.claude-plugin/`). `analyst` is the entry point: it reads your saved league card, asks at most one question and runs the right skill below; `analyst/reading-a-league.md` is the shared guide for reading a league automatically (Yahoo pages, ESPN data endpoints, and the fallback ladder down to pasted text). `setup` reads a league and saves a league card; `team-check` is the category health check (`scripts/analyze.mjs` is the engine bundled into one dependency-free file that runs on Node). `matchup`, `waiver` and `trade` score a move by what it does to your weekly win chance.

## What it will do

- **Team health check:** each category rated elite, strong, neutral or weak against a simulated league of your size.
- **Weekly matchup:** your chance to win each category and the week against your real opponent, counting each player's real games from the NBA schedule. See [docs/matchup-simulation.md](docs/matchup-simulation.md).
- **Pickups and trades:** each add, drop or trade is scored by how much it changes your chance to win a week (and the other team's, for a trade). No opinions: every number is the difference between two simulations. See [docs/matchup-simulation.md](docs/matchup-simulation.md).
- **Honest about uncertainty:** rookies, injured players and small samples are flagged, not guessed silently.

## Data

Player numbers are computed from public box-score statistics and published nightly as one small file of per-season averages, each player's team and a four-week NBA schedule: `https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json`. League baselines are computed from it at run time because they depend on your league size. Raw game logs are not redistributed. A copy is bundled in `skills/team-check/data/snapshot.json` as an offline fallback; refresh it with `curl -o skills/team-check/data/snapshot.json <the URL above>`.

## License

MIT. See [LICENSE](LICENSE).
