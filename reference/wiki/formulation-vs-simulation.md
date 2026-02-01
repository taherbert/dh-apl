# Formulation vs Simulation

Source: https://github.com/simulationcraft/simc/wiki/FormulationVsSimulation

## What does it mean?

Simulationcraft represents a simulation-based approach to damage calculation, contrasting with formula-based tools like spreadsheets and Rawr. The distinction can be illustrated through the birthday paradox: formulation uses mathematics to derive exact answers, while simulation uses brute-force computation, running scenarios repeatedly to approximate results.

## Complexity matters

Formula-based tools face significant challenges as problem complexity increases. They typically rely on:

- **Approximations**: Converting variable procs into permanent bonuses, losing synergy details
- **Ignored interactions**: Excluding mechanics too difficult to model mathematically
- **User restrictions**: Limiting customization options to avoid complete rewrites

Simulations handle complexity more naturally. Once core infrastructure exists, additional features require many simple problems that can be individually addressed rather than wholesale rewrites.

## Formulation vs. Simulation Comparison

### Formulation Strengths

- Deterministic results -- identical outputs every time
- Enables precise comparison of small gear/talent changes
- Often developed by specialists in their field

### Formulation Weaknesses

- Difficult to verify source code and validate simplifications
- Higher risk of human error
- Slow development and update cycles

### Simulation Strengths

- Models actual behavior rather than abstractions
- Easier to verify and update quickly
- Offers greater user freedoms and features

### Simulation Weaknesses

- Results vary due to random number generation
- Requires many iterations to determine expected behavior
- Measuring small changes demands significant computational resources

## Accuracy vs. Precision

The analogy: a precise but inaccurate tool puts the bullet in the same spot (12 inches off center) every time. An accurate but imprecise tool puts the bullet within 3 inches of the center, but never hits the same place twice.

## What Really Matters

Sufficient accuracy and precision matter less than trust and usability. Key points:

- Trust derives primarily from author credibility and verifiability
- Simulations (when well-written) may be easier to verify through comparison with combat logs
- Usability depends on turnaround time and whether tools answer users' actual questions
- Both approaches have legitimate roles; neither is universally superior
