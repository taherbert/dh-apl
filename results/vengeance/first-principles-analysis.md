# First-Principles VDH Theorycrafting Analysis

Generated: 2026-02-12
Spec: Vengeance Demon Hunter (Midnight)
APL Baseline: vengeance.simc @ 84156ca6

## Motivation

The current APL has been iteratively optimized to a local optimum (+0.003% cumulative from last 4 structural changes). The biggest gain came from fixing a structural bug (+2.73% empowered cycle ordering), not from threshold tuning. This analysis derives optimal behavior from raw mechanics and compares it to the current APL, looking for structural gaps that iteration wouldn't find.

## Critical Mechanic Verifications (SimC C++ Source)

### Untethered Rage Proc Mechanic

Source: `sc_demon_hunter.cpp:2526-2547`

```cpp
bool trigger_untethered_rage(const int souls_consumed) {
    double chance_to_proc = souls_consumed * 0.0075 * pow(1.35, buff.seething_anger->stack());
    if (rng().roll(chance_to_proc)) {
        buff.seething_anger->expire();
        buff.untethered_rage->trigger();
        return true;
    }
    if (!buff.untethered_rage->up() && talent.untethered_rage_3->ok())
        buff.seething_anger->trigger();
    return false;
}
```

**Key finding:** Single roll per cast, probability scaled by fragments consumed. NOT per-fragment individually.

| Cast | Fragments | Base Chance | At SA=5 | At SA=10 |
|------|-----------|-------------|---------|----------|
| SBomb@5 | 5 | 3.75% | 15.2% | 61.4% |
| SBomb@4 | 4 | 3.00% | 12.1% | 49.1% |
| SBomb@3 | 3 | 2.25% | 9.1% | 36.9% |
| Soul Cleave | 2 | 1.50% | 6.1% | 24.6% |

**Fishing analysis (proc attempts per GCD):**
- SBomb@5 cycle: ~3.5 GCDs per attempt → 0.0375/3.5 = 0.0107 chance/GCD
- SBomb@3 + SC weaving: ~3 GCDs for 2 attempts → (0.0225+0.015)/3 = 0.0125 chance/GCD
- Fishing wins by +17% proc rate per GCD at cost of lower damage quality

**Conclusion:** The UR fishing sub-list's approach of lowering SBomb threshold + Soul Cleave weaving is mechanically correct. More casts per unit time beats higher per-cast chance.

### Fallout Fragment Generation

Source: `sc_demon_hunter.cpp:4781-4790`

```cpp
bool spawn_fallout_soul = false;
if (talent.vengeance.fallout->ok()) {
    spawn_fallout_soul = s->n_targets == 1 || rng().roll(0.60);
}
if (initial && spawn_fallout_soul)
    spawn_soul_fragment(proc.soul_fragment_from_fallout, soul_fragment::LESSER, 1);
```

**Key finding:** One fragment per ImmAura tick maximum (gated by `initial`). ST: 100% proc rate. AoE: 60% chance (not per-target). The `initial` flag prevents multiple fragments from multi-target hits in the same tick.

**Implication:** Fallout's fragment value is constant regardless of target count. In AoE, it's actually LESS reliable (60% vs 100%). ImmAura's value in AoE comes from damage, not fragment acceleration.

---

## Theory 1: Multiplier Window Density

### Premise

Fire damage under Fiery Demise (+15%) during Meta (+20%) gets 1.38x compound amplification. The DPS-optimal behavior is to maximize fire-school damage concentration inside overlapping Brand+Meta windows.

### Mechanical Derivation

**Fire-school CDs and their natural alignment:**

| Ability | AP Coeff | School | CD | Brand Alignment |
|---------|----------|--------|-----|-----------------|
| Soul Carver | 2.08 | Fire | 60s | Natural (60:60) |
| Fel Devastation | 1.54 | Fire | 40s | Every 120s only |
| SBomb | ~2.0@5 | Fire | ~25s | On-demand |
| Sigil of Spite | 6.92 | Chaos | 60s | No benefit (Chaos school) |

**Compound amplification math:**
- Base fire damage during Brand+Meta: `damage * 1.15 * 1.20 = damage * 1.38`
- A 2.08 AP Soul Carver during Brand+Meta: `2.08 * 1.38 = 2.87 AP` (+0.79 AP gained)
- A 1.54 AP FelDev during Brand+Meta: `1.54 * 1.38 = 2.13 AP` (+0.59 AP gained)
- Frailty (+3-6% damage taken) applied BEFORE fire CDs: adds another `0.03-0.06 * 2.87 = 0.086-0.172 AP` per Soul Carver

**Optimal sequencing inside a Brand window:**
1. SBomb@3+ (applies Frailty debuff — amplifies all subsequent damage)
2. ImmAura (Charred Flesh extends Brand, Fallout generates fragments for next SBomb)
3. Soul Carver (2.08 AP instant fire + 4-6 fragments for SBomb chain)
4. FelDev (1.54 AP fire channel, if available and Brand has 4+ seconds remaining)
5. SBomb again (consumes Soul Carver fragments under Brand amp)

### Gap Assessment vs Current APL

**AR Brand Window (`ar_brand_window`):**
```
spirit_bomb,if=soul_fragments>=3&!debuff.frailty.up       ← Frailty-first: CORRECT
immolation_aura,if=talent.charred_flesh&!buff...           ← Charred Flesh: CORRECT
soul_carver                                                ← Fire CD: CORRECT
sigil_of_spite,if=soul_fragments<=3                        ← Fragment gen: CORRECT
fel_devastation,if=!buff.rending_strike.up&!...            ← No Brand duration check
immolation_aura,if=!talent.charred_flesh                   ← Fallback: CORRECT
```

**Gaps identified:**
1. **FelDev has no Brand duration check.** A 2s FelDev channel starting at 2s remaining Brand wastes most of the channel outside the window. Should gate on `dot.fiery_brand.remains>4`.
2. **No SBomb follow-up after Soul Carver.** Soul Carver generates 4-6 fragments, but the Brand window list doesn't include a second SBomb to consume them under Brand amp. Control falls through to the main list where `spirit_bomb,if=soul_fragments>=3&variable.fiery_demise_active` catches it — but only if 3+ frags are ready AND FD is still active. This works but is implicit, not guaranteed.

**AR Cooldowns Brand sync:**
```
fiery_brand,if=talent.fiery_demise&(cooldown.fiery_brand.charges>=2|
    (!dot.fiery_brand.ticking&(cooldown.soul_carver.remains<6|
    cooldown.fel_devastation.remains<6|cooldown.sigil_of_spite.remains<6)))
```

This sync is solid: Brand fires when a fire CD is ready within 6s. The `charges>=2` clause prevents wasting charges. However, **Sigil of Spite is Chaos school** — syncing Brand to Spite readiness provides no fire amp benefit. The Spite entry should be removed from the Brand sync condition.

**Anni Brand:** `fiery_brand,if=talent.fiery_demise&!dot.fiery_brand.ticking` — no CD sync at all. Brand fires whenever it's available. This is simpler but misses the density benefit.

### Testable Predictions

1. Adding `dot.fiery_brand.remains>4` gate to FelDev in Brand window should be neutral-to-positive
2. Removing Spite from AR Brand sync condition should be neutral (Spite is Chaos school)
3. Adding Brand+fire CD sync to Anni should be positive for FD builds

---

## Theory 2: Meta GCD Budget Allocation

### Premise

Meta is a finite window (~10-13 GCDs with haste). Each GCD spent on a low-DPGCD ability during Meta costs more than outside Meta because of the +20% amplification on everything.

### Mechanical Derivation

**Meta GCD values (AP per GCD-equivalent):**

| Ability | GCD Cost | Raw AP | Meta AP (×1.20) | Per-GCD |
|---------|----------|--------|-----------------|---------|
| Soul Carver | 1.0 | 2.08 | 2.50 | 2.50 |
| SBomb@5 | 1.0 | 2.00 | 2.40 | 2.40 |
| SBomb@4 | 1.0 | 1.60 | 1.92 | 1.92 |
| Fracture | 1.0 | 1.035 | 1.24 | 1.24 |
| FelDev | ~3.5 | 1.54 | 1.85 | 0.53 |
| Felblade | 0.5 | 1.00 | 1.20 | 2.40 |
| Soul Cleave | 1.0 | 1.29 | 1.55 | 1.55 |

**FelDev during Meta is 0.53 AP/GCD** — the worst on-GCD ability. During 3.5 GCDs of FelDev channel, the alternative Fracture+SBomb rotation produces:
- 2.5 Fracture (3.10 AP) + 1 SBomb@4 (1.92 AP) = 5.02 AP
- FelDev = 1.85 AP
- **Opportunity cost: -3.17 AP per FelDev during Meta**

**But:** FelDev is Fire school (Brand amp if Brand is ticking during Meta). FelDev+Brand+Meta: `1.54 * 1.38 = 2.13 AP` vs Fracture+SBomb@4 combo at 5.02 AP. Still -2.89 AP. FelDev is never worth casting during Meta from a pure DPGCD standpoint.

**Exception — Anni Meteoric Rise:** FelDev generates 3 fragments. During Voidfall spending when fragment-starved, those fragments enable SBomb@3+ which triggers meteors. The meteor damage (not modeled in simple DPGCD) can justify FelDev.

### Gap Assessment vs Current APL

**AR:** FelDev is in `ar_cooldowns` which is called AFTER `ar_empowered` and `ar_brand_window`. No explicit Meta gate. If Meta is up but empowered cycle is complete and Brand is not ticking, FelDev fires during Meta.

```
# ar_cooldowns (called during Meta if no empowered/brand active)
fel_devastation,if=!buff.rending_strike.up&!buff.glaive_flurry.up
```

**Anni:** FelDev gated by `!buff.voidfall_spending.up` but NOT by Meta.

```
# anni main list
fel_devastation,if=!buff.voidfall_spending.up
```

**Gap:** Neither hero tree gates FelDev by Meta. This is the second-largest theoretical DPGCD loss after the (already fixed) empowered cycle ordering.

### Testable Predictions

1. Gating FelDev with `!buff.metamorphosis.up` (cast before/after Meta, not during) should improve Meta GCD efficiency
2. Exception: Allow FelDev during Meta if Brand is ticking AND fragments < threshold (fire amp + fragment gen justifies the channel)
3. For Anni: FelDev during Voidfall spending at stack=3 with low frags is already gated correctly in `anni_voidfall`

---

## Theory 3: Fragment Economy — Dual-Resource Coupling

### Premise

Fracture is the sole dual-resource generator (Fury + Fragments). This coupling creates a single pipeline with two outputs. The binding constraint is whichever resource runs dry first.

### Mechanical Derivation

**Resource generation per Fracture cast:**

| Condition | Fury | Fragments | SBomb needs |
|-----------|------|-----------|-------------|
| Normal | 25 | 2 | 40 Fury + 5 frags |
| Meta | 40 | 3 | 40 Fury + 4 frags |

**Bottleneck analysis:**
- Normal: Need 2.5 Fractures for 5 frags, 1.6 for 40 Fury → **Fragment-bottlenecked**
- Meta: Need 1.33 Fractures for 4 frags, 1.0 for 40 Fury → **Fragment-bottlenecked** (barely)

**Fragment value derivation:**
Each fragment saved from waste = 1 fewer Fracture GCD needed. That saved GCD can be spent on another SBomb cycle. True value per fragment:
- Direct: contributes 0.4 AP per frag to SBomb damage (at 5 frags: 2.0 AP total)
- Indirect: saves 0.5 Fracture GCDs (1 frag / 2 per Fracture)
- Pipeline acceleration: 0.5 GCDs × average DPGCD (~1.5 AP/GCD) = 0.75 AP
- **Total per-fragment value: ~0.4 + 0.75 = 1.15 AP**

**Fragment overcap cost:**
- Soul Carver generates 4-6 fragments over its DoT. At 3+ existing frags, 1-3 will overcap.
- Overcap of 2 fragments = 2.3 AP lost
- Soul Carver direct damage = 2.08 AP (or 2.39 AP with Brand amp)
- **At 4+ existing frags outside Brand:** Net loss from overcap exceeds Soul Carver's damage

**Sigil of Spite generates ~3 fragments.** At 4+ existing frags, overcap loses ~1.15 AP per wasted frag.

### Gap Assessment vs Current APL

**AR:**
```
# ar_cooldowns
sigil_of_spite,if=soul_fragments<=3                        ← Fragment gate: CORRECT
soul_carver,if=!talent.fiery_demise|variable.fiery_demise_active  ← No fragment gate outside Brand!
```

Soul Carver has no fragment gate when fired outside Brand (when FD is not talented or Brand not ticking). At 4-5 existing fragments, Soul Carver's DoT fragments overcap.

**Anni:**
```
sigil_of_spite,if=soul_fragments<=2+talent.soul_sigils     ← Fragment gate: CORRECT
soul_carver,if=talent.soul_carver&soul_fragments<=3        ← Fragment gate: CORRECT
```

Anni has proper fragment gating on Soul Carver (≤3). AR does not.

**AR Brand Window:**
```
soul_carver                                                ← No fragment gate (intentional?)
sigil_of_spite,if=soul_fragments<=3
```

During Brand, Soul Carver fires unconditionally. This is justified: 2.08 × 1.15 = 2.39 AP direct damage under Brand amp exceeds overcap cost in most scenarios.

**Fracture charge management:**
```
# AR main list
fracture,if=cooldown.fracture.full_recharge_time<gcd.max&soul_fragments<variable.spb_threshold&
    (!variable.fiery_demise_active|active_enemies>=3)
```

This prevents charge cap when frags < threshold. But the FD exception (`!variable.fiery_demise_active` in ST) means during Brand windows, Fracture charges can cap while waiting for SBomb@3 opportunities. The theory says Fracture charges should NEVER cap — each wasted charge is ~1.0 AP lost.

### Testable Predictions

1. Adding `soul_fragments<=3` gate to AR Soul Carver outside Brand should reduce overcap waste
2. Removing the FD exception from Fracture charge management (or making it less restrictive) may improve filler efficiency
3. These are small-magnitude changes (~0.1-0.3% expected)

---

## Theory 4: Cooldown Cadence — Natural Alignment

### Premise

Cooldown timings create a natural rhythm. Understanding which CDs naturally converge reveals optimal hold/free-run decisions.

### Mechanical Derivation

**Cooldown timeline (first 120s):**

```
t=0s:   Meta + Brand + Soul Carver + Spite + FelDev + SBomb  ← FULL BURST
t=25s:  SBomb
t=40s:  FelDev
t=48s:  Brand (DiF charge 2)
t=50s:  SBomb
t=60s:  Soul Carver + Spite + Brand (if charge held)         ← MINI BURST
t=75s:  SBomb
t=80s:  FelDev
t=100s: SBomb
t=108s: Brand (DiF charge)
t=120s: Meta + Soul Carver + Spite + FelDev + Brand           ← FULL BURST
```

**Key insights:**

1. **FelDev (40s)** naturally aligns with Brand+Meta only at t=0 and t=120. Holding FelDev from t=40 to t=48 (for Brand) wastes 8s of CD time. Over 5 minutes: ~1 lost cast = 1.54 AP.

2. **Soul Carver (60s)** naturally aligns with Brand. Holding up to 6s costs zero casts on a 60s CD. Always sync.

3. **Meta (120s)** should never be delayed. 1s of Meta delay = loss of 0.20 × ~6 AP/s = 1.2 AP. Brand is naturally available (2 charges via DiF, recharge ~48s).

4. **Brand charge management:** With 2 charges (DiF), Brand at t=0 and t=48 means a charge is available at t=96-108 for Meta at t=120. No explicit reservation needed IF Brand is used on CD.

5. **Sigil of Spite** is Chaos school (no Brand synergy). Its value is pure damage + fragment generation. Should free-run on CD with only a fragment gate.

### Gap Assessment vs Current APL

**Brand sync (AR):** Brand fires when `charges>=2 OR fire CD ready within 6s`. This includes Spite in the sync condition — Spite is Chaos school and doesn't benefit from Brand's fire amp. Minor inefficiency: Brand might be held for Spite readiness when it should fire independently.

**Meta:** Both AR and Anni fire Meta on CD with no delay. CORRECT.

**FelDev hold:** No hold logic exists. FelDev fires on CD regardless of Brand timing. This matches the theory's recommendation (holding FelDev for Brand loses more than it gains). CORRECT.

**Brand charge reservation for Meta:** No explicit reservation. The `charges>=2` clause prevents double-stacking Brand when both charges are available, but doesn't reserve a charge for Meta. In practice, the 48s recharge means a charge is usually available by Meta time.

### Testable Predictions

1. Removing Spite from AR Brand sync condition is neutral-to-positive (Spite is Chaos school)
2. Brand charge reservation for Meta (hold 1 charge within 15s of Meta) may improve convergence density
3. These are likely sub-0.1% changes — at noise threshold

---

## Theory 5: Hero State Machine Priority Integration

### Premise

AR's empowered cycle and Anni's Voidfall state machine are overlaid on the base rotation. When state machine obligations conflict with burst window priorities, which takes precedence?

### AR: Empowered Cycle vs Brand

Current APL calls `ar_empowered` BEFORE `ar_brand_window`. Analysis:

- Empowered abilities (Fracture/Soul Cleave) are Physical school — no Fiery Demise fire amp
- Completing the cycle applies Reaver's Mark (7-14% damage amp) which amplifies ALL subsequent damage
- 3-GCD empowered cycle (~4.5s) out of 10-12s Brand window leaves 5.5-7.5s for fire CDs

**Brand-first alternative:**
- 3 empowered Physical GCDs inside Brand waste ~4.5s of Brand amp doing Physical damage
- But Reaver's Mark applied AFTER Brand means fire CDs get RM amp too
- Net: empowered-first gets RM amp on fire CDs, Brand-first wastes Brand time on Physical

**Verdict:** Empowered-first is correct. Confirmed by +2.73% fix.

### Anni: Voidfall Spending Priority

Voidfall spending (3 stacks → triple meteor via SBomb) is the highest-burst event for Anni.

Current APL correctly gates:
- FelDev blocked during spending (channel delays meteor triggers)
- Meta blocked during spending (Mass Acceleration can't grant stacks when already spending)
- Meta blocked at building=2 (natural completion → double burst via Mass Acceleration)
- FelDev ALLOWED during spending at stack=3 when fragment-starved (Meteoric Rise frags → SBomb → meteor)

**Flaw check:** During spending at stack<3, only Soul Cleave fires as a spender (triggers smaller meteors). But Fracture is also gated by `!buff.voidfall_spending.up`:
```
fracture,if=!buff.voidfall_spending.up                    ← Blocks Fracture during spending
```

An ungated `fracture` appears at the bottom as a safety net:
```
fracture                                                   ← Safety net during spending
```

**Potential issue:** During spending at stack 1-2, Soul Cleave triggers meteors. But what if Fury is too low for Soul Cleave? The safety-net Fracture generates frags+Fury, but it's at the very bottom of the priority list, after Felblade/ImmAura/Sigil of Flame. Those fillers don't generate fragments for the next SBomb. The spending phase could stall if Fury generation is delayed by filler priorities.

### Gap Assessment

1. **AR empowered ordering:** CORRECT — confirmed by +2.73% test
2. **Anni Voidfall spending:** Mostly correct but potential Fury starvation during spending
3. **Anni Fracture during spending:** Safety-net Fracture is too low priority — could move higher during spending specifically

### Testable Predictions

1. Moving Fracture higher in priority during Voidfall spending (fury<40 condition) may prevent spending phase stalls
2. Expected magnitude: small (~0.05-0.15%) — spending phases are short and rare events

---

## Theory 6: The Filler Problem

### Premise

~60% of fight time is outside burst windows. The filler rotation's efficiency determines the baseline that burst windows improve upon.

### Mechanical Derivation

**On-GCD filler DPGCD hierarchy (including resource value):**

| Rank | Ability | Direct AP | Resource Value | True DPGCD |
|------|---------|-----------|----------------|-----------|
| 1 | Fracture | 1.035 | +25 Fury, +2 frags (~2.30 AP) | ~3.34 |
| 2 | SBomb@5 | 2.00 | consumes 5 frags | ~2.00 |
| 3 | Soul Cleave | 1.29 | consumes 2 frags (-2.30 AP) | ~-1.01 (raw) |
| 4 | Felblade | 1.00 | +15 Fury (0.5 GCD) | ~4.00/GCD |
| 5 | Sigil of Flame | 0.792 | +25 Fury + DoT | ~1.50 |
| 6 | Throw Glaive | 0.60-0.73 | nothing | ~0.67 |

**Critical insight on Felblade:** At 0.5s GCD, Felblade is 4.0 AP/GCD-second — the most efficient filler. It's currently ranked below Fracture and SBomb but its GCD efficiency is exceptional.

**Soul Cleave value analysis:**
Soul Cleave consumes 2 fragments that could fuel SBomb. But if fragments are at cap and SBomb is on CD, those fragments are going to waste anyway. Soul Cleave as overcap prevention:
- 2 frags wasted = 2.30 AP lost
- Soul Cleave = 1.29 AP gained + prevents overcap
- Net vs letting frags cap: +3.59 AP (cast SC) vs -2.30 AP (waste frags)

Soul Cleave should ONLY fire as an overcap valve when SBomb is on CD and frags are at risk.

### Gap Assessment vs Current APL

**AR filler ordering:**
```
fracture,if=debuff.reavers_mark.up&active_enemies=1&...   ← RM feed: specialized
fracture,if=cooldown.fracture.full_recharge_time<gcd.max&... ← Charge cap prevention
spirit_bomb,if=soul_fragments>=3&variable.fiery_demise_active ← FD SBomb@3
spirit_bomb,if=soul_fragments>=variable.spb_threshold       ← Standard SBomb@5/4
fracture                                                     ← General Fracture
felblade                                                     ← After Fracture!
immolation_aura,if=talent.fallout                           ← Fallout ImmAura
sigil_of_flame                                              ← SoF
soul_cleave                                                 ← Overcap valve
```

**Issue 1:** Felblade is ranked BELOW ungated Fracture. Felblade at 0.5 GCD is 4.0 AP/GCD vs Fracture at ~3.34 AP/GCD. But Fracture generates fragments that feed SBomb, so its pipeline value exceeds its raw DPGCD. This ordering is likely correct — Fracture's fragment generation enables SBomb which is the real damage dealer.

**Issue 2:** Soul Cleave is correctly at the bottom as an overcap valve. CORRECT.

**Issue 3:** ImmAura is listed in fillers (`actions.fillers`) and also inline in the main list. In the main AR list, ImmAura only appears conditionally (`talent.fallout`). But ImmAura should fire on CD regardless of Fallout for its Fury generation (~38-47 Fury total). The fillers list does have `immolation_aura` unconditionally, so this works — but only after ALL main list abilities are exhausted.

### Testable Predictions

1. Moving ImmAura higher in the filler section (above Sigil of Flame) may improve Fury generation uptime
2. Fracture > Felblade ordering is likely correct due to fragment pipeline value — don't change
3. These are micro-optimizations at noise threshold

---

## Theory 7: Untethered Rage — Structural vs Fishing Value

### Premise

UR's value comes from two sources: the proc itself (10s free Meta ≈ 24 AP) and the fishing behavior that changes Meta GCD allocation. The optimization history showed UR fishing's value was from threshold=4 during Meta, but the fishing sub-list also has independent value.

### Mechanical Derivation (from C++ source verification)

**Proc mechanic confirmed:** `chance = souls_consumed * 0.0075 * pow(1.35, SA_stacks)`

**Seething Anger BLP:** Each failed proc attempt during Meta adds 1 SA stack (if UR3 talented). With ~6-8 SBomb/SC casts during a 10-13 GCD Meta, SA reaches 6-8 stacks by fishing window.

**Fishing window math (last 6s of Meta, ~4 GCDs):**

| Strategy | Casts | Proc Attempts | Total Chance (SA=6) | Damage Loss |
|----------|-------|---------------|---------------------|-------------|
| Normal rotation | 1 SBomb@5 + 2 Fracture | 1 | 14.3% | 0 |
| Fish: SBomb@3 + SC + Fracture×2 | 2 | 15.3% | ~1.5 AP |
| Fish: SBomb@3 + SC + SBomb@3 + Frac | 3 | 19.3% | ~3.0 AP |

At SA=6, fishing adds ~5% absolute proc chance at cost of 1.5-3.0 AP in rotation quality.

Expected value of UR proc: 10s of Meta ≈ 10 × 6 AP/s × 0.20 = 12 AP (the +20% amp on existing damage). Actual value is higher because Mass Acceleration (Anni) or empowered cycle (AR) can trigger during UR Meta.

**Net fishing EV at SA=6:** +5% × 12 AP - 3.0 AP = -2.4 AP (marginal)
**Net fishing EV at SA=8:** +12% × 12 AP - 3.0 AP = -1.56 AP (marginal)
**Net fishing EV at SA=10:** +24.5% × 12 AP - 3.0 AP = -0.06 AP (breakeven)

**Conclusion:** Fishing is borderline. It becomes positive only at very high SA stacks (10+). The existing 6s fishing window may be too early — SA hasn't accumulated enough. The historical shortening from 8s → 6s was correct directionally.

### Gap Assessment vs Current APL

**Current UR fishing sub-list:**
```
spirit_bomb,if=buff.seething_anger.up&soul_fragments>=3    ← SA-gated SBomb@3
spirit_bomb,if=soul_fragments>=4                            ← SBomb@4 fallback
sigil_of_spite,if=soul_fragments<=2                        ← Fragment gen
soul_carver,if=soul_fragments<=2                           ← Fragment gen
fracture                                                    ← Filler
soul_cleave,if=soul_fragments>=1                           ← Proc attempt via SC
```

**The fishing window gate:**
```
variable,name=ur_fishing,value=talent.untethered_rage&buff.metamorphosis.up&
    buff.metamorphosis.remains<6&!buff.untethered_rage.up
```

**Issues:**
1. The first SBomb line requires `buff.seething_anger.up` — this is correct as a minimum SA>0 check
2. SBomb@4 fallback fires at 4 frags without SA check — this is fine, 4 frags is efficient regardless
3. No SA STACK threshold. Theory predicts fishing is only positive at SA≥10. Below that, the damage loss exceeds the proc EV. Adding `buff.seething_anger.stack>=8` as a minimum would filter out low-value fishing windows.
4. Soul Carver fires during fishing for fragment gen but also generates its OWN proc attempt (triggers `trigger_untethered_rage`). This is good — double value.

### Testable Predictions

1. Adding SA stack minimum (≥8) to fishing entry condition should filter unprofitable fishing
2. If SA<8 at 6s remaining, normal rotation is better — just cast SBomb@5 normally
3. Expected magnitude: ~0.05-0.10% — fishing is already a rare event within Meta windows

---

## Summary: Gap Prioritization

### High Priority (Largest Expected Impact)

| # | Theory | Gap | Expected Impact | Risk |
|---|--------|-----|-----------------|------|
| 1 | T2: Meta GCD | FelDev fires during Meta without gate | -3.17 AP per occurrence | May hurt FD builds where Brand+Meta overlap |
| 2 | T3: Fragment Economy | AR Soul Carver has no fragment gate outside Brand | ~-2.3 AP per overcap event | May delay SC too long, losing a cast |
| 3 | T1: Multiplier Density | Spite in AR Brand sync wastes Brand charges | ~0.5 AP per misaligned Brand | Low risk — condition removal only |

### Medium Priority (Moderate Expected Impact)

| # | Theory | Gap | Expected Impact | Risk |
|---|--------|-----|-----------------|------|
| 4 | T1: Multiplier Density | FelDev in Brand window has no duration check | ~0.5 AP per clipped channel | May delay FelDev, losing a cast |
| 5 | T5: State Machine | Anni Fracture too low priority during spending | Spending stall prevention | May interfere with meteor sequencing |
| 6 | T7: UR Fishing | No SA stack minimum on fishing entry | ~0.1 AP per low-SA fishing | May miss rare high-value fishing windows |

### Low Priority (At Noise Threshold)

| # | Theory | Gap | Expected Impact | Risk |
|---|--------|-----|-----------------|------|
| 7 | T3: Fragment Economy | Fracture charge cap during FD Brand windows | ~0.1 AP per cap event | May cause premature SBomb |
| 8 | T4: CD Cadence | Brand charge reservation for Meta | Sub-0.1% | Over-constraints rotation |
| 9 | T6: Filler Problem | ImmAura priority in non-Fallout builds | Sub-0.1% | Current fallthrough works |

### Matches (APL Already Optimal)

- **T1:** Frailty-first sequencing in Brand window ✓
- **T1:** Charred Flesh ImmAura timing in Brand window ✓
- **T4:** Meta never delayed ✓
- **T4:** FelDev free-runs on CD (not held for Brand) ✓
- **T5:** AR empowered cycle ordering ✓ (fixed in +2.73% patch)
- **T5:** Anni Voidfall spending blocks FelDev and Meta ✓
- **T5:** Anni Meta gated by building<2 ✓
- **T6:** Soul Cleave as overcap valve ✓
- **T6:** Fracture > Felblade ordering ✓ (pipeline value)
- **T7:** UR fishing sub-list approach (more casts per GCD) ✓
- **T7:** 6s fishing window (shortened from 8s) ✓

## Cross-Reference with Optimization History

Before testing any candidate, verify against rejected hypotheses:

- **FelDev removal from Voidfall sub-list:** REJECTED (-3.16%). Theory 2 proposes gating by Meta, not removal. Different change.
- **SBomb threshold tuning (5→4 outside Meta):** REJECTED. Theory 3 proposes fragment gates on generators, not threshold changes.
- **AoE SBomb@3:** REJECTED. No theory proposes this change.
- **UR fishing 8s→6s:** ACCEPTED (+0.035%). Theory 7 builds on this by adding SA minimum.

No proposed candidates contradict prior rejected hypotheses.
