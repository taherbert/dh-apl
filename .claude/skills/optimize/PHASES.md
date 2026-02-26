# /optimize Phase Reference

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

Check `getSessionState('phase')` and `getSessionState('session_id')` for existing session. If found, reconstruct via `getIterations({ sessionId })` + `iterate.js status` + `results/{spec}/plan.md`. If no DB session, check `iterate.js status` and `results/{spec}/checkpoint.md`.

### 0c. Generate Build Roster

```bash
npm run roster generate               # Cluster-based roster from SPEC_CONFIG templates
npm run roster show                   # Verify coverage
```

### 0d. Establish Multi-Build Baseline

Only if no active iteration session:

```bash
node src/sim/iterate.js init apls/{spec}/{spec}.simc
```

### 0e. Load the Full Knowledge Base

**Tier 1 -- Mechanical Blueprint (always load):** spec adapter (`src/spec/{spec}.js` SPEC_CONFIG), current APL, `spells-summary.json`

**Tier 2 -- Interaction & Proc Data:** `interactions-summary.json`, `cpp-proc-mechanics.json`, SPEC_CONFIG talent clusters (`talentClusters`, `rosterTemplates`)

**Tier 3 -- Accumulated Knowledge:** DB findings (`getFindings({status:'validated'})`), DB hypotheses (`getHypotheses()`), DB builds/synergies

**Tier 4 -- External:** Wowhead/Icy Veins when internal data has gaps (treat as hypotheses).

**Token budget:** Use `npm run data:query -- <type> <term>` for targeted lookups instead of reading full data files. Only read full summary files when broad analysis is needed.

**In direct hypothesis mode (`test:`):** Load Tiers 1-3 only. Skip Phases 1-2.

### 0f. Batch Divergence Analysis (Pre-Hypothesis Priming)

Run the batch pattern-analyze pipeline across all representative builds:

```bash
node src/sim/iterate.js pattern-analyze
```

Output: `results/{spec}/divergence-report-{build}.md`, `divergences-{build}.json`, `cross-archetype-synthesis.json`, and theory-generator hypotheses in the DB.

**What it tells you:** Each divergence is a specific claim — "at state S, 15s rollout prefers X over Y by Z points." Divergences with high delta (>100) that recur across archetypes are strong theory candidates.

**Limitation:** The rollout uses an approximate scoring model. Treat every divergence as a hypothesis requiring causal reasoning — not a proven improvement. Skip this step if resuming a session.

---

## Phase 1: Deep Reasoning + Parallel Specialists

> **Skipped in direct hypothesis mode.** Jump to Phase 3.

### 1a. Deep Reasoning (REQUIRED before specialists)

#### Study the Build Roster

What talent clusters define each template? Which cluster combinations create compound value? How do different builds differ in rotation needs? Read SPEC_CONFIG `talentClusters` and `rosterTemplates`.

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

Read `results/{spec}/divergence-report-*.md` (from Phase 0f). Each divergence is a candidate theory seed. Apply deep mechanical reasoning: WHY does the divergence exist? Is the rollout's reasoning sound in context?

2-3 theories that GUIDE everything. **Persist to DB** via `createTheory()`.

Set session phase: `setSessionState('phase', '1_specialists')`

#### Non-Obvious Discovery Techniques

- **Inverse optimization** -- remove conditions one by one, measure delta
- **Sensitivity analysis** -- vary numeric thresholds, plot DPS response
- **Cross-scenario divergence** -- same APL at different target counts, look for rank inversions
- **Execute phase detection** -- test `target.time_to_die` thresholds

#### Target Count Regimes

- **ST** -- cooldown alignment primary, resource pooling for burst
- **Cleave (3-5T)** -- AoE spender DPGCD dominates, quadratic scaling loops
- **Heavy AoE (8-10T)** -- GCD budget is binding, secondary resource abundant

### 1b. Parallel Specialist Launch

Launch 4 specialists **IN PARALLEL** using the Task tool. All 4 calls in a **SINGLE message**. Each specialist uses `subagent_type: "theorist"`, `model: "opus"`. Run all in background with `run_in_background: true`.

Each specialist prompt MUST include the root theories, roster template structure, spec name/data paths, and focus area.

| Specialist          | Focus                                                | Key Data                                              | Output                        |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| Spell Data          | DPGCD rankings, modifier stacking, proc mechanics    | spells-summary, cpp-proc-mechanics, interactions      | `analysis_spell_data.json`    |
| Talent Interactions | Synergy clusters, anti-synergies, build-APL coupling | talents, interactions, SPEC_CONFIG clusters/templates | `analysis_talent.json`        |
| Resource Flow       | Resource equilibrium, GCD budget, cooldown cycles    | spells-summary, cpp-proc-mechanics, APL               | `analysis_resource_flow.json` |
| State Machine       | Hero tree rhythms, variable correctness, dead code   | APL, SPEC_CONFIG clusters, spells-summary             | `analysis_state_machine.json` |

While specialists run in background, continue reading the knowledge base or begin Phase 2 preparation.

---

## Phase 2: Synthesis

> **Skipped in direct hypothesis mode.** Jump to Phase 3.

### 2a. Synthesize

```bash
node src/sim/iterate.js synthesize
```

Read all four `results/{spec}/analysis_*.json` files. Cross-reference with root theories.

### 2b-2d. Generate Hypotheses

```bash
node src/sim/iterate.js divergence-hypotheses    # Import state-sim divergences
node src/sim/iterate.js strategic                 # APL-level strategic hypotheses
node src/sim/iterate.js theorycraft               # Resource-flow and temporal hypotheses
```

### 2e. Unify All Hypothesis Sources

```bash
node src/sim/iterate.js unify
```

Performs fingerprinting, consensus detection, mutation inference, priority boosting, and DB persistence. After unification, ALL hypotheses can produce candidates via `iterate.js generate`.

### 2f. Rank Hypotheses

1. **Your theories that specialists missed** -- highest priority
2. **Unified hypotheses with consensus_count > 1** -- convergent evidence
3. **Divergences with rollout_delta > 100 recurring across archetypes**
4. **Specialist findings aligned with theories**
5. **Single-source hypotheses with mutation**
6. **Specialist findings with no causal backing** -- lower priority

**Scope ranking:** Universal > Template-specific > Hero-tree-specific > Build-specific

### 2g. Generate Summary

Write `results/{spec}/analysis_summary.md`. Initialize `dashboard.md` and `changelog.md`. Proceed directly to testing.

---

## Phase 3 Supplementary: Escape Strategies + Parallelism

### Escape Strategies (3+ consecutive rejections)

1. **Compound mutation** -- try two individually-rejected changes that might synergize
2. **Reversal test** -- reverse a previously accepted change
3. **Radical reorder** -- swap top 3-5 priority actions in a sub-list
4. **Reference import** -- compare against simc default APL in `reference/`
5. **Category rotation** -- switch from threshold sweeps to reordering to conditions

### Parallelism in Iteration

**Default: pipeline standard/confirm sims with next-hypothesis work.** As soon as you launch a standard/confirm sim in background, start Step 1 for the next hypothesis.

**Batch: multiple independent hypotheses.** When independent hypotheses exist (check `src/analyze/hypothesis-independence.js`):

1. Group by independence (`groupIndependent()`)
2. Use `subagent_type: "apl-engineer"` (`model: "opus"`) to generate all candidate APLs **in parallel**
3. Run quick screening sequentially (fast and local)
4. Promote passing candidates to standard fidelity using `/sim-background`
5. Use `/sim-check` to collect results; accept/reject each
6. Re-baseline before starting the next independent group

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

Use the `/showcase` skill. Pass `--skip-sims` if the roster was just simmed in Phase 4b.

### 4e. Reports

```bash
node src/sim/iterate.js summary
npm run db:dump
```

### 4f. Stop Remote Instance

```bash
npm run remote:stop
```

### 4g. Commit

```bash
git add apls/{spec}/{spec}.simc results/{spec}/
git commit -m "optimize: {spec} -- N iterations, M accepted, +X.XX% mean weighted DPS"
```
