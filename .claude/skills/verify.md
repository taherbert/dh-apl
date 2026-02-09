---
description: Run npm run verify and analyze the results. Fix issues, rebuild, and re-verify until clean.
---

Run `npm run verify` and analyze the results.

## Setup

Run `node src/engine/startup.js` to determine the active spec.

## Expected Baseline

0 failures, minimal warnings (unknown interaction rate ~5%, target 0%).

## Investigation

If there are failures or warnings beyond the known baseline, investigate each one:

- For missing talents: check if they exist in Raidbots data and SpellDataDump
- For stale talents: confirm they're absent from Raidbots
- For unknown interactions: look up the source spell in SpellDataDump
- For contamination: trace the leak path and fix the filter

Fix any issues found, rebuild data with `npm run build-data`, and re-verify until clean.

Data files are in `data/{spec}/`. Results are in `results/{spec}/`.
