# Reference

Detailed reference material for the dh-apl project. See [CLAUDE.md](CLAUDE.md) for core rules and conventions. Consult this file when you need specific command syntax, architecture details, data source information, or talent build rules.

## Session Protocol

1. Run `SPEC=vengeance node src/engine/startup.js` to check config and simc sync status (use appropriate spec)
2. Check `MULTI-SPEC-PLAN.md` for any ongoing multi-phase work
3. Run `npm run db:status` to check theorycraft DB contents
4. Update CLAUDE.md if new commands, patterns, or architectural decisions emerge

## Data Sources

- **Raidbots** (`raidbots.com/static/data/{env}/talents.json`): Authoritative talent tree source. Provides class/spec/hero nodes with spell IDs, positions, choice variants. Environment: `live` or `ptr` (controlled by `config.json` `data.env`).
- **simc C++** (class module path from `config.json`): Implementation reference. Talent assignments via `talent.{tree}.{var}` patterns.
- **simc spell_query**: Runtime spell data (effects, coefficients). Limited by binary age.
- **SpellDataDump**: Full spell effect data, updated more frequently than the binary.

### Spell Data Interpretation

When effect data is ambiguous (e.g., unclear whether a value is a damage amp or DR, or what school a spell targets), read the spell's description/tooltip text. The `description` field in `spells.json` often clarifies the intended effect better than raw effect subtypes.

### Environment Toggle

Change `data.env` in the per-spec config file (`config.{spec}.json`) or in `config.json` (global default) to switch between `"live"`, `"ptr"`, or `"beta"`. Then run `SPEC={spec} npm run build-data` to regenerate from the new environment. Midnight data uses `"beta"`.

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

## Architecture

```
config.json              # Global settings (simc, data defaults, simulation, scenarios)
config.vengeance.json    # Vengeance spec identity (className, specName, specId)
config.devourer.json     # Devourer spec identity + overrides (e.g., data.env)
src/
  engine/           # Core engine (spec-agnostic)
    paths.js        # Centralized per-spec path resolution (dataDir, resultsDir, aplsDir)
    startup.js      # Loads config.json, deep-merges config.{spec}.json via initSpec(), checks simc sync
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
    raidbots-talents.json      # Raidbots talent data
  havoc/                  # Future: another DH spec
apls/
  vengeance/              # Per-spec APL files (exactly 3 tracked files)
    baseline.simc         # SimC default APL (self-contained, including talents)
    profile.simc          # Gear/config partial (NO talents — builds come from roster)
    vengeance.simc        # Our from-scratch APL (uses input=profile.simc)
    current.simc          # Iteration working copy (gitignored)
results/
  vengeance/              # Per-spec simulation output and persistent state
    theorycraft.db        # Unified SQLite: builds, archetypes, findings, hypotheses, iterations, roster
    SCHEMA.md             # Schema documentation
reference/                # Shared (cross-spec C++ source)
  vengeance-apl.simc
  simc-talent-variables.json
  .refresh-metadata.json
  wiki/                   # SimC wiki docs (auto-synced)
```

## Full Command Reference

All commands require a spec. Use `SPEC=vengeance` env var or `--spec vengeance` flag.

```bash
# === FULL REFRESH (after simc update) ===
SPEC=vengeance npm run refresh               # Rebuild everything from simc

# Environment variables for refresh:
#   SPEC=vengeance                           # Required: which spec to target
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

# === Build Roster (cluster-based, from SPEC_CONFIG templates) ===
npm run roster generate                      # Generate full roster from templates (recommended)
npm run roster show                          # Show roster with validation status
npm run roster import-community              # Import community builds from config
npm run roster import-baseline               # Import SimC default build
npm run roster validate                      # Re-validate all builds
npm run roster prune                         # Remove redundant builds within threshold
npm run roster generate-names                # Generate talent-diff display names
npm run roster update-dps                    # Refresh DPS from latest sim results

# === Simulation ===
node src/sim/runner.js apls/vengeance/baseline.simc  # Run simulation
node src/sim/analyze.js                              # Analyze results

# === Engine (all require SPEC env var or --spec flag) ===
SPEC=vengeance node src/engine/startup.js    # Check config + simc sync status
SPEC=vengeance node src/engine/extract.js    # Check extraction pipeline status
SPEC=vengeance node src/engine/model.js      # Check model pipeline status
SPEC=vengeance node src/util/validate.js     # Validate all data + staleness check
npm run db:migrate                           # One-time import of legacy JSON → SQLite
npm run db:migrate-theory                    # Migrate build-theory.json → DB tables
npm run db:migrate-mechanics                 # Migrate mechanics.json → findings table
npm run db:status                            # Show SQLite record counts
npm run db:dump                              # Print formatted DB summary to stdout
node src/util/db.js top 10                   # Top 10 builds by weighted DPS
npm run synthesize                           # Run hypothesis synthesizer standalone

# === Verification ===
npm run verify                               # Verify data against simc C++
npm run extract-simc                         # Extract simc C++ talent variables

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

## Internal Methodology

Embedded directly in agent and skill definitions:

- `.claude/agents/theorist.md` — resource flow, DPGCD, cooldown, talent interaction, proc analysis frameworks
- `.claude/agents/apl-engineer.md` — SimC APL mechanics, off-GCD weaving, mutation operations
- `.claude/agents/reviewer.md` — APL comprehension, verification, theory revision
- `.claude/agents/sim-runner.md` — iteration protocol, fidelity tiers, failure handling
- `.claude/skills/optimize.md` — full pipeline orchestration with inlined methodology

## Database Tables

- **builds** — All talent builds (cluster-generated, community, baseline) with hashes, DPS, display names, roster membership
- **archetypes** — Legacy DoE-discovered build archetypes (retained for history)
- **factors** — Legacy DoE factor impacts (retained for history)
- **synergies** — Talent synergy pairs
- **findings** — Validated analytical insights (including migrated mechanics)
- **hypotheses** — Optimization hypotheses (pending, tested, accepted, rejected)
- **iterations** — APL iteration history (accept/reject decisions with DPS deltas)
- **session_state** — Key-value store for iteration state
- **talent_clusters** — Spec talent cluster definitions (migrated from build-theory)
- **cluster_synergies** — Cluster × hero tree synergy ratings
- **tension_points** — Build tension/tradeoff definitions

**After accepting APL changes:** Re-run `npm run roster generate` to refresh the roster.
