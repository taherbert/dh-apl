---
description: Bootstrap a fresh spec — generates data, APL scaffold, and build theory from scratch. Use when starting optimization for a new spec or after major game changes.
argument-hint: "[spec-name]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch
---

Bootstrap workflow for fresh spec optimization. This skill orchestrates the full pipeline from zero knowledge to a working APL and build theory.

## When to Use

- Starting optimization for a **new spec**
- After a **major game patch** that invalidates existing knowledge
- When you want to **rebuild everything from scratch**
- When the existing APL, DB knowledge, or findings are corrupt/stale

## Prerequisites

1. **SimC binary** must be built and accessible
2. **Raidbots data** must be available (run `npm run fetch-raidbots` if needed)
3. **config.json** must be configured with the target spec identifiers

## Setup

Run `node src/engine/startup-cli.js` to determine the active spec. Use the spec name for all `{spec}` path references below.

## Workflow Steps

### Phase 1: Data Generation

```bash
# 1. Fetch latest talent data from Raidbots
npm run fetch-raidbots

# 2. Extract spell data from SimC
npm run extract

# 3. Build talent tree
npm run talents

# 4. Extract C++ interactions and proc mechanics
npm run cpp-interactions
npm run cpp-procs

# 5. Build interaction map
npm run interactions

# 6. Generate context-efficient summaries
npm run context-summary
```

After Phase 1, you should have:

- `data/{spec}/spells-summary.json` — spell catalog
- `data/{spec}/talents.json` — talent tree
- `data/{spec}/interactions-summary.json` — talent interactions
- `data/{spec}/cpp-proc-mechanics.json` — proc rates and ICDs

### Phase 2: Reference APL Technique Study

Before building our own APL, study the SimC default APL for **technique** — syntax patterns, structural idioms, and SimC features we should use. This is NOT about copying priorities.

```bash
# Extract the default APL from SimC C++ source
npm run extract-apl
```

Read `reference/{spec}-apl.simc` and document:

1. **SimC syntax techniques** — variable patterns, accumulator usage, `prev_gcd` expressions, `time_to_die` conditions, trinket slot handling
2. **Structural patterns** — how are action lists delegated? What sub-lists exist (cooldowns, AoE, burst)? How is hero tree branching done?
3. **State machine encoding** — how are multi-step cycles expressed? (e.g., empowerment windows, charge management)
4. **Scaling patterns** — how do `spell_targets` breakpoints work? How does the APL adapt from ST to AoE?

**Important:** The reference APL's priority ordering and threshold values are background research, not ground truth. They may be wrong, incomplete, or tuned to a different build. Your priorities come from mathematical analysis; your thresholds come from simulation. The techniques (how to express ideas in SimC syntax) are what you're learning here.

Also read `reference/wiki/action-lists.md` and `reference/wiki/action-list-expressions.md` for the full SimC expression language. These document features you might not know exist.

### Phase 3: APL Construction

Using the spell data from Phase 1 and syntax techniques from Phase 2, manually construct an initial APL at `apls/{spec}/{spec}.simc`.

The initial APL should:

- Include hero tree branching structure (`run_action_list` for mutually exclusive branches)
- Define variables for resource thresholds and buff tracking
- Use action list delegation for cooldowns, defensives, and burst windows
- Cover all relevant abilities from the spell catalog

The priorities will be refined by `/optimize` later.

### Phase 4: Build Theory Generation

```bash
# Generate initial build theory and write to DB
node src/analyze/build-theory-generator.js
```

Review the generated theory via `npm run db:status` and `npm run db:dump`:

- Clusters may be incomplete or miscategorized
- Hero trees need manual verification
- Synergies are detected by co-reference, not simulation
- Archetypes are combinatorial, not optimal

Review and curate the talent clusters and archetypes in the DB. Use `/theory` to manage theories.

### Phase 5: Talent-APL Coupling Analysis

```bash
# Analyze talent-APL dependencies
node src/analyze/talent-apl-coupling.js data/{spec}/talents.json apls/{spec}/{spec}-scaffold.simc
```

This identifies:

- Abilities unlocked by talents (need APL entries)
- Resource modifications (need threshold adjustments)
- Proc mechanics (need buff tracking)
- Buff windows (need damage alignment)

### Phase 6: Initial Simulation

```bash
# Run baseline sim with scaffold APL
npm run sim -- apls/{spec}/{spec}-scaffold.simc st

# If it works, initialize iteration state
node src/sim/iterate.js init apls/{spec}/{spec}-scaffold.simc
```

### Phase 7: Generate Build Roster

```bash
# Generate cluster-based roster from SPEC_CONFIG templates
npm run roster generate
npm run roster show                   # Verify coverage
```

This generates builds from SPEC_CONFIG `rosterTemplates` × hero tree × variant. Each template specifies an apex rank and which talent clusters to include/exclude.

## Expected Outputs

After bootstrap, you should have:

- `data/{spec}/spells-summary.json` — spell data
- `data/{spec}/talents.json` — talent tree
- `data/{spec}/interactions-summary.json` — interactions
- `results/{spec}/theorycraft.db` — builds, roster membership, talent clusters
- `apls/{spec}/{spec}-scaffold.simc` — starting point

## Next Steps

1. **Verify roster** — `npm run roster show` to confirm template × hero tree coverage
2. **Refine APL** — add talent gates, hero tree routing, conditions
3. **Run /optimize** — start the full optimization loop (deep reasoning + iteration)

## Common Issues

### "Spells data not found"

Run the full data pipeline: `npm run build-data`

### "SimC binary not found"

Ensure SIMC_DIR is set or simc is in PATH

### "Raidbots data stale"

Run `npm run fetch-raidbots` to refresh talent data

### "Generated APL doesn't parse"

The scaffold is a starting point — some abilities may need manual fixing

## Extending for New Specs

To add support for a new spec:

1. Copy `src/spec/_template.js` to `src/spec/{spec}.js` and fill in the blanks (see `src/spec/interface.js` for the full contract)
2. Update `config.json` with the new spec identifiers
3. Run bootstrap workflow
4. Curate generated files
