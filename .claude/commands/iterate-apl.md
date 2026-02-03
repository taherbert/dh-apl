Autonomous APL iteration loop. Run without stopping until improvements are exhausted.

## Startup

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
- Both hero tree branches (anni/ar) should be updated if the change applies to both

### Step 4: Test (Tiered)

**Quick screen first:**
Run: `node src/sim/iterate.js compare apls/candidate.simc --quick`

- If any scenario regresses >1% → reject immediately (saves time)
- If all scenarios are within ±0.3% → inconclusive at this fidelity, escalate

**Standard test (if quick screen passes):**
Run: `node src/sim/iterate.js compare apls/candidate.simc`

- Read delta and statistical significance per scenario from stdout

**Confirm (if marginal):**
If any improvement is 0.1-0.3% and marked "not significant":
Run: `node src/sim/iterate.js compare apls/candidate.simc --confirm`

- High-iteration run to resolve the ambiguity

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

### Step 6: Repeat

Go to Step 1. Continue until:

- 3 consecutive rejections with no new hypotheses → try a different approach category
- 10 consecutive rejections → stop, summarize findings
- All hypothesis categories exhausted → stop, summarize findings

## On Completion

Print final summary:

- Starting DPS vs final DPS (all scenarios)
- Total iterations attempted / accepted / rejected
- Most impactful changes
- Remaining untested ideas
