# Equipment

Source: https://github.com/simulationcraft/simc/wiki/Equipment

This documentation is part of the TCI (Textual Configuration Interface) reference.

## Declaring Items

### Syntax

Equipment pieces use this format: `<slot>=<item_name>[,<option1=value1>,<option2=value2>,...]`

Item names replace spaces with underscores.

Examples:

```
head=earthen_helmet

head=earthen_helmet,type=plate,ilevel=359,quality=epic,stats=2784armor_168crit_228haste_512sta_281str,gems=destructive_shadowspirit_20crit_20str_30str,enchant=60str_35mastery

head=earthen_helmet,id=60325,gems=destructive_shadowspirit_20crit_20str_30str,enchant=60str_35mastery
```

### Slot Keywords

Valid slots: meta_gem, head, neck, shoulder/shoulders, back, shirt, chest, waist, wrist/wrists, hand/hands, legs, feet, finger1/ring1, finger2/ring2, trinket1, trinket2, main_hand, off_hand, ranged, tabard

## Options

### Importing Stats Through ID

- **id** (default: 0): Specifies item ID to query stats from item sources
- **source** (default: ""): Overrides the item_db_source setting for this item

```
head=earthen_helmet,id=60325
head=earthen_helmet,id=60325,source=mmoc|local
```

### Basic Properties

- **quality**: Item quality (rare, epic, uncommon)
- **ilevel**: Item level
- **type**: Armor type (cloth, leather, mail, plate)
- **lfr**: Flag as looking for raid (1 or 0)
- **heroic**: Flag as heroic (1 or 0)
- **warforged**: Flag as elite/warforged (1 or 0)
- **mythic**: Flag as mythic (1 or 0)
- **upgrade**: Apply upgrade level (1 or 2). Requires quality and ilevel.

```
head=some_helm,type=plate
head=darkfang_mask,id=105542,upgrade=2
```

### Stats

- **stats**: Sequence of stat values using format `<value1><stat1>[_<value2><stat2>_...]`

```
head=earthen_helmet,stats=2784armor_168crit_228haste_512sta_281str
```

- **weapon**: Specifies weapon damage ranges with syntax `weapon=<type>[_<option1>=<value1>...]`

Types: dagger, fist, beast, beast2h, sword, sword2h, mace, mace2h, axe, axe2h, staff, polearm, bow, gun, crossbow, thrown, arcane, bleed, chaos, fire, frost, frostfire, holy, nature, physical, shadow, spellstorm, shadowfrost, shadowflame, drain

Options:

- **speed** (mandatory): Weapon speed in seconds
- **min/max**: Damage range
- **dps**: Weapon DPS
- **dmg/damage**: Constant damage

```
main_hand=some_axe,weapon=axe2h_4.0speed_1750min_2250max
main_hand=some_axe,weapon=axe2h_4.0speed_500dps
main_hand=some_axe,weapon=axe2h_4.0speed_2000dmg
```

### Gems

- **gems**: Gem bonuses using format `[<metaprefix>_<metasuffix>][_<value1><stat1>...]`

```
head=earthen_helmet,gems=destructive_shadowspirit_20crit_20str_30str
```

### Enchants

- **enchant**: Either a stats sequence or recognized keyword

```
main_hand=shalugdoom_the_axe_of_unmaking,enchant=landslide
main_hand=shalugdoom_the_axe_of_unmaking,enchant=burning_writ_3
main_hand=shalugdoom_the_axe_of_unmaking,enchant=500str
```

### Embellishments

- **embellishment**: Tokenized name of embellishment to add

```
back=vibrant_wildercloth_shawl,id=193511,embellishment=blue_silken_lining
```

### Procs

- **use**: On-use effects with syntax `<value1><param1>[_<value2><param2>...]`

Parameters: school abbreviation, stat abbreviation, cd/cooldown, dur/duration, stack/stacks, aoe, driver, tick, reverse

```
trinket1=unsolvable_riddle,stats=321mastery,use=1605str_120cd_20dur
trinket1=custom_trinket,use=100Agi_10stack_1tick_10dur_60cd
```

- **equip**: Proc effects with syntax `<trigger>_<value1><param1>[_<value2><param2>...]`

Additional parameters: procby, procon, %, ppm, rppm, driver, trigger, refresh, norefresh

```
trinket1=darkmoon_card_hurricane,stats=321str,equip=procby/attack_5000nature_10%
trinket1=custom_trinket,equip=procby/attack_procon/crit_100agi_10dur_5%
```

- **addon**: Shortcut for built-in proc effects

```
hands=some_gloves,addon=pyrorocket
```

- **initial_cd**: Minimum time before procs occur

```
trinket1=soul_capacitor,id=124225,bonus_id=567,initial_cd=3.5
```

### Set Bonuses

Set bonuses must be manually added:

```
set_bonus=tier17_2pc=1
set_bonus=tier17_4pc=1
```

For hero tree sets:

```
set_bonus=tww3_felscarred_2pc=1
set_bonus=name=thewarwithin_season_3,pc=2,hero_tree=felscarred,enable=1
```

## Item Data Importation

- **item_db_source** (scope: global; default: "wowhead,mmoc,bcpapi,ptrhead,local"): Sequence of sources

Sources: "wowhead", "bcpapi", "ptrhead", "local"

```
item_db_source=local|wowhead
```

## Additional Commands

```
scale_to_itemlevel=600
```

## Appendix: Stats Abbreviations

- Resources: health, mana, energy, rage, runic, focus
- Primary: str, agi, sta, int, spi
- Secondary: mastery, crit, haste, vers, mult, sp, ap, mp5
- Defensive: armor, bonus_armor
- Weapon damages: wdps, wspeed, wohdmg, wohspeed
