# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Multi-spec SimulationCraft Action Priority List (APL) framework for World of Warcraft. Currently targeting **Vengeance Demon Hunter** (tank spec). The architecture supports any WoW spec through per-spec adapters and data isolation.

SimulationCraft APLs are text-based priority lists that define ability usage, cooldown timing, and conditional logic for character simulation. They use SimC's custom APL syntax (`actions=`, `actions+=/ability,if=condition`).

## Domain Context

- **SimulationCraft (SimC):** Open-source WoW combat simulator. APLs drive the decision engine.
- **APL syntax:** Each line is an action entry with optional conditions. Lines are evaluated top-to-bottom; first matching action fires.
- **Multi-spec architecture:** `config.json` selects the active spec. Per-spec data lives in `data/{spec}/`, `results/{spec}/`, `apls/{spec}/`. The spec adapter (`src/spec/{spec}.js`) provides all spec-specific knowledge.
- **DPS only.** This project optimizes exclusively for damage output. Survivability, HPS, DTPS, and defensive metrics are not goals. Defensives are maintained for SimC realism but never at the expense of DPS.
- **Spec-specific knowledge** (abilities, resources, hero trees, burst windows, state machines) lives in the spec adapter's `SPEC_CONFIG`. Read it via `getSpecAdapter().getSpecConfig()`. Never hardcode ability names in analysis modules.
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
# apls/vengeance/vengeance.simc — run from project root
input=apls/vengeance/profile.simc   # CWD-relative path
actions=auto_attack
actions+=/...
```

`apls/{spec}/profile.simc` contains the shared character setup (race, talents, gear). APL files contain only action lines. The `resolveInputDirectives()` function in `profilesets.js` inlines `input=` directives so profileset content written to `results/` is self-contained.

## Session Protocol

1. Run `node src/engine/startup.js` to check config and simc sync status
2. Check `MULTI-SPEC-PLAN.md` for any ongoing multi-phase work
3. Read `data/{spec}/build-theory.json` for structural context
4. Update this file if new commands, patterns, or architectural decisions emerge

## Data Sources

- **Raidbots** (`raidbots.com/static/data/{env}/talents.json`): Authoritative talent tree source. Provides class/spec/hero nodes with spell IDs, positions, choice variants. Environment: `live` or `ptr` (controlled by `config.json` `data.env`).
- **simc C++** (class module path from `config.json`): Implementation reference. Talent assignments via `talent.{tree}.{var}` patterns.
- **simc spell_query**: Runtime spell data (effects, coefficients). Limited by binary age.
- **SpellDataDump**: Full spell effect data, updated more frequently than the binary.

### Spell Data Interpretation

When effect data is ambiguous (e.g., unclear whether a value is a damage amp or DR, or what school a spell targets), read the spell's description/tooltip text. The `description` field in `spells.json` often clarifies the intended effect better than raw effect subtypes.

### Environment Toggle

Change `data.env` in `config.json` to switch between `"live"`, `"ptr"`, or `"beta"`. Then run `npm run build-data` to regenerate from the new environment. Midnight data uses `"beta"`.

### Hero Trees

Hero trees are defined in the spec adapter's `SPEC_CONFIG.heroTrees`. Each has a subtree ID, damage school, key buffs, and APL branch name. Read these from the adapter — don't hardcode.

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

The full data files (`spells.json` at 548KB, `interactions.json` at 1.4MB) are too large to read into context efficiently. Use the summary files in `data/{spec}/` instead:

- **`spells-summary.json`** (46KB): Use for APL analysis. Has id, name, school, resource, cooldown, charges, duration, GCD, AoE radius, generates, and resolved descriptions. Omits raw effects, family flags, attributes, labels.
- **`interactions-summary.json`** (234KB): Use for APL analysis. Has `bySpell`, `byTalent`, `talentCategories`, `bySetBonus` views with magnitude, proc info, and application type. Omits the flat `interactions[]` array and `effectDetails`.
- **`talents.json`** (89KB): Small enough to read directly — no summary needed.

Only read the full files when you need raw spell effect data (coefficients, effect subtypes) or effect-level detail on interactions. For a specific spell, use `Grep` on the full file rather than reading it entirely.

## Architecture

```
config.json         # Single human-editable config (spec, simc, scenarios, fidelity)
src/
  engine/           # Core engine (spec-agnostic)
    paths.js        # Centralized per-spec path resolution (dataDir, resultsDir, aplsDir)
    startup.js      # Loads config.json, sets spec name, derives paths, checks simc sync
    extract.js      # Extraction pipeline orchestrator
    model.js        # Model pipeline orchestrator
  spec/             # Spec-specific adapters
    interface.js    # Adapter contract + runtime validation
    vengeance.js    # VDH: spell IDs, domain overrides, hero trees, resource models, state machines
    common.js       # Shared adapter utilities (buildAbilityData, etc.)
  extract/          # Data extraction (raidbots.js, spells.js, parser.js)
  model/            # Data models (talents.js, interactions.js, interaction-types.js)
  visualize/        # Reports and graphs (text-report.js, graph.js)
  sim/              # SimC runner and analysis (runner.js, analyze.js, iterate.js)
  analyze/          # Strategic analysis — data-driven from spec adapter
  discover/         # Build discovery pipeline (build-discovery.js)
  apl/              # APL parser, condition-parser, mutator, scaffold
  util/             # Shared utilities (db.js, validate.js, talent-string.js)
data/
  vengeance/              # Per-spec extracted + modeled data
    raw/                  # Raw simc dumps (gitignored)
    spells.json           # Parsed spell catalog (full)
    spells-summary.json   # Context-efficient spell data — use this for analysis
    talents.json          # Full talent tree — small enough to read directly
    interactions.json     # Talent → spell interaction map (full)
    interactions-summary.json  # Context-efficient interactions — use this for analysis
    cpp-proc-mechanics.json    # Auto-extracted C++ proc rates, ICDs, constants
    build-theory.json          # Curated: talent clusters, hero trees, archetype theory
    build-roster.json          # Persistent build roster (version-controlled)
    raidbots-talents.json      # Raidbots talent data
  havoc/                  # Future: another DH spec
apls/
  vengeance/              # Per-spec APL files
    profile.simc          # Shared character profile (gear, talents, race)
    baseline.simc         # SimC default APL (reference only)
    vengeance.simc        # Our from-scratch APL (uses input=profile.simc)
    current.simc          # Iteration working copy (gitignored)
results/
  vengeance/              # Per-spec simulation output and persistent state
    builds.json           # Discovered archetypes + ranked builds
    builds.db             # SQLite: queryable builds, factors, archetypes
    findings.json         # Accumulated analytical insights
    findings.db           # SQLite: queryable findings and hypotheses
    SCHEMA.md             # Schema documentation
reference/                # Shared (cross-spec C++ source)
  vengeance-apl.simc
  simc-talent-variables.json
  .refresh-metadata.json
  wiki/                   # SimC wiki docs (auto-synced)
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

# === Build Discovery ===
npm run discover                             # Standard fidelity (~10-20 min)
npm run discover -- --quick                  # Quick screening (~2-5 min)
npm run discover -- --confirm                # High fidelity (~30-60 min)
npm run discover -- --ar-only                # Aldrachi Reaver builds only
npm run discover -- --anni-only              # Annihilator builds only

# === Build Roster (persistent, version-controlled) ===
npm run roster show                          # Show roster with validation status
npm run roster import-doe                    # Import from builds.json (DoE discovery)
npm run roster import-multi-build            # Import from multi-build.simc (Anni builds)
npm run roster import-profile                # Import profile.simc reference build
npm run roster validate                      # Re-validate all builds
npm run roster prune                         # Remove redundant builds within threshold
npm run roster migrate                       # One-time v1→v2 migration from existing data

# === Simulation ===
node src/sim/runner.js apls/vengeance/baseline.simc  # Run simulation
node src/sim/analyze.js                              # Analyze results

# === Engine ===
node src/engine/startup.js                   # Check config + simc sync status
node src/engine/extract.js                   # Check extraction pipeline status
node src/engine/model.js                     # Check model pipeline status
node src/util/validate.js                    # Validate all data + staleness check
npm run db:migrate                           # Import builds.json/findings.json → SQLite
npm run db:status                            # Show SQLite record counts
node src/util/db.js top 10                   # Top 10 builds by weighted DPS
npm run synthesize                           # Run hypothesis synthesizer standalone

# === Verification ===
npm run verify                               # Verify data against simc C++
npm run extract-simc                         # Extract simc C++ talent variables

# === User Commands ===
/optimize [focus directive]                          # THE optimization command — does everything
/bootstrap                                           # Fresh spec setup from scratch
/sim [apl-file]                                      # Run a simulation
/build                                               # Rebuild all data files
/verify                                              # Verify data against simc C++
/audit                                               # Full cross-reference audit
/simc-reference [topic]                              # Look up SimC syntax and expressions

# Iteration state management
node src/sim/iterate.js init apls/vengeance/baseline.simc
node src/sim/iterate.js status
node src/sim/iterate.js compare apls/vengeance/candidate.simc [--quick|--confirm]
node src/sim/iterate.js accept "reason" [--hypothesis "fragment"]
node src/sim/iterate.js reject "reason" [--hypothesis "fragment"]
node src/sim/iterate.js hypotheses
node src/sim/iterate.js strategic                    # Generate archetype-aware hypotheses with auto-mutations
node src/sim/iterate.js theorycraft                  # Generate temporal resource flow hypotheses
node src/sim/iterate.js generate                     # Auto-generate candidate from top hypothesis
node src/sim/iterate.js synthesize                   # Synthesize hypotheses from all specialist sources
node src/sim/iterate.js rollback <iteration-id>      # Rollback an accepted iteration
node src/sim/iterate.js summary

# Analysis tools
node src/analyze/archetypes.js                       # Show archetypes, clusters, synergies, tensions
node src/analyze/strategic-hypotheses.js <workflow.json> [apl.simc]  # Generate strategic hypotheses
node src/analyze/theorycraft.js [workflow.json] [apl.simc]           # Temporal resource flow analysis
node src/apl/condition-parser.js "condition"         # Parse APL condition to AST
node src/apl/mutator.js <apl.simc> '<mutation-json>' # Apply mutation to APL
```

## Key Paths

- **SimC binary:** `/Users/tom/Documents/GitHub/simc/engine/simc` (or `bin/simc` local copy)
- **SimC source:** `/Users/tom/Documents/GitHub/simc` (branch: `midnight`)
- **Class module:** Resolved from `config.json` `simc.classModule` (e.g., `engine/class_modules/sc_demon_hunter.cpp`)
- **APL module:** Resolved from `config.json` `simc.aplModule` (e.g., `engine/class_modules/apl/apl_demon_hunter.cpp`)

## Expansion Context

Targeting **Midnight** expansion. The simc `midnight` branch may have new abilities, talent changes, or mechanic reworks compared to TWW (The War Within). Always check the midnight branch for current spell data.

## Persistence — Build Knowledge & Findings

Per-spec JSON files + SQLite databases in `data/{spec}/` and `results/{spec}/` track state across sessions:

- **`data/{spec}/build-theory.json`** — Curated mechanical knowledge: talent clusters, hero tree interactions, cluster×hero synergies, build archetypes, and tension points. Not auto-generated — edited by hand when analysis reveals new structural insights. Used by `archetypes.js` and skill prompts.
- **`data/{spec}/build-roster.json`** — Persistent build roster for multi-build evaluation. Version-controlled alongside build-theory.json. Contains validated builds from all hero trees with DPS history. Auto-updated by `npm run discover` and `iterate.js`. Manage via `npm run roster`.
- **`results/{spec}/builds.json`** — Discovered archetypes and ranked talent builds from `npm run discover`. Contains factor impacts, synergy pairs, archetype groupings, and per-build DPS across all scenarios. Re-run after APL changes to update rankings.
- **`results/{spec}/findings.json`** — Accumulated analytical insights across sessions. Each finding is a discrete insight with evidence, confidence level, and tags.
- **`results/{spec}/builds.db`** — SQLite mirror of builds.json (queryable). Run `npm run db:migrate` to import.
- **`results/{spec}/findings.db`** — SQLite for findings + hypothesis tracking. Accepted iterations auto-record here.

**Session startup protocol:** Read `data/{spec}/build-theory.json` for structural context, `results/{spec}/builds.json` (or `builds.db`) for quantitative rankings, and `findings.json` (filtered to `status: "validated"`) for calibration.

**After accepting APL changes:** Re-run `npm run discover -- --quick` to re-rank builds under the new APL.

### Commands

**One command for optimization:** `/optimize [focus]` — fully autonomous: discovers archetypes via DoE, generates build roster, deep reasoning, 4 parallel specialist subagents, synthesis, multi-build iteration (tests against ALL roster builds simultaneously), APL branching for archetypes/hero trees, and reporting. No user confirmation needed — sim compute is not a concern. Pass an optional focus directive (e.g., `/optimize Check soul fragment economy`) to prioritize an area.

**Utility commands:** `/bootstrap`, `/sim`, `/build`, `/verify`, `/audit`, `/simc-reference` — simple single-purpose tools.

**Internal methodology** (NOT user-facing — referenced by `/optimize` internally):

- `prompts/apl-analysis-guide.md` — canonical knowledge base + calculation frameworks
- `prompts/full-analysis-methodology.md` — economy modeling, systemic tensions
- `prompts/iterate-apl-methodology.md` — iteration loop protocol
- `prompts/theorycraft-methodology.md` — temporal resource flow
- `prompts/talent-analysis-methodology.md` — talent interaction graphs
- `prompts/analyze-apl-methodology.md` — APL comprehension walkthrough
- `prompts/apl-iteration-guide.md` — iteration tactics and escape strategies

## Conventions

- APL files use `.simc` extension.
- Use action list names that describe purpose (e.g., `defensives`, `cooldowns`, `aoe`, `single_target`).
- Comment non-obvious conditions with `#` lines explaining the "why."
- Keep the default action list short — delegate to sub-lists via `run_action_list` (mutually exclusive branches) or `call_action_list` (optional sub-routines that fall through).
- **Always test against ALL archetypes.** The APL is shared by all talent builds. Verify the build roster covers all archetypes: `npm run roster show`. The roster is persistent and auto-updated by `npm run discover`. `iterate.js` requires the roster and refuses single-build mode. If a change helps some archetypes but hurts others, create a sub-action-list gated by talent/hero-tree check, then re-test against the full roster.
- **Theory before simulation.** Before changing any ability's placement, conditions, or priority, read it in context. Understand _why_ it is where it is, what role it plays in the resource/GCD/cooldown economy, and what downstream effects a change would cause. Form a clear theory — "this change should improve X because Y" — before creating a candidate or running a sim. Never shotgun changes to see what sticks.
- **Deep reasoning drives automation.** Every analysis session must start with deep mechanical reasoning using the full knowledge base (`prompts/apl-analysis-guide.md` Section 0 is the single canonical list of all data sources). Automated hypothesis generators (`strategic`, `theorycraft`, `workflow`) are heuristic screeners that serve the deep theory, not replacements for it. A shallow observation like "buff uptime is low" is only useful when paired with reasoning about _why_ it's low and what the real fix costs. Never run automated screeners in isolation — always frame their output within a deeper understanding of the system.
- **Audit existing logic for errors.** APL variables and conditions encode assumptions about game mechanics — caps, thresholds, talent interactions. These assumptions can become wrong when talents change the rules (e.g., an apex talent raising the soul fragment cap from 5 to 6). Actively look for hardcoded values or implicit assumptions that don't account for the current talent build. When you find one, trace the downstream effects: a corrected cap may change fragment thresholds, spender conditions, and target-count breakpoints.
- All JS uses ESM (`import`/`export`), Node.js 23+.
