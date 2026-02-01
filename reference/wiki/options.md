# Options

Source: https://github.com/simulationcraft/simc/wiki/Options

This is part of the Textual Configuration Interface reference.

## Public Test Realms

**ptr** (scope: ulterior characters; default: 0) allows targeting the PTR version. By default, SimulationCraft targets the live WoW version.

```
ptr=0
#<Insert other options here>
#<Insert character declarations here>

ptr=1
copy=EvilTwin
```

## Combat Length

### Time-Based Models

Two time-based combat length models exist:

- **Fixed Time** _(default)_: Combat length depends purely on configured time parameters with uniformly distributed enemy health.
- **Enemy Health Estimation**: Enemy health adjusts so combat length based on enemy death corresponds to configured parameters. Set `fixed_time=0`.

#### Configuration

**max_time** (scope: global; default: 300) sets desired average fight duration in seconds:

```
max_time=400
```

**vary_combat_length** (scope: global; default: 0.2) artificially varies combat length linearly across iterations as a fraction of **max_time**, between 0 and 1:

```
max_time=200
vary_combat_length=0.1
```

**fixed_time** (scope: global; default: 1) enables the Fixed Time model when non-zero:

```
max_time=300
vary_combat_length=0.0
fixed_time=1
```

### Fixed Enemy Health Model

**override.target_health** (scope: global; default: 0) specifies initial target health pool when non-zero:

```
override.target_health=100000000
```

### Safeguards

All configurations include a safeguard to prevent endless simulations:

```
simulation_end = 2 * max_time * ( 1 + vary_combat_length )
```

## Infinite Resources

**infinite_rage, energy, mana, focus, runic, health** (scope: global; default: 0) provide infinite resources:

```
infinite_mana=1
```

## Latency

**strict_gcd_queue** (scope: global; default: 0) properly models in-game GCD queue when non-zero:

```
strict_gcd_queue=1
```

**gcd_lag** (scope: global; default: 0.150) represents client latency in seconds for queued GCD actions.

**gcd_lag_stddev** (scope: global; default: 0.0) provides standard deviation for gcd_lag.

```
gcd_lag=0.05
gcd_lag_stddev=0.01
```

**channel_lag** (scope: global; default: 0.250) represents client latency for channel ticks.

**channel_lag_stddev** (scope: global; default: 0.0) provides standard deviation for channel_lag.

```
channel_lag=0.10
channel_lag_stddev=0.02
```

**queue_lag** (scope: global; default: 0.037) represents server processing duration for queued GCD-bound actions.

**queue_lag_stddev** (scope: global; default: 0.0) provides standard deviation for queue_lag.

```
queue_lag=0.01
queue_lag_stddev=0.002
```

**default_world_lag** (scope: global; default: 0.1) represents network latency to the server:

```
default_world_lag=0.3
default_world_lag_stddev=0.05
```

**travel_variance** (scope: global; default: 0.075) is the standard deviation in seconds for ranged spell flight time:

```
travel_variance=0.150
```

### Latency Notes

1. **gcd_lag** and **channel_lag** can simulate brain lag alongside **skill** and **reaction_time** options.
2. Very small or zero lag values can cause haste plot discontinuities.

## Multithreading

**threads** (scope: global; default: 0) specifies the number of computation threads. Zero or negative uses all available CPU threads:

```
threads=7
```

**process_priority** (scope: global; default: below_normal; choices: low, below_normal, normal, above_normal, highest):

```
process_priority=low
```

## Networking

### HTTP Cache

**http_clear_cache** (scope: ulterior HTTP calls; default: 0) flushes the HTTP cache when non-zero:

```
http_clear_cache=1
```

### Proxy

**proxy** (scope: subsequent network operations; default "none,,0") specifies a proxy:

```
proxy=http,proxy.example.com,3128
armory=us,illidan,John
```

## Advanced Options

### Aura Delay

**default_aura_delay** (scope: global; default: 0.15) is the delay in seconds for aura applications:

```
default_aura_delay=0.25
```

### Timing Wheel

**wheel_granularity** (scope: global; default: 32) sets slices per second.

**wheel_seconds** (scope: global; default: 1024) sets total timing wheel length in seconds:

```
wheel_granularity=64
wheel_seconds=1024
```

### Resources Regeneration Frequency

**regen_periodicity** (scope: global; default: 0.25) sets the timespan in seconds between regen ticks:

```
regen_periodicity=1.0
```

### Error Confidence

**confidence** (scope: global; default: 0.95) sets the confidence level for the error interval:

```
confidence=0.97
```

### Allow Experimental Specialization

**allow_experimental_specializations** (scope: global; default: 0) allows unsupported experimental class specializations:

```
allow_experimental_specializations=1
```
