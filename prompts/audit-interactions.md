# Audit: Interaction Data Completeness

## Scope

Verify every talent→spell interaction in the dataset for **damage output** correctness. This audit covers direct damage, damage amplification, and indirect damage contributions (procs, resource generation that enables damage spells, cooldown reduction on damage abilities).

**Explicitly exclude** from damage-relevance:

- Healing (Charred Warblades, Soul Rending, Feast of Souls heal, Shattered Restoration)
- Damage reduction / mitigation (Painbringer, Demonic Wards, Calcified Spikes, Demonic Resilience, Fel Flame Fortification)
- Crowd control (Imprison, Sigil of Misery fear, Chaos Nova stun component)
- Movement / mobility (Pursuit, Blazing Path, Vengeful Retreat speed)
- Stat passives with no spell interaction (Will of the Illidari, Aldrachi Design, Illidari Knowledge, Internal Struggle, Erratic Felheart, Perfectly Balanced Glaive, Down in Flames, Unrestrained Fury)
- Utility (Darkness DR, Soul Barrier absorb, Sigil of Silence interrupt, Sigil of Chains pull)

A talent is **damage-relevant** if it: increases damage dealt, triggers a damage proc, grants/extends a damage buff, reduces a damage ability's cooldown, generates resources used by damage spells, or modifies a damage spell's mechanics (e.g., target count, AoE behavior).

## Data Files

Read these files from the project root:

| File                              | Shape                                                                                                                     | Description                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/spells.json`                | Array of 169 spell objects                                                                                                | VDH spell catalog. Keys: `name`, `id`, `school`, `schoolMask`, `effects`, `description`, `resolvedDescription`, `passive`, `affectingSpells` |
| `data/interactions.json`          | Object with `interactions` (array of 293), `talentCategories` (object, 121 talents), `bySpell`, `byTalent`                | Talent→spell interaction map                                                                                                                 |
| `data/talents.json`               | Object with `class` (45), `spec` (43), `hero.Aldrachi Reaver` (17), `hero.Annihilator` (16) = 121 total                   | Full talent tree. Each talent has: `name`, `spellId`, `maxRank`, `school`, `description`, `type`                                             |
| `data/cpp-effects-inventory.json` | Object with `parseEffects` (28), `parseTargetEffects` (4), `compositeOverrides` (8), `reactiveTriggers` (16), `stats` (4) | C++ implementation reference from `sc_demon_hunter.cpp`                                                                                      |

### Interaction Object Shape

```json
{
  "source": { "id": 123, "name": "Talent Name", "isTalent": true, "tree": "spec", "heroSpec": null },
  "target": { "id": 456, "name": "Spell Name" },
  "type": "damage_modifier|proc_trigger|buff_grant|cooldown_modifier|duration_modifier|resource_modifier|mechanic_change|range_modifier|stacking_modifier",
  "effects": [1, 2],
  "discoveryMethod": "spell_data|cpp_scanner|effect_scan",
  "confidence": "high|medium",
  "magnitude": { "value": 0.10, "unit": "percent|flat|sp_coefficient" },
  "application": "buff_on_player|debuff_on_target|...",
  "effectDetails": [...],
  "categories": [...]
}
```

### Talent Category Values

Each talent in `talentCategories` is classified as one of:

- `has_interactions` — interactions exist in the data
- `cpp_only` — referenced in C++ but no spell_data/effect_scan interactions
- `stat_passive` — pure stat bonus, no spell interaction
- `self_buff` — grants a buff but classified separately
- `active_ability` — an ability itself, not a modifier

## Procedure

### Step 1: Load and Index

1. Read all four data files.
2. Build a lookup: talent name → all interactions where `source.name` matches.
3. Build a reverse lookup: spell name → all interactions where `target.name` matches.
4. Index spells by school for school-targeting verification.

### Step 2: Per-Talent Audit (121 talents)

For **each** of the 121 talents in `talentCategories`:

#### 2a. Read the Description

Find the talent in `talents.json` by name. Read its `description` field. Understand what the talent actually does.

#### 2b. Classify Damage Relevance

Based on the description, determine if this talent affects damage output (per the scope definition above). Compare against its current `talentCategories` classification.

- If classified `stat_passive` or `active_ability` → confirm it truly has no damage interaction. If it does affect damage, flag as **miscategorized**.
- If classified `cpp_only` → check if a spell_data or effect_scan interaction _should_ exist but is missing.
- If classified `has_interactions` → proceed to Step 2c.

#### 2c. Verify Interactions (for damage-relevant talents with interactions)

For each interaction sourced from this talent:

1. **Target completeness:** Are all affected spells listed? If the talent description says "increases Fire damage by X%", check that _every_ Fire-school spell in `spells.json` is targeted (either directly or via `schoolTarget`).
2. **Magnitude accuracy:** Compare `magnitude.value` against the talent's `resolvedDescription` or `description` values. A talent saying "increases damage by 6%" should have `magnitude.value: 0.06` (or `6` with `unit: percent` — verify unit consistency).
3. **Unit correctness:** Is `magnitude.unit` appropriate? Percent modifiers should be `percent`, not `flat`. Spell coefficients should be `sp_coefficient`.
4. **Rank scaling:** If `maxRank > 1`, verify `magnitude` reflects per-rank value and the talent entry has correct `maxRank`.
5. **Interaction type:** Does the `type` match what the talent does? A damage amp should be `damage_modifier`, not `buff_grant`. A proc that deals damage should be `proc_trigger`.
6. **Spec contamination:** Verify `source.tree` is `class`, `spec`, `Aldrachi Reaver`, or `Annihilator`. Flag any Havoc, Devourer, or Scarred sources.
7. **Duplicate check:** Flag if this talent has multiple interactions to the same target with the same type.

#### 2d. Flag Missing Interactions (for damage-relevant talents WITHOUT interactions)

If a talent is damage-relevant but has no interactions (or is `cpp_only`):

- Describe what interaction(s) should exist.
- Note the expected type, targets, and magnitude if determinable from the description.

### Step 3: Per-Spell Verification

For each of these core damage spells, verify interaction completeness:

| Spell            | School        | Expected Modifier Sources                                      |
| ---------------- | ------------- | -------------------------------------------------------------- |
| Spirit Bomb      | Fire          | Burning Blood, Fiery Demise, Charred Flesh, Void Reaver, etc.  |
| Soul Cleave      | Shadow        | Focused Cleave, Void Reaver, etc.                              |
| Fracture / Shear | Physical      | (base builders, check for modifiers)                           |
| Immolation Aura  | Fire          | Agonizing Flames, Burn It Out, Stoke the Flames, Burning Blood |
| Sigil of Flame   | Fire          | Ascending Flame, Quickened Sigils, Burning Blood, Fiery Demise |
| Fiery Brand      | Fire          | Burning Alive, Charred Flesh, Down in Flames, Fiery Demise     |
| Fel Devastation  | Fire          | Stoke the Flames, Burning Blood, Fiery Demise                  |
| Soul Carver      | Fire          | Fiery Demise, Burning Blood                                    |
| The Hunt         | —             | (check if present in spell catalog)                            |
| Elysian Decree   | —             | (check if present in spell catalog)                            |
| Felblade         | Fire          | (check modifiers)                                              |
| Infernal Strike  | Fire/Physical | (two spell IDs — 189110 Physical, 189112 Fire)                 |
| Throw Glaive     | Physical      | Bouncing Glaives, Master of the Glaive, Champion of the Glaive |
| Sigil of Spite   | —             | (check if present and has interactions)                        |
| Chaos Nova       | Chromatic     | (damage component, check Mastery interaction)                  |

For each spell:

1. Is the `school` and `schoolMask` correct?
2. Are all modifiers that should affect it present in interactions?
3. Do school-wide modifiers (Burning Blood affects Fire, Fiery Demise affects Fire) correctly include this spell if its school matches?
4. Are there duplicate interactions (same source→target, same type)?

### Step 4: Cross-Reference C++ Inventory

For each entry in `cpp-effects-inventory.json`:

#### parseEffects / parseTargetEffects

Each entry has a `buff` name and optional `effectMask`. Verify that:

- A corresponding interaction exists in `interactions.json` for the buff/talent.
- If no interaction exists, determine if the C++ effect is damage-relevant. If yes, flag as **missing interaction**.

#### compositeOverrides

These modify calculated stats (like attack power, haste). Check if any are damage-relevant and whether they're reflected in interactions.

#### reactiveTriggers

These are proc triggers from the C++ implementation. Verify each damage-relevant trigger has a matching `proc_trigger` interaction.

### Step 5: School Targeting Completeness

For every interaction that uses school-based targeting (any interaction with `categories` containing school references, or whose source talent description mentions a school):

1. List all spells in `spells.json` with a matching `school`.
2. Compare against the interaction's actual targets.
3. Flag any spells that should be included but aren't.

### Step 6: Duplicate Detection

Scan all 293 interactions for duplicates: same `source.id` → same `target.id` with same `type`. Report any found.

## Output Format

Produce a structured report with these sections:

```markdown
## Audit Summary

- **Total talents audited:** N/121
- **Total interactions checked:** N/293
- **Issues found:** N
- **Missing interactions:** N
- **Confirmed exclusions:** N

## Issues Found

For each issue:

### [Talent Name] — [Issue Type]

- **Category:** miscategorized | wrong_magnitude | wrong_unit | wrong_type | missing_target | duplicate | spec_contamination | wrong_rank
- **Current:** [what the data says]
- **Expected:** [what it should be]
- **Evidence:** [description text, spell data, or C++ reference]

## Missing Interactions

For each gap:

### [Talent Name]

- **Description:** [what the talent does]
- **Expected interaction:** type=[type], targets=[spell names], magnitude=[value if known]
- **Source:** [how we know — description, C++ reference, etc.]

## Confirmed Exclusions

Talents correctly excluded from damage interactions:

| Talent   | Category       | Reason                          |
| -------- | -------------- | ------------------------------- |
| Imprison | active_ability | CC ability, no damage component |
| ...      | ...            | ...                             |

## C++ Coverage

| C++ Category       | Total | Matched | Unmatched (damage-relevant) |
| ------------------ | ----- | ------- | --------------------------- |
| parseEffects       | 28    | N       | N                           |
| parseTargetEffects | 4     | N       | N                           |
| compositeOverrides | 8     | N       | N                           |
| reactiveTriggers   | 16    | N       | N                           |

## Duplicates

[List any duplicate source→target pairs with same type]

## School Targeting

[List any school-wide modifiers with missing spell targets]
```

## Completion Criteria

The audit is complete when:

1. All 121 talents have been evaluated and classified
2. All core damage spells have been cross-checked
3. All C++ inventory entries have been matched or flagged
4. School targeting has been verified for all school-wide modifiers
5. The output report has all sections populated
6. Every issue has enough detail to be actionable (fix the data, not "investigate further")
