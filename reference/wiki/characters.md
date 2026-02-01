# Characters

Source: https://github.com/simulationcraft/simc/wiki/Characters

## Declaration

Define characters BEFORE enemies (required for profileset compatibility).

```
warrior=John
demon_hunter=Jane
```

**copy** duplicates a character:

```
armory=us,illidan,john
copy=john_evil_twin
```

## Importation

### Armory

```
armory=us,illidan,john
armory=eu,archimonde,bill,roger
```

### From Local JSON

```
local_json=mainfile,spec=specfile,equipment=equipmentfile
```

## Talents

**talents** accepts Blizzard's export hash or tree-specific inputs:

```
class_talents=19979:1/20024:1/shadowfiend:1/improved_shadowfiend:1
spec_talents=mind_flay:1/vampiric_touch:1/devouring_plague:1
hero_talents=keeper_of_the_grove
```

## Key Options

- **race**: blood_elf, night_elf, human, orc, etc.
- **level**: Default 80 (TWW)
- **role**: dps, heal, tank
- **position**: front, back, ranged_front, ranged_back
- **distance**: Yards from boss
- **skill** (default: 1.0): Player performance (0.8 = 20% error chance)
- **bugs** (default: 1): Reproduce known server bugs

## Consumables

```
flask=whispered_pact
food=lemon_herb_filet
potion=prolonged_power
augmentation=defiled
temporary_enchant=main_hand:howling_rune_3
```

Disable: `potion=disabled`, `food=disabled`, etc.

## Stat Overrides

- **gear_strength/agility/intellect/etc.**: Override total gear stat contribution
- **enchant_strength/etc.**: Add bonus/malus on top of gear
- **set_bonus=tier17_2pc=1**: Enable set bonuses

## Pets

```
pet=felguard
pet=cat,cat
```

## Other

- **sleeping** (default: 0): Deactivate without removing
- **quiet** (default: 0): Remove from reports but keep in sim
- **use_pre_potion** (default: 1): Allow pre-combat potion
- **ready_trigger** (default: false): Event-based action scheduling
