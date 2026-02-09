---
description: Generate a self-contained HTML showcase report comparing baseline vs optimized APL across all roster builds.
argument-hint: "[--fidelity quick|standard|confirm]"
---

# Showcase Report

Generate a self-contained HTML showcase report comparing the baseline SimC APL against our optimized APL across all roster builds.

## Usage

`/showcase [--fidelity quick|standard|confirm]`

Arguments: $ARGUMENTS

## Execution

1. Determine spec from `SPEC` env var or `--spec` flag
2. Parse fidelity from arguments (default: `standard`)
3. Run the showcase generator:

```bash
SPEC=$SPEC node src/visualize/showcase.js --fidelity $FIDELITY
```

4. Report the output location: `results/{spec}/showcase/index.html`
5. Open in browser if possible: `open results/{spec}/showcase/index.html`

## What the Report Shows

- **Per-build DPS comparison**: Baseline vs optimized across all roster builds
- **Per-scenario breakdown**: ST (1T), small AoE (5T), big AoE (10T) + weighted
- **APL structural diff**: Added/removed/modified action lists and variables
- **Build rankings**: Overall, per hero tree, per scenario
- **Optimization changelog**: Accepted iterations with theory attribution and DPS deltas
- **Community builds**: Included from roster (source `community:*`)

## Notes

- The report is self-contained HTML — no external dependencies
- Standard fidelity takes ~5-10 minutes for a full roster
- Quick fidelity (~2 min) is good for iteration previews
- The report reads optimization history from the database (`theorycraft.db`)
