# Coded Flags

Source: https://github.com/simulationcraft/simc/wiki/CodedFlags

## Introduction

This page documents action flags used in SimulationCraft code for configuring abilities and procs. This is not an exhaustive list.

## Action Flags

### Damage & Resource

- `school` - Specifies damage type (e.g., SCHOOL_PHYSICAL)
- `resource_current` - Defines resource consumed (e.g., RESOURCE_RAGE)
- `aoe` - Number of targets affected; -1 hits all targets
- `base_costs` - Resource cost for using ability
- `costs_per_second` - Resource cost per second of use

### Strike Mechanics

- `may_multistrike` - Enables/disables multistrike procs (0/1/-1 options)
- `may_hit`, `may_miss`, `may_dodge`, `may_parry`, `may_glance`, `may_block`, `may_crush`, `may_crit` - Hit outcome possibilities
- `special` - Whether spell uses yellow attack hit table
- `periodic_hit` - Related to periodic damage outcomes

### Execution

- `channeled` - Prevents other actions during execution
- `background` - Disables direct execution in action lists
- `repeating` - For abilities repeating without user input
- `use_off_gcd` - Checks conditions every 0.1 seconds
- `quiet` - Disables reporting

### Damage Behavior

- `split_aoe_damage` - Distributes AOE damage evenly
- `base_add_multiplier` - Damage decay per target
- `weapon_multiplier` - Weapon damage scaling
- `attack_power_mod.direct/tick` - Attack power scaling
- `spell_power_mod.direct/tick` - Spell power scaling

### Cooldowns & Timing

- `cooldown` - Manipulates duration and charges
- `min_gcd` - Minimum global cooldown regardless of haste
- `trigger_gcd` - GCD length triggered on use
- `base_execute_time` - Pre-modifier execution time
- `base_tick_time` - Time between ticks

### DOT Management

- `dot_duration` - Default DOT duration
- `tick_zero` - Immediate tick on cast
- `hasted_ticks` - Ticks scale with haste
- `tick_may_crit` - Periodic ticks can critically hit
- `dot_behavior` - DOT_CLIP, DOT_REFRESH, or DOT_EXTEND

### Miscellaneous

- `harmful` - Determines if ability pulls boss; affects precombat limits
- `proc` - Whether ability is a proc
- `callbacks` - Enables/disables proc callback system
- `dual` - Excludes action from total execution count
- `range` - Ability usage distance
- `movement_directionality` - MOVEMENT_OMNI, MOVEMENT_TOWARDS, MOVEMENT_AWAY
- `base_teleport_distance` - Maximum travel distance for movement abilities
- `rp_gain` - Death Knight runic power generation
