# Talent Analysis Methodology

Internal reference for the talent specialist within `/optimize`. Not a user-facing command.

Reasons about the build itself: which talents create compound value, which combinations are non-obvious, and how talent choices reshape the rotation economy.

## Phase 1: Map the Interaction Graph

Build a mental model of talent interactions — not a flat list, but a graph of cause and effect.

### Modifier Stacking Chains

Using `interactions-summary.json` `bySpell` lookups, find every talent that modifies each core ability. Read the core abilities from `specConfig.spellIds` and identify the high-value ones (those with the most modifiers or highest base damage). For each, compute the total modifier stack under the current build.

Key question: **Which ability has the deepest modifier stack?** That ability's effective DPGCD is most sensitive to talent changes — adding or removing one modifier has the largest absolute impact because modifiers multiply.

### Enabler vs Amplifier Talents

Classify talents by their role in the rotation economy:

- **Enablers** change what you CAN do — they add abilities, unlock resources, or create new resource sources
- **Amplifiers** change how MUCH something does — flat or conditional damage increases to existing abilities
- **Rhythm changers** alter the rotation's tempo — they change resource generation rates, add proc-based resource sources, or modify cooldown timings
- **State machine modifiers** change hero tree ability cycles — they affect cycle length, empowered window value, or state transition triggers

### Cross-Tree Synergy Detection

The most valuable talent interactions cross tree boundaries — a class talent amplifying a spec ability, or a hero talent that changes when a spec cooldown should be used.

For each taken talent, trace its effects through the interaction graph:

1. What abilities does it directly modify? (from `byTalent`)
2. What other talents modify those same abilities? (from `bySpell`)
3. Do any of those co-modifiers create compound effects? (multiplicative stacking, proc chains, resource enablement)

## Phase 2: Identify Talent Tensions

### Mutually Exclusive Choices

At choice nodes, the tree forces a decision between alternatives. For each choice node in the current build:

- What does the chosen talent contribute to the rotation economy?
- What does the unchosen alternative contribute?
- Is the choice clearly correct, or is it close enough that build context (AoE vs ST, burst vs sustain) could flip it?
- Does the unchosen alternative have synergies with OTHER talents in the build that would create compound value?

### Point Budget Pressure

With fixed point budgets per tree (class, spec, hero), every talent point has an opportunity cost. The question isn't "is this talent good?" — it's "is this talent better than the best alternative use of this point?"

### Build-APL Coupling

Some talent changes are APL-neutral (a flat damage amp doesn't change what you cast or when). Others require APL restructuring. Identify talents that create build-APL coupling:

- **Resource generation scaling:** Does this talent change how resource generation scales with target count?
- **New resource sources:** Does this talent add a resource source on a different timescale than the primary generator?
- **Cooldown frequency:** Does this talent add charges to a cooldown or reduce its recharge time?
- **Effect spreading:** Does this talent spread a single-target effect to multiple targets?
- **Timing changes:** Does this talent change cast times, delays, or activation windows?

For each talent in the build, ask: "If I removed this talent, would the APL need to change? If I added a different talent, would the APL need to change?" Talents that require APL changes are the highest-leverage analysis targets.

## Phase 3: Investigate Non-Obvious Combinations

### Feedback Loops

Look for cycles where resource consumption procs a buff that increases generation rate, creating a self-reinforcing loop. Trace these through the interaction graph and `cpp-proc-mechanics.json` for proc rates and ICDs.

### Threshold Interactions

One talent moves a value across a breakpoint that another talent cares about. The value of the generator talent depends on the spender's cooldown AND the hero tree's resource consumption pattern.

### Anti-Synergies

Talents that individually look good but work against each other when combined:

- Multiple generators for the same resource might cause overcapping
- Two damage amplifiers for the same window might saturate the GCD budget
- A talent that encourages pooling resources + a talent that rewards spending creates a behavioral contradiction

## Phase 4: Quantify and Rank

For each insight, compute expected DPS impact with specific numbers:

- Modifier contributions: talent's modifier % x ability's share of total DPS
- Resource flow changes: additional resources generated x marginal spending value
- Cycle changes: altered cooldown frequency x damage per cast
- Interaction compounds: product of stacked modifiers vs sum of individual values

Rank findings by:

1. **Build errors** — talents that are strictly dominated by alternatives
2. **High-value swaps** — single-point changes with clear DPS gains
3. **Structural opportunities** — multi-point changes that open new synergy paths (requires APL adaptation)
4. **Speculative combinations** — non-obvious interactions worth testing
