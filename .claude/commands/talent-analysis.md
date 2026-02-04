Deep analysis of VDH talent interactions, synergy clusters, and build-APL co-optimization.

Companion to `/theorycraft` (which analyzes temporal resource flow given a fixed build) and `/full-analysis` (which analyzes APL structure given a fixed build). This skill reasons about the build itself: which talents create compound value, which combinations are non-obvious, and how talent choices reshape the rotation economy.

## Setup

1. Read the talent tree and interaction data:

```
data/talents.json
data/interactions-summary.json
data/cpp-proc-mechanics.json
data/spells-summary.json
```

2. Read accumulated findings and build history:

```
results/findings.json
results/build-registry.json
```

Filter findings to `status: "validated"` — these calibrate your analysis. If builds have been tested before, their results inform which talent directions have already been explored.

3. Read the current build from the profile. Use `$ARGUMENTS` if provided, else check `apls/profile.simc` for the `talents=` line.

4. Read archetype definitions: `src/analyze/archetypes.js` (SEED_ARCHETYPES object)

5. Read the from-scratch modeling: `plans/apl-from-scratch-v2.md` (sections 1.1–1.5 for DPGCD tables, resource value analysis, state machine models)

6. Check for existing sim results (`ls results/`) to ground analysis in actual DPS contributions.

## Phase 1: Map the Interaction Graph

Build a mental model of talent interactions — not a flat list, but a graph of cause and effect.

### Modifier Stacking Chains

Using `interactions-summary.json` `bySpell` lookups, find every talent that modifies each core ability. For the high-value abilities (Fracture, Spirit Bomb, Soul Cleave, Fiery Brand, Soul Carver, Sigil of Spite), compute the total modifier stack under the current build.

Key question: **Which ability has the deepest modifier stack?** That ability's effective DPGCD is most sensitive to talent changes — adding or removing one modifier has the largest absolute impact because modifiers multiply.

Example chain: Spirit Bomb is modified by Fiery Demise (+30% during Brand), Vulnerability (+X%), Frailty (debuff), Focused Cleave (+50% to Soul Cleave which competes for fragments). These aren't independent — Fiery Demise's value depends on how many GCDs you can pack into the Brand window, which depends on fragment generation rate, which depends on Fracture talents (Keen Edge, Tempered Steel) and Fallout procs.

### Enabler vs Amplifier Talents

Classify talents by their role in the rotation economy:

- **Enablers** change what you CAN do (Spirit Bomb, Fel Devastation, Felblade — they add abilities or resources)
- **Amplifiers** change how MUCH something does (Keen Edge +10% Physical, Fiery Demise +15% Fire, Tempered Steel +12%)
- **Rhythm changers** alter the rotation's tempo (Fallout changes fragment generation rate, Soul Sigils adds fragment sources, Quickened Sigils changes sigil timing)
- **State machine modifiers** change the hero tree cycle (Bladecraft adds Reaver's Mark stacks, Thrill of the Fight changes empowered window value, World Killer changes Meta cycling)

The interesting build decisions are usually between talents of DIFFERENT types. Taking another amplifier for an already-strong ability has diminishing returns (additive stacking) or predictable returns (multiplicative stacking). Taking a rhythm changer can reshape the entire rotation economy in ways that aren't obvious from the talent tooltip.

### Cross-Tree Synergy Detection

The most valuable talent interactions cross tree boundaries — a class talent amplifying a spec ability, or a hero talent that changes when a spec cooldown should be used.

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

With 34 class + 34 spec + 13 hero points, every talent point has an opportunity cost. The question isn't "is this talent good?" — it's "is this talent better than the best alternative use of this point?"

For each talent in the current build, estimate its DPS contribution:

- Direct: damage modifier × affected ability's DPS share
- Indirect: resource generation changes × downstream spending value
- Structural: how it changes what the APL can or should do

Then identify the weakest talents — the ones contributing the least per point. Are there unselected talents that would contribute more if swapped in?

### Build-APL Coupling

Some talent changes are APL-neutral (a flat damage amp doesn't change what you cast or when). Others require APL restructuring:

- **Fallout** (fragment proc from Immo Aura): Changes the fragment economy at different target counts. With Fallout, fragment generation scales with targets, making Spirit Bomb relatively more valuable in AoE. Without it, fragment generation is fixed. The APL's `active_enemies` breakpoints need to shift.
- **Soul Sigils** (fragments from sigils): Adds a new fragment source on a different timescale than Fracture. Changes pooling logic.
- **Quickened Sigils** vs **Concentrated Sigils**: Changes sigil placement delay, which affects uptime modeling and weaving.
- **Down in Flames** (extra Brand charge): Fundamentally changes the Fiery Demise burst window frequency. Two Brand charges mean twice the burst windows — the APL should spend differently.
- **Burning Alive** (Brand spreads): In AoE, this changes Brand from single-target amp to multi-target. Completely reshapes the value of Brand-aligned abilities.

For each talent in the build, ask: "If I removed this talent, would the APL need to change? If I added a different talent, would the APL need to change?" Talents that require APL changes are more interesting to analyze because their value isn't captured by a simple modifier percentage.

## Phase 3: Investigate Non-Obvious Combinations

This is the creative core. Look for talent combinations where the whole exceeds the sum of parts.

### Feedback Loops

A feeds B which feeds A. Example:

- Untethered Rage procs haste on fragment consumption
- More haste → faster GCDs → more Fracture casts → more fragments
- More fragments → more consumption → more Untethered Rage procs
- Is there a critical mass where this loop becomes self-sustaining?

### Threshold Interactions

One talent moves a value across a breakpoint that another talent cares about. Example:

- Soul Sigils adds fragments from sigil casts
- This might push fragment counts above Spirit Bomb's optimal threshold more often
- But only if the sigil-generated fragments arrive at the right TIME relative to Spirit Bomb's cooldown
- The value of Soul Sigils depends on Spirit Bomb's cooldown (spec talent) AND the hero tree's fragment consumption pattern

### Anti-Synergies

Talents that individually look good but work against each other when combined:

- Talents that both generate fragments might cause overcapping if the APL can't consume fast enough
- Two damage amplifiers for the same window might saturate the GCD budget in that window
- A talent that encourages pooling + a talent that rewards spending creates a behavioral contradiction

### "What if?" Scenarios

For 2-3 promising unchosen talents, model what would change:

- How does the rotation economy shift?
- What APL changes would be needed?
- Is the expected DPS gain worth the point(s) spent and the point(s) given up?
- Does this open up or close off other synergy paths?

## Phase 4: Quantify and Rank

For each insight, compute expected DPS impact with specific numbers:

- Modifier contributions: talent's modifier % × ability's share of total DPS
- Resource flow changes: additional resources generated × marginal spending value
- Cycle changes: altered cooldown frequency × damage per cast
- Interaction compounds: product of stacked modifiers vs sum of individual values

Rank findings by:

1. **Build errors** — talents that are strictly dominated by alternatives
2. **High-value swaps** — single-point changes with clear DPS gains
3. **Structural opportunities** — multi-point changes that open new synergy paths (requires APL adaptation)
4. **Speculative combinations** — non-obvious interactions worth testing

## Phase 5: Test (if requested)

For testable hypotheses, use profilesets to compare builds:

```bash
# Single talent swap
node src/sim/profilesets.js --talent-swap "Old Talent:New Talent"

# Or via iterate.js with a modified profile
node src/sim/iterate.js compare apls/candidate.simc --quick
```

For talent changes that require APL adaptation:

1. Generate the modified talent build
2. Write the corresponding APL changes
3. Test the BUILD+APL combination together — testing the build with an unadapted APL underestimates the talent's value

## Output

### Current Build Assessment

- Modifier stack depths per core ability
- Weakest talents (lowest contribution per point)
- Build-APL coupling points

### Synergy Map

- Cross-tree interaction chains
- Feedback loops identified
- Anti-synergies flagged

### Recommendations (ranked)

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

1. Append new insights to `results/findings.json` — each synergy, anti-synergy, or talent evaluation is a finding with evidence, confidence, and tags (use `talent-synergy`, `build-apl-coupling`, `state-machine` tags from `results/SCHEMA.md`)
2. If any finding contradicts an existing one, mark the old one `status: "superseded"`
3. If specific builds were evaluated, add or update entries in `results/build-registry.json`
