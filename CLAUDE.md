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

## Architecture

```
src/
  extract/        # Spell data extraction from simc (parser.js, spells.js)
  model/          # Data models (talents.js, interactions.js, interaction-types.js)
  visualize/      # Reports and graphs (text-report.js, graph.js)
  sim/            # SimC runner and analysis (runner.js, analyze.js)
  apl/            # APL parser and generator (future)
data/
  raw/            # Raw simc dumps (gitignored)
  spells.json     # Parsed VDH spell catalog
  talents.json    # Full talent tree
  interactions.json  # Talent → spell interaction map
apls/             # APL files (.simc)
results/          # Simulation output (gitignored)
```

## Commands

```bash
# Extract spell data
node src/extract/spells.js

# Build talent tree
node src/model/talents.js

# Build interaction map
node src/model/interactions.js

# Generate reports
node src/visualize/text-report.js
node src/visualize/graph.js

# Run simulation
node src/sim/runner.js apls/baseline.simc

# Analyze results
node src/sim/analyze.js
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
