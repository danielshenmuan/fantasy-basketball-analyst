# fantasy-basketball-analyst

A free, open-source fantasy basketball analyst for AI agents (ChatGPT, Claude, and others).

It turns your league's rosters into plain answers: where your team is strong and weak in each category, who to pick up, and what trades make sense. Your agent reads your league; this project supplies the numbers and the method.

**Status:** early work in progress. The engine and the agent skill instructions exist; the daily data file they read is not published yet, so there is nothing to install today.

## Layout

- `engine/`: TypeScript engine (league baselines, simulated-league benchmark, team assessment) with tests. `bun test` runs them; `bun run build` writes the single-file script below.
- `skill/`: the agent skill. `SKILL.md` is the playbook; `scripts/analyze.mjs` is the engine bundled into one dependency-free file that runs on Node.

## What it will do

- **Team health check:** each category rated elite, strong, neutral or weak against a simulated league of your size.
- **Pickups and trades:** suggestions based on the categories your team actually needs.
- **Honest about uncertainty:** rookies, injured players and small samples are flagged, not guessed silently.

## Data

Player numbers are computed from public box-score statistics and published as a small daily snapshot (season averages and league baselines). Raw game logs are not redistributed.

## License

MIT. See [LICENSE](LICENSE).
