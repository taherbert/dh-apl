# Comprehensive Vengeance DH Data Verification & Hardening

## Context

You are working on a Vengeance Demon Hunter APL (Action Priority List) optimization framework for World of Warcraft's **Midnight expansion** (patch 11.2.x). The project lives at `/Users/tom/Documents/GitHub/dh-apl`.

The framework extracts spell and talent data from SimulationCraft (simc), models talent→spell interactions, and uses that data to craft and test APLs. The simc source is at `/Users/tom/Documents/GitHub/simc` on the `midnight` branch.

**The data pipeline:**

```
simc spell_query → parser.js → spells.json
                              → talents-raw.json
talents-raw.json + spells.json + sc_demon_hunter.cpp → talents.js → talents.json
spells.json + talents.json → interactions.js → interactions.json
all JSON → text-report.js → ability-report.md
all JSON → graph.js → interaction-graph.mermaid
```

Run `npm run build-data` to regenerate everything. Run individual steps with `npm run extract`, `npm run talents`, etc.

**Known issues we've already fixed:**

- Havoc-only talents were leaking into the Vengeance talent tree. Fixed by parsing `talent.havoc.*` and `talent.vengeance.*` assignments from `sc_demon_hunter.cpp`.
- Base spec abilities (Soul Cleave, Shear, Immolation Aura, etc.) weren't showing in reports because they aren't in any talent tree. Fixed by creating `src/model/vengeance-base.js` with a shared BASE_SPELL_IDS set.
- Parser regex bug caused "Affecting Spells" field to not parse (only 1 space before colon). Fixed.

**Known remaining concerns:**

- Talent tree positions (row/col) come from simc's `talent` query and may be stale or not match the live beta client. Frailty shows as row 2, col 1 in our data but may have moved in the actual midnight talent tree.
- Many interactions are classified as "unknown" because the modifier spell isn't in our collection or the effect type doesn't map to a known category.
- Spell descriptions contain unresolved template variables ($s1, $s2, $d, etc.).
- The simc midnight branch may not implement all midnight-specific changes yet (version string still shows "thewarwithin").
- "Devourer" is a new DH hero tree in midnight (like Aldrachi Reaver and Fel-Scarred). It is NOT Vengeance-specific — hero trees are shared across DH specs. Our framework currently only tracks Fel-Scarred and Aldrachi Reaver.

## Your Mission

Perform a **comprehensive audit** of the data pipeline and its outputs. The goal is threefold:

1. **Verify completeness and correctness** of the current data
2. **Identify and fix any gaps, errors, or stale data**
3. **Harden the pipeline** so it's resilient to future patch changes (abilities added/removed/moved, talents reshuffled, names changed, new hero trees, etc.)

Work autonomously. Read all source files, data files, and the simc C++ source as needed. Use the wowhead beta site (https://www.wowhead.com/beta/spell={id}) to cross-reference individual spells. Use the simc source (`sc_demon_hunter.cpp`) as ground truth for what's actually implemented.

---

## Part 1: Spell Completeness Audit

### 1A. Base Spec Abilities

Every Vengeance DH has these abilities without any talent investment. Verify each is in `data/spells.json` with correct data.

**Cross-reference against the simc C++ source.** Search for `find_specialization_spell`, `find_class_spell`, and `find_spell(..., DEMON_HUNTER_VENGEANCE)` in `sc_demon_hunter.cpp`. Every spell found this way should be in our BASE_SPELL_IDS set (`src/model/vengeance-base.js`) and in `spells.json`.

For each base ability, verify:

- [ ] Present in spells.json with correct spell ID
- [ ] Present in BASE_SPELL_IDS
- [ ] School, resource cost, GCD, cooldown, duration, range are correct
- [ ] Effects array is populated and makes sense
- [ ] Description is present

**Also check:** Are there any `spec.*` assignments in `sc_demon_hunter.cpp` for Vengeance that we're missing? Search for `spec.` assignments in the Vengeance init section.

### 1B. Class-Wide Abilities

Abilities available to all Demon Hunter specs (Havoc, Vengeance, and the new Devourer). These should be in our class talent tree.

**Cross-reference:** Search for `find_class_spell` and talents in the class tree section of `sc_demon_hunter.cpp`. Every class-tree talent should appear in `talents.json` under the `class` tree.

For each:

- [ ] Present in talents.json class tree
- [ ] Corresponding spell in spells.json
- [ ] Not incorrectly classified as Vengeance-specific or Havoc-only

### 1C. Vengeance Spec Talents

Every `talent.vengeance.*` from `sc_demon_hunter.cpp` should be in our spec tree.

**Method:** Extract every `talent.vengeance.\w+ = find_talent_spell(...)` line from the C++ source. Cross-reference each against `talents.json` spec tree. Flag any that are:

- In simc C++ but missing from our data
- In our data but NOT in simc C++ (phantom talents)
- Named differently between simc and our data

### 1D. Hero Tree Talents

**Current hero trees for Vengeance:** Aldrachi Reaver, Fel-Scarred.
**New in midnight:** Devourer (shared hero tree).

For each hero tree:

- [ ] All talents present with correct spell IDs
- [ ] Verify against `sc_demon_hunter.cpp` hero tree sections (search for `talent.aldrachi_reaver.*`, `talent.felscarred.*`, `talent.devourer.*`)
- [ ] Determine which hero trees are available to Vengeance specifically (not all hero trees may be available to all specs)

**Critical:** Is Devourer available to Vengeance? Check the C++ source for spec restrictions on hero tree activation.

### 1E. Missing Spells

Search for spell IDs referenced in `sc_demon_hunter.cpp` (Vengeance sections) that are NOT in our `spells.json`:

- Triggered spells (from proc effects)
- Buff/debuff spells (applied by abilities)
- Damage component spells (secondary damage from abilities)
- Resource generation spells

These "hidden" spells are important for understanding interactions even though they're not directly castable.

---

## Part 2: Talent Tree Verification

### 2A. Tree Structure

For each tree (class, spec, each hero tree):

- [ ] Total talent count matches what simc reports
- [ ] Row/column positions are plausible (no overlaps, no gaps that shouldn't exist)
- [ ] Choice nodes are correctly represented (two talents at same position)
- [ ] Max rank values are correct (most are 1, some are 2)
- [ ] Required points thresholds match (reqPoints field in talentEntry)

### 2B. Position Freshness

**This is a known concern.** Talent positions may have changed between TWW and Midnight.

**Method:**

1. Check the simc midnight branch git log for recent talent tree restructuring commits
2. For a sample of 10+ talents, cross-reference positions against wowhead beta (https://www.wowhead.com/beta/spell={id}/{name})
3. If positions are stale, determine whether simc's talent positions matter for our APL work (they may not — the APL cares about talent names, not tree positions)

### 2C. Spec Assignment Accuracy

Our pipeline parses `talent.havoc.*` and `talent.vengeance.*` from `sc_demon_hunter.cpp` to determine spec ownership. Verify:

- [ ] Every Vengeance talent in simc C++ is in our spec tree
- [ ] No Havoc talents leaked through
- [ ] Talents that exist in BOTH specs (if any) are handled correctly
- [ ] The new Devourer spec's talents are properly excluded or included as appropriate

### 2D. Talent Categorization

Each talent is categorized as: `active_ability`, `off_gcd_ability`, `spell_modifier`, `proc_trigger`, `passive_buff`, `passive`, `other`.

Verify a sample of 20+ talents have correct categories. The categorization logic is in `talents.js` `categorizeTalent()` — check if it handles all effect types correctly.

---

## Part 3: Spell Data Verification

### 3A. Effects

For each active Vengeance ability (Fracture, Soul Cleave, Spirit Bomb, Fiery Brand, Fel Devastation, Immolation Aura, Sigil of Flame, Soul Carver, Sigil of Spite, Bulk Extraction):

- [ ] All effects are parsed (compare count against simc spell_query raw output in `data/raw/`)
- [ ] Effect types are correct (School Damage, Apply Aura, Proc Trigger Spell, etc.)
- [ ] AP coefficients are present for damage effects
- [ ] Base values and scaled values are populated
- [ ] Radius/range values are correct for AoE abilities
- [ ] Target types are correct

### 3B. Triggered Spells

Many abilities trigger secondary spells. Verify the trigger chain is captured:

- Fracture → Soul Fragment generation
- Spirit Bomb → Frailty application
- Immolation Aura → periodic damage ticks
- Soul Carver → Soul Fragment generation
- Sigil of Flame → ground effect damage
- Fiery Brand → DoT application
- Demonsurge variants (Soul Sunder, Spirit Burst)

For each trigger: is the triggered spell ID in our spells.json? Are the trigger conditions captured?

### 3C. Buffs, Debuffs, Auras

Catalog every buff and debuff that Vengeance DH applies or benefits from. Cross-reference against simc's buff initialization section (search for `make_buff` and `buff.` in `sc_demon_hunter.cpp`).

Key buffs to verify:

- Demon Spikes (defensive)
- Metamorphosis (offensive/defensive)
- Immolation Aura (damage)
- Fiery Brand (debuff on target)
- Frailty (debuff on target)
- Soul Furnace (damage amp)
- Rending Strike / Glaive Flurry (Aldrachi Reaver)
- Demonsurge variants (Fel-Scarred)
- Student of Suffering (Fel-Scarred)
- Any new Midnight-specific buffs

For each:

- [ ] Buff spell is in spells.json
- [ ] Duration is correct
- [ ] Max stacks (if applicable) is correct
- [ ] Effect (what the buff does) is captured

### 3D. DoTs and Periodic Effects

Verify all DoT/HoT/periodic effects:

- Fiery Brand DoT
- Sigil of Flame ground effect
- Immolation Aura periodic
- Frailty healing effect
- Any soul fragment periodic mechanics

### 3E. Resource Mechanics

Verify resource data is correct:

- Fury costs on all spenders (Soul Cleave, Spirit Bomb, Fel Devastation)
- Fury generation on all builders (Fracture, Shear, Immolation Aura ticks, Felblade)
- Soul Fragment generation sources and counts
- Soul Fragment consumption mechanics

### 3F. Affecting Spells (Modifiers)

The `affectingSpells` array on each spell lists what modifies it. This is the foundation of our interaction graph.

For a sample of 10 key abilities, verify:

- [ ] All listed modifiers actually exist and are relevant to Vengeance
- [ ] No important modifiers are missing (cross-reference with simc C++ `action_t::composite_*` methods)
- [ ] Modifier effect indices are correct

### 3G. Template Variable Resolution

Descriptions contain `$s1`, `$s2`, `$d`, `$SPC`, `$?s{id}[yes][no]`, and other template variables. These reference effect values from the spell data.

Assess:

- How many descriptions have unresolved variables?
- Can we resolve them using our parsed effect data? ($s1 = effect #1 base value, $s2 = effect #2 base value, $d = duration, etc.)
- Implement resolution if feasible, or document the mapping for future work

---

## Part 4: Interaction Graph Verification

### 4A. Unknown Interactions

149 of 207 interactions are typed "unknown". For each:

- Is the source spell in our collection? If not, should it be?
- Can the type be determined from the C++ source (search for where the modifier is applied)?
- Prioritize: which "unknown" interactions affect the top DPS abilities?

### 4B. Missing Interactions

Some interactions may not appear in the `affectingSpells` field but are implemented in C++. Search `sc_demon_hunter.cpp` for Vengeance-specific interaction code that modifies:

- Damage multipliers (`composite_da_multiplier`, `composite_ta_multiplier`)
- Cooldown adjustments (`cooldown->adjust`)
- Resource generation bonuses
- Duration extensions
- Proc chances

Flag any interactions found in C++ that are NOT in our interaction graph.

### 4C. Interaction Type Accuracy

For interactions that ARE typed, verify the type is correct. Sample 20+ and cross-reference with what the talent actually does (read the C++ implementation).

---

## Part 5: Pipeline Hardening

### 5A. Freshness Verification

Design and implement a verification system that can detect stale data:

1. **Simc version check** — Record the simc git hash used for extraction. On rebuild, warn if the hash has changed (meaning simc was updated and data should be re-extracted).

2. **Spell count check** — Record expected counts. Warn if counts change unexpectedly.

3. **Key spell ID check** — Maintain a list of "must-have" spell IDs. Fail the build if any are missing.

4. **Diff reporting** — When rebuilding, show what changed (new spells, removed spells, modified spells, moved talents).

### 5B. External Validation

Create a verification script (`src/verify.js` or similar) that:

1. Runs `npm run build-data` to regenerate everything
2. Checks all spell IDs against simc's spell_query to confirm they still exist
3. Verifies every `talent.vengeance.*` from the C++ source is in our talent tree
4. Verifies every base spec ability is in BASE_SPELL_IDS
5. Checks for Havoc contamination (no Havoc-only talents in our data)
6. Reports interaction coverage (% of interactions with known types)
7. Reports description template variable resolution coverage
8. Outputs a pass/fail summary with details on failures

### 5C. Adaptability for Future Changes

The system must handle:

- **New abilities added** — Detection: spell count changes, new `talent.vengeance.*` entries in C++
- **Abilities removed** — Detection: spell_query returns empty for a previously known ID
- **Abilities renamed** — Detection: spell ID exists but name changed
- **Talents moved in tree** — Detection: row/col changed for same talent entry
- **New hero trees** — Detection: new subtree IDs in talent query, new `talent.{treename}.*` sections in C++
- **Hero tree availability changes** — Detection: spec assignment changes in C++

For each scenario, the verification script should detect and report it clearly.

### 5D. Devourer Hero Tree

The Devourer is a new hero tree in Midnight. Determine:

- Is it available to Vengeance DH? (Check C++ source for spec restrictions)
- If yes, add it to the talent tree builder alongside Fel-Scarred and Aldrachi Reaver
- Extract and verify all Devourer talents
- Update the subtree ID mapping in spells.js

---

## Part 6: Data Model Improvements

### 6A. Spell Schema

Review the current spell object schema. Are we capturing everything we need? Consider adding:

- `spec` field on each spell (vengeance/havoc/shared/unknown)
- `category` field (builder/spender/cooldown/defensive/utility/passive)
- `resolvedDescription` with template variables filled in
- `triggerChain` — array of spell IDs this ability triggers
- `buffApplied` / `debuffApplied` — spell IDs of buffs/debuffs this creates

### 6B. Talent Schema

Review the talent object schema. Consider adding:

- `prereqs` — array of talent names/IDs required before this talent
- `choicePartner` — if this is a choice node, the other option's ID
- `simcName` — the snake_case name simc uses (for APL authoring)

### 6C. Interaction Schema

Review the interaction object. Consider:

- `magnitude` — the actual numeric value of the modification (e.g., "+15% damage")
- `conditions` — when the interaction applies (e.g., "only during Metamorphosis")
- `source_effect_index` — which effect on the source spell drives this interaction

---

## Deliverables

After completing the audit, produce:

1. **A verification report** (can be console output or markdown) listing:
   - Total spells, talents, interactions
   - Missing items found (with spell IDs)
   - Incorrect items found (with details)
   - Stale data found
   - Coverage statistics (% of interactions typed, % of descriptions resolved, etc.)

2. **Code fixes** for any issues found

3. **A verification script** (`src/verify.js`) that can be run anytime to re-check data integrity

4. **Updated PLAN.md** with findings and any new future work items

5. **Updated CLAUDE.md** if any new conventions, commands, or architectural decisions emerged

Work through this systematically. Read the source files, cross-reference against simc, fix issues as you find them, and build toward a self-verifying data pipeline.
