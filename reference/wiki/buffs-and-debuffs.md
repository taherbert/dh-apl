# Buffs and Debuffs

Source: https://github.com/simulationcraft/simc/wiki/BuffsAndDebuffs

## Optimal Raid

**optimal_raid** (global; default: 1) automatically grants all appropriate raid buffs including Bloodlust at fight start. Disable for dynamic buff application in full raid sims.

```
optimal_raid=0
```

## Overrides

Individual buffs/debuffs controlled after `optimal_raid`:

- override.bloodlust
- override.arcane_intellect
- override.battle_shout
- override.mark_of_the_wild
- override.power_word_fortitude
- override.chaos_brand
- override.mystic_touch
- override.windfury_totem
- override.hunters_mark
- override.bleeding (permanent bleed on target)

```
optimal_raid=1
override.bloodlust=0
```

## Bloodlust Triggers

Checked every 1 second:

- **bloodlust_percent** (default: 0): Health % threshold
- **bloodlust_time** (default: 0): Elapsed time (positive) or remaining time (negative)

```
bloodlust_time=-100
bloodlust_percent=20
```

## External Buffs

Timed buffs with cast times separated by `/`:

- external_buffs.power_infusion
- external_buffs.blessing_of_summer/autumn/winter/spring
- external_buffs.rallying_cry
- external_buffs.tome_of_unstable_power (requires ilevel setting)
- external_buffs.potion_bomb_of_power

Disable with empty assignment: `external_buffs.power_infusion=`
