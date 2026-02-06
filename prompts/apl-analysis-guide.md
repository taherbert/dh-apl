# APL Analysis Methodology Reference

Load this document at the start of any APL analysis session. It provides calculation frameworks, data field references, and worked examples for SimulationCraft APL optimization.

This guide is **spec-agnostic**. Spec-specific data (abilities, resources, spell IDs, coefficients) comes from the spec adapter via `getSpecAdapter().getSpecConfig()`. All field paths reference the project data files: `data/spells-summary.json`, `data/interactions-summary.json`, `data/talents.json`.

---

## 0. Loading the Knowledge Base

**This is the single canonical list of data sources for any analysis session.** `/optimize` and all internal methodology files reference this section. If a new data source is added, update it here — not in individual prompts.

Run `node src/engine/startup.js` to determine the active spec. All `{spec}` paths below use the spec name from startup output.

### Tier 1 — Mechanical Blueprint (always load)

| Source                                                            | What it provides                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spec adapter** (`src/spec/{spec}.js` → `SPEC_CONFIG`)           | Resource models (names, caps, generators, consumers), hero trees (state machines, rhythms, key buffs, `aplBranch`, `buildMethod`), burst windows (durations, damage amps), synergy clusters, resource flows, off-GCD abilities, cooldown buffs. This is the mechanical blueprint — all spec-specific knowledge comes from here. |
| **APL** (`apls/{spec}/current.simc` or `apls/{spec}/{spec}.simc`) | The actual rotation being analyzed — action lists, conditions, variables, delegation structure.                                                                                                                                                                                                                                 |
| **Spell data** (`data/{spec}/spells-summary.json`)                | Ability mechanics with numbers: cooldowns, resources, durations, GCD, AoE radius, school, charges, descriptions.                                                                                                                                                                                                                |

### Tier 2 — Interaction & Proc Data (load for any non-trivial analysis)

| Source                                                         | What it provides                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Interactions** (`data/{spec}/interactions-summary.json`)     | Talent-to-spell interaction map: what modifies what, proc chains, application types, magnitudes. Trace chains through this to find non-obvious dependencies. |
| **C++ proc mechanics** (`data/{spec}/cpp-proc-mechanics.json`) | Proc rates, ICDs, RPPM values, hidden constants extracted from the C++ source. Reveals mechanics not visible in spell tooltips.                              |
| **Build theory** (`data/{spec}/build-theory.json`)             | Curated archetype definitions, talent clusters, synergy/tension analysis, hero tree interactions.                                                            |

### Tier 3 — Accumulated Knowledge (load to avoid re-work)

| Source                                             | What it provides                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Findings** (`results/{spec}/findings.json`)      | Filter `status: "validated"` for known truths. Check `status: "rejected"` to avoid retesting dead ends. Your analysis should be consistent with validated findings, or explain why they no longer hold. |
| **Hypotheses** (`results/{spec}/hypotheses.json`)  | Queued untested ideas from prior sessions.                                                                                                                                                              |
| **Builds** (`results/{spec}/builds.json`)          | Discovered archetype rankings and factor impacts from DoE.                                                                                                                                              |
| **Deep analyses** (`results/{spec}/*_analysis.md`) | Prior C++ investigations, detailed mechanical analyses.                                                                                                                                                 |

### Tier 4 — External References (when internal data has gaps)

When you encounter unclear talent interactions, uncertain mechanic behavior, or new abilities without C++ coverage:

- Search **Wowhead** or **Icy Veins** spec guides for the relevant mechanic
- Treat community sources as **hypotheses to verify**, not ground truth
- Cross-reference against C++ proc data and spell effects before trusting
- Prioritize official/primary sources over community speculation

### Spec Adapter API

```javascript
import { getSpecAdapter } from "../spec/loader.js";
const adapter = getSpecAdapter();
const config = adapter.getSpecConfig();
```

Key config sections: `config.resources`, `config.heroTrees`, `config.buffWindows`, `config.synergies`, `config.offGcdAbilities`, `config.cooldownBuffs`, `config.resourceFlow`.

Use `adapter.loadAbilityData()` for merged spell data with domain overrides applied.

---

## 1. Resource Flow Analysis

### Primary Resource Economy

Read `config.resources.primary` for the resource name and cap. Read `config.resourceFlow` for generators and consumers with per-cast amounts.

The primary resource is a builder/spender resource with a defined cap. Generation and spending must be modeled to avoid overcapping (waste) or starvation (empty GCDs).

**Generation sources** (from `resourceFlow.generates[]` and spell effects):

Look up each generator in `spells-summary.json`. Key fields: `resourceFlow.generates[].amount`, `effects[].details.baseValue` (type: Energize Power), `charges` (for charge-based abilities).

**Spending priorities** (from `resource.cost` or `resourceFlow.costs[]`):

Look up each spender's cost. Compare DPGCD per resource spent to identify the most efficient spender.

**Resource equilibrium equation:**

```
ResourcePerSecond_gen = sum(generator_casts/sec * resource_per_cast)
ResourcePerSecond_spend = sum(spender_casts/sec * spender_cost)
Equilibrium when: ResourcePerSecond_gen >= ResourcePerSecond_spend
```

To compute casts per second for charge-based abilities: with N charges and C seconds recharge (haste-scaled), sustained rate = N / C \* haste_factor (up to charge cap throughput).

**Overcap risk:** If generation exceeds spending capacity, excess resource is wasted:

```
waste_per_sec = max(0, ResourcePerSecond_gen - ResourcePerSecond_spend)
waste_dps_cost = waste_per_sec * (best_spender_damage / best_spender_cost)
```

### Secondary Resource Economy (if applicable)

Some specs have a secondary resource (e.g., combo points, soul fragments, holy power). Read `config.resources.secondary` — if present, model its generation and consumption the same way.

Secondary resources are often generated by specific abilities and consumed by spenders in batches. Key modeling questions:

- What is the cap? (Read from config)
- Which abilities generate how many per cast?
- Which spenders consume how many, and does damage scale with amount consumed?
- What is the optimal consumption threshold (e.g., cast spender at 4+ secondary resource)?

Look up generation amounts in spell effects (`effects[].details.baseValue`) and consumption caps in spender spell data.

**Secondary resource equilibrium:**

```
secondary_per_cycle = sum(generator_casts * secondary_per_cast) + proc_generation
secondary_consumed_per_cycle = spender_casts * avg_consumed_per_spender
```

The optimal spender threshold depends on damage scaling per unit of secondary resource consumed.

### GCD Budget Modeling

At 1.5s base GCD (haste-scaled), the total GCD budget per minute is:

```
GCDs_per_minute = 60 / (1.5 / haste_factor)
```

At 20% haste: 60 / 1.25 = 48 GCDs/min.

**On-GCD abilities compete for time.** Check `gcd` field in spells-summary.json:

- `gcd: 1.5` = on-GCD (standard abilities)
- `gcd: 0` = off-GCD (read from `config.offGcdAbilities`)
- `gcd: 0.5` = reduced GCD (some abilities)

GCD allocation framework:

```
GCDs_available = 48  (at 20% haste)
GCDs_builder   = min(charges_available, resource_needed / resource_per_cast) * ...
GCDs_spender   = secondary_resource_available / secondary_per_spender
GCDs_maintenance = cooldown abilities (1 per cooldown cycle each)
GCDs_filler    = GCDs_available - (builder + spender + maintenance + ...)
```

If allocated GCDs exceed budget, lower-priority abilities get dropped. This is the core APL ordering problem.

---

## 2. Damage-per-GCD Framework

### Raw DPGCD from AP Coefficients

Look up `effects[].details.apCoefficient` in spells.json. This is the fraction of Attack Power dealt as damage per hit.

```
raw_damage = AP * apCoefficient * (1 + delta/2)  [average with delta variance]
DPGCD = raw_damage / (gcd_duration)
```

For abilities with per-unit-of-secondary-resource scaling (e.g., a spender that hits once per consumed resource unit):

```
total_coefficient = per_unit_coefficient * units_consumed
```

Look up AP coefficients for each ability from spells.json `effects[].details.apCoefficient`.

### Effective DPGCD with Modifier Stacking

Look up interactions targeting the spell in `interactions-summary.json`. Filter by `type: "damage_modifier"`.

Modifiers with `magnitude.stacking: "multiplicative"` multiply together:

```
effective_damage = raw_damage * (1 + mod1) * (1 + mod2) * ...
```

Modifiers with `magnitude.stacking: "additive"` sum before applying:

```
effective_damage = raw_damage * (1 + mod1 + mod2 + ...)
```

### Opportunity Cost

Every GCD spent on ability X is a GCD not spent on ability Y.

```
opportunity_cost(X) = DPGCD(next_best_alternative) - DPGCD(X)
```

If opportunity_cost > 0, ability X should not be cast. An ability is worth casting only when its effective DPGCD exceeds every available alternative.

For abilities with secondary effects (healing, resource generation, secondary resource generation), convert those to damage-equivalent value:

```
effective_DPGCD(X) = direct_DPGCD(X) + resource_generated * resource_to_damage_rate + secondary_generated * secondary_to_damage_rate
```

Where `resource_to_damage_rate = best_spender_DPGCD / best_spender_resource_cost`.

---

## 3. Cooldown Optimization

### Waste Analysis

Every second a cooldown sits ready but unused is lost DPS.

```
waste_dps = ability_total_damage / cooldown_duration * seconds_wasted / cooldown_duration
```

More precisely:

```
casts_lost_per_fight = floor(seconds_wasted / cooldown)
damage_lost = casts_lost_per_fight * damage_per_cast
```

Read cooldown from `cooldown` (simple) or `charges.cooldown` (charge-based) fields in spells-summary.json.

### Alignment Windows

Read `config.buffWindows` and `config.cooldownBuffs` for burst windows with damage amplification. When two cooldowns are active simultaneously, their damage modifiers multiply:

```
aligned_value = base_damage * mod_A * mod_B
unaligned_value = base_damage * mod_A + base_damage * mod_B  (across separate windows)
alignment_gain = aligned_value - unaligned_value = base_damage * mod_A * mod_B - base_damage * (mod_A + mod_B)
```

This simplifies to: alignment is worth `base_damage * mod_A * mod_B` extra damage, which is positive when both mods > 0. Larger modifiers benefit more from alignment.

### Fractional Cooldown Math

Over a fight of duration T with cooldown C:

```
max_casts = 1 + floor((T - cast_time) / C)
```

For charge-based abilities (read `charges.count` and `charges.cooldown` from spell data):

```
max_casts = charges + floor((T - initial_gcd) / recharge_time)
```

### Holding Cost

DPS lost per second of holding a cooldown:

```
holding_cost_per_sec = damage_per_cast / cooldown^2
```

This derives from: holding C seconds delays all future casts by C seconds, losing approximately one cast over (cooldown / C) cycles. Only hold if the alignment gain exceeds holding_cost \* hold_duration.

### SimC Cooldown Mechanics

**`sync` modifier:** Forces an action to wait until another action is also ready. Useful for aligning cooldowns without complex conditions:

```
actions+=/big_cooldown,sync=other_cooldown
```

**`cooldown_react`:** Returns 1 only if the cooldown has elapsed AND sufficient reaction time has passed (default 0.5s). Prevents unrealistic instant reactions to cooldown availability.

**Charge-based cooldowns:** Use `cooldown.X.charges_fractional` for partial charge tracking and `cooldown.X.full_recharge_time` for time until all charges are ready:

```
# Cast if we'd cap charges before next GCD
actions+=/builder,if=cooldown.builder.charges_fractional>=1.8
```

**Multi-variable hold patterns:** Use variables to coordinate hold decisions across multiple cooldowns:

```
variable,name=hold_ability_a,value=cooldown.ability_b.remains<ability_a_cd*0.3
actions+=/ability_a,if=!variable.hold_ability_a&<resource_condition>
```

This centralizes hold logic in a variable, then references it from multiple action lines. See `reference/wiki/action-lists.md` (APL Variables section).

---

## 4. Buff/Debuff Maintenance

### Uptime Modeling

For buffs/debuffs with known duration and cooldown:

```
theoretical_uptime = duration / cooldown
```

In interactions-summary.json, some entries include `theoreticalUptime` directly (e.g., permanent-uptime buffs show `theoreticalUptime: 1`).

For abilities where uptime < 1, the effective DPS contribution of a buff is:

```
effective_modifier = (modifier_value * uptime) + (1 * (1 - uptime))
```

### Pandemic Windows

Refreshing a buff/debuff before it expires extends the duration up to 130% of base. The pandemic window is the final 30% of the duration.

```
pandemic_window = duration * 0.3
safe_refresh_time = duration - pandemic_window = duration * 0.7
```

For any buff/debuff, read `duration` from spells-summary.json and compute the pandemic window. Refreshing outside the window wastes the remaining duration. Refreshing too late leaves a gap.

### Travel Time Compensation

Some abilities have a placement delay (e.g., ground-targeted sigils, travel-time projectiles). Account for this when modeling uptime:

```
effective_gap = cooldown - duration + travel_time
effective_uptime = duration / (cooldown + travel_time)
```

Check talent modifications in interactions-summary.json for talents that reduce placement delays.

### Buff Cascade Chains

Some buffs enable or amplify other effects, creating chains. Read `config.cooldownBuffs` for major damage windows, then trace interactions-summary.json to find all abilities amplified during that window.

Model cascade value as:

```
cascade_value = sum(ability_damage * modifier_from_chain) for each ability cast during window
              - sum(ability_damage) for the same abilities cast without the chain
```

The optimal strategy is to stack as many high-value GCDs into the amplification window as possible.

---

## 5. AoE Scaling Analysis

### Target-Count Breakpoints

For each ability, look up the `aoe` field in spells-summary.json: `{radius, maxTargets, reducedAoe}`.

Compare single-target DPGCD to AoE DPGCD:

```
AoE_DPGCD(N) = single_hit_damage * min(N, maxTargets) * aoe_reduction_factor(N)
```

Where `reducedAoe` indicates reduced damage beyond a threshold (typically sqrt scaling or explicit cap).

### Priority Shifts by Target Count

Build a DPGCD table per ability at each target count:

| Ability     | 1T        | 2T     | 3T     | 5T     | 8T     |
| ----------- | --------- | ------ | ------ | ------ | ------ |
| Builder     | coeff\*AP | same   | same   | same   | same   |
| AoE Spender | X\*AP     | 2X\*AP | 3X\*AP | 5X\*AP | 8X\*AP |
| ST Spender  | Y\*AP     | ~Y\*AP | ...    | ...    | ...    |

The crossover point where AoE abilities surpass ST abilities defines target-count breakpoints for APL `active_enemies>=N` conditions.

### Funnel vs Spread Damage

- **Spread:** Damage is split evenly across targets (e.g., an AoE spender hits all targets equally).
- **Funnel:** Damage concentrates on priority target while cleaving.
- **Quadratic scaling:** When both secondary resource generation AND secondary resource consumption scale with targets.

### Quadratic Secondary Resource Scaling

If a talent or mechanic generates secondary resources proportional to targets hit, and the spender deals damage to all targets proportional to secondary resources consumed, the result is quadratic scaling:

```
secondary_from_aoe_proc = targets * ticks * proc_chance
spender_casts = secondary_from_aoe_proc / secondary_per_spender
total_aoe_damage = spender_casts * damage_per_spender * targets
```

The `ticks * targets * proc_chance * targets` term gives quadratic scaling in N (targets).

---

## 6. Talent Interaction Analysis

### Modifier Stacking Calculations

In interactions-summary.json, each interaction has `magnitude.stacking` indicating how it combines:

- `"multiplicative"`: `total = product of (1 + value/100) for each modifier`
- `"additive"`: `total = 1 + sum(value/100) for each modifier`

### Synergy Cluster Discovery

Query interactions-summary.json `bySpell` lookups to find all talents that modify a given spell. Talents that modify the same high-value spell form a synergy cluster.

```javascript
// Pseudo-query: find all modifiers for a key spender
interactions.filter(
  (i) => i.target.name === "SpenderName" && i.type === "damage_modifier",
);
```

Read `config.synergies` for pre-identified clusters. Investigate additional clusters by:

- Grouping talents that modify the same high-DPGCD spell
- Finding talents that share a damage school target
- Identifying talents that form resource generation chains

### Build-APL Co-optimization

Talent builds and APL logic are interdependent. A talent that buffs a spender only matters if the APL actually casts that spender frequently enough to benefit. Steps:

1. Identify which talents are taken in the build.
2. Filter interactions to only those whose source is a taken talent.
3. Weight abilities by their modified DPGCD under the active talent set.
4. Order the APL by weighted DPGCD, accounting for resource constraints.

---

## 7. Proc/RPPM Analysis

### Expected Proc Rates

In interactions-summary.json, proc-based interactions have `procInfo`:

```json
"procInfo": {
  "procChance": 100   // percent chance per trigger event
}
```

In spells.json, look for `procChance` (percent per event) or `realPPM` (procs per minute, haste-adjusted).

For RPPM:

```
expected_procs_per_minute = RPPM * (1 + haste_percent/100)
avg_time_between_procs = 60 / expected_procs_per_minute
```

For flat proc chance:

```
expected_procs = trigger_events * (procChance / 100)
```

### Proc DPS Value

```
proc_dps = (proc_damage * expected_procs_per_minute) / 60
```

For buff procs:

```
proc_uptime = min(1, proc_duration * expected_procs_per_minute / 60)
proc_dps_value = total_buffed_damage * modifier * proc_uptime
```

### ICD Floors

`internalCooldown` in spells.json caps proc frequency regardless of trigger rate:

```
max_procs_per_minute = 60 / max(icd, 60 / (trigger_rate * proc_chance))
```

---

## 8. Off-GCD Weaving and Free Actions

### Identifying Off-GCD Abilities

Read `config.offGcdAbilities` for the spec's off-GCD abilities. Also filter spells-summary.json for `gcd: 0`.

These abilities can be cast between GCDs without delaying the next on-GCD ability.

### Weaving Without DPS Loss

Off-GCD abilities are "free" in terms of GCD budget but still have animation time. In SimC, off-GCD actions are woven automatically if placed in the APL. Place them before on-GCD abilities in the priority list so they fire during GCD dead time.

APL pattern:

```
actions+=/off_gcd_defensive,if=charges>=1&!buff.off_gcd_defensive.up
actions+=/off_gcd_movement,if=<condition>
actions+=/builder,if=...  # on-GCD follows
```

### Movement Abilities as Free Damage

Off-GCD movement abilities that deal damage provide free DPS:

```
free_dps = movement_ability_damage / movement_ability_cooldown
```

This damage costs zero GCDs. It should always be used on cooldown in pure DPS optimization (subject to positional constraints).

### SimC Off-GCD Modifiers

**`use_off_gcd=1`:** Explicitly marks an action for off-GCD execution. SimC will attempt to weave it between GCD-locked actions:

```
actions+=/defensive_ability,use_off_gcd=1,if=charges>=1&!buff.defensive_ability.up
```

**`use_while_casting=1`:** Allows an action during a cast or channel:

```
actions+=/major_cooldown,use_while_casting=1,if=action.channel_ability.channeling
```

**GCD lag mechanics:** In SimC, there is a small delay between when an off-GCD action can fire and when the sim checks for it. Placing off-GCD actions earlier in the priority list ensures they're evaluated first during these checks. See `reference/wiki/action-lists.md` (Non-Standard Timing section).

---

## 9. Systematic Non-Obvious Insight Discovery

### Inverse Optimization

Deliberately violate an APL rule and measure the DPS delta. If removing a condition causes less DPS loss than expected, the condition may be over-constrained. If it causes more, the condition is load-bearing.

```
baseline_dps = sim(original_apl)
modified_dps = sim(apl_with_rule_removed)
rule_value = baseline_dps - modified_dps
```

Run this for each conditional in the APL to build a "condition value map."

### Correlation Mining from Sim Data

After running sims, analyze:

- Ability cast counts vs DPS
- Resource waste rates vs DPS
- Buff uptimes vs DPS

Strong correlations reveal which factors most influence the outcome.

### Sensitivity Analysis

Vary numeric thresholds in APL conditions and measure DPS response:

```
# Test resource threshold for a spender
for threshold in [30, 40, 50, 60, 70, 80]:
    sim(apl with: spender,if=resource>={threshold}&secondary_resource>=N)
```

Plot DPS vs threshold to find optimal breakpoints and flat regions (where exact value does not matter).

### Cross-Scenario Divergence Detection

Run the same APL against Patchwerk at different target counts (read scenario config from `config.json`):

- Patchwerk 1T (pure single target)
- Patchwerk 5T (sustained cleave)
- Patchwerk 10T (heavy AoE)

Abilities whose rank changes dramatically between target counts need target-count-specific APL branches (`active_enemies>=N`). Look for: when AoE spenders overtake ST spenders, when proc-based secondary resource generation becomes dominant, and when GCD budget shifts from builder-heavy to spender-heavy.

### Execute Phase Detection

Some APL conditions should change as the target approaches death. Use `target.health.pct` and `target.time_to_die` to detect execute phases:

```
# More aggressive cooldown usage when fight is ending
actions+=/big_cooldown,if=target.time_to_die<15
# Dump resources instead of pooling
actions+=/spender,if=target.time_to_die<5
```

Test APL variants with `target.time_to_die` thresholds via sensitivity analysis to find where execute-phase logic adds value.

### Consumable Timing

Potions and on-use trinkets have a single use (or limited uses) per fight. Optimal timing depends on cooldown alignment:

```
actions+=/potion,if=buff.major_cooldown.up|target.time_to_die<30
```

Test potion timing against different fight durations using profilesets.

### Second-Order Effect Chains

Trace indirect value chains that do not appear in direct DPGCD calculations. These chains are invisible in single-ability analysis. Model them by tracing interaction chains: find interactions where the target of one interaction is the source of another.

Example pattern:

```
More secondary resource (from generators/procs)
  -> Bigger spender casts (more secondary consumed)
    -> More debuff uptime (if spender applies a debuff)
      -> Indirect benefits (healing, reduced defensive needs)
        -> More offensive GCDs available
          -> Higher sustained DPS
```

### Timing Micro-optimization

GCDs are quantized at 1.5s / haste. Buff durations and cooldowns are continuous. This mismatch creates optimization opportunities:

```
GCDs_in_buff_window = floor(buff_duration / effective_gcd)
```

Pandemic refresh at `duration * 0.7` gives additional GCDs in the extended window.

### Diminishing Returns Identification

Some modifiers have diminishing returns when stacked. Check if multiple interactions targeting the same spell use `stacking: "additive"` — these sum linearly and each additional point is worth less relative to total. Multiplicative stacking has increasing marginal returns.

### Talent-Combination Search Space

With N binary talent choices, there are 2^N possible builds. Use profilesets in SimC to explore:

```
profileset."build_A"+=talents=...
profileset."build_B"+=talents=...
```

Focus on talent clusters identified in Section 6. For a cluster of 5 interdependent talents, test all 32 combinations rather than evaluating each talent independently.

---

## 10. Mathematical Frameworks

### Expected Value per GCD

```
E[damage_per_GCD] = sum over all abilities:
  P(ability_is_castable) * P(ability_is_highest_priority) * damage(ability)
```

In practice, approximate by the deterministic priority ordering weighted by castability (resource available, not on cooldown).

### Resource Equilibrium Equations

For a builder/spender system:

```
Let G = total resource generation per GCD cycle
Let S = resource cost of chosen spender
Let R = ratio of builder GCDs to spender GCDs

Equilibrium: G * R_builders = S * R_spenders
Where: R_builders + R_spenders + R_other = 1 (GCD budget)
```

For a builder generating `g` resource per cast and a spender costing `s`:

```
R_builder / R_spender = s / g
```

With additional resource sources (passive generation, procs), this ratio decreases, allowing more spender casts or filler abilities.

### Uptime Under GCD Constraints

For a buff that must be maintained via a GCD-costing ability:

```
uptime_cost = GCD / cooldown  (fraction of GCD budget consumed)
effective_uptime = min(1, duration / cooldown)
```

If maintaining the buff costs too many GCDs, net DPS may decrease despite the buff's value.

```
net_value = (buffed_dps - unbuffed_dps) * uptime - opportunity_cost * uptime_cost * GCDs_per_minute
```

### AoE Damage Scaling Functions

**Linear scaling (capped):**

```
damage(N) = single_target_damage * min(N, maxTargets)
```

**Square-root reduced scaling (beyond cap):**

```
damage(N) = single_target_damage * (cap + sqrt(N - cap))  [for N > cap]
```

**Quadratic (secondary-resource-dependent):**

```
damage(N) = secondary_generation(N) * damage_per_unit * N
           = (base_secondary + N * proc_rate) * coeff * AP * N
```

---

## 11. Data File Reference

### spells.json / spells-summary.json

Each entry is a spell object. Key fields:

| Field                             | Type    | Description                                                              |
| --------------------------------- | ------- | ------------------------------------------------------------------------ |
| `id`                              | number  | Spell ID                                                                 |
| `name`                            | string  | Spell name                                                               |
| `school`                          | string  | Damage school (Physical, Fire, Chromatic, etc.)                          |
| `passive`                         | boolean | True if passive/aura                                                     |
| `resource`                        | object  | `{cost, type, typeId, spellId}` — resource cost                          |
| `resourceFlow`                    | object  | `{costs: [{amount, resourceType}], generates: [{amount, resourceType}]}` |
| `gcd`                             | number  | 0 = off-GCD, 1.5 = standard, 0.5 = reduced                               |
| `cooldown`                        | number  | Seconds (simple cooldown)                                                |
| `charges`                         | object  | `{count, cooldown}` for charge-based abilities                           |
| `duration`                        | number  | Buff/debuff duration in seconds                                          |
| `effects[]`                       | array   | Each effect has `index`, `effectId`, `type`, `details`                   |
| `effects[].details.apCoefficient` | number  | Attack Power coefficient for damage calculation                          |
| `effects[].details.baseValue`     | number  | Base value (resource count, dummy data, etc.)                            |
| `effects[].details.delta`         | number  | Damage variance (e.g., 0.05 = +/-5%)                                     |
| `effects[].details.radius`        | string  | AoE radius (e.g., "0 - 8 yards")                                         |
| `aoe`                             | object  | `{radius, maxTargets, reducedAoe}` when present                          |
| `hasteScaling`                    | object  | `{gcd: true/false}` — whether GCD scales with haste                      |
| `procChance`                      | number  | Percent chance to proc (per trigger event)                               |
| `realPPM`                         | number  | Real procs per minute (haste-scaled)                                     |
| `internalCooldown`                | number  | Minimum seconds between procs                                            |
| `description`                     | string  | Tooltip text with template variables                                     |
| `resolvedDescription`             | string  | Tooltip with variables resolved to values                                |
| `affectingSpells[]`               | array   | Spells that modify this spell, with affected effect indices              |
| `triggeredBy[]`                   | array   | Spells that trigger this spell                                           |
| `schoolMask`                      | number  | Bitmask for damage school                                                |

### interactions.json / interactions-summary.json

Top-level structure:

```json
{
  "interactions": [ ... ],   // flat array of all interactions
  "bySpell": { ... },        // lookup by target spell ID
  "byTalent": { ... }        // lookup by source talent name
}
```

Each interaction object:

| Field                | Type   | Description                                                                |
| -------------------- | ------ | -------------------------------------------------------------------------- |
| `source`             | object | `{id, name, isTalent, tree, heroSpec}`                                     |
| `target`             | object | `{id, name}` — the spell being modified                                    |
| `type`               | string | `"damage_modifier"`, `"proc_trigger"`, `"resource_modifier"`, etc.         |
| `effects[]`          | array  | Which effect indices on the target are modified                            |
| `discoveryMethod`    | string | `"spell_data"`, `"effect_scan"`, `"cpp_source"`                            |
| `confidence`         | string | `"high"`, `"medium"`, `"low"`                                              |
| `magnitude`          | object | `{value, unit, stacking, perRank, maxRank}`                                |
| `magnitude.value`    | number | Modifier amount (e.g., 15 for 15%)                                         |
| `magnitude.unit`     | string | `"percent"`, `"flat"`, `"sp_coefficient"`                                  |
| `magnitude.stacking` | string | `"multiplicative"` or `"additive"`                                         |
| `schoolTarget[]`     | array  | Schools affected (e.g., `["Fire"]`)                                        |
| `procInfo`           | object | `{procChance}` — proc details when applicable                              |
| `theoreticalUptime`  | number | 0-1, expected uptime fraction                                              |
| `application`        | string | `"buff_on_player"`, `"debuff_on_target"`                                   |
| `categories[]`       | array  | `["offensive"]`, `["defensive"]`, `["offensive", "defensive"]`             |
| `effectDetails[]`    | array  | Detailed effect breakdown with type, baseValue, affectedSpells, schoolMask |

### talents.json

Top-level structure:

```json
{
  "class": { "name": "<ClassName>", "talents": [...] },
  "spec": { "name": "<SpecName>", "talents": [...] },
  "hero": {
    "<HeroTree1>": { "subtreeId": N, "talents": [...] },
    "<HeroTree2>": { "subtreeId": M, "talents": [...] }
  }
}
```

Each talent object:

| Field          | Type   | Description                                                      |
| -------------- | ------ | ---------------------------------------------------------------- |
| `name`         | string | Talent name                                                      |
| `spellId`      | number | Associated spell ID (cross-ref with spells.json)                 |
| `nodeId`       | number | Talent tree node ID                                              |
| `posX`, `posY` | number | Position in talent tree grid                                     |
| `maxRank`      | number | Maximum talent ranks                                             |
| `type`         | string | `"active_ability"`, `"off_gcd_ability"`, `"passive"`, `"choice"` |
| `cooldown`     | number | Cooldown if applicable                                           |
| `gcd`          | number | GCD if applicable                                                |
| `charges`      | object | `{count, cooldown}` if charge-based                              |
| `description`  | string | Talent tooltip                                                   |
| `affectedBy[]` | array  | Talents/spells that modify this talent                           |

---

## 12. Worked Examples Appendix

The frameworks above are abstract. To apply them to the loaded spec, substitute concrete values from the spec adapter and spell data. Here is the general pattern for each example type:

### Example A: Spender DPGCD Calculation

```
1. Look up the spender in spells.json: get apCoefficient per unit of secondary resource
2. Multiply by units consumed: total_coeff = per_unit_coeff * N
3. raw_damage = AP * total_coeff
4. effective_gcd = 1.5 / haste_factor
5. DPGCD = raw_damage (per GCD, since we compute total damage per cast)
6. DPS_contribution = raw_damage / effective_gcd

With talent modifier (from interactions):
7. modified_damage = raw_damage * (1 + modifier_percent)
8. modified_DPS = modified_damage / effective_gcd
```

### Example B: Resource Economy Cycle

```
1. Read builder: resource_per_cast from resourceFlow, GCD cost, charges
2. Read spender: resource_cost from resourceFlow, GCD cost, secondary_resource_required
3. Compute cycle: N builders -> 1 spender
   - resource_generated = N * resource_per_cast
   - resource_spent = spender_cost
   - Net resource: surplus or deficit
   - Secondary generated: N * secondary_per_builder
   - GCDs consumed: N + 1
   - Cycle time: (N + 1) * effective_gcd
4. Sustainable rate: resource_gen / cycle_time vs resource_spend / cycle_time
5. Surplus available for additional spenders or fillers
```

### Example C: Alignment Window Value

```
1. Read cooldown buff from config.cooldownBuffs: duration, modifier_percent
2. GCDs_in_window = floor(duration / effective_gcd)
3. Value = sum(ability_damage * modifier_percent) for all GCDs in window
4. Per-minute value = window_value / cooldown
5. Misalignment cost = casting low-value abilities during the window
```

### Example D: Quadratic AoE Scaling

```
1. Identify the AoE proc talent: proc_rate per tick per target
2. Read the AoE DoT/tick ability: ticks over duration
3. secondary_from_proc = ticks * targets * proc_rate
4. Total spender casts = secondary_from_proc / secondary_per_spender
5. Total damage = spender_casts * per_cast_damage * targets
6. The targets * targets term produces quadratic scaling
```

### Example E: GCD Budget Allocation (1 minute)

```
1. Base GCD: 1.5s, with haste -> effective GCD
2. Total GCDs per minute: 60 / effective_gcd
3. Allocate by ability:
   - Builders: charges / recharge_time * 60
   - Spenders: limited by secondary resource and primary resource
   - Maintenance: cooldown abilities (60 / cooldown each)
   - Fillers: remaining GCDs
4. Off-GCD (free): list from config.offGcdAbilities
5. Remaining GCDs = total - allocated = room for fillers or waste
```

---

## 13. SimC APL Mechanics Reference

### Action Modifiers

Key modifiers beyond basic `if=` conditions (full reference: `reference/wiki/action-lists.md`):

- **`cycle_targets=1`**: Cycles the action through all available targets. Combine with `target_if=` for smart targeting:

```
actions+=/debuff_ability,cycle_targets=1,target_if=min:dot.debuff.remains,if=!dot.debuff.ticking
```

- **`target_if=min:expr` / `target_if=max:expr`**: Select target with min/max expression value. `target_if=first:expr` selects first target where expression is nonzero.

- **`line_cd=N`**: Forces N seconds between executions of this action, even if it's otherwise ready:

```
actions+=/dot_ability,line_cd=8,if=!debuff.dot.up
```

- **`interrupt_if=expr`**: Interrupts a channel when expression is true and GCD has elapsed:

```
actions+=/channel_ability,interrupt_if=<resource_ready_condition>
```

- **`chain=1`**: Re-casts a channeled spell at the beginning of its last tick. `early_chain_if=expr` chains at any tick if expression is true.

- **`sync=action_name`**: Prevents execution unless another action is also ready (see Section 3).

- **`use_off_gcd=1` / `use_while_casting=1`**: Off-GCD timing control (see Section 8).

- **`cancel_if=expr`**: Cancels a channeled action when the expression becomes true, even mid-channel.

- **`wait_until_ready=1`**: Restarts action list scanning if this action is the best choice but isn't ready yet, rather than falling through to lower-priority actions.

### Advanced Expressions

Key expressions for APL conditions (full reference: `reference/wiki/action-list-expressions.md`):

- **`prev_gcd.1.spell_name`**: True if the last GCD action was `spell_name`. The `.1` is the history depth (1 = last, 2 = two ago). Useful for sequencing.

- **`~` / `!~`**: String-in/not-in operators (from SpellQuery). Rarely used in APLs but available.

- **`<?` / `>?`**: Max/min of two values. `a<?b` returns the larger; `a>?b` returns the smaller:

```
# Cap a value at N for calculations
variable,name=capped_value,value=raw_value<?cap
```

- **`%%`**: Modulus operator. Useful for cyclic timing.

- **`buff.X.react`**: Stack count of buff X, but only after reaction time has elapsed. More realistic than `buff.X.stack` for proc-based buffs.

- **`action.X.in_flight`**: True if spell X is currently traveling to target. Use `action.X.in_flight_to_target` for current-target-specific check.

- **`cooldown.X.full_recharge_time`**: Time until all charges of X are ready. For charge-based abilities, this is more useful than `cooldown.X.remains` which only tracks the next charge.

### Spec-Specific Expressions

Consult `reference/wiki/` for class-specific SimC expressions. Common patterns:

- Resource-specific expressions (e.g., soul fragments, combo points, holy power)
- Apex talent checks using `apex.N` syntax
- Spec-specific sim options that affect behavior

Read the appropriate class wiki page in `reference/wiki/` for the loaded spec's expressions and options.

### APL Variables

Variables store computed values for reuse across conditions. Operations: `set`, `add`, `sub`, `mul`, `div`, `min`, `max`, `setif`, `reset`, `floor`, `ceil`.

```
# Define a variable
variable,name=spender_ready,value=secondary_resource>=N&primary_resource>=cost

# Use it
actions+=/spender,if=variable.spender_ready

# Conditional set with fallback
variable,name=pool_resource,op=setif,value=1,value_else=0,condition=cooldown.big_ability.remains<3
```

`cycling_variable` iterates over all targets to accumulate values:

```
actions+=/variable,name=debuff_count,op=reset
actions+=/cycling_variable,name=debuff_count,op=add,value=dot.debuff.ticking
```

Full reference: `reference/wiki/action-lists.md` (APL Variables section).

#### When to Use Variables

Variables are the APL's abstraction mechanism. All derived state and decision logic should live in variables, keeping action lines focused on what to cast.

**Always extract to a variable when:**

- A condition or sub-expression appears in more than one action line (DRY).
- A condition involves multi-step computation (e.g., accumulating a count via sequential `op=max`/`op=add` lines).
- A talent flag or build-dependent toggle gates multiple actions.
- A threshold depends on context (e.g., a resource target that changes during burst windows).

**Keep inline when:**

- The condition is unique to a single action and reads clearly (e.g., `if=resource>=40`).
- The expression is trivial and adding a variable would obscure intent.

**Design principles:**

- Name variables for the _decision_ they represent, not the mechanic (`spender_ready` not `has_enough_resource`).
- Use `op=setif` for binary flags with a fallback: `variable,name=X,op=setif,condition=expr,value=1,value_else=0`.
- Use sequential `op=reset` -> `op=max`/`op=add` lines to build up composite state.
- Variables are evaluated each time the action list reaches them. Place variable definitions at the top of the action list they belong to, before the actions that reference them.

---

## 14. Target Count Considerations

Read scenario configuration from `config.json` for the specific target counts simulated. Each target count represents a distinct optimization regime.

### Low Target Count (Pure Single Target)

- Full GCD budget on priority target.
- Spender value comes from per-unit coefficient, not from target scaling.
- Cooldown alignment is the primary optimization lever — burst windows with damage amps are high value.
- Secondary resource economy is deterministic: builders generate at a fixed rate, AoE procs contribute nothing.
- Resource pooling for burst windows matters most here.

### Medium Target Count (Sustained Cleave)

- AoE spender damage scales linearly with targets, making it dramatically higher DPGCD than ST.
- AoE proc talents become significant: ticking abilities proc secondary resources from each target, feeding quadratic scaling loops (Section 5).
- Secondary resource economy shifts from deterministic to probabilistic — proc variance affects spender cadence.
- `active_enemies>=N` breakpoints define when AoE priorities override ST priorities.
- Single-target damage amp windows are diluted across targets — alignment value decreases relative to raw AoE throughput.

### High Target Count (Heavy AoE)

- AoE spenders may hit reduced damage beyond a cap (`reducedAoe`), so scaling is sublinear past that threshold.
- Secondary resource generation from procs is abundant — the constraint shifts from "enough secondary resource" to "enough primary resource and GCDs to spend them."
- GCD budget becomes the binding constraint. Every on-GCD action competes for limited slots, so abilities with weak per-target scaling get dropped.
- Passive ticking damage (hitting all targets) becomes a larger share of total damage.
- ST spender value relative to AoE spender depends on whether you have the resources for the AoE spender; at high target counts with AoE procs, you almost always do.

### What to Compare Across Target Counts

When running the same APL at different target counts, look for:

1. **Ability rank inversions** — abilities that are high-priority at 1T but low at 5T (or vice versa).
2. **Wasted casts** — abilities being cast at target counts where they're suboptimal.
3. **Secondary resource waste** — resources expiring or overflowing at high target counts.
4. **Primary resource waste** — overcapping when secondary resource generation outpaces spending ability.
5. **Missing `active_enemies` conditions** — actions that should have target-count guards but don't.

---

## 15. APL Verification & Debugging

### Combat Logging

Enable `log=1` in the SimC profile to generate a full combat log:

```
log=1
iterations=1
```

Use single-iteration logs to trace specific sequences. Look for: ability usage order, resource values at decision points, buff uptimes, and wasted cooldown time.

### APL Export

`save_actions=filename.simc` exports the resolved APL after all variable substitutions and default list generation. Useful for verifying what SimC actually executes vs. what you wrote.

### Variance Analysis

`report_rng=1` adds RNG breakdown to the report. Combine with higher iteration counts for statistical confidence.

For formal A/B testing between APL variants, use `target_error=0.1` (or lower). See `reference/wiki/statistical-behaviour.md`.

### Profile Sets for A/B Testing

Profile sets run multiple configurations in a single sim, sharing the RNG seed for paired comparison:

```
profileset."baseline"+=
profileset."variant_A"+=actions=...modified_apl...
```

Output ranks all profilesets by DPS with confidence intervals. See `reference/wiki/profile-sets.md`.

### Spell Data Overrides

Test hypothetical tuning changes without modifying source code:

```
# What if a spender's coefficient was 10% higher?
override.spell_data=<spell_id>,<effect_idx>,<new_coefficient>
```

Useful for sensitivity analysis: "How much would DPS change if this ability were buffed/nerfed?"
