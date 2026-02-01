# Vengeance Demon Hunter — Ability & Talent Report

Generated from SimC midnight branch. 104 spells, 70 modifier sources.

## Active Abilities

### Chaos Nova (179057)

School: Chromatic | Cost: 25 Fury | GCD: 1.5s | CD: 45s | Duration: 2s

> Unleash an eruption of fel energy, dealing $s2 Chaos damage and stunning all nearby enemies for $d.$?s320412[ Each enemy stunned by Chaos Nova has a $s3% chance to generate a Lesser Soul Fragment.][]

**Modified by:**
- Demon Soul (damage_modifier)
- Mastery: Demonic Presence (damage_modifier)
- Unleashed Power (resource_modifier)
- Fiery Brand (buff_grant)
- Fiery Brand (buff_grant)
- Exergy (damage_modifier)
- Frailty (buff_grant)
- Chaos Blades (damage_modifier)
- Demon Soul (damage_modifier)
- Burning Blood (damage_modifier) [spec]
- Seething Chaos (damage_modifier)
- Fiery Resolve (buff_grant)
- Inertia (damage_modifier)
- Demon Hide (unknown)
- Reaver's Mark (buff_grant)
- Thrill of the Fight (mechanic_change)
- Luck of the Draw! (proc_trigger)
- Thrill of the Fight (mechanic_change)
- Demon Soul (damage_modifier)
- Demon Soul (damage_modifier)

### Consume Magic (278326)

School: Chromatic | GCD: 1.5s | CD: 10s | Range: 30yd

> Consume $m1 beneficial Magic effect removing it from the target$?s320313[ and granting you $s2 Fury][].

### Darkness (196718)

School: Physical | GCD: 1.5s | CD: 300s | Duration: 8s

> Summons darkness around you in a$?a357419[ 12 yd][n 8 yd] radius, granting friendly targets a $209426s2% chance to avoid all damage from an attack. Lasts $d. Chance to avoid damage increased by $s3% when not in a raid.

**Modified by:**
- Cover of Darkness (duration_modifier)
- Long Night (duration_modifier) [class]
- Pitch Black (cooldown_modifier) [class]

### Fel Devastation (212084)

School: Fire | Cost: 50 Fury | GCD: 1.5s | CD: 40s | Duration: 2s | Range: 20yd

> Unleash the fel within you, damaging enemies directly in front of you for ${$212105s1*(2/$t1)} Fire damage over $d.$?s320639[ Causing damage also heals you for up to ${$212106s1*(2/$t1)} health.][]

**Modified by:**
- Fel Defender (cooldown_modifier)
- Demonsurge (mechanic_change)

### Felblade (232893)

School: Physical | GCD: 0.5s | CD: 15s | Range: 15yd

> Charge to your target and deal $213243sw2 $@spelldesc395020 damage. $?s263642[Fracture has a chance to reset the cooldown of Felblade. |cFFFFFFFFGenerates $213243s3 Fury.|r]?s203513[Shear has a chance to reset the cooldown of Felblade. |cFFFFFFFFGenerates $213243s3 Fury.|r]?a203555[Demon Blades has a chance to reset the cooldown of Felblade. |cFFFFFFFFGenerates $213243s3 Fury.|r][Demon's Bite has a chance to reset the cooldown of Felblade. |cFFFFFFFFGenerates $213243s3 Fury.|r]

**Modified by:**
- Any Means Necessary (damage_modifier)

### Fiery Brand (204021)

School: Fire | GCD: 1.5s | Charges: 1 (60s) | Range: 30yd

> Brand an enemy with a demonic symbol, instantly dealing $s2 Fire damage$?s320962[ and ${$207771s5*$207771d} Fire damage over $207771d][]. The enemy's damage done to you is reduced by $s1% for $207744d.

**Modified by:**
- Demon Soul (damage_modifier)
- Fiery Brand (buff_grant)
- Fiery Brand (buff_grant)
- Fiery Demise (damage_modifier)
- Spirit of the Darkness Flame (buff_grant)
- Frailty (buff_grant)
- Revel in Pain (buff_grant)
- Spirit of the Darkness Flame (buff_grant)
- Fiery Brand (duration_modifier)
- Demon Soul (damage_modifier)
- Any Means Necessary (damage_modifier)
- Burning Blood (damage_modifier) [spec]
- Fires of Fel (damage_modifier)
- Fiery Resolve (buff_grant)
- Demon Hide (unknown)
- Reaver's Mark (buff_grant)
- Luck of the Draw! (proc_trigger)
- Thrill of the Fight (mechanic_change)
- Demon Soul (damage_modifier)

### Fracture (263642)

School: Physical | GCD: 1.5s | Charges: 2 (4.5s) | Range: 5yd

> Rapidly slash your target for ${$225919sw1+$225921sw1} Physical damage, and shatter $s1 Lesser Soul Fragments from them. |cFFFFFFFFGenerates $s4 Fury.|r

**Modified by:**
- Metamorphosis (damage_modifier)
- Fiery Demise (damage_modifier)
- Mark of the Ogre (buff_grant)
- Half-Giant Empowerment (damage_modifier)
- Fires of Fel (damage_modifier)

### Immolation Aura (258920)

School: Fire | GCD: 1.5s | CD: 1.5s | Charges: 1 (30s) | Duration: 6s

> Engulf yourself in flames, $?a320364 [instantly causing $258921s1 $@spelldesc1224451 damage to enemies within $258921A1 yards and ][]radiating ${$258922s1*$d} $@spelldesc1224451 damage over $d.$?s320374[ |cFFFFFFFFGenerates $<havocTalentFury> Fury over $d.|r][]$?(s212612 & !s320374)[ |cFFFFFFFFGenerates $<havocFury> Fury.|r][]$?s212613[ |cFFFFFFFFGenerates $<vengeFury> Fury over $d.|r][]

**Modified by:**
- Agonizing Flames (damage_modifier) [spec]
- Infernal Armor (damage_modifier) [class]
- Immolation Aura (damage_modifier)
- Burning Wound (damage_modifier)
- Any Means Necessary (damage_modifier)
- Immolation Aura (damage_modifier)
- Immolation Aura (damage_modifier)
- Immolation Aura (damage_modifier)
- Immolation Aura (damage_modifier)
- Demonsurge (mechanic_change)

### Imprison (217832)

School: Shadow | GCD: 1.5s | CD: 45s | Duration: 60s | Range: 20yd

> Imprisons a demon, beast, or humanoid, incapacitating them for $d. Damage may cancel the effect. Limit 1.

### Shear (203782)

School: Physical | GCD: 1.5s | Range: 5yd

> Shears an enemy for $s1 Physical damage, and shatters $?a187827[two Lesser Soul Fragments][a Lesser Soul Fragment] from your target. |cFFFFFFFFGenerates $m2 Fury.|r

**Modified by:**
- Demon Soul (damage_modifier)
- Metamorphosis (damage_modifier)
- Fiery Demise (damage_modifier)
- Frailty (buff_grant)
- Mark of the Ogre (buff_grant)
- Half-Giant Empowerment (damage_modifier)
- Demon Soul (damage_modifier)
- Shear Fury (unknown)
- Fires of Fel (damage_modifier)
- Fiery Resolve (buff_grant)
- Reaver's Mark (buff_grant)
- Luck of the Draw! (proc_trigger)
- Thrill of the Fight (mechanic_change)
- Demon Soul (damage_modifier)

### Sigil of Chains (202138)

School: Physical | GCD: 1.5s | Charges: 1 (60s) | Duration: 2s | Range: 30yd

> Place a Sigil of Chains at the target location that activates after $d. All enemies affected by the sigil are pulled to its center and are snared, reducing movement speed by $204843s1% for $204843d.

**Modified by:**
- Quickened Sigils (duration_modifier) [spec]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Flame (204596)

School: Physical | GCD: 1.5s | Charges: 1 (30s) | Duration: 2s | Range: 30yd

> Place a Sigil of Flame at the target location that activates after $d. Deals $204598s1 $@spelldesc395020 damage, and an additional $204598o3 $@spelldesc395020 damage over $204598d, to all enemies affected by the sigil. |CFFffffffGenerates $389787s1 Fury.|R

**Modified by:**
- Quickened Sigils (duration_modifier) [spec]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Misery (207684)

School: Physical | GCD: 1.5s | Charges: 1 (120s) | Duration: 2s | Range: 30yd

> Place a Sigil of Misery at the target location that activates after $d. Causes all enemies affected by the sigil to cower in fear, disorienting them for $207685d.

**Modified by:**
- Quickened Sigils (duration_modifier) [spec]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Silence (202137)

School: Physical | GCD: 1.5s | Charges: 1 (90s) | Duration: 2s | Range: 30yd

> Place a Sigil of Silence at the target location that activates after $d. Silences all enemies affected by the sigil for $204490d.

**Modified by:**
- Quickened Sigils (duration_modifier) [spec]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Spite (390163)

School: Chromatic | GCD: 1.5s | Charges: 1 (60s) | Duration: 2s | Range: 30yd

> Place a demonic sigil at the target location that activates after $d. Detonates to deal $389860s1 Chaos damage and shatter up to $s3 Lesser Soul Fragments from enemies affected by the sigil. Deals reduced damage beyond $s1 targets.

**Modified by:**
- Quickened Sigils (duration_modifier) [spec]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Soul Carver (207407)

School: Fire | GCD: 1.5s | CD: 60s | Duration: 3s | Range: 5yd

> Carve into the soul of your target, dealing ${$s2+$214743s1} Fire damage and an additional $o1 Fire damage over $d.  Immediately shatters $s3 Lesser Soul Fragments from the target and $s4 additional Lesser Soul Fragment every $t1 sec.

**Modified by:**
- Demon Soul (damage_modifier)
- Fiery Brand (buff_grant)
- Fiery Brand (buff_grant)
- Fiery Demise (damage_modifier)
- Frailty (buff_grant)
- Demon Soul (damage_modifier)
- Any Means Necessary (damage_modifier)
- Burning Blood (damage_modifier) [spec]
- Fires of Fel (damage_modifier)
- Fiery Resolve (buff_grant)
- Demon Hide (unknown)
- Reaver's Mark (buff_grant)
- Luck of the Draw! (proc_trigger)
- Thrill of the Fight (mechanic_change)
- Demon Soul (damage_modifier)

### Soul Cleave (228477)

School: Physical | Cost: 30 Fury | GCD: 1.5s | Range: 5yd

> Viciously strike up to $228478s2 enemies in front of you for $228478s1 Physical damage and heal yourself for $s4. Consumes up to $s3 available Soul Fragments$?s321021[ and heals you for an additional $s5 for each Soul Fragment consumed][].

**Modified by:**
- Immolation Aura (buff_grant)
- Mark of the Ogre (buff_grant)
- Half-Giant Empowerment (damage_modifier)
- Immolation Aura (damage_modifier)
- Immolation Aura (damage_modifier)
- Immolation Aura (damage_modifier)
- Demonsurge (mechanic_change)

### Spirit Bomb (247454)

School: Fire | Cost: 40 Fury | GCD: 1.5s | Duration: 1.5s

> Consume up to $s2 available Soul Fragments then explode, damaging nearby enemies for $247455s1 Fire damage per fragment consumed, and afflicting them with Frailty for $247456d, causing you to heal for $247456s1% of damage you deal to them. Deals reduced damage beyond $s3 targets.

### Throw Glaive (185123)

School: Physical | Cost: 25 Fury | GCD: 1.5s | Charges: 1 (9s) | Range: 30yd

> Throw a demonic glaive at the target, dealing $337819s1 Physical damage. The glaive can ricochet to $?$s320386[${$337819x1-1} additional enemies][an additional enemy] within 10 yards.

**Modified by:**
- Demon Soul (damage_modifier)
- Exergy (damage_modifier)
- Mo'arg Bionic Stabilizers (damage_modifier)
- Chaos Blades (damage_modifier)
- Bouncing Glaives (damage_modifier) [class]
- Demon Soul (damage_modifier)
- Serrated Glaive (damage_modifier)
- Accelerated Blade (unknown)
- Seething Chaos (damage_modifier)
- Inertia (damage_modifier)
- Champion of the Glaive (range_modifier) [class]
- Reaver's Mark (buff_grant)
- Thrill of the Fight (mechanic_change)
- Demon Soul (damage_modifier)

## Talent Trees

### Class (45 talents)

**Row 0:**
- (1) **Vengeful Retreat** (198793) [off_gcd_ability]
  _Remove all snares and vault away. Nearby enemies take $198813s2 Physical damage$?s320635[ and have their movement speed reduced by $198813s1% for $198813d][].$?a203551[ |cFFFFFFFFGenerates ${($203650s..._
- (3) **Felblade** (232893) [active_ability]
  _Charge to your target and deal $213243sw2 $@spelldesc395020 damage. $?s263642[Fracture has a chance to reset the cooldown of Felblade. |cFFFFFFFFGenerates $213243s3 Fury.|r]?s203513[Shear has a chance..._
- (5) **Sigil of Misery** (207684) [active_ability]
  _Place a Sigil of Misery at the target location that activates after $d. Causes all enemies affected by the sigil to cower in fear, disorienting them for $207685d._

**Row 1:**
- (1) **Vengeful Bonds** (320635) [passive_buff]
  _Vengeful Retreat reduces the movement speed of all nearby enemies by $198813s1% for $198813d._
- (2) **Unrestrained Fury** (320770) [passive]
  _Increases maximum Fury by $s1._
- (4) **Shattered Restoration** (389824) [passive_buff]
  _The healing of Shattered Souls is increased by $s1%._
- (5) **Improved Sigil of Misery** (320418) [passive]
  _Reduces the cooldown of Sigil of Misery by ${$s1/-1000} sec._

**Row 2:**
- (1) **Bouncing Glaives** (320386) [spell_modifier]
  → Throw Glaive (damage_modifier)
  _Throw Glaive ricochets to $s1 additional $ltarget:targets;._
- (3) **Imprison** (217832) [active_ability]
  _Imprisons a demon, beast, or humanoid, incapacitating them for $d. Damage may cancel the effect. Limit 1._
- (5) **Charred Warblades** (213010) [passive_buff]
  _You heal for $s1% of all Fire damage you deal._

**Row 3:**
- (0) **Chaos Nova** (179057) [active_ability]
  _Unleash an eruption of fel energy, dealing $s2 Chaos damage and stunning all nearby enemies for $d.$?s320412[ Each enemy stunned by Chaos Nova has a $s3% chance to generate a Lesser Soul Fragment.][]_
- (2) **Improved Disrupt** (320361) [spell_modifier]
  _Increases the range of Disrupt to ${$s2+$s1} yds._
- (4) **Consume Magic** (278326) [active_ability]
  _Consume $m1 beneficial Magic effect removing it from the target$?s320313[ and granting you $s2 Fury][]._
- (6) **Aldrachi Design** (391409) [passive]
  _Increases your chance to parry by $s1%._

**Row 4:**
- (0) **Focused Ire** (1266296)
- (1) **Master of the Glaive** (389763) [proc_trigger]
  _Throw Glaive has ${$s2+1} charges and snares all enemies hit by $213405s1% for $213405d._
- (1) **Champion of the Glaive** (429211) [spell_modifier]
  → Throw Glaive (range_modifier)
  _Throw Glaive has ${$s2+1} charges and $s1 yard increased range._
- (2) **Disrupting Fury** (183782) [proc_trigger]
  _Disrupt generates $218903s1 Fury on a successful interrupt._
- (3) **Blazing Path** (320416) [passive]
  _$?a212613[Infernal Strike][Fel Rush] gains an additional charge._
- (4) **Swallowed Anger** (320313) [passive_buff]
  _Consume Magic generates $278326s2 Fury when a beneficial Magic effect is successfully removed from the target._
- (5) **Aura of Pain** (207347) [spell_modifier]
  _Increases the critical strike chance of Immolation Aura by $s1%._
- (6) **Live by the Glaive** (428607) [proc_trigger]
  _When you parry an attack or have one of your attacks parried, restore $428608s2% of max health and $428608s1 Fury. This effect may only occur once every $s1 sec._

**Row 5:**
- (0) **Pursuit** (320654) [passive]
  _Mastery increases your movement speed._
- (2) **Soul Rending** (204909) [spell_modifier]
  → Metamorphosis (damage_modifier)
  _Leech increased by $s1%. Gain an additional $s2% leech while Metamorphosis is active._
- (3) **Felfire Haste** (389846) [proc_trigger]
  _$?c1[Fel Rush][Infernal Strike] increases your movement speed by $389847s1% for $389847d._
- (4) **Infernal Armor** (320331) [spell_modifier]
  → Immolation Aura (damage_modifier)
  _Immolation Aura increases your armor by $s1% and causes melee attackers to suffer ${$320334s1/$s3} $@spelldesc395020 damage._
- (5) **Burn It Out** (1266316)
- (5) **Soul Cleanse** (1266496)
- (6) **Lost in Darkness** (389849) [spell_modifier]
  _Spectral Sight has ${$s1/-1000} sec reduced cooldown and no longer reduces movement speed._

**Row 6:**
- (1) **Illidari Knowledge** (389696) [passive]
  _Reduces magic damage taken by $s1%._
- (3) **Felbound** (1266762)
- (5) **Will of the Illidari** (389695) [passive]
  _Increases maximum health by $s1%._

**Row 7:**
- (1) **Internal Struggle** (393822) [passive]
  _Increases your mastery by ${$s1*$mas}.1%._
- (2) **Furious** (1266326)
- (4) **Remorseless** (1266328)
- (5) **First In, Last Out** (1266497)

**Row 8:**
- (1) **Erratic Felheart** (391397) [passive]
  _The cooldown of $?a212613[Infernal Strike ][Fel Rush ]is reduced by ${-1*$s1}%._
- (2) **Final Breath** (1266500)
- (3) **Darkness** (196718) [active_ability]
  _Summons darkness around you in a$?a357419[ 12 yd][n 8 yd] radius, granting friendly targets a $209426s2% chance to avoid all damage from an attack. Lasts $d. Chance to avoid damage increased by $s3% w..._
- (4) **Demon Muzzle** (1266329)
- (5) **Soul Splitter** (1266330)

**Row 9:**
- (1) **Wings of Wrath** (1266493)
- (3) **Long Night** (389781) [spell_modifier]
  → Darkness (duration_modifier)
  _Increases the duration of Darkness by ${$s1/1000} sec._
- (3) **Pitch Black** (389783) [spell_modifier]
  → Darkness (cooldown_modifier)
  _Reduces the cooldown of Darkness by ${$s1/-1000} sec._
- (5) **Demonic Resilience** (1266307)

### Spec (Vengeance) (43 talents)

**Row 0:**
- (4) **Fel Devastation** (212084) [active_ability]
  _Unleash the fel within you, damaging enemies directly in front of you for ${$212105s1*(2/$t1)} Fire damage over $d.$?s320639[ Causing damage also heals you for up to ${$212106s1*(2/$t1)} health.][]_

**Row 1:**
- (3) **Spirit Bomb** (247454) [active_ability]
  _Consume up to $s2 available Soul Fragments then explode, damaging nearby enemies for $247455s1 Fire damage per fragment consumed, and afflicting them with Frailty for $247456d, causing you to heal for..._
- (5) **Fiery Brand** (204021) [active_ability]
  _Brand an enemy with a demonic symbol, instantly dealing $s2 Fire damage$?s320962[ and ${$207771s5*$207771d} Fire damage over $207771d][]. The enemy's damage done to you is reduced by $s1% for $207744d..._

**Row 2:**
- (2) **Perfectly Balanced Glaive** (320387) [passive]
  _Reduces the cooldown of Throw Glaive by ${$abs($s0/1000)} sec._
- (4) **Quickened Sigils** (209281) [spell_modifier]
  → Sigil of Silence (duration_modifier)
  → Sigil of Chains (duration_modifier)
  → Sigil of Flame (duration_modifier)
  → Sigil of Misery (duration_modifier)
  → Sigil of Spite (duration_modifier)
  _All Sigils activate ${$s1/-1000} second faster._
- (6) **Ascending Flame** (428603) [passive]
  _Sigil of Flame's initial damage is increased by $s2%. Multiple applications of Sigil of Flame may overlap._

**Row 3:**
- (1) **Tempered Steel** (1265800)
- (2) **Calcified Spikes** (389720) [passive_buff]
  _You take $391171s2% reduced damage after Demon Spikes ends, fading by 1% per second._
- (4) **Roaring Fire** (391178) [passive]
  _Fel Devastation heals you for up to $s1% more, based on your missing health._
- (4) **Sigil of Silence** (202137) [active_ability]
  _Place a Sigil of Silence at the target location that activates after $d. Silences all enemies affected by the sigil for $204490d._
- (6) **Retaliation** (389729) [passive_buff]
  _While Demon Spikes is active, melee attacks against you cause the attacker to take $391159s1 Physical damage. Generates high threat._
- (7) **Felfire Fist** (389724) [passive]
  _Reduce the cooldown of Infernal Strike by ${$s1/-1000} sec._

**Row 4:**
- (0) **Sigil of Spite** (390163) [active_ability]
  _Place a demonic sigil at the target location that activates after $d. Detonates to deal $389860s1 Chaos damage and shatter up to $s3 Lesser Soul Fragments from enemies affected by the sigil. Deals red..._
- (2) **Agonizing Flames** (207548) [spell_modifier]
  → Immolation Aura (damage_modifier)
  _Immolation Aura increases your movement speed by $s1% and its duration is increased by $s2%._
- (4) **Feed the Demon** (218612) [passive_buff]
  _Consuming a Soul Fragment reduces the remaining cooldown of Demon Spikes by ${$s1/100}.2 sec._
- (6) **Burning Blood** (390213) [spell_modifier]
  → Chaos Nova (damage_modifier)
  → Infernal Strike (damage_modifier)
  → Fiery Brand (damage_modifier)
  → Soul Carver (damage_modifier)
  → Spirit Bomb (damage_modifier)
  _Fire damage increased by $s1%._
- (8) **Revel in Pain** (343014) [proc_trigger]
  _When Fiery Brand expires on your primary target, you gain a shield that absorbs up ${$AP*($s2/100)*(1+$@versadmg)} damage for $343013d, based on your damage dealt to them while Fiery Brand was active._

**Row 5:**
- (1) **Frailty** (389958) [passive_buff]
  _Enemies struck by Sigil of Flame are afflicted with Frailty for $247456d. You heal for $247456s1% of all damage you deal to targets with Frailty._
- (2) **Feast of Souls** (207697) [passive_buff]
  _Soul Cleave heals you for an additional $207693o1 over $207693d._
- (3) **Fallout** (227174) [passive_buff]
  _Immolation Aura's initial burst has a chance to shatter Lesser Soul Fragments from enemies._
- (4) **Ruinous Bulwark** (326853) [spell_modifier]
  _Fel Devastation heals for an additional $s1%, and $s2% of its healing is converted into an absorb shield for $326863d._
- (5) **Volatile Flameblood** (390808) [passive_buff]
  _Immolation Aura generates $m-$M Fury when it deals critical damage. This effect may only occur once per ${$proccooldown+0.1} sec._
- (6) **Soul Barrier** (1265924)
- (6) **Soul Sigils** (395446) [passive_buff]
  _Afflicting an enemy with a Sigil generates $m1 Lesser Soul $LFragment:Fragments;._
- (7) **Fel Flame Fortification** (389705) [passive_buff]
  _You take $393009s1% reduced magic damage while Immolation Aura is active._

**Row 6:**
- (0) **Void Reaver** (268175) [proc_trigger]
  _Frailty now also reduces all damage you take from afflicted targets by $s2%. Enemies struck by Soul Cleave are afflicted with Frailty for $247456d._
- (2) **Painbringer** (207387) [passive_buff]
  _Consuming a Soul Fragment reduces all damage you take by $s1% for $212988d. Multiple applications may overlap._
- (4) **Sigil of Chains** (202138) [active_ability]
  _Place a Sigil of Chains at the target location that activates after $d. All enemies affected by the sigil are pulled to its center and are snared, reducing movement speed by $204843s1% for $204843d._
- (6) **Fiery Demise** (389220) [passive]
  _Fiery Brand also increases Fire damage you deal to the target by $s1%._
- (8) **Chains of Anger** (389715) [spell_modifier]
  → Sigil of Silence (range_modifier)
  → Sigil of Chains (range_modifier)
  → Sigil of Flame (range_modifier)
  → Sigil of Misery (range_modifier)
  → Sigil of Spite (range_modifier)
  _Increases the duration of your Sigils by ${$s2/1000} sec and radius by $s1 yds._

**Row 7:**
- (1) **Focused Cleave** (343207) [passive_buff]
  _Soul Cleave deals $s1% increased damage to your primary target._
- (2) **Soulmonger** (389711) [passive_buff]
  _When consuming a Soul Fragment would heal you above full health it shields you instead, up to a maximum of ${$MHP*$s1/100}._
- (4) **Stoke the Flames** (393827) [spell_modifier]
  _Fel Devastation damage increased by $s1%._
- (6) **Burning Alive** (207739) [passive_buff]
  _Every $207771t3 sec, Fiery Brand spreads to one nearby enemy._
- (7) **Cycle of Binding** (389718) [passive_buff]
  _Sigil of Flame reduces the cooldown of your Sigils by $s1 sec._

**Row 8:**
- (2) **Vulnerability** (389976) [passive_buff]
  _Frailty now also increases all damage you deal to afflicted targets by $s1%._
- (4) **Vengeful Beast** (1265818)
- (6) **Charred Flesh** (336639) [passive_buff]
  _Immolation Aura damage increases the duration of your Fiery Brand and Sigil of Flame by ${$s1/1000}.2 sec._

**Row 9:**
- (2) **Soulcrush** (389985) [spell_modifier]
  → Frailty (stacking_modifier)
  _Multiple applications of Frailty may overlap. Soul Cleave applies Frailty to your primary target for $s2 sec._
- (3) **Soul Carver** (207407) [active_ability]
  _Carve into the soul of your target, dealing ${$s2+$214743s1} Fire damage and an additional $o1 Fire damage over $d.  Immediately shatters $s3 Lesser Soul Fragments from the target and $s4 additional L..._
- (4) **Last Resort** (209258) [passive]
  _Sustaining fatal damage instead transforms you to Metamorphosis form. This may occur once every $209261d._
- (5) **Darkglare Boon** (389708) [passive_buff]
  _When Fel Devastation finishes fully channeling, it refreshes $s1-$s2% of its cooldown and refunds $s3-$s4 Fury._
- (6) **Down in Flames** (389732) [passive]
  _Fiery Brand has ${$s1/-1000} sec reduced cooldown and $s2 additional $lcharge:charges;._

### Hero: Aldrachi Reaver (17 talents)

**Row 0:**
- (2) **Art of the Glaive** (442290) [proc_trigger]
  _Consuming $?a212612[$s1][$s2] Soul Fragments or casting The Hunt converts your next Throw Glaive into Reaver's Glaive. $@spellicon442294 $@spellname442294: $@spelldesc442294_

**Row 1:**
- (0) **Fury of the Aldrachi** (442718) [passive_buff]
  _When enhanced by Reaver's Glaive, $?a212612[Blade Dance][Soul Cleave] casts $s2 additional glaive slashes to nearby targets. If cast after $?a212612[Chaos Strike]?s263642[Fracture][Shear], cast $?a123..._
- (1) **Evasive Action** (444926) [proc_trigger]
  _Vengeful Retreat can be cast a second time within $444929d._
- (1) **Unhindered Assault** (444931) [passive_buff]
  _Vengeful Retreat resets the cooldown of Felblade._
- (3) **Reaver's Mark** (442679) [passive_buff]
  _When enhanced by Reaver's Glaive, $?a212612[Chaos Strike]?s263642[Fracture][Shear] applies Reaver's Mark, which causes the target to take $442624s1% increased damage for $442624d. Max $442624u stacks...._
- (4) **Broken Spirit** (1272143)

**Row 2:**
- (0) **Aldrachi Tactics** (442683) [passive_buff]
  _The second enhanced ability in a pattern shatters an additional Soul Fragment._
- (1) **Army Unto Oneself** (442714) [passive_buff]
  _Felblade surrounds you with a Blade Ward, reducing damage taken by $442715s1% for $442715d._
- (1) **Incorruptible Spirit** (442736) [passive_buff]
  _Each Soul Fragment you consume shields you for an additional $s1% of the amount healed._
- (3) **Wounded Quarry** (442806) [passive_buff]
  _Expose weaknesses in the target of your $@spellname442624, causing your Physical damage to any enemy to also deal $s1% of the damage dealt to your marked target as Chaos, and sometimes shatter a Lesse..._
- (4) **Keen Edge** (1272138)

**Row 3:**
- (0) **Incisive Blade** (442492) [spell_modifier]
  → Soul Cleave (damage_modifier)
  _$?a212612[Chaos Strike][Soul Cleave] deals $s1% increased damage._
- (1) **Keen Engagement** (442497) [passive]
  _Reaver's Glaive generates $s1 Fury._
- (1) **Preemptive Strike** (444997) [proc_trigger]
  _Throw Glaive deals $444979s1 Physical damage to enemies near its initial target._
- (3) **Bladecraft** (1272153)
- (4) **Warblade's Hunger** (442502) [proc_trigger]
  _Consuming a Soul Fragment causes your next $?a212612[Chaos Strike]?s263642[Fracture][Shear] to deal $442507s1 additional Physical damage.$?a212612[ Felblade consumes up to $s2 nearby Soul Fragments.][..._

**Row 4:**
- (2) **Thrill of the Fight** (442686) [passive_buff]
  _After consuming both enhancements, gain Thrill of the Fight, increasing your attack speed by $442695s1% for $442695d and your damage and healing by $442688s1% for $442688d._

### Hero: Annihilator (16 talents)

**Row 0:**
- (2) **Voidfall** (1253304)

**Row 1:**
- (0) **Swift Erasure** (1253668)
- (1) **Meteoric Rise** (1253377)
- (3) **Catastrophe** (1253769)
- (4) **Phase Shift** (1256245)

**Row 2:**
- (0) **Path to Oblivion** (1253399)
- (0) **State of Matter** (1253402)
- (1) **Mass Acceleration** (1256295)
- (3) **Doomsayer** (1253676)
- (3) **Harness the Cosmos** (1279247)
- (4) **Celestial Echoes** (1253415)

**Row 3:**
- (0) **Final Hour** (1253805)
- (1) **Meteoric Fall** (1253391)
- (3) **Dark Matter** (1256307)
- (4) **Otherworldly Focus** (1253817)

**Row 4:**
- (2) **World Killer** (1256353)

## Resource Flow

### Fury Generators
- Vengeful Retreat (198793)
- Shear (203782)
- Sigil of Flame (204596)
- Felblade (232893)
- Immolation Aura (258920)
- Fracture (263642)

### Fury Spenders
- Chaos Nova (179057): 25 Fury
- Throw Glaive (185123): 25 Fury
- Fel Devastation (212084): 50 Fury
- Soul Cleave (228477): 30 Fury
- Spirit Bomb (247454): 40 Fury

### Soul Fragment Generators
- Chaos Nova (179057)
- Metamorphosis (187827)
- Shear (203782)
- Fracture (263642)

### Soul Fragment Consumers
- Soul Cleave (228477)
- Spirit Bomb (247454)
- Warblade's Hunger (442502)
- Incorruptible Spirit (442736)
