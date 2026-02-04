# Plan: Vengeance DH APL Framework — Midnight Expansion

## Goal

Build the foundation for creating an optimal Vengeance Demon Hunter APL targeting the Midnight expansion. The core insight: **understanding spell/talent interactions deeply** is the prerequisite to everything else. We build tools to extract, map, and visualize those interactions, then use that understanding to craft and test APLs.

## Prerequisites

- [x] simc on `midnight` branch and built
- [x] Node.js available (v23.11.0)
- [x] SimC binary at `/Users/tom/Documents/GitHub/simc/engine/simc`

## Steps

### Step 0: Save Plan to Repo

- [x] Create `PLAN.md`
- [x] Update `CLAUDE.md` with architecture and session protocol

### Step 1: Project Scaffold

- [x] `package.json` — ESM module
- [x] `.gitignore` — Add `data/raw/`, `results/`
- [x] Directory structure: `src/{extract,model,visualize,sim,apl}`, `data/`, `apls/`, `results/`

### Step 2: Spell Data Extraction & Parsing

- [x] `src/extract/parser.js` — spell_query text → JSON parser
- [x] `src/extract/spells.js` — runs simc spell_query, produces `data/spells.json`
- Note: ~104 spells extracted from Raidbots spell IDs + base abilities + class spells
- Note: Descriptions contain simc template variables ($s1, $s2, etc.) — future: resolve to actual values

### Step 3: Talent Tree Mapping

- [x] `src/model/talents.js` — structures talent data into class/spec/hero trees
- [x] Output: `data/talents.json`
- [x] Raidbots integration: 42 class nodes, 42 spec nodes, 14+14 hero nodes
- [x] Talent entries (with choice node expansion): 45 class, 44 spec, 17 Aldrachi Reaver, 16 Annihilator
- Note: Raidbots is authoritative for tree structure; simc C++ is implementation reference
- Note: Devourer is a third DH spec (Intellect caster), not a hero tree
- Note: Vengeance hero trees in Midnight: Aldrachi Reaver (subtree 35) + Annihilator (subtree 124)
- Note: Class node spell IDs are identical across all three DH specs

### Step 4: Interaction Mapping

- [x] `src/model/interaction-types.js` — interaction category definitions + effect/name heuristics
- [x] `src/model/interactions.js` — merges spell_data + C++ scanner + effect scan
- [x] `src/extract/cpp-interactions.js` — C++ cross-reference scanner (talent↔talent, talent→ability)
- [x] `src/visualize/audit-report.js` — comprehensive audit report
- [x] Output: `data/interactions.json`, `data/cpp-interactions.json`, `data/audit-report.md`
- [x] **Zero unknown interactions** (was 10)
- [x] **266 interactions** (was 190): 190 spell_data + 59 cpp_scanner + 17 effect_scan
- [x] **114 talents** have interactions (was 70), 11 stat passives excluded, 44 C++-only
- [x] Verification: 20 passed, 0 failed, 2 warnings (orphan sub-spells, 1 active ability gap)

### Step 5: Visualization

- [x] `src/visualize/text-report.js` — markdown ability/talent report
- [x] `src/visualize/graph.js` — Mermaid interaction graph
- [x] Output: `data/ability-report.md`, `data/interaction-graph.mermaid`

### Step 6: SimC Runner

- [x] `src/sim/runner.js` — executes simc, parses JSON output
- [x] `src/sim/analyze.js` — extracts optimization signals
- [x] Three scenarios: Patchwerk ST, Small AoE (3 targets), Large AoE (10 targets)

### Step 7: Baseline APL

- [x] Copy TWW3 vengeance APL as `apls/baseline.simc`
- [x] Copy TWW3 profile as `apls/profile.simc`
- [x] Run baseline simulation, record reference numbers

**Baseline Results (Fel-Scarred, TWW3 profile, 1000 iterations):**

| Scenario        | DPS        | HPS     |
| --------------- | ---------- | ------- |
| Patchwerk ST    | 3,087,582  | 890,439 |
| Small AoE (3T)  | 8,238,623  | 806,147 |
| Large AoE (10T) | 18,732,678 | 737,423 |

**Key ST findings:**

- Burning Blades 20.5%, Demonsurge 12.3%, Soul Cleave 10.0% of damage
- Spirit Bomb is 50.8% of healing (via Frailty)
- Demon Spikes uptime: 63.8%, Metamorphosis uptime: 39.0%
- Soul Furnace damage amp uptime only 11.2% — potential optimization target

### Step 8: Raidbots Integration & Project Setup

- [x] `src/config.js` — Central config (DATA_ENV, paths, Raidbots URLs, VDH identifiers)
- [x] `src/extract/raidbots.js` — Fetch Raidbots talent data → `data/raidbots-talents.json`
- [x] Refactored `src/model/talents.js` — Raidbots as primary source (replaces DBC talent dump)
- [x] Refactored `src/extract/spells.js` — Spell IDs from Raidbots (removed `parseTalentDump()`)
- [x] Updated `src/verify.js` — Raidbots-based verification (count matching, stale detection, choice nodes)
- [x] `.claude/commands/` skills: verify, build, sim, audit
- [x] Updated `package.json` — `fetch-raidbots` script, updated `build-data` pipeline
- [x] Updated `.claude/settings.local.json` — `npm run *` permission
- [x] Updated `CLAUDE.md` — Data sources, environment toggle, hero trees, choice nodes
- [x] Rewritten `prompts/verify-data.md` — Raidbots as primary authority

**Current verification status:** 18 passed, 0 failed, 1 warning (5.3% unknown interactions)

## Current Data Pipeline

```
npm run fetch-raidbots  →  data/raidbots-talents.json (from Raidbots API)
npm run extract         →  data/spells.json (simc spell_query for each Raidbots spell ID)
npm run talents         →  data/talents.json (structured class/spec/hero trees)
npm run interactions    →  data/interactions.json (talent → spell interaction graph)
npm run report          →  data/ability-report.md
npm run graph           →  data/interaction-graph.mermaid

npm run build-data      →  runs all of the above in sequence
npm run verify          →  validates data against Raidbots + simc C++
```

## Known Gaps

- GCD efficiency metric uses conservative estimate (total executes / theoretical GCDs) — doesn't account for haste-adjusted GCD or off-GCD abilities
- Annihilator profile needed — current baseline only exercises Aldrachi Reaver talents
- Spell template variable resolution at 65.9% — remaining are stat-dependent ($AGI, $sw), compound conditionals, and sub-spells missing from binary

### Step 9: SimC Reference Data Extraction

- [x] `reference/vengeance-apl.simc` — simc default VDH APL
- [x] `reference/simc-talent-variables.json` — C++ talent variable names (219 total across all trees)
- [x] `reference/spelldatadump-vdh.txt` — Full DH spell effect data from SpellDataDump
- [x] `reference/trait-data.md` — Key simc structs: trait_data_t, player_talent_t, soul_fragment enum
- [x] `reference/tww3-profiles/` — TWW3 VDH profiles (base + Aldrachi Reaver)
- [x] `reference/apl-conversion/` — ConvertAPL.py + generate_demon_hunter.py
- [x] `reference/wiki/` — 15 SimC wiki pages (APL syntax, expressions, DH options, etc.)
- [x] `src/extract/simc-talents.js` — Extracts talent variables from sc_demon_hunter.cpp
- [x] Updated `package.json` with `extract-simc` script
- [x] Updated `CLAUDE.md` with reference directory documentation

## Phase 2: APL Tooling Pipeline

Build all tooling needed to programmatically create, test, and iterate on VDH APLs, then establish a workflow where Claude can autonomously run simulation loops and reason about improvements.

### Step 10: Resolve Spell Template Variables

- [x] Add `resolvedDescription` field to each spell in `data/spells.json`
- [x] Substitute `$s1`/`$s2`/`$s3` → effect N's `scaledValue` or `baseValue`
- [x] Substitute `$d` → spell duration, `$t1`/`$t2` → tick period, `$a1` → radius
- [x] Handle `$SpellIds1` cross-references, `$?sSpellId[yes][no]` conditionals
- [x] Handle `${expr}` arithmetic (e.g., `$s1*2`, `$s1/1000`)
- [x] Target ~85-90% resolution; leave unresolvable as raw template
- Note: `src/extract/template-resolver.js` — standalone module, integrated into spells.js
- Note: 110/167 spells fully resolved (65.9%), 22 partial, 35 unresolved
- Note: 65.4% variable-level resolution; remaining are stat-dependent ($AGI, $sw), compound conditionals, and sub-spells missing from binary
- Note: Also fetches 43 sub-spells referenced in descriptions for better resolution

### Step 11: APL Parser/Generator

- [x] `src/apl/parser.js` — Parse `.simc` APL text into AST, serialize back
- [x] AST nodes: ActionList, RawSection, Action, Variable, RunActionList, Comment
- [x] Operations: `parse()`, `serialize()`, `getActionLists()`, `findAction()`, `insertAction()`, `removeAction()`, `replaceCondition()`, `createAction()`, `createVariable()`
- [x] Round-trip fidelity: `serialize(parse(text))` produces PERFECT output
- Note: Preserves document order — non-APL lines (gear, profile) stay in position
- Note: baseline.simc: 10 action lists, 166 actions, perfect round-trip
- Note: reference/vengeance-apl.simc: 5 action lists, 67 actions, perfect round-trip

### Step 12: Talent Combination Generator

- [x] `src/model/talent-combos.js` — Generate valid talent sets from tree graph
- [x] Validation: entry nodes, `prev` connectivity, `reqPoints` gates, choice node exclusivity
- [x] Hero tree simplification: enumerate choice node combinations only
- [x] **Reworked to DoE fractional factorial design** (replaces anchor-based generation)
- [x] Node classification: locked (entry/free) vs factor (decision points)
- [x] Factor identification: binary, multi-rank (2 factors), choice nodes
- [x] Resolution IV fractional factorial: 512 rows for 44 factors (9 base + 35 generators)
- [x] Build mapping: design rows → valid builds with connectivity repair + budget reconciliation
- [x] Cross-product with hero tree choice combos (8 AR + 4 Annihilator = 12)
- [x] Design quality metrics: balance, orthogonality, pair coverage
- [x] `src/analyze/doe-analysis.js` — OLS regression with main effects + 2-way interactions
- [x] Optimal build prediction, confirmation builds, diagnostic output
- Note: 5856 valid builds (488 unique spec designs × 12 hero combos), 98% feasibility rate
- Note: 44 binary factors from 40 spec tree factor nodes (2 locked entry, 40 flex)
- Note: Budget reconciliation degrades orthogonality (max corr 0.79, pair coverage 81%)
- Note: 10 infeasible design rows due to reqPoints gate edge cases (7 of 8 required points)

### Step 13: Batch Testing via Profilesets

- [x] `src/sim/profilesets.js` — Generate and run SimC profileset files
- [x] Support talent, APL, and action line overrides per variant
- [x] Parse ranked JSON results with delta comparison
- [x] Regression testing: golden results, flag >1% regressions
- Note: Uses SimC native profileset mode for memory-efficient batch comparison
- Note: Golden results stored in `results/golden/`, >1% warn, >3% error thresholds

### Step 14: Autonomous Simulation Workflow

- [x] `src/sim/workflow.js` — Single entry point for full sim→analyze cycle
- [x] Parse APL, run across scenarios, return structured JSON analysis
- [x] No user interaction required; designed for Claude to call
- Note: Outputs structured JSON with per-scenario DPS/HPS/DTPS, ability breakdowns, buff uptimes, GCD efficiency, and cross-scenario AoE scaling analysis

### Step 15: APL Reasoning Framework

- [x] `src/analyze/reasoning.js` — Generate improvement hypotheses from sim results
- [x] Analysis: underused abilities, buff uptime gaps, cooldown alignment, conditional tightness
- [x] Output ranked hypotheses with category, confidence, suggested tests
- Note: 6 analysis dimensions: underused abilities, modifier alignment, buff uptime gaps, cooldown alignment, conditional tightness, AoE mismatch
- Note: Uses interaction graph data to correlate talent modifiers with ability DPS share

### Dependency Order

```
Step 10 (template vars) ──────────────────────────────────┐
Step 11 (APL parser) ──────┬──────────────────────────────┤
Step 12 (talent combos) ───┤                              │
                           ├─→ Step 13 (profilesets) ──→ Step 14 (workflow) ──→ Step 15 (reasoning)
```

## Phase: Build VDH APL from Scratch (Midnight)

### Phase 0: Merge main — [x] Complete

- Merged origin/main (fast-forward to 7453f26)
- Rebuilt data pipeline (skipping fetch-raidbots due to sandbox)

### Phase 1A: Fill data gaps — [x] Complete

- Fixed FIELD_REGEX bug in parser.js (`\s+` → `\s*`) — "Internal Cooldown" field was being silently dropped
- Added "Category Cooldown" parser case
- Created `data/proc-mechanics.json` with C++ hardcoded proc rates
- Result: 15 spells now have internalCooldown, 4 have categoryCooldown

### Phase 1B: Exhaustive data analysis — [x] Complete

- Extracted AP coefficients for all VDH damage spells
- Built DPGCD ranking table (Sigil of Spite 6.92 > Voidfall Meteor 5.4 > Fiery Brand 4.16 > Reaver's Glaive 3.45 > Fracture 3.105)
- Mapped all damage modifiers with percentages
- Modeled AR state machine (Build → Convert → Spend) and Voidfall cycle (Build → Spend)
- Analyzed resource budget: ~431 Fury/min generation, ~270 Fury/min spending

### ~~Phase 2-4~~ — SUPERSEDED

The derivative APL built in these phases was deleted. It was structurally a copy of the baseline with minor tweaks, not a genuine first-principles build.

**See `plans/apl-from-scratch-v2.md` for the current plan.** Start there.

### Phase 3.1: APL Skeleton — [x] Complete

- Created `apls/vengeance.simc` with 8 action lists: precombat, default, externals, ar, ar_empowered, ar_cooldowns, anni, anni_voidfall
- Sub-list design: `call_action_list` for empowered/cooldowns/voidfall (optional, falls through), `run_action_list` for hero tree routing (mutually exclusive)
- Uses `input=apls/profile.simc` (CWD-relative, not file-relative — SimC resolves from where binary is invoked)
- All abilities cast across all scenarios, no 0-cast issues
- Demon Spikes uptime 99%+, AotG cycle functioning correctly
- ST DPS -3.9% vs baseline (expected for untuned skeleton), AoE +14-17% (Spirit Bomb threshold + sub-list structure)
- Parser round-trips cleanly (only normalizes `actions.X=/` to `actions.X=`, cosmetic)

### Phase 2: Simulation-Driven Priority Discovery — [x] Complete

Ran 5 profileset tests (24 total variants) in ST to discover optimal AR priority ordering:

| Test                  | Best Variant                    | DPS Impact | Key Finding                                                 |
| --------------------- | ------------------------------- | ---------- | ----------------------------------------------------------- |
| Fracture guard        | No overflow guard               | +10.4%     | Fracture DPGCD high enough that overflow waste < lost casts |
| Core rotation         | Meta-priority Fracture          | +5.2%      | +1 frag/cast in Meta justifies top priority                 |
| Felblade position     | After Fracture                  | +2.1%      | Fury gen is critical; removing costs -13.8%                 |
| Cooldown order        | Brand > Spite > Carver > FelDev | +0.6%      | Brand first enables Fiery Demise window                     |
| Spirit Bomb threshold | 4-5 frags within noise          | +0.3%      | Keep at 4 for Frailty uptime                                |

AoE test confirmed Spirit Bomb threshold has negligible AoE impact (0.3% spread).

Applied all findings to `apls/vengeance.simc`. Results vs baseline:

- ST: +6.5% (22,885 → 24,370)
- 5T AoE: +25.1% (66,143 → 82,772)
- 10T AoE: +27.4% (115,025 → 146,491)

Bug fixes during Phase 2:

- Fixed `resolveInputDirectives` to try CWD-relative paths as fallback (profileset system couldn't resolve `input=apls/profile.simc`)
- Fixed `runProfileset` sync variant dropping input file path (`args.slice(1)` → `args`)

### Phase 3.2: Variable Design — [x] Complete

Tested dynamic `spb_threshold` variable (Frailty-aware, AoE-aware, Fiery Demise-aware) via profilesets against static thresholds 3/4/5:

- **ST:** All thresholds within 0.6% — no significant decision boundary exists
- **5T AoE:** All within 1.4% (higher thresholds slightly favored, but within noise at 1% target_error)
- **Conclusion:** Dynamic threshold adds complexity without measurable gain. Simplified to static `spb_threshold=4` as a named variable.

Variables in final APL:

| Variable              | Purpose                                      | Used by               |
| --------------------- | -------------------------------------------- | --------------------- |
| `trinket_1_buffs`     | Trinket buff detection (SimC plumbing)       | AR + Anni trinket use |
| `trinket_2_buffs`     | Trinket buff detection (SimC plumbing)       | AR + Anni trinket use |
| `fiery_demise_active` | Fiery Demise window flag                     | AR Soul Carver gate   |
| `spb_threshold`       | Spirit Bomb fragment threshold (static 4)    | AR Spirit Bomb        |
| `spb_1t_souls`        | Anni ST Spirit Bomb threshold (FD-dependent) | Anni Spirit Bomb      |

Removed dead variables: `num_spawnable_souls`, `single_target`, `small_aoe`, `big_aoe` (defined but never referenced in action conditions).

Variables NOT added (rationale):

- `fury_value_sc/sbomb` — SimC has no runtime spell introspection
- `fragment_waste_risk` — Phase 2 showed Fracture overflow guard costs -10.4%
- `ar_cycle_ready` — too subtle, no sim evidence of gain
- `frailty_needed` — folded into dynamic spb_threshold test; result was noise

Additional exploration (post Phase 3.2):

| Test                    | Best Variant       | DPS Impact | Applied? | Key Finding                                                                    |
| ----------------------- | ------------------ | ---------- | -------- | ------------------------------------------------------------------------------ |
| Soft overcap (inactive) | Spite guard <=5    | +0.3%      | Yes      | Relaxed Spite from <=3 to <=5; urgent SBomb at 3 frags = -0.3%                 |
| SBomb cooldown pooling  | Baseline (no pool) | —          | No       | All pooling variants -0.3% to -2.8%; SC opportunity cost > SBomb marginal gain |

Key insight: With 25s Spirit Bomb CD, fragments have time-value — spending NOW via Soul Cleave (2.912 AP) > hoarding for later SBomb (+0.8 AP from +2 frags).

### Phase 4: Validation — [x] Complete

Ran both APLs (`vengeance.simc` vs `baseline.simc`) across all 3 scenarios with `target_error=0.5`:

| Scenario | Ours    | Baseline | Delta  |
| -------- | ------- | -------- | ------ |
| ST       | 24,365  | 22,806   | +6.8%  |
| 5T AoE   | 82,816  | 66,350   | +24.8% |
| 10T AoE  | 146,193 | 114,764  | +27.4% |

**AoE gain decomposition:** The bulk of the AoE delta comes from Spirit Bomb being freely available in our AR branch (fired at 4+ fragments), while the baseline gates Spirit Bomb behind `spell_targets>=12` in its AR branch — effectively disabling it for 5T and 10T scenarios. The remaining gain from rotation optimization (Meta-priority Fracture, cooldown ordering, etc.) is likely 3-5% in AoE.

Diagnostics:

- All abilities casting (no 0-cast issues)
- Demon Spikes uptime 99.2%
- Fragment overflow lower than baseline (78.8 vs 118.0)
- AotG cycle functioning correctly
- Frailty uptime healthy

Known gaps:

- Annihilator branch untested (no Anni talent profile exists)
- Brand-first CD ordering (+0.6%) tested at `target_error=1.0` — below noise floor, should be re-tested at higher fidelity

### Phase 5: Untethered Rage Implementation — [x] Complete

**Root cause investigation:** Untethered Rage (apex talent, 4 ranks) was in the talent build string but not loading in SimC. Investigation revealed two issues:

1. **Missing `ptr=1` in profile** — SimC defaults `dbc->ptr=false`. PTR data tables (gated by `SC_USE_PTR` + `maybe_ptr()`) contain tiered apex nodes (110416, 110425, 110427) that don't exist in live data tables. Without `ptr=1`, `generate_tree_nodes()` loads 224 nodes instead of 227, and `find_talent_spell("Untethered Rage")` fails silently.
2. **Partial SimC implementation** — UR proc formula was a placeholder (`0.0075 * pow(1.35, up())`), and the free Metamorphosis mechanic was not implemented.

**Fixes applied:**

| File                       | Change                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `apls/profile.simc`        | Added `ptr=1` (enables PTR data tables for Midnight beta)         |
| `src/sim/runner.js`        | Auto-adds `ptr=1` when `DATA_ENV` is "ptr" or "beta"              |
| `apls/vengeance.simc`      | Meta condition: `!buff.metamorphosis.up\|buff.untethered_rage.up` |
| SimC `sc_demon_hunter.cpp` | Full UR implementation (see below)                                |

**SimC implementation (on fork `taherbert/simc`, branch `feature/untethered-rage-meta`):**

1. Expire Seething Anger on UR proc + proc tracking
2. UR buff grants temporary Meta charge via `adjust_max_charges(cur - old)` stack callback
3. Meta execute: UR-consumed Meta uses max(remaining, 10s) duration — `extend_duration()` when Meta is active with <10s remaining, `trigger(10s)` when Meta is down. Avoids both `extend_duration_or_trigger()` (extends BY 10s, too generous) and `trigger()` (assertion failure from TICK refresh_behavior on Meta buff).
4. Removed "Partial implementation" comment
5. Preserves upstream proc rate formula: `0.0075 * pow(1.35, SA_up)` per soul consumed

**Note on upstream proc formula:** Upstream uses `buff.seething_anger->up()` (boolean 0/1) but SA has 99 max stacks. This means the formula treats SA as binary (35% boost when active) rather than scaling with stack count. Likely an upstream bug — `check()` (returns stack count) would give exponential scaling. Not fixed in our PR; separate upstream concern.

**Results (target_error=0.3, 1532 iterations):**

| Metric                | Value       |
| --------------------- | ----------- |
| DPS                   | 29,086 ± 44 |
| Meta uptime           | 26.8%       |
| UR procs/fight        | 2.7         |
| Meta casts/fight      | 5.7         |
| Seething Anger uptime | 95.3%       |

### Phase 6: Optimization Pass — [x] Complete

- [x] Baseline established: ST 29,032 / 5T 91,888 / 10T 162,484
- [x] 15 hypotheses tested, 1 accepted (SBomb threshold 5 → +0.21% weighted)
- [x] 14 hypotheses rejected — APL at local optimum
- [x] Key findings recorded in `results/findings.json`

**Accepted change:**

- Spirit Bomb threshold 4→5: +0.36% ST, -0.20% 5T, +0.44% 10T (+0.21% weighted, p<0.05)

**Key rejected hypotheses (with reason):**

- Meta `use_while_casting=1`: -0.29% (SimC already handles off-GCD properly)
- Spite AotG-aware: -0.04% (overcomplicated, no gain)
- Hold Spite/FelDev for Brand window: -0.32% (delayed casts > FD bonus)
- SBomb threshold 3: -0.51% (esp. -1.50% at 5T)
- SBomb threshold 6: -0.95% (overcaps fragments)
- IA priority above Fracture: -0.10% (Fracture's immediate fragments > passive ticks)
- FelDev interrupt_if for SBomb: -0.03% (no gain at confirm)
- SC Fury dump at 100: -0.30% (catastrophic -2.70% at 10T — consumes SBomb fragments)
- FelDev before cooldowns: -0.58% (channels delay Brand→FD window)
- Brand-Meta alignment: -0.45% (delaying FD window > overlap bonus)
- Tighter CD fragment guards: -0.23% (delays valuable CD casts)
- Target-dependent threshold: -0.46% (threshold 5 optimal everywhere)
- Flat AR list: -0.01% (`call_action_list` has zero overhead)
- Dynamic FD threshold: -0.23% (5th fragment always worth waiting for)

**Current baseline (post Phase 6):**

| Metric | ST     | 5T     | 10T     |
| ------ | ------ | ------ | ------- |
| DPS    | 29,214 | 91,712 | 163,436 |

### Phase 7: Build + APL Co-Optimization — [x] Complete

Swapped 5 spec talents to fill previously suboptimal choices. The original plan assumed 5 unspent points, but the build was already at 34/34 — required dropping 5 points.

**Talent changes:**

| Action | Talent                                   | Section | DPS Impact                             |
| ------ | ---------------------------------------- | ------- | -------------------------------------- |
| +Add   | Down in Flames (2 Brand charges, 48s CD) | S3      | High — Fiery Demise uptime ~doubled    |
| +Add   | Soul Carver (60s CD, frag shattering)    | S3      | Medium — new damage CD + fragments     |
| +Add   | Darkglare Boon (Fel Dev CDR refund)      | S3      | Low-Medium — more Fel Dev casts        |
| +Add   | Soulcrush (double Frailty effects)       | S3      | Medium — Vulnerability 3%→6% per stack |
| +Add   | Ascending Flame (Sigil +50%)             | S1      | Low                                    |
| -Drop  | Last Resort                              | S3      | Zero (cheat death)                     |
| -Drop  | Calcified Spikes                         | S1      | Zero (defensive)                       |
| -Drop  | Feed the Demon                           | S2      | Zero (DS CDR, already 99% uptime)      |
| -Drop  | Stoke the Flames                         | S3      | Moderate (Fel Dev damage %)            |
| Reduce | Charred Flesh 2→1                        | S3      | Moderate (less FB extension/tick)      |

**Gate constraint:** S1+S2 must total ≥ 20 points. With Ascending Flame in S1 and 4 adds in S3, only 1 S1 drop + 1 S2 drop was feasible, forcing 3 drops from S3 (where only Last Resort had zero DPS value).

**APL adaptation:** Only one change had statistically significant impact — the Fiery Brand condition for 2 charges:

```
# Old: fiery_brand,if=talent.fiery_demise&!dot.fiery_brand.ticking
# New: fiery_brand,if=talent.fiery_demise&(cooldown.fiery_brand.charges>=2|!dot.fiery_brand.ticking)
```

+0.22% at 10T, +0.067% weighted.

**Rejected APL changes (4 tested, 0 accepted beyond Brand condition):**

- Soul Carver FD gate removal: +0.02% weighted (noise — gate is free with 2 Brand charges)
- Fel Dev priority above Spite/SC: +0.09% weighted (mixed — gains 5T, loses ST/10T)
- Rending Strike gate removal on Reaver's Glaive: -0.005% weighted (noise)
- Spirit Bomb threshold 4 with Soulcrush: -0.01% weighted (threshold 5 still optimal)

**Final results (co-optimized build + APL):**

| Scenario | Pre-Optimization | Post-Optimization | Delta  |
| -------- | ---------------- | ----------------- | ------ |
| ST       | 29,218           | 31,555            | +8.0%  |
| 5T       | 91,978           | 101,451           | +10.3% |
| 10T      | 163,116          | 179,395           | +10.0% |

**Key insight:** Nearly all of the gain comes from the talent build itself (+8.4-10.4%), not APL adaptation (+0.07%). The existing APL conditions were already well-suited to the new talents because: (a) Soul Carver was already in the APL but wasn't in the build, (b) Fiery Brand naturally adapts to 2 charges since the `!dot.ticking` condition fires whenever Brand falls off, (c) Soulcrush/Ascending Flame/Darkglare Boon are passives requiring no APL support.

### Future Work

- [ ] Create Annihilator talent profile and validate `actions.anni` / `actions.anni_voidfall`
- [ ] Test with DungeonRoute / movement scenarios
- [ ] Update gear profile when Midnight-specific consumables, gems, enchants become available in SimC
- [ ] Submit UR implementation as PR to simc/simc (branch: midnight)

## Findings & Notes

- SimC `midnight` branch version string still shows "thewarwithin" — the version identifier hasn't been updated
- Raidbots returns spec-specific talent trees (filtered by specId), but class node spell IDs are identical across all DH specs
- DBC subtree IDs map correctly to hero trees: 35 = Aldrachi Reaver, 124 = Annihilator
- simc binary built Sep 5 2025; some newer spells (e.g., Demonsurge) not in binary's spell data
- Buff uptimes from simc JSON are percentages (0-100), not fractions (0-1)
- GCD efficiency metric needs refinement for AoE scenarios (currently counts per-target hits)
- FIELD_REGEX bug: "Internal Cooldown" (17 chars) fills the spell_query column exactly, leaving zero padding before `:`. Fixed by `\s*`
- C++ hardcoded proc rates (Fallout 100%/60%, Wounded Quarry 30%) are NOT in spell data — need manual extraction or automated C++ scanner
- `input=` resolver added to `profilesets.js` (`resolveInputDirectives`) — inlines referenced files so profileset content written to `results/` is self-contained. Used by `iterate.js:buildProfilesetContent()` and `profilesets.js:generateProfileset()`.
- SimC APL expressions have NO runtime spell data introspection — no `action.X.ap_coefficient`, no `spell.X.base_damage`. The `multiplier` expression returns the composite multiplier for the _current action's_ schools only. APL variables must use threshold-based conditions, not computed damage-per-fury comparisons.
- SimC `input=` resolves paths relative to **CWD** (where simc binary is invoked), NOT relative to the including file's directory. Use `input=apls/profile.simc` when running from project root.
- **`ptr=1` is required for Midnight beta data.** SimC `maybe_ptr()` is a compile-time gate (`#if SC_USE_PTR`), but `dbc->ptr` defaults to `false` at runtime. Set `ptr=1` in the profile or as a sim override. Without it, tiered apex nodes (Untethered Rage, Eternal Hunt, Midnight hero node) are missing from the talent tree.
- **Untethered Rage mechanic:** Upstream proc formula `0.0075 * pow(1.35, SA_up) * souls_consumed` per consumption event. ~2.7 procs per 300s fight. UR proc grants a free Meta charge (10s duration vs normal 15s). SA stacks expire on UR proc; SA cannot stack while UR is active. SA has 99 max stacks, but upstream formula uses `up()` (binary) not `check()` (stack count).
- **Meta buff refresh hazard:** Meta buff has `refresh_behavior = TICK` (from spell data periodic dummy effect) but `buff_period = zero()` and `tick_behavior = NONE` (set in constructor). Calling `trigger()` on active Meta hits `assert(tick_event)` in `refresh_duration()`. Calling `extend_duration_or_trigger()` extends BY the duration rather than refreshing TO it. Solution: use `extend_duration()` with delta = max(0, desired - remaining) when Meta is active, `trigger(duration)` when Meta is down.
