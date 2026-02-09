Run simulations using `npm run sim`. Arguments: APL file path and optional scenario.

## Setup

Run `node src/engine/startup.js` to determine the active spec.

## Execution

If `$ARGUMENTS` provided, use as the APL file path. Otherwise default to `apls/{spec}/{spec}.simc`.

After sim completes, run `npm run analyze` and report key metrics:

- DPS numbers for each scenario
- Top damage sources
- Key buff uptimes
- Resource efficiency

Compare against baseline if available in the DB (`getFindings()`) or iteration state via `node src/sim/iterate.js status`.
