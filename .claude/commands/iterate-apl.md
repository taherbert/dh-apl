Autonomous APL iteration loop. Run without stopping until improvements are exhausted.

## Session Resilience

Before starting, validate the environment:

1. Run `node src/sim/iterate.js status` to check state
2. If state is corrupted, it will auto-recover from backups — check stderr for recovery messages
3. Run `git status` — ensure clean working tree on the correct branch
4. If no state exists: `node src/sim/iterate.js init apls/baseline.simc`

### Warm Restart

If resuming from a crash or new session:

1. Run `node src/sim/iterate.js status` — shows current progress and consecutive rejections
2. Read `results/dashboard.md` for a quick overview
3. Read `results/changelog.md` to understand what was already accepted
4. Check `git log --oneline -10` for recent commits (each accept should have a commit)
5. Read `apls/current.simc` as the working APL
6. Read `prompts/apl-iteration-guide.md` for methodology (only on first startup, not every iteration)
7. Resume the iteration loop from Step 1

## Startup (Fresh Session)

1. Run `node src/sim/iterate.js status` to check state
2. If no state exists: `node src/sim/iterate.js init apls/baseline.simc`
3. Read `prompts/apl-iteration-guide.md` for methodology
4. Read `apls/current.simc` as the working APL

## Iteration Loop

Repeat until no hypotheses remain or improvements plateau:

### Step 1: Assess

- Run `node src/sim/iterate.js status`
- Run `node src/sim/iterate.js hypotheses`
- Review pending hypotheses and recent iteration history
- Check consecutive rejection count from status output

### Step 2: Choose

Pick the highest-value hypothesis to test. Prioritize:

1. High-confidence hypotheses first
2. Hypotheses affecting abilities with large DPS share
3. Novel approaches not yet tried (check exhausted list)

If all hypotheses are exhausted, generate new ones:

- Threshold sweeps on key conditions
- Priority reordering experiments
- Cross-scenario condition additions
- Variable-based hold pattern experiments

### Step 3: Modify

- Read `apls/current.simc`
- Make ONE targeted change based on the chosen hypothesis
- Save as `apls/candidate.simc`
- Describe the mutation clearly (for the iteration log)

Rules:

- One change per iteration (isolate variables)
- Preserve round-trip fidelity (use parser when possible)
- Don't modify profile/gear lines — APL only
- The current baseline uses AR talents — only `actions.ar` is active. Changes to shared lists (precombat, default, externals) affect both hero trees. To optimize Annihilator, a separate baseline with Annihilator talents is needed.

### Step 4: Test (Tiered)

**Quick screen first:**
Run: `node src/sim/iterate.js compare apls/candidate.simc --quick`

- If any scenario regresses >1% → reject immediately (saves time)
- If all scenarios are within +/-0.3% → inconclusive at this fidelity, escalate

**Standard test (if quick screen passes):**
Run: `node src/sim/iterate.js compare apls/candidate.simc`

- Read delta and statistical significance per scenario from stdout

**Confirm (if marginal):**
If any improvement is 0.1-0.3% and marked "not significant":
Run: `node src/sim/iterate.js compare apls/candidate.simc --confirm`

- High-iteration run to resolve the ambiguity

#### SimC Failure Handling

- **Syntax error** (SimC exits with error about APL parsing): Fix the candidate APL and re-run. Do not reject — this is an authoring error, not a hypothesis failure.
- **Timeout** (SimC runs >10 minutes with no output): Kill and reject the hypothesis. Something is causing infinite loops or extreme iteration counts.
- **Repeated SimC failures** (3+ consecutive SimC crashes/errors): Stop the iteration loop. Report the error and save state. There may be a binary or system issue.

### Step 5: Decide

**Accept if:**

- At least one scenario shows a **statistically significant** improvement (delta > 2x stderr)
- AND no scenario has a statistically significant regression >0.3%
- OR total weighted improvement is positive AND significant (weight: 50% ST, 30% 5T, 20% 10T)

**Reject if:**

- No statistically significant improvement in any scenario
- Any scenario has a significant regression without compensating significant gains
- Quick screen shows clear regression (>1%)

**Inconclusive** (neither accept nor reject):

- If results are within noise after `--confirm`, log as "inconclusive" and move on
- Don't count inconclusive results against the consecutive-rejection counter

Run: `node src/sim/iterate.js accept "reason" --hypothesis "description fragment"` or `reject "reason" --hypothesis "description fragment"` or `reject "inconclusive — within noise" --hypothesis "description fragment"`

The `--hypothesis` flag matches the hypothesis being tested by description substring. This ensures correct attribution instead of blindly popping the first pending hypothesis.

### Step 5b: Git Commit After Accept

After every successful `accept`, commit the updated APL:

```bash
git add apls/current.simc results/iteration-state.json results/dashboard.md results/changelog.md results/findings.md
git commit -m "iterate: <hypothesis summary> (<+/-X.XX%> weighted)"
```

Include the hypothesis description and weighted DPS impact in the commit message. This creates a recoverable history of every accepted change.

### Step 6: Repeat

Go to Step 1. Continue until stopped by one of the conditions below.

## Parallelism Strategy

When multiple hypotheses in the same category are available (e.g., several threshold sweeps):

1. Use subagents to quick-screen 2-3 candidates simultaneously
2. Each subagent: modify APL, run `--quick` comparison, report results
3. Promote the best-performing candidate to standard fidelity test
4. This is optional — sequential iteration is fine for most cases

## Stop Conditions

Use the `consecutiveRejections` counter from `iterate.js status` (tracked in state automatically):

- **3 consecutive rejections** with no new hypotheses → try escape strategies from the iteration guide (compound mutations, reversals, radical reorder)
- **10 consecutive rejections** → stop, run `node src/sim/iterate.js summary`
- **All hypothesis categories exhausted** AND escape strategies tried → stop
- **SimC repeated failures** (3+ crashes) → stop and report

### Context Window Management

- Stop at ~180k tokens of context usage. Save state and suggest restarting with `/iterate-apl`
- Don't read full sim JSON — use `iterate.js status` and `iterate.js compare` for summaries
- Don't re-read guides every iteration — read once at startup
- Use short reasons in accept/reject — one sentence per iteration

## On Completion

1. Run `node src/sim/iterate.js summary` — generates all reports
2. Commit final state:
   ```bash
   git add apls/current.simc results/
   git commit -m "iterate: final — N iterations, M accepted, +X.XX% weighted DPS"
   ```
3. Print summary:
   - Starting DPS vs final DPS (all scenarios)
   - Total iterations attempted / accepted / rejected
   - Most impactful changes
   - Remaining untested ideas
