The ONE command for all APL and build optimization. Runs everything autonomously: discover archetypes, deep reasoning, parallel specialist analysis, synthesis, multi-build iteration, APL branching, and reporting.

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

### 0a. Determine Active Spec

Run `node src/engine/startup.js`.

### 0b. Session Recovery

Check DB for existing session:

```javascript
const phase = getSessionState("phase");
const sessionId = getSessionState("session_id");
```

If a session exists, read `results/{spec}/plan.md` and query `getIterations({ sessionId })`. Resume from where we left off.

If no DB session, check legacy: `node src/sim/iterate.js status`. If iteration state exists, check `results/{spec}/checkpoint.md`.

### 0c. Discover Archetypes and Generate Build Roster

```bash
npm run discover -- --quick           # DoE-based archetype discovery (~2-5 min)
npm run roster show                   # Verify coverage
npm run roster generate-hashes        # Enable profileset mode
```

Skip discovery if DB has archetypes from < 24h ago. Just verify roster.

### 0d. Establish Multi-Build Baseline

Only if no active iteration session:

```bash
node src/sim/iterate.js init apls/{spec}/{spec}.simc
```

### 0e. Load the Full Knowledge Base

**Tier 1 -- Mechanical Blueprint (always load):** spec adapter (`src/spec/{spec}.js` SPEC_CONFIG), current APL, `spells-summary.json`

**Tier 2 -- Interaction & Proc Data:** `interactions-summary.json`, `cpp-proc-mechanics.json`, DB talent clusters/archetypes (`getTalentClusters()`, `getArchetypes()`)

**Tier 3 -- Accumulated Knowledge:** DB findings (`getFindings({status:'validated'})`), DB hypotheses (`getHypotheses()`), DB builds/archetypes/factors/synergies

**Tier 4 -- External:** Wowhead/Icy Veins when internal data has gaps (treat as hypotheses).

All data paths in `data/{spec}/` and `results/{spec}/`. See CLAUDE.md "Data File Selection" for full path reference.

**In direct hypothesis mode (`test:`):** Load Tiers 1-3 only. Skip Phases 1-2.

---

## Phase 1: Deep Reasoning + Parallel Specialists

> **Skipped in direct hypothesis mode.** Jump to Phase 3.

### 1a. Deep Reasoning (REQUIRED before specialists)

**This is the most important step.**

#### Study the Archetypes

What talent clusters define each archetype? What factor impacts are largest? Which synergy pairs create compound value? How do archetypes differ in rotation needs?

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

#### Map Archetype-Specific Tensions

Where do different archetypes need different APL behavior?

#### Study Reference APL

Read `reference/{spec}-apl.simc` for SimC syntax patterns (NOT priorities): variable patterns, trinket handling, state machine encoding, delegation, AoE breakpoints, cooldown sync.

#### Form Root Theories

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

Launch 4 specialists IN PARALLEL using Task tool (`subagent_type: "general-purpose"`). All 4 in a SINGLE message. Include root theories and archetype results.

| Specialist          | Focus                                                | Key Data                                                | Output                        |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| Spell Data          | DPGCD rankings, modifier stacking, proc mechanics    | spells-summary, cpp-proc-mechanics, interactions        | `analysis_spell_data.json`    |
| Talent Interactions | Synergy clusters, anti-synergies, build-APL coupling | talents, interactions, DB clusters/archetypes/synergies | `analysis_talent.json`        |
| Resource Flow       | Resource equilibrium, GCD budget, cooldown cycles    | spells-summary, cpp-proc-mechanics, APL                 | `analysis_resource_flow.json` |
| State Machine       | Hero tree rhythms, variable correctness, dead code   | APL, DB clusters/archetypes, spells-summary             | `analysis_state_machine.json` |

---

## Phase 2: Synthesis

> **Skipped in direct hypothesis mode.** Jump to Phase 3.

### 2a. Synthesize

```bash
node src/sim/iterate.js synthesize
```

Read all four `results/{spec}/analysis_*.json` files. Cross-reference with root theories.

### 2b. Rank Hypotheses

1. **Your theories that specialists missed** -- highest priority (deep insights)
2. **Specialist findings aligned with theories** -- high priority
3. **Specialist findings with no causal backing** -- lower priority

**Scope ranking:** Universal > Archetype-specific > Hero-tree-specific > Build-specific

### 2c. Generate Summary

Write `results/{spec}/analysis_summary.md`. Initialize `dashboard.md` and `changelog.md`.

**Proceed directly to testing.**

---

## Phase 3: Multi-Build Iteration Loop

**Every test runs against ALL roster builds simultaneously.**

### Build Roster Requirement

1. Verify roster: `npm run roster show` -- must cover all archetypes from both hero trees
2. If empty: `npm run roster migrate` or re-run discovery
3. Generate hashes: `npm run roster generate-hashes`
4. `iterate.js init` requires the roster. Profileset mode auto-activates when all builds have hashes.

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

Pick highest-value hypothesis. Priority: your deep theories > aligned screener findings > high-confidence on high-DPS-share abilities > multi-part coherent changes.

**Never test a hypothesis you can't explain causally.**

If exhausted: `node src/sim/iterate.js strategic` and `theorycraft` -- but reason about the APL FIRST.

#### Step 3: Modify

Read `current.simc`. Make ONE targeted change. Save as `candidate.simc`.

Before any change: locate the ability, understand its priority placement, trace resource/cooldown impact, check cross-references, check all hero tree branches, predict direction and magnitude.

#### Step 4: Test

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

- **Accept if:** mean weighted > 0 AND worst build > -1%
- **Archetype-gate if:** helps some (>+0.1%) but hurts others (>-0.3%). Create gated sub-list, re-test.
- **Reject if:** mean weighted <= 0 OR regressions without branching path
- **Inconclusive:** within noise after confirm -> log and move on

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
2. Launch 2-3 parallel subagents, each testing one candidate at `--quick`
3. Promote best to standard fidelity
4. Re-baseline before next group

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
npm run discover -- --quick
```

### 4b. Audit APL Branch Coverage

Every archetype has appropriate branching, no dead branches, branch comments explain purpose, shared logic not duplicated.

### 4c. Record Findings

Record via `addFinding()`: id, timestamp, hypothesis, status, scope, archetype, impact, mechanism, aplBranch.

### 4d. Generate Showcase Report

```bash
SPEC=$SPEC node src/visualize/showcase.js --fidelity standard
```

### 4e. Reports

```bash
node src/sim/iterate.js summary
npm run db:dump                  # Verify DB state
```

### 4f. Session Summary

Archetypes discovered, hypotheses tested/accepted/rejected, theories validated/refuted, per-archetype DPS improvement, APL branches created, remaining untested ideas, showcase location.

### 4g. Commit

```bash
git add apls/{spec}/{spec}.simc results/{spec}/
git commit -m "optimize: {spec} -- N iterations, M accepted, +X.XX% mean weighted DPS"
```

---

## Checkpoint Protocol

On context limits or interruption, save to `results/{spec}/checkpoint.md`: current phase, hypothesis, per-build progress, archetypes analyzed, APL branches created, remaining work.

## Anti-Patterns

- **Single-build testing** -- ALWAYS test against the full roster
- **Specialists without theory** -- form root theories BEFORE launching specialists
- **Sequential specialists** -- ALWAYS launch all 4 in parallel
- **Flat APL for diverse builds** -- if archetypes differ, the APL MUST branch
- **Trusting screener output without reasoning** -- observations are not insights
- **Grinding thresholds without theory** -- test values from mechanical reasoning, not sweeps
- **Ignoring per-build results** -- aggregate mean hides archetype regressions
