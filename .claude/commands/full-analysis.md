Run a comprehensive APL analysis and iteration session. Execute all phases autonomously.

## Phase 1: Establish Baseline

1. Run `node src/sim/iterate.js init apls/baseline.simc` to initialize fresh iteration state
2. Run `node src/sim/runner.js apls/baseline.simc` to get current numbers across all scenarios
3. Read the sim results — record ST, 3T, 10T DPS as reference points

If `$ARGUMENTS` was provided, use that file instead of `apls/baseline.simc`.

## Phase 2: Full Analysis Sweep

Run ALL analysis engines against the baseline and current sim results. Launch independent analyses in parallel where possible.

### 2a. Error Audit

Read `prompts/apl-iteration-guide.md` section 0 ("Error Audit"). Read the APL, `data/spells.json`, `data/cpp-proc-mechanics.json`, and `data/interactions.json`. Audit the APL for:

- Stale hardcoded values (caps, thresholds, counts that talents modify)
- Missing talent interactions (conditions that don't gate on a talent that changes the mechanic)
- Incorrect operators or comparisons (off-by-one, wrong boolean logic, inverted checks)
- Dead or unreachable lines (conditions that can never be true, or shadowed by earlier unconditional actions)

Trace downstream effects of any errors found. Errors before optimization — always.

### 2b. Strategic Hypotheses

Run `node src/sim/iterate.js strategic` to generate archetype-aware hypotheses with auto-mutations.

### 2c. Temporal Hypotheses

Run `node src/sim/iterate.js theorycraft` to generate resource flow and cooldown cycle hypotheses.

### 2d. Manual APL Review

Read through the APL line by line. For each action and variable, verify the condition logic against `data/spells.json` (cooldowns, costs, coefficients) and `data/cpp-proc-mechanics.json` (proc rates, ICDs, fragment caps). Note any condition that encodes an assumption you can't verify, or that doesn't account for the current talent build.

## Phase 3: Triage and Rank

Merge all findings into a single ranked list:

1. **Errors first** — Any logic bug or stale assumption is higher priority than any optimization
2. **High-confidence optimizations** — Cross-reference against known validated results from the theorycraft skill (Fracture overflow guard +10.4%, Meta-priority Fracture +5.2%, Brand-first ordering +0.6%, Spite guard relaxation +0.3%)
3. **Novel hypotheses** — New ideas from strategic and temporal engines that haven't been tested
4. **Speculative ideas** — Lower-confidence hypotheses worth a quick screen

Print the ranked list before proceeding. Wait for user confirmation before entering the iteration loop.

## Phase 4: Iterate

Work through the ranked list using the `/iterate-apl` methodology:

- One change per iteration
- Quick screen first (`--quick`), escalate to standard if promising, `--confirm` if marginal
- Accept/reject with clear reasoning and `--hypothesis` attribution
- Git commit after each accept
- If 3 consecutive rejections with no new ideas, try compound mutations or reversals
- If 10 consecutive rejections, stop and summarize

## Phase 5: Report

When iteration plateaus or exhausts hypotheses:

1. Run `node src/sim/iterate.js summary`
2. Print: starting DPS vs final DPS (all scenarios), total iterations, most impactful changes
3. List remaining untested ideas for future sessions
4. Commit final state
