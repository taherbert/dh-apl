# Deep Theorycrafting System Overhaul

## Problem Statement

The current theorycrafting workflow is **consistently shallow**. Despite sophisticated infrastructure (hypothesis engines, mutation system, DoE pipeline, state management), the actual execution fails to produce meaningful insights because:

1. **Sequential execution** — Skills run one after another instead of parallel specialists
2. **No orchestration** — No central agent synthesizes inputs from multiple analysis tracks
3. **Shallow iteration** — Tests ONE hypothesis → accept/reject → repeat (no depth)
4. **Unsophisticated APL changes** — Missing variables, timing guards, phase-specific sub-lists
5. **No build-specific or condition-specific priorities** — APL is too generic

**User's repeated feedback (paraphrased):** "Your results are useless because you're not iterating on the APL. The process should generate archetypes, builds, theories per build, APL changes, test them, and iterate until improvements are found — even if specific to certain builds or archetypes."

---

## What Already Works (Preserve This)

| Component                   | Location                                                                 | Status                              |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| Skill hierarchy             | `.claude/commands/*.md`                                                  | Clean, purposeful                   |
| Strategic hypothesis engine | `src/analyze/strategic-hypotheses.js`                                    | Generates mutations automatically   |
| Temporal hypothesis engine  | `src/analyze/theorycraft.js`                                             | Generates mutations automatically   |
| APL mutation system         | `src/apl/mutator.js`                                                     | AST-based, validates changes        |
| DoE build discovery         | `src/discover/build-discovery.js`                                        | Produces quality archetype data     |
| Iteration state management  | `src/sim/iterate.js`                                                     | Backup/recovery, version migration  |
| Three-tier knowledge system | `data/build-theory.json`, `results/builds.json`, `results/findings.json` | Structured persistence              |
| APL delegation patterns     | `apls/vengeance.simc`                                                    | Correct use of run/call_action_list |

---

## Required Outcomes

### 1. Parallel Specialist Execution

Multiple analysis tracks run **simultaneously**, not sequentially. Each produces structured output that feeds into synthesis.

### 2. Central Orchestration

The main agent launches specialists, waits for completion, **synthesizes their outputs**, makes decisions about what to test, and loops.

### 3. Deep Iteration

The loop is: **archetypes → builds → theories per build → APL changes → test → observe → iterate**. Not: "test one thing, accept/reject, repeat."

### 4. Sophisticated APL Output

Generated APL changes include:

- Complex variable calculations (computed state, pooling projections)
- Phase-specific sub-lists (meta_prep, brand_window, fel_dev)
- Dynamic timing guards (hold_sof_for_sbomb, dont_soul_cleave)
- Talent-gated and condition-gated sub-routines via `call_action_list`

### 5. Build-Specific Insights

Identify which improvements apply universally vs. which are archetype-specific or build-specific. Record all findings for cross-session learning.

---

## System Architecture

### Orchestration Flow

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

### Deep Iteration Loop

```
1. LAUNCH parallel specialists (4 subagents via TaskCreate)
   - Spell data analyst
   - Talent interaction analyst
   - Resource flow analyst
   - State machine analyst

2. WAIT for all specialists to complete

3. SYNTHESIZE outputs:
   - Rank hypotheses by cross-analyst consensus
   - Identify compound hypotheses (require 2+ dimensions)
   - Flag conflicts between analysts

4. FOR EACH archetype (from build-theory.json):
   a. FOR EACH build in archetype (from builds.json):
      i. Generate 3-5 archetype-specific deep hypotheses
      ii. FOR EACH hypothesis:
          - Create sophisticated APL mutation
          - Run quick screen (parallel if independent)
          - If promising: run confirm fidelity
          - Record to findings.json
          - If accepted: check for second-order effects
      iii. After all hypotheses for this build:
           - Identify build-specific improvements
           - Record which hypotheses worked

5. CROSS-BUILD ANALYSIS:
   - Which improvements are universal?
   - Which are archetype-specific?
   - Update build-theory.json with new insights

6. ITERATE until:
   - No untested hypothesis has expected gain > 0.3%
   - 10 consecutive rejections across all builds
   - Context approaching limits (checkpoint and resume)
```

---

## Deep Hypothesis Structure

A **shallow hypothesis** (what we have now):

```
"Move Fracture above Soul Cleave"
```

A **deep hypothesis** (what we need):

```
{
  "id": "meta-fracture-priority",
  "systemic_issue": "Fragment economy shifts during Meta (+1 frag per Fracture)",
  "mechanism": "Fracture generates 3 frags during Meta vs 2 normally. At 20% Meta
               uptime, this is +0.4 extra frags per Fracture. Spirit Bomb scales
               at 0.4 AP/frag, so each Meta-Fracture adds 0.16 AP to the next SBomb.",
  "proposed_changes": [
    {
      "type": "move_up",
      "list": "ar",
      "ability": "fracture",
      "condition": "buff.metamorphosis.up",
      "position": "top_of_core_rotation"
    }
  ],
  "expected_impact": "+3-5% ST DPS from maximizing fragment gen during Meta",
  "counter_argument": "Fracture charges may not be available. But recharge is 3.75s
                       at 20% haste, so 4 charges regenerate during 15s Meta.",
  "dependencies": [],
  "archetype_specific": false
}
```

**Target: 3-5 deep hypotheses per archetype.** With 6 archetypes, that's 18-30 total hypotheses, each with mechanism, numbers, counter-argument, and specific APL mutations.

---

## Sophisticated APL Patterns

### Pattern 1: Computed State Variables

```simc
# Fragment generation potential — how many fragments could we spawn now
actions=/variable,name=num_spawnable_souls,op=reset,default=0
actions+=/variable,name=num_spawnable_souls,op=max,value=2,if=cooldown.fracture.charges>=1&!buff.metamorphosis.up
actions+=/variable,name=num_spawnable_souls,op=max,value=3,if=cooldown.fracture.charges>=1&buff.metamorphosis.up
actions+=/variable,name=num_spawnable_souls,op=add,value=3,if=talent.soul_carver&cooldown.soul_carver.up
```

### Pattern 2: Timing Guard Variables

```simc
# Hold Sigil if Soul Sigils talented and Spirit Bomb is almost ready
actions+=/variable,name=hold_sof_for_sbomb,value=talent.soul_sigils&cooldown.spirit_bomb.remains<2&soul_fragments>=3
actions+=/sigil_of_flame,if=!variable.hold_sof_for_sbomb
```

### Pattern 3: Phase-Specific Sub-Lists

```simc
# Meta preparation phase — pool resources before Meta
actions+=/call_action_list,name=meta_prep,if=cooldown.metamorphosis.remains<5&!buff.metamorphosis.up

actions.meta_prep=/spirit_bomb,if=soul_fragments>=variable.spb_threshold
actions.meta_prep+=/fracture,if=fury<80|cooldown.fracture.charges>=2
# Don't cast fillers — save resources for Meta window
```

### Pattern 4: Talent-Gated Sub-Lists

```simc
# Only call if Charred Flesh is talented — extends Brand via fire ticks
actions+=/call_action_list,name=brand_extend,if=talent.charred_flesh&dot.fiery_brand.ticking

actions.brand_extend=/immolation_aura,if=!buff.immolation_aura.up
actions.brand_extend+=/sigil_of_flame,if=!debuff.sigil_of_flame.up
```

### Pattern 5: Resource Pooling Logic

```simc
# Fury pooling for upcoming Fel Devastation
actions+=/variable,name=fel_dev_fury_needed,value=50
actions+=/variable,name=fel_dev_pool,value=cooldown.fel_devastation.remains<3&fury<variable.fel_dev_fury_needed
actions+=/soul_cleave,if=!variable.fel_dev_pool&fury>=60
```

---

## Implementation Phases

### Phase 1: Parallel Specialist Framework

**Goal:** Modify `/optimize` to launch parallel subagents and synthesize their outputs

**Files to modify:**

- `.claude/commands/optimize.md` — Add TaskCreate pattern for 4 specialists, synthesis phase

**Deliverables:**

- Specialists write structured output to `results/analysis_*.json`
- Orchestrator reads all outputs and produces ranked hypothesis list

### Phase 2: Deep Hypothesis Structure

**Goal:** Hypothesis generators produce compound, mechanism-backed hypotheses

**Files to modify:**

- `src/analyze/strategic-hypotheses.js` — Add archetype-specific generation, structured output
- `src/analyze/theorycraft.js` — Add per-build hypothesis context
- `.claude/commands/talent-analysis.md` — Add synergy-to-hypothesis mapping

**Deliverables:**

- Each hypothesis includes: mechanism, numbers, counter-argument, expected impact
- Hypotheses tagged by archetype applicability

### Phase 3: Sophisticated Mutations

**Goal:** Mutation system can create variables, sub-lists, timing guards

**Files to modify:**

- `src/apl/mutator.js` — Add new mutation types: ADD_VARIABLE, ADD_ACTION_LIST, ADD_PHASE, INSERT_ACTION

**Deliverables:**

- Can programmatically add `variable,name=X,value=expr` lines
- Can programmatically create sub-lists and insert `call_action_list` references
- Validation for complex mutations

### Phase 4: Deep Iteration Loop

**Goal:** Nested loop (archetype → build → hypothesis) with parallel testing

**Files to modify:**

- `.claude/commands/iterate-apl.md` — Add nested loop pattern, checkpoint/resume
- `src/sim/iterate.js` — Add checkpoint command, parallel test coordination

**Deliverables:**

- Full depth iteration: tests all hypotheses across all builds
- Checkpoint/resume for multi-session work
- Cross-build analysis after each archetype

### Phase 5: Integration and Testing

**Goal:** End-to-end validation of the new system

**Validation:**

- Run full optimization pass on one archetype
- Verify specialist outputs are synthesized correctly
- Verify sophisticated mutations are applied correctly
- Verify checkpoint/resume works across sessions
- Verify findings.json accumulates validated insights

---

## Checkpoint/Resume Protocol

### On Session End (Context Limits or Interruption)

1. Save iteration state: `node src/sim/iterate.js status` (auto-saves)
2. Specialist outputs persist in `results/analysis_*.json`
3. Findings persist in `results/findings.json`
4. Create `results/checkpoint.md`:
   - Current archetype/build/hypothesis being tested
   - Hypotheses remaining per archetype
   - Key findings this session

### On Session Resume

1. Run `node src/sim/iterate.js status`
2. Read `results/checkpoint.md`
3. If specialist outputs < 24h old: reuse them
4. If specialist outputs > 24h old: re-run specialists
5. Resume from last hypothesis, don't repeat completed tests

---

## Files Inventory

### Command Files (Modify)

| File                                  | Purpose              | Changes                                    |
| ------------------------------------- | -------------------- | ------------------------------------------ |
| `.claude/commands/optimize.md`        | Central orchestrator | Parallel launch, synthesis, deep loop      |
| `.claude/commands/iterate-apl.md`     | Iteration patterns   | Checkpoint/resume, sophisticated mutations |
| `.claude/commands/full-analysis.md`   | Deep analysis        | Structured output format                   |
| `.claude/commands/theorycraft.md`     | Temporal analysis    | Per-archetype hypothesis context           |
| `.claude/commands/talent-analysis.md` | Talent synergies     | Synergy-to-hypothesis mapping              |

### Source Files (Modify)

| File                                  | Purpose          | Changes                                        |
| ------------------------------------- | ---------------- | ---------------------------------------------- |
| `src/apl/mutator.js`                  | APL mutation     | ADD_VARIABLE, ADD_ACTION_LIST, ADD_PHASE types |
| `src/analyze/strategic-hypotheses.js` | Hypothesis gen   | Compound hypotheses, archetype-specific        |
| `src/analyze/theorycraft.js`          | Resource flow    | Structured output for synthesis                |
| `src/sim/iterate.js`                  | State management | Checkpoint command, parallel test support      |

### New Files (Create)

| File                               | Purpose                                           |
| ---------------------------------- | ------------------------------------------------- |
| `src/analyze/synthesizer.js`       | Combine specialist outputs into ranked hypotheses |
| `results/analysis_spell_data.json` | Specialist output (ephemeral, gitignored)         |
| `results/analysis_talent.json`     | Specialist output (ephemeral, gitignored)         |
| `results/analysis_resource.json`   | Specialist output (ephemeral, gitignored)         |
| `results/analysis_state.json`      | Specialist output (ephemeral, gitignored)         |
| `results/checkpoint.md`            | Session checkpoint (ephemeral, gitignored)        |

---

## Success Criteria

### Quantitative

- **Hypothesis depth**: 100% of hypotheses include mechanism, numbers, counter-argument
- **Coverage**: 3-5 hypotheses per archetype tested
- **APL sophistication**: Generated APL uses variables, sub-lists, timing guards
- **Test efficiency**: Parallel quick screens reduce wall-clock time by 2-3x
- **Cross-session**: Can interrupt and resume without repeating work

### Qualitative

- **Meaningful insights**: Each session produces findings that inform future work
- **Build-specific knowledge**: Know which changes work for which builds
- **Accumulated wisdom**: findings.json grows with validated insights
- **APL quality**: Output APL resembles sophistication of old reference APL

---

## Anti-Patterns to Avoid

- **Threshold grinding** — Testing fury>=38 vs 40 vs 42 without theory of WHY
- **Blind reordering** — "Move X above Y" without mechanism
- **One-dimensional analysis** — Evaluating ability by direct damage only
- **Shallow iteration** — Test one thing, accept/reject, repeat
- **Sequential execution** — Running specialists one after another
- **Ignoring second-order effects** — Not tracing downstream impact of changes

---

## SimC Build Requirement

**All testing MUST use SimC built from PR #10869** ([taherbert/feature/untethered-rage-meta](https://github.com/simulationcraft/simc/pull/10869)).

This PR implements Untethered Rage free Metamorphosis:

- Grants temporary Meta charge when UR procs
- UR-triggered Meta uses 10s duration (matches Demonic pattern)
- Extends existing Meta by 10s without wasting procs
- ~28.6% Meta uptime vs baseline

### Building from PR

```bash
cd /Users/tom/Documents/GitHub/simc
git fetch origin pull/10869/head:pr-10869
git checkout pr-10869
make -C engine -j$(sysctl -n hw.ncpu)
```

Verify before testing:

```bash
./engine/simc --version  # Should show midnight branch commit from PR
```

---

## Execution Notes

This plan is designed for **multi-session execution**. Each session should:

1. Read this plan file first
2. **Build SimC from PR #10869** (see above)
3. Check `results/checkpoint.md` for resume point
4. If starting fresh: begin at Phase 1
5. If resuming: continue from checkpoint
6. Before ending: update checkpoint.md with current state

The goal is **depth over breadth**. It's better to deeply optimize one archetype than to shallowly touch all of them. Findings accumulate in `results/findings.json` and inform future sessions.

**Key insight from past failures:** The infrastructure exists — the problem is orchestration and depth. Don't build new systems. Make the existing systems work together properly with parallel execution, synthesis, and deep iteration.
