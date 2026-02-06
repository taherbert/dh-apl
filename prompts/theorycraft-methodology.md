# Theorycraft Methodology — Temporal Resource Flow Analysis

Internal reference for the temporal analysis specialist within `/optimize`. Not a user-facing command.

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
- Only propose changes where gain x frequency > loss x frequency

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
