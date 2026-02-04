# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SimulationCraft Action Priority List (APL) for World of Warcraft — **Vengeance Demon Hunter** (tank spec).

SimulationCraft APLs are text-based priority lists that define ability usage, cooldown timing, and conditional logic for character simulation. They use SimC's custom APL syntax (`actions=`, `actions+=/ability,if=condition`).

## Domain Context

- **SimulationCraft (SimC):** Open-source WoW combat simulator. APLs drive the decision engine.
- **APL syntax:** Each line is an action entry with optional conditions. Lines are evaluated top-to-bottom; first matching action fires.
- **Vengeance DH resources:** Fury (builder/spender), Soul Fragments (healing/damage), health/defensives.
- **DPS only.** This project optimizes exclusively for damage output. Survivability, HPS, DTPS, and defensive metrics are not goals. Demon Spikes and other defensives are maintained for SimC realism but never at the expense of DPS.
- **Key abilities:** Fracture, Spirit Bomb, Soul Cleave, Immolation Aura, Sigil of Flame, Fiery Brand, Demon Spikes, Fel Devastation, The Hunt, Elysian Decree.
- **Talent builds** affect which abilities are available and how the APL branches.

## SimC APL Syntax Reference

```
actions=auto_attack
actions+=/ability_name,if=condition1&condition2
actions+=/run_action_list,name=sub_list,if=condition
actions+=/call_action_list,name=sub_list,if=condition
```

Common condition expressions: `fury>=30`, `soul_fragments>=4`, `buff.demon_spikes.up`, `talent.spirit_bomb.enabled`, `cooldown.fiery_brand.ready`, `health.pct<50`, `active_enemies>=3`.

**Apex talents:** Apex talents (pinnacle talents at the bottom of the tree) use `apex.N` where N is the rank number (e.g., `apex.1`, `apex.2`). Do NOT use `talent.apex_name` — always use the `apex.N` syntax.

**APL variables:** Use `variable,name=X,value=expr` to extract shared logic out of action conditions. Variables keep action statements focused on "what to cast" while variables handle "is the situation right." If a condition or sub-expression appears in more than one action line, it should be a variable. Computed state (target counts, resource thresholds, buff windows, talent-dependent flags) belongs in variables — not duplicated inline across action conditions.

**Action list delegation:** Two mechanisms for sub-lists with different control flow (source: `engine/action/action.cpp`):

- **`run_action_list,name=X`** — Swaps the active list to `X`. Remaining actions in the caller are skipped for this evaluation cycle. Use for mutually exclusive branches (e.g., hero tree routing: `run_action_list,name=ar,if=hero_tree.aldrachi_reaver`).
- **`call_action_list,name=X`** — Evaluates `X` inline. If an action fires, the cycle ends normally. If nothing in `X` is ready, control falls through to the next line in the caller. Use for optional sub-routines (externals, defensives, burst windows) and shared logic across branches. Zero GCD/overhead — `use_off_gcd=true`, `use_while_casting=true`.

Choose `run_action_list` when branches are mutually exclusive (only one should ever execute). Choose `call_action_list` when the sub-list is optional or shared — it tries the sub-list and continues if nothing fires.

**Multi-file structure:** SimC supports `input=<filename>` to include one file from another. Paths resolve relative to **CWD** (where simc binary is invoked). Our APL files use this to avoid duplicating the character profile:

```
# apls/vengeance.simc — run from project root
input=apls/profile.simc   # CWD-relative path
actions=auto_attack
actions+=/...
```

`apls/profile.simc` contains the shared character setup (race, talents, gear). APL files contain only action lines. The `resolveInputDirectives()` function in `profilesets.js` inlines `input=` directives so profileset content written to `results/` is self-contained.

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

### Spell Data Interpretation

When effect data is ambiguous (e.g., unclear whether a value is a damage amp or DR, or what school a spell targets), read the spell's description/tooltip text. The `description` field in `spells.json` often clarifies the intended effect better than raw effect subtypes.

### Environment Toggle

Change `DATA_ENV` in `src/config.js` to switch between `"live"`, `"ptr"`, or `"beta"`. Then run `npm run build-data` to regenerate from the new environment. Midnight data uses `"beta"`.

### Hero Trees

Vengeance has two hero trees (Midnight):

- **Aldrachi Reaver** (subtree 35): Art of the Glaive, Reaver's Mark, Keen Edge, Rending Strike, Glaive Flurry, etc. APL branch: `actions.ar`
- **Annihilator** (subtree 124): Voidfall, Catastrophe, Dark Matter, World Killer, etc. APL branch: `actions.anni`

The current baseline uses AR talents. The `anni` branch exists in the APL but won't execute without an Annihilator talent profile.

### Talent Build Rules — MANDATORY

Generated talent builds MUST be valid. SimC and Wowhead accept invalid over-budget builds silently — that does NOT make them valid. Never generate an invalid build.

**Point budgets (Midnight):**

- Class tree: **34 points** spent (not counting free/entry nodes)
- Spec tree: **34 points** spent (not counting free/entry nodes)
- Hero tree: **13 points** spent (not counting free/entry nodes)
- All points MUST be spent — no under-spending

**Gate requirements:**

- Each tree has gate rows that require a minimum number of points spent before unlocking further rows
- Section 1 (rows 1-4): must spend **8 points** to unlock section 2
- Section 2 (rows 5-7): must spend **20 points** to unlock section 3
- Section 3 (rows 8-10): standard rows plus the pinnacle talent at the bottom
- You can over-spend in a section, but never under-spend
- The `reqPoints` field on each node indicates the gate threshold

**Validation:** The `--generate` and `--modify` commands in `src/util/talent-string.js` MUST validate point budgets and gate requirements. Refuse to produce an invalid build.

### Choice Nodes

Raidbots nodes with `type: "choice"` have multiple `entries` (index 100/200/300). Each entry is a separate talent option — all are included in `talents.json`.

### Data File Selection

The full data files (`spells.json` at 548KB, `interactions.json` at 1.4MB) are too large to read into context efficiently. Use the summary files instead:

- **`spells-summary.json`** (46KB): Use for APL analysis. Has id, name, school, resource, cooldown, charges, duration, GCD, AoE radius, generates, and resolved descriptions. Omits raw effects, family flags, attributes, labels.
- **`interactions-summary.json`** (234KB): Use for APL analysis. Has `bySpell`, `byTalent`, `talentCategories`, `bySetBonus` views with magnitude, proc info, and application type. Omits the flat `interactions[]` array and `effectDetails`.
- **`talents.json`** (89KB): Small enough to read directly — no summary needed.

Only read the full files when you need raw spell effect data (coefficients, effect subtypes) or effect-level detail on interactions. For a specific spell, use `Grep` on the full file rather than reading it entirely.

## Architecture

```
src/
  config.js       # Central config (DATA_ENV, paths, identifiers)
  extract/        # Data extraction (raidbots.js, spells.js, parser.js)
  model/          # Data models (talents.js, interactions.js, interaction-types.js)
  visualize/      # Reports and graphs (text-report.js, graph.js)
  sim/            # SimC runner and analysis (runner.js, analyze.js, iterate.js)
  analyze/        # Strategic analysis (archetypes.js, strategic-hypotheses.js, theorycraft.js)
  apl/            # APL parser, condition-parser, mutator
data/
  raw/            # Raw simc dumps (gitignored)
  raidbots-talents.json  # Raidbots talent data (filtered to VDH)
  spells.json            # Parsed VDH spell catalog (full — 548KB)
  spells-summary.json    # Context-efficient spell data (46KB) — use this for analysis
  talents.json           # Full talent tree (89KB — small enough to read directly)
  interactions.json      # Talent → spell interaction map (full — 1.4MB)
  interactions-summary.json  # Context-efficient interactions (234KB) — use this for analysis
  cpp-proc-mechanics.json  # Auto-extracted C++ proc rates, ICDs, constants
apls/             # APL files (.simc)
  profile.simc           # Shared character profile (gear, talents, race)
  baseline.simc          # SimC default APL (reference only)
  vengeance.simc         # Our from-scratch APL (uses input=profile.simc)
  current.simc           # Iteration working copy (managed by iterate.js, not hand-edited)
results/          # Simulation output and persistent state
  build-registry.json    # Build tracking: talent builds, DPS results, APL version, staleness
  findings.json          # Accumulated analytical insights across sessions
  SCHEMA.md              # Schema documentation for persistence files
reference/
  vengeance-apl.simc           # simc default VDH APL (auto-extracted from C++)
  simc-talent-variables.json   # C++ talent variable names mapped to trees
  spelldatadump-vdh.txt        # Full spell effect data (auto-generated)
  .refresh-metadata.json       # Last refresh timestamp and simc commit
  trait-data.md                # Key simc struct definitions
  apl-conversion/              # APL ↔ C++ conversion tools
  wiki/                        # SimC wiki docs (auto-synced from simc wiki)
    action-lists.md            # APL syntax reference
    action-list-expressions.md # Complete expression/condition reference
    demon-hunters.md           # DH-specific SimC options
    textual-config.md          # TCI basics
    options.md                 # General simulation options
    equipment.md               # Gear, gems, enchants, set bonuses
    output.md                  # Report formats, combat logs
    spell-query.md             # spell_query syntax and data sources
    spell-data.md              # Spell data internals
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
    expansion-options.md       # Expansion-specific options
    simc-for-tanks.md          # Tank simulation guide
    target-options.md          # Target/enemy options
```

## Commands

```bash
# === FULL REFRESH (after simc update) ===
npm run refresh                              # Rebuild everything from simc

# Environment variables for refresh:
#   SIMC_DIR=/path/to/simc                   # Override simc path
#   SIMC_BRANCH=midnight                     # Branch to use (default: midnight)
#   SKIP_BUILD=1                             # Skip simc binary rebuild
#   SKIP_WIKI=1                              # Skip wiki sync

# === Individual refresh steps ===
npm run extract-apl                          # Extract APL from C++ to .simc
npm run sync-wiki                            # Sync wiki docs from simc
npm run spelldatadump                        # Regenerate SpellDataDump

# === Data pipeline ===
npm run fetch-raidbots                       # Fetch Raidbots talent data
npm run extract                              # Extract spell data
npm run talents                              # Build talent tree
npm run cpp-interactions                     # Extract C++ talent cross-references
npm run cpp-procs                            # Extract C++ proc rates, ICDs, constants
npm run interactions                         # Build interaction map
npm run build-data                           # Run full data pipeline

# === Reports ===
npm run report                               # Generate text report
npm run graph                                # Generate interaction graph
npm run audit-report                         # Generate interaction audit
npm run context-summary                      # Generate context-efficient summaries

# === Simulation ===
node src/sim/runner.js apls/baseline.simc    # Run simulation
node src/sim/analyze.js                      # Analyze results

# === Verification ===
npm run verify                               # Verify data against simc C++
npm run extract-simc                         # Extract simc C++ talent variables

# Analyze APL — walk through APL explaining what each line does and why
/analyze-apl [apls/baseline.simc]

# SimC reference — look up SimC syntax, expressions, fight styles
/simc-reference [topic]

# Iterate APL — autonomous improvement loop
/iterate-apl

# Theorycraft — temporal resource flow analysis and hypotheses
/theorycraft [apls/vengeance.simc]

# Talent analysis — synergy clusters, build-APL co-optimization
/talent-analysis

# Full analysis — deep theorycraft + iteration loop
/full-analysis [apls/baseline.simc]

# Optimize — co-optimize build + APL together
/optimize [apls/vengeance.simc]

# Iteration state management
node src/sim/iterate.js init apls/baseline.simc
node src/sim/iterate.js status
node src/sim/iterate.js compare apls/candidate.simc [--quick|--confirm]
node src/sim/iterate.js accept "reason" [--hypothesis "fragment"]
node src/sim/iterate.js reject "reason" [--hypothesis "fragment"]
node src/sim/iterate.js hypotheses
node src/sim/iterate.js strategic                    # Generate archetype-aware hypotheses with auto-mutations
node src/sim/iterate.js theorycraft                  # Generate temporal resource flow hypotheses
node src/sim/iterate.js generate                     # Auto-generate candidate from top hypothesis
node src/sim/iterate.js rollback <iteration-id>      # Rollback an accepted iteration
node src/sim/iterate.js summary

# Analysis tools
node src/analyze/archetypes.js                       # Show archetype definitions
node src/analyze/strategic-hypotheses.js <workflow.json> [apl.simc]  # Generate strategic hypotheses
node src/analyze/theorycraft.js [workflow.json] [apl.simc]           # Temporal resource flow analysis
node src/apl/condition-parser.js "condition"         # Parse APL condition to AST
node src/apl/mutator.js <apl.simc> '<mutation-json>' # Apply mutation to APL
```

## Key Paths

- **SimC binary:** `/Users/tom/Documents/GitHub/simc/engine/simc` (or `bin/simc` local copy)
- **SimC source:** `/Users/tom/Documents/GitHub/simc` (branch: `midnight`)
- **VDH class module:** `engine/class_modules/sc_demon_hunter.cpp`
- **VDH APL module:** `engine/class_modules/apl/apl_demon_hunter.cpp`

## Expansion Context

Targeting **Midnight** expansion. The simc `midnight` branch may have new abilities, talent changes, or mechanic reworks compared to TWW (The War Within). Always check the midnight branch for current spell data.

## Persistence — Build Registry & Findings

Two JSON files in `results/` track state across sessions. See `results/SCHEMA.md` for full schema documentation.

- **`results/build-registry.json`** — Tracks every talent build tested, its DPS results per scenario, which APL version produced those results, and staleness detection. When an APL changes, builds tested under the old APL become "stale" — their rankings may no longer be accurate.
- **`results/findings.json`** — Accumulated analytical insights across sessions. Each finding is a discrete insight with evidence, confidence level, and tags. Replaces hardcoded known-result tables in skill prompts.

**Session startup protocol:** Read both files. Check for unresolved stale warnings in the build registry. Filter findings to `status: "validated"` for calibration context.

**After accepting changes:** Record new APL version, mark affected builds stale, append findings for each insight discovered.

### Skill Hierarchy

```
/optimize          ← Master loop: co-optimizes build + APL together
  ├── /talent-analysis  ← Talent interaction graph, synergy clusters
  ├── /theorycraft      ← Temporal resource flow, timing conflicts
  └── /full-analysis    ← Deep APL theorycraft, systemic tensions
        └── /iterate-apl  ← Autonomous iteration (test, accept/reject)

/analyze-apl       ← Comprehension: walk through APL explaining it
/simc-reference    ← Look up SimC syntax and expressions
```

## Conventions

- APL files use `.simc` extension.
- Use action list names that describe purpose (e.g., `defensives`, `cooldowns`, `aoe`, `single_target`).
- Comment non-obvious conditions with `#` lines explaining the "why."
- Keep the default action list short — delegate to sub-lists via `run_action_list` (mutually exclusive branches) or `call_action_list` (optional sub-routines that fall through).
- **Theory before simulation.** Before changing any ability's placement, conditions, or priority, read it in context. Understand _why_ it is where it is, what role it plays in the resource/GCD/cooldown economy, and what downstream effects a change would cause. Form a clear theory — "this change should improve X because Y" — before creating a candidate or running a sim. Never shotgun changes to see what sticks.
- **Audit existing logic for errors.** APL variables and conditions encode assumptions about game mechanics — caps, thresholds, talent interactions. These assumptions can become wrong when talents change the rules (e.g., an apex talent raising the soul fragment cap from 5 to 6). Actively look for hardcoded values or implicit assumptions that don't account for the current talent build. When you find one, trace the downstream effects: a corrected cap may change fragment thresholds, spender conditions, and target-count breakpoints.
- All JS uses ESM (`import`/`export`), Node.js 23+.
