# APL Iteration Methodology

Internal reference for the iteration loop within `/optimize`. Not a user-facing command.

## Build Roster — REQUIRED BEFORE ITERATION

**Every iteration session MUST test against ALL archetypes.** The APL is shared by all talent builds. A change that helps one archetype but hurts another is a regression, not an improvement.

Before starting any iteration loop:

1. **Verify roster:** `npm run roster show`
   - The roster is persistent at `data/{spec}/build-roster.json` (version-controlled)
   - Must include builds from BOTH hero trees
   - Must cover all archetypes from `data/{spec}/build-theory.json`
   - If roster is empty: run `npm run roster migrate` to populate from existing data
   - If builds.json is stale/missing: re-run `npm run discover -- --ar-only --quick` (auto-imports to roster)
   - To add builds manually: `npm run roster import-doe`, `npm run roster import-multi-build`
   - To generate hashes for override-only builds: `npm run roster generate-hashes` (enables profileset mode)
2. `iterate.js init` requires the roster and runs multi-build baseline
   - Profileset mode (constant 2-actor memory) auto-activates when all builds have hashes
   - Falls back to batched multi-actor mode otherwise (batch sizes: quick=12, standard=8, confirm=4)
3. All subsequent `iterate.js compare` calls test against ALL roster builds simultaneously
   - Use `--batch-size N` to override the fidelity-based default batch size

**iterate.js refuses to run without a populated roster.** Single-build mode is not supported.

## Session Resilience

Before starting, validate the environment:

1. Run `node src/sim/iterate.js status` to check state
2. If state is corrupted, it will auto-recover from backups — check stderr for recovery messages
3. Run `git status` — ensure clean working tree on the correct branch
4. If no state exists: `node src/sim/iterate.js init apls/{spec}/baseline.simc`

### Warm Restart

If resuming from a crash or new session:

1. Run `node src/sim/iterate.js status` — shows current progress and consecutive rejections
2. Read `results/{spec}/dashboard.md` for a quick overview
3. Read `results/{spec}/changelog.md` to understand what was already accepted
4. Check `git log --oneline -10` for recent commits (each accept should have a commit)
5. Read `apls/{spec}/current.simc` as the working APL
6. Read `prompts/apl-iteration-guide.md` for methodology (only on first startup, not every iteration)
7. Read `results/{spec}/findings.json` — filter to `status: "validated"` to calibrate against known results
8. Resume the iteration loop from Step 1

## Iteration Loop

Repeat until no hypotheses remain or improvements plateau:

### Step 1: Deep Analysis (REQUIRED — do this BEFORE touching hypotheses)

Read the current APL and reason about the mechanical system using ALL available data. This is not optional — every iteration cycle must start from understanding, not from a hypothesis queue.

**Load the full knowledge base per `prompts/apl-analysis-guide.md` Section 0.** That section is the single canonical list of data sources — all tiers (mechanical blueprint, interaction/proc data, accumulated knowledge, external references).

**Reason about the system:**

- Where do resources come from and go? Are any being wasted or over-pooled?
- What cooldown cycles exist? Are abilities aligned or fighting for the same windows?
- What talent interactions create non-obvious dependencies? (Trace chains through `interactions-summary.json`)
- What proc mechanics create hidden value? (Use `cpp-proc-mechanics.json` for ICDs and rates)
- What state machine transitions does the hero tree impose, and does the APL respect them?
- What assumptions in conditions might be wrong for certain builds or target counts?

**Form 1-3 causal theories** — "X should improve Y because Z" — grounded in mechanical reasoning with specific numbers from the data files. A theory without numbers from spell data is speculation.

Only AFTER forming your own theories, check what the automated screeners found:

- Run `node src/sim/iterate.js status` and `node src/sim/iterate.js hypotheses`
- Use screener output to _validate_ or _quantify_ your theories, not to replace them
- A screener hypothesis that aligns with your deep theory gets priority
- A screener hypothesis with no causal backing gets deprioritized

### Step 2: Choose

Pick the highest-value hypothesis to test. Prioritize:

1. **Your own deep theories** — backed by causal reasoning about the mechanical system. A theory you formed by reading the APL and understanding resource flows always outranks a screener observation.
2. **Screener hypotheses that align with deep theories** — automated observations that confirm or quantify something you already reasoned about.
3. High-confidence hypotheses affecting abilities with large DPS share, but only if you understand WHY the change should help.
4. Multi-part hypotheses — a coherent set of interdependent APL changes that implement one conceptual idea. These test as a single iteration if the components can't be evaluated independently.

**Never test a hypothesis you can't explain causally.** If a screener says "buff uptime is low," you must reason about WHY before acting — is it a priority issue, a GCD competition issue, a talent dependency? The cause determines the fix.

If all hypotheses are exhausted, generate new ones:

- Run the analytical engines: `node src/sim/iterate.js strategic` and `node src/sim/iterate.js theorycraft`
- But FIRST re-read the APL and think about what's left to improve — use the engines to validate your thinking, not to think for you
- Resource economy rebalancing (fury/fragment equilibrium shifts)
- Cooldown alignment changes (stagger vs group)
- Burst window utilization improvements
- Cross-scenario condition additions

### Step 3: Modify

- Read `apls/{spec}/current.simc`
- Make ONE targeted change based on the chosen hypothesis
- Save as `apls/{spec}/candidate.simc`
- Describe the mutation clearly (for the iteration log)

Rules:

- One change per iteration (isolate variables)
- Preserve round-trip fidelity (use parser when possible)
- Don't modify profile/gear lines — APL only. The profile lives in `apls/{spec}/profile.simc` (included via `input=`). Only edit action lines.
- The APL may contain hero tree branches (e.g., `run_action_list,name=<branch>,if=hero_tree.<name>`). Changes to shared lists (precombat, default, externals) affect all hero trees. Changes within a hero-tree-specific sub-list only affect that branch. Check which hero tree branch is active for the current baseline talents before modifying hero-tree-specific lists.

Structural mutations (beyond condition tweaks) are valid:

- **Extract sub-list with `call_action_list`:** Factor shared logic into a sub-list (e.g., `actions.cooldowns`, `actions.aoe`). Use `call_action_list` — it evaluates inline and falls through if nothing fires, so the caller continues normally.
- **AoE/ST split:** Add `call_action_list,name=aoe,if=spell_targets.X>=N` before ST priority. This is a structural change but still one logical mutation.
- **Reordering:** Moving an action line up/down is a valid single mutation.
- **Adding action lines:** New lines count as one mutation if they serve one hypothesis.
- Do NOT use `run_action_list` for sub-routines that should fall through — use `call_action_list`. Reserve `run_action_list` for mutually exclusive branches only.

### Step 4: Test (Tiered)

**Quick screen first:**
Run: `node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick`

- If any scenario regresses >1% → reject immediately (saves time)
- If all scenarios are within +/-0.3% → inconclusive at this fidelity, escalate

**Standard test (if quick screen passes):**
Run: `node src/sim/iterate.js compare apls/{spec}/candidate.simc`

- Read delta and statistical significance per scenario from stdout

**Confirm (if marginal):**
If any improvement is 0.1-0.3% and marked "not significant":
Run: `node src/sim/iterate.js compare apls/{spec}/candidate.simc --confirm`

- High-iteration run to resolve the ambiguity

#### SimC Failure Handling

- **Syntax error** (SimC exits with error about APL parsing): Fix the candidate APL and re-run. Do not reject — this is an authoring error, not a hypothesis failure.
- **Timeout** (SimC runs >10 minutes with no output): Kill and reject the hypothesis. Something is causing infinite loops or extreme iteration counts.
- **Repeated SimC failures** (3+ consecutive SimC crashes/errors): Stop the iteration loop. Report the error and save state. There may be a binary or system issue.

### Step 5: Decide

**Multi-build decision criteria:**

- **Accept if:** mean weighted delta > 0 AND worst build weighted delta > -1%
- **Reject if:** mean weighted ≤ 0, OR any build regresses > 1% weighted
- **Archetype-gate if:** change helps some archetypes (>+0.1%) but hurts others (>-0.3%)
  - Create a sub-action-list gated by talent or hero tree check
  - Re-test the gated version against the FULL roster
  - Accept only when gated version is neutral-or-positive for ALL builds

**Reject if:**

- No statistically significant improvement across builds
- Any build/scenario has a significant regression without compensating significant gains
- Quick screen shows clear regression (>1%)

**Inconclusive** (neither accept nor reject):

- If results are within noise after `--confirm`, log as "inconclusive" and move on
- Don't count inconclusive results against the consecutive-rejection counter

Run: `node src/sim/iterate.js accept "reason" --hypothesis "description fragment"` or `reject "reason" --hypothesis "description fragment"` or `reject "inconclusive — within noise" --hypothesis "description fragment"`

The `--hypothesis` flag matches the hypothesis being tested by description substring. This ensures correct attribution instead of blindly popping the first pending hypothesis.

### Step 5b: Record Findings and Commit

After every accept or reject, record findings:

1. **Append to `results/{spec}/findings.json`:** Add a new finding entry with the insight, evidence (DPS delta numbers), confidence, tags, and `status: "validated"` (if accepted) or `status: "rejected"` (if rejected). Use the tag taxonomy from `results/{spec}/SCHEMA.md`.

After every successful `accept`, commit:

```bash
git add apls/{spec}/current.simc results/{spec}/iteration-state.json results/{spec}/dashboard.md results/{spec}/changelog.md results/{spec}/findings.json
git commit -m "iterate: <hypothesis summary> (<+/-X.XX%> weighted)"
```

Include the hypothesis description and weighted DPS impact in the commit message. This creates a recoverable history of every accepted change.

### Step 6: Repeat

Go to Step 1. Continue until stopped by one of the conditions below.

## Parallelism Strategy

When multiple independent hypotheses are available (e.g., several threshold sweeps or condition variants):

1. Launch 2-3 subagents using the Task tool, each working on a different hypothesis
2. Each subagent: modify `apls/{spec}/current.simc` into a unique candidate file, run `node src/sim/iterate.js compare <candidate> --quick`, and report the per-scenario deltas
3. Collect results from all subagents and promote the best-performing candidate to standard fidelity test
4. This is optional — sequential iteration is fine for most cases. Use parallelism when the hypothesis queue is deep and candidates are independent.

## Human-Reviewable Outputs

The iteration loop maintains human-readable state files that are updated continuously:

- **`results/{spec}/dashboard.md`** — Updated after every accept/reject. Shows current DPS, iteration count, and recent changes at a glance.
- **`results/{spec}/changelog.md`** — Logs every accepted change with DPS impact. Append-only history of what worked.
- **`results/{spec}/findings.json`** — Records insights (validated, rejected, inconclusive) with evidence and tags. Persists across sessions.

## Stop Conditions

Use the `consecutiveRejections` counter from `iterate.js status` (tracked in state automatically):

- **3 consecutive rejections** with no new hypotheses → try escape strategies from the iteration guide (compound mutations, reversals, radical reorder)
- **10 consecutive rejections** → stop, run `node src/sim/iterate.js summary`
- **All hypothesis categories exhausted** AND escape strategies tried → stop
- **SimC repeated failures** (3+ crashes) → stop and report

### Context Window Management

- Stop at ~180k tokens of context usage. Save state and suggest restarting with `/optimize`
- Don't read full sim JSON — use `iterate.js status` and `iterate.js compare` for summaries
- Don't re-read guides every iteration — read once at startup
- Use short reasons in accept/reject — one sentence per iteration

## On Completion

1. Run `node src/sim/iterate.js summary` — generates all reports
2. Commit final state:
   ```bash
   git add apls/{spec}/current.simc results/{spec}/
   git commit -m "iterate: final — N iterations, M accepted, +X.XX% weighted DPS"
   ```
3. Print summary:
   - Starting DPS vs final DPS (all scenarios)
   - Total iterations attempted / accepted / rejected
   - Most impactful changes
   - Remaining untested ideas
