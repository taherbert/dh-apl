---
description: Bootstrap a fresh spec — generates data, APL scaffold, and build theory from scratch. Use when starting optimization for a new spec or after major game changes.
---

Bootstrap workflow for fresh spec optimization. This skill orchestrates the full pipeline from zero knowledge to a working APL and build theory.

## When to Use

- Starting optimization for a **new spec**
- After a **major game patch** that invalidates existing knowledge
- When you want to **rebuild everything from scratch**
- When the existing APL, build-theory, or findings are corrupt/stale

## Prerequisites

1. **SimC binary** must be built and accessible
2. **Raidbots data** must be available (run `npm run fetch-raidbots` if needed)
3. **config.json** must be configured with the target spec identifiers

## Setup

Run `node src/engine/startup.js` to determine the active spec. Use the spec name for all `{spec}` path references below.

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

### Phase 3: APL Scaffold

```bash
# Generate initial APL skeleton from spell data
node src/apl/scaffold.js {spec} null apls/{spec}/{spec}-scaffold.simc
```

Review the generated scaffold:

- `apls/{spec}/{spec}-scaffold.simc` — starting APL
- `apls/{spec}/{spec}-scaffold-analysis.md` — analysis report

The scaffold is a **starting point**, not a finished APL. It:

- Identifies relevant abilities
- Classifies by cooldown, resource, category
- Does NOT know talent gates
- Does NOT know hero tree routing
- Does NOT know optimal priorities

Enhance the scaffold using techniques learned in Phase 2 — add hero tree branching structure, variable patterns for resource thresholds, and action list delegation. The priorities will be refined by `/optimize` later.

### Phase 4: Build Theory Generation

```bash
# Generate initial build theory from talent data
node src/analyze/build-theory-generator.js data/{spec}/build-theory-generated.json
```

Review the generated theory:

- Clusters may be incomplete or miscategorized
- Hero trees need manual verification
- Synergies are detected by co-reference, not simulation
- Archetypes are combinatorial, not optimal

**Important:** Copy to `data/{spec}/build-theory.json` only after manual curation.

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

### Phase 7: Build Discovery (Optional)

```bash
# Run build discovery to find optimal talent combinations
npm run discover -- --quick
```

This generates `results/{spec}/builds.json` with ranked builds.

## Expected Outputs

After bootstrap, you should have:

- `data/{spec}/spells-summary.json` — spell data
- `data/{spec}/talents.json` — talent tree
- `data/{spec}/interactions-summary.json` — interactions
- `data/{spec}/build-theory.json` — needs curation
- `apls/{spec}/{spec}-scaffold.simc` — starting point
- `results/{spec}/builds.json` — if discovery ran

## Next Steps

1. **Curate build-theory.json** — review clusters, archetypes, synergies
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
