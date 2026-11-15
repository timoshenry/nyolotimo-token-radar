[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/timoshenry/nyolotimo-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/timoshenry/nyolotimo-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Signal / Token Radar

An offline, repeatable research board for `token-radar-01`. It reads the competition's frozen snapshot, estimates implied market-cap scenarios for eligible pre-token records, and shows token-bearing records separately as comparables. A blank token field is evidence about this snapshot; it does not prove current token status, an upcoming launch, or an incentive program.

## Reproduce the build

Use Node.js 22.18 or newer. Pass either the snapshot file or its containing directory. The output directory must be separate from the repository and snapshot.

```sh
node main.ts --input /path/to/snapshot.json --output /tmp/token-radar-out
# A directory input resolves to <directory>/snapshot.json:
node main.ts --input /path/to/input --output /tmp/token-radar-out
# In the competition image:
node main.ts --input /input/snapshot.json --output /output
```

The command validates the sealed ten-field record shape, unique slugs, dates, numeric fields and watchlist references before scoring. It rejects unknown or repeated flags and refuses output paths that overlap source assets or the input. Identical in-memory scoring passes must agree before files are written.

`--help` prints usage without reading the snapshot. `--input` and `--output` each accept one non-empty value (either as `--flag value` or `--flag=value`); unknown flags, duplicate flags, missing values, regular-file outputs and output symlinks are rejected. Output must be a real directory path outside the repository source/dashboard/screenshots and must not overwrite or contain the input snapshot.

Open `out/dashboard/index.html` from its generated folder. The bundled page uses local `data.js`, has no network dependency, and exposes evidence in each row's detail panel. `board.json` contains the ranked rows; `data.js` carries those same rows plus live references and model notes. `dossier.json` is produced last from the managed output using the supplied make.fun library. Builds replace generated `dashboard/` and `screenshots/` subfolders and refresh the board artifacts.

## What is ranked

Eligibility starts with records whose market cap, CoinGecko ID and symbol are all null. A conservative lexical screen removes exchange products, versioned deployments and explicit wrapped, staked, bridged or derivative markers. The snapshot watchlist is mandatory coverage, including any pre-token watchlist entry caught by that stricter screen. Other eligible records can be added below the watchlist floor. The current sealed snapshot produces 197 ranked rows; this count describes this input, not a target the code fills.

Token-bearing records provide observed peer ratios and a separate live-reference view. For each candidate, the model uses positive market-cap/TVL ratios from token-bearing records. It selects at least three exact-category peers if possible; otherwise it tries the same first category word, then the global token-bearing cohort. It takes the median and clamps the resulting anchor to 0.01–2.5. The detail panel shows the cohort label, count and up to eight stable sample slugs.

## How to read an estimate

The central scenario is TVL × peer median × capped seven-day TVL movement × tracking-age maturity × category risk × category competition × chain breadth × TVL-quality factor × dilution factor. The last two factors are disclosed constants (0.82 and 0.72), not measured properties: the snapshot has no TVL-quality or future-supply fields. The category, competition and chain factors are also heuristics. Model constants and per-row multipliers are included in the generated data.

The estimate is an implied market-cap scenario, not a token price, target, forecast or issuance probability. Its low/high band is a sensitivity range, not a statistically calibrated interval. Confidence reflects peer count and the availability of age and TVL-change fields; it is not confidence that a token will launch. TVL measures deposits attributed to a protocol, not revenue, ownership or value accruing to a future token. Tracking age is not a verified launch date, and a one-week TVL change can reverse.

The checklist is a set of conditional research prompts inferred from category and chain fields. Product availability, official domains, contract addresses, incentives, eligibility, jurisdiction and withdrawal terms are not verified by this offline snapshot. Recheck them independently; no step is necessary to obtain a reward.

## Validation

```sh
node scripts/validate-build.mjs
# The process-level CLI checks can also be run on their own:
node scripts/test-cli.mjs /path/to/snapshot.json
```

The validator builds twice in temporary directories and compares every artifact byte. It also checks row eligibility, rank order, watchlist coverage, checklist bounds, offline dashboard assets, screenshot format/geometry/size, and the generated dossier against the vendored builder, then runs the child-process CLI safety regression suite. The CLI tests cover directory-form input, `--input=` and `--output=` options, malformed JSON, invalid protocol shape, and preservation of output contents when snapshot validation rejects input. Both test commands accept the snapshot path as an optional first argument when the default kit path is unavailable.

MIT licensed. Snapshot and kit materials are supplied by make.fun.
[exit status 0]