# Interaction Audit Report

Generated: 2026-02-02T02:01:28.899Z

## Summary

- **Total interactions:** 266
- **Talents with interactions:** 114
- **Total talents:** 121

### By Type

| Type | Count |
|------|-------|
| damage_modifier | 110 |
| buff_grant | 46 |
| proc_trigger | 38 |
| resource_modifier | 18 |
| duration_modifier | 17 |
| mechanic_change | 16 |
| cooldown_modifier | 14 |
| range_modifier | 6 |
| stacking_modifier | 1 |

### By Discovery Method

| Method | Count |
|--------|-------|
| spell_data | 190 |
| cpp_scanner | 59 |
| effect_scan | 17 |

### By Confidence

| Confidence | Count |
|------------|-------|
| high | 190 |
| medium | 76 |

### By Source Tree

| Tree | Count |
|------|-------|
| non-talent | 166 |
| spec | 53 |
| hero | 33 |
| class | 14 |

## Talent Triage

| Category | Count |
|----------|-------|
| has_interactions | 65 |
| cpp_only | 44 |
| stat_passive | 11 |
| active_ability | 1 |

## Per-Talent Detail

### Class Talents

#### Vengeful Retreat (198793) — has_interactions

_No outgoing interactions_

**Incoming:**
- Prepared [resource_modifier, spell_data]
- Tactical Retreat [resource_modifier, spell_data]
- Evasive Action [mechanic_change, spell_data]

#### Felblade (232893) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Warblade's Hunger | damage_modifier | cpp_scanner |

**Incoming:**
- Any Means Necessary [damage_modifier, spell_data]
- Warblade's Hunger [damage_modifier, cpp_scanner]

#### Sigil of Misery (207684) — has_interactions

_No outgoing interactions_

**Incoming:**
- Quickened Sigils [duration_modifier, spell_data]
- Any Means Necessary [damage_modifier, spell_data]
- Chains of Anger [range_modifier, spell_data]

#### Vengeful Bonds (320635) — cpp_only

_No outgoing interactions_

#### Unrestrained Fury (320770) — stat_passive

_No outgoing interactions_

#### Shattered Restoration (389824) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Consume Soul | resource_modifier | cpp_scanner |

#### Improved Sigil of Misery (320418) — stat_passive

_No outgoing interactions_

#### Bouncing Glaives (320386) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Throw Glaive | damage_modifier | spell_data |

#### Imprison (217832) — active_ability

_No outgoing interactions_

#### Charred Warblades (213010) — cpp_only

_No outgoing interactions_

#### Chaos Nova (179057) — has_interactions

_No outgoing interactions_

**Incoming:**
- Demon Soul [damage_modifier, spell_data]
- Mastery: Demonic Presence [damage_modifier, spell_data]
- Unleashed Power [resource_modifier, spell_data]
- Fiery Brand [damage_modifier, spell_data]
- Fiery Brand [buff_grant, spell_data]
- Exergy [damage_modifier, spell_data]
- Frailty [damage_modifier, spell_data]
- Chaos Blades [damage_modifier, spell_data]
- Demon Soul [damage_modifier, spell_data]
- Burning Blood [damage_modifier, spell_data]
- Seething Chaos [damage_modifier, spell_data]
- Fiery Resolve [buff_grant, spell_data]
- Inertia [damage_modifier, spell_data]
- Demon Hide [buff_grant, spell_data]
- Reaver's Mark [buff_grant, spell_data]
- Thrill of the Fight [mechanic_change, spell_data]
- Luck of the Draw! [proc_trigger, spell_data]
- Thrill of the Fight [mechanic_change, spell_data]
- Demon Soul [damage_modifier, spell_data]
- Demon Soul [damage_modifier, spell_data]

#### Improved Disrupt (320361) — cpp_only

_No outgoing interactions_

#### Consume Magic (278326) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Swallowed Anger | resource_modifier | cpp_scanner |

**Incoming:**
- Swallowed Anger [resource_modifier, cpp_scanner]

#### Aldrachi Design (391409) — stat_passive

_No outgoing interactions_

#### Focused Ire (1266296) — cpp_only

_No outgoing interactions_

#### Master of the Glaive (389763) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Master of the Glaive | proc_trigger | effect_scan |

#### Champion of the Glaive (429211) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Throw Glaive | range_modifier | spell_data |

#### Disrupting Fury (183782) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Disrupting Fury | proc_trigger | effect_scan |

#### Blazing Path (320416) — stat_passive

_No outgoing interactions_

#### Swallowed Anger (320313) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Consume Magic | resource_modifier | cpp_scanner |

**Incoming:**
- Consume Magic [resource_modifier, cpp_scanner]

#### Aura of Pain (207347) — cpp_only

_No outgoing interactions_

#### Live by the Glaive (428607) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Live by the Glaive | proc_trigger | effect_scan |

#### Pursuit (320654) — cpp_only

_No outgoing interactions_

#### Soul Rending (204909) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Metamorphosis | damage_modifier | spell_data |

#### Felfire Haste (389846) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Felfire Haste | proc_trigger | effect_scan |

#### Infernal Armor (320331) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Immolation Aura | damage_modifier | spell_data |

**Incoming:**
- Fallout [resource_modifier, cpp_scanner]
- Charred Flesh [resource_modifier, cpp_scanner]
- Volatile Flameblood [resource_modifier, cpp_scanner]
- Agonizing Flames [cooldown_modifier, cpp_scanner]

#### Burn It Out (1266316) — cpp_only

_No outgoing interactions_

#### Soul Cleanse (1266496) — cpp_only

_No outgoing interactions_

#### Lost in Darkness (389849) — cpp_only

_No outgoing interactions_

#### Illidari Knowledge (389696) — stat_passive

_No outgoing interactions_

#### Felbound (1266762) — cpp_only

_No outgoing interactions_

#### Will of the Illidari (389695) — stat_passive

_No outgoing interactions_

#### Internal Struggle (393822) — stat_passive

_No outgoing interactions_

#### Furious (1266326) — cpp_only

_No outgoing interactions_

#### Remorseless (1266328) — cpp_only

_No outgoing interactions_

#### First In, Last Out (1266497) — cpp_only

_No outgoing interactions_

#### Erratic Felheart (391397) — stat_passive

_No outgoing interactions_

#### Final Breath (1266500) — cpp_only

_No outgoing interactions_

#### Darkness (196718) — has_interactions

_No outgoing interactions_

**Incoming:**
- Cover of Darkness [duration_modifier, spell_data]
- Long Night [duration_modifier, spell_data]
- Pitch Black [cooldown_modifier, spell_data]

#### Demon Muzzle (1266329) — cpp_only

_No outgoing interactions_

#### Soul Splitter (1266330) — cpp_only

_No outgoing interactions_

#### Wings of Wrath (1266493) — cpp_only

_No outgoing interactions_

#### Long Night (389781) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Darkness | duration_modifier | spell_data |

#### Pitch Black (389783) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Darkness | cooldown_modifier | spell_data |

#### Demonic Resilience (1266307) — cpp_only

_No outgoing interactions_

### Spec Talents

#### Fel Devastation (212084) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Meteoric Rise | cooldown_modifier | cpp_scanner |
| Darkglare Boon | cooldown_modifier | cpp_scanner |

**Incoming:**
- Fel Defender [cooldown_modifier, spell_data]
- Demonsurge [mechanic_change, spell_data]
- Meteoric Rise [cooldown_modifier, cpp_scanner]
- Darkglare Boon [cooldown_modifier, cpp_scanner]

#### Spirit Bomb (247454) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Frailty | proc_trigger | cpp_scanner |
| Dark Matter | proc_trigger | cpp_scanner |

**Incoming:**
- Dark Matter [proc_trigger, cpp_scanner]

#### Fiery Brand (204021) — has_interactions

_No outgoing interactions_

**Incoming:**
- Demon Soul [damage_modifier, spell_data]
- Fiery Brand [damage_modifier, spell_data]
- Fiery Brand [buff_grant, spell_data]
- Fiery Demise [damage_modifier, spell_data]
- Spirit of the Darkness Flame [buff_grant, spell_data]
- Frailty [damage_modifier, spell_data]
- Revel in Pain [buff_grant, spell_data]
- Spirit of the Darkness Flame [buff_grant, spell_data]
- Fiery Brand [duration_modifier, spell_data]
- Demon Soul [damage_modifier, spell_data]
- Any Means Necessary [damage_modifier, spell_data]
- Burning Blood [damage_modifier, spell_data]
- Fires of Fel [damage_modifier, spell_data]
- Fiery Resolve [buff_grant, spell_data]
- Demon Hide [buff_grant, spell_data]
- Reaver's Mark [buff_grant, spell_data]
- Luck of the Draw! [proc_trigger, spell_data]
- Thrill of the Fight [mechanic_change, spell_data]
- Demon Soul [damage_modifier, spell_data]
- Burning Alive [duration_modifier, cpp_scanner]
- Burning Alive [duration_modifier, cpp_scanner]

#### Perfectly Balanced Glaive (320387) — stat_passive

_No outgoing interactions_

#### Quickened Sigils (209281) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Sigil of Silence | duration_modifier | spell_data |
| Sigil of Chains | duration_modifier | spell_data |
| Sigil of Flame | duration_modifier | spell_data |
| Sigil of Misery | duration_modifier | spell_data |
| Sigil of Spite | duration_modifier | spell_data |

#### Ascending Flame (428603) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Sigil of Flame | duration_modifier | cpp_scanner |

**Incoming:**
- Cycle of Binding [duration_modifier, cpp_scanner]
- Frailty [duration_modifier, cpp_scanner]

#### Tempered Steel (1265800) — cpp_only

_No outgoing interactions_

#### Calcified Spikes (389720) — cpp_only

_No outgoing interactions_

#### Roaring Fire (391178) — stat_passive

_No outgoing interactions_

#### Sigil of Silence (202137) — has_interactions

_No outgoing interactions_

**Incoming:**
- Quickened Sigils [duration_modifier, spell_data]
- Any Means Necessary [damage_modifier, spell_data]
- Chains of Anger [range_modifier, spell_data]

#### Retaliation (389729) — cpp_only

_No outgoing interactions_

#### Felfire Fist (389724) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Infernal Strike | proc_trigger | cpp_scanner |
| buff:felfire_fist_in_combat | buff_grant | effect_scan |
| buff:felfire_fist_out_of_combat | buff_grant | effect_scan |

#### Sigil of Spite (390163) — has_interactions

_No outgoing interactions_

**Incoming:**
- Quickened Sigils [duration_modifier, spell_data]
- Any Means Necessary [damage_modifier, spell_data]
- Chains of Anger [range_modifier, spell_data]

#### Agonizing Flames (207548) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Immolation Aura | damage_modifier | spell_data |
| Infernal Armor | cooldown_modifier | cpp_scanner |

#### Feed the Demon (218612) — cpp_only

_No outgoing interactions_

#### Burning Blood (390213) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Chaos Nova | damage_modifier | spell_data |
| Infernal Strike | damage_modifier | spell_data |
| Fiery Brand | damage_modifier | spell_data |
| Soul Carver | damage_modifier | spell_data |
| Spirit Bomb | damage_modifier | spell_data |

#### Revel in Pain (343014) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Revel in Pain | proc_trigger | effect_scan |

#### Frailty (389958) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Sigil of Flame | duration_modifier | cpp_scanner |
| Ascending Flame | duration_modifier | cpp_scanner |
| Dark Matter | proc_trigger | cpp_scanner |
| Focused Cleave | damage_modifier | cpp_scanner |

**Incoming:**
- Cycle of Binding [duration_modifier, cpp_scanner]
- Spirit Bomb [proc_trigger, cpp_scanner]

#### Feast of Souls (207697) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Soul Cleave | resource_modifier | cpp_scanner |

#### Fallout (227174) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Immolation Aura | resource_modifier | cpp_scanner |
| Charred Flesh | resource_modifier | cpp_scanner |
| Volatile Flameblood | resource_modifier | cpp_scanner |
| Infernal Armor | resource_modifier | cpp_scanner |

#### Ruinous Bulwark (326853) — cpp_only

_No outgoing interactions_

#### Volatile Flameblood (390808) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Immolation Aura | resource_modifier | cpp_scanner |
| Infernal Armor | resource_modifier | cpp_scanner |

**Incoming:**
- Fallout [resource_modifier, cpp_scanner]
- Charred Flesh [resource_modifier, cpp_scanner]

#### Soul Barrier (1265924) — cpp_only

_No outgoing interactions_

#### Soul Sigils (395446) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Sigil of Flame | cooldown_modifier | cpp_scanner |

**Incoming:**
- Cycle of Binding [cooldown_modifier, cpp_scanner]

#### Fel Flame Fortification (389705) — cpp_only

_No outgoing interactions_

#### Void Reaver (268175) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Void Reaver | proc_trigger | effect_scan |

#### Painbringer (207387) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Painbringer | damage_modifier | effect_scan |

#### Sigil of Chains (202138) — has_interactions

_No outgoing interactions_

**Incoming:**
- Quickened Sigils [duration_modifier, spell_data]
- Any Means Necessary [damage_modifier, spell_data]
- Chains of Anger [range_modifier, spell_data]

#### Fiery Demise (389220) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Fiery Demise | damage_modifier | effect_scan |

#### Chains of Anger (389715) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Sigil of Silence | range_modifier | spell_data |
| Sigil of Chains | range_modifier | spell_data |
| Sigil of Flame | range_modifier | spell_data |
| Sigil of Misery | range_modifier | spell_data |
| Sigil of Spite | range_modifier | spell_data |

#### Focused Cleave (343207) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Soul Cleave | damage_modifier | cpp_scanner |

**Incoming:**
- Frailty [damage_modifier, cpp_scanner]

#### Soulmonger (389711) — cpp_only

_No outgoing interactions_

#### Stoke the Flames (393827) — cpp_only

_No outgoing interactions_

#### Burning Alive (207739) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Fiery Brand | duration_modifier | cpp_scanner |
| Fiery Brand | duration_modifier | cpp_scanner |

#### Cycle of Binding (389718) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Sigil of Flame | cooldown_modifier | cpp_scanner |
| Soul Sigils | cooldown_modifier | cpp_scanner |
| Frailty | duration_modifier | cpp_scanner |
| Ascending Flame | duration_modifier | cpp_scanner |

#### Vulnerability (389976) — cpp_only

_No outgoing interactions_

#### Vengeful Beast (1265818) — cpp_only

_No outgoing interactions_

#### Charred Flesh (336639) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Immolation Aura | resource_modifier | cpp_scanner |
| Volatile Flameblood | resource_modifier | cpp_scanner |
| Infernal Armor | resource_modifier | cpp_scanner |

**Incoming:**
- Fallout [resource_modifier, cpp_scanner]

#### Soulcrush (389985) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Frailty | stacking_modifier | spell_data |

#### Soul Carver (207407) — has_interactions

_No outgoing interactions_

**Incoming:**
- Demon Soul [damage_modifier, spell_data]
- Fiery Brand [damage_modifier, spell_data]
- Fiery Brand [buff_grant, spell_data]
- Fiery Demise [damage_modifier, spell_data]
- Frailty [damage_modifier, spell_data]
- Demon Soul [damage_modifier, spell_data]
- Any Means Necessary [damage_modifier, spell_data]
- Burning Blood [damage_modifier, spell_data]
- Fires of Fel [damage_modifier, spell_data]
- Fiery Resolve [buff_grant, spell_data]
- Demon Hide [buff_grant, spell_data]
- Reaver's Mark [buff_grant, spell_data]
- Luck of the Draw! [proc_trigger, spell_data]
- Thrill of the Fight [mechanic_change, spell_data]
- Demon Soul [damage_modifier, spell_data]

#### Last Resort (209258) — cpp_only

_No outgoing interactions_

#### Darkglare Boon (389708) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Fel Devastation | cooldown_modifier | cpp_scanner |

**Incoming:**
- Fel Devastation [cooldown_modifier, cpp_scanner]
- Meteoric Rise [cooldown_modifier, cpp_scanner]

#### Down in Flames (389732) — stat_passive

_No outgoing interactions_

### Hero: Aldrachi Reaver

#### Art of the Glaive (442290) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Art of the Glaive | proc_trigger | effect_scan |

**Incoming:**
- Fury of the Aldrachi [proc_trigger, cpp_scanner]
- Reaver's Mark [proc_trigger, cpp_scanner]
- Thrill of the Fight [proc_trigger, cpp_scanner]
- Aldrachi Tactics [proc_trigger, cpp_scanner]
- Bladecraft [proc_trigger, cpp_scanner]

#### Fury of the Aldrachi (442718) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Art of the Glaive | proc_trigger | cpp_scanner |
| Reaver's Mark | proc_trigger | cpp_scanner |
| Thrill of the Fight | proc_trigger | cpp_scanner |
| Aldrachi Tactics | proc_trigger | cpp_scanner |
| Bladecraft | proc_trigger | cpp_scanner |

#### Evasive Action (444926) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Evasive Action | proc_trigger | effect_scan |

#### Unhindered Assault (444931) — cpp_only

_No outgoing interactions_

#### Reaver's Mark (442679) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Art of the Glaive | proc_trigger | cpp_scanner |
| Thrill of the Fight | proc_trigger | cpp_scanner |
| Aldrachi Tactics | proc_trigger | cpp_scanner |

**Incoming:**
- Fury of the Aldrachi [proc_trigger, cpp_scanner]

#### Broken Spirit (1272143) — cpp_only

_No outgoing interactions_

#### Aldrachi Tactics (442683) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Art of the Glaive | proc_trigger | cpp_scanner |

**Incoming:**
- Fury of the Aldrachi [proc_trigger, cpp_scanner]
- Reaver's Mark [proc_trigger, cpp_scanner]
- Thrill of the Fight [proc_trigger, cpp_scanner]

#### Army Unto Oneself (442714) — cpp_only

_No outgoing interactions_

#### Incorruptible Spirit (442736) — cpp_only

_No outgoing interactions_

#### Wounded Quarry (442806) — cpp_only

_No outgoing interactions_

#### Keen Edge (1272138) — cpp_only

_No outgoing interactions_

#### Incisive Blade (442492) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Soul Cleave | damage_modifier | spell_data |

#### Keen Engagement (442497) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Throw Glaive | resource_modifier | cpp_scanner |

#### Preemptive Strike (444997) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Throw Glaive | proc_trigger | cpp_scanner |

#### Bladecraft (1272153) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Art of the Glaive | proc_trigger | cpp_scanner |

**Incoming:**
- Fury of the Aldrachi [proc_trigger, cpp_scanner]

#### Warblade's Hunger (442502) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Felblade | damage_modifier | cpp_scanner |
| Fracture | proc_trigger | cpp_scanner |

**Incoming:**
- Felblade [damage_modifier, cpp_scanner]

#### Thrill of the Fight (442686) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Art of the Glaive | proc_trigger | cpp_scanner |
| Aldrachi Tactics | proc_trigger | cpp_scanner |
| buff:thrill_of_the_fight_haste | buff_grant | effect_scan |

**Incoming:**
- Fury of the Aldrachi [proc_trigger, cpp_scanner]
- Reaver's Mark [proc_trigger, cpp_scanner]

### Hero: Annihilator

#### Voidfall (1253304) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| World Killer | proc_trigger | cpp_scanner |

#### Swift Erasure (1253668) — cpp_only

_No outgoing interactions_

#### Meteoric Rise (1253377) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Fel Devastation | cooldown_modifier | cpp_scanner |
| Darkglare Boon | cooldown_modifier | cpp_scanner |
| buff:voidfall_building | buff_grant | effect_scan |

**Incoming:**
- Fel Devastation [cooldown_modifier, cpp_scanner]

#### Catastrophe (1253769) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Soul Cleave | proc_trigger | cpp_scanner |

#### Phase Shift (1256245) — cpp_only

_No outgoing interactions_

#### Path to Oblivion (1253399) — cpp_only

_No outgoing interactions_

#### State of Matter (1253402) — cpp_only

_No outgoing interactions_

#### Mass Acceleration (1256295) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| buff:voidfall_building | buff_grant | effect_scan |

#### Doomsayer (1253676) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| World Killer | proc_trigger | cpp_scanner |
| buff:doomsayer_in_combat | buff_grant | effect_scan |
| buff:doomsayer_out_of_combat | buff_grant | effect_scan |

#### Harness the Cosmos (1279247) — cpp_only

_No outgoing interactions_

#### Celestial Echoes (1253415) — cpp_only

_No outgoing interactions_

#### Final Hour (1253805) — cpp_only

_No outgoing interactions_

#### Meteoric Fall (1253391) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| World Killer | proc_trigger | cpp_scanner |

#### Dark Matter (1256307) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Spirit Bomb | proc_trigger | cpp_scanner |
| Soul Cleave | cooldown_modifier | cpp_scanner |

**Incoming:**
- Spirit Bomb [proc_trigger, cpp_scanner]
- Frailty [proc_trigger, cpp_scanner]

#### Otherworldly Focus (1253817) — cpp_only

_No outgoing interactions_

#### World Killer (1256353) — has_interactions

| Target | Type | Method |
|--------|------|--------|
| Voidfall | mechanic_change | cpp_scanner |

**Incoming:**
- Voidfall [proc_trigger, cpp_scanner]
- Meteoric Fall [proc_trigger, cpp_scanner]
- Doomsayer [proc_trigger, cpp_scanner]

## Cross-Tree Interactions

Hero talents that interact with spec/class abilities:

- **Incisive Blade** (Aldrachi Reaver) → Soul Cleave [damage_modifier]
- **Catastrophe** (Annihilator) → Soul Cleave [proc_trigger]
- **Meteoric Rise** (Annihilator) → Fel Devastation [cooldown_modifier]
- **Dark Matter** (Annihilator) → Spirit Bomb [proc_trigger]
- **Dark Matter** (Annihilator) → Soul Cleave [cooldown_modifier]
- **World Killer** (Annihilator) → Voidfall [mechanic_change]
- **Warblade's Hunger** (Aldrachi Reaver) → Felblade [damage_modifier]
- **Warblade's Hunger** (Aldrachi Reaver) → Fracture [proc_trigger]
- **Keen Engagement** (Aldrachi Reaver) → Throw Glaive [resource_modifier]
- **Preemptive Strike** (Aldrachi Reaver) → Throw Glaive [proc_trigger]
- **Meteoric Rise** (Annihilator) → Darkglare Boon [cooldown_modifier]
- **Thrill of the Fight** (Aldrachi Reaver) → buff:thrill_of_the_fight_haste [buff_grant]
- **Mass Acceleration** (Annihilator) → buff:voidfall_building [buff_grant]
- **Meteoric Rise** (Annihilator) → buff:voidfall_building [buff_grant]
- **Doomsayer** (Annihilator) → buff:doomsayer_in_combat [buff_grant]
- **Doomsayer** (Annihilator) → buff:doomsayer_out_of_combat [buff_grant]

## Resource Economy

Interactions involving resource generation/spending:

- Unleashed Power → Chaos Nova [resource_modifier]
- Prepared → Vengeful Retreat [resource_modifier]
- Tactical Retreat → Vengeful Retreat [resource_modifier]
- Shear Fury → Shear [resource_modifier]
- Shattered Restoration → Consume Soul [resource_modifier] (on_soul_consume)
- Feast of Souls → Soul Cleave [resource_modifier] (conditional)
- Swallowed Anger → Consume Magic [resource_modifier] (conditional)
- Fallout → Immolation Aura [resource_modifier] (conditional)
- Charred Flesh → Immolation Aura [resource_modifier] (conditional)
- Volatile Flameblood → Immolation Aura [resource_modifier] (conditional)
- Keen Engagement → Throw Glaive [resource_modifier] (conditional)
- Consume Magic → Swallowed Anger [resource_modifier] (conditional)
- Fallout → Charred Flesh [resource_modifier] (conditional)
- Fallout → Volatile Flameblood [resource_modifier] (conditional)
- Fallout → Infernal Armor [resource_modifier] (conditional)
- Charred Flesh → Volatile Flameblood [resource_modifier] (conditional)
- Charred Flesh → Infernal Armor [resource_modifier] (conditional)
- Volatile Flameblood → Infernal Armor [resource_modifier] (conditional)

## Gaps

Talents with zero interactions (excluding stat passives):

- **Vengeful Bonds** (320635) — cpp_only [class]
- **Imprison** (217832) — active_ability [class]
- **Charred Warblades** (213010) — cpp_only [class]
- **Improved Disrupt** (320361) — cpp_only [class]
- **Focused Ire** (1266296) — cpp_only [class]
- **Aura of Pain** (207347) — cpp_only [class]
- **Pursuit** (320654) — cpp_only [class]
- **Burn It Out** (1266316) — cpp_only [class]
- **Soul Cleanse** (1266496) — cpp_only [class]
- **Lost in Darkness** (389849) — cpp_only [class]
- **Felbound** (1266762) — cpp_only [class]
- **Furious** (1266326) — cpp_only [class]
- **Remorseless** (1266328) — cpp_only [class]
- **First In, Last Out** (1266497) — cpp_only [class]
- **Final Breath** (1266500) — cpp_only [class]
- **Demon Muzzle** (1266329) — cpp_only [class]
- **Soul Splitter** (1266330) — cpp_only [class]
- **Wings of Wrath** (1266493) — cpp_only [class]
- **Demonic Resilience** (1266307) — cpp_only [class]
- **Tempered Steel** (1265800) — cpp_only [spec]
- **Calcified Spikes** (389720) — cpp_only [spec]
- **Retaliation** (389729) — cpp_only [spec]
- **Feed the Demon** (218612) — cpp_only [spec]
- **Ruinous Bulwark** (326853) — cpp_only [spec]
- **Soul Barrier** (1265924) — cpp_only [spec]
- **Fel Flame Fortification** (389705) — cpp_only [spec]
- **Soulmonger** (389711) — cpp_only [spec]
- **Stoke the Flames** (393827) — cpp_only [spec]
- **Vulnerability** (389976) — cpp_only [spec]
- **Vengeful Beast** (1265818) — cpp_only [spec]
- **Last Resort** (209258) — cpp_only [spec]
- **Unhindered Assault** (444931) — cpp_only [hero/Aldrachi Reaver]
- **Broken Spirit** (1272143) — cpp_only [hero/Aldrachi Reaver]
- **Army Unto Oneself** (442714) — cpp_only [hero/Aldrachi Reaver]
- **Incorruptible Spirit** (442736) — cpp_only [hero/Aldrachi Reaver]
- **Wounded Quarry** (442806) — cpp_only [hero/Aldrachi Reaver]
- **Keen Edge** (1272138) — cpp_only [hero/Aldrachi Reaver]
- **Swift Erasure** (1253668) — cpp_only [hero/Annihilator]
- **Phase Shift** (1256245) — cpp_only [hero/Annihilator]
- **Path to Oblivion** (1253399) — cpp_only [hero/Annihilator]
- **State of Matter** (1253402) — cpp_only [hero/Annihilator]
- **Harness the Cosmos** (1279247) — cpp_only [hero/Annihilator]
- **Celestial Echoes** (1253415) — cpp_only [hero/Annihilator]
- **Final Hour** (1253805) — cpp_only [hero/Annihilator]
- **Otherworldly Focus** (1253817) — cpp_only [hero/Annihilator]

## Stat Passives (Excluded from Coverage)

- Unrestrained Fury (320770)
- Improved Sigil of Misery (320418)
- Aldrachi Design (391409)
- Blazing Path (320416)
- Illidari Knowledge (389696)
- Will of the Illidari (389695)
- Internal Struggle (393822)
- Erratic Felheart (391397)
- Perfectly Balanced Glaive (320387)
- Roaring Fire (391178)
- Down in Flames (389732)
