# Statistical Behaviour

Source: https://github.com/simulationcraft/simc/wiki/StatisticalBehaviour

## Introduction

Simulations inherently produce varied results across runs due to their stochastic nature. Multiple iterations help stabilize outcomes by averaging randomness. Configuration options allow fine-tuning of statistical properties.

## Default Behavior

Without user specification, SimC employs 0.2% target error with a maximum of 1,000,000 iterations. The GUI uses identical defaults. When `iterations` is set without `target_error`, that exact iteration count executes.

## Target Error

**target_error** (global scope, default: 0.2) potentially halts simulation before completion. The system tracks role-based metrics (dps, heal, tank) each iteration, examining distribution to calculate statistical error. Error decreases with more iterations. Upon reaching target levels, simulation stops and generates reports. Maximum iterations default to 1,000,000 unless explicitly configured otherwise.

```
target_error=0.2
```

## Iterations

**iterations** (global scope; default: 1,000,000) specifies simulated fights per run. Increased values improve accuracy and stability but extend computation time.

```
iterations=10000
```

## Constant Seed

**seed** (global scope; default: 0) controls the pseudo-random sequence. Setting to 0 uses time-based seeds for variation. Non-zero values generate consistent sequences across runs, incremented by 1 per thread.

```
seed=1247695
```

Note: Constant seeds ensure identical inputs yield identical outputs but don't meaningfully compare slightly different configurations, since equipment changes alter action ordering.

### Deterministic

**deterministic** (global scope, default: 0) seeds RNG packages with hard-coded values (31459, incremented per thread). Equivalent to seed=31459.

```
deterministic=1
```

## Averaging Rolls

**average_range** (global scope, default: 1) forces damage range rolls to return average values. Doesn't affect attack table or proc rolls.

```
average_range=0
```

**average_gauss** (global scope; default: 0) forces normal distribution rolls to return average values. Renders settings like gcd_stddev ineffective.

```
average_gauss=1
```
