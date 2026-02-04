Perform temporal resource flow analysis on the VDH APL and generate testable hypotheses.

## Setup

1. Read spell data and proc mechanics:

```
data/spells.json
data/cpp-proc-mechanics.json
```

2. Read the APL to analyze. If `$ARGUMENTS` was provided, use that file. Otherwise default:

```
apls/vengeance.simc
```

If neither exists, check `apls/baseline.simc`.

3. Read recent sim results if available:

```
ls results/
```

Look for `workflow_current.json`, `vengeance_summary.json`, or `vengeance_st.json` (for detailed cast counts, buff uptimes, proc data).

4. Run the temporal analysis engine:

```javascript
import {
  analyzeResourceFlow,
  generateTemporalHypotheses,
} from "./src/analyze/theorycraft.js";
```

Or via CLI:

```bash
node src/analyze/theorycraft.js results/workflow_current.json apls/vengeance.simc
```

## Analysis Steps

Walk through the 5-step temporal analysis:

### 1. Resource Flow Model

For each resource (fury, fragments, GCDs), trace the flow over one full rotation cycle (~25s for SBomb, ~60s for major CDs):

- Where does generation exceed consumption?
- Where does consumption create bottlenecks?
- Where does overflow waste resources?

### 2. Cooldown Cycle Mapping

For each ability with a significant cooldown (>10s), map its cycle:

- Spirit Bomb (25s), Fiery Brand (60s), Soul Carver (60s), Sigil of Spite (60s), Fel Devastation (40s), Metamorphosis (120s)
- Resource budget per cycle (fury/frags generated and consumed)
- Compare theoretical vs actual cast counts from sim data

### 3. Timing Conflict Detection

Scan for these conflict patterns:

- **Resource Competition** — Two consumers drawing from the same pool on different timescales (SC vs SBomb for fragments)
- **Cooldown Collision** — Two cooldowns that should be staggered or aligned but aren't (Carver + SBomb timing)
- **Burst Window Waste** — Damage multiplier active but resources depleted (Brand up, no fury for SBomb)
- **Pooling Opportunity** — Burst phase approaching, resources could be saved
- **Resource Gating** — Guards on abilities that cost more in opportunity than they save in overflow

### 4. Opportunity Cost Computation

For each conflict, compute BOTH SIDES of the tradeoff with real numbers:

- What damage/utility is **lost** by the proposed change?
- What damage/utility is **gained**?
- How many times per fight does this situation occur?
- Only propose changes where gain × frequency > loss × frequency

### 5. Counter-Argument Check

For each hypothesis, argue the OPPOSITE case. Use specific numbers. Only keep the hypothesis if the favorable case survives the counter-argument.

## Output Format

### Resource Flow Summary

Table of resources with generation/consumption rates and waste metrics.

### Timing Conflicts Found

Each conflict with explanation, cost-benefit numbers, and recommendation.

### Testable Hypotheses

Ranked list with:

- What to change in the APL
- Expected DPS impact (with reasoning from AP coefficients)
- How to test (profileset variant description)
- Counter-argument

### Known Validated Results

Cross-reference against known test results:

| Insight                                     | Manual Result        | Status             |
| ------------------------------------------- | -------------------- | ------------------ |
| Fracture overflow guard costs DPS           | +10.4% without guard | High confidence    |
| Spite fragment guard too restrictive        | +0.3% at <=5 vs <=3  | Medium confidence  |
| SBomb pooling (guard SC to save frags)      | -1.3% to -2.8%       | Correctly rejected |
| Meta-priority Fracture (extra frag in Meta) | +5.2%                | High confidence    |
| Brand-first cooldown ordering               | +0.6%                | Medium confidence  |

## Optional: Auto-Test

If the user says "test" or "run", automatically:

1. Build profileset variants for top 3 hypotheses
2. Run via iterate.js pipeline: `node src/sim/iterate.js compare apls/candidate.simc --quick`
3. Report results
