---
description: Generate a self-contained HTML showcase report comparing baseline vs optimized APL across all roster builds.
argument-hint: "[--fidelity quick|standard|confirm] [--skip-sims]"
allowed-tools: Bash, Read, Glob, Grep
---

# Showcase Report

Generate a self-contained HTML showcase report comparing the baseline SimC APL against our optimized APL across the full roster (all builds).

## Usage

`/showcase [--fidelity quick|standard|confirm] [--skip-sims]`

Arguments: $ARGUMENTS

## Execution

1. Determine spec from `SPEC` env var or `--spec` flag
2. Parse fidelity and flags from arguments (default: `standard`)
3. Run the showcase generator:

```bash
SPEC=$SPEC node src/visualize/showcase.js --fidelity $FIDELITY
```

Use `--skip-sims` to regenerate HTML from cached DB data without running sims.

4. Report the output location: `results/{spec}/showcase/index.html`
5. Open in browser if possible: `open results/{spec}/showcase/index.html`

## What the Report Shows

- **Summary cards**: Average weighted improvement, per-scenario averages, best/worst build
- **Full roster table**: All builds grouped by hero tree, with per-scenario DPS + delta%
  - Baseline DPS shown on hover (tooltip)
  - TOP badge on per-scenario and per-tree winners
  - Column sorting (click headers)
  - Sticky headers for scrolling
- **APL structural diff**: Added/removed/modified action lists
- **Optimization changelog**: Accepted iterations with DPS deltas

## Architecture

- Uses **profileset mode** (`generateRosterProfilesetContent` + `runProfilesetAsync`) for all 69+ builds
- 6 total sims: 2 APLs (baseline + ours) x 3 scenarios
- Results stored in DB: our DPS in `dps_*` columns, baseline in `simc_dps_*` columns
- `--skip-sims` reads both sets of DPS from DB without any sim runs
- Dark theme, self-contained HTML (inline CSS + JS, no external deps)

## Notes

- Standard fidelity takes ~5-10 minutes for a full roster
- Quick fidelity (~2 min) is good for iteration previews
- The report reads optimization history from the database (`theorycraft.db`)
