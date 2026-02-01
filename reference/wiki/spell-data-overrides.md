# Spell Data Overrides

Source: https://github.com/simulationcraft/simc/wiki/SpellDataOverrides

## Spell Data

Spells consist of three main components: spell data (basic information like name, cast time, cooldown), effect data (actionable properties such as healing or damage), and optional power data (resource cost characteristics).

SimulationCraft extracts spell, effect, and power data for use in class modules and simulator features. The system also allows users to override data to explore hypothetical scenarios without code changes.

## Spell Data Override

Data overriding uses the format: `override.spell_data=<spell|effect|power>.<id>.<field>=value`

Where:

- `spell`, `effect`, or `power` indicates the data type
- `id` is the numerical identifier
- `field` is the data attribute to override

For player-specific overrides, use `override.player.spell_data` in player scope.

**Important considerations:**

- This is a low-level feature not intended for typical users
- Results can be unintuitive due to hardcoded values in class modules, incorrect spell/effect identification, or locally cached spell data
- Overriding spell data should always be done before the character definition

## List of Fields

### Spells

- `prj_speed` (float): Projectile speed in yards/second
- `school` (integer): School mask
- `scaling_class` (integer): Internal scaling class value
- `spell_level` (integer): Required spell level
- `max_level` (integer): Maximum scaling level
- `req_max_level` (integer): Required caster maximum level
- `max_scaling_level` (integer): Caps scaling at `min(player_level, max_scaling_level)`
- `min_range` (float): Minimum range
- `max_range` (float): Maximum range
- `cooldown` (integer, milliseconds): Spell cooldown
- `charge_cooldown` (integer, milliseconds): Charge cooldown
- `internal_cooldown` (integer, milliseconds): Internal cooldown
- `category_cooldown` (integer, milliseconds): Category cooldown
- `charges` (integer): Cooldown charges
- `gcd` (integer, milliseconds): Global cooldown
- `duration` (integer, milliseconds): Aura duration
- `rune_cost` (integer): Rune cost (Obsoleted in release 7)
- `runic_power_gain` (integer): Runic power gain x 10
- `max_stack` (integer): Maximum aura stack
- `proc_charges` (integer): Stacks per trigger
- `proc_chance` (integer): Trigger percent chance
- `cast_min` (integer, milliseconds): Minimum cast time
- `cast_max` (integer, milliseconds): Maximum cast time
- `rppm` (float): RPPM value
- `class_flags_family` (integer): Spell family
- `class_flags` (integer): Bit array grouping flags (positive adds, negative removes)
- `attributes` (integer): Attribute bit array (positive sets, negative unsets)

### Effects

- `coefficient` (float): Average scaling coefficient
- `delta` (float): Delta scaling coefficient
- `bonus` (float): Bonus/combo point scaling coefficient
- `sp_coefficient` (float): Spell power coefficient
- `ap_coefficient` (float): Attack power coefficient
- `period` (integer, milliseconds): Base tick time
- `base_value` (integer): Base effect value
- `misc_value1` (integer): First misc value
- `misc_value2` (integer): Second misc value
- `chain_multiplier` (float): Target-jump multiplier
- `points_per_combo_points` (float): Legacy bonus field (unused)
- `points_per_level` (float): Legacy average field (unused)
- `die_sides` (integer): Legacy delta field (unused)
- `class_flags` (integer): Affected spell groups (positive adds, negative removes)

### Powers

Power data fields (added in release 7.2.0 release 2):

- `cost` (integer): Absolute resource cost
- `cost_per_tick` (integer): Absolute cost per tick
- `max_cost` (integer): Absolute maximum cost
- `pct_cost` (float): Percent cost [0..1]
- `pct_cost_per_tick` (float): Percent cost per tick [0..1]
- `max_pct_cost` (float): Maximum percent cost [0..1]

**Power data quirks:**

- Some absolute resources are expressed in tenths of units (Rage, Runic Power, Burning Ember, Astral Power, Pain, Demonic Fury). Multiply by 10 when overriding.
- Variable-cost spells have in-game maximum = cost + max_cost field value
- Cannot add completely new resource costs to spells

## Examples

To change Icy Talons base value from 30 to 45:

```
$ simc override.spell_data=effect.43156.base_value=45 spell_query=spec_spell.name=icy_talons
```

Place overrides before spell_query options to apply them correctly.
