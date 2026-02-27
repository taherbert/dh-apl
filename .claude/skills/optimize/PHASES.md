# /optimize Phase Reference — Subagent Instructions

Each phase section below is a self-contained instruction set for the subagent that executes it. Subagents read their section, execute fully, persist results to DB + files, and return a brief summary.

---

## Phase 0: Setup (inline — run by main thread)

### 0a. Determine Active Spec + Data Freshness Gate

Run `node src/engine/startup-cli.js` to check config, spec, and simc sync status.

**Staleness gate — auto-refresh if needed:**

1. Check the startup output for the `Sync:` line. If it says anything other than `up to date`, local data is stale.

2. Check for upstream simc changes:

```bash
git -C /Users/tom/Documents/GitHub/simc fetch origin midnight --quiet
git -C /Users/tom/Documents/GitHub/simc rev-parse HEAD
git -C /Users/tom/Documents/GitHub/simc rev-parse origin/midnight
```

3. If either check shows staleness: `SPEC={spec} npm run refresh`

4. Re-run `node src/engine/startup-cli.js` to confirm.

### 0b. Session Recovery

```bash
node src/sim/iterate.js phase
node src/sim/iterate.js status
```

If a session exists, skip to the appropriate phase.

### 0c. Generate Roster + Baseline

```bash
npm run roster generate
npm run roster show
node src/sim/iterate.js init apls/{spec}/{spec}.simc   # Only if no active session
```

### 0d. Pattern Analysis (optional, skip if resuming)

```bash
node src/sim/iterate.js pattern-analyze
```

Output: divergence reports, theory-generator hypotheses in DB.

---

## Phase 1: Deep Reasoning Subagent Instructions

> **Agent config:** `subagent_type: "general-purpose"`, `model: "opus"`
> **Skipped in direct hypothesis mode (`test:`)**

### Inputs

Read these files (in YOUR context, not the orchestrator's):

- **Spec adapter:** `src/spec/{spec}.js` — SPEC_CONFIG (abilities, resources, hero trees, clusters, templates)
- **Current APL:** `apls/{spec}/{spec}.simc` or `apls/{spec}/current.simc`
- **Spells summary:** `data/{spec}/spells-summary.json` (~57KB)
- **Interactions summary:** `data/{spec}/interactions-summary.json` (~329KB) — prefer `npm run data:query -- interaction <term>` for targeted lookups
- **Proc mechanics:** `data/{spec}/cpp-proc-mechanics.json`
- **Talents:** `data/{spec}/talents.json`
- **DB findings:** Run `npm run db:dump` or query validated findings
- **DB hypotheses:** `node src/sim/iterate.js hypotheses` for previously tested work
- **Divergence reports:** `results/{spec}/divergence-report-*.md` (from Phase 0d, if they exist)

### Process

#### Study the Build Roster

What talent clusters define each template? Which cluster combinations create compound value? How do different builds differ in rotation needs? Read SPEC_CONFIG `talentClusters` and `rosterTemplates`.

#### Model the Economy

**Primary resource** — Compute equilibrium: resource in/out per minute, marginal damage value per unit on each spender, burst window shifts.

**Secondary resource** — Steady-state generation rate by target count, waste sources, consumption value per unit.

**GCD budget** — ~48 GCDs/min at 20% haste. Map mandatory, discretionary, and negative-value abilities.

#### Identify Systemic Tensions

- **Resource competition** — two consumers, same pool. Is APL arbitration correct?
- **Cooldown misalignment** — map periods, multiplicative overlaps, holding costs, LCM supercycle
- **Burst window utilization** — GCDs in window, filled with highest-DPGCD? Pre-pooling?
- **State machine incoherence** — hero tree cycles vs APL rhythm
- **Second-order chains** — indirect value chains invisible in single-ability analysis

#### Map Build-Specific Tensions

Where do different builds need different APL behavior? Cluster presence/absence and apex rank create the primary variation axes.

#### Study Reference APL

Read `reference/{spec}-apl.simc` for SimC syntax patterns (NOT priorities): variable patterns, trinket handling, state machine encoding, delegation, AoE breakpoints, cooldown sync.

#### Form Root Theories

Read divergence reports if they exist. Each divergence is a candidate theory seed. Apply deep mechanical reasoning: WHY does the divergence exist? Is the rollout's reasoning sound in context?

2-3 theories that GUIDE everything. **Persist to DB** via `createTheory()`.

#### Non-Obvious Discovery Techniques

- **Inverse optimization** — remove conditions one by one, measure delta
- **Sensitivity analysis** — vary numeric thresholds, plot DPS response
- **Cross-scenario divergence** — same APL at different target counts, look for rank inversions
- **Execute phase detection** — test `target.time_to_die` thresholds

#### Target Count Regimes

- **ST** — cooldown alignment primary, resource pooling for burst
- **Cleave (3-5T)** — AoE spender DPGCD dominates, quadratic scaling loops
- **Heavy AoE (8-10T)** — GCD budget is binding, secondary resource abundant

### Outputs (persistence contract)

1. **DB:** 2-3 theories via `createTheory()` with title, reasoning, causal chains, confidence
2. **File:** `results/{spec}/deep_reasoning.md` — the full reasoning document including:
   - Resource economy model with numbers
   - Systemic tensions identified
   - Build-specific tension map
   - Root theories with evidence
   - Predicted high-leverage areas for specialist investigation

### Returns (to orchestrator)

A single message: "Created N theories: [short titles]. Deep reasoning written to deep_reasoning.md."

Do NOT return the full reasoning text. The orchestrator should never see it — it's for the specialists and synthesis subagent to read from the file.

---

## Specialist Subagent Details

> **Agent config:** `subagent_type: "theorist"`, `model: "opus"`, `run_in_background: true`
> See `/.claude/agents/theorist.md` for the full theorist agent framework.

Each specialist reads `results/{spec}/deep_reasoning.md` for root theories before starting analysis.

| Specialist          | Focus                                                | Key Data                                              | Output File                   |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| Spell Data          | DPGCD rankings, modifier stacking, proc mechanics    | spells-summary, cpp-proc-mechanics, interactions      | `analysis_spell_data.json`    |
| Talent Interactions | Synergy clusters, anti-synergies, build-APL coupling | talents, interactions, SPEC_CONFIG clusters/templates | `analysis_talent.json`        |
| Resource Flow       | Resource equilibrium, GCD budget, cooldown cycles    | spells-summary, cpp-proc-mechanics, APL               | `analysis_resource_flow.json` |
| State Machine       | Hero tree rhythms, variable correctness, dead code   | APL, SPEC_CONFIG clusters, spells-summary             | `analysis_state_machine.json` |

Each specialist writes JSON output to `results/{spec}/analysis_{focus}.json` per the format in `theorist.md`.

---

## Phase 2: Synthesis Subagent Instructions

> **Agent config:** `subagent_type: "general-purpose"`, `model: "opus"`
> **Skipped in direct hypothesis mode (`test:`)**

### Inputs

Read these files (in YOUR context, not the orchestrator's):

- **Deep reasoning:** `results/{spec}/deep_reasoning.md`
- **Specialist outputs:** All four `results/{spec}/analysis_*.json` files
- **DB theories:** Run `npm run db:dump` to get current theories
- **Current APL:** `apls/{spec}/current.simc` or `apls/{spec}/{spec}.simc`

### Process

#### 2a. Synthesize

```bash
node src/sim/iterate.js synthesize
```

Cross-reference all specialist outputs with root theories from deep_reasoning.md.

#### 2b-2d. Generate Hypotheses

```bash
node src/sim/iterate.js divergence-hypotheses
node src/sim/iterate.js strategic
node src/sim/iterate.js theorycraft
```

#### 2e. Unify

```bash
node src/sim/iterate.js unify
```

Fingerprinting, consensus detection, mutation inference, DB persistence.

#### 2f. Rank Hypotheses

1. **Root theories that specialists missed** — highest priority
2. **Unified hypotheses with consensus_count > 1** — convergent evidence
3. **Divergences with rollout_delta > 100 recurring across archetypes**
4. **Specialist findings aligned with theories**
5. **Single-source hypotheses with mutation**
6. **Specialist findings with no causal backing** — lower priority

**Scope ranking:** Universal > Template-specific > Hero-tree-specific > Build-specific

#### 2g. Generate Summary

Write `results/{spec}/analysis_summary.md`. Initialize `dashboard.md` and `changelog.md`.

### Outputs (persistence contract)

1. **DB:** All hypotheses persisted via `iterate.js unify`
2. **Files:** `analysis_summary.md`, `dashboard.md`, `changelog.md`

### Returns (to orchestrator)

"Synthesis complete. N hypotheses generated (M unified with consensus). Top 5: [one-line each with category and priority]."

---

## Phase 3: Iteration Batch Subagent Instructions

> **Agent config:** `subagent_type: "general-purpose"`, `model: "opus"`

### Inputs

- **Current APL:** `apls/{spec}/current.simc`
- **Pending hypotheses:** `node src/sim/iterate.js hypotheses`
- **Iteration state:** `node src/sim/iterate.js status`
- **Spec data:** Use `npm run data:query -- <type> <term>` for targeted lookups. Do NOT read full data files unless you need broad analysis for a specific hypothesis.

### Process

For each hypothesis in your batch (up to the batch size given in your prompt):

#### Step 1: Analyze

Read current APL. Form a causal theory for this specific hypothesis — "this change should improve X because Y." Check `iterate.js hypotheses` for prior test results to avoid retesting.

#### Step 2: Choose

Verify the hypothesis is worth testing. Skip if: already tested, no causal backing, duplicates a prior rejection.

#### Step 3: Modify

Read `current.simc`. Make ONE targeted change. Save as `candidate.simc`. Before the change: locate the ability, understand its priority placement, trace resource/cooldown impact, check cross-references in all hero tree branches, predict direction and magnitude.

#### Step 4: Test

**Default (staged — quick screen then auto-escalate to standard):**

```bash
node src/sim/iterate.js compare apls/{spec}/candidate.simc
```

Staged mode runs quick fidelity first. If mean weighted < -0.2%, it rejects immediately without running standard. Otherwise it auto-escalates to standard in the same call.

**Quick only (when you want a fast answer without escalation):**

```bash
node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick
```

**Confirm fidelity (for marginal changes near the noise floor):**

```bash
node src/sim/iterate.js compare apls/{spec}/candidate.simc --confirm
```

SimC failure: syntax error -> fix and retry. Timeout -> kill and reject. 3+ crashes -> stop batch.

#### Step 5: Decide

- **Accept if:** mean weighted > target_error AND worst build > -1%
- **Reject if:** no subset benefits above noise floor, OR no valid SimC discriminator exists after checking ALL axes
- **Inconclusive:** within noise after confirm -> log and move on

**CRITICAL: Partial gains are opportunities, not failures.** A hypothesis showing +2% for some builds and -4% for others is a STRONG signal for a gated implementation. Before rejecting ANY mixed result:

1. Sort all builds by weighted delta. Identify top/bottom 10 gainers/losers.
2. Systematically check EACH discriminator axis: hero tree, apex rank, talent cluster presence, hero variant, target count.
3. A "clean split" = gainers share a trait losers lack.
4. At standard fidelity, only deltas above +/-0.5% are meaningful.
5. If a discriminator exists: write a gated candidate and re-test the full roster.
6. If no discriminator exists after checking all axes: reject and document the analysis.
7. If gains are suggestive but ambiguous: escalate to `--confirm` fidelity.

**Never reject based on mean-weighted alone.** Always examine per-build distribution.

```bash
node src/sim/iterate.js accept "reason" --hypothesis "description fragment"
node src/sim/iterate.js reject "reason" --hypothesis "description fragment"
```

#### Step 6: Record + Continue

After each accept/reject, the DB is updated automatically by iterate.js. Continue to the next hypothesis in your batch.

After each accept: commit with `iterate: <hypothesis> (<+/-X.XX%> weighted)`

### Outputs (persistence contract)

1. **DB:** Iterations recorded via `iterate.js accept/reject`, hypothesis statuses updated
2. **Files:** `dashboard.md` and `changelog.md` updated by iterate.js
3. **APL:** `current.simc` updated on accept (iterate.js does this automatically)

### Returns (to orchestrator)

"Batch: N tested, M accepted (best: +X.XX%), P rejected. Consecutive rejections: R. Remaining pending: K."

Include a 1-line note if escape strategies are needed (3+ consecutive rejections) or if a significant finding was made.

---

## Phase 3 Supplementary: Escape Strategies

When the orchestrator detects 3+ consecutive rejections, it should include these directives in the next batch subagent's prompt:

1. **Compound mutation** — try two individually-rejected changes that might synergize
2. **Reversal test** — reverse a previously accepted change
3. **Radical reorder** — swap top 3-5 priority actions in a sub-list
4. **Reference import** — compare against simc default APL in `reference/`
5. **Category rotation** — switch from threshold sweeps to reordering to conditions

---

## Phase 4: Cross-Build Analysis + Final Report (inline)

Run by main thread directly — these are CLI commands with small outputs.

### 4a. Re-rank Builds

```bash
npm run roster generate
```

### 4b. Audit APL Branch Coverage

Every build template has appropriate branching, no dead branches, branch comments explain purpose, shared logic not duplicated.

### 4c. Record Findings

Record via `addFinding()`: id, timestamp, hypothesis, status, scope, archetype, impact, mechanism, aplBranch.

### 4d. Generate Showcase Report

Use the `/showcase` skill.

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
git add apls/{spec}/{spec}.simc
git commit -m "optimize: {spec} - N iterations, M accepted, +X.XX% mean weighted DPS"
```
