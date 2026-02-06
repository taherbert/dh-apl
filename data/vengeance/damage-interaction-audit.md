# Interaction Data Completeness Audit — Damage Output

**Date:** 2026-02-02
**Branch:** `audit/interaction-data`
**Data snapshot:** 293 interactions, 121 talents, 169 spells

---

## Audit Summary

- **Total talents audited:** 121/121
- **Total interactions checked:** 293
- **Issues found:** 8
- **Missing interactions (damage-relevant cpp_only):** 19
- **Confirmed non-damage exclusions:** 34
- **Duplicates found:** 1 (Burning Alive → Fiery Brand)
- **Borderline cases:** 5

---

## Issues Found

### 1. Soul Cleave — school confirmed Physical

- **Category:** resolved (no action needed)
- **Current:** `school: Physical`, `schoolMask: 1` (both spell IDs 228477, 228478)
- **Verification:** Spell data effect explicitly says `School Damage (2): physical`. The C++ `soul_cleave_t` inherits school from spell data with no override. Physical is correct.
- **Impact:** None. School-wide Fire modifiers (Burning Blood, Fiery Demise) correctly exclude Soul Cleave. No Shadow school data exists for Soul Cleave in any source.

### 2. Vengeful Bonds — miscategorized

- **Category:** miscategorized
- **Current:** `cpp_only` — classified as damage-relevant override
- **Expected:** **Not damage-relevant.** Description: "Vengeful Retreat reduces the movement speed of all nearby enemies by 70% for 3s." This is a slow effect only. VR itself deals damage (via spell 198813 effect 2), but Vengeful Bonds adds the slow, not damage.
- **Evidence:** Talent description contains no damage component. Spell 198813 effect 1 is the slow, effect 2 is damage that exists on VR baseline.
- **Action:** Remove from missing interactions list. Add to confirmed non-damage exclusions.

### 3. Unhindered Assault — wrong_expected_interaction

- **Category:** miscategorized
- **Current:** `cpp_only`, flagged as "VR damage + range increase"
- **Expected:** Description says "Vengeful Retreat resets the cooldown of Felblade." This is a cooldown_modifier on Felblade, not a VR damage increase. Damage-relevant because it enables more Felblade casts.
- **Evidence:** Talent description in `talents.json`.
- **Action:** Should have interaction: `type=cooldown_modifier, target=Felblade`

### 4. Burning Blood — targeting verified correct

- **Category:** resolved (no action needed)
- **Current:** Burning Blood targets 14 Fire spells including `Infernal Armor` (320334, Fire school). The Fire spells NOT targeted are: Painbringer, Burning Alive, Fiery Demise, Frailty, Revel in Pain.
- **Expected:** These 5 "Fire" spells are buff/debuff auras, not direct damage spells. Burning Blood correctly excludes them — it uses spell-level targeting via `affectedSpells` lists, not raw school matching.
- **Impact:** No action needed. Burning Blood targeting is correct.

### 5. Fiery Demise — self_interaction is expected behavior

- **Category:** resolved (expected)
- **Current:** Fiery Demise has an interaction targeting itself: `Fiery Demise → Fiery Demise (damage_modifier)`
- **Explanation:** Fiery Demise (spell 389220) is a passive that increases Fire damage dealt to Fiery Brand targets by 15% per rank. Its effect modifies Fiery Brand spell variants (207744, 207771) via `Apply Flat Modifier w/ Label: Spell Effect 2`. Since Fiery Brand's effect 2 is `Modify Damage Taken% from Caster's Spells`, Fiery Demise amplifies the damage bonus that Fiery Brand already applies. The self-reference in the interaction graph reflects this: Fiery Demise modifies the Fiery Brand debuff, which in turn modifies all caster damage to branded targets. This is correct and expected.
- **Action:** No change needed. Add a note that this is a modifier-on-modifier pattern, not erroneous self-reference.

### 6. Infernal Armor — 6 interactions targeting distinct Immo Aura spell IDs

- **Category:** verified (no action needed)
- **Current:** Infernal Armor has 6 interactions all targeting `Immolation Aura` with type `damage_modifier`. There are 11 Immolation Aura spell variants in `spells.json`.
- **Verification:** Each interaction targets a distinct Immolation Aura spell ID. Immo Aura has multiple spell entries for different ranks, talent variants, and triggered effects. 6 of 11 are damage-dealing variants that Infernal Armor correctly modifies.
- **Action:** No dedup needed. These are legitimate distinct-target interactions.

### 7. Burning Alive — genuine duplicate

- **Category:** duplicate
- **Current:** `Burning Alive → Fiery Brand (duration_modifier)` appears twice. Both entries have identical source.id (207739) and target.id (204021) with same type and discoveryMethod (cpp_scanner).
- **Expected:** Single interaction. Burning Alive spreads Fiery Brand to nearby enemies — one duration_modifier interaction is correct.
- **Action:** Deduplicate — remove one of the two identical interactions in `interactions.json`.

### 8. Stoke the Flames — verified complete

- **Category:** resolved (no action needed)
- **Current:** Stoke the Flames only modifies Fel Devastation (35% damage increase). Description confirms: "Fel Devastation damage increased by 35%."
- **Impact:** None — interaction is complete.

---

## Not Duplicates (Corrected from Previous Audit)

The previous audit incorrectly flagged Felfire Fist and Doomsayer as having duplicate interactions. These are distinct interactions targeting different buff states:

### Felfire Fist (source.id: 389724) — 3 distinct interactions

| #   | Target                          | Type         | Notes                                             |
| --- | ------------------------------- | ------------ | ------------------------------------------------- |
| 1   | Infernal Strike (189110)        | proc_trigger | Felfire Fist triggers on Infernal Strike impact   |
| 2   | buff:felfire_fist_in_combat     | buff_grant   | In-combat buff state (talent_gates_buff mechanic) |
| 3   | buff:felfire_fist_out_of_combat | buff_grant   | Out-of-combat buff state                          |

These are unrelated to Burning Alive or Doomsayer. The in_combat/out_of_combat split represents different buff tracking states, not duplicates.

### Doomsayer (source.id: 1253676) — 3 distinct interactions

| #   | Target                       | Type         | Notes                                |
| --- | ---------------------------- | ------------ | ------------------------------------ |
| 1   | World Killer (1256353)       | proc_trigger | Doomsayer triggers World Killer proc |
| 2   | buff:doomsayer_in_combat     | buff_grant   | In-combat buff state                 |
| 3   | buff:doomsayer_out_of_combat | buff_grant   | Out-of-combat buff state             |

---

## Missing Interactions (Damage-Relevant cpp_only Talents)

These 19 talents are classified `cpp_only` and appear damage-relevant but lack spell_data/effect_scan interactions. Many have no resolved descriptions (Midnight expansion data gap).

### Damage Modifiers

| Talent         | Tree            | Description                                                                              | Expected Interaction                                                                                                                |
| -------------- | --------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Vulnerability  | spec (rank 2)   | "Frailty now also increases all damage you deal to afflicted targets by $s1%."           | `damage_modifier` on all abilities via Frailty debuff. C++ confirms: `parse_target_effects(frailty)` with Vulnerability percentage. |
| Retaliation    | spec            | "While Demon Spikes is active, melee attacks cause $391159s1 Physical damage."           | `proc_trigger` — reactive damage proc (confirmed by C++ `reactiveTriggers`)                                                         |
| Tempered Steel | spec            | _(no desc)_                                                                              | `damage_modifier` on Throw Glaive + `resource_modifier` for Fury gen                                                                |
| Focused Ire    | class           | _(no desc)_                                                                              | `damage_modifier` — likely single-target damage bonus                                                                               |
| Keen Edge      | Aldrachi Reaver | _(no desc)_                                                                              | `damage_modifier` on Reaver's Glaive                                                                                                |
| Wounded Quarry | Aldrachi Reaver | "Physical damage to any enemy also deals $s1% of damage dealt to marked target as Chaos" | `proc_trigger` — echo damage to Reaver's Mark target                                                                                |

### Resource / Cooldown Modifiers

| Talent             | Tree            | Description                                         | Expected Interaction                                                  |
| ------------------ | --------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Furious            | class           | _(no desc)_                                         | `resource_modifier` — Fury generation increase                        |
| Remorseless        | class           | _(no desc)_                                         | `resource_modifier` — bonus Fury on first hit                         |
| Burn It Out        | class           | _(no desc)_                                         | `mechanic_change` on Immolation Aura — faster ticks, higher Fury cost |
| Phase Shift        | Annihilator     | _(no desc)_                                         | `resource_modifier` — Sigil of Flame generates Fury                   |
| Path to Oblivion   | Annihilator     | _(no desc)_                                         | `resource_modifier` — Voidfall gives additional Fury                  |
| Soul Splitter      | class (rank 2)  | _(no desc)_                                         | `resource_modifier` — Soul Carver generates extra fragments           |
| Wings of Wrath     | class           | _(no desc)_                                         | `cooldown_modifier` — Sigil of Flame extra charge                     |
| Unhindered Assault | Aldrachi Reaver | "Vengeful Retreat resets the cooldown of Felblade." | `cooldown_modifier` on Felblade                                       |
| Otherworldly Focus | Annihilator     | _(no desc)_                                         | `cooldown_modifier` — Voidfall CDR from ability usage                 |

### Proc / Mechanic

| Talent         | Tree            | Description | Expected Interaction                                                    |
| -------------- | --------------- | ----------- | ----------------------------------------------------------------------- |
| Final Breath   | class           | _(no desc)_ | `mechanic_change` — Fel Devastation healing converts to damage          |
| Vengeful Beast | spec            | _(no desc)_ | `damage_modifier` or `buff_grant` — damage bonus on Frailty application |
| Broken Spirit  | Aldrachi Reaver | _(no desc)_ | `duration_modifier` on Frailty                                          |
| Swift Erasure  | Annihilator     | _(no desc)_ | `mechanic_change` — Reaver's Mark expires faster                        |

### Annihilator Hero Talents (all lack descriptions)

| Talent             | Expected Interaction                                |
| ------------------ | --------------------------------------------------- |
| State of Matter    | `damage_modifier` — Meteoric damage bonus           |
| Harness the Cosmos | `damage_modifier` — Voidfall damage amplification   |
| Celestial Echoes   | `stacking_modifier` — Voidfall proc chance increase |
| Final Hour         | `damage_modifier` — Catastrophe empowerment         |

### Damage-Relevant Stat Passives (Missing Interactions)

These talents grant stats that directly increase damage output but have no interactions:

| Talent            | Stat    | Description                                  | Expected Interaction                                                                                   |
| ----------------- | ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Internal Struggle | Mastery | "Increases your mastery by ${$s1\*$mas}.1%." | `stat_modifier` on mastery. Mastery: Fel Blood increases attack power for VDH. Direct damage increase. |

Note: Internal Struggle grants mastery, not versatility as previously reported. For VDH, Mastery: Fel Blood increases attack power, which scales all damage. This needs an interaction or at minimum documentation that mastery scaling is handled implicitly by SimC's stat system rather than explicit interactions.

---

## Confirmed Non-Damage Exclusions

| Talent                    | Category         | Reason                                                                                                                                                                                                                 |
| ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imprison                  | active_ability   | CC ability, no damage component                                                                                                                                                                                        |
| Sigil of Misery           | has_interactions | CC fear effect only                                                                                                                                                                                                    |
| Shattered Restoration     | has_interactions | Healing only — increased healing received                                                                                                                                                                              |
| Charred Warblades         | cpp_only         | Healing only — leech from Fire damage                                                                                                                                                                                  |
| Soul Rending              | has_interactions | Healing only — leech during Metamorphosis                                                                                                                                                                              |
| Feast of Souls            | has_interactions | Healing only — heal on Soul Cleave                                                                                                                                                                                     |
| Live by the Glaive        | has_interactions | Healing only — Throw Glaive heals                                                                                                                                                                                      |
| Painbringer               | self_buff        | Damage reduction debuff on target (not a damage amp)                                                                                                                                                                   |
| Calcified Spikes          | cpp_only         | Damage reduction — Demon Spikes armor                                                                                                                                                                                  |
| Demonic Resilience        | cpp_only         | Damage reduction — max HP and magic DR                                                                                                                                                                                 |
| Fel Flame Fortification   | cpp_only         | Damage reduction — Immo Aura gives DR and armor                                                                                                                                                                        |
| Demon Muzzle              | cpp_only         | Defensive — reduces target damage after Sigil of Silence                                                                                                                                                               |
| Revel in Pain             | has_interactions | Defensive — absorb shield from Soul Cleave                                                                                                                                                                             |
| Ruinous Bulwark           | has_interactions | Defensive — Fel Dev overhealing → absorb                                                                                                                                                                               |
| Soul Barrier              | cpp_only         | Defensive — absorb shield                                                                                                                                                                                              |
| Soulmonger                | cpp_only         | Defensive — Soul Fragment shield                                                                                                                                                                                       |
| Last Resort               | cpp_only         | Defensive — cheat death                                                                                                                                                                                                |
| Feed the Demon            | cpp_only         | Defensive — Soul Fragment reduces DS cooldown                                                                                                                                                                          |
| Army Unto Oneself         | cpp_only         | Defensive — leech from Frailty                                                                                                                                                                                         |
| Incorruptible Spirit      | cpp_only         | Defensive — reduced CD on Consume Magic                                                                                                                                                                                |
| First In, Last Out        | cpp_only         | Defensive — grants rapidly decaying absorb shield on Infernal Strike. Description: "Infernal Strike grants you a rapidly decaying shield equal to $s1% of your maximum health." C++ marks it NYI. No damage component. |
| Darkness                  | has_interactions | Utility — avoidance zone                                                                                                                                                                                               |
| Long Night                | has_interactions | Utility — extends Darkness                                                                                                                                                                                             |
| Pitch Black               | has_interactions | Utility — reduces Darkness CD                                                                                                                                                                                          |
| Vengeful Bonds            | cpp_only         | Utility — adds slow to Vengeful Retreat, no damage component                                                                                                                                                           |
| Soul Cleanse              | cpp_only         | Utility — Consume Magic removes additional buff                                                                                                                                                                        |
| Lost in Darkness          | cpp_only         | Utility — reduces Spectral Sight CD                                                                                                                                                                                    |
| Improved Disrupt          | cpp_only         | Utility — increases Disrupt range                                                                                                                                                                                      |
| Pursuit                   | cpp_only         | Movement — speed and Fel Rush utility                                                                                                                                                                                  |
| Will of the Illidari      | stat_passive     | Stat passive — max HP (non-damage)                                                                                                                                                                                     |
| Aldrachi Design           | stat_passive     | Stat passive — armor (non-damage)                                                                                                                                                                                      |
| Illidari Knowledge        | stat_passive     | Stat passive — magic DR (non-damage)                                                                                                                                                                                   |
| Perfectly Balanced Glaive | stat_passive     | Stat passive — parry (non-damage)                                                                                                                                                                                      |
| Improved Sigil of Misery  | stat_passive     | Stat passive — Sigil of Misery range (CC only)                                                                                                                                                                         |

### Borderline Cases

| Talent                             | Decision        | Rationale                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Down in Flames                     | **Include**     | Extra Fiery Brand charges + reduced cooldown. Fiery Brand is a damage-amplifying ability via Fiery Demise (+15% Fire damage to branded targets), Charred Flesh (extends brand duration on hit), and Burning Alive (spreads brand). More casts = more damage amp uptime. Type: `cooldown_modifier` + `stacking_modifier` on Fiery Brand.           |
| Unrestrained Fury                  | **Borderline**  | +20 max Fury enables better pooling and avoids overcap during high-generation windows. Indirect damage increase through better resource utilization. Type: `resource_modifier` on Fury capacity. Not a direct damage modifier but affects APL decision-making and burst windows.                                                                  |
| Blazing Path                       | **Conditional** | Extra Infernal Strike charge. Damage-relevant when combined with Felfire Fist (triggers damage proc on Infernal Strike) or Doomsayer (triggers World Killer on Infernal Strike). Without those talents, purely mobility. Type: `stacking_modifier` on Infernal Strike charges.                                                                    |
| Erratic Felheart                   | **Conditional** | Reduces Infernal Strike cooldown by $s1% per rank (NOT a speed stat passive as previously reported). Damage-relevant via same Felfire Fist/Doomsayer synergy as Blazing Path — more frequent Infernal Strikes means more proc triggers. Type: `cooldown_modifier` on Infernal Strike.                                                             |
| Sigil of Silence / Sigil of Chains | **Conditional** | When Soul Sigils is talented, casting any sigil generates Lesser Soul Fragments. Soul Fragments fuel Spirit Bomb damage. These sigils are utility abilities with an indirect damage path through Soul Sigils → Soul Fragments → Spirit Bomb. The Soul Sigils interaction should reference Sigil of Silence and Sigil of Chains as valid triggers. |
| Felbound                           | **Unknown**     | No description available. cpp_only. Cannot classify without description. Spell ID 1266762.                                                                                                                                                                                                                                                        |

---

## C++ Coverage

### parseEffects (28 total)

| Buff                           | Context              | Damage-Relevant?  | Has Interaction? | Notes                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------- | ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| demon_soul                     | demon_hunter_pet_t   | Havoc             | N/A              | Havoc-only (Fel-Scarred)                                                                                                                                                                                                                                         |
| empowered_demon_soul           | demon_hunter_pet_t   | Havoc             | N/A              | Havoc-only (Fel-Scarred)                                                                                                                                                                                                                                         |
| metamorphosis + monster_within | demon_hunter_pet_t   | Yes               | **No**           | Mastery scaling in Meta — interactions exist for Metamorphosis but not via this parse_effects path                                                                                                                                                               |
| feast_of_souls                 | demon_hunter_pet_t   | No                | Yes (excluded)   | Healing buff                                                                                                                                                                                                                                                     |
| rolling_torment                | demon_hunter_pet_t   | Yes (Devourer)    | N/A              | Devourer hero tree buff — damage modifier on abilities. Not VDH Aldrachi/Annihilator.                                                                                                                                                                            |
| impending_apocalypse           | demon_hunter_pet_t   | Yes (Devourer)    | N/A              | Devourer hero tree buff — conditional damage buff during Voidblade chains. Not VDH.                                                                                                                                                                              |
| exergy                         | demon_hunter_pet_t   | Havoc             | N/A              | Havoc talent — damage amplification buff triggered by various abilities.                                                                                                                                                                                         |
| inertia                        | demon_hunter_pet_t   | Havoc             | N/A              | Havoc talent                                                                                                                                                                                                                                                     |
| empowered_eye_beam             | demon_hunter_pet_t   | Havoc             | N/A              | Havoc talent                                                                                                                                                                                                                                                     |
| warblades_hunger               | demon_hunter_pet_t   | Yes               | **Yes**          | Warblade's Hunger has interactions                                                                                                                                                                                                                               |
| thrill_of_the_fight_damage     | demon_hunter_pet_t   | Yes               | **Yes**          | Thrill of the Fight has interactions                                                                                                                                                                                                                             |
| enduring_torment               | demon_hunter_pet_t   | Yes (Scarred)     | N/A              | Fel-Scarred hero tree — haste buff via `set_pct_buff_type(STAT_PCT_BUFF_HASTE)`. Not VDH.                                                                                                                                                                        |
| demonsurge_demonsurge          | demon_hunter_pet_t   | Havoc/Scarred     | N/A              | Fel-Scarred hero                                                                                                                                                                                                                                                 |
| demonsurge_demonic_intensity   | demon_hunter_pet_t   | Havoc/Scarred     | N/A              | Fel-Scarred                                                                                                                                                                                                                                                      |
| demonsurge                     | demon_hunter_pet_t   | Havoc/Scarred     | N/A              | Fel-Scarred                                                                                                                                                                                                                                                      |
| voidsurge                      | demon_hunter_pet_t   | Yes (Annihilator) | No               | Annihilator proc — **missing interaction**                                                                                                                                                                                                                       |
| blur                           | parse_player_effects | Havoc             | N/A              | Havoc defensive                                                                                                                                                                                                                                                  |
| blur                           | parse_player_effects | Havoc             | N/A              | Duplicate Havoc                                                                                                                                                                                                                                                  |
| demon_spikes                   | parse_player_effects | No (defensive)    | No               | Armor/parry buff                                                                                                                                                                                                                                                 |
| seething_anger                 | parse_player_effects | Yes (VDH)         | No               | Untethered Rage 3 talent — stacking buff that increases proc chance for untethered_rage. Triggers when untethered_rage fails to proc on soul consumption. `set_default_value_from_effect(1)`. Indirect damage amplifier via proc chain. **Missing interaction.** |
| fel_blood_rank_2               | parse_player_effects | No (defensive)    | No               | Mastery DR component                                                                                                                                                                                                                                             |
| thrill_of_the_fight_haste      | parse_player_effects | Yes               | **Yes**          | Haste → faster attacks/casts                                                                                                                                                                                                                                     |
| voidfall_building              | parse_player_effects | Yes (Annihilator) | No               | Voidfall stacking buff — **missing**                                                                                                                                                                                                                             |
| voidfall_spending              | parse_player_effects | Yes (Annihilator) | No               | Voidfall spending buff — **missing**                                                                                                                                                                                                                             |
| voidfall_final_hour            | parse_player_effects | Yes (Annihilator) | No               | Final Hour empowered Voidfall — **missing**                                                                                                                                                                                                                      |

### parseTargetEffects (4 total)

| Debuff         | Damage-Relevant? | Has Interaction? | Notes                                                                                                                          |
| -------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| devourers_bite | Yes (Devourer)   | N/A              | Devourer hero — not VDH Aldrachi/Annihilator                                                                                   |
| burning_wound  | Yes (Havoc)      | N/A              | Havoc talent                                                                                                                   |
| frailty        | Yes              | **Yes**          | Frailty has damage_modifier interactions. C++ shows effect mask enabling effects 4,5 with Vulnerability/Soulcrush percentages. |
| fiery_brand    | Mixed            | **Yes**          | Fiery Brand debuff has interactions. C++ disables effect 4 (DR component).                                                     |

### compositeOverrides (8 total)

| Function                | Context                      | Talent                           | Damage-Relevant (VDH)? | Notes                                                    |
| ----------------------- | ---------------------------- | -------------------------------- | ---------------------- | -------------------------------------------------------- |
| composite_da_multiplier | demon_hunter_pet_t           | chaotic_disposition (havoc)      | N/A                    | Havoc                                                    |
| composite_ta_multiplier | demon_hunter_pet_t           | chaotic_disposition (havoc)      | N/A                    | Havoc                                                    |
| composite_da_multiplier | otherworldly_focus_benefit_t | otherworldly_focus (annihilator) | **Yes**                | Annihilator talent — **missing interaction**             |
| composite_da_multiplier | surge_base_t                 | focused_hatred (scarred)         | N/A                    | Fel-Scarred                                              |
| composite_da_multiplier | reap_t                       | focused_ray (devourer)           | N/A                    | Devourer                                                 |
| composite_da_multiplier | hungering_slash_base_t       | singular_strikes (devourer)      | N/A                    | Devourer                                                 |
| composite_da_multiplier | auto_attack_t                | first_blood (havoc)              | N/A                    | Havoc                                                    |
| composite_da_multiplier | soul_cleave_t                | focused_cleave (vengeance)       | **Yes**                | **Has interaction** — Focused Cleave → Soul Cleave (50%) |

### reactiveTriggers (16 total)

| Source            | Trigger              | Type                | Damage-Relevant (VDH)? | Notes                                                                            |
| ----------------- | -------------------- | ------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| assess_damage     | infernal_armor       | reactive_proc       | Yes                    | Infernal Armor fire damage on hit — **has interactions** (6x Immo Aura modifier) |
| assess_damage     | infernal_armor       | reactive_proc       | Yes                    | Duplicate with additional DS condition                                           |
| assess_damage     | retaliation          | reactive_proc       | **Yes**                | Retaliation damage proc — **missing interaction**                                |
| target_mitigation | illidari_knowledge   | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | blur (x2)            | mitigation_modifier | No                     | Havoc defensive                                                                  |
| target_mitigation | demonic_wards (x2)   | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | demonic_wards_2 (x2) | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | demonic_wards_3      | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | demon_hide           | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | painbringer          | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | demon_spikes_buff    | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | fiery_brand_debuff   | mitigation_modifier | No                     | DR only                                                                          |
| target_mitigation | frailty_debuff       | mitigation_modifier | No                     | DR only                                                                          |

### C++ Coverage Summary

| C++ Category       | Total | VDH-Relevant | Matched | Unmatched (damage-relevant)                                                              |
| ------------------ | ----- | ------------ | ------- | ---------------------------------------------------------------------------------------- |
| parseEffects       | 28    | ~11          | 4       | 5 (voidsurge, voidfall_building, voidfall_spending, voidfall_final_hour, seething_anger) |
| parseTargetEffects | 4     | 2            | 2       | 0                                                                                        |
| compositeOverrides | 8     | 2            | 1       | 1 (otherworldly_focus)                                                                   |
| reactiveTriggers   | 16    | 2            | 1\*     | 1 (retaliation)                                                                          |

\*Infernal Armor has interactions but they're modifiers on Immo Aura, not a reactive proc interaction.

---

## Duplicates

| Source        | Target               | Type              | Occurrences | Action                                                                                      |
| ------------- | -------------------- | ----------------- | ----------- | ------------------------------------------------------------------------------------------- |
| Burning Alive | Fiery Brand (204021) | duration_modifier | 2           | Deduplicate — both entries are identical (same source.id, target.id, type, discoveryMethod) |

---

## Multi-Effect Spell Coverage

Many VDH spells have multiple effects (initial hit, DoT, AoE splash, etc.) with different schools or coefficients. Interactions that specify `effects: [1, 2]` arrays target specific effect indices rather than the whole spell.

Notable multi-effect interactions:

- **Mastery: Demonic Presence** targets effects [1, 2] on damage spells — effect 1 is typically direct amount modifier, effect 2 is periodic amount modifier. Both are damage-relevant.
- **Fiery Brand** debuff targets effect [2] (`Modify Damage Taken% from Caster's Spells`) — correctly skipping effect 1 (the direct hit) and effect 4 (DR component, disabled in C++).
- **Fiery Demise** targets effect [1] on Fiery Brand variants — modifies the damage amp percentage specifically.

Interactions with effect arrays are correctly identifying which effects they modify. No cases found where an interaction targets the wrong effect index.

---

## School Targeting

No interactions are tagged with `categories: ["school_target"]` (schoolTargetingModifiers = 0). School-wide modifiers like Burning Blood and Fiery Demise use spell-level `affectedSpells` lists rather than school-based matching.

### Burning Blood School Coverage

Burning Blood targets 14 spells across Fire and Chromatic schools. All damage-dealing Fire spells are covered. Non-damage Fire auras (Painbringer, Burning Alive, Fiery Demise, Frailty, Revel in Pain) are correctly excluded as they're buff/debuff spells without direct damage components.

### Fiery Demise School Coverage

Fiery Demise targets 17 spells with damage_modifier. It covers all major damage abilities including non-Fire spells (Shear, Fracture — Physical). This is correct: Fiery Demise increases all damage to Fiery Brand targets, not just Fire damage. The self-referencing interaction (Fiery Demise → Fiery Demise) is expected behavior — see Issue #5 above.

---

## Uncategorized Interaction Sources

These 6 sources appear in `interactions` but are not in `talentCategories`:

| Source                    | Interactions | Notes                                                                                         |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Mastery: Demonic Presence | 1            | Spec mastery, not a talent. Correctly excluded from talent categories.                        |
| Rush of Chaos             | 1            | Passive effect, may not be a selectable talent.                                               |
| Metamorphosis             | 3            | Active ability/cooldown, not a talent modifier.                                               |
| Mastery: Fel Blood        | 1            | Spec mastery.                                                                                 |
| Extended Spikes           | 1            | Defensive talent (DS duration).                                                               |
| Immolation Aura           | 30           | Active ability — its self-referencing buff_grant interactions represent Immo Aura's own buff. |

These are expected: masteries and active abilities are interaction sources but not entries in the talent category system.

---

## Key Findings & Recommendations

### Critical (affect simulation accuracy)

1. **Vulnerability (spec, rank 2):** Major damage modifier — "Frailty increases all damage to afflicted targets by $s1%." This is a universal damage amp and lacks a spell_data interaction. The C++ parseTargetEffects confirms it's implemented via the Frailty debuff with Vulnerability percentage. **Priority: High.**

2. **Retaliation (spec):** Reactive damage proc dealing Physical damage when attacked during Demon Spikes. C++ reactiveTrigger confirms implementation. No interaction exists. **Priority: Medium** (tank damage, not dominant).

3. **Voidfall/Annihilator system:** 4 missing parseEffects (voidsurge, voidfall_building, voidfall_spending, voidfall_final_hour) plus 1 compositeOverride (otherworldly_focus). The entire Annihilator hero tree's buff system lacks spell_data interactions. **Priority: High for Annihilator builds.**

4. **Seething Anger (Untethered Rage 3):** Stacking buff parsed via `parse_player_effects` that increases untethered_rage proc chance on soul consumption. Damage-relevant via proc chain (more procs → more damage buff uptime). **Priority: Medium.**

### Moderate (data quality)

5. **1 duplicate interaction** (Burning Alive → Fiery Brand) should be deduplicated.
6. **Down in Flames** should have `cooldown_modifier` + `stacking_modifier` interactions on Fiery Brand — extra charges and reduced cooldown increase damage amp uptime.
7. **19 cpp_only talents with no descriptions** — Midnight expansion talents where spell template resolution failed. Descriptions needed to fully verify damage relevance.

### Low (informational)

8. **Stat passives:** Internal Struggle (mastery) is damage-relevant but stat scaling is typically handled implicitly by SimC's stat system, not via explicit interactions. Document this distinction.
9. **Conditional damage paths:** Blazing Path, Erratic Felheart, Sigil of Silence, and Sigil of Chains have indirect damage contributions through talent synergies (Felfire Fist/Doomsayer for Infernal Strike talents; Soul Sigils for sigil talents). These don't need standalone interactions but should be noted as APL-relevant synergies.

### Resolved (from previous audit)

- ~~**First In, Last Out:**~~ Confirmed non-damage. Grants absorb shield on Infernal Strike, not a damage amp. C++ marks it NYI.
- ~~**The Hunt / Elysian Decree:**~~ Not in the current Midnight VDH talent tree. Only referenced in other spell descriptions (e.g., Art of the Glaive mentions "casting The Hunt" as a trigger). Legacy abilities removed from the tree.
- ~~**Soul Cleave school:**~~ Physical confirmed by both spell data and C++ implementation. No Shadow school data exists.
- ~~**Felfire Fist / Doomsayer duplicates:**~~ Not duplicates. Each has 3 distinct interactions targeting different spells/buff states.
- ~~**Fiery Demise self-reference:**~~ Expected behavior. Modifier-on-modifier pattern where Fiery Demise amplifies Fiery Brand's damage taken debuff.
- ~~**Erratic Felheart:**~~ Not a speed stat passive — reduces Infernal Strike cooldown. Reclassified to borderline (conditional damage via Felfire Fist/Doomsayer synergy).
