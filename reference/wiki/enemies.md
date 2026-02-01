# Enemies

Source: https://github.com/simulationcraft/simc/wiki/Enemies

Define enemies AFTER character profiles (required for profileset compatibility).

## Built-in Enemies

- **Fluffy Pillow**: Default enemy. Stationary for DPS, auto-attacks tank targets.
- **tank_dummy**: City-style tank dummy with configurable type (`weak`, `dungeon`, `mythic`)
- **tmi_boss**: TMI standard boss for tank scoring (`T17L`, `T17N`, `T17H`, `T17M`)

## Custom Enemies

```
enemy=Mean_Fluffy_Pillow
enemy_tank=Theck
```

### Health Options

- **enemy_health**: Set starting health
- **enemy_fixed_health_percentage**: Maintain constant health %
- **enemy_initial_health_percentage**: Start at specific %
- **enemy_death_pct**: Kill early at % (affects all enemies)
- **enemy_custom_health_timeline**: Custom time-in-health-range (`35:0.8` = last 20% of fight under 35% HP). Requires `fixed_time`.

### Enemy Action Lists

Available abilities:

- **auto_attack**: Melee auto-attack
- **auto_attack_off_hand**: Off-hand auto-attack
- **melee_nuke**: Direct physical damage
- **spell_nuke**: Direct fire damage
- **spell_dot**: Fire DoT
- **spell_aoe**: Raid-wide fire damage
- **summon_add**: Spawn an add

Ability options: `damage`, `attack_speed`, `range`, `cooldown`, `aoe_tanks`, `apply_debuff`, `type`, `dot_duration`, `tick_time`

```
enemy=Razor_Sharp_Pillow
actions=auto_attack,damage=500,range=100,attack_speed=2.0
actions+=/melee_nuke,damage=5000,cooldown=5,attack_speed=0
actions+=/spell_aoe,damage=2500,cooldown=20,attack_speed=2.0
```

## Multiple Targets

```
desired_targets=4
# or define individually:
enemy=Fluffy_Pillow
enemy=enemy2
enemy=enemy3
```

## Global Options

- **target_level**: Set all target levels (default: +3 above player)
- **target_race**: Set target race for talent effects (undead, beast, demon, etc.)
