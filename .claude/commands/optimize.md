Co-optimize talent build and APL together. The build determines what the rotation CAN do; the APL determines what it DOES. Optimizing either in isolation leaves value on the table.

This is the master orchestrator. It launches parallel specialist analyses, synthesizes their outputs, and executes deep iteration loops across archetypes and builds.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CENTRAL ORCHESTRATOR                         │
│                      (/optimize skill)                           │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ SPELL DATA      │ │ TALENT          │ │ RESOURCE FLOW   │
│ SPECIALIST      │ │ SPECIALIST      │ │ SPECIALIST      │
│                 │ │                 │ │                 │
│ - DPGCD ranks   │ │ - Synergy       │ │ - Resource      │
│ - Modifier      │ │   clusters      │ │   equilibrium   │
│   stacking      │ │ - Anti-synergies│ │ - Cooldown      │
│ - School        │ │ - Build-APL     │ │   cycles        │
│   clusters      │ │   coupling      │ │ - Timing        │
│                 │ │                 │ │   conflicts     │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         │          ┌────────┴────────┐          │
         │          │ STATE MACHINE   │          │
         │          │ SPECIALIST      │          │
         │          │                 │          │
         │          │ - Hero tree     │          │
         │          │   rhythms       │          │
         │          │ - Variable      │          │
         │          │   coherence     │          │
         │          │ - Dead code     │          │
         │          └────────┬────────┘          │
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │     SYNTHESIS       │
                  │                     │
                  │ - Cross-analyst     │
                  │   consensus         │
                  │ - Compound          │
                  │   hypotheses        │
                  │ - Conflict          │
                  │   resolution        │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │   DEEP ITERATION    │
                  │                     │
                  │ FOR each archetype: │
                  │   FOR each build:   │
                  │     FOR hypothesis: │
                  │       mutate → test │
                  │       record → loop │
                  └─────────────────────┘
```

## Startup

### 0. Determine Active Spec

Run `node src/engine/startup.js` to load config and determine the active spec. The output includes the spec name (e.g., `vengeance`). Use this spec name for ALL path construction below — replace `{spec}` with the actual spec name throughout.

All per-spec paths follow these patterns:

- Data: `data/{spec}/filename.json`
- Results: `results/{spec}/filename.json`
- APLs: `apls/{spec}/filename.simc`

### 1. Check Knowledge System

**BEFORE launching specialists, check existing knowledge:**

```bash
# Check for known mechanics (avoid re-analyzing)
cat data/{spec}/mechanics.json 2>/dev/null

# Check for untested hypotheses (might already have ideas queued)
cat results/{spec}/hypotheses.json 2>/dev/null

# Check for validated findings (don't re-test)
cat results/{spec}/findings.json 2>/dev/null | jq '.[] | select(.status == "validated")'
```

If `mechanics.json` has relevant mechanics for the current focus:

- Use those facts directly — don't re-analyze C++
- Reference the source file for deep details

If `hypotheses.json` has untested hypotheses:

- Consider testing those before generating new ones
- Prioritize by priority field

### 2. Check for Checkpoint

```bash
# Check if resuming from a previous session
cat results/{spec}/checkpoint.md 2>/dev/null
node src/sim/iterate.js status

# Check for synthesis output (ranked hypotheses from previous run)
cat results/{spec}/synthesis.json 2>/dev/null
```

If checkpoint exists and is < 24h old:

- Read checkpoint position (archetype/build/hypothesis)
- Read problem statement and root theory for context
- Check if specialist outputs are fresh (< 24h)
- If fresh: skip to Deep Iteration at checkpoint position
- If stale: re-run specialists, then resume at checkpoint position

If synthesis.json exists and is < 24h old:

- Can resume from ranked hypothesis list
- Skip specialist phase if hypotheses still relevant

### 3. Load Context (if not resuming)

**Tier 1 — Always load:**

```
data/{spec}/mechanics.json           # Known mechanical facts
data/{spec}/spells-summary.json      # Context-efficient spell data
data/{spec}/cpp-proc-mechanics.json  # Proc rates, ICDs, constants
results/{spec}/findings.json         # Filter status: "validated"
results/{spec}/hypotheses.json       # Queued hypotheses
results/{spec}/builds.json           # Discovered archetypes + rankings
```

**Tier 2 — For specialist synthesis:**

```
data/{spec}/talents.json             # Full talent tree
data/{spec}/interactions-summary.json # Talent-spell interaction map
data/{spec}/build-theory.json        # Curated archetype/cluster knowledge
```

### 4. Establish Baseline

```bash
# Initialize iteration state if not already present
# Use $ARGUMENTS if provided, otherwise default to the spec's main APL
node src/sim/iterate.js init $ARGUMENTS  # or apls/{spec}/{spec}.simc
```

## Phase 0: Deep Reasoning (REQUIRED before specialists)

Before launching any specialists, the orchestrator must form its own understanding. This prevents specialists from operating in a vacuum and ensures their output can be evaluated against a theory.

1. Read the current APL (`apls/{spec}/current.simc` or `apls/{spec}/{spec}.simc`)
2. Read `data/{spec}/spells-summary.json` and `data/{spec}/build-theory.json`
3. Think through the mechanical system:
   - What is the resource generation/spending equilibrium? Where is waste?
   - What cooldown cycles exist and how do they interact?
   - What talent interactions create the most leverage?
   - What about the current APL structure seems suboptimal and WHY?
4. Form 2-3 **root theories** — "The biggest opportunity is X because Y"
5. These root theories GUIDE what the specialists should focus on and how to evaluate their output

The specialists below are research assistants, not decision makers. They gather evidence. The orchestrator reasons about that evidence through the lens of its root theories.

## Phase 1: Parallel Specialist Launch

Launch 4 specialist analyses IN PARALLEL using the Task tool. Each specialist writes structured output to `results/{spec}/analysis_*.json`.

**IMPORTANT:** Launch all 4 specialists in a SINGLE message with 4 Task tool calls. Do NOT wait for one to complete before launching the next.

### Specialist Prompts

**Spell Data Specialist:**

```
Analyze the current spec's spell data for APL optimization opportunities.

Read the active spec's data files:
- data/{spec}/spells-summary.json
- data/{spec}/cpp-proc-mechanics.json

Also read for context:
- data/{spec}/interactions-summary.json

Produce analysis:
1. DPGCD ranking — damage per GCD for each ability, accounting for:
   - Base damage + modifiers from current build
   - Resource cost (primary resource, fragment consumption)
   - GCD length
2. Modifier stacking depth — which abilities have the most amplifiers?
3. School clusters — which abilities share damage schools for synergy?
4. Proc mechanics — ICD conflicts, proc rate misalignments

Generate hypotheses in this format:
{
  "id": "unique_id",
  "category": "SPELL_DATA",
  "systemicIssue": "description of the issue found",
  "mechanism": "detailed explanation with numbers",
  "expectedImpact": "estimated DPS impact",
  "priority": 1-10,
  "proposedChanges": [{ "type": "move_up|move_down|add_condition|...", "ability": "name", ... }]
}

Write output to: results/{spec}/analysis_spell_data.json
Include timestamp in output for freshness checking.
```

**Talent Specialist:**

```
Analyze the current spec's talent interactions for build-APL co-optimization.

Read the active spec's data files:
- data/{spec}/talents.json
- data/{spec}/interactions-summary.json
- data/{spec}/build-theory.json

Also read for context:
- results/{spec}/builds.json
- results/{spec}/findings.json

Produce analysis:
1. Synergy clusters — which talents amplify each other?
2. Anti-synergies — which talents compete or conflict?
3. Build-APL coupling points — which talents require APL restructuring if changed?
4. Weakest talents in current build (lowest contribution per point)
5. Strongest unchosen talents (highest potential contribution)

Generate hypotheses in the spell data format.
Focus on COUPLED hypotheses that require both build AND APL changes.

Write output to: results/{spec}/analysis_talent.json
Include timestamp in output for freshness checking.
```

**Resource Flow Specialist:**

```
Analyze the current spec's resource economy for timing optimization.

Read the active spec's data files:
- data/{spec}/spells-summary.json
- data/{spec}/cpp-proc-mechanics.json

Read the APL to analyze:
- apls/{spec}/current.simc (if it exists, otherwise apls/{spec}/{spec}.simc)

Also read for context:
- data/{spec}/build-theory.json (for resource model documentation)

Produce analysis:
1. Resource generation/spending equilibrium — are we capping? starving?
2. Secondary resource (fragments, combo points, etc.) generation rate vs consumption — optimal thresholds?
3. GCD budget allocation — mandatory vs discretionary GCDs
4. Cooldown cycle map — alignment windows, collision points
5. Burst window utilization — do we pre-stock resources?

Generate hypotheses focused on TIMING:
- Pooling before burst windows
- Threshold adjustments based on resource flow
- Cooldown sequencing improvements

Write output to: results/{spec}/analysis_resource_flow.json
Include timestamp in output for freshness checking.
```

**State Machine Specialist:**

```
Analyze the current spec's APL state machine for coherence.

Read the APL to analyze:
- apls/{spec}/current.simc (if it exists, otherwise apls/{spec}/{spec}.simc)

Read for context:
- data/{spec}/build-theory.json (hero tree state machines, burst windows)
- data/{spec}/spells-summary.json

Produce analysis:
1. Hero tree state machine — does the APL respect each hero tree's rhythms?
2. Variable usage — are computed states correct? any stale values?
3. Action list delegation — run_action_list vs call_action_list usage
4. Dead code — unreachable conditions, redundant checks
5. Missing gates — talent conditions that should exist but don't

Generate hypotheses focused on STATE COHERENCE:
- Variable corrections
- Missing phase sub-lists
- Timing guard additions

Write output to: results/{spec}/analysis_state_machine.json
Include timestamp in output for freshness checking.
```

## Phase 2: Synthesis

After all 4 specialists complete:

### 2a. Read Specialist Outputs

Read all four analysis files:

```
results/{spec}/analysis_spell_data.json
results/{spec}/analysis_talent.json
results/{spec}/analysis_resource_flow.json
results/{spec}/analysis_state_machine.json
```

### 2b. Run Programmatic Synthesis

```bash
node src/sim/iterate.js synthesize
```

This runs the hypothesis synthesizer which cross-references multiple specialist sources, detects consensus, and ranks hypotheses.

### 2c. Generate Human-Readable Summary

Write `results/{spec}/analysis_summary.md` with:

1. **High-Consensus Hypotheses** — supported by 2+ specialists
2. **Compound Hypotheses** — require multiple APL mutations
3. **Conflicts** — contradictory recommendations with resolution strategy
4. **By Archetype** — which apply universally vs hero-tree-specific
5. **Specialist Findings** — key insights from each specialist

### 2d. Initialize Tracking Files

Write `results/{spec}/dashboard.md` with initial state:

```markdown
# Optimization Dashboard

**Spec:** {spec}
**Started:** {timestamp}
**Baseline DPS:** (from iterate.js status)

## Progress

| Iteration | Hypothesis | Result | Impact |
| --------- | ---------- | ------ | ------ |
| (empty)   |            |        |        |

## Stats

- Tested: 0
- Accepted: 0
- Rejected: 0
- Consecutive Rejections: 0
```

Write `results/{spec}/changelog.md` with:

```markdown
# Optimization Changelog

## {date} Session

### Accepted Changes

(none yet)

### Rejected Hypotheses

(none yet)
```

### 2e. Present and Confirm

Present the synthesized hypotheses to the user. Include:

- The ranked hypothesis list from the synthesis
- Key conflicts and how you propose to resolve them
- Which archetypes each hypothesis targets

**Wait for user confirmation before proceeding to testing.**

## Phase 3: Deep Iteration Loop

Execute the nested iteration loop:

```
FOR EACH archetype (from data/{spec}/build-theory.json):
  FOR EACH build in archetype (from results/{spec}/builds.json):
    FOR EACH hypothesis (from synthesis):
      1. Generate candidate APL
      2. Run quick screen
      3. If promising: run confirm fidelity
      4. Record to results/{spec}/findings.json
      5. If accepted: check for second-order effects
```

### Iteration Protocol

For each hypothesis:

```bash
# 1. Generate candidate using auto-mutation if available
node src/sim/iterate.js generate

# 2. Quick screen
node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick

# 3. If promising (weighted > 0.1%), confirm
node src/sim/iterate.js compare apls/{spec}/candidate.simc --confirm

# 4. Accept or reject
node src/sim/iterate.js accept "reason" --hypothesis "fragment"
# OR
node src/sim/iterate.js reject "reason" --hypothesis "fragment"
```

### After Each Iteration

Update `results/{spec}/dashboard.md` with the new row.

Update `results/{spec}/changelog.md` with the accepted change or rejected hypothesis.

### Hypothesis Types

**Simple (auto-mutation available):**

- Use `node src/sim/iterate.js generate` to create candidate
- Test directly

**Compound (multiple changes):**

- Apply mutations sequentially using src/apl/mutator.js
- Test the combined result

**Coupled (build + APL):**

1. Generate modified profile with new talents string
2. Write candidate APL with adapted action lines
3. Compare against current baseline
4. ALSO compare new build with OLD APL (to measure coupling value)

### Second-Order Effects

After accepting a change, check for downstream impacts:

- Did resource equilibrium shift? Re-evaluate thresholds
- Did a new ability become valuable? Check priority ordering
- Did burst window characteristics change? Re-evaluate pooling

Generate new hypotheses based on the accepted change.

## Phase 4: Cross-Build Analysis

After completing all builds in an archetype:

1. **Universal Improvements** — which changes helped ALL builds?
2. **Archetype-Specific** — which only helped certain builds?
3. **Build-Specific** — which only helped one build?

Record findings to `results/{spec}/findings.json`:

```json
{
  "id": "finding_id",
  "timestamp": "ISO8601",
  "hypothesis": "description",
  "status": "validated",
  "scope": "universal|archetype|build",
  "archetype": "archetype_name",
  "builds": ["affected_build_ids"],
  "impact": { "st": "+X%", "small_aoe": "+Y%", "big_aoe": "+Z%" },
  "mechanism": "explanation of why this worked"
}
```

After completing all archetypes, re-rank builds under the updated APL:

```bash
npm run discover -- --quick
```

## Checkpoint Protocol

### On Context Limits or Interruption

Save state to `results/{spec}/checkpoint.md`:

```markdown
# Optimization Checkpoint

**Timestamp:** {ISO8601}
**Spec:** {spec}
**Current Archetype:** {archetype_name}
**Current Build:** {build_id}
**Current Hypothesis:** {hypothesis_id}
**Iterations Completed:** N
**Accepted:** M
**Rejected:** R

## Key Observations

- {insight 1}
- {insight 2}

## Remaining Work

- {what's left to do}

## Resume Instructions

1. Run /optimize
2. Startup will detect this checkpoint and resume from here
```

Also save iterate.js state:

```bash
node src/sim/iterate.js status
```

### On Session Resume

1. Run `node src/engine/startup.js` to determine active spec
2. Run `node src/sim/iterate.js status`
3. Read `results/{spec}/checkpoint.md`
4. If specialist outputs < 24h old: reuse them
5. If specialist outputs > 24h old: re-run Phase 1
6. Resume from checkpoint position

## Loop Termination

Stop when ALL of these are true:

- No untested hypothesis has expected gain > 0.3%
- 10 consecutive rejections across all builds
- At least one full pass through archetypes produced no accepts

OR when:

- Context approaching limits — save checkpoint and suggest re-running

## Session Completion

### 1. Generate Final Reports

```bash
node src/sim/iterate.js summary
```

### 2. Update Dashboard

Write final state to `results/{spec}/dashboard.md` with complete iteration table and summary statistics.

### 3. Print Session Summary

Output to the user:

- **Spec analyzed:** the active spec name
- **Archetypes covered:** list
- **Builds tested per archetype:** counts
- **Hypotheses tested / accepted / rejected:** totals
- **Total DPS improvement:** weighted across scenarios
- **Key Findings:**
  - Universal improvements (apply to all builds)
  - Archetype-specific discoveries
  - Mechanism insights (why things worked/didn't)
- **Remaining Work:**
  - Untested hypotheses for next session
  - Checkpoint position for resume
  - Areas needing deeper investigation

### 4. Commit

```bash
git add apls/{spec}/current.simc results/{spec}/
git commit -m "optimize: {spec} — N iterations, M accepted, +X.XX% weighted DPS"
```

## Anti-Patterns

- **Specialists without theory** — launching specialists before the orchestrator has its own understanding. Specialists gather evidence; the orchestrator reasons about it. If you can't explain WHY a specialist's finding matters mechanically, it's not actionable.
- **Sequential specialist execution** — ALWAYS launch all 4 in parallel
- **Shallow iteration** — test one thing, accept/reject, repeat without depth. Every iteration must connect back to a causal theory.
- **Ignoring consensus** — hypotheses supported by multiple specialists are higher confidence
- **Skipping second-order effects** — an accepted change may enable further improvements
- **Testing talent swaps with unadapted APL** — coupled hypotheses need both changes
- **Grinding thresholds without theory** — "resource>=38 vs 40 vs 42" without mechanism
- **Trusting screener output without reasoning** — automated generators find patterns, not causes. "Buff uptime is low" is an observation, not an insight. The insight is understanding WHY it's low and what the fix costs in GCDs, resources, and opportunity.
- **Hardcoding spec-specific knowledge** — read from the spec adapter, not from memory
