# Profile Sets

Source: https://github.com/simulationcraft/simc/wiki/ProfileSets

## Overview

Profile sets are a mechanism of batch-simulating actors introduced in Simulationcraft 725-01. They provide a third simulation mode distinct from conventional multi-actor or `single_actor_batch=1` approaches.

### Key Benefits

The primary advantage is memory efficiency. Profile sets maintain only two simultaneous actors in memory -- the baseline and individual profile set environments -- eliminating memory constraints faced by traditional simulation modes.

### Output Limitations

Profile sets only output summary information about the baseline set of profiles. Results include minimum, first quartile, median, mean, third quartile, maximum values, standard deviation, and iteration counts in JSON reports. Textual reports show only median values, while HTML reports exclude standard deviation and iteration information.

## Usage Format

```
<baseline profile definition>

profileset.<profileset name>=<option-1>
profileset.<profileset name>+=<option-2>
...
profileset.<profileset name>+=<option-N>
```

Key requirements:

- Single baseline profile only
- Unique profile set names
- Whitespace in names requires double quotes
- Period characters prohibited in names
- Metric selection via `profileset_metric` option (default: `dps`)

## Parallel Processing

Supported in Simulationcraft 735-01 or newer. The `profileset_work_threads` option controls threads per worker, with maximum workers calculated as `floor(threads / profileset_work_threads)`.

## Multi-Actor Baseline Configuration

Simulationcraft 1015-01 introduced options for multi-actor baselines:

- **profileset_main_actor_index**: Specifies which actor receives modifications (default: 0)
- **profileset_report_player_index**: Designates actor for player metric reporting
- **profileset_multiactor_base_name**: Names baseline display in reports (default: "Baseline")

## Unsupported Options

Profile sets cannot use `armory` (recommend saving profiles to files instead), spell queries, scale factor calculations, plotting, or additional player additions via `copy` or `class_name` options.
