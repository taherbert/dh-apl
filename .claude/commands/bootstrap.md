---
description: Bootstrap a fresh spec — generates data, APL scaffold, and build theory from scratch. Use when starting optimization for a new spec or after major game changes.
---

Bootstrap workflow for fresh spec optimization. This skill orchestrates the full pipeline from zero knowledge to a working APL and build theory.

## When to Use

- Starting optimization for a **new spec** (not VDH)
- After a **major game patch** that invalidates existing knowledge
- When you want to **rebuild everything from scratch**
- When the existing APL, build-theory, or findings are corrupt/stale

## Prerequisites

1. **SimC binary** must be built and accessible
2. **Raidbots data** must be available (run `npm run fetch-raidbots` if needed)
3. **Spec identifier** — e.g., "vengeance", "havoc", "protection", etc.

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

- `data/spells-summary.json` — spell catalog
- `data/talents.json` — talent tree
- `data/interactions-summary.json` — talent interactions
- `data/cpp-proc-mechanics.json` — proc rates and ICDs

### Phase 2: APL Scaffold

```bash
# Generate initial APL skeleton from spell data
node src/apl/scaffold.js vengeance null apls/vengeance-scaffold.simc
```

Review the generated scaffold:

- `apls/vengeance-scaffold.simc` — starting APL
- `apls/vengeance-scaffold-analysis.md` — analysis report

The scaffold is a **starting point**, not a finished APL. It:

- ✅ Identifies relevant abilities
- ✅ Classifies by cooldown, resource, category
- ❌ Does NOT know talent gates
- ❌ Does NOT know hero tree routing
- ❌ Does NOT know optimal priorities

### Phase 3: Build Theory Generation

```bash
# Generate initial build theory from talent data
node src/analyze/build-theory-generator.js data/build-theory-generated.json
```

Review the generated theory:

- Clusters may be incomplete or miscategorized
- Hero trees need manual verification
- Synergies are detected by co-reference, not simulation
- Archetypes are combinatorial, not optimal

**Important:** Copy to `data/build-theory.json` only after manual curation.

### Phase 4: Talent-APL Coupling Analysis

```bash
# Analyze talent-APL dependencies
node src/analyze/talent-apl-coupling.js data/talents.json apls/vengeance-scaffold.simc
```

This identifies:

- Abilities unlocked by talents (need APL entries)
- Resource modifications (need threshold adjustments)
- Proc mechanics (need buff tracking)
- Buff windows (need damage alignment)

### Phase 5: Initial Simulation

```bash
# Run baseline sim with scaffold APL
npm run sim -- apls/vengeance-scaffold.simc st

# If it works, initialize iteration state
node src/sim/iterate.js init apls/vengeance-scaffold.simc
```

### Phase 6: Build Discovery (Optional)

```bash
# Run build discovery to find optimal talent combinations
npm run discover -- --quick
```

This generates `results/builds.json` with ranked builds.

## Expected Outputs

After bootstrap, you should have:

- `data/spells-summary.json` — ✅ spell data
- `data/talents.json` — ✅ talent tree
- `data/interactions-summary.json` — ✅ interactions
- `data/build-theory.json` — ⚠️ needs curation
- `apls/vengeance-scaffold.simc` — ⚠️ starting point
- `results/builds.json` — ✅ if discovery ran

## Next Steps

1. **Curate build-theory.json** — review clusters, archetypes, synergies
2. **Refine APL** — add talent gates, hero tree routing, conditions
3. **Run /optimize** — start the full optimization loop
4. **Iterate** — use /iterate-apl to improve incrementally

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

1. Add spec config to `src/apl/scaffold.js`:

```javascript
const SPEC_CONFIG = {
  newspec: {
    specId: "newspec",
    className: "classname",
    role: "role",
    primaryResource: "resource",
    spellKeywords: ["ability1", "ability2", ...],
  },
};
```

2. Update `config.json` with spec identifiers
3. Run bootstrap workflow
4. Curate generated files
