---
description: Run npm run build-data to regenerate all data files for the active spec.
---

Run `npm run build-data` to regenerate all data files for the active spec.

## Setup

Run `node src/engine/startup-cli.js` to determine the active spec.

## After the Build

1. Check output counts against expected values (from Raidbots). Expected counts vary by spec — compare against the Raidbots talent data to verify node counts, choice node expansion, and spell coverage.
2. Run `npm run verify` to validate — expect 0 failures
3. Report any changes from previous build (new spells, removed talents, count shifts)

Output files will be in `data/{spec}/`.
