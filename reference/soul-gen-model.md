# Soul Generation GCD-Budget Model

Design doc for `scripts/soul-gen-model.mjs` -- a standalone analytical tool that models Aldrachi Reaver soul fragment generation and Art of the Glaive (AotG) progression through GCD-by-GCD forward simulation.

## Purpose

The AR APL look-ahead variables (lines 49-70 of vengeance.simc) estimate time-to-RG and filler feasibility. These estimates ignore passive fragment generation and use simplified charge models. This tool provides ground-truth GCD budgets to calibrate those variables.

## Core Model

### State tracked per GCD

- Fragment pool (0-6, cap 6)
- AotG counter (target 20)
- Fracture charges (0-2, 3.75s recharge at 20% haste)
- Cooldown timers (SC, SoS, SpB -- all hasted)
- Passive fragment accumulator (fractional)

### Overflow-as-consumption

When fragments are generated at cap (6), excess fragments are destroyed. Each destroyed fragment increments AotG by 1 -- identical to consumption via SpB/SClv. This means generation at cap produces AotG with no spend GCD required.

### Key insight: fracture recharge = 3 GCDs

`FRAC_RECHARGE_BASE / GCD_BASE = 4.5 / 1.5 = 3.0` -- this ratio is haste-invariant. After the initial 2-charge burst, exactly 1 charge returns every 3 GCDs regardless of haste.

### GCD budget constraint

After burst (2 charges), sustained fracture rate is 1 per 3 GCDs. The 2 intermediate GCDs are SClv spends, CD casts, or fillers. At cap, each fracture GCD produces 2 overflow AotG (3 in meta).

### SpB is a cooldown, not a rotational spender

Spirit Bomb has a 25s base (hasted) cooldown -- ~20.8s at 20% haste. It fires once per RG cycle. Soul Cleave (no CD, 2 frag consume) is the primary spender for converting frags to AotG between fractures.

## Source Rates

### Active (GCD cost)

| Source         | Frags      | GCD cost | Cooldown                      | Notes                     |
| -------------- | ---------- | -------- | ----------------------------- | ------------------------- |
| Fracture       | 2 (3 meta) | 1        | 2 charges, 4.5s base (hasted) | Primary generator         |
| Soul Carver    | 3+3 DoT    | 1        | 30s base (hasted)             | 6 total over 3s           |
| Sigil of Spite | 3 (+1 BS)  | 1        | 60s base (hasted)             | Instant generation        |
| Spirit Bomb    | -5 consume | 1        | 25s base (hasted)             | Big batch, once per cycle |
| Soul Cleave    | -2 consume | 1        | none                          | Primary spender           |

### Passive (fractional, between GCDs)

| Source         | Rate                   | Condition          |
| -------------- | ---------------------- | ------------------ |
| Wounded Quarry | 0.30/s                 | Always (AR talent) |
| Fallout        | 0.30/target/s          | During IA          |
| Broken Spirit  | +0.20 on SC, +1 on SoS | Talent             |
| Soul Splitter  | 2% multiplicative      | Talent             |

### Effective passive rates at 20% haste (1.25s GCD)

- ST with WQ only: 0.38 frags/GCD
- ST with WQ+Fallout+IA: 0.75 frags/GCD
- 5-target AoE with WQ+Fallout+IA: 2.25 frags/GCD

## Strategy: Smart Greedy

Priority per GCD:

1. **Spend to trigger RG** (SpB if up, else SClv) if consumable frags >= deficit
2. **Soul Carver** if available (highest frags/GCD ratio)
3. **Sigil of Spite** if available
4. **Overflow fracture** if at cap with charges (especially valuable during SC DoT)
5. **Fracture** to generate (build toward cap before spending)
6. **SpB big batch** when up and frags >= 4 (after exhausting fracture charges)
7. **SClv** if frags >= 2 and SpB not imminent (convert idle frags to AotG)
8. **Filler**

### SpB timing: after building, not before

SpB should fire AFTER fracture charges are spent and cap is established, not immediately after SC. During the SC DoT window (~3s), fragments arrive at cap and overflow for free AotG. Using SpB early wastes this overflow window.

Optimal opening: SC -> Frac -> Frac(overflow) -> SpB -> SClv cycles

### SClv as primary spender

With SpB on 25s CD, the Frac/SClv cycle drives most AotG progress:

- Frac at cap: +2 overflow AotG (1 GCD)
- SClv: -2 frags, +2 AotG (1 GCD)
- Pattern: Frac -> SClv -> filler -> Frac -> SClv -> ... (2 AotG per active GCD)

## Findings

### Baseline: 0 AotG, 0 frags, apex 3, 20% haste, SC ready

| Metric                 | Expected         | Conservative (50%) |
| ---------------------- | ---------------- | ------------------ |
| Time to RG             | 15.00s (13 GCDs) | 18.75s (16 GCDs)   |
| Time to 2nd RG         | 33.75s (28 GCDs) | N/A                |
| Filler margin (20s RM) | 5.00s (4 GCDs)   | 1.25s (1 GCD)      |

GCD budget: 1 SC + 5 Frac + 1 SpB + 5 SClv + 1 filler = 13 total.
AotG sources: 2 overflow + 15 spend + 3 passive/DoT.

### Key scenario comparisons

| Scenario                 | Time to RG     | Filler margin | Notes                  |
| ------------------------ | -------------- | ------------- | ---------------------- |
| Base (SC ready)          | 15.00s/13 GCDs | 4 GCDs        | Standard opening       |
| Meta active              | 11.25s/10 GCDs | 7 GCDs        | fracGen=3 cuts 3 GCDs  |
| SC + SoS both            | 12.50s/11 GCDs | 6 GCDs        | SoS saves 2 GCDs       |
| No SC (cd 30)            | 21.25s/18 GCDs | 0 GCDs        | Exceeds RM window      |
| Mid-cycle (10/3)         | 7.50s/7 GCDs   | 3 GCDs        | Starting stacks matter |
| Near RM expiry (8/2, 5s) | 8.75s/8 GCDs   | 0 GCDs        | Cannot reach within RM |
| High haste (30%)         | 13.85s/13 GCDs | 5 GCDs        | More GCDs, ~same time  |
| AoE+Fallout (5 targets)  | 8.75s/8 GCDs   | 9 GCDs        | Passive dominates      |

### Critical observations

1. **SpB is a once-per-cycle ability.** With 20.8s hasted CD, it fires once in a ~15s RG cycle. SClv (no CD, 2-frag consume) does most of the AotG conversion work. This is NOT reflected in the current gen_time variables which assume SpB is freely available.

2. **Passive gen offset is substantial.** WQ contributes ~5 frags over a 13-GCD cycle. The current gen_time variable counts zero passive contribution.

3. **SC is the single largest accelerant.** Without SC, RG exceeds the 20s RM window. With SC at cap, the 6-frag burst (3 instant + 3 DoT overflow) contributes 4-6 AotG for 1 GCD.

4. **Meta cuts 3 GCDs** via fracGen=3 (50% more frags per fracture). This effect IS captured by the current APL's `frac_souls` variable.

5. **Conservative filler margin is tight.** At 50% passive rates, only 1 filler GCD available in the base case. APL should use conservative estimates for timing-critical decisions.

6. **Haste doesn't help much.** 30% vs 20% haste: same GCD count (~13), same real time (~14s). The fracture:GCD ratio is constant at 3:1. All CDs are hasted proportionally.

## APL Variable Analysis

### Operator note: `<?` = MAX, `>?` = MIN

In SimC expression syntax, `<?` is the max operator and `>?` is the min operator. This is counterintuitive but confirmed.

### Deficit clamping is correct

Line 51: `value=(20-buff.art_of_the_glaive.stack-soul_fragments.total)<?0`
This computes `max(deficit, 0)` -- correctly clamps the deficit to non-negative. Same pattern in line 59 `net_deficit` and lines 56/62 inner terms `((fracs-charges-1)<?0)` which correctly clamp extra recharge count to non-negative.

### Bug: `op=ceil` ignores `value=` expression (CONFIRMED)

Lines 52 and 60 use `op=ceil,value=expr` in a single statement:

```
variable,name=fracs_base,op=ceil,value=variable.base_deficit%variable.frac_souls
variable,name=fracs_needed,op=ceil,value=variable.net_deficit%variable.frac_souls
```

In SimC's `variable.cpp`, `OPERATION_CEIL` applies `ceil(current_value_)` to the variable's existing value. The `value=` expression is **never parsed** when `op=ceil` (guarded out at line 135). Result: both variables are always 0, making `gen_time` and `time_to_next_glaive` dead code.

**Fix:** Split into two statements (set then ceil):

```
variable,name=fracs_base,value=variable.base_deficit%variable.frac_souls
variable,name=fracs_base,op=ceil
```

**Debug verification (single iteration, 30s):**

- Baseline: gen_time=0 always, time_to_next_glaive=5\*gcd.max (~4.14-4.76)
- Fixed: gen_time ranges 0-17.46, time_to_next_glaive ranges 4.17-23.17
- Math verified at t=3.183: deficit=14, frac_souls=3, fracs_needed=ceil(8/3)=3, gen_time=4.76 (matches hand calculation)

## APL Variable Improvement Candidates

### 1. Fix op=ceil bug in fracs_base and fracs_needed

Split the combined `op=ceil,value=...` into two separate lines. This activates the entire gen_time estimation chain.

### 2. `passive_frag_rate` -- new variable

Account for WQ + Fallout generation during the RM window.

```
variable,name=passive_frag_rate,value=0.30*gcd.max+(talent.fallout&buff.immolation_aura.up)*0.30*spell_targets.spirit_bomb*gcd.max
```

### 3. Adjusted `gen_time` -- reduce by passive offset

Current gen_time counts only fracture charges. Subtracting passive offset:

```
variable,name=passive_offset,value=variable.passive_frag_rate*variable.fracs_needed*(1+apex.3)
variable,name=adj_fracs_needed,op=ceil,value=(variable.net_deficit-variable.passive_offset)%variable.frac_souls
```

### 4. Overflow-aware `rg_imminent`

Current rg_imminent checks `aotg.stack + soul_fragments >= 18/20`. With overflow model, generation at cap also increments AotG:

```
# At cap, next fracture produces frac_souls overflow AotG
variable,name=rg_imminent,value=(...existing...)|
  (soul_fragments>=6&buff.art_of_the_glaive.stack>=(20-variable.frac_souls)&cooldown.fracture.charges>=1)
```

### 5. Filler-RG gate in `prio_slashes`

Add margin check: only filler when remaining RM supports full filler+refresh cycle.

```
variable,name=filler_rg_ok,value=debuff.reavers_mark.remains>(variable.gen_time+5*gcd.max)
```

## Usage

```bash
# Standard opening
node scripts/soul-gen-model.mjs --aotg 0 --frags 0 --apex 3 --rm-remains 20 --haste 0.20

# Mid-combat with partial state
node scripts/soul-gen-model.mjs --aotg 12 --frags 4 --apex 3 --rm-remains 8 --frac-charges 1 --frac-cd 2 --sc-cd 15

# AoE with Fallout
node scripts/soul-gen-model.mjs --aotg 0 --frags 0 --apex 3 --targets 5 --fallout --ia-active --ia-remains 6

# Meta burst
node scripts/soul-gen-model.mjs --aotg 0 --frags 0 --apex 3 --meta

# SpB on CD (mid-cycle)
node scripts/soul-gen-model.mjs --aotg 0 --frags 0 --apex 3 --spb-cd 15

# Verbose GCD log
node scripts/soul-gen-model.mjs --aotg 0 --frags 0 --apex 3 -v
```
