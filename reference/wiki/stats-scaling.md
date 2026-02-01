# Stats Scaling and Plotting

Source: https://github.com/simulationcraft/simc/wiki/StatsScaling

## Scale Factors

Scale factors measure DPS gain per point of a stat. SimC adds a delta of stat points and compares to baseline.

### Basic Options

- **calculate_scale_factors** (default: 0): Enable scale factor computation
- **scale\_[stat]** (default: 0): Custom delta for a stat (0 = use default)
- **positive_scale_delta** (default: 0): Force positive deltas
- **scale_over** (default: ""): Metric to evaluate against (dps, tmi, deaths, avg_death_time, min_death_time, dmg_taken)

### Default Delta

Determined by rating needed for 3.5% haste increase. Doubles when using `smooth_scale_factors`.

### Advanced

- **scale_delta_multiplier** (default: 1.0): Multiply all default deltas
- **scale_only** (default: ""): Only compute for listed stats
- **normalize_scale_factors** (default: 0): Normalize to primary stat = 1.0
- **scale_factor_noise** (default: -1.0): Detect computation problems (< 0: warn when scale factor <= error)
- **smooth_scale_factors** (default: 0): Force deterministic/separated RNG, halve deltas
- **scale_lag** (default: 0): Compute latency scale factor per ms
- **center_scale_delta** (default: 0): Centered approximation (doubles compute time)

## Stat Plotting

Plot DPS across a range of stat values.

- **dps_plot_stat** (default: ""): Stats to plot (e.g., "haste,crit_rating,mastery")
- **dps_plot_points** (default: 20): Number of graph points
- **dps_plot_step** (default: variable): Delta between points
- **dps_plot_positive** (default: 0): Plot from 0 instead of centered
- **dps_plot_iterations** (default: 10000): Iterations per point
- **dps_plot_target_error** (default: variable): Target error per point
- **dps_plot_display_delta** (default: 0): Show DPS difference vs previous step

## Reforge Plots

Generate CSV for analyzing multi-stat relationships.

- **reforge_plot_stat** (default: ""): Comma-separated stats (min 2). Multiple plots separated by "/"
- **reforge_plot_amount** (default: 200): Max reforge per stat
- **reforge_plot_step** (default: 20): Stat delta between points. Complexity: O((N/2)^K) for K stats
- **reforge_plot_iterations** (default: -1): Iterations per point (<= 0 uses baseline)
- **reforge_plot_output_file** (default: ""): CSV output file
