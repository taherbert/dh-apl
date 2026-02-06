The ONE command for all APL and build optimization. Runs everything autonomously: discover archetypes, deep reasoning, parallel specialist analysis, synthesis, multi-build iteration, APL branching, and reporting. No user interaction required.

If `$ARGUMENTS` is provided (e.g., `/optimize Check soul fragment economy`), treat it as a **focus directive** — prioritize that area while still analyzing the full system. If no arguments, analyze the full rotation holistically.

## Architecture

```
/optimize (you are here)
    |
    +-- Phase 0: Setup + Build Discovery
    |     Startup, discover archetypes, generate build roster
    |
    +-- Phase 1: Deep Reasoning + Parallel Specialists
    |     Load ALL data, model economy, form root theories
    |     Launch 4 specialist subagents in parallel
    |
    +-- Phase 2: Synthesis + Hypothesis Ranking
    |     Cross-reference findings, rank hypotheses
    |     Proceed directly to testing (no confirmation gate)
    |
    +-- Phase 3: Multi-Build Iteration Loop
    |     Test against ALL roster builds simultaneously
    |     Create APL branches for archetypes/hero trees
    |     Accept/reject based on aggregate + per-build results
    |
    +-- Phase 4: Cross-Build Analysis + Final Report
          Re-rank builds, document build-specific APL paths, commit
```

## Internal Methodology References

Read these once at session start — not every iteration:

- `prompts/apl-analysis-guide.md` — Canonical knowledge base (Section 0) + calculation frameworks
- `prompts/full-analysis-methodology.md` — Economy modeling, systemic tensions, hypothesis generation
- `prompts/iterate-apl-methodology.md` — Iteration loop: modify, test, decide, record
- `prompts/theorycraft-methodology.md` — Temporal resource flow analysis
- `prompts/talent-analysis-methodology.md` — Talent interaction graphs, synergy clusters
- `prompts/analyze-apl-methodology.md` — APL comprehension walkthrough
- `prompts/apl-iteration-guide.md` — Iteration tactics and escape strategies

## Phase 0: Setup + Build Discovery

### 0a. Determine Active Spec

Run `node src/engine/startup.js` to determine the active spec. All paths below use `{spec}`.

### 0b. Check for Checkpoint / Existing State

```bash
node src/sim/iterate.js status
```

If iteration state exists, check `results/{spec}/checkpoint.md` and `results/{spec}/dashboard.md` to determine whether to resume or start fresh. If resuming, follow the warm restart protocol in `prompts/iterate-apl-methodology.md`.

### 0c. Discover Archetypes and Generate Build Roster

**This is foundational.** Before any analysis, establish the build landscape:

```bash
# Run DoE-based build discovery (quick fidelity for speed)
npm run discover -- --quick

# Generate build roster (2-3 builds per archetype)
node src/sim/build-roster.js generate --tier standard
```

Build discovery uses Design of Experiments (DoE) to:

1. Generate fractional factorial talent combinations
2. Simulate all combinations across ST/5T/10T scenarios
3. Compute factor impacts (which talents matter most for DPS)
4. Cluster builds into archetypes based on forming factors (top differentiating talents)
5. Identify 2-factor synergy interactions

Output: `results/{spec}/builds.json` with `discoveredArchetypes[]`, `allBuilds[]`, `factorImpacts[]`, `synergyPairs[]`

The build roster (`results/{spec}/build-roster.json`) contains 2-3 builds per archetype across all hero trees. ALL subsequent simulation testing uses this roster.

**If builds.json already exists and is < 24h old**, skip discovery and just regenerate the roster.

### 0d. Establish Multi-Build Baseline

```bash
node src/sim/iterate.js init apls/{spec}/{spec}.simc
```

With a build roster present, `init` automatically runs multi-build baseline simulation across all roster builds and scenarios. This establishes per-build DPS numbers that all subsequent comparisons test against.

### 0e. Load the Full Knowledge Base

**Read `prompts/apl-analysis-guide.md` Section 0** — the single canonical list of all data sources. Load all 4 tiers:

- **Tier 1 (Mechanical Blueprint):** Spec adapter (`src/spec/{spec}.js`), APL, spell data (`data/{spec}/spells-summary.json`)
- **Tier 2 (Interactions):** `data/{spec}/interactions-summary.json`, `data/{spec}/cpp-proc-mechanics.json`, `data/{spec}/build-theory.json`
- **Tier 3 (Accumulated Knowledge):** `results/{spec}/findings.json` (filter `status: "validated"`), `results/{spec}/hypotheses.json`, `results/{spec}/builds.json` (especially `discoveredArchetypes` and `factorImpacts`)
- **Tier 4 (External):** Wowhead/Icy Veins when internal data has gaps (treat as hypotheses, not truth)

Also read methodology: `prompts/full-analysis-methodology.md` and `prompts/apl-iteration-guide.md`.

## Phase 1: Deep Reasoning + Parallel Specialists

### 1a. Deep Reasoning (REQUIRED before specialists)

**This is the most important step.** Before launching any specialists, form your own understanding using ALL available data INCLUDING the archetype discovery results:

1. **Study the archetypes** — What talent clusters define each archetype? What factor impacts are largest? Which synergy pairs create compound value? How do archetypes differ in their rotation needs?
2. **Model the economy** — Resource generation/spending equilibrium, GCD budget, marginal values per spender (see `prompts/full-analysis-methodology.md` Phase 1)
3. **Identify systemic tensions** — Resource competition, cooldown misalignment, burst window waste, state machine incoherence
4. **Map archetype-specific tensions** — Where do different archetypes need different APL behavior? Which talents fundamentally change the rotation?
5. **Study reference APL** — Read `reference/{spec}-apl.simc` for SimC syntax patterns (NOT priorities)

**Form 2-3 root theories** — these GUIDE everything that follows:

- "The biggest opportunity is X because Y, supported by Z from the data"
- "Archetypes A and B need different treatment of ability X because..."
- "The APL treats all builds the same for X, but archetype C needs..."

### 1b. Parallel Specialist Launch

Launch 4 specialist analyses IN PARALLEL using the Task tool with `subagent_type: "general-purpose"`.

**IMPORTANT:** Launch all 4 in a SINGLE message. Include your root theories and the archetype discovery results in each prompt.

**Specialist 1: Spell Data** — DPGCD rankings, modifier stacking, school clusters, proc mechanics
Reads: `data/{spec}/spells-summary.json`, `data/{spec}/cpp-proc-mechanics.json`, `data/{spec}/interactions-summary.json`
Writes to: `results/{spec}/analysis_spell_data.json`

**Specialist 2: Talent Interactions** — Synergy clusters, anti-synergies, build-APL coupling, archetype-specific talent value
Reads: `data/{spec}/talents.json`, `data/{spec}/interactions-summary.json`, `data/{spec}/build-theory.json`, `results/{spec}/builds.json`
Writes to: `results/{spec}/analysis_talent.json`
Methodology: `prompts/talent-analysis-methodology.md`

**Specialist 3: Resource Flow** — Resource equilibrium per archetype, GCD budget, cooldown cycles, burst windows
Reads: `data/{spec}/spells-summary.json`, `data/{spec}/cpp-proc-mechanics.json`, APL, `data/{spec}/build-theory.json`
Writes to: `results/{spec}/analysis_resource_flow.json`
Methodology: `prompts/theorycraft-methodology.md`

**Specialist 4: State Machine / APL Coherence** — Hero tree rhythms, variable correctness, dead code, missing talent gates, archetype branching gaps
Reads: APL, `data/{spec}/build-theory.json`, `data/{spec}/spells-summary.json`
Writes to: `results/{spec}/analysis_state_machine.json`
Methodology: `prompts/analyze-apl-methodology.md`

## Phase 2: Synthesis

### 2a. Read Specialist Outputs + Run Synthesis

```bash
node src/sim/iterate.js synthesize
```

Read all four `results/{spec}/analysis_*.json` files. Cross-reference with root theories.

### 2b. Evaluate and Rank Hypotheses

Filter through root theories:

- Specialist findings aligned with theories → high priority
- Your theories that specialists missed → highest priority (these are the deep insights)
- Specialist findings with no causal backing → lower priority

**Categorize hypotheses by scope:**

1. **Universal** — should help ALL builds (resource economy, core rotation logic)
2. **Archetype-specific** — help builds with talent X but not builds without it
3. **Hero-tree-specific** — help one hero tree's builds
4. **Build-specific** — narrow improvements for one build configuration

### 2c. Generate Analysis Summary

Write `results/{spec}/analysis_summary.md` with economic models, tensions, hypotheses, archetype analysis.

Initialize `results/{spec}/dashboard.md` and `results/{spec}/changelog.md`.

**Proceed directly to testing.** Do not wait for user confirmation — sim compute is not a concern.

## Phase 3: Multi-Build Iteration Loop

**Every test runs against ALL roster builds simultaneously.** This is non-negotiable — an improvement that helps one archetype but hurts another is only valuable if the APL can branch to apply it selectively.

### Iteration Protocol

For each hypothesis:

```bash
# 1. Generate candidate APL
# Apply the change to apls/{spec}/current.simc, save as apls/{spec}/candidate.simc

# 2. Quick screen against all builds
node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick

# 3. Evaluate multi-build results:
#    - Check per-build deltas (which archetypes gain, which lose)
#    - Check aggregate: mean weighted, worst weighted, per-tree averages
#    - If ANY archetype regresses >1%, check if APL branching can isolate the change

# 4. If promising, confirm at higher fidelity
node src/sim/iterate.js compare apls/{spec}/candidate.simc

# 5. Accept or reject
node src/sim/iterate.js accept "reason" --hypothesis "fragment"
node src/sim/iterate.js reject "reason" --hypothesis "fragment"
```

### Decision Criteria (Multi-Build)

**Accept if:**

- Mean weighted improvement > 0 AND statistically significant
- No build regresses > 0.5% (weighted) without compensating gains
- OR: improvement is build-specific AND can be gated with an APL branch

**Accept with branching if:**

- Some archetypes gain, others lose
- The change can be gated behind a talent/hero tree condition
- Create an APL branch: `call_action_list,name=X,if=talent.Y.enabled` or `if=hero_tree.Z`

**Reject if:**

- No significant improvement across any build
- Regressions in multiple archetypes without clear branching path

### APL Branching Strategy

When a hypothesis helps some builds but hurts others, **create targeted APL branches** instead of rejecting:

**By hero tree:**

```
actions+=/run_action_list,name=ar_core,if=hero_tree.aldrachi_reaver
actions+=/run_action_list,name=anni_core,if=hero_tree.annihilator
```

**By talent choice:**

```
actions+=/call_action_list,name=spirit_bomb_priority,if=talent.spirit_bomb.enabled
```

**By target count:**

```
actions+=/call_action_list,name=aoe,if=spell_targets.sigil_of_flame>=3
```

**By archetype (talent combination):**

```
# Use variables to detect archetype
variable,name=is_sbomb_fallout,value=talent.spirit_bomb.enabled&talent.fallout.enabled
actions+=/call_action_list,name=sbomb_rotation,if=variable.is_sbomb_fallout
```

**Document every branch** with a comment explaining which archetype/build it serves and why the branch exists:

```
# Spirit Bomb + Fallout archetype: pool fragments to 5 before SBomb
# because Fallout generates extra fragments on Immolation Aura tick
actions.sbomb_rotation=...
```

### After Each Accept

1. Record to `results/{spec}/findings.json` with scope (universal/archetype/hero-tree/build)
2. Update `results/{spec}/dashboard.md` with per-build deltas
3. Update `results/{spec}/changelog.md`
4. Commit the accepted change
5. Check for second-order effects: did resource equilibrium shift? Did a new ability become valuable for certain builds?

### Parallelism in Iteration

When multiple independent hypotheses exist:

1. Launch 2-3 Task subagents, each testing a different candidate with `--quick`
2. Each subagent writes a unique candidate file and reports per-build deltas
3. Promote the best candidate to standard fidelity

### Stop Conditions

- 3 consecutive rejections with no new hypotheses → try escape strategies per `prompts/apl-iteration-guide.md`
- 10 consecutive rejections → stop
- All hypothesis categories exhausted AND escape strategies tried → stop
- Context approaching limits → save checkpoint, suggest re-running `/optimize`

## Phase 4: Cross-Build Analysis + Final Report

### 4a. Re-rank Builds Under Updated APL

```bash
npm run discover -- --quick
```

Compare archetype rankings before vs after. Did the optimization change which builds are strongest?

### 4b. Audit APL Branch Coverage

Review the final APL and verify:

- Every archetype has appropriate branching where needed
- No dead branches (talent conditions that no roster build satisfies)
- Branch comments document which archetypes they serve
- Shared logic (used by all archetypes) is in the default/core list, not duplicated in branches

### 4c. Record Findings

Append all insights to `results/{spec}/findings.json`:

```json
{
  "id": "finding_id",
  "timestamp": "ISO8601",
  "hypothesis": "description",
  "status": "validated",
  "scope": "universal|archetype|hero-tree|build",
  "archetype": "archetype_name (if scope != universal)",
  "builds": ["affected_build_ids"],
  "impact": { "st": "+X%", "small_aoe": "+Y%", "big_aoe": "+Z%" },
  "mechanism": "explanation of why this worked",
  "aplBranch": "name of APL branch if applicable"
}
```

### 4d. Generate Final Reports

```bash
node src/sim/iterate.js summary
```

Update `results/{spec}/dashboard.md` with:

- Per-archetype DPS improvements
- Per-build DPS improvements
- APL branches created and their impact

### 4e. Print Session Summary

- Archetypes discovered and builds tested
- Hypotheses tested / accepted / rejected
- Universal vs archetype-specific improvements
- Total DPS improvement per archetype (weighted)
- APL branches created
- Remaining untested ideas

### 4f. Commit

```bash
git add apls/{spec}/current.simc results/{spec}/
git commit -m "optimize: {spec} — N iterations, M accepted, +X.XX% mean weighted DPS"
```

## Checkpoint Protocol

On context limits or interruption, save to `results/{spec}/checkpoint.md`:

- Current phase, hypothesis, per-build progress
- Archetypes analyzed, APL branches created
- Remaining work
- Resume: "Run `/optimize` — startup will detect this checkpoint"

## Multi-Build Infrastructure Reference

### Build Discovery

```bash
npm run discover -- --quick        # DoE-based: ~2-5 min
npm run discover -- --ar-only      # Filter by hero tree
npm run discover                   # Standard fidelity: ~10-20 min
```

### Build Roster

```bash
node src/sim/build-roster.js generate --tier fast      # 1 build/archetype
node src/sim/build-roster.js generate --tier standard  # 2-3 builds/archetype
node src/sim/build-roster.js generate --tier full      # All builds/archetype
```

### Talent Hashing

```bash
node src/util/talent-string.js --decode <hash>              # Decode to talent list
node src/util/talent-string.js --modify <hash> +Talent -Talent  # Modify build
node src/util/talent-string.js --test <hash>                # Round-trip validation
```

### Multi-Build Iteration

```bash
node src/sim/iterate.js init <apl>           # Multi-build baseline (auto-detects roster)
node src/sim/iterate.js compare <candidate>  # Tests against ALL roster builds
node src/sim/iterate.js status               # Shows per-build DPS + aggregate
```

## Anti-Patterns

- **Single-build testing** — ALWAYS test against the full roster. An improvement that helps one build but hurts others is only useful if you branch the APL.
- **Specialists without theory** — form root theories BEFORE launching specialists.
- **Sequential specialist execution** — ALWAYS launch all 4 in parallel.
- **Flat APL for diverse builds** — if archetypes have meaningfully different rotations, the APL MUST branch. A single priority list cannot optimally serve builds with different talent interactions.
- **Undocumented branches** — every APL branch must have a comment explaining which archetype it serves and why.
- **Trusting screener output without reasoning** — "buff uptime is low" is an observation, not an insight.
- **Grinding thresholds without theory** — test values derived from mechanical reasoning, not arbitrary sweeps.
- **Testing talent swaps with unadapted APL** — coupled hypotheses need both build AND APL changes.
- **Hardcoding spec-specific knowledge** — read from the spec adapter, not from memory.
- **Ignoring per-build results** — the aggregate mean can hide regressions in specific archetypes. Always check per-build deltas.
