# Vengeance Demon Hunter — Ability & Talent Report

Generated from SimC midnight branch. 180 spells, 72 modifier sources.

## Active Abilities

### Bulk Extraction (320341)

School: Fire | GCD: 1.5s | CD: 60s

> Demolish the spirit of all those around you, dealing $s1 Fire damage to nearby enemies and extracting up to $s2 Lesser Soul Fragments, drawing them to you for immediate consumption.

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
- Demon Hide (damage_modifier)
- Reaver's Mark (buff_grant)
- Luck of the Draw! (proc_trigger)
- Thrill of the Fight (mechanic_change)
- Demon Soul (damage_modifier)

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
- Demon Hide (damage_modifier)
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
- Demon Hide (damage_modifier)
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
- Shear Fury (damage_modifier) [spec]
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
- Quickened Sigils (duration_modifier) [class]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Flame (204596)

School: Physical | GCD: 1.5s | Charges: 1 (30s) | Duration: 2s | Range: 30yd

> Place a Sigil of Flame at the target location that activates after $d. Deals $204598s1 $@spelldesc395020 damage, and an additional $204598o3 $@spelldesc395020 damage over $204598d, to all enemies affected by the sigil. |CFFffffffGenerates $389787s1 Fury.|R

**Modified by:**
- Quickened Sigils (duration_modifier) [class]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Misery (207684)

School: Physical | GCD: 1.5s | Charges: 1 (120s) | Duration: 2s | Range: 30yd

> Place a Sigil of Misery at the target location that activates after $d. Causes all enemies affected by the sigil to cower in fear, disorienting them for $207685d.

**Modified by:**
- Quickened Sigils (duration_modifier) [class]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Silence (202137)

School: Physical | GCD: 1.5s | Charges: 1 (90s) | Duration: 2s | Range: 30yd

> Place a Sigil of Silence at the target location that activates after $d. Silences all enemies affected by the sigil for $204490d.

**Modified by:**
- Quickened Sigils (duration_modifier) [class]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Sigil of Spite (390163)

School: Chromatic | GCD: 1.5s | Charges: 1 (60s) | Duration: 2s | Range: 30yd

> Place a demonic sigil at the target location that activates after $d. Detonates to deal $389860s1 Chaos damage and shatter up to $s3 Lesser Soul Fragments from enemies affected by the sigil. Deals reduced damage beyond $s1 targets.

**Modified by:**
- Quickened Sigils (duration_modifier) [class]
- Any Means Necessary (damage_modifier)
- Chains of Anger (range_modifier) [spec]

### Soul Barrier (263648)

School: Shadow | GCD: 1.5s | CD: 30s | Duration: 15s

> Shield yourself for $d, absorbing $<baseAbsorb> damage. Consumes all available Soul Fragments to add $<fragmentAbsorb> to the shield per fragment.

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
- Demon Hide (damage_modifier)
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
- Accelerated Blade (damage_modifier)
- Seething Chaos (damage_modifier)
- Inertia (damage_modifier)
- Champion of the Glaive (range_modifier) [class]
- Reaver's Mark (buff_grant)
- Thrill of the Fight (mechanic_change)
- Demon Soul (damage_modifier)

## Talent Trees

### Class (41 talents)

**Row 1:**
- (1) **Vengeful Retreat** (198793) [off_gcd_ability]
  _Remove all snares and vault away. Nearby enemies take $198813s2 Physical damage$?s320635[ and have their movement speed reduced by $198813s1% for $198813d][].$?a203551[ |cFFFFFFFFGenerates ${($203650s..._
- (2) **Blazing Path** (320416) [passive]
  _$?a212613[Infernal Strike][Fel Rush] gains an additional charge._
- (3) **Sigil of Misery** (207684) [active_ability]
  _Place a Sigil of Misery at the target location that activates after $d. Causes all enemies affected by the sigil to cower in fear, disorienting them for $207685d._

**Row 2:**
- (1) **Vengeful Bonds** (320635) [passive_buff]
  _Vengeful Retreat reduces the movement speed of all nearby enemies by $198813s1% for $198813d._
- (2) **Unrestrained Fury** (320770) [passive]
  _Increases maximum Fury by $s1._
- (3) **Shattered Restoration** (389824) [passive_buff]
  _The healing of Shattered Souls is increased by $s1%._
- (4) **Improved Sigil of Misery** (320418) [passive]
  _Reduces the cooldown of Sigil of Misery by ${$s1/-1000} sec._

**Row 3:**
- (1) **Bouncing Glaives** (320386) [spell_modifier]
  → Throw Glaive (damage_modifier)
  _Throw Glaive ricochets to $s1 additional $ltarget:targets;._
- (2) **Imprison** (217832) [active_ability]
  _Imprisons a demon, beast, or humanoid, incapacitating them for $d. Damage may cancel the effect. Limit 1._
- (3) **Charred Warblades** (213010) [passive_buff]
  _You heal for $s1% of all Fire damage you deal._

**Row 4:**
- (1) **Chaos Nova** (179057) [active_ability]
  _Unleash an eruption of fel energy, dealing $s2 Chaos damage and stunning all nearby enemies for $d.$?s320412[ Each enemy stunned by Chaos Nova has a $s3% chance to generate a Lesser Soul Fragment.][]_
- (2) **Improved Disrupt** (320361) [spell_modifier]
  _Increases the range of Disrupt to ${$s2+$s1} yds._
- (3) **Consume Magic** (278326) [active_ability]
  _Consume $m1 beneficial Magic effect removing it from the target$?s320313[ and granting you $s2 Fury][]._
- (4) **Aldrachi Design** (391409) [passive]
  _Increases your chance to parry by $s1%._

**Row 5:**
- (1) **Chaos Fragments** (320412) [passive_buff]
  _Each enemy stunned by Chaos Nova has a $179057s3% chance to generate a Lesser Soul Fragment._
- (2) **Master of the Glaive** (389763) [proc_trigger]
  _Throw Glaive has ${$s2+1} charges and snares all enemies hit by $213405s1% for $213405d._
- (2) **Champion of the Glaive** (429211) [spell_modifier]
  → Throw Glaive (range_modifier)
  _Throw Glaive has ${$s2+1} charges and $s1 yard increased range._
- (3) **Disrupting Fury** (183782) [proc_trigger]
  _Disrupt generates $218903s1 Fury on a successful interrupt._
- (4) **Felblade** (232893) [active_ability]
  _Charge to your target and deal $213243sw2 $@spelldesc395020 damage. $?s263642[Fracture has a chance to reset the cooldown of Felblade. |cFFFFFFFFGenerates $213243s3 Fury.|r]?s203513[Shear has a chance..._
- (5) **Swallowed Anger** (320313) [passive_buff]
  _Consume Magic generates $278326s2 Fury when a beneficial Magic effect is successfully removed from the target._
- (6) **Aura of Pain** (207347) [spell_modifier]
  _Increases the critical strike chance of Immolation Aura by $s1%._
- (7) **Live by the Glaive** (428607) [proc_trigger]
  _When you parry an attack or have one of your attacks parried, restore $428608s2% of max health and $428608s1 Fury. This effect may only occur once every $s1 sec._

**Row 6:**
- (1) **Pursuit** (320654) [passive]
  _Mastery increases your movement speed._
- (2) **Soul Rending** (204909) [spell_modifier]
  → Metamorphosis (damage_modifier)
  _Leech increased by $s1%. Gain an additional $s2% leech while Metamorphosis is active._
- (3) **Infernal Armor** (320331) [spell_modifier]
  → Immolation Aura (damage_modifier)
  _Immolation Aura increases your armor by $s1% and causes melee attackers to suffer ${$320334s1/$s3} $@spelldesc395020 damage._
- (4) **Lost in Darkness** (389849) [spell_modifier]
  _Spectral Sight has ${$s1/-1000} sec reduced cooldown and no longer reduces movement speed._

**Row 7:**
- (1) **Felfire Haste** (389846) [proc_trigger]
  _$?c1[Fel Rush][Infernal Strike] increases your movement speed by $389847s1% for $389847d._
- (2) **Illidari Knowledge** (389696) [passive]
  _Reduces magic damage taken by $s1%._
- (4) **Will of the Illidari** (389695) [passive]
  _Increases maximum health by $s1%._
- (5) **Precise Sigils** (389799) [spell_modifier]
  _All Sigils are now placed at your target's location._

**Row 8:**
- (1) **Internal Struggle** (393822) [passive]
  _Increases your mastery by ${$s1*$mas}.1%._
- (2) **Darkness** (196718) [active_ability]
  _Summons darkness around you in a$?a357419[ 12 yd][n 8 yd] radius, granting friendly targets a $209426s2% chance to avoid all damage from an attack. Lasts $d. Chance to avoid damage increased by $s3% w..._
- (3) **Soul Sigils** (395446) [passive_buff]
  _Afflicting an enemy with a Sigil generates $m1 Lesser Soul $LFragment:Fragments;._
- (4) **Quickened Sigils** (209281) [spell_modifier]
  → Sigil of Silence (duration_modifier)
  → Sigil of Chains (duration_modifier)
  → Sigil of Flame (duration_modifier)
  → Sigil of Misery (duration_modifier)
  → Sigil of Spite (duration_modifier)
  _All Sigils activate ${$s1/-1000} second faster._

**Row 9:**
- (1) **Erratic Felheart** (391397) [passive]
  _The cooldown of $?a212613[Infernal Strike ][Fel Rush ]is reduced by ${-1*$s1}%._
- (2) **Pitch Black** (389783) [spell_modifier]
  → Darkness (cooldown_modifier)
  _Reduces the cooldown of Darkness by ${$s1/-1000} sec._
- (2) **Long Night** (389781) [spell_modifier]
  → Darkness (duration_modifier)
  _Increases the duration of Darkness by ${$s1/1000} sec._
- (3) **Rush of Chaos** (320421) [spell_modifier]
  → Metamorphosis (cooldown_modifier)
  _Reduces the cooldown of Metamorphosis by ${$m1/-1000} sec._
- (4) **Demon Muzzle** (388111) [passive_buff]
  _Enemies deal $s1% reduced magic damage to you for $394933d after being afflicted by one of your Sigils._
- (5) **Flames of Fury** (389694) [passive_buff]
  _Sigil of Flame deals $s2% increased damage and generates $s1 additional Fury per target hit._

**Row 10:**
- (3) **Sigil of Spite** (390163) [active_ability]
  _Place a demonic sigil at the target location that activates after $d. Detonates to deal $389860s1 Chaos damage and shatter up to $s3 Lesser Soul Fragments from enemies affected by the sigil. Deals red..._

### Spec (Vengeance) (48 talents)

**Row 1:**
- (1) **Fel Devastation** (212084) [active_ability]
  _Unleash the fel within you, damaging enemies directly in front of you for ${$212105s1*(2/$t1)} Fire damage over $d.$?s320639[ Causing damage also heals you for up to ${$212106s1*(2/$t1)} health.][]_

**Row 2:**
- (1) **Frailty** (389958) [passive_buff]
  _Enemies struck by Sigil of Flame are afflicted with Frailty for $247456d. You heal for $247456s1% of all damage you deal to targets with Frailty._
- (2) **Fiery Brand** (204021) [active_ability]
  _Brand an enemy with a demonic symbol, instantly dealing $s2 Fire damage$?s320962[ and ${$207771s5*$207771d} Fire damage over $207771d][]. The enemy's damage done to you is reduced by $s1% for $207744d..._
- (2) **Demon Blades** (203555) [proc_trigger]
  _Your auto attacks deal an additional $203796s1 $@spelldesc395041 damage and generate $203796m2-$203796M2 Fury._
- (2) **Insatiable Hunger** (258876) [passive_buff]
  _Demon's Bite deals $s2% more damage and generates $s3 to $s4 additional Fury._

**Row 3:**
- (1) **Fracture** (263642) [active_ability]
  _Rapidly slash your target for ${$225919sw1+$225921sw1} Physical damage, and shatter $s1 Lesser Soul Fragments from them. |cFFFFFFFFGenerates $s4 Fury.|r_
- (1) **Shear Fury** (389997) [spell_modifier]
  → Shear (damage_modifier)
  _Shear generates $s1 additional Fury._
- (1) **Improved Fel Rush** (343017) [spell_modifier]
  _Fel Rush damage increased by $s1%._
- (2) **Deflecting Spikes** (321028) [passive_buff]
  _Demon Spikes also increases your Parry chance by $203819s1% for $203819d._
- (3) **Ascending Flame** (428603) [passive]
  _Sigil of Flame's initial damage is increased by $s2%. Multiple applications of Sigil of Flame may overlap._

**Row 4:**
- (1) **Perfectly Balanced Glaive** (320387) [passive]
  _Reduces the cooldown of Throw Glaive by ${$abs($s0/1000)} sec._
- (2) **Calcified Spikes** (389720) [passive_buff]
  _You take $391171s2% reduced damage after Demon Spikes ends, fading by 1% per second._
- (3) **Sigil of Silence** (202137) [active_ability]
  _Place a Sigil of Silence at the target location that activates after $d. Silences all enemies affected by the sigil for $204490d._
- (3) **Roaring Fire** (391178) [passive]
  _Fel Devastation heals you for up to $s1% more, based on your missing health._
- (4) **Retaliation** (389729) [passive_buff]
  _While Demon Spikes is active, melee attacks against you cause the attacker to take $391159s1 Physical damage. Generates high threat._
- (5) **Meteoric Strikes** (389724) [passive]
  _Reduce the cooldown of Infernal Strike by ${$s1/-1000} sec._

**Row 5:**
- (1) **Spirit Bomb** (247454) [active_ability]
  _Consume up to $s2 available Soul Fragments then explode, damaging nearby enemies for $247455s1 Fire damage per fragment consumed, and afflicting them with Frailty for $247456d, causing you to heal for..._
- (2) **Agonizing Flames** (207548) [spell_modifier]
  → Immolation Aura (damage_modifier)
  _Immolation Aura increases your movement speed by $s1% and its duration is increased by $s2%._
- (3) **Extended Spikes** (389721) [spell_modifier]
  → Demon Spikes (duration_modifier)
  _Increases the duration of Demon Spikes by ${$s1/1000} sec._
- (4) **Burning Blood** (390213) [spell_modifier]
  → Chaos Nova (damage_modifier)
  → Infernal Strike (damage_modifier)
  → Fiery Brand (damage_modifier)
  → Soul Carver (damage_modifier)
  → Spirit Bomb (damage_modifier)
  → Essence Break (damage_modifier)
  → Bulk Extraction (damage_modifier)
  _Fire damage increased by $s1%._
- (5) **Revel in Pain** (343014) [proc_trigger]
  _When Fiery Brand expires on your primary target, you gain a shield that absorbs up ${$AP*($s2/100)*(1+$@versadmg)} damage for $343013d, based on your damage dealt to them while Fiery Brand was active._

**Row 6:**
- (1) **Void Reaver** (268175) [proc_trigger]
  _Frailty now also reduces all damage you take from afflicted targets by $s2%. Enemies struck by Soul Cleave are afflicted with Frailty for $247456d._
- (3) **Fallout** (227174) [passive_buff]
  _Immolation Aura's initial burst has a chance to shatter Lesser Soul Fragments from enemies._
- (4) **Ruinous Bulwark** (326853) [spell_modifier]
  _Fel Devastation heals for an additional $s1%, and $s2% of its healing is converted into an absorb shield for $326863d._
- (5) **Volatile Flameblood** (390808) [passive_buff]
  _Immolation Aura generates $m-$M Fury when it deals critical damage. This effect may only occur once per ${$proccooldown+0.1} sec._
- (6) **Bulk Extraction** (320341) [active_ability]
  _Demolish the spirit of all those around you, dealing $s1 Fire damage to nearby enemies and extracting up to $s2 Lesser Soul Fragments, drawing them to you for immediate consumption._
- (6) **Soul Barrier** (263648) [active_ability]
  _Shield yourself for $d, absorbing $<baseAbsorb> damage. Consumes all available Soul Fragments to add $<fragmentAbsorb> to the shield per fragment._
- (7) **Fel Flame Fortification** (389705) [passive_buff]
  _You take $393009s1% reduced magic damage while Immolation Aura is active._

**Row 7:**
- (1) **Soul Furnace** (391165) [proc_trigger]
  _Every $391166u Soul Fragments you consume increases the damage of your next Soul Cleave or Spirit Bomb by $391172s1%._
- (2) **Painbringer** (207387) [passive_buff]
  _Consuming a Soul Fragment reduces all damage you take by $s1% for $212988d. Multiple applications may overlap._
- (3) **Sigil of Chains** (202138) [active_ability]
  _Place a Sigil of Chains at the target location that activates after $d. All enemies affected by the sigil are pulled to its center and are snared, reducing movement speed by $204843s1% for $204843d._
- (4) **Fiery Demise** (389220) [passive]
  _Fiery Brand also increases Fire damage you deal to the target by $s1%._
- (5) **Chains of Anger** (389715) [spell_modifier]
  → Sigil of Silence (range_modifier)
  → Sigil of Chains (range_modifier)
  → Sigil of Flame (range_modifier)
  → Sigil of Misery (range_modifier)
  → Sigil of Spite (range_modifier)
  _Increases the duration of your Sigils by ${$s2/1000} sec and radius by $s1 yds._

**Row 8:**
- (1) **Focused Cleave** (343207) [passive_buff]
  _Soul Cleave deals $s1% increased damage to your primary target._
- (2) **Soulmonger** (389711) [passive_buff]
  _When consuming a Soul Fragment would heal you above full health it shields you instead, up to a maximum of ${$MHP*$s1/100}._
- (3) **Stoke the Flames** (393827) [spell_modifier]
  _Fel Devastation damage increased by $s1%._
- (3) **Restless Hunter** (390142) [passive_buff]
  _Leaving demon form grants a charge of Fel Rush and increases the damage of your next Blade Dance by $390212s1%._
- (4) **Burning Alive** (207739) [passive_buff]
  _Every $207771t3 sec, Fiery Brand spreads to one nearby enemy._
- (5) **Cycle of Binding** (389718) [passive_buff]
  _Sigil of Flame reduces the cooldown of your Sigils by $s1 sec._

**Row 9:**
- (1) **Vulnerability** (389976) [passive_buff]
  _Frailty now also increases all damage you deal to afflicted targets by $s1%._
- (2) **Feed the Demon** (218612) [passive_buff]
  _Consuming a Soul Fragment reduces the remaining cooldown of Demon Spikes by ${$s1/100}.2 sec._
- (3) **Charred Flesh** (336639) [passive_buff]
  _Immolation Aura damage increases the duration of your Fiery Brand and Sigil of Flame by ${$s1/1000}.2 sec._

**Row 10:**
- (1) **Soulcrush** (389985) [spell_modifier]
  → Frailty (stacking_modifier)
  _Multiple applications of Frailty may overlap. Soul Cleave applies Frailty to your primary target for $s2 sec._
- (2) **Soul Carver** (207407) [active_ability]
  _Carve into the soul of your target, dealing ${$s2+$214743s1} Fire damage and an additional $o1 Fire damage over $d.  Immediately shatters $s3 Lesser Soul Fragments from the target and $s4 additional L..._
- (3) **Last Resort** (209258) [passive]
  _Sustaining fatal damage instead transforms you to Metamorphosis form. This may occur once every $209261d._
- (4) **Darkglare Boon** (389708) [passive_buff]
  _When Fel Devastation finishes fully channeling, it refreshes $s1-$s2% of its cooldown and refunds $s3-$s4 Fury._
- (5) **Down in Flames** (389732) [passive]
  _Fiery Brand has ${$s1/-1000} sec reduced cooldown and $s2 additional $lcharge:charges;._
- (5) **Illuminated Sigils** (428557) [passive]
  _Sigil of Flame has ${$s3/-1000} sec reduced cooldown and $s1 additional $lcharge:charges;. You have $s2% increased chance to parry attacks from enemies afflicted by your Sigil of Flame._

### Hero: Aldrachi Reaver (14 talents)

**Row 1:**
- (1) **Art of the Glaive** (442290) [proc_trigger]
  _Consuming $?a212612[$s1][$s2] Soul Fragments or casting The Hunt converts your next Throw Glaive into Reaver's Glaive. $@spellicon442294 $@spellname442294: $@spelldesc442294_

**Row 2:**
- (1) **Fury of the Aldrachi** (442718) [passive_buff]
  _When enhanced by Reaver's Glaive, $?a212612[Blade Dance][Soul Cleave] casts $s2 additional glaive slashes to nearby targets. If cast after $?a212612[Chaos Strike]?s263642[Fracture][Shear], cast $?a123..._
- (2) **Evasive Action** (444926) [proc_trigger]
  _Vengeful Retreat can be cast a second time within $444929d._
- (2) **Unhindered Assault** (444931) [passive_buff]
  _Vengeful Retreat resets the cooldown of Felblade._
- (3) **Reaver's Mark** (442679) [passive_buff]
  _When enhanced by Reaver's Glaive, $?a212612[Chaos Strike]?s263642[Fracture][Shear] applies Reaver's Mark, which causes the target to take $442624s1% increased damage for $442624d. Max $442624u stacks...._

**Row 3:**
- (1) **Aldrachi Tactics** (442683) [passive_buff]
  _The second enhanced ability in a pattern shatters an additional Soul Fragment._
- (2) **Army Unto Oneself** (442714) [passive_buff]
  _Felblade surrounds you with a Blade Ward, reducing damage taken by $442715s1% for $442715d._
- (2) **Incorruptible Spirit** (442736) [passive_buff]
  _Each Soul Fragment you consume shields you for an additional $s1% of the amount healed._
- (3) **Wounded Quarry** (442806) [passive_buff]
  _Expose weaknesses in the target of your $@spellname442624, causing your Physical damage to any enemy to also deal $s1% of the damage dealt to your marked target as Chaos, and sometimes shatter a Lesse..._

**Row 4:**
- (1) **Incisive Blade** (442492) [spell_modifier]
  → Soul Cleave (damage_modifier)
  _$?a212612[Chaos Strike][Soul Cleave] deals $s1% increased damage._
- (2) **Keen Engagement** (442497) [passive]
  _Reaver's Glaive generates $s1 Fury._
- (2) **Preemptive Strike** (444997) [proc_trigger]
  _Throw Glaive deals $444979s1 Physical damage to enemies near its initial target._
- (3) **Warblade's Hunger** (442502) [proc_trigger]
  _Consuming a Soul Fragment causes your next $?a212612[Chaos Strike]?s263642[Fracture][Shear] to deal $442507s1 additional Physical damage.$?a212612[ Felblade consumes up to $s2 nearby Soul Fragments.][..._

**Row 5:**
- (1) **Thrill of the Fight** (442686) [passive_buff]
  _After consuming both enhancements, gain Thrill of the Fight, increasing your attack speed by $442695s1% for $442695d and your damage and healing by $442688s1% for $442688d._

### Hero: Annihilator (0 talents)

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
- Eye Beam (198013): 30 Fury
- Fel Devastation (212084): 50 Fury
- Soul Cleave (228477): 30 Fury
- Spirit Bomb (247454): 40 Fury
- Fel Barrage (258925): 10 Fury
- Glaive Tempest (342817): 30 Fury

### Soul Fragment Generators
- Chaos Nova (179057)
- Metamorphosis (187827)
- Shear (203782)
- Fracture (263642)
- Chaos Fragments (320412)

### Soul Fragment Consumers
- Soul Cleave (228477)
- Spirit Bomb (247454)
- Soul Barrier (263648)
- Soul Furnace (391165)
- Warblade's Hunger (442502)
- Incorruptible Spirit (442736)
