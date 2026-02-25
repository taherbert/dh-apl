---
description: Run simulations using npm run sim. Pass APL file path and optional scenario as arguments.
argument-hint: "[apl-file] [scenario]"
allowed-tools: Bash, Read, Glob, Grep
---

Run simulations using `npm run sim`. Arguments: APL file path and optional scenario.

> **For iteration testing** (results you intend to accept or reject), use `/sim-background` instead — it runs `iterate.js compare`, records results to the DB, and connects to `iterate.js accept/reject`. `/sim` is for ad-hoc exploration only; its results are not tracked.

## Setup

Run `node src/engine/startup-cli.js` to determine the active spec.

## Execution

If `$ARGUMENTS` provided, use as the APL file path. Otherwise default to `apls/{spec}/{spec}.simc`.

After sim completes, run `npm run analyze` and report key metrics:

- DPS numbers for each scenario
- Top damage sources
- Key buff uptimes
- Resource efficiency

Compare against baseline if available in the DB (`getFindings()`) or iteration state via `node src/sim/iterate.js status`.
