# Raid Events

Source: https://github.com/simulationcraft/simc/wiki/RaidEvents

## Fight Styles

- **Patchwerk**: Empty events, pure single-target
- **CastingPatchwerk**: ST with casting mechanics
- **LightMovement**: Infrequent movement
- **HeavyMovement**: Frequent movement, multiple distances
- **DungeonSlice**: Approximates M+ with boss + alternating add waves
- **DungeonRoute**: Pull-based encounter framework
- **HecticAddCleave**: Regular adds + frequent movement
- **HelterSkelter**: Chaotic (casting, movement, stuns, invulnerability)
- **CleaveAdd**: Regular add spawning

## Event Syntax

Core options for all events:

- `cooldown`/`period`: Frequency (seconds)
- `duration`: Length (seconds)
- `distance`: Movement distance (yards)
- `cooldown_stddev`/`duration_stddev`: Variation
- `first`/`last`: Start/end time
- `first_pct`/`last_pct`: Health % triggers
- `force_stop`: Cancel at phase boundaries
- `timestamp`: Specific times (colon-delimited)

## Player Filtering

- `players_only`: Ignore pets
- `player_chance`: Per-player probability (0.0-1.0)
- `distance_min`/`distance_max`: Position filtering
- `player_if`: Expression-based filtering

## Adds

```
raid_event=/adds,count=3,duration=15,cooldown=45,first=20
```

Options: `count`, `count_range`, `name`, `health`, `same_duration`, `spawn_x`/`spawn_y`, `distance`, `spawn_distance_min`/`max`, `angle_start`/`end`, `stacked`

## Pull (DungeonRoute)

```
raid_event=/pull,pull=1,enemies="Trash:2000000/BOSS_Boss:10000000",bloodlust=1
raid_event=/pull,pull=2,delay=5,enemies="Pack:1500000:Beast/Pack:1500000:Beast"
```

## Other Event Types

- **casting**: Force interruptible casts
- **movement**: `move_distance`, `to`, `direction` (omni/away/towards)
- **stuns**: Periodic stuns
- **invulnerability**: `retarget`, `target`
- **damage**: `amount`, `amount_range`, `type`
- **heal**: `amount`, `to_pct`, `to_pct_range`
- **vulnerability**: `multiplier` (default 1.0 = 2x damage), `target`
- **distraction**: `skill` (reduction multiplier, default 0.2)
- **buff**: `buff_name`, `stacks`
