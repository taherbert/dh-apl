Deep analysis of talent interactions, synergy clusters, and build-APL co-optimization for the active spec.

Companion to `/theorycraft` (which analyzes temporal resource flow given a fixed build) and `/full-analysis` (which analyzes APL structure given a fixed build). This skill reasons about the build itself: which talents create compound value, which combinations are non-obvious, and how talent choices reshape the rotation economy.

## Setup

1. Run `node src/engine/startup.js` to determine the active spec. All paths below use `{spec}` as a placeholder for the spec name from config.

2. Read the talent tree and interaction data:

```
data/{spec}/talents.json
data/{spec}/interactions-summary.json
data/{spec}/cpp-proc-mechanics.json
data/{spec}/spells-summary.json
```

3. Read accumulated findings and build data:

```
results/{spec}/findings.json
results/{spec}/builds.json
data/{spec}/build-theory.json
```

Filter findings to `status: "validated"` -- these calibrate your analysis. Read `builds.json` for factor impacts and archetype rankings. Read `build-theory.json` for cluster synergies and tension points.

4. Load the spec adapter to get spec-specific knowledge:

```javascript
const adapter = await loadSpecAdapter();
const specConfig = adapter.getSpecConfig();
// specConfig.resources      — primary/secondary resource names and caps
// specConfig.spellIds       — core ability spell IDs
// specConfig.heroTrees      — hero tree definitions (subtree, school, key buffs, APL branch)
// specConfig.resourceFlow   — resource generators and consumers with rates
// specConfig.burstWindows   — damage amplification windows (if defined)
// specConfig.stateMachines  — hero tree ability cycles (if defined)
// specConfig.synergies      — known talent synergy pairs
```

5. Read the current build from the profile. Use `$ARGUMENTS` if provided, else check `apls/{spec}/profile.simc` for the `talents=` line.

6. Read archetype definitions from `data/{spec}/build-theory.json` (buildArchetypes, specClusters, heroTrees).

7. Check for existing sim results (`ls results/{spec}/`) to ground analysis in actual DPS contributions.

## Phase 1: Map the Interaction Graph

Build a mental model of talent interactions -- not a flat list, but a graph of cause and effect.

### Modifier Stacking Chains

Using `interactions-summary.json` `bySpell` lookups, find every talent that modifies each core ability. Read the core abilities from `specConfig.spellIds` and identify the high-value ones (those with the most modifiers or highest base damage). For each, compute the total modifier stack under the current build.

Key question: **Which ability has the deepest modifier stack?** That ability's effective DPGCD is most sensitive to talent changes -- adding or removing one modifier has the largest absolute impact because modifiers multiply.

For each heavily-modified ability, trace the full modifier chain: direct damage amps, conditional amps (e.g., during burst windows), debuff interactions, and resource-dependent scaling. These modifiers are not independent -- a conditional amp's value depends on how many GCDs you can pack into its window, which depends on resource generation rate, which depends on generator talents and proc mechanics.

### Enabler vs Amplifier Talents

Classify talents by their role in the rotation economy:

- **Enablers** change what you CAN do -- they add abilities, unlock resources, or create new resource sources
- **Amplifiers** change how MUCH something does -- flat or conditional damage increases to existing abilities
- **Rhythm changers** alter the rotation's tempo -- they change resource generation rates, add proc-based resource sources, or modify cooldown timings
- **State machine modifiers** change hero tree ability cycles -- they affect cycle length, empowered window value, or state transition triggers

Read hero tree definitions from `specConfig.heroTrees` to understand which state machines are active. If `specConfig.stateMachines` is defined, use it for cycle details.

The interesting build decisions are usually between talents of DIFFERENT types. Taking another amplifier for an already-strong ability has diminishing returns (additive stacking) or predictable returns (multiplicative stacking). Taking a rhythm changer can reshape the entire rotation economy in ways that aren't obvious from the talent tooltip.

### Cross-Tree Synergy Detection

The most valuable talent interactions cross tree boundaries -- a class talent amplifying a spec ability, or a hero talent that changes when a spec cooldown should be used.

For each taken talent, trace its effects through the interaction graph:

1. What abilities does it directly modify? (from `byTalent`)
2. What other talents modify those same abilities? (from `bySpell`)
3. Do any of those co-modifiers create compound effects? (multiplicative stacking, proc chains, resource enablement)

The compound effects are where build optimization lives. Two talents that independently provide +10% each are worth 1.21x together (multiplicative), but if one talent's proc TRIGGERS the other talent's effect, the compound value could be much higher.

## Phase 2: Identify Talent Tensions

### Mutually Exclusive Choices

At choice nodes, the tree forces a decision between alternatives. For each choice node in the current build:

- What does the chosen talent contribute to the rotation economy?
- What does the unchosen alternative contribute?
- Is the choice clearly correct, or is it close enough that build context (AoE vs ST, burst vs sustain) could flip it?
- Does the unchosen alternative have synergies with OTHER talents in the build that would create compound value?

### Point Budget Pressure

With fixed point budgets per tree (class, spec, hero), every talent point has an opportunity cost. The question isn't "is this talent good?" -- it's "is this talent better than the best alternative use of this point?"

For each talent in the current build, estimate its DPS contribution:

- Direct: damage modifier x affected ability's DPS share
- Indirect: resource generation changes x downstream spending value
- Structural: how it changes what the APL can or should do

Then identify the weakest talents -- the ones contributing the least per point. Are there unselected talents that would contribute more if swapped in?

### Build-APL Coupling

Some talent changes are APL-neutral (a flat damage amp doesn't change what you cast or when). Others require APL restructuring. These are the most interesting talents to analyze because their value isn't captured by a simple modifier percentage.

Identify talents that create build-APL coupling by asking these questions:

- **Resource generation scaling:** Does this talent change how resource generation scales with target count? If so, the APL's `active_enemies` breakpoints for spenders may need to shift.
- **New resource sources:** Does this talent add a resource source on a different timescale than the primary generator? If so, pooling and spending logic may need adjustment.
- **Cooldown frequency:** Does this talent add charges to a cooldown or reduce its recharge time? Extra charges fundamentally change burst window frequency -- the APL should spend differently during those windows.
- **Effect spreading:** Does this talent spread a single-target effect to multiple targets? In AoE, this changes the ability from a single-target amp to a multi-target one, reshaping the value of abilities aligned with that effect.
- **Timing changes:** Does this talent change cast times, delays, or activation windows? This affects weaving patterns and uptime modeling.

For each talent in the build, ask: "If I removed this talent, would the APL need to change? If I added a different talent, would the APL need to change?" Talents that require APL changes are the highest-leverage analysis targets.

## Phase 3: Investigate Non-Obvious Combinations

This is the creative core. Look for talent combinations where the whole exceeds the sum of parts.

### Feedback Loops

Look for cycles where resource consumption procs a buff that increases generation rate, creating a self-reinforcing loop. Trace these through the interaction graph:

- A talent procs a buff on resource consumption (check `cpp-proc-mechanics.json` for proc rates and ICDs)
- That buff increases generation rate (haste, extra procs, reduced cooldowns)
- More generation leads to more consumption, which procs the buff again
- Is there a critical mass where this loop becomes self-sustaining?

### Threshold Interactions

One talent moves a value across a breakpoint that another talent cares about:

- A talent that adds a new resource source might push resource counts above a spender's optimal threshold more often
- But only if the new resources arrive at the right TIME relative to the spender's cooldown or GCD availability
- The value of the generator talent depends on the spender's cooldown AND the hero tree's resource consumption pattern

Check `specConfig.resources` for resource caps and `specConfig.resourceFlow` for generation/consumption rates to identify where thresholds matter.

### Anti-Synergies

Talents that individually look good but work against each other when combined:

- Multiple generators for the same resource might cause overcapping if the APL can't consume fast enough (check resource caps in `specConfig.resources`)
- Two damage amplifiers for the same window might saturate the GCD budget in that window
- A talent that encourages pooling resources + a talent that rewards spending creates a behavioral contradiction

### "What if?" Scenarios

For 2-3 promising unchosen talents, model what would change:

- How does the rotation economy shift?
- What APL changes would be needed?
- Is the expected DPS gain worth the point(s) spent and the point(s) given up?
- Does this open up or close off other synergy paths?

## Phase 4: Quantify and Rank

For each insight, compute expected DPS impact with specific numbers:

- Modifier contributions: talent's modifier % x ability's share of total DPS
- Resource flow changes: additional resources generated x marginal spending value
- Cycle changes: altered cooldown frequency x damage per cast
- Interaction compounds: product of stacked modifiers vs sum of individual values

Rank findings by:

1. **Build errors** -- talents that are strictly dominated by alternatives
2. **High-value swaps** -- single-point changes with clear DPS gains
3. **Structural opportunities** -- multi-point changes that open new synergy paths (requires APL adaptation)
4. **Speculative combinations** -- non-obvious interactions worth testing

## Phase 5: Test (if requested)

For testable hypotheses, use profilesets to compare builds:

```bash
# Single talent swap
node src/sim/profilesets.js --talent-swap "Old Talent:New Talent"

# Or via iterate.js with a modified profile
node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick
```

For talent changes that require APL adaptation:

1. Generate the modified talent build
2. Write the corresponding APL changes
3. Test the BUILD+APL combination together -- testing the build with an unadapted APL underestimates the talent's value

## Output

### Written Report

Write the full analysis to `results/{spec}/talent_analysis.md` for human review. Structure it with the sections below.

### Current Build Assessment

- Modifier stack depths per core ability (read abilities from `specConfig.spellIds`)
- Weakest talents (lowest contribution per point)
- Build-APL coupling points

### Synergy Map

- Cross-tree interaction chains
- Feedback loops identified
- Anti-synergies flagged

### Recommendations (ranked by expected impact)

For each:

- The talent change (swap, add, restructure)
- The mechanism (why this works, traced through the interaction graph)
- Required APL changes (if any)
- Expected DPS impact (with numbers)
- What you give up
- Counter-argument

### Questions for Testing

- Which interactions can only be resolved by simulation (too many variables for pure theory)?
- What profileset comparisons would be most informative?

## On Completion

Record findings from this analysis:

1. Append new insights to `results/{spec}/findings.json` -- each synergy, anti-synergy, or talent evaluation is a finding with evidence, confidence, and tags (use `talent-synergy`, `build-apl-coupling`, `state-machine` tags from `results/{spec}/SCHEMA.md`)
2. If any finding contradicts an existing one, mark the old one `status: "superseded"`
3. If specific builds were evaluated, re-run `npm run discover -- --quick` to update `results/{spec}/builds.json`
