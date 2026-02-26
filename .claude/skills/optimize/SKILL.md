---
description: The ONE command for all APL and build optimization. Runs everything autonomously — generates cluster roster, deep reasoning, parallel specialist analysis, synthesis, multi-build iteration, and reporting.
argument-hint: "[focus directive or 'test: hypothesis']"
model: opus
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch
---

Autonomous APL optimization: roster, deep reasoning, parallel specialists, synthesis, multi-build iteration, APL branching, reporting.

If `$ARGUMENTS` starts with `test:`, skip Phases 1-2 and jump to Phase 3 with those hypotheses. Otherwise treat `$ARGUMENTS` as a focus directive.

## State Management

All state flows through `results/{spec}/theorycraft.db`.

```javascript
import {
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
```

**Recovery after context compaction:** `getSessionState('phase')`, `getSessionState('session_id')`, `getIterations({ sessionId })`, `getHypotheses({ status: 'pending' })`, read `results/{spec}/plan.md`. Update `plan.md` after every phase transition and iteration.

---

## Phases 0-2: Setup, Reasoning, Synthesis

Read `.claude/skills/optimize/PHASES.md` for detailed phase instructions before starting each phase. Key sequence:

**Phase 0:** startup-cli check -> session recovery -> roster generate -> baseline init -> pattern-analyze -> load knowledge base. Use `npm run data:query` for targeted lookups instead of reading full data files.

**Phase 1:** This is the most important phase. Deep mechanical reasoning FIRST: model the resource economy (equilibrium, marginal DPGCD, burst windows), identify systemic tensions (resource competition, cooldown misalignment, state machine incoherence, second-order chains), map build-specific tensions across cluster/apex axes. Form 2-3 root theories and persist via `createTheory()`. THEN launch specialists.

**Specialist launch mandate:** Launch all 4 specialists (spell data, talent interactions, resource flow, state machine) in a **SINGLE message** using Task tool with `subagent_type: "theorist"`, `model: "opus"`, `run_in_background: true`. Never launch sequentially. Each prompt MUST include your root theories verbatim, roster template structure, spec/data paths, and assigned focus area. See PHASES.md for the specialist table.

**Phase 2:** synthesize -> divergence-hypotheses -> strategic -> theorycraft -> unify -> rank -> write summary. Ranking: your deep theories > unified hypotheses with consensus_count > 1 > divergences with delta > 100 across archetypes > aligned specialist findings > single-source hypotheses.

**In direct hypothesis mode (`test:`):** Skip Phases 1-2. Load knowledge base tiers 1-3 only. Jump to Phase 3.

---

## Phase 3: Multi-Build Iteration Loop

**Every test runs against ALL roster builds simultaneously.** Before entering the loop, read `.claude/skills/optimize/PHASES.md` section "Phase 3 Supplementary" for escape strategies and batch parallelism patterns.

### Pre-Flight

```bash
npm run remote:status
npm run remote:start    # if not active — start automatically
```

Query pending hypotheses (`iterate.js hypotheses`). For the top N (up to 10), create a task for each using TaskCreate. Set to in_progress when starting, completed when done (update description with "ACCEPTED +X.XX%: reason" or "REJECTED: reason").

**If resuming:** `iterate.js status`, read `dashboard.md`/`changelog.md`, `git log --oneline -10`, read `current.simc`, query DB findings. Resume from Step 1.

### Iteration Loop

#### Step 1: Analyze

Read current APL. Form 1-3 causal theories with specific numbers. Then check screeners: `node src/sim/iterate.js hypotheses`. Use screener output to validate your theories, not replace them.

#### Step 2: Choose

Priority: your deep theories > unified hypotheses with `consensus_count > 1` > aligned screener findings > high-confidence on high-DPS-share abilities. **Never test a hypothesis you can't explain causally.**

If exhausted: `node src/sim/iterate.js strategic` and `theorycraft` -- but reason about the APL FIRST.

#### Step 3: Modify

Read `current.simc`. Make ONE targeted change. Save as `candidate.simc`. Before any change: locate the ability, understand its priority placement, trace resource/cooldown impact, check cross-references in all hero tree branches, predict direction and magnitude.

#### Step 4: Test

**Quick screening (synchronous, local):**

```bash
node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick
```

If quick screening rejects (any scenario > 1% regression), go to Step 5 (reject).

**Standard/confirm (always background, remote):**

```bash
/sim-background apls/{spec}/candidate.simc -- <hypothesis description>
/sim-background apls/{spec}/candidate.simc --confirm -- <hypothesis description>
```

**Immediately return to Step 1 for the next hypothesis.** Do not wait. Use `/sim-check` when it completes.

SimC failure: syntax error -> fix and retry. Timeout -> kill and reject. 3+ crashes -> stop loop.

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
7. If gains are suggestive but ambiguous: escalate the top-gaining subset to `--confirm` fidelity before concluding.

**Never reject based on mean-weighted alone.** Always examine per-build distribution.

```bash
node src/sim/iterate.js accept "reason" --hypothesis "description fragment"
node src/sim/iterate.js reject "reason" --hypothesis "description fragment"
```

#### Step 5b: Record

1. Record finding to DB via `addFinding()`
2. Update `plan.md`, `dashboard.md`
3. After accept: commit with `iterate: <hypothesis> (<+/-X.XX%> weighted)`

#### Step 6: Repeat

### Stop Conditions

- 3 consecutive rejections with no new hypotheses -> escape strategies (see PHASES.md)
- 10 consecutive rejections -> stop
- All categories + escape strategies exhausted -> stop
- Context approaching ~180k tokens -> checkpoint and suggest restart

### Context Window Management

- Use `iterate.js status` and `compare` for summaries, not full sim JSON
- Use `npm run data:query` for targeted spell/talent/interaction lookups
- Short reasons in accept/reject -- one sentence

---

## Phase 4: Final Report + Commit

Read `.claude/skills/optimize/PHASES.md` Phase 4 for full steps. Key sequence: re-rank builds -> audit branch coverage -> record findings -> `/showcase` -> summary -> `npm run remote:stop` -> commit.

## Checkpoint Protocol

On context limits or interruption, save to `results/{spec}/checkpoint.md`: current phase, hypothesis, per-build progress, templates analyzed, APL branches created, remaining work.

## Anti-Patterns

- **Single-build testing** -- ALWAYS test against the full roster
- **Specialists without theory** -- form root theories BEFORE launching specialists
- **Sequential specialists** -- ALWAYS launch all 4 in a SINGLE message
- **Flat APL for diverse builds** -- if builds differ, the APL MUST branch
- **Trusting screener output** -- observations are not insights; reason first
- **Grinding thresholds without theory** -- test values from mechanical reasoning, not sweeps
- **Ignoring per-build results** -- aggregate mean hides regressions; always check distribution
- **Rejecting partial gains** -- gate them instead; see Step 5 protocol
- **Writing results to memory** -- ALL findings go to `theorycraft.db`, never auto-memory
- **Reading full data files** -- use `npm run data:query` for targeted lookups
