# Gear Optimizer Redesign: Sim Components, Assemble by Constraint

**Date:** 2026-03-16
**Status:** Design
**Goal:** A single deterministic command that finds the highest-DPS full gear set by simming components (needed for the report anyway), then assembling optimal sets via constraint solving.

## Problem Statement

The current 12-phase gear pipeline (`src/sim/gear.js`) evaluates gear slot-by-slot in a fixed priority order, then assembles results via a priority waterfall (`buildGearLines()`). This causes:

1. **Ordering bugs**: Phase 4 picks weapons before Phase 7 picks embellishments. Weapon choice depends on whether a crafted weapon carries an embellishment, but that decision hasn't been made yet.
2. **Profile propagation errors**: The profile writer reads the old profile and preserves lines for uncovered slots, inheriting stale gems, wrong item names, and corrupted embellishment counts.
3. **Missed cross-slot interactions**: Embellishment slot displacement cost depends on what drop item is displaced, which depends on EP weights, which depend on the overall gear set. The pipeline computes these sequentially rather than jointly.
4. **Non-determinism**: Different starting profiles produce different outputs because the priority waterfall inherits baseline items for uncovered slots.

## Design Principles

- **Deterministic**: Same `gear-candidates.json` + same sim results = same output. No random perturbation, no old-profile inheritance.
- **Report-integrated**: Component sims produce report ranking data as a byproduct. No duplicate sim work.
- **EP for stat-sticks only**: Effect items, embellishments, trinkets, and mini-sets are always sim-evaluated. EP is used only where it's reliable (items whose value comes entirely from secondary stats).
- **Constraint-coupled**: Embellishments, mini-sets, tier skip, and crafted slots are solved as one constraint graph, not as independent sequential phases.
- **Clean output**: Profile generated from `gear-candidates.json` as sole source of truth. The old profile provides only the preamble (talents, flask, food, overrides).

## Item Taxonomy

| Category                     | Evaluation method                                                       | Examples                                                                |
| ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Stat sticks                  | EP-rankable, deterministic                                              | Most neck, back, waist, feet, wrist drops                               |
| Effect items                 | Sim required (proc value not captured by EP)                            | Proc weapons, special rings, on-equip items                             |
| Mini-set pairs               | Sim as pair AND individually (a piece may be BiS without the set bonus) | Row Walker's 2P (Murder Row Materials)                                  |
| Embellishment combos         | Sim as pairs with displacement cost baked in                            | Sigil Hunt + Sigil Hunt, World Tree Rootwraps + Prismatic Focusing Iris |
| Built-in embellishment items | Sim required; ARE crafted, count toward emb cap                         | World Tree Rootwraps, Loa Worshiper's Band, Row Walker's pieces         |
| Trinkets                     | Sim as pairs, value is stat-dependent (evaluate last)                   | On-use, passive, proc trinkets                                          |
| Tier pieces                  | Locked 4-of-5; which slot to skip is a constraint variable              | Devouring Reaver's set                                                  |

## Constraints (Hard)

- Exactly 4 tier set pieces (from 5 possible tier slots: head, shoulder, chest, hands, legs)
- Exactly 2 embellishments (explicit `embellishment=X` tags + built-in items that inherently have one)
- At most 2 crafted items (identified by `bonus_id=8793` or `crafted_stats=`)
- A crafted item without an embellishment is never optimal (ilvl penalty makes it strictly worse than the best drop)
- Built-in embellishment items are crafted AND consume an embellishment slot
- Unique-equip restrictions (some items cannot coexist)
- Not all embellishments can be applied to all item types
- Mini-set bonuses require specific item pairs; individual pieces are also valid standalone candidates

## Pipeline Phases

### Phase 1: Scale Factors (~5 min)

Run `calculate_scale_factors=1` across all 4 scenarios for the top roster build. Produces:

- Weighted scale factors (Agi, Haste, Crit, Mastery, Vers)
- DPS plot curves for iterative EP reweighting
- Iterative reweighting (max 5 iterations) to correct self-reinforcing EP bias

Scale factors are used ONLY for:

- Pruning stat-stick slots from ~15 candidates to top ~5
- Gem EP ranking
- Enchant EP ranking (stat enchants only; weapon/ring enchants are simmed)

Scale factors are NOT used for: effect items, embellishments, trinkets, mini-sets, or any item whose value comes from a proc or special effect.

### Phase 2: Component Sims (~12-18 min)

All sims run against the current profile as baseline, using 3 representative builds across 4 scenarios. All results feed directly into the report AND into the Phase 3 constraint solver.

#### 2a. Embellishment Pairs (~12 profileset runs)

Generate all valid (effect1, effect2, slot1, slot2) tuples:

- Standard effect pairs: C(N,2) + N same-effect-doubled, placed on the cheapest displacement-cost crafted slots
- Built-in item + effect pairs: each built-in item paired with each effect on the cheapest non-overlapping slot
- Built-in item pairs: C(builtIn, 2) where both items fit the crafted/emb budget
- Null embellishment baseline (crafted items with no effects)

Each variant replaces 2 slots with crafted items carrying the specified effects. The sim directly measures net DPS including displacement cost relative to the current profile.

Estimated: ~65-80 pair variants across ~12 profileset runs.

Report output: Full embellishment pair rankings with weighted DPS and per-scenario breakdown.

#### 2b. Effect Items (~8 profileset runs)

Per-slot evaluation of all items that need sims (proc weapons, special rings, items with on-equip effects). Each item is simmed as a drop-in replacement for that slot.

Slots evaluated: main_hand, off_hand, and any slot containing items tagged with `proc` or `effect` in gear-candidates.json.

Report output: Per-slot rankings for weapon evaluation, effect item tiers.

#### 2c. Mini-Set Evaluation (~4 profileset runs)

For each mini-set (e.g., Row Walker's 2P with items in wrist/chest/hands):

- Sim each valid pair combination WITH set bonus active (C(3,2) = 3 pairs for a 3-piece set)
- Sim each piece individually as a standalone item (it may be BiS even without the set bonus)

Report output: Mini-set DPS contribution, per-piece standalone rankings.

#### 2d. Trinket Screening (~8 profileset runs)

Screen all trinket candidates individually. Each trinket is simmed in slot 1 with the current profile's slot 2 trinket as anchor.

On-use trinkets are auto-advanced to pairing regardless of screen rank to avoid fixed-anchor bias (on-use trinkets that pair well with other on-use trinkets are systematically understated by individual screening).

Report output: Individual trinket rankings, trinket scaling by ilvl tier.

### Phase 3: Constraint Assembly (~0 sims, milliseconds)

A constraint solver enumerates all valid full gear sets.

**Inputs:**

- Phase 2a: embellishment pair DPS deltas (sim-measured)
- Phase 2b: effect item DPS deltas (sim-measured)
- Phase 2c: mini-set pair and individual DPS deltas (sim-measured)
- Phase 1: EP weights for stat-stick scoring (top ~5 per slot after pruning)

**Hard constraints enforced:**

- Exactly 4 tier pieces from 5 possible tier slots
- Exactly 2 embellishments (explicit + built-in)
- At most 2 crafted items
- Unique-equip restrictions
- Slot type validity (embellishment type restrictions, item slot restrictions)
- Mini-set pair atomicity (both pieces or neither for set bonus; individual pieces evaluated separately)

**Scoring:**
For each valid configuration, estimate total DPS by summing:

- Embellishment pair DPS delta (from Phase 2a sim)
- Effect item DPS deltas for non-stat-stick slots (from Phase 2b sim)
- Mini-set bonus DPS if applicable (from Phase 2c sim)
- EP score for each stat-stick slot (from Phase 1 weights)

This assumes component DPS contributions are approximately additive. Phase 4 validation catches cases where this assumption fails.

**Output:** Top ~10 candidate full-set configurations, ranked by estimated total DPS.

**Search space estimate:** After Phase 2 pruning, the free variables are: tier skip (5 options), embellishment config (~65 options from Phase 2a), effect items per sim-slot (~5-10 per slot), stat-sticks per EP-slot (~5 per slot, ~6-8 free slots). With constraint pruning (crafted limit, emb limit, unique-equip), the valid configuration space is ~50K-100K. Scoring each takes microseconds.

### Phase 4: Full-Set Validation (~4 min)

Top 10 full-set configurations from Phase 3 are simmed as complete 16-slot gear sets at standard fidelity. Each configuration specifies every slot explicitly.

This catches:

- Cross-slot stat synergies that EP missed
- Displacement cost errors from old-profile baseline
- Multiplicative interactions between components
- Non-additive DPS contributions

Output: Validated ranking of top 10 full sets. Winner selected.

### Phase 5: Trinket Pairing (~3 min)

#### 5a. Pair sims (~4 profileset runs)

Top-K trinkets from Phase 2d screening are paired (C(K,2) combinations) and simmed against the Phase 4 winning gear set. Trinket value is measured in the correct stat context.

#### 5b. Cross-validation (~9 profileset runs)

Top 3 trinket pairs simmed against top 3 embellishment configurations as complete 16-slot sets. This catches trinket x embellishment synergies (e.g., a crit-buff trinket paired with a crit-scaling embellishment).

If a different trinket pair or embellishment config wins in cross-validation, update the winning set accordingly.

Report output: Full trinket pair rankings against the optimized gear set.

### Phase 6: Re-evaluation (~7 min)

#### 6a. Embellishment re-check (~4 profileset runs)

Unconditionally re-sim the top ~10 embellishment pairs against the winning gear set (not the old profile). If a different pair wins, re-run Phase 4 validation with the new embellishment config.

#### 6b. Second EP pass + stat-stick re-check (~5 min)

Re-derive scale factors from the winning gear set's stat profile. Re-prune stat-stick slots with the new weights. If any slot's winner changes, substitute and re-validate the full set.

This iterative convergence step closes the scale factor instability gap. If the winning set's stat profile is similar to the foundation profile, this phase converges immediately (1 iteration). If stats shifted significantly, it may take 2-3 iterations.

### Phase 7: Gems + Enchants + Final Validation (~3 min)

#### 7a. Gems (~2 profileset runs)

Sim gem configurations against the final set:

- Diverse + Eversong Diamond (unique prismatic gem requires color diversity)
- All-same best EP gem
- All-same 2nd-best EP gem

Gem socket count per item comes from `gear-candidates.json` candidate definitions, NOT from the old profile.

#### 7b. Enchants (~2 profileset runs)

- Stat enchants (chest, legs, shoulder, cloak): EP-ranked, no sim needed
- Weapon enchants: simmed (proc-based, value depends on weapon speed/type)
- Ring enchants: simmed (proc-based)

#### 7c. Final validation (~1 profileset run)

Complete assembled set with gems and enchants, simmed at confirm fidelity against the original profile baseline. Must pass quality gate (assembled >= original).

### Phase 8: Write Profile

Generate `profile.simc` FROM SCRATCH using `gear-candidates.json` as the sole source of truth.

**Input sources for each line:**

- Slot assignment: Phase 3 constraint solver output
- Item SimC string: `gear-candidates.json` candidate `simc` field
- Crafted stats: Phase 2 stat allocation (or re-optimized from Phase 6b)
- Embellishment tag: Phase 3 constraint solver (which effect on which item)
- Gem IDs: Phase 7a gem config, socket count from candidate definition
- Enchant IDs: Phase 7b enchant winners
- Preamble (talents, flask, food, overrides): Read from old profile (only non-gear lines)

**Verification before writing:**

- Each item's gem count matches socket count in gear-candidates.json
- Total embellishments = exactly 2
- Total crafted items <= 2
- No `embellishment=X` on built-in embellishment items
- Every slot has exactly one item
- Quick single-profile sim confirms DPS is in expected range

## Estimated Sim Budget

| Phase                      | Profileset runs         | Wall time      |
| -------------------------- | ----------------------- | -------------- |
| 1. Scale factors           | 1 (not profileset)      | ~5 min         |
| 2a. Embellishments         | ~12                     | ~4 min         |
| 2b. Effect items           | ~8                      | ~3 min         |
| 2c. Mini-sets              | ~4                      | ~1 min         |
| 2d. Trinket screen         | ~8                      | ~3 min         |
| 3. Constraint assembly     | 0                       | <1 sec         |
| 4. Full-set validation     | ~10                     | ~4 min         |
| 5a. Trinket pairs          | ~4                      | ~2 min         |
| 5b. Cross-validation       | ~9                      | ~3 min         |
| 6a. Emb re-check           | ~4                      | ~2 min         |
| 6b. EP re-check            | 1 (not profileset) + ~5 | ~7 min         |
| 7. Gems + enchants + final | ~5                      | ~3 min         |
| **Total**                  | **~70-80**              | **~35-50 min** |

All Phase 2 sub-phases can run concurrently (independent inputs). With parallel execution on the remote instance, Phase 2 wall time could be ~8-10 min instead of ~11 min.

## Known Limitations

1. **Component additivity**: Phase 3 scoring assumes DPS contributions are additive. Phase 4 validates the top 10 and Phase 5b cross-validates trinket x embellishment interactions, but interactions beyond top 10 are missed.

2. **Old-profile baseline for Phase 2**: Component sims measure displacement cost relative to the current profile, not the optimal gear set. Phase 6a (embellishment re-check) and Phase 6b (EP re-check) mitigate this iteratively.

3. **Trinket x stat-stick synergies**: A stat-proc trinket changes the optimal secondary allocation, but stat-stick slots are filled before trinkets are finalized. Phase 6b's EP re-check partially captures this.

## Architectural Changes from Current Pipeline

| Aspect                   | Current                                 | New                                             |
| ------------------------ | --------------------------------------- | ----------------------------------------------- |
| Assembly method          | Priority waterfall (`buildGearLines()`) | Constraint solver over sim-validated components |
| Profile output           | Incremental modification of old profile | Generated from scratch                          |
| Embellishment evaluation | EP-estimated displacement cost          | Sim-measured displacement cost                  |
| Cross-slot coupling      | Phase 7.5 ring/emb conflict only        | Full constraint graph                           |
| Trinket context          | Simmed against old profile once         | Simmed against optimized gear set               |
| Determinism              | Depends on starting profile state       | Same input = same output                        |
| Gem assignment           | Queue from old profile socket counts    | Socket count from candidate definition          |
| Report integration       | Separate sim runs for report data       | Report data is Phase 2 output                   |

## File Changes

| File                               | Change                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sim/gear.js`                  | Major rewrite of pipeline orchestration, constraint solver, profile writer. Preserve sim infrastructure (profileset runner, remote routing, scenario weighting). |
| `src/sim/gear-solver.js`           | New file: constraint solver. Enumerates valid gear sets, scores by component DPS + EP, returns ranked configs.                                                   |
| `data/{spec}/gear-candidates.json` | No structural change. Ensure all items have correct socket counts, effect tags, and built-in embellishment flags.                                                |
| `data/{spec}/gear-config.json`     | No structural change. Ensure `builtInItems` is complete and correct.                                                                                             |
| `.claude/skills/gear/SKILL.md`     | Update phase descriptions and verification requirements.                                                                                                         |

## Validation Strategy

Before replacing the current pipeline:

1. Run both systems on the same input
2. Diff the output profiles
3. Sim both profiles at confirm fidelity
4. If the new system's output is equal or better DPS, ship it
5. If worse, investigate which phase diverged
