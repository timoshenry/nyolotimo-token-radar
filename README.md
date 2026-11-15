[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/timoshenry/nyolotimo-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/timoshenry/nyolotimo-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Bounty:** [Build the best token launch radar on make.fun](https://make.fun/bounty/token-radar-01)

# Signal / Token Radar

A reproducible, offline research dashboard for the `token-radar-01` make.fun bounty.

The program reads the sealed DefiLlama snapshot and ranks protocols whose snapshot records contain no token fields. It keeps live-token references separate, uses category-matched tokenized peers to derive disclosed implied-value scenarios, and exposes source fields, adjustments, uncertainty bands, and practical risk-aware farm plans.

## Run

Requires Node.js 22.18+ (Node 24 works):

```bash
node main.ts --input /path/to/snapshot.json --output ./out
```

The grader mounts `/input/snapshot.json` and `/output`; locally, `--input` and `--output` can point to equivalent paths.

## Model notes

- “No token recorded” means only that the frozen snapshot has blank market-cap, CoinGecko ID, and symbol fields. It is not proof that no token exists today.
- Live-token protocols are displayed separately and never ranked as pre-token opportunities.
- Implied values are model scenarios, not token-price forecasts, launch probabilities, or promises of airdrops.
- The peer multiple, growth/maturity adjustments, risk haircuts, and uncertainty band are disclosed in each protocol's detail view.
- The dashboard is static and makes no network requests.

## Validation

```bash
node scripts/validate-build.mjs
```

This performs two deterministic builds and checks watchlist coverage, farm plans, screenshots, dossier generation, and the offline dashboard constraint.

MIT licensed. Snapshot data and bounty materials are supplied by make.fun for this competition.
