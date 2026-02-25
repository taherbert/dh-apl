---
description: The ONE command for all APL and build optimization. Runs everything autonomously — generates cluster roster, deep reasoning, parallel specialist analysis, synthesis, multi-build iteration, and reporting.
argument-hint: "[focus directive or 'test: hypothesis']"
model: opus
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch
---

The ONE command for all APL and build optimization. Runs everything autonomously: generate cluster roster, deep reasoning, parallel specialist analysis, synthesis, multi-build iteration, APL branching, and reporting.

If `$ARGUMENTS` is provided (e.g., `/optimize Check soul fragment economy`), treat it as a **focus directive** -- prioritize that area while still analyzing the full system.

**Invocation modes:**

- `/optimize` -- Full pipeline (Phases 0-4)
- `/optimize Check soul fragment economy` -- Focused analysis (same phases, prioritize area)
- `/optimize test: Lower SBomb threshold to 4 during Meta` -- Direct hypothesis (skip Phases 1-2, go to Phase 3)
- `/optimize test: Hyp A; Hyp B; Hyp C` -- Batch hypothesis testing

## Architecture

```
/optimize (you are here)
    |
    +-- Phase 0: Setup + Build Discovery + Session Recovery
    +-- Phase 1: Deep Reasoning + Parallel Specialists
    +-- Phase 2: Synthesis + Hypothesis Ranking
    +-- Phase 3: Multi-Build Iteration Loop + Theory Revision
    +-- Phase 4: Showcase Report + Commit
```

## State Management

All state flows through `results/{spec}/theorycraft.db`. No JSON snapshots — the DB is the single source of truth.

```javascript
import {
  getDb,
  setSessionState,
  getSessionState,
  addTheory,
  addHypothesis,
  addIteration,
  addFinding,
  getIterations,
  getRosterBuilds,
} from "../util/db.js";
import { createTheory, getTheorySummary } from "../analyze/theory.js";
import { reviseFromIteration } from "../analyze/theory-revision.js";
```

**Recovery after context compaction:**

1. `getSessionState('phase')` -- current phase
2. `getSessionState('session_id')` -- session UUID
3. `getIterations({ sessionId })` -- full iteration history
4. `getHypotheses({ status: 'pending' })` -- remaining work
5. Read `results/{spec}/plan.md` -- human-readable progress

Update `results/{spec}/plan.md` after every phase transition and iteration.

---

## Phase 0: Setup + Build Discovery

### 0a. Determine Active Spec + Data Freshness Gate

Run `node src/engine/startup-cli.js` to check config, spec, and simc sync status.

**Staleness gate — auto-refresh if needed:**

1. Check the startup output for the `Sync:` line. If it says anything other than `up to date`, local data is stale (simc binary was updated but data pipeline hasn't been rebuilt).

2. Check for **upstream** simc changes that haven't been pulled yet:

```bash
git -C /Users/tom/Documents/GitHub/simc fetch origin midnight --quiet
git -C /Users/tom/Documents/GitHub/simc rev-parse HEAD           # local
git -C /Users/tom/Documents/GitHub/simc rev-parse origin/midnight # remote
```

If local and remote HEADs differ, upstream has new commits.

3. **If either check shows staleness**, run the full refresh pipeline:

```bash
SPEC={spec} npm run refresh
```

This pulls simc, rebuilds the binary, extracts reference APL + wiki + spell data, runs the full data pipeline, verifies, and records metadata (~5-10 min). Non-interactive mode is automatic.

4. After refresh completes, re-run `node src/engine/startup-cli.js` to confirm `Sync: up to date`.

**If both checks pass**, data is fresh — continue to 0b.

### 0b. Session Recovery

Check DB for existing session:

```javascript
const phase = getSessionState("phase");
const sessionId = getSessionState("session_id");
```

If a session exists, query `getIterations({ sessionId })` to reconstruct history, then check `node src/sim/iterate.js status` for iteration state. Use `results/{spec}/plan.md` as supplementary context if it exists (human-written during Phase 3 progress updates). Resume from where we left off.

If no DB session, check legacy: `node src/sim/iterate.js status`. If iteration state exists, check `results/{spec}/checkpoint.md`.

### 0c. Generate Build Roster

```bash
npm run roster generate               # Cluster-based roster from SPEC_CONFIG templates
npm run roster show                   # Verify coverage
```

Templates are defined in SPEC_CONFIG (`rosterTemplates`). Each template specifies an apex rank and which talent clusters to include/exclude. Crossed with hero tree × variant = full roster. Hashes are generated automatically.

### 0d. Establish Multi-Build Baseline

Only if no active iteration session:

```bash
node src/sim/iterate.js init apls/{spec}/{spec}.simc
```

### 0f. Batch Divergence Analysis (Pre-Hypothesis Priming)

Run the batch pattern-analyze pipeline across all representative builds. This chains optimal-timeline → apl-interpreter → divergence → pattern-analysis → cross-archetype-synthesis → theory-generator, producing mechanically-grounded hypotheses as a structured starting point for Phase 1a. Per-build scoring is automatically enriched with talent modifiers.

```bash
node src/sim/iterate.js pattern-analyze
```

Output: `results/{spec}/divergence-report-{build}.md`, `divergences-{build}.json`, `cross-archetype-synthesis.json`, and theory-generator hypotheses in the DB.

**What it tells you:** Each divergence is a specific claim — "at state S (fury, frags, VF, buffs), 15s rollout prefers X over Y by Z rollout-score points." Divergences with high delta (>100) that recur across archetypes are strong theory candidates. The cross-archetype synthesis identifies universal vs build-specific patterns.

**Limitation:** The rollout uses an approximate scoring model (enriched with talent modifiers but still deterministic). Treat every divergence as a hypothesis requiring causal reasoning before testing — not a proven improvement. Skip this step if resuming a session (divergences were already generated).

---

### 0e. Load the Full Knowledge Base

**Tier 1 -- Mechanical Blueprint (always load):** spec adapter (`src/spec/{spec}.js` SPEC_CONFIG), current APL, `spells-summary.json`

**Tier 2 -- Interaction & Proc Data:** `interactions-summary.json`, `cpp-proc-mechanics.json`, SPEC_CONFIG talent clusters (`talentClusters`, `rosterTemplates`)

**Tier 3 -- Accumulated Knowledge:** DB findings (`getFindings({status:'validated'})`), DB hypotheses (`getHypotheses()`), DB builds/synergies

**Tier 4 -- External:** Wowhead/Icy Veins when internal data has gaps (treat as hypotheses).

All data paths in `data/{spec}/` and `results/{spec}/`. See CLAUDE.md "Data File Selection" for full path reference.

**In direct hypothesis mode (`test:`):** Load Tiers 1-3 only. Skip Phases 1-2.

---

## Phase 1: Deep Reasoning + Parallel Specialists

> **Skipped in direct hypothesis mode.** Jump to Phase 3.

### 1a. Deep Reasoning (REQUIRED before specialists)

**This is the most important step.**

#### Study the Build Roster

What talent clusters define each template? Which cluster combinations create compound value? How do different builds (apex ranks, cluster presence/absence) differ in rotation needs? Read SPEC_CONFIG `talentClusters` and `rosterTemplates` for the full roster structure.

#### Model the Economy

**Primary resource** -- Compute equilibrium: resource in/out per minute, marginal damage value per unit on each spender, burst window shifts.

**Secondary resource** -- Steady-state generation rate by target count, waste sources, consumption value per unit.

**GCD budget** -- ~48 GCDs/min at 20% haste. Map mandatory, discretionary, and negative-value abilities.

#### Identify Systemic Tensions

- **Resource competition** -- two consumers, same pool. Is APL arbitration correct?
- **Cooldown misalignment** -- map periods, multiplicative overlaps, holding costs, LCM supercycle
- **Burst window utilization** -- GCDs in window, filled with highest-DPGCD? Pre-pooling?
- **State machine incoherence** -- hero tree cycles vs APL rhythm
- **Second-order chains** -- indirect value chains invisible in single-ability analysis

#### Map Build-Specific Tensions

Where do different builds need different APL behavior? Cluster presence/absence and apex rank create the primary variation axes.

#### Study Reference APL

Read `reference/{spec}-apl.simc` for SimC syntax patterns (NOT priorities): variable patterns, trinket handling, state machine encoding, delegation, AoE breakpoints, cooldown sync.

#### Form Root Theories

Read `results/{spec}/divergence-report-*.md` (from Phase 0f). Each divergence is a candidate theory seed — it tells you WHERE the APL may deviate from optimal. Apply deep mechanical reasoning to each: WHY does the divergence exist? Is the rollout's reasoning sound in context? Does the APL's choice have justification the model doesn't capture (e.g., fire amp setup, burst window sync)?

High-delta divergences (>100 rollout points) that appear across multiple archetypes are the most likely real improvements. Low-delta ones (<50) are likely model noise.

2-3 theories that GUIDE everything. **Persist to DB** via `createTheory()`.

Set session phase: `setSessionState('phase', '1_specialists')`

#### Non-Obvious Discovery Techniques

- **Inverse optimization** -- remove conditions one by one, measure delta. Builds "condition value map."
- **Sensitivity analysis** -- vary numeric thresholds, plot DPS response for optimal breakpoints.
- **Cross-scenario divergence** -- same APL at different target counts. Look for rank inversions, wasted casts.
- **Execute phase detection** -- test `target.time_to_die` thresholds for cooldown/resource dumping.

#### Target Count Regimes

- **ST** -- cooldown alignment primary, resource pooling for burst, deterministic secondary resource
- **Cleave (3-5T)** -- AoE spender DPGCD dominates, quadratic scaling loops, `active_enemies>=N` breakpoints
- **Heavy AoE (8-10T)** -- GCD budget is binding, secondary resource abundant, passive ticking dominates

### 1b. Parallel Specialist Launch

Launch 4 specialists **IN PARALLEL** using the Task tool. All 4 calls in a **SINGLE message** — never sequentially. Each specialist uses `subagent_type: "theorist"`, `model: "opus"` to inherit the full theorist methodology (resource flow, DPGCD, cooldown optimization, etc.). Run all in background with `run_in_background: true` for maximum parallelism.

Each specialist prompt MUST include:

- The root theories you formed in 1a (verbatim)
- Roster template structure (clusters, apex ranks)
- The spec name and data paths
- Which focus area to analyze and which output file to write

| Specialist          | Focus                                                | Key Data                                              | Output                        |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| Spell Data          | DPGCD rankings, modifier stacking, proc mechanics    | spells-summary, cpp-proc-mechanics, interactions      | `analysis_spell_data.json`    |
| Talent Interactions | Synergy clusters, anti-synergies, build-APL coupling | talents, interactions, SPEC_CONFIG clusters/templates | `analysis_talent.json`        |
| Resource Flow       | Resource equilibrium, GCD budget, cooldown cycles    | spells-summary, cpp-proc-mechanics, APL               | `analysis_resource_flow.json` |
| State Machine       | Hero tree rhythms, variable correctness, dead code   | APL, SPEC_CONFIG clusters, spells-summary             | `analysis_state_machine.json` |

While specialists run in background, continue reading the knowledge base or begin Phase 2 preparation. Check specialist output files when they complete.

---

## Phase 2: Synthesis

> **Skipped in direct hypothesis mode.** Jump to Phase 3.

### 2a. Synthesize

```bash
node src/sim/iterate.js synthesize
```

Read all four `results/{spec}/analysis_*.json` files. Cross-reference with root theories.

### 2b. Import Divergence Hypotheses

Import state-sim divergences as DB hypotheses:

```bash
node src/sim/iterate.js divergence-hypotheses
```

This populates the hypothesis DB with cross-archetype divergences (delta > 100, >= 2 archetypes).

### 2c. Generate Strategic Hypotheses

```bash
node src/sim/iterate.js strategic
```

Generates APL-level strategic hypotheses (ability ordering, condition gaps, dead conditions). Requires `loadState()` — init must have run.

### 2d. Generate Theorycraft Hypotheses

```bash
node src/sim/iterate.js theorycraft
```

Generates resource-flow and temporal hypotheses (resource waste, cooldown misalignment, burst window utilization). Requires workflow results from init.

### 2e. Unify All Hypothesis Sources

Merge all 6 hypothesis sources (strategic, theorycraft, synthesized, divergence-analysis, theory-generator, specialist agents) into a consensus-ranked, mutation-enriched list:

```bash
node src/sim/iterate.js unify
```

This performs:

1. **Fingerprinting** — semantic identity matching across heterogeneous formats
2. **Consensus detection** — count distinct sources per hypothesis (e.g., strategic + divergence both flag the same swap)
3. **Mutation inference** — generate `aplMutation` for sources that lack them (divergence, theory-generator, specialists)
4. **Priority boosting** — +25% per additional confirming source; rejection memory reduces priority for previously-rejected fingerprints
5. **DB persistence** — updates consensus_count, consensus_sources, fingerprint; marks duplicates as "merged"

After unification, ALL hypotheses can produce candidates via `iterate.js generate`, not just sources 1-3.

### 2f. Rank Hypotheses

Ranking order (post-unification):

1. **Your theories that specialists missed** -- highest priority (deep insights)
2. **Unified hypotheses with consensus_count > 1** -- convergent evidence from multiple independent sources
3. **Divergences with rollout_delta > 100 that recur across archetypes** -- strong mechanical signal
4. **Specialist findings aligned with theories** -- high priority
5. **Single-source hypotheses with mutation** -- moderate priority
6. **Specialist findings with no causal backing** -- lower priority

**Scope ranking:** Universal > Template-specific > Hero-tree-specific > Build-specific

### 2g. Generate Summary

Write `results/{spec}/analysis_summary.md`. Initialize `dashboard.md` and `changelog.md`.

**Proceed directly to testing.**

---

## Phase 3: Multi-Build Iteration Loop

**Every test runs against ALL roster builds simultaneously.**

### Remote Sim Check

Before starting heavy iteration, check if remote sim offloading is available:

```bash
SPEC={spec} npm run remote:status
```

If no instance is active, suggest starting one — multi-build iteration at standard/confirm fidelity benefits significantly from remote (96 vCPUs vs local cores):

```bash
npm run remote:start
```

Quick-fidelity screening sims automatically stay local (SCP overhead exceeds sim time). Standard and confirm fidelity sims route to remote automatically when an instance is active.

### Build Roster Requirement

1. Verify roster: `npm run roster show` -- must cover templates from both hero trees
2. If empty: `npm run roster generate` -- cluster-based generation from SPEC_CONFIG
3. `iterate.js init` requires the roster. Profileset mode auto-activates (all cluster builds have hashes).

### Progress Tracking

Before entering the iteration loop, query pending hypotheses (`iterate.js hypotheses`).
For the top N (up to 10), create a task for each using TaskCreate:

- subject: hypothesis summary (truncated to 60 chars)
- activeForm: "Testing <topic from hypothesis>"
- description: full summary + mutation type + source

When starting an iteration (Step 1), set the task to in_progress via `TaskUpdate { taskId, status: "in_progress" }`.
When recording the outcome (Step 5b), set the task to completed via `TaskUpdate { taskId, status: "completed" }` and update
the description with the result: "ACCEPTED +X.XX%: reason" or "REJECTED: reason".

If new hypotheses are generated mid-loop (escape strategies, theorycraft),
create new tasks as they're selected.

### Session Resilience

If resuming: `node src/sim/iterate.js status`, read `dashboard.md`/`changelog.md`, check `git log --oneline -10`, read `current.simc`, query DB findings (`getFindings({status:'validated'})`). Resume from Step 1.

### Iteration Loop

#### Step 1: Analyze

Read current APL. Load Tiers 1-3. Form 1-3 causal theories with specific numbers. Then check screeners:

```bash
node src/sim/iterate.js hypotheses
```

Use screener output to validate or quantify your theories, not replace them.

#### Step 2: Choose

Pick highest-value hypothesis. Priority: your deep theories > unified hypotheses with `consensus_count > 1` > aligned screener findings > high-confidence on high-DPS-share abilities > multi-part coherent changes.

**Prefer consensus hypotheses** — when multiple independent sources (strategic, theorycraft, divergence, theory-generator) converge on the same finding, that's strong evidence. Use `node src/sim/iterate.js hypotheses` to see consensus counts.

**Never test a hypothesis you can't explain causally.**

If exhausted: `node src/sim/iterate.js strategic` and `theorycraft` -- but reason about the APL FIRST.

#### Step 3: Modify

Read `current.simc`. Make ONE targeted change. Save as `candidate.simc`.

Before any change: locate the ability, understand its priority placement, trace resource/cooldown impact, check cross-references, check all hero tree branches, predict direction and magnitude.

#### Step 4: Test

Before launching any sim, write `results/{spec}/active-sim.json` (hypothesis, candidate path, fidelity, expected outcome, timestamp). This checkpoint enables `/sim-check` recovery after context compaction. The sim-runner agent does this automatically; for manual iteration, use `/sim-background` or write it directly.

```bash
node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick
# If any scenario regresses >1% -> reject immediately
# If promising:
node src/sim/iterate.js compare apls/{spec}/candidate.simc
# If marginal (0.1-0.3%):
node src/sim/iterate.js compare apls/{spec}/candidate.simc --confirm
```

SimC failure: syntax error -> fix and retry. Timeout -> kill and reject. 3+ crashes -> stop loop.

#### Step 5: Decide

- **Accept if:** mean weighted > target_error AND worst build > -1%. A change with impact below the sim's target_error is noise — do not accept it regardless of sign.
- **Build-gate if:** ANY builds gain meaningfully (>+0.5%) even if others regress. This is NOT a reject — it's a branching signal. Follow the **Partial Gains Protocol** below.
- **Reject if:** no subset of builds benefits meaningfully above the noise floor (±0.5% at standard fidelity), OR no valid SimC expression can discriminate the benefiting builds after systematic analysis of ALL discriminator axes. **Rejection requires documenting what you checked.**
- **Inconclusive:** within noise after confirm -> log and move on

**CRITICAL: Partial gains are opportunities, not failures.** A hypothesis that shows +2% for high-apex builds and -4% for low-apex builds is a STRONG signal for a gated implementation. The mean-weighted result is misleading in this case — look at per-build results and find the pattern.

**Partial Gains Protocol (MANDATORY before rejecting any mixed result):**

1. Sort all builds by weighted delta. Identify the top 10 gainers and top 10 losers.
2. Systematically check EACH discriminator axis for a clean split:
   - Hero tree (`hero_tree.aldrachi_reaver` / `hero_tree.annihilator`)
   - Apex rank (`apex.1`, `apex.2`, `apex.3`)
   - Talent cluster presence (`talent.X` for each cluster-defining talent)
   - Hero variant (hero-specific talent checks)
   - Target count (`variable.small_aoe`, `variable.single_target`)
3. A "clean split" means: gainers predominantly share a trait that losers lack, with minimal overlap.
4. At standard fidelity (target_error=1), the noise floor is ±0.5%. Only count builds with deltas ABOVE this threshold as meaningful gainers/losers.
5. If a discriminator exists: write a gated candidate using that SimC expression and re-test against the full roster.
6. If no discriminator exists after checking all axes: reject and document the analysis.
7. If gains are suggestive but ambiguous: escalate the top-gaining subset to `--confirm` fidelity before concluding.

```bash
node src/sim/iterate.js accept "reason" --hypothesis "description fragment"
node src/sim/iterate.js reject "reason" --hypothesis "description fragment"
```

#### Step 5b: Record

1. Update theory confidence via `reviseFromIteration(iterationId)` (+0.15 accept, -0.10 reject, refute at 0.2)
2. Record finding to DB via `addFinding()`
3. Update `plan.md`, `dashboard.md`
4. After accept: commit with `iterate: <hypothesis> (<+/-X.XX%> weighted)`

#### Step 6: Repeat

### Escape Strategies (3+ consecutive rejections)

1. **Compound mutation** -- try two individually-rejected changes that might synergize
2. **Reversal test** -- reverse a previously accepted change
3. **Radical reorder** -- swap top 3-5 priority actions in a sub-list
4. **Reference import** -- compare against simc default APL in `reference/`
5. **Category rotation** -- switch from threshold sweeps to reordering to conditions

### Parallelism in Iteration

When independent hypotheses exist (use `src/analyze/hypothesis-independence.js`):

1. Group by independence (`groupIndependent()`)
2. For each independent hypothesis, use `subagent_type: "apl-engineer"` (`model: "opus"`) to generate the candidate APL in parallel
3. Launch parallel `subagent_type: "sim-runner"` agents (`model: "opus"`) with `run_in_background: true`, each testing one candidate at `--quick`
4. Promote best to standard fidelity
5. Re-baseline before next group

For sequential iteration (the common case), you can still parallelize: generate the next candidate while reviewing the current sim results.

### Stop Conditions

- 3 consecutive rejections with no new hypotheses -> escape strategies
- 10 consecutive rejections -> stop
- All categories + escape strategies exhausted -> stop
- Context approaching ~180k tokens -> checkpoint and suggest restart

### Context Window Management

- Don't read full sim JSON -- use `iterate.js status` and `compare` for summaries
- Don't re-read guides every iteration -- once at startup
- Short reasons in accept/reject -- one sentence

---

## Phase 4: Cross-Build Analysis + Final Report

### 4a. Re-rank Builds

```bash
npm run roster generate               # Regenerate roster with latest SPEC_CONFIG
```

### 4b. Audit APL Branch Coverage

Every build template has appropriate branching, no dead branches, branch comments explain purpose, shared logic not duplicated.

### 4c. Record Findings

Record via `addFinding()`: id, timestamp, hypothesis, status, scope, archetype, impact, mechanism, aplBranch.

### 4d. Generate Showcase Report

Use the `/showcase` skill (which runs the report generator and opens the result in a browser). Pass `--skip-sims` if the roster was just simmed in Phase 4b.

### 4e. Reports

```bash
node src/sim/iterate.js summary
npm run db:dump                  # Verify DB state
```

### 4f. Session Summary

Build roster coverage, hypotheses tested/accepted/rejected, theories validated/refuted, per-build DPS improvement, APL branches created, remaining untested ideas, showcase location.

### 4g. Commit

```bash
git add apls/{spec}/{spec}.simc results/{spec}/
git commit -m "optimize: {spec} -- N iterations, M accepted, +X.XX% mean weighted DPS"
```

---

## Checkpoint Protocol

On context limits or interruption, save to `results/{spec}/checkpoint.md`: current phase, hypothesis, per-build progress, templates analyzed, APL branches created, remaining work.

## Anti-Patterns

- **Single-build testing** -- ALWAYS test against the full roster
- **Specialists without theory** -- form root theories BEFORE launching specialists
- **Sequential specialists** -- ALWAYS launch all 4 in parallel
- **Flat APL for diverse builds** -- if builds differ (cluster presence, apex rank), the APL MUST branch
- **Trusting screener output without reasoning** -- observations are not insights
- **Grinding thresholds without theory** -- test values from mechanical reasoning, not sweeps
- **Ignoring per-build results** -- aggregate mean hides per-template regressions
- **Writing optimization results to memory files** -- ALL findings, hypotheses, and iteration results go to `theorycraft.db` via `addFinding()`, `addHypothesis()`, `addIteration()`. NEVER write session results, accepted/rejected hypotheses, or mechanical discoveries to auto-memory (`memory/*.md`). The DB is the canonical store; memory files are for durable workflow knowledge only.
