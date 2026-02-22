---
description: Generate a self-contained HTML dashboard report for APL optimization results across all roster builds.
argument-hint: "[--fidelity quick|standard|confirm] [--skip-sims]"
allowed-tools: Bash, Read, Glob, Grep
---

# Report Dashboard

Generate a self-contained HTML dashboard showing build rankings, hero tree comparison, talent costs, and optimization history.

## Usage

`/showcase [--fidelity quick|standard|confirm] [--skip-sims]`

Arguments: $ARGUMENTS

## Execution

1. Determine spec from `SPEC` env var or `--spec` flag
2. Parse fidelity and flags from arguments (default: `standard`)
3. Run the report generator:

```bash
SPEC=$SPEC node src/visualize/report.js --fidelity $FIDELITY
```

Use `--skip-sims` to regenerate HTML from cached DB data without running sims.

4. Report the output location: `results/{spec}/report/index.html`
5. Open in browser if possible: `open results/{spec}/report/index.html`

## What the Report Shows

- **Key stats**: Best overall build, APL improvement %, hero tree gap
- **Best builds per scenario**: Best weighted, 1T, 5T, 10T with copy-hash buttons
- **Hero tree comparison**: Side-by-side bar chart, top 3 builds per tree
- **Build rankings**: All builds sortable by any column, hero tree filter, TOP badges
- **Talent impact**: Cluster costs (dropping clusters vs reference), talent policy (locked/banned/excluded)
- **Optimization journey**: Chronological table of accepted iterations with impact bars

## Architecture

- Uses **profileset mode** (`generateRosterProfilesetContent` + `runProfilesetAsync`) for all roster builds
- 3-6 total sims: our APL x 3 scenarios (+ baseline if present)
- Results stored in DB: our DPS in `dps_*` columns, baseline in `simc_dps_*` columns
- `--skip-sims` reads DPS from DB without any sim runs
- Dark theme, self-contained HTML (inline CSS + JS, Inter font from Google Fonts)
- Interactive: sortable columns, hero tree filter, copy-to-clipboard, collapsible sections

## Notes

- Standard fidelity takes ~5-10 minutes for a full roster
- Quick fidelity (~2 min) is good for iteration previews
- The report reads optimization history from the database (`theorycraft.db`)
