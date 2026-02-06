Perform temporal resource flow analysis on the active spec's APL and generate testable hypotheses.

## Setup

1. Run `node src/engine/startup.js` to determine the active spec. Use the spec name for all `{spec}` path references below.

2. **Load the full knowledge base per `prompts/apl-analysis-guide.md` Section 0.** That section is the single canonical list of all data sources — load all tiers relevant to temporal analysis (mechanical blueprint, interaction/proc data, accumulated knowledge, external references when gaps exist).

3. Read the APL to analyze. If `$ARGUMENTS` was provided, use that file. Otherwise default to `apls/{spec}/{spec}.simc`. If neither exists, check `apls/{spec}/baseline.simc`.

4. Read recent sim results if available: `ls results/{spec}/`. Look for `workflow_current.json` or `*_summary.json` files (for detailed cast counts, buff uptimes, proc data).

5. Run the temporal analysis engine:

```bash
node src/analyze/theorycraft.js results/{spec}/workflow_current.json apls/{spec}/{spec}.simc
```

## Analysis Steps

Walk through the 5-step temporal analysis:

### 1. Resource Flow Model

For each resource (read from `SPEC_CONFIG.resourceModels`), trace the flow over one full rotation cycle:

- Where does generation exceed consumption?
- Where does consumption create bottlenecks?
- Where does overflow waste resources?

### 2. Cooldown Cycle Mapping

For each ability with a significant cooldown (>10s), map its cycle. Read cooldown values from `data/{spec}/spells-summary.json`:

- Cooldown period and charges
- Resource budget per cycle (generated and consumed)
- Compare theoretical vs actual cast counts from sim data

### 3. Timing Conflict Detection

Scan for these conflict patterns:

- **Resource Competition** — Two consumers drawing from the same pool on different timescales
- **Cooldown Collision** — Two cooldowns that should be staggered or aligned but aren't
- **Burst Window Waste** — Damage multiplier active but resources depleted
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

### Cross-Reference Findings

Read `results/{spec}/findings.json` and filter to `status: "validated"`. Cross-reference your hypotheses against known results:

- If a hypothesis matches a validated finding, note it and calibrate your expected impact accordingly
- If a hypothesis contradicts a validated finding, investigate the discrepancy before testing
- If your analysis uncovers something the findings don't address, that's a higher-priority hypothesis

### Record New Findings

After analysis, append new insights to `results/{spec}/findings.json`:

- Each distinct insight gets its own entry with evidence, confidence, tags
- If your analysis contradicts an existing finding, mark the old one `status: "superseded"` and add a `supersededBy` reference
- Use the tag taxonomy from `results/{spec}/SCHEMA.md`

## Optional: Auto-Test

If the user says "test" or "run", automatically:

1. Build profileset variants for top 3 hypotheses
2. Run via iterate.js pipeline: `node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick`
3. Report results
