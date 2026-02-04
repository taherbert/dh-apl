Co-optimize talent build and APL together. The build determines what the rotation CAN do; the APL determines what it DOES. Optimizing either in isolation leaves value on the table — the best APL for build A may be mediocre for build B, and the best build assumes an APL that actually exploits its synergies.

This is the master loop. It uses the analytical frameworks from `/talent-analysis`, `/theorycraft`, and `/full-analysis` as phases within a single co-optimization cycle, not as independent tools.

## Setup

### Context Budget Tiers

Load data incrementally to preserve context window. Don't front-load everything — pull in detail as needed.

**Tier 1 — Always load (startup):**

```
prompts/apl-analysis-guide.md
data/spells-summary.json
data/cpp-proc-mechanics.json
results/findings.json
results/builds.json
```

**Tier 2 — Load when analyzing talents:**

```
data/talents.json
data/interactions-summary.json
data/build-theory.json (clusters, hero trees, archetype theory)
```

**Tier 3 — Load when deep-diving mechanics:**

```
prompts/apl-iteration-guide.md
plans/apl-from-scratch-v2.md (sections 1.1–1.5)
```

**Tier 4 — Only when needed for specific spell effects:**

```
Grep data/spells.json for specific spell IDs
Grep data/interactions.json for specific talent effects
```

### Startup

1. Load Tier 1 data
2. Read the current build + APL:
   - `apls/profile.simc` — extract the `talents=` string
   - Use `$ARGUMENTS` for APL file if provided, else `apls/vengeance.simc`, else `apls/baseline.simc`
3. Read `results/builds.json` — check factor impacts and archetype rankings for optimization opportunities
4. Read `results/findings.json` — filter to `status: "validated"` for calibration
5. Establish baseline:
   - `node src/sim/runner.js <apl-file>` — record ST, 3T, 10T DPS
   - `node src/sim/iterate.js init <apl-file>` — initialize iteration state

## The Co-Optimization Loop

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌──────────┐     ┌──────────┐     ┌──────────────┐    │
│  │  TALENT   │────▶│ RESOURCE │────▶│     APL      │    │
│  │ ANALYSIS  │     │  MODEL   │     │ OPTIMIZATION │    │
│  └──────────┘     └──────────┘     └──────┬───────┘    │
│       ▲                                    │            │
│       │            ┌──────────┐            │            │
│       └────────────│ EVALUATE │◀───────────┘            │
│                    │  & PIVOT │                         │
│                    └──────────┘                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Each pass through the loop produces a (build, APL) pair that is strictly tested against the current best. The loop terminates when no build change or APL change improves the combined result.

### Pass 1: Understand the Current State

Before changing anything, understand what you have. Do this work ONCE at the start — don't repeat it every loop iteration. Load Tier 2 data for this pass.

**1a. Talent Landscape** (`/talent-analysis` framework)

Map the interaction graph for the current build:

- Modifier stacking depth per core ability
- Identify the 3-5 weakest talents (lowest contribution per point)
- Identify the 3-5 strongest unchosen talents (highest potential contribution)
- Flag build-APL coupling points — which talents would require APL restructuring if changed?
- Detect cross-tree synergy chains and feedback loops
- Detect anti-synergies (talents working against each other)

**1b. Rotation Economy** (`/theorycraft` framework)

Model the resource economy under the current build:

- Fury generation/spending equilibrium
- Fragment generation rate and consumption pattern
- GCD budget allocation — mandatory vs discretionary
- Cooldown cycle map with alignment/collision analysis
- Burst window utilization (how well does the APL fill damage windows?)

**1c. APL Audit** (`/full-analysis` framework)

Quick audit of the APL for systemic issues:

- Logic errors (stale hardcoded values, missing talent gates, dead lines)
- Resource competition arbitration (is the SC vs SBomb decision optimal?)
- Burst window resource pooling (does the APL pre-stock for windows?)
- State machine coherence (does the APL respect hero tree rhythms?)

**1d. Hero Tree Coverage**

Determine which hero trees the current build exercises:

- **Aldrachi Reaver:** If the build has AR talents, the `actions.ar` branch is active. This is the current primary path.
- **Annihilator:** If the build has Anni talents, the `actions.anni` branch is active. Anni has a fundamentally different rotation rhythm (Voidfall cycle, Catastrophe windows) that requires its own analysis.

If optimizing for BOTH hero trees, each needs its own (build, APL) pair. Don't try to optimize both simultaneously — optimize one, checkpoint, then the other.

**1e. Fight-Style Awareness**

The default Patchwerk sim models pure stand-and-deliver fights. Real encounters involve:

- Movement phases (DPS loss from dropped GCDs)
- Add spawns (AoE breakpoint shifts)
- Intermissions (cooldown alignment disruption)

After establishing Patchwerk baselines, note which hypotheses might behave differently with movement or adds. Flag these for DungeonRoute or custom fight profile testing later.

### Pass 2: Generate Hypotheses Across Both Dimensions

This is where the co-optimization happens. Generate hypotheses that span BOTH build and APL:

**Build-only hypotheses** (APL stays the same):

- Talent swaps where the current APL already exploits the replacement talent's value
- Stat passive swaps that don't change rotation behavior
- Amplifier upgrades on abilities the APL already prioritizes heavily

**APL-only hypotheses** (build stays the same):

- Systemic tensions identified in 1b/1c
- Resource economy improvements
- Cooldown alignment changes
- Use the engines: `node src/sim/iterate.js strategic` and `node src/sim/iterate.js theorycraft`

**Coupled hypotheses** (build AND APL change together):
These are the high-value, non-obvious ones. Examples:

- "Take talent X, which changes fragment generation rate, AND restructure fragment pooling logic to exploit it" — neither change alone shows the full value
- "Drop talent Y (weak amplifier) for talent Z (rhythm changer), AND add a new APL variable that tracks the altered state" — the talent swap is neutral without the APL adaptation
- "Swap to Down in Flames (extra Brand charge), AND restructure cooldown sequencing to use double Brand windows" — testing the talent without the APL change underestimates it by 50%+

**Rank all hypotheses together**, not in separate categories. A coupled hypothesis that's expected to gain 3% should rank above a pure APL hypothesis that gains 1%, even though the coupled one is harder to test.

Present the ranked list and wait for user confirmation before testing.

### Pass 3: Test

For each hypothesis, the testing approach depends on its type:

**Build-only:**

```bash
# Use profileset with talent override
# Modify profile.simc with new talents= string, keep same APL
node src/sim/iterate.js compare apls/candidate.simc --quick
```

**APL-only:**

```bash
# Standard iterate.js comparison
node src/sim/iterate.js compare apls/candidate.simc --quick
```

**Coupled (build + APL):**

1. Generate modified `apls/profile-candidate.simc` with new `talents=` string
2. Write `apls/candidate.simc` with `input=profile-candidate.simc` AND the adapted APL
3. Compare against current baseline: `node src/sim/iterate.js compare apls/candidate.simc --quick`
4. ALSO compare against: same new build with OLD APL (to measure how much the APL adaptation matters)
5. The delta between tests 3 and 4 is the coupling value — the DPS that only exists because build and APL were co-optimized

Follow the `/iterate-apl` methodology for accept/reject:

- Quick screen first, escalate if promising
- One conceptual change per iteration (a coupled build+APL change counts as ONE if the components are interdependent)
- Git commit after each accept

**After each test, update findings and re-rank builds:**

1. Add findings to `results/findings.json` — each tested hypothesis produces at least one finding (validated, rejected, or inconclusive)
2. If an APL change was accepted, re-run `npm run discover -- --quick` to re-rank builds under the new APL
3. Check `results/builds.json` for ranking shifts — builds that previously ranked lower may benefit disproportionately from the APL change

### Pass 4: Evaluate & Pivot

After testing the top hypotheses from Pass 2:

**If a build change was accepted:**
The rotation economy has shifted. Return to Pass 1b to re-model:

- Did the fragment generation rate change? → Reconsider fragment thresholds
- Did a new ability become available or change value? → Reconsider priority ordering
- Did burst window characteristics change? → Reconsider pooling logic
- Did the GCD budget shift? → Reconsider which abilities are worth a GCD

Then generate NEW hypotheses that only exist because of the build change. These are second-order optimizations that couldn't be found in the original build.

**If only APL changes were accepted:**
The build analysis from Pass 1a is still valid. Check:

- Did APL optimization reveal that a talent's value is higher/lower than estimated?
- Did a talent that seemed weak turn out to be load-bearing (its removal causes regression)?
- Did a talent that seemed strong turn out to be redundant (the APL works around it)?

If the APL optimization changed your understanding of talent values, return to Pass 1a with updated knowledge and regenerate build hypotheses.

**If nothing was accepted:**

- Are there coupled hypotheses that weren't tried? (Often the highest-value but hardest to construct)
- Are there radical build departures worth exploring? (Different hero tree, different archetype entirely)
- Is the current (build, APL) pair a local optimum? Document what was tried and what plateau was reached.

### Loop Termination

Stop when ALL of these are true:

- No untested build hypothesis has expected gain > 0.5%
- No untested APL hypothesis has expected gain > 0.3%
- No untested coupled hypothesis remains
- At least one full pass through the loop produced no accepted changes

OR when:

- 10 consecutive rejections across all hypothesis types
- Context approaching limits (~180k tokens) — checkpoint and suggest re-running

## Anti-Patterns

- **Testing talent swaps with an unadapted APL.** If a talent changes what the APL should do, testing it without APL changes systematically underestimates coupled talents and overestimates APL-neutral ones. This biases toward stat passives and away from interesting build choices.
- **Optimizing the APL to perfection for one build, THEN exploring builds.** The APL you just perfected encodes assumptions about the current build. A talent swap may invalidate those assumptions, making the "perfect" APL actively harmful.
- **Treating build and APL as independent variables.** They aren't. The space you're searching is (build × APL), not build + APL. Optimizing each dimension independently finds a saddle point, not a maximum.
- **Exploring too many builds without depth.** Testing 10 builds at quick-screen fidelity tells you less than testing 3 builds with adapted APLs at full fidelity. Prefer depth over breadth.
- **Ignoring the APL coupling cost.** A build that's 2% better in theory but requires a complete APL rewrite has higher risk than a build that's 1% better and APL-neutral. Factor in the confidence of the APL adaptation.

## Output

### Current State Assessment

- Build: talent string, archetype classification, modifier stack summary
- APL: structure overview, resource economy model, key tensions
- Baseline DPS: ST / 3T / 10T

### Hypothesis Ranking (unified across all types)

| #   | Type | Hypothesis | Expected Gain | Coupling Value | Confidence |
| --- | ---- | ---------- | ------------- | -------------- | ---------- |

### Test Results

For each tested hypothesis:

- What changed (build, APL, or both)
- DPS delta per scenario
- Whether the coupling value prediction was correct
- What was learned (mechanism confirmed/refuted)

### Final State

- Best (build, APL) pair found
- Total improvement over starting baseline
- Remaining untested hypotheses for future sessions
- Key findings about build-APL coupling in this spec
