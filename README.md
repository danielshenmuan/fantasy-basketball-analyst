# fantasy-basketball-analyst

A free, open-source fantasy basketball analyst for AI agents (ChatGPT, Claude, and others).

It turns your league's rosters into plain answers: where your team is strong and weak in each category, who to pick up, and what trades make sense. Your agent reads your league; this project supplies the numbers and the method.

**Status:** early work in progress. The engine, the data file (published nightly) and three skills (`setup`, `team-check`, `matchup`) exist as a Claude plugin; pickup and trade advice are not built yet. To try the plugin: `/plugin marketplace add danielshenmuan/fantasy-basketball-analyst`, then install `fantasy-basketball-analyst`.

## Layout

- `engine/`: TypeScript engine (league baselines, simulated-league benchmark, team assessment) with tests. `bun test` runs them; `bun run build` writes the single-file script below. It also holds the weekly head-to-head matchup simulation (not yet exposed in a skill).
- `skills/`: the agent skills, packaged as one Claude plugin (`.claude-plugin/`). `setup` reads a league and saves a league card; `team-check` is the category health check (`scripts/analyze.mjs` is the engine bundled into one dependency-free file that runs on Node). More skills (matchup, waiver, trade) follow.

## What it will do

- **Team health check:** each category rated elite, strong, neutral or weak against a simulated league of your size.
- **Weekly matchup:** your chance to win each category and the week against your real opponent, counting each player's real games from the NBA schedule. See [docs/matchup-simulation.md](docs/matchup-simulation.md).
- **Pickups and trades:** suggestions based on the categories your team actually needs.
- **Honest about uncertainty:** rookies, injured players and small samples are flagged, not guessed silently.

## Data

Player numbers are computed from public box-score statistics and published nightly as one small file of per-season averages, each player's team and a four-week NBA schedule: `https://storage.googleapis.com/fantasy-survivors-analyst-data/snapshot.json`. League baselines are computed from it at run time because they depend on your league size. Raw game logs are not redistributed. A copy is bundled in `skills/team-check/data/snapshot.json` as an offline fallback; refresh it with `curl -o skills/team-check/data/snapshot.json <the URL above>`.

## License

MIT. See [LICENSE](LICENSE).
