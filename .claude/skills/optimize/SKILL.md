---
description: The ONE command for all APL and build optimization. Adaptive pipeline - focused tasks skip specialists and go straight to iteration; exploration mode runs full analysis. Always starts remote before sims.
argument-hint: "[focus directive or 'test: hypothesis']"
model: opus
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch
---

Autonomous APL optimization using **phase-as-subagent architecture**. Each phase runs in its own subagent with a fresh context window. The main thread is a thin state machine that reads summaries and launches subagents. Results persist to DB + files, never accumulate in the main conversation.

## Mode Detection

**Before starting, classify the task:**

| Mode            | Trigger                                                              | Path                                                           |
| --------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Focused**     | `$ARGUMENTS` names specific abilities, talents, builds, or mechanics | Phase 0 → Phase 1a ONLY (deep reasoning) → Phase 3 (iteration) |
| **Exploration** | `$ARGUMENTS` is empty or generic ("optimize", "find improvements")   | Phase 0 → Phase 1a+1b → Phase 2 → Phase 3                      |
| **Direct test** | `$ARGUMENTS` starts with `test:`                                     | Phase 0 → Phase 3 with those hypotheses                        |

**Focused mode skips specialists and synthesis.** The deep reasoning subagent already identifies actionable hypotheses when given a specific focus. Specialists are only valuable for broad, undirected exploration where you don't know what to look for. Never run specialists when the user has told you what to investigate.

## Architecture

```
Main Thread (thin orchestrator — never reads data files):
  ├── Phase 0: Setup + remote start (inline CLI commands)
  │
  ├── [FOCUSED] Phase 1a: Deep Reasoning subagent → hypotheses to DB
  │             Skip 1b + Phase 2, go directly to Phase 3
  │
  ├── [EXPLORATION] Phase 1a: Deep Reasoning → 1b: Specialists → Phase 2: Synthesis
  │
  ├── Phase 3: Loop: Launch Iteration Batch subagents → each tests 3-5 hypotheses
  └── Phase 4: Report (inline CLI commands)
```

**Context budget for main thread:** The main thread should NEVER read large data files (spells-summary.json, interactions-summary.json, talents.json). All analysis happens in subagents. The main thread reads only: `iterate.js status` output, `iterate.js phase` output, `dashboard.md`, `checkpoint.md`, DB query results (compact), and 1-line subagent return summaries.

## State Management

All state flows through `results/{spec}/theorycraft.db`. The orchestrator tracks its own phase:

```bash
node src/sim/iterate.js phase "1_reasoning"    # Set phase
node src/sim/iterate.js phase                   # Get phase
node src/sim/iterate.js status                  # Shows orchestrator phase + iteration state
```

**Recovery after context compaction:** The pre-compact hook auto-checkpoints and injects a recovery manifest. On resume: `iterate.js phase` to get current phase, `iterate.js status` for iteration state, read `checkpoint.md` and `plan.md` for context. Launch the appropriate phase subagent to continue.

---

## Phase 0: Setup (inline)

Run these directly in the main thread — they produce small outputs.

### 0a. Spec + Data Freshness

```bash
node src/engine/startup-cli.js
```

If simc data is stale, run `SPEC={spec} npm run refresh` before continuing.

### 0b. Start Remote Instance

**Always start the remote before any analysis.** Standard/confirm sims need it, and it takes ~30s to launch. Start it now so it's ready by Phase 3. If remote is already active, skip.

```bash
npm run remote:status        # Check if already active
npm run remote:start         # Start if not active (requires dangerouslyDisableSandbox for SSH)
```

If spot capacity is unavailable, note it and proceed — sims will run locally. **Never run standard/confirm fidelity locally when remote is available.** If remote fails to start due to sandbox restrictions, retry with `dangerouslyDisableSandbox: true`.

### 0c. Session Recovery

```bash
node src/sim/iterate.js phase         # Check orchestrator phase
node src/sim/iterate.js status        # Check iteration state
```

If a session exists, skip to the appropriate phase. If the orchestrator phase shows a partially-complete phase, resume from there.

### 0d. Generate Roster + Baseline

```bash
npm run roster generate
npm run roster show
node src/sim/iterate.js init apls/{spec}/{spec}.simc   # Only if no active session
```

### 0e. Pattern Analysis (optional, skip if resuming)

```bash
node src/sim/iterate.js pattern-analyze
```

### 0f. Set Phase

```bash
node src/sim/iterate.js phase "0_complete"
```

Update `results/{spec}/plan.md` with Phase 0 summary.

---

## Phase 1: Deep Reasoning + Specialists (subagents)

> **Skipped in direct hypothesis mode (`test:`).** Jump to Phase 3.

### 1a. Launch Deep Reasoning Subagent

Set phase, then launch a **single subagent** that does all the heavy reading and reasoning:

```bash
node src/sim/iterate.js phase "1_reasoning"
```

Launch with Task tool:

- `subagent_type: "general-purpose"`
- `model: "opus"`
- `run_in_background: false` (wait for completion)

**Subagent prompt must include:**

- Spec name and key paths (data dir, results dir, APL path)
- Path to spec knowledge file: `reference/{spec}-knowledge.md`
  (read first; eliminates need for Explore agents on structural knowledge)
- Focus directive (from `$ARGUMENTS`) if any
- Instruction: "Read `.claude/skills/optimize/PHASES.md` section 'Phase 1: Deep Reasoning Subagent Instructions' and execute fully."

**What the subagent does (details in PHASES.md):**

1. Loads all data files (spells-summary, interactions-summary, talents, SPEC_CONFIG, APL, DB findings) — in its own context, not yours
2. Studies the build roster and models the resource economy
3. Identifies systemic tensions and maps build-specific tensions
4. Forms 2-3 root theories, persists via `createTheory()`
5. Writes `results/{spec}/deep_reasoning.md` — the full reasoning document
6. Returns: "Created N theories: [short titles]. Deep reasoning written to deep_reasoning.md."

**Main thread receives:** A 1-2 line summary. Never sees the data files or reasoning text.

### 1b. Launch 4 Specialist Subagents (EXPLORATION MODE ONLY)

> **Skip this entirely in focused mode.** The deep reasoning subagent already produces actionable hypotheses when given a specific focus. Specialists add 30-40 minutes of wall time and produce redundant findings. Only run specialists when exploring an unknown optimization space with no specific directive.

After deep reasoning completes, launch all 4 specialists **in a SINGLE message**:

```bash
node src/sim/iterate.js phase "1_specialists"
```

Each specialist:

- `subagent_type: "theorist"`
- `model: "opus"`
- `run_in_background: true`

**Each specialist prompt must include:**

- Spec name, data dir path, results dir path
- "Read `results/{spec}/deep_reasoning.md` for root theories and context"
- Assigned focus area and output filename
- "Read `.claude/skills/optimize/PHASES.md` specialist table for framework details"

| Specialist          | Focus                                                | Output                        |
| ------------------- | ---------------------------------------------------- | ----------------------------- |
| Spell Data          | DPGCD rankings, modifier stacking, proc mechanics    | `analysis_spell_data.json`    |
| Talent Interactions | Synergy clusters, anti-synergies, build-APL coupling | `analysis_talent.json`        |
| Resource Flow       | Resource equilibrium, GCD budget, cooldown cycles    | `analysis_resource_flow.json` |
| State Machine       | Hero tree rhythms, variable correctness, dead code   | `analysis_state_machine.json` |

**Main thread receives:** Background completion notifications (1 line each). No analysis text enters the main context.

Update `plan.md` after specialists launch. Proceed to Phase 2 when all 4 complete.

---

## Phase 2: Synthesis (EXPLORATION MODE ONLY)

> **Skipped in focused mode and direct hypothesis mode (`test:`).** In focused mode, the deep reasoning subagent writes hypotheses directly to the DB — go straight to Phase 3. Only run synthesis when specialists produced analysis files that need cross-referencing.

```bash
node src/sim/iterate.js phase "2_synthesis"
```

Launch with Task tool:

- `subagent_type: "general-purpose"`
- `model: "opus"`
- `run_in_background: false` (wait for completion)

**Subagent prompt must include:**

- Spec name and key paths
- "Read `.claude/skills/optimize/PHASES.md` section 'Phase 2: Synthesis Subagent Instructions' and execute fully."

**What the subagent does (details in PHASES.md):**

1. Reads `deep_reasoning.md` + all 4 `analysis_*.json` files + DB theories — in its own context
2. Runs `iterate.js synthesize`, `divergence-hypotheses`, `strategic`, `theorycraft`, `unify`
3. Ranks hypotheses per the ranking protocol
4. Writes `results/{spec}/analysis_summary.md`, initializes `dashboard.md` and `changelog.md`
5. Returns: "Synthesis complete. N hypotheses generated (M unified). Top 5: [brief list]"

**Main thread receives:** A 2-3 line summary with hypothesis count and top priorities.

Update `plan.md`. Set phase:

```bash
node src/sim/iterate.js phase "2_complete"
```

---

## Phase 3: Iteration (batched subagents)

### Pre-Flight

Remote should already be running from Phase 0b. Verify and start if somehow not active:

```bash
npm run remote:status          # Should show active from Phase 0b
npm run remote:start           # Only if not active (dangerouslyDisableSandbox for SSH)
node src/sim/iterate.js phase "3_iteration"
```

Check pending hypotheses:

```bash
node src/sim/iterate.js hypotheses | head -30
```

### Iteration Batch Loop

Launch iteration batches as subagents. Each batch tests 3-5 hypotheses in a fresh context window:

```
while pending hypotheses remain AND stop conditions not met:
  1. Launch Iteration Batch subagent (foreground)
  2. Read 1-line return summary
  3. Read dashboard.md for progress
  4. Check stop conditions
  5. If continuing: launch next batch
```

**Batch subagent config:**

- `subagent_type: "general-purpose"`
- `model: "opus"`
- `run_in_background: false`

**Batch subagent prompt must include:**

- Spec name and key paths
- Current APL path (`apls/{spec}/current.simc`)
- "Read `.claude/skills/optimize/PHASES.md` section 'Phase 3: Iteration Batch Subagent Instructions' and execute fully."
- Batch size (3-5 hypotheses)
- Whether remote sims are available (`npm run remote:status` result)

**What the batch subagent does (details in PHASES.md):**

1. Reads current APL and queries DB for top pending hypotheses
2. For each hypothesis: analyze → write candidate → compare → accept/reject
3. All state persisted to DB via iterate.js accept/reject
4. Updates dashboard.md and changelog.md
5. Returns: "Batch: N tested, M accepted (+X.XX% best), P rejected. Consecutive rejections: R."

**Main thread receives:** A 1-line summary per batch.

### Stop Conditions (checked by main thread between batches)

- 3 consecutive rejections with no new hypotheses → try escape strategies
- 10 consecutive rejections → stop
- All categories + escape strategies exhausted → stop
- No pending hypotheses remaining → stop

### Escape Strategies

If consecutive rejections hit 3, pass escape directives to the next batch subagent prompt:

- Compound mutation: try two individually-rejected changes together
- Reversal test: reverse a previously accepted change
- Radical reorder: swap top 3-5 priorities in a sub-list
- Reference import: compare against `reference/` APL
- Category rotation: switch from thresholds to reordering to conditions

---

## Phase 4: Report + Commit (inline)

```bash
node src/sim/iterate.js phase "4_report"
npm run roster generate
node src/sim/iterate.js summary
npm run db:dump
```

Use `/showcase` for report generation. Then:

```bash
npm run remote:stop
node src/sim/iterate.js phase "complete"
```

Commit: `optimize: {spec} - N iterations, M accepted, +X.XX% mean weighted DPS`

---

## Anti-Patterns

- **Running specialists in focused mode** — NEVER. When the user names specific abilities/talents/builds, deep reasoning alone produces the hypotheses. Specialists add 30-40 min of redundant analysis.
- **Running standard/confirm sims locally** — NEVER when remote can be started. Always `npm run remote:start` in Phase 0. Quick fidelity is fine locally.
- **Waiting until Phase 3 to start remote** — Start in Phase 0b so it's ready when needed.
- **Reading data files in main thread** — NEVER. All data reading happens in subagents.
- **Large return values from subagents** — subagents persist to DB/files and return 1-line summaries
- **Single-build testing** — ALWAYS test against the full roster
- **Specialists without theory** — deep reasoning BEFORE specialists (exploration mode only)
- **Sequential specialists** — ALWAYS launch all 4 in a SINGLE message (exploration mode only)
- **Skipping phase tracking** — always `iterate.js phase <value>` at transitions
- **Ignoring per-build results** — aggregate mean hides regressions
- **Rejecting partial gains** — gate them instead (see PHASES.md Phase 3)
- **Writing results to memory** — ALL findings go to `theorycraft.db`, never auto-memory
