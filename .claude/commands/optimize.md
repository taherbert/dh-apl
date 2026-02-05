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
│ - DPGCD ranks   │ │ - Synergy       │ │ - Fury/frag     │
│ - Modifier      │ │   clusters      │ │   equilibrium   │
│   stacking      │ │ - Anti-synergies│ │ - Cooldown      │
│ - School        │ │ - Build-APL     │ │   cycles        │
│   clusters      │ │   coupling      │ │ - Timing        │
│                 │ │                 │ │   conflicts     │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
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

### 1. Check Knowledge System

**BEFORE launching specialists, check existing knowledge:**

```bash
# Check for known mechanics (avoid re-analyzing)
cat data/mechanics.json 2>/dev/null

# Check for untested hypotheses (might already have ideas queued)
cat results/hypotheses.json 2>/dev/null

# Check for validated findings (don't re-test)
cat results/findings.json 2>/dev/null | jq '.[] | select(.status == "validated")'
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
cat results/checkpoint.md 2>/dev/null
node src/sim/iterate.js status

# Check for synthesis.json (ranked hypotheses from previous run)
cat results/synthesis.json 2>/dev/null
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
data/mechanics.json          # Known mechanical facts
data/spells-summary.json
data/cpp-proc-mechanics.json
results/findings.json (filter status: "validated")
results/hypotheses.json      # Queued hypotheses
results/builds.json
```

**Tier 2 — For specialist synthesis:**

```
data/talents.json
data/interactions-summary.json
data/build-theory.json
```

### 3. Establish Baseline

```bash
# Initialize iteration state if not already present
node src/sim/iterate.js init $ARGUMENTS  # or apls/vengeance.simc
```

## Phase 1: Parallel Specialist Launch

Launch 4 specialist analyses IN PARALLEL using TaskCreate. Each specialist writes structured output to `results/analysis_*.json`.

**IMPORTANT:** Launch all 4 specialists in a SINGLE message with 4 TaskCreate calls. Do NOT wait for one to complete before launching the next.

### Specialist Prompts

**Spell Data Specialist:**

```
Analyze VDH spell data for APL optimization opportunities.

Read: data/spells-summary.json, data/cpp-proc-mechanics.json

Produce analysis:
1. DPGCD ranking — damage per GCD for each ability, accounting for:
   - Base damage + modifiers from current build
   - Resource cost (Fury, fragment consumption)
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

Write output to: results/analysis_spell_data.json
Include timestamp in output for freshness checking.
```

**Talent Specialist:**

```
Analyze VDH talent interactions for build-APL co-optimization.

Read: data/talents.json, data/interactions-summary.json, data/build-theory.json

Produce analysis:
1. Synergy clusters — which talents amplify each other?
2. Anti-synergies — which talents compete or conflict?
3. Build-APL coupling points — which talents require APL restructuring if changed?
4. Weakest talents in current build (lowest contribution per point)
5. Strongest unchosen talents (highest potential contribution)

Generate hypotheses in the spell data format.
Focus on COUPLED hypotheses that require both build AND APL changes.

Write output to: results/analysis_talent.json
```

**Resource Flow Specialist:**

```
Analyze VDH resource economy for timing optimization.

Read: data/spells-summary.json, apls/current.simc (or vengeance.simc)

Produce analysis:
1. Fury generation/spending equilibrium — are we capping? starving?
2. Fragment generation rate vs consumption — optimal thresholds?
3. GCD budget allocation — mandatory vs discretionary GCDs
4. Cooldown cycle map — alignment windows, collision points
5. Burst window utilization — do we pre-stock resources?

Generate hypotheses focused on TIMING:
- Pooling before burst windows
- Threshold adjustments based on resource flow
- Cooldown sequencing improvements

Write output to: results/analysis_resource_flow.json
```

**State Machine Specialist:**

```
Analyze VDH APL state machine for coherence.

Read: apls/current.simc (or vengeance.simc), data/build-theory.json

Produce analysis:
1. Hero tree state machine — does the APL respect AR/Anni rhythms?
2. Variable usage — are computed states correct? any stale values?
3. Action list delegation — run_action_list vs call_action_list usage
4. Dead code — unreachable conditions, redundant checks
5. Missing gates — talent conditions that should exist but don't

Generate hypotheses focused on STATE COHERENCE:
- Variable corrections
- Missing phase sub-lists
- Timing guard additions

Write output to: results/analysis_state_machine.json
```

## Phase 2: Synthesis

After all 4 specialists complete, run synthesis:

```javascript
// Read and synthesize specialist outputs
import {
  loadSpecialistOutputs,
  synthesize,
  generateSynthesisReport,
} from "./src/analyze/synthesizer.js";

const outputs = loadSpecialistOutputs();
const result = synthesize(outputs);

// result contains:
// - hypotheses: ranked list with consensus scores
// - compound: hypotheses requiring multiple changes
// - simple: single-change hypotheses
// - conflicts: contradictory recommendations
// - byArchetype: grouped by universal/AR/Anni
```

### Synthesis Output

Present the synthesized hypotheses to the user:

1. **High-Consensus Hypotheses** — supported by 2+ specialists
2. **Compound Hypotheses** — require multiple APL mutations
3. **Conflicts** — contradictory recommendations with resolution strategy
4. **By Archetype** — which apply universally vs hero-tree-specific

Wait for user confirmation before proceeding to testing.

## Phase 3: Deep Iteration Loop

Execute the nested iteration loop:

```
FOR EACH archetype (from build-theory.json):
  FOR EACH build in archetype (from builds.json):
    FOR EACH hypothesis (from synthesis):
      1. Generate candidate APL
      2. Run quick screen
      3. If promising: run confirm fidelity
      4. Record to findings.json
      5. If accepted: check for second-order effects
```

### Iteration Protocol

For each hypothesis:

```bash
# 1. Generate candidate using auto-mutation if available
node src/sim/iterate.js generate

# 2. Quick screen
node src/sim/iterate.js compare apls/candidate.simc --quick

# 3. If promising (weighted > 0.1%), confirm
node src/sim/iterate.js compare apls/candidate.simc --confirm

# 4. Accept or reject
node src/sim/iterate.js accept "reason" --hypothesis "fragment"
# OR
node src/sim/iterate.js reject "reason" --hypothesis "fragment"
```

### Hypothesis Types

**Simple (auto-mutation available):**

- Use `node src/sim/iterate.js generate` to create candidate
- Test directly

**Compound (multiple changes):**

- Apply mutations sequentially using src/apl/mutator.js
- Test the combined result

**Coupled (build + APL):**

1. Generate modified profile.simc with new talents string
2. Write candidate.simc with adapted APL
3. Compare against current baseline
4. ALSO compare new build with OLD APL (to measure coupling value)

### Second-Order Effects

After accepting a change, check for downstream impacts:

- Did resource equilibrium shift? → Re-evaluate thresholds
- Did a new ability become valuable? → Check priority ordering
- Did burst window characteristics change? → Re-evaluate pooling

Generate new hypotheses based on the accepted change.

## Phase 4: Cross-Build Analysis

After completing all builds in an archetype:

1. **Universal Improvements** — which changes helped ALL builds?
2. **Archetype-Specific** — which only helped certain builds?
3. **Build-Specific** — which only helped one build?

Record findings to `results/findings.json`:

```json
{
  "id": "finding_id",
  "timestamp": "ISO8601",
  "hypothesis": "description",
  "status": "validated",
  "scope": "universal|archetype|build",
  "archetype": "spirit_bomb|etc",
  "builds": ["affected_build_ids"],
  "impact": { "st": "+X%", "small_aoe": "+Y%", "big_aoe": "+Z%" },
  "mechanism": "explanation of why this worked"
}
```

## Checkpoint Protocol

### On Context Limits or Interruption

```bash
node src/sim/iterate.js checkpoint \
  --archetype "current_archetype" \
  --build "current_build" \
  --hypothesis "current_hypothesis" \
  --notes "key observations this session"
```

### On Session Resume

1. Run `node src/sim/iterate.js status`
2. Read `results/checkpoint.md`
3. If specialist outputs < 24h old: reuse them
4. If specialist outputs > 24h old: re-run Phase 1
5. Resume from checkpoint position

## Loop Termination

Stop when ALL of these are true:

- No untested hypothesis has expected gain > 0.3%
- 10 consecutive rejections across all builds
- At least one full pass through archetypes produced no accepts

OR when:

- Context approaching limits — save checkpoint and suggest re-running

## Anti-Patterns

- **Sequential specialist execution** — ALWAYS launch all 4 in parallel
- **Shallow iteration** — test one thing, accept/reject, repeat without depth
- **Ignoring consensus** — hypotheses supported by multiple specialists are higher confidence
- **Skipping second-order effects** — an accepted change may enable further improvements
- **Testing talent swaps with unadapted APL** — coupled hypotheses need both changes
- **Grinding thresholds without theory** — "fury>=38 vs 40 vs 42" without mechanism

## Output

### Session Summary

- Archetypes covered
- Builds tested per archetype
- Hypotheses tested / accepted / rejected
- Total DPS improvement (weighted across scenarios)

### Key Findings

- Universal improvements (apply to all builds)
- Archetype-specific discoveries
- Mechanism insights (why things worked/didn't)

### Remaining Work

- Untested hypotheses for next session
- Checkpoint position for resume
- Areas needing deeper investigation
