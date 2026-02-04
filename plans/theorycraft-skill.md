# Plan: `/theorycraft` Skill — Temporal Resource Flow Analysis

## Motivation

The existing `strategic-hypotheses.js` generates hypotheses from **static relationships**: buff uptimes, ability priorities, talent interactions. It asks "which ability should be higher priority?" — a per-GCD question.

Human theorycrafters think differently. They reason about **resource flow over time**: "Spirit Bomb has a 25s cooldown, and Soul Cleave consumes fragments between casts — should I pool fragments before SBomb comes off CD?" This requires temporal reasoning about:

1. **Cooldown cycles** — abilities create burst/trough phases over 25-120s windows
2. **Resource competition** — two abilities competing for the same resource on different timescales
3. **Opportunity costs** — what you give up now to pool for later
4. **Timing mismatches** — GCD length vs fragment activation delay, haste breakpoints

This skill fills that gap. It performs **temporal resource flow analysis** and generates testable hypotheses about timing, pooling, and cycle management.

## What This Skill Is NOT

- NOT a replacement for `strategic-hypotheses.js` (which handles priority ordering)
- NOT a replacement for `/iterate-apl` (which runs the optimization loop)
- NOT a simulation tool — it generates hypotheses for the profileset pipeline to test

## Architecture: Where It Fits

```
/theorycraft (NEW)                    /analyze-apl (existing)
    │                                      │
    ▼                                      ▼
src/analyze/theorycraft.js (NEW)    src/analyze/strategic-hypotheses.js
    │                                      │
    ├── Resource flow model                ├── Buff uptime analysis
    ├── Cycle timing analysis              ├── Priority ordering
    ├── Opportunity cost calc              ├── Condition complexity
    └── Temporal hypotheses                └── Window efficiency
    │                                      │
    └──────────┬───────────────────────────┘
               ▼
      Unified hypothesis format
               │
               ▼
      src/sim/iterate.js (existing)
               │
               ▼
      Profileset testing pipeline
```

Both hypothesis generators feed the same `iterate.js` pipeline. The `/theorycraft` skill adds a new category of reasoning, not a parallel pipeline.

## Deliverables

### 1. `src/analyze/theorycraft.js` — Core Analysis Engine

The main module. Exports:

```javascript
export function analyzeResourceFlow(spellData, aplText, simResults)
// Returns: { resources: ResourceModel[], cycles: CooldownCycle[], conflicts: TimingConflict[] }

export function generateTemporalHypotheses(resourceFlow, aplText)
// Returns: hypothesis[] in the same format as strategic-hypotheses.js
```

### 2. `.claude/commands/theorycraft.md` — Skill Prompt

Slash command that:

1. Loads spell data, current APL, recent sim results
2. Runs the temporal analysis
3. Presents findings as a structured report
4. Generates ranked hypotheses ready for testing
5. Optionally auto-tests top hypotheses via profilesets

### 3. Integration with `iterate.js`

Add a `theorycraft` subcommand to iterate.js:

```bash
node src/sim/iterate.js theorycraft    # Generate temporal hypotheses
```

This parallels the existing `strategic` subcommand.

---

## Core Analysis Framework

### Step 1: Resource Flow Modeling

Build a model of each resource system from spell data.

**Resources to model:**

| Resource       | Cap         | Generators                                                                           | Consumers                                    | Notes                                          |
| -------------- | ----------- | ------------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------- |
| Fury           | 120         | Fracture (25, 40 in Meta), Felblade (variable), Immolation Aura, auto-attacks        | Spirit Bomb (40), Soul Cleave (35)           | Overflow = waste                               |
| Soul Fragments | 6 (active)  | Fracture (2, 3 in Meta), Soul Carver (3), Sigil of Spite, Fallout procs, Soul Sigils | Spirit Bomb (up to 5), Soul Cleave (up to 2) | Inactive→active delay ~230ms; overflow = waste |
| GCDs           | 40/min base | Time                                                                                 | Every ability                                | Haste scales; off-GCD abilities don't consume  |
| Cooldowns      | per-ability | Time                                                                                 | Casting the ability                          | Some have charges (Fracture 2, IA 2)           |

**Data sources:**

- `data/spells.json` — AP coefficients, costs, cooldowns, charges, fragment generation counts
- `data/cpp-proc-mechanics.json` — proc rates (Fallout 100%/60%), ICDs
- `data/interactions.json` — talent → spell modifier map

**Model output per resource:**

```javascript
{
  name: "soul_fragments",
  cap: 6,
  generators: [
    { ability: "fracture", amount: 2, amountMeta: 3, cooldown: 6, charges: 2, gcdsPerMin: 10 },
    { ability: "soul_carver", amount: 3, cooldown: 60, gcdsPerMin: 1 },
    { ability: "sigil_of_spite", amount: "variable", cooldown: 60, gcdsPerMin: 1 },
    { ability: "fallout", amount: 1, procRate: 1.0, perTick: true, source: "immolation_aura" },
  ],
  consumers: [
    { ability: "spirit_bomb", amount: "up_to_5", cooldown: 25, valuePerUnit: "+20% damage" },
    { ability: "soul_cleave", amount: "up_to_2", cooldown: 0, valuePerUnit: "+20% damage" },
  ],
  flowRate: { generationPerMin: 24, consumptionPerMin: 20, netPerMin: 4 },
  overflowRate: { fromSim: 78.8, pctOfGenerated: "3.2%" },
}
```

### Step 2: Cooldown Cycle Analysis

For each ability with a significant cooldown (>10s), map its cycle:

```javascript
{
  ability: "spirit_bomb",
  cooldown: 25,
  gcdsPerCycle: 17,  // 25s / 1.5s GCD
  phases: [
    { name: "available", duration: "1 GCD", action: "cast SBomb" },
    { name: "recovery", duration: "24.5s", action: "generate fragments for next SBomb" },
  ],
  resourceBudget: {
    // During the 25s cycle, how much of each resource flows?
    furyGenerated: 250,   // ~10 Fractures × 25 fury
    furyConsumed: 215,    // 1 SBomb (40) + 5 SC (175)
    fragsGenerated: 20,   // 10 Fractures × 2
    fragsConsumed: 14,    // 1 SBomb (4-5) + 5 SC (10)
    fragsOverflowed: 6,   // cap overflow
  },
}
```

### Step 3: Timing Conflict Detection

Scan for these conflict patterns:

**Pattern A: Resource Competition**
Two consumers drawing from the same pool on different timescales.

- Example: Soul Cleave (continuous) vs Spirit Bomb (burst every 25s) both consume fragments
- Signal: high fragment overflow + SBomb casting at <5 fragments

**Pattern B: Cooldown Collision**
Two cooldowns that should be staggered or aligned but aren't.

- Example: Soul Carver (generates 3 frags) and Spirit Bomb (consumes frags) — should Carver fire right before SBomb?
- Signal: Carver fires when SBomb is on CD, wasting fragments to overflow

**Pattern C: Burst Window Waste**
Damage multiplier active but resources depleted.

- Example: Fiery Demise window open but no fury for Spirit Bomb
- Signal: low cast count of fire abilities during Brand uptime

**Pattern D: Inactive Fragment Window**
Fragment-generating abilities create fragments that are temporarily immune to consumption.

- Example: After Soul Carver, 3 fragments are inactive for ~230ms
- Signal: only relevant at very high haste where GCD < activation delay

**Pattern E: Pooling Opportunity**
A burst phase is approaching and resources could be saved.

- Example: SBomb coming off CD in 3s, should we stop SC to save frags?
- Counter-signal: opportunity cost of not spending may exceed pooling benefit

### Step 4: Opportunity Cost Computation

For each timing conflict, compute the cost-benefit:

```javascript
{
  conflict: "SC consumes fragments that SBomb could use",
  poolingBenefit: {
    description: "SBomb at 6 frags instead of 4",
    valueGain: "2.0 × 2.2 - 2.0 × 1.8 = 0.8 AP per SBomb",
    frequency: "12 SBomb casts per fight, ~4 affected",
    totalGain: 3.2, // AP over fight
  },
  poolingCost: {
    description: "Skip 1 Soul Cleave per pool window",
    valueLost: "2.08 × 1.4 = 2.912 AP per skipped SC",
    frequency: "~4 pool windows",
    totalLost: 11.6, // AP over fight
  },
  netValue: -8.4, // AP loss — pooling not worth it
  recommendation: "DO NOT pool — SC opportunity cost exceeds SBomb marginal gain",
}
```

The key insight: **compute both sides of the tradeoff before generating a hypothesis.** This prevents hypotheses that "feel right" but are net negative.

### Step 5: Hypothesis Generation

Only generate hypotheses where the opportunity cost analysis is favorable (or genuinely uncertain). Each hypothesis includes:

```javascript
{
  // Standard fields (matches strategic-hypotheses.js format)
  category: "TEMPORAL_POOLING" | "CYCLE_ALIGNMENT" | "COOLDOWN_SEQUENCING" | "RESOURCE_GATING",
  hypothesis: "Relax Sigil of Spite fragment guard from <=3 to <=5",
  observation: "Spite fires 5.5 times per fight; at <=5 guard it could fire 6.2 times",
  aplMutation: { type: "relax_threshold", list: "ar_cooldowns", ability: "sigil_of_spite", ... },
  priority: number,
  confidence: "high" | "medium" | "low",

  // NEW temporal fields
  temporalAnalysis: {
    resourceFlow: "soul_fragments",
    cycleLength: 60, // Spite cooldown
    conflictType: "resource_gating",
    opportunityCost: { gain: 3.2, loss: 1.1, net: 2.1 },
    timingWindow: "any time during 60s cycle",
  },
  prediction: "+0.3% DPS from more frequent Spite casts, slight increase in frag overflow",
}
```

---

## New Hypothesis Categories

Add these to complement the existing `STRATEGIC_CATEGORIES`:

```javascript
const TEMPORAL_CATEGORIES = {
  TEMPORAL_POOLING: "Save resources for upcoming burst window",
  CYCLE_ALIGNMENT: "Align ability cycles for better resource utilization",
  COOLDOWN_SEQUENCING: "Order cooldowns to minimize resource waste",
  RESOURCE_GATING: "Adjust resource guards on cooldowns",
  HASTE_BREAKPOINT: "Exploit timing thresholds at specific haste levels",
  INACTIVE_EXPLOITATION: "Use soul_fragments.inactive awareness",
};
```

---

## Reasoning Prompts

The skill prompt should guide Claude through specific reasoning patterns. These are the "thought starters" that produce deep insights:

### Prompt 1: Resource Flow Audit

> "For each resource (fury, fragments, GCDs), trace the flow over one full rotation cycle (~25s for SBomb, ~60s for major CDs). Where does generation exceed consumption? Where does consumption create bottlenecks? Where does overflow waste resources?"

### Prompt 2: Cooldown Interaction Matrix

> "For each pair of cooldown abilities, ask: should they fire together (multiplicative benefit) or apart (resource spreading)? What happens to resources when both fire in the same GCD window?"

### Prompt 3: Pooling Cost-Benefit

> "For any proposed pooling behavior (delay spending to save resources for burst), compute: (a) what damage/utility is lost by delaying, (b) what damage/utility is gained from a bigger burst, (c) how many times per fight does this situation occur. Only propose pooling when (b) × (c) > (a) × (c)."

### Prompt 4: Timing Mismatch Scan

> "What abilities have timing properties that create windows of opportunity? Examples: inactive fragment delay (230ms), GCD length (1.5s at base, less with haste), buff durations that expire mid-GCD, cooldown remainders that create alignment/misalignment."

### Prompt 5: Counter-Intuitive Check

> "For each hypothesis, argue the opposite case. If the hypothesis is 'pool fragments for SBomb,' argue why NOT pooling is better. Use specific numbers. Only keep the hypothesis if the favorable case survives the counter-argument."

---

## Data Requirements

The analysis engine needs these inputs. All exist in the current project:

| Data                | Source                         | Used For                       |
| ------------------- | ------------------------------ | ------------------------------ |
| Spell coefficients  | `data/spells.json`             | Damage value calculations      |
| Cooldowns & charges | `data/spells.json`             | Cycle length modeling          |
| Proc mechanics      | `data/cpp-proc-mechanics.json` | Fragment generation rates      |
| Talent interactions | `data/interactions.json`       | Modifier detection             |
| Current APL         | `apls/vengeance.simc`          | Understanding current behavior |
| Sim cast counts     | `results/*_summary.json`       | Actual vs theoretical flow     |
| Fragment overflow   | SimC JSON output (procs)       | Waste quantification           |
| Buff uptimes        | SimC JSON output (buffs)       | Window utilization             |

---

## Skill Prompt: `.claude/commands/theorycraft.md`

```markdown
Perform temporal resource flow analysis on the VDH APL and generate testable hypotheses.

## Setup

1. Read spell data and APL:
   - `data/spells.json` — ability coefficients, costs, cooldowns
   - `data/cpp-proc-mechanics.json` — proc rates, ICDs
   - `apls/vengeance.simc` — current APL (or `$ARGUMENTS` if provided)

2. Read recent sim results (if available):
   - `results/vengeance_summary.json`
   - `results/vengeance_st.json` (for detailed cast counts, buff uptimes, proc data)

3. Read existing analysis infrastructure:
   - `src/analyze/theorycraft.js` — run the temporal analysis engine

## Analysis

Run the 5-step temporal analysis:

1. **Resource Flow Model** — Map fury, fragments, GCDs. Compute generation/consumption rates.
2. **Cooldown Cycles** — For each CD ability, map burst/recovery phases and resource budgets.
3. **Timing Conflicts** — Scan for resource competition, cooldown collisions, burst window waste.
4. **Opportunity Costs** — For each conflict, compute both sides of the tradeoff with real numbers.
5. **Hypotheses** — Generate only where cost-benefit is favorable or genuinely uncertain.

## Output

Present results as:

### Resource Flow Summary

Table of resources with generation/consumption rates and waste metrics.

### Timing Conflicts Found

Each conflict with explanation, cost-benefit numbers, and recommendation.

### Testable Hypotheses

Ranked list of hypotheses with:

- What to change in the APL
- Expected DPS impact (with reasoning)
- How to test (profileset variant description)

### Counter-Arguments

For each hypothesis, the strongest argument against it.

## Optional: Auto-Test

If the user says "test" or "run", automatically:

1. Build profileset variants for top 3 hypotheses
2. Run via `runProfileset()` from `src/sim/profilesets.js`
3. Report results
```

---

## Implementation Steps

### Phase 1: Resource Flow Model (`src/analyze/theorycraft.js`)

1. **Parse spell data** into the resource model structure
   - Read `data/spells.json` for each VDH ability
   - Extract: AP coefficient, fury cost, fury generation, fragment generation, cooldown, charges
   - Read `data/cpp-proc-mechanics.json` for proc rates
   - Build the `ResourceModel` for fury, fragments, GCDs

2. **Parse sim results** for actual flow rates
   - Read cast counts from `results/vengeance_st.json`
   - Read proc counts (fragment overflow, fragment expire)
   - Read buff uptimes
   - Compare theoretical vs actual flow rates

3. **Export `analyzeResourceFlow()`** — returns the model

### Phase 2: Cycle & Conflict Analysis

4. **Build cooldown cycle models** for each ability with CD > 10s
   - Spirit Bomb (25s), Fiery Brand (60s), Soul Carver (60s), Sigil of Spite (60s), Fel Devastation (40s), Metamorphosis (120s)
   - Compute resource budget per cycle (fury/frags generated and consumed)

5. **Detect timing conflicts** by comparing cycles
   - Pattern matching: resource competition, cooldown collision, burst waste, pooling opportunities
   - Use sim data to validate (e.g., "SBomb casts at <4 frags" indicates missed pooling, "high overflow" indicates over-generation)

6. **Compute opportunity costs** for each conflict
   - Use AP coefficients and modifier values from spell data
   - Per-fight frequency estimation from cast counts

7. **Export `generateTemporalHypotheses()`** — returns hypothesis array

### Phase 3: Skill Prompt & Integration

8. **Create `.claude/commands/theorycraft.md`** — the slash command prompt

9. **Add `theorycraft` subcommand to `iterate.js`**
   - Imports `generateTemporalHypotheses` from `theorycraft.js`
   - Adds hypotheses to `state.pendingHypotheses`
   - Same interface as the existing `strategic` subcommand

10. **Add new mutation operators** to `mutator.js` (if needed)
    - `ADD_RESOURCE_GUARD` — add a resource-based condition to an action
    - `ADD_COOLDOWN_SYNC` — add cooldown alignment condition
    - These may not be needed if existing operators suffice

### Phase 4: Validation

11. **Test on current APL** — run the engine, verify it produces the same insights we found manually:
    - "Spite fragment guard is too restrictive" (we validated: +0.3% when relaxed)
    - "SBomb pooling is net negative" (we validated: -1.3% to -2.8%)
    - "Fracture overflow guard costs more than it saves" (Phase 2: +10.4% without guard)

12. **Integration test** — run `node src/sim/iterate.js theorycraft` and verify hypotheses appear in pending queue

---

## Known Insights the Engine Should Reproduce

These are hypotheses our manual analysis already tested. The engine should independently discover them (used as validation):

| Insight                                       | Manual Result        | Category                         |
| --------------------------------------------- | -------------------- | -------------------------------- |
| Fracture overflow guard costs DPS             | +10.4% without guard | RESOURCE_GATING                  |
| Spite fragment guard too restrictive          | +0.3% at <=5 vs <=3  | RESOURCE_GATING                  |
| SBomb pooling (guard SC to save frags)        | -1.3% to -2.8%       | TEMPORAL_POOLING (negative)      |
| Urgent SBomb at 3 when inactive frags present | -0.3%                | INACTIVE_EXPLOITATION (negative) |
| Meta-priority Fracture (extra frag in Meta)   | +5.2%                | CYCLE_ALIGNMENT                  |
| Brand-first cooldown ordering                 | +0.6%                | COOLDOWN_SEQUENCING              |

The engine should also find these negative results and correctly predict them as net-negative via opportunity cost analysis — not just generate them as "try this."

---

## Files to Create/Modify

| File                              | Action         | Purpose                         |
| --------------------------------- | -------------- | ------------------------------- |
| `src/analyze/theorycraft.js`      | CREATE         | Core analysis engine            |
| `.claude/commands/theorycraft.md` | CREATE         | Skill prompt                    |
| `src/sim/iterate.js`              | MODIFY         | Add `theorycraft` subcommand    |
| `src/apl/mutator.js`              | MODIFY (maybe) | Add temporal mutation operators |
| `CLAUDE.md`                       | MODIFY         | Document `/theorycraft` command |

## Dependencies

- `data/spells.json` — must exist (run `npm run build-data` if not)
- `data/cpp-proc-mechanics.json` — must exist
- `results/vengeance_st.json` — should exist for sim-informed analysis (falls back to theoretical-only if missing)
- `src/analyze/archetypes.js` — reuse archetype detection
- `src/analyze/strategic-hypotheses.js` — reuse hypothesis format and `MUTATION_OPS`
- `src/sim/profilesets.js` — for auto-test capability
