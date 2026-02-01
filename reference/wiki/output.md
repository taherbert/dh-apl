# Output

Source: https://github.com/simulationcraft/simc/wiki/Output

## Combat Logs

The **log** option (global scope, default: 0) generates human-readable console output. Enabling it forces iterations to 1.

```
log=1
output=log.txt
```

The **output** option (global scope, default: "") redirects standard output to a file.

```
output=c:\log.txt
```

The **log_spell_id** option (global scope, default: 0) includes spell data IDs when logging actions or buffs.

## Reports

**html** option writes HTML reports:

```
html=report.html
```

**xml** option writes custom-format XML reports (unmaintained, may be removed):

```
xml=report.xml
```

**json2** option (preferred over deprecated json) writes JSON reports:

```
json2=report.json
```

**report_details** (default: 1) controls ability expansion in HTML reports. Set to 0 for smaller files.

**report_precision** (default: 3) sets decimal places for scale factors:

```
calculate_scale_factors=1
report_precision=2
```

**report_rng** (default: 0) includes maximum DPS deviation as percentage in HTML summaries.

**report_pets_separately** (default: 0) reports pets as individual players with separate charts.

**full_damage_sources_chart** displays all damage sources instead of combined top-level entries.

**buff_uptime_timeline** (default: 1) records non-constant buff uptime timelines for JSON output and HTML visualization.

**buff_stack_uptime_timeline** (default: 1, requires buff_uptime_timeline=1) multiplies uptime values by stack levels.

**hosted_html** (default: 0) removes JS/CSS from reports, hosting them on simulationcraft.org:

```
html=mytoon.html
hosted_html=1
```

## Others

**reference_player** (global scope, default: "") compares all players' DPS against specified player as baseline percentage.

## Massive Profiles Exportation

**save_profiles** (default: 0) exports all player profiles to `<prefix><playername>.simc` format.

**save_prefix** (default: "") adds prefix to all saved profiles:

```
armory=us,illidan,john
save_profiles=1
save_prefix=test_
```

## Per-Character Profile Exportation

**save** exports complete character profile:

```
save=john_profile.simc
```

**save_gear** exports only gear configuration.

**save_talents** exports only talent choices.

**save_actions** exports only action lists:

```
save_gear=john_gear.simc
save_talents=john_talents.simc
save_actions=john_actions.simc
```

## Debugging

**dps_plot_debug** (default: 0) outputs full reports for each stats plotting run.

**debug** (default: 0) outputs developer debugging information, enables logging, forces iterations to 1.

**debug_scale_factors** (default: 0) prints reports after each scale factor simulation.

**reforge_plot_debug** (default: 0) outputs additional computation data for reforge plot points.

## Exit Codes

Successful simulations return `0`. Abnormal termination returns:

- `1`: General unknown termination
- `30`: Invalid APL argument
- `40`: Initialization error
- `50`: Iteration error
- `51`: Simulation stuck (infinite loop suspected)
- `60`: Network/file error
- `61`: Report output error
- `70`: Invalid sim-scope argument
- `71`: Invalid fight style
- `80`: Invalid player-scope argument
- `81`: Invalid talent string
- `82`: Invalid item string
