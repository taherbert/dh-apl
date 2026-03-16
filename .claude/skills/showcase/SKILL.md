---
description: Generate the APL optimization report dashboard — build rankings, hero tree comparison, talent costs, and optimization history. Use /gear to run the gear pipeline first.
argument-hint: "[--fidelity quick|standard|confirm] [--skip-sims] [--publish]"
allowed-tools: Bash, Read, Glob, Grep
---

# Report Dashboard

Generate a self-contained HTML dashboard showing APL build rankings, hero tree comparison, talent costs, and optimization history.

## Usage

`/showcase [--fidelity quick|standard|confirm] [--skip-sims] [--publish]`

Arguments: $ARGUMENTS

## Pre-checks

Run these before generating the report:

1. **Gear pipeline state** -- verify phases 0-11 are complete:

```bash
SPEC=${SPEC:-vengeance} node src/sim/gear.js status
```

If incomplete, warn the user and offer to run `/gear` first. The report renders partial data but gear sections will be empty.

2. **Roster validation** -- verify builds have archetypes and display names:

```bash
SPEC=${SPEC:-vengeance} npm run roster show
```

The report auto-classifies unclassified builds and auto-generates missing display names, so this is informational.

3. **Remote sim status** (skip if `--skip-sims`):

```bash
npm run remote:status
```

If not active and sims are needed, start it: `npm run remote:start`

## Execution

1. Determine spec from `SPEC` env var or `--spec` flag
2. Parse fidelity and flags from arguments (default: `standard`)
3. Run the report generator:

```bash
SPEC=${SPEC:-vengeance} npm run report:dashboard -- --fidelity $FIDELITY
```

Use `--skip-sims` to regenerate HTML from cached DB data without running new sims.

4. Report the output location: `results/{spec}/report/index.html`
5. Open in browser if possible: `open results/{spec}/report/index.html`

## Post-checks — MANDATORY

After the report generates, you MUST verify before showing results or publishing:

1. **DPS sanity check**: Top build weighted DPS must be in the expected range (140k-180k for VDH). If DPS is below 50k, the talent hashes are broken (missing hero talents). Do NOT publish.

2. **Section check**:

```bash
grep -c 'Build Rankings\|Trinket Rankings\|Talent Heatmap\|Embellishment Rankings' results/${SPEC:-vengeance}/report/index.html
```

Expected: at least 3-4 section headers present.

3. **Profile check** (if gear pipeline ran): Verify `profile.simc` against `gear-candidates.json` — gem counts, item names vs IDs, embellishment count = 2, no built-in emb items with extra embellishment tags.

4. **If ANY check fails**: Do NOT publish. Fix the issue or report it to the user.

## Publishing

If `--publish` is passed:

```bash
SPEC=${SPEC:-vengeance} npm run report:publish
```

## What the Report Shows

- **Key stats**: Best overall build, APL improvement %, hero tree gap
- **Best builds per scenario**: Best weighted, 1T, 5T, 10T with copy-hash buttons
- **Hero tree comparison**: Side-by-side bar chart, top 3 builds per tree
- **Build rankings**: All builds with hero tree tabs, sortable columns, TOP badges
- **Talent heatmap**: Per-talent DPS impact (ablation-based when sims run, cohort-based with --skip-sims)
- **Gear display**: Equipped items, trinket rankings, embellishment rankings
- **Optimization journey**: Chronological table of accepted iterations with impact bars

## Architecture

- Uses **profileset mode** (`generateRosterProfilesetContent` + `runProfilesetAsync`) for all roster builds
- 3-6 total sims: our APL x 3 scenarios (+ baseline if present)
- Results stored in DB: our DPS in `dps_*` columns, baseline in `simc_dps_*` columns
- `--skip-sims` reads DPS from DB without any sim runs
- Dark theme, self-contained HTML (inline CSS + JS, Outfit and DM Sans from Google Fonts)
- Interactive: sortable columns, hero tree tabs, copy-to-clipboard, collapsible sections

## Graceful Degradation

- **No ablation data**: Heatmap renders in cohort mode (weighted DPS impact from build population). This happens with `--skip-sims` or when ablation sims fail (e.g., remote AMI mismatch).
- **No gear pipeline**: Gear display, trinket rankings, and embellishment sections are empty. Run `/gear` first.
- **Partial roster DPS**: Report warns but still renders available data.

## Notes

- Standard fidelity takes ~5-10 minutes for a full roster
- Quick fidelity (~2 min) is good for iteration previews
- The report reads optimization history from the database (`theorycraft.db`)
