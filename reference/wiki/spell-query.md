# Spell Query

Source: https://github.com/simulationcraft/simc/wiki/SpellQuery

## Overview

SpellQuery is a spell data search feature in SimulationCraft that doesn't perform simulations but instead reads expressions to filter spell and talent data. It outputs matching spells or talents from live or PTR servers.

## Basic Usage

The `spell_query` option filters spell/talent data. You can append `@level` to specify actor level or item level scaling.

## Data Sources

Available identifier data sources include:

- `spell` - Master spell list
- `talent` - Master talent list
- `talent_spell` - Spell IDs used by talents
- `class_spell` - Class spells (clickable, includes pets)
- `race_spell` - Racial spells
- `mastery` - Class masteries
- `spec_spell` - Specialization spells
- `glyph` - Glyph spells
- `set_bonus` - Set bonus spells
- `effect` - All effects
- `azerite` - Azerite power spells
- `covenant_spell` - Covenant abilities
- `soulbind_spell` - Soulbind abilities
- `conduit_spell` - Conduit abilities
- `runeforge_spell` - Runeforge legendary spells

## Filterable Fields

**String fields:** name, school, class, pet_class, covenant, desc, tooltip

**Numeric fields:** id, speed, scaling, level, max_level, min_range, max_range, cooldown, gcd, charges, duration, max_stack, proc_chance, icd, cast_min, cast_max, attribute, flag

**String operators:** `==`, `!=`, `~`, `!~`

**Numeric operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`

## Operators for Lists

- `&` - Intersection
- `|` - Union
- `-` - Subtraction

## Important Notes

All string-based filtering requires whitespaces converted to underscores and no special characters. Comparisons are case-insensitive.

## Examples

Query all Shaman class spells:

```
simc spell_query=class_spell.class=shaman
```

Query spells containing "shadow damage":

```
simc spell_query="spell.desc~shadow_damage|spell.tooltip~shadow_damage"
```

Query class spells costing resources:

```
simc spell_query="class_spell.cost>0"
```
