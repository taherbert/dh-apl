# Plan: Vengeance DH APL — Genuine First-Principles Build (v2)

## Why v2

The first attempt produced an APL that was structurally a copy of the existing baseline with minor condition tweaks. The trinket logic, ability ordering, and conditional structure were all inherited rather than derived. This plan describes how to build an APL where **every priority decision comes from mathematical modeling and simulation validation**, not from reading existing APLs.

**What we CAN learn from existing APLs:** SimC syntax patterns, available expressions, off-GCD mechanics, how variables work, how hero tree routing works. These are _language_ concerns, not _priority_ concerns.

**What we must NOT inherit:** Ability ordering, conditional thresholds, when to cast what. These must come from the data.

## Branch & Files

- **Branch:** `feature/apl-from-scratch`
- **Output:** `apls/vengeance.simc` (action lines only, uses `input=profile.simc`)
- **Profile:** `apls/profile.simc` (shared character setup — gear, talents, race). Already exists.
- **Multi-file:** APL files start with `input=profile.simc` to include the shared profile. SimC resolves `input=` paths relative to the including file's directory first, then CWD.
- **Pipeline note:** `resolveInputDirectives()` in `profilesets.js` inlines `input=` directives so profileset content is self-contained. Used by both `iterate.js:buildProfilesetContent()` and `profilesets.js:generateProfileset()`. ✅ Done.
- **Previous APL deleted** — start fresh

## Available Data Files

All data is pre-built and ready to read:

| File                                        | Contents                                                       |
| ------------------------------------------- | -------------------------------------------------------------- |
| `data/spells.json`                          | All VDH spells with AP coefficients, costs, cooldowns, effects |
| `data/interactions.json`                    | 266 talent→ability interactions with modifier percentages      |
| `data/cpp-proc-mechanics.json`              | Auto-extracted proc rates, ICDs, constants from C++            |
| `data/talents.json`                         | Full talent tree structure (class/spec/hero)                   |
| `data/ability-report.md`                    | Human-readable ability + talent report                         |
| `reference/vengeance-apl.simc`              | SimC default APL (syntax reference ONLY)                       |
| `reference/wiki/action-list-expressions.md` | Complete expression/condition reference                        |
| `reference/wiki/demon-hunters.md`           | DH-specific expressions (soul_fragments, etc.)                 |

## Available Tools

| Command                                            | Purpose                               |
| -------------------------------------------------- | ------------------------------------- |
| `node src/sim/runner.js apls/vengeance.simc`       | Run sim (3 scenarios: 1T, 5T, 10T)    |
| `node src/sim/iterate.js init apls/vengeance.simc` | Initialize iteration loop             |
| `node src/sim/iterate.js strategic`                | Generate strategic hypotheses         |
| `src/apl/parser.js`                                | Parse/serialize APL (round-trip safe) |
| `src/apl/mutator.js`                               | Programmatic APL mutations            |

---

## Phase 1: Mathematical Modeling (No APL Code)

### 1.1 Effective DPGCD Table

Compute the **effective damage per GCD** for every ability, accounting for talent modifiers that are always active (passive talents in the build). The raw AP coefficients alone are misleading because some abilities stack 3-4 multiplicative modifiers.

**Raw AP coefficients** (from `data/spells.json`):

| Ability           | Raw AP     | School      | Cost    | CD           | Notes                            |
| ----------------- | ---------- | ----------- | ------- | ------------ | -------------------------------- |
| Sigil of Spite    | 6.92       | Chromatic   | 0       | 60s          | Highest raw coefficient          |
| Voidfall Meteor   | 5.4        | Shadowflame | 0       | state-gated  | Anni only                        |
| Fiery Brand       | 4.16       | Fire        | 0       | 60s          | Also applies Fiery Demise window |
| Reaver's Glaive   | 3.45       | Physical    | 0       | state-gated  | AR only, 3 targets chain         |
| Fracture          | 3.105      | Physical    | 0       | 2 charges/6s | 1.035 MH + 2.07 OH               |
| Soul Carver       | 3.09+DoT   | Fire        | 0       | 60s          | +0.67/tick for 3s                |
| Soul Cleave       | 2.08       | Physical    | 35 fury | none         | 8yd cone, reduced >5T            |
| Spirit Bomb       | 2.0        | Fire        | 40 fury | 25s          | Consumes frags, applies Frailty  |
| Explosion of Soul | 1.8        | Fire        | 0       | from set     | 12yd radius, set bonus           |
| Felblade          | 1.23       | Fire        | 0       | 12s          | Generates 15 fury                |
| Meteor Shower     | 0.9        | Shadowflame | 0       | passive      | Anni meteor ticks                |
| Sigil of Flame    | 0.8+DoT    | Fire        | 0       | 30s          | +0.5/tick DoT                    |
| Infernal Strike   | 0.626      | Fire        | 0       | 15s/2ch      | Off-GCD                          |
| Throw Glaive      | 0.49       | Physical    | 25 fury | 9s           | Filler                           |
| Fel Devastation   | 0.411/tick | Fire        | 50 fury | 40s          | Channel ~2s                      |
| Immo Aura initial | 0.33       | Fire        | 0       | 30s/2ch      | +ticks over duration             |

**Modifier stacking by ability** (from `data/interactions.json`):

For the standard AR build, compute total multiplicative modifier per ability. Example for Fracture:

- Keen Edge: +10% Physical
- Tempered Steel: +12% Physical
- Furious: +3% (generator)
- Metamorphosis: +15%/+20% (during Meta)
- Fiery Demise: +15% (during Brand window)
- Reaver's Mark: +7% (debuff)
- Frailty: +3% (debuff, doubled by Soulcrush to +6%)
- Set 2pc: +35%

**Key question to answer:** After stacking modifiers, does the DPGCD ranking change? Specifically:

- Does Fracture (3.105 × 1.10 × 1.12 × 1.03 × 1.35 = ~5.6 effective) outrank some cooldowns?
- Does Spirit Bomb (2.0 × 1.08 × 1.15 × 1.20 = ~3.0 effective during Brand) justify its 40-fury cost?
- How does Soul Cleave (2.08 × 1.50 × 1.12 × 1.10 × 1.03 = ~4.0 effective with Focused Cleave + Tempered Steel + Incisive Blade) compare?

### 1.2 Resource Value Analysis

**What is 1 Fury worth in damage terms?**

Calculate the marginal damage value of spending 1 Fury:

- Soul Cleave: 2.08 AP × modifiers / 35 Fury = X AP per Fury
- Spirit Bomb: 2.0 AP × modifiers / 40 Fury = Y AP per Fury (but also applies Frailty)
- The higher value determines which spender to prefer

**What is 1 Soul Fragment worth?**

A fragment has value through:

- Spirit Bomb: each fragment adds ~0.4 AP base damage (2.0 / 5)
- Soul Cleave: each fragment adds ~0.416 AP damage (2.08 × 0.2 per frag)
- Frailty healing: 3% damage taken returned as healing (6% with Soulcrush)
- Untethered Rage: 10% × (1 + stacks) chance per fragment consumed → haste/damage proc

**Fragment value changes with count:**

- At 1 fragment: Spirit Bomb deals 0.4 AP for 40 fury — terrible
- At 4 fragments: Spirit Bomb deals 1.6 AP for 40 fury — comparable to Soul Cleave per fury
- At 5 fragments: Spirit Bomb deals 2.0 AP for 40 fury — still modest per-fury
- But: Spirit Bomb applies Frailty (+3-6% to ALL damage) — this secondary value is enormous
- The breakpoint is NOT about Spirit Bomb damage but about Frailty uptime value

### 1.3 State Machine Analysis

#### AR State Machine: Art of the Glaive Cycle

```
[IDLE] ──Fracture/SC──→ [STACKING] ──4 stacks──→ [EMPOWERED]
                              ↑                        │
                              │                   Glaive Flurry
                              │                   Rending Strike
                              │                        │
                              └────cycle complete───────┘
```

- **Stack threshold:** 4 (Vengeance)
- **Consumption ICD:** 100ms
- **Empowered abilities:** Rending Strike (enhanced Fracture), Glaive Flurry (enhanced Soul Cleave)
- **Thrill of the Fight:** Triggered on cycle completion, +20% damage, 700ms delay
- **Reaver's Mark:** Applied on cycle completion, +7% dmg taken debuff

**Question to model:** How many GCDs does a full cycle take? If it's ~4 GCDs (2 Fractures + 1 Glaive Flurry + 1 Rending Strike), what's the average DPS of the cycle vs individual ability DPS?

#### Anni State Machine: Voidfall Cycle

```
[IDLE] ──ability cast──→ [BUILDING] ──max stacks──→ [SPENDING]
  ↑        (30% chance)                                  │
  │                                              Fracture/SC
  │                                              consume 1 stack
  │                                              + drop meteor
  │                                                      │
  └──────────all stacks consumed─────────────────────────┘
```

- **Building proc chance:** 30% per Fury-generating ability
- **Building max stacks:** Expires at max (3)
- **Spending:** Each Fracture/Soul Cleave consumes 1 stack, drops 1 Voidfall Meteor (5.4 AP)
- **World Killer:** 3rd meteor is larger (+50% damage)
- **Cannot build while spending is active**

**Question to model:** Expected GCDs between Voidfall cycles? With 30% proc rate, average ~3.3 ability casts to gain 1 stack, ~10 casts to fill 3 stacks. That's ~15s of gameplay per cycle.

#### Fragment Economy State Machine

```
[GENERATING] ──Fracture──→ +2 frags (+3 in Meta)
             ──Fallout───→ +1 frag (100% ST, 60% AoE per tick)
             ──Soul Sigils→ +1 per sigil
             ──Soul Carver→ +3 immediate + ticks
                    │
                    ▼
[POOLING] ──cap check──→ MAX 6 fragments
                    │
                    ▼
[CONSUMING] ──Spirit Bomb──→ consumes up to 5 (applies Frailty)
            ──Soul Cleave──→ consumes up to 2
            ──movement────→ 85% chance per fragment
```

**Key modeling question:** What's the optimal consumption pattern?

- Always SBomb at 4+? Or 3+ during Fiery Demise?
- Is it ever correct to Soul Cleave at 5 fragments instead of waiting for Spirit Bomb CD?
- Fragment overflow waste: if generating 2/cast and cap is 6, waste starts at 5 fragments

### 1.4 GCD Budget Allocation

At 0% haste, 1.5s GCD = 40 GCDs per minute.

**Fixed GCD consumers** (abilities you MUST use on CD for max value):

- Fracture: ~10 GCDs/min (2 charges, 6s recharge each = 10/min)
- Sigil of Flame: ~2 GCDs/min (30s CD, 1 charge)
- Spirit Bomb: ~2.4 GCDs/min (25s CD)
- Felblade: ~5 GCDs/min (12s CD, reliable reset)
- Fiery Brand: ~1 GCD/min (60s CD)
- Soul Carver: ~1 GCD/min (60s CD)
- Fel Devastation: ~1.5 GCDs/min (40s CD, 2s channel)
- Sigil of Spite: ~1 GCD/min (60s CD)
- Immolation Aura: ~2 GCDs/min (30s, 2 charges)

**Total fixed:** ~26 GCDs/min → **14 discretionary GCDs/min**

**Discretionary GCDs go to:** Soul Cleave (fury dump), additional Fractures (fragment gen), Throw Glaive (filler)

**The real question:** Is this allocation correct? Maybe some "fixed" abilities should be delayed or skipped. For example:

- Is Felblade (1.23 AP, 15 fury) worth a GCD over an extra Soul Cleave (2.08 AP × modifiers)?
- Should Immolation Aura without Fallout talent be cast at all?
- Is Sigil of Flame (0.8 AP + DoT) worth a GCD vs just Fracturing more?

### 1.5 Burst Window Modeling

**Fiery Demise window:**

- Duration: ~8s (Fiery Brand DoT)
- GCDs available: ~5 at base haste
- +15% (rank 2: +30%) to ALL Fire damage
- Abilities to stack in window: Spirit Bomb, Soul Carver, Immolation Aura, Sigil of Flame, Fel Devastation
- Question: Is it worth delaying some abilities to align with Brand?

**Metamorphosis window:**

- Duration: 15s (Vengeance)
- GCDs available: ~10
- +15-20% damage to Fracture/SC/SBomb
- Extra fragment generation (+1 per Fracture)
- Question: What's the DPS increase if you pool CDs for Meta?

**AR Thrill of the Fight window:**

- +20% damage during empowered phase
- Duration: Tied to empowered buff duration
- Question: How many GCDs fit inside this window?

---

## Phase 2: Simulation-Driven Priority Discovery

### 2.1 Baseline Permutation Testing

Instead of assuming an ordering, **test orderings empirically** using profilesets.

Create a minimal "skeleton" APL with just the scaffolding (auto_attack, disrupt, off-GCD abilities, hero tree routing) and then use profilesets to test different orderings of the core rotation:

**Test 1: Cooldown ordering**

- Which long CD should fire first when multiple are available?
- Test permutations of: Fiery Brand, Soul Carver, Sigil of Spite, Fel Devastation, Metamorphosis

**Test 2: Builder vs spender priority**

- Should Fracture always be above Soul Cleave?
- At what Fury level should you prefer Soul Cleave over Fracture?
- Does this change in AoE?

**Test 3: Spirit Bomb fragment thresholds**

- Test Spirit Bomb at 2, 3, 4, 5 fragments in ST
- Test at 2, 3, 4 fragments in AoE
- Does the threshold change during Fiery Demise?

**Test 4: Felblade value**

- Compare APL with Felblade at various priority positions
- Is it a net positive at all, or does it displace higher-value GCDs?

**Test 5: Fragment pooling vs spending**

- Should you delay Fracture when at 5 fragments?
- Is it ever correct to let fragments expire rather than sub-optimally consume them?

### 2.2 AR-Specific Ordering Discovery

Test AR cycle sequencing:

- Does it matter if you Fracture or Soul Cleave during Glaive Flurry?
- Should you use cooldowns (Brand, Soul Carver) inside or outside AR windows?
- What's the optimal placement of Spirit Bomb relative to the AR cycle?

### 2.3 Anni-Specific Ordering Discovery

Test Voidfall interaction:

- Should you hold Spirit Bomb for spending phase alignment?
- Does Fiery Brand timing matter relative to meteor drops?
- What's the priority of Soul Cleave vs Fracture during spending phase?

---

## Phase 3: APL Construction

Build the APL section by section, validating each addition with a sim run.

### 3.1 Skeleton (syntax/structure only)

Create `apls/vengeance.simc` with:

1. `input=profile.simc` — includes shared character profile (gear, talents, race)
2. `actions.precombat` — snapshot_stats, pre-pull abilities
3. `actions` (default) — variables, auto_attack, disrupt, off-GCD weaving, hero tree routing
4. `actions.externals` — power_infusion
5. `actions.ar` — empty, to be filled
6. `actions.anni` — empty, to be filled

**Syntax patterns to use** (learned from reference, NOT priority):

- `variable,name=X,value=expr` for computed state
- `use_off_gcd=1` for Infernal Strike, Demon Spikes, Meta, Potion
- `run_action_list,name=ar,if=hero_tree.aldrachi_reaver` (mutually exclusive branches)
- `call_action_list,name=externals,if=condition` (optional sub-routines that fall through)
- `buff.X.up`, `dot.X.ticking`, `soul_fragments>=N`, `cooldown.X.ready`
- `trinket.1.has_use_buff`, `trinket.1.has_buff.agility`, etc.

See CLAUDE.md "Action list delegation" for full `run_action_list` vs `call_action_list` semantics.

### 3.2 Variable Design

Design variables based on Phase 1 analysis. These should encode **decision boundaries** identified by the math, not copy-paste from baseline. Examples of genuinely derived variables:

- `fury_value_sc` — effective damage of next Soul Cleave per fury
- `fury_value_sbomb` — effective damage of next Spirit Bomb per fury (accounting for fragment count)
- `frailty_needed` — whether Frailty is down or expiring soon (justifies lower-threshold SBomb)
- `ar_cycle_ready` — whether we should be building toward or spending AR empowerments
- `fragment_waste_risk` — whether next Fracture would overflow fragments

### 3.3 Priority Lists

Fill in AR and Anni lists **using the ordering discovered in Phase 2 simulations**, not assumed ordering. Each action should have a comment citing which test/analysis justified its position.

### 3.4 Trinket Handling

For trinkets, the standard detection pattern IS the right approach (it's SimC infrastructure, not a priority decision). Use the standard `trinket_N_buffs` variable and `use_item` pattern. This is one area where reuse is correct — it's SimC plumbing.

---

## Phase 4: Validation

### 4.1 Sim Comparison

Run against baseline across all 3 scenarios. Record:

- DPS delta
- Ability cast counts (every ability should cast if talented)
- Buff uptimes (Demon Spikes, Fiery Brand, Metamorphosis, Thrill of Fight)
- Fragment waste (soul_fragment_expire, soul_fragment_overflow)
- Fury overcap rate
- GCD efficiency

### 4.2 Diagnostic Checks

- Any ability with 0 casts that should be casting → syntax error
- Demon Spikes uptime <80% → defensive gap
- Fragment waste >5% → pooling logic issue
- Fury overcap >10% → spending logic issue

### 4.3 A/B Variant Testing

For any decision that was close in Phase 2 testing, create A/B variants and run with higher iteration counts to confirm the winner.

---

## Phase 5: Iteration Handoff

```bash
node src/sim/iterate.js init apls/vengeance.simc
node src/sim/iterate.js strategic
```

The iteration system generates hypotheses and tests them automatically. After the from-scratch build validates, hand off to the iteration loop for fine-tuning.

---

## Key Principles

1. **Every ordering decision must have a data citation.** "Fracture above Soul Cleave because effective DPGCD is X vs Y" — not "Fracture above Soul Cleave because the baseline has it that way."

2. **Test, don't assume.** If two orderings seem close, run a profileset comparison. SimC is the ground truth, not theory.

3. **Question conventional wisdom.** Maybe Felblade isn't worth a GCD. Maybe Spirit Bomb at 3 fragments is better than 4. Maybe Sigil of Flame should be much lower priority. The data will tell us.

4. **Model interactions, not abilities in isolation.** A 3.0 DPGCD ability that enables a +15% damage window for 5 subsequent GCDs is worth more than a 4.0 DPGCD ability in isolation.

5. **Fragment and Fury flow are first-class concerns.** The APL is fundamentally a resource management system. Abilities that generate resources have secondary value beyond their direct damage.

---

## SimC Expression Quick Reference

Key expressions for VDH APL conditions:

```
# Resources
fury, fury.deficit, fury.pct
soul_fragments, soul_fragments.total, soul_fragments.inactive

# Buffs
buff.metamorphosis.up, buff.metamorphosis.remains
buff.demon_spikes.up
buff.rending_strike.up, buff.glaive_flurry.up
buff.voidfall_building.stack, buff.voidfall_spending.stack
buff.thrill_of_the_fight.up
buff.art_of_the_glaive.stack

# Debuffs
dot.fiery_brand.ticking, dot.fiery_brand.remains

# Cooldowns
cooldown.X.ready, cooldown.X.remains
cooldown.X.charges, cooldown.X.charges_fractional
cooldown.X.full_recharge_time

# Targets
spell_targets.spirit_bomb, active_enemies

# Talents
talent.X, talent.X.enabled
hero_tree.aldrachi_reaver, hero_tree.annihilator
apex.1, apex.2 (apex talent ranks)

# Trinkets
trinket.1.has_use_buff, trinket.1.has_buff.agility
trinket.1.cooldown.duration, trinket.1.cooldown.remains
trinket.1.is.item_name

# Previous action
prev_gcd.1.ability_name

# Misc
time, health.pct
target.debuff.casting.react
use_off_gcd=1 (action modifier, not expression)
```

## Estimated Sim Runs

- Phase 2 profileset tests: ~10-15 runs (quick mode, 100 iterations)
- Phase 4 validation: 3 runs (1000 iterations each)
- Phase 5 iteration: ~5-10 runs
- **Total: ~20-30 sim runs**

## Known Gaps

- **`archetypes.js` is hardcoded seed data** — descriptions, cooldowns, and mechanic details are hand-curated with no automated import from `spells.json`. The Spirit Bomb CD error (45s vs actual 25s) was an example. Future: consider validating archetype data against spell data, or importing key values programmatically.
- ~~**`iterate.js` needs `input=` resolver**~~ — ✅ Done. `resolveInputDirectives()` added to `profilesets.js`, used by both `buildProfilesetContent()` and `generateProfileset()`.
