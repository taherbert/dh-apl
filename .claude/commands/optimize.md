The ONE command for all APL and build optimization. Runs everything autonomously: deep reasoning, parallel specialist analysis, synthesis, iteration, and reporting.

If `$ARGUMENTS` is provided (e.g., `/optimize Check soul fragment economy`), treat it as a **focus directive** — prioritize that area while still analyzing the full system. If no arguments, analyze the full rotation holistically.

## Architecture

```
/optimize (you are here)
    |
    +-- Phase 0: Setup + Deep Reasoning (orchestrator)
    |     Read ALL data, model the economy, form root theories
    |
    +-- Phase 1: Parallel Specialists (Task subagents)
    |     4 subagents launched simultaneously:
    |     - Spell Data Specialist
    |     - Talent Specialist
    |     - Resource Flow Specialist
    |     - State Machine Specialist
    |
    +-- Phase 2: Synthesis
    |     Cross-reference specialist findings with root theories
    |     Present hypotheses to user for confirmation
    |
    +-- Phase 3: Deep Iteration Loop
    |     Test hypotheses: mutate -> sim -> accept/reject -> repeat
    |
    +-- Phase 4: Cross-Build Analysis + Final Report
          Re-rank builds, record findings, commit
```

## Internal Methodology References

These files contain detailed methodology for each phase. Read them once at session start — not every iteration:

- `prompts/apl-analysis-guide.md` — Canonical knowledge base (Section 0) + calculation frameworks
- `prompts/full-analysis-methodology.md` — Deep analysis: economy modeling, systemic tensions, hypothesis generation
- `prompts/iterate-apl-methodology.md` — Iteration loop: modify, test, decide, record
- `prompts/theorycraft-methodology.md` — Temporal resource flow analysis
- `prompts/talent-analysis-methodology.md` — Talent interaction graphs, synergy clusters
- `prompts/analyze-apl-methodology.md` — APL comprehension walkthrough
- `prompts/apl-iteration-guide.md` — Iteration tactics and escape strategies

## Phase 0: Setup + Deep Reasoning

### 0a. Determine Active Spec

Run `node src/engine/startup.js` to determine the active spec. All paths below use `{spec}`.

### 0b. Check for Checkpoint / Existing State

```bash
node src/sim/iterate.js status
```

If iteration state exists, check `results/{spec}/checkpoint.md` and `results/{spec}/dashboard.md` to determine whether to resume or start fresh. If resuming, follow the warm restart protocol in `prompts/iterate-apl-methodology.md`.

### 0c. Load the Full Knowledge Base

**Read `prompts/apl-analysis-guide.md` Section 0** — the single canonical list of all data sources. Load all 4 tiers:

- **Tier 1 (Mechanical Blueprint):** Spec adapter (`src/spec/{spec}.js`), APL (`apls/{spec}/{spec}.simc` or `current.simc`), spell data (`data/{spec}/spells-summary.json`)
- **Tier 2 (Interactions):** `data/{spec}/interactions-summary.json`, `data/{spec}/cpp-proc-mechanics.json`, `data/{spec}/build-theory.json`
- **Tier 3 (Accumulated Knowledge):** `results/{spec}/findings.json` (filter `status: "validated"`), `results/{spec}/hypotheses.json`, `results/{spec}/builds.json`
- **Tier 4 (External):** Wowhead/Icy Veins when internal data has gaps (treat as hypotheses, not truth)

Also read methodology references: `prompts/full-analysis-methodology.md` and `prompts/apl-iteration-guide.md`.

### 0d. Study Reference APL Technique

Read `reference/{spec}-apl.simc` for SimC syntax patterns and structural techniques — NOT priorities. See `prompts/full-analysis-methodology.md` Phase 0 for what to look for.

### 0e. Deep Reasoning (REQUIRED before specialists)

**This is the most important step.** Before launching any specialists or automation, form your own understanding using ALL available data:

1. **Model the economy** — resource generation/spending equilibrium, GCD budget, marginal values per spender (see `prompts/full-analysis-methodology.md` Phase 1)
2. **Identify systemic tensions** — resource competition, cooldown misalignment, burst window waste, state machine incoherence (see Phase 2)
3. **Form 2-3 root theories** — "The biggest opportunity is X because Y, supported by Z from the data." A theory without numbers from spell data is speculation.

These root theories GUIDE everything that follows — specialist focus, hypothesis evaluation, iteration priority. The specialists below are research assistants, not decision makers.

### 0f. Establish Baseline

```bash
node src/sim/iterate.js init apls/{spec}/{spec}.simc
```

## Phase 1: Parallel Specialist Launch

Launch 4 specialist analyses IN PARALLEL using the Task tool. Each reads relevant data and writes structured output.

**IMPORTANT:** Launch all 4 specialists in a SINGLE message with 4 Task tool calls. Do NOT wait for one to complete before launching the next. Use `subagent_type: "general-purpose"` for each.

Include your root theories in each specialist's prompt so they can focus their analysis accordingly.

### Specialist 1: Spell Data

Reads: `data/{spec}/spells-summary.json`, `data/{spec}/cpp-proc-mechanics.json`, `data/{spec}/interactions-summary.json`
Produces: DPGCD rankings, modifier stacking depth, school clusters, proc mechanic analysis
Writes to: `results/{spec}/analysis_spell_data.json`

### Specialist 2: Talent Interactions

Reads: `data/{spec}/talents.json`, `data/{spec}/interactions-summary.json`, `data/{spec}/build-theory.json`, `results/{spec}/builds.json`
Produces: Synergy clusters, anti-synergies, build-APL coupling points, weakest/strongest talent analysis
Writes to: `results/{spec}/analysis_talent.json`
Methodology: `prompts/talent-analysis-methodology.md`

### Specialist 3: Resource Flow

Reads: `data/{spec}/spells-summary.json`, `data/{spec}/cpp-proc-mechanics.json`, APL, `data/{spec}/build-theory.json`
Produces: Resource equilibrium, secondary resource model, GCD budget, cooldown cycle map, burst window utilization
Writes to: `results/{spec}/analysis_resource_flow.json`
Methodology: `prompts/theorycraft-methodology.md`

### Specialist 4: State Machine / APL Coherence

Reads: APL, `data/{spec}/build-theory.json`, `data/{spec}/spells-summary.json`
Produces: Hero tree state machine analysis, variable coherence audit, action list delegation review, dead code detection
Writes to: `results/{spec}/analysis_state_machine.json`
Methodology: `prompts/analyze-apl-methodology.md`

## Phase 2: Synthesis

After all 4 specialists complete:

### 2a. Read Specialist Outputs

Read all four `results/{spec}/analysis_*.json` files.

### 2b. Run Programmatic Synthesis

```bash
node src/sim/iterate.js synthesize
```

Cross-references specialist outputs, detects consensus, ranks hypotheses.

### 2c. Evaluate Through Root Theories

Filter specialist findings through your root theories from Phase 0:

- Specialist findings that align with your theories → high priority
- Specialist findings with no causal backing from your theories → lower priority, investigate why
- Your theories that specialists missed → these are the deep insights, highest priority

### 2d. Generate Analysis Summary

Write `results/{spec}/analysis_summary.md` with:

- Economic models built
- Systemic tensions identified
- Root theories and specialist evidence
- Ranked hypothesis list
- Key conflicts and resolution strategy

Initialize `results/{spec}/dashboard.md` and `results/{spec}/changelog.md` for tracking.

### 2e. Present and Confirm

**Present the ranked hypothesis list to the user. Wait for confirmation before proceeding to testing.**

Include: ranked hypotheses, which archetypes each targets, expected impact, and conflicts.

## Phase 3: Deep Iteration Loop

Execute the iteration loop per `prompts/iterate-apl-methodology.md`:

```
FOR EACH approved hypothesis:
  1. Generate candidate APL (one change per iteration)
  2. Quick screen: node src/sim/iterate.js compare candidate.simc --quick
  3. If promising: standard test, then --confirm if marginal
  4. Accept or reject with --hypothesis flag
  5. Record to findings.json, update dashboard.md and changelog.md
  6. Commit each accept
  7. Check for second-order effects from accepted changes
```

### Parallelism in Iteration

When multiple independent hypotheses exist:

1. Launch 2-3 Task subagents, each testing a different candidate with `--quick`
2. Promote the best candidate to standard/confirm fidelity
3. Use this for independent threshold sweeps or condition variants

### Coupled Hypotheses (Build + APL)

1. Generate modified profile with new talents string
2. Write candidate APL with adapted action lines
3. Compare against current baseline
4. ALSO compare new build with OLD APL (to measure coupling value)

### Stop Conditions

- 3 consecutive rejections with no new hypotheses → try escape strategies (compound mutations, reversals, radical reorder) per `prompts/apl-iteration-guide.md`
- 10 consecutive rejections → stop
- All hypothesis categories exhausted AND escape strategies tried → stop
- Context approaching limits → save checkpoint, suggest re-running `/optimize`

## Phase 4: Cross-Build Analysis + Final Report

### 4a. Re-rank Builds

```bash
npm run discover -- --quick
```

### 4b. Record Findings

Append all insights to `results/{spec}/findings.json` with evidence, confidence, and tags per `results/{spec}/SCHEMA.md`.

### 4c. Generate Final Reports

```bash
node src/sim/iterate.js summary
```

Update `results/{spec}/dashboard.md` with final state.

### 4d. Print Session Summary

- Spec analyzed, archetypes covered
- Hypotheses tested / accepted / rejected
- Total DPS improvement (weighted across scenarios)
- Key findings: universal improvements, archetype-specific discoveries, mechanism insights
- Remaining untested ideas for next session

### 4e. Commit

```bash
git add apls/{spec}/current.simc results/{spec}/
git commit -m "optimize: {spec} — N iterations, M accepted, +X.XX% weighted DPS"
```

## Checkpoint Protocol

On context limits or interruption, save to `results/{spec}/checkpoint.md`:

- Current phase, archetype, build, hypothesis
- Key observations so far
- Remaining work
- Resume: "Run `/optimize` — startup will detect this checkpoint"

## Anti-Patterns

- **Specialists without theory** — launching specialists before forming root theories. Specialists gather evidence; you reason about it.
- **Sequential specialist execution** — ALWAYS launch all 4 in parallel.
- **Shallow iteration** — test one thing, accept/reject, repeat without depth. Every iteration must connect back to a causal theory.
- **Trusting screener output without reasoning** — "buff uptime is low" is an observation, not an insight. The insight is understanding WHY.
- **Grinding thresholds without theory** — "resource>=38 vs 40 vs 42" without mechanism.
- **Testing talent swaps with unadapted APL** — coupled hypotheses need both build AND APL changes.
- **Hardcoding spec-specific knowledge** — read from the spec adapter, not from memory.
