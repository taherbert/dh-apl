# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SimulationCraft Action Priority List (APL) for World of Warcraft — **Vengeance Demon Hunter** (tank spec).

SimulationCraft APLs are text-based priority lists that define ability usage, cooldown timing, and conditional logic for character simulation. They use SimC's custom APL syntax (`actions=`, `actions+=/ability,if=condition`).

## Domain Context

- **SimulationCraft (SimC):** Open-source WoW combat simulator. APLs drive the decision engine.
- **APL syntax:** Each line is an action entry with optional conditions. Lines are evaluated top-to-bottom; first matching action fires.
- **Vengeance DH resources:** Fury (builder/spender), Soul Fragments (healing/damage), health/defensives.
- **Key abilities:** Fracture, Spirit Bomb, Soul Cleave, Immolation Aura, Sigil of Flame, Fiery Brand, Demon Spikes, Fel Devastation, The Hunt, Elysian Decree.
- **Talent builds** affect which abilities are available and how the APL branches.

## SimC APL Syntax Reference

```
actions=auto_attack
actions+=/ability_name,if=condition1&condition2
actions+=/run_action_list,name=sub_list,if=condition
```

Common condition expressions: `fury>=30`, `soul_fragments>=4`, `buff.demon_spikes.up`, `talent.spirit_bomb.enabled`, `cooldown.fiery_brand.ready`, `health.pct<50`, `active_enemies>=3`.

## Session Protocol

1. Read `PLAN.md` at start to understand current project state
2. After completing a step, mark it done with `[x]` and add implementation notes
3. Record surprising findings under "Findings & Notes" in PLAN.md
4. Update this file if new commands, patterns, or architectural decisions emerge

## Data Sources

- **Raidbots** (`raidbots.com/static/data/{env}/talents.json`): Authoritative talent tree source. Provides class/spec/hero nodes with spell IDs, positions, choice variants. Environment: `live` or `ptr` (controlled by `src/config.js` `DATA_ENV`).
- **simc C++** (`sc_demon_hunter.cpp`): Implementation reference. Talent assignments via `talent.{tree}.{var}` patterns.
- **simc spell_query**: Runtime spell data (effects, coefficients). Limited by binary age.
- **SpellDataDump**: Full spell effect data, updated more frequently than the binary.

### Environment Toggle

Change `DATA_ENV` in `src/config.js` to switch between `"live"` and `"ptr"`. Then run `npm run build-data` to regenerate from the new environment.

### Hero Trees

Vengeance has two hero trees:

- **Aldrachi Reaver** (subtree 35): Art of the Glaive, Reaver's Mark, Keen Edge, etc.
- **Annihilator** (subtree 124): Voidfall, Catastrophe, Dark Matter, World Killer, etc.

### Choice Nodes

Raidbots nodes with `type: "choice"` have multiple `entries` (index 100/200/300). Each entry is a separate talent option — all are included in `talents.json`.

## Architecture

```
src/
  config.js       # Central config (DATA_ENV, paths, identifiers)
  extract/        # Data extraction (raidbots.js, spells.js, parser.js)
  model/          # Data models (talents.js, interactions.js, interaction-types.js)
  visualize/      # Reports and graphs (text-report.js, graph.js)
  sim/            # SimC runner and analysis (runner.js, analyze.js)
  apl/            # APL parser and generator (future)
data/
  raw/            # Raw simc dumps (gitignored)
  raidbots-talents.json  # Raidbots talent data (filtered to VDH)
  spells.json     # Parsed VDH spell catalog
  talents.json    # Full talent tree
  interactions.json  # Talent → spell interaction map
apls/             # APL files (.simc)
results/          # Simulation output (gitignored)
reference/
  vengeance-apl.simc           # simc default VDH APL
  simc-talent-variables.json   # C++ talent variable names mapped to trees
  spelldatadump-vdh.txt        # Full spell effect data (SpellDataDump)
  trait-data.md                # Key simc struct definitions
  tww3-profiles/               # TWW3 VDH profiles from simc
  apl-conversion/              # APL ↔ C++ conversion tools
  wiki/                        # SimC wiki docs (APL syntax, expressions, options, etc.)
    action-lists.md            # APL syntax reference
    action-list-expressions.md # Complete expression/condition reference
    demon-hunters.md           # DH-specific SimC options
    textual-config.md          # TCI basics
    options.md                 # General simulation options
    equipment.md               # Gear, gems, enchants, set bonuses
    output.md                  # Report formats, combat logs
    spell-query.md             # spell_query syntax and data sources
    spell-data-overrides.md    # Override spell/effect data
    statistical-behaviour.md   # Iterations, target_error, RNG
    profile-sets.md            # Batch talent/gear comparison
    coded-flags.md             # Action flags, scaling coefficients
    developer-docs.md          # Architecture: sim_t, player_t, action_t
    fighting-variance.md       # Law of Large Numbers, confidence
    formulation-vs-simulation.md # Analytical vs simulation tradeoffs
    how-to-build.md            # Building simc from source
    stats-scaling.md           # Scale factors, stat plotting, reforge plots
    buffs-and-debuffs.md       # Raid buffs, bloodlust, external buffs
    raid-events.md             # Fight styles, adds, movement, DungeonRoute
    characters.md              # Character declaration, talents, consumables
    enemies.md                 # Custom enemies, tank dummies, action lists
    expansion-options.md       # TWW/DF/SL expansion-specific options
```

## Commands

```bash
# Fetch Raidbots talent data
npm run fetch-raidbots

# Extract spell data
node src/extract/spells.js

# Build talent tree
node src/model/talents.js

# Extract C++ talent cross-references
npm run cpp-interactions

# Build interaction map (merges spell_data + C++ + effect scan)
node src/model/interactions.js

# Generate reports
node src/visualize/text-report.js
node src/visualize/graph.js

# Generate interaction audit report
npm run audit-report

# Run simulation
node src/sim/runner.js apls/baseline.simc

# Analyze results
node src/sim/analyze.js

# Verify data against simc C++ source
npm run verify

# Extract simc C++ talent variables to reference/
npm run extract-simc
```

## Key Paths

- **SimC binary:** `/Users/tom/Documents/GitHub/simc/engine/simc`
- **SimC source:** `/Users/tom/Documents/GitHub/simc` (branch: `midnight`)
- **VDH class module:** `engine/class_modules/sc_demon_hunter.cpp`
- **VDH APL module:** `engine/class_modules/apl/apl_demon_hunter.cpp`
- **TWW3 profiles:** `profiles/TWW3/TWW3_Demon_Hunter_Vengeance*.simc`

## Expansion Context

Targeting **Midnight** expansion. The simc `midnight` branch may have new abilities, talent changes, or mechanic reworks compared to TWW (The War Within). Always check the midnight branch for current spell data.

## Conventions

- APL files use `.simc` extension.
- Use action list names that describe purpose (e.g., `defensives`, `cooldowns`, `aoe`, `single_target`).
- Comment non-obvious conditions with `#` lines explaining the "why."
- Keep the default action list short — delegate to sub-lists via `run_action_list`.
- All JS uses ESM (`import`/`export`), Node.js 23+.
