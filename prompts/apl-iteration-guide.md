# APL Iteration Methodology Guide

Reference for the autonomous APL optimization loop (Phase 3 of `/optimize`). Complements `prompts/apl-analysis-guide.md` with iteration-specific strategy.

## 0. Error Audit — Before Optimizing, Fix What's Wrong

Before pursuing optimization hypotheses, audit the APL for logic errors. Fixing incorrect assumptions often yields larger gains than tuning correct-but-suboptimal logic, and optimization on top of broken logic is wasted work.

### What to look for

- **Stale hardcoded values.** Variables and conditions that assume fixed caps, thresholds, or counts that talents modify. Read `config.resources` for actual resource caps and check whether APL conditions reflect them. If a talent raises a resource cap or changes a proc rate, downstream conditions using the old values are suspect.
- **Missing talent interactions.** Conditions that don't gate on a talent that fundamentally changes the mechanic. If a talent doubles a proc chance, extends a duration, or adds a new resource source, the APL logic downstream of that mechanic needs to reflect it. Cross-reference `interactions-summary.json` for modifier sources.
- **Incorrect operator or comparison.** Off-by-one errors (`>=4` vs `>=5`), wrong boolean logic (`&` vs `|`), or inverted checks (`!buff.X.up` when `buff.X.up` was intended).
- **Dead or unreachable lines.** Actions whose conditions can never be true given the talent build, or that are shadowed by an earlier unconditional action that always fires first.

### Tracing downstream effects

A single corrected assumption can cascade. When you fix an error, trace outward:

1. **What variables reference the corrected value?** Update them.
2. **What thresholds change?** A higher resource cap means the old "full" threshold is no longer full — does this change DPGCD breakpoints?
3. **What target-count breakpoints shift?** More secondary resources per cycle means more AoE spender damage, which may lower the `active_enemies>=N` threshold.
4. **What resource flows change?** Extra secondary resources may mean more healing or more resource-free damage, shifting the primary resource economy.

Document each error and its downstream trace as a finding before making the fix. The fix itself may be one line, but the theory behind it should be thorough.

## 1. Mutation Taxonomy

Types of APL changes, ordered by risk/impact:

### Low Risk

- **Threshold sweep:** Vary numeric condition values (`resource>=N`, `secondary_resource>=N`, `active_enemies>=N`). Small, isolated, easy to measure.
- **Condition relaxation:** Remove or loosen a condition to allow more casts. E.g., drop a `&buff.X.up` guard.
- **Condition addition:** Add `active_enemies>=N`, `buff.X.up`, or resource guards to reduce waste casts.

### Medium Risk

- **Priority reorder:** Swap adjacent actions to test ordering sensitivity. Affects which action "wins" when both are available.
- **Action addition:** Add an underused ability to a list at a specific priority position.
- **Action removal:** Remove a low-value action that wastes GCDs.

### High Risk

- **Variable introduction:** Extract complex conditions into `variable,name=X,value=expr` for reuse. Changes evaluation semantics (computed once per evaluation vs inline).
- **List restructuring:** Move actions between sub-lists or change `run_action_list` conditions. Can cause cascading priority shifts.

### One Change Per Iteration

Always make ONE mutation per iteration. Compound changes make it impossible to attribute results. The only exception is when two changes are logically inseparable (e.g., adding an ability AND the condition that gates it).

## 2. Hypothesis-to-Mutation Mapping

How to translate hypothesis categories from `iterate.js` into specific APL edits:

| Hypothesis Category     | Mutation Strategy                                                        |
| ----------------------- | ------------------------------------------------------------------------ |
| `underused_ability`     | Move higher in priority list, or relax its conditions                    |
| `wasted_gcds`           | Add tighter conditions or remove the action entirely                     |
| `buff_uptime_gap`       | Prioritize the buff-applying ability higher, add pandemic-window refresh |
| `conditional_tightness` | Relax filler conditions, add fallback fillers at list bottom             |
| `aoe_mismatch`          | Add/adjust `active_enemies>=N` thresholds to the relevant actions        |
| `threshold_sweep`       | Create candidate with different numeric values, test each                |
| `cooldown_alignment`    | Add `buff.X.up` or `cooldown.X.remains<N` conditions to align burst      |

### Reading the APL for Edit Targets — Theory First

Before touching any ability, build a complete mental model of its role. Never skip this.

1. **Locate the ability.** Find it in `apls/current.simc` — note which action list it's in, its priority position, and every condition on the line.
2. **Understand why it's there.** Read the surrounding actions above and below. What does this ability compete with for GCDs? What fires instead if this condition fails? What would fire _less_ if this condition is loosened?
3. **Trace the resource/cooldown impact.** Does this ability generate or spend primary resource? Produce or consume secondary resource? Interact with a cooldown window? A change here ripples through the resource economy. Read `config.resourceFlow` and `config.buffWindows` for the spec's resource and burst mechanics.
4. **Check cross-references.** Search for `variable,name=` definitions and other action lines that reference the same buff, debuff, or resource threshold. A condition change on one line may conflict with assumptions elsewhere.
5. **Check all hero tree branches.** Read `config.heroTrees` for the spec's hero tree names. The APL may have separate action lists per hero tree (e.g., `actions.tree_a` and `actions.tree_b`). Changes to shared lists affect all builds.
6. **Form a theory.** State explicitly: "This change should improve X because Y, at the cost of Z." If you can't articulate the expected mechanism, you don't understand the change well enough to make it. Do more analysis before simulating.
7. **Predict the direction.** Before running the sim, predict whether the change will be positive, negative, or neutral — and roughly by how much. After results come back, compare against your prediction. Wrong predictions mean your model of the APL is incomplete; update it before the next iteration.

## 3. Avoiding Local Optima

When improvements plateau (3+ consecutive rejections):

### Escape Strategies

1. **Compound mutation:** Try two changes that individually regressed but might synergize. E.g., lowering a threshold AND adding a new condition.

2. **Reversal test:** Reverse a previously accepted change to see if later changes made it obsolete. The accept history in iteration state tracks all changes.

3. **Radical reorder:** Swap the top 3-5 priority actions in a sub-list. Large perturbation to escape local optima.

4. **Reference import:** Compare against the simc default APL in `reference/`. If it handles something differently, try that approach.

5. **Category rotation:** If threshold sweeps are exhausted, switch to priority reordering. If reordering is exhausted, try condition changes. Cycle through mutation types.

### When to Stop

- 10 consecutive rejections with no new hypothesis categories to try
- All hypotheses exhausted and escape strategies tried
- Remaining hypotheses are all defensive/survivability (skip for DPS optimization)

## 4. Statistical Confidence

### SimC Statistics

SimC reports `mean_stddev` (standard error of the mean) directly in profileset output when available. This is more precise than computing `stddev / sqrt(iterations)` manually, since simc accounts for autocorrelation.

A delta is **statistically significant** when:

```
|delta| > 2 * stderr  (approximately 95% confidence)
```

### target_error and Adaptive Iteration Counts

Instead of fixed iteration counts, comparison runs use `target_error` to let simc converge naturally. Lower target_error = more iterations = tighter confidence intervals:

| Tier     | target_error | Typical StdErr | Detectable Delta |
| -------- | ------------ | -------------- | ---------------- |
| Quick    | 1.0          | ~0.5%          | >1.0%            |
| Standard | 0.3          | ~0.15%         | >0.3%            |
| Confirm  | 0.1          | ~0.05%         | >0.1%            |

### Tiered Testing Strategy

1. **Quick screen** (`--quick`, target_error=1.0): Reject obvious losers fast. Never accept based on quick alone.
2. **Standard** (default, target_error=0.3): Normal comparison. Sufficient for >0.3% deltas.
3. **Confirm** (`--confirm`, target_error=0.1): Only for marginal changes where standard is inconclusive.

### When Scenarios Disagree

If one scenario improves and another regresses:

- Escalate both to `--confirm` for higher confidence
- Use the weighted score (from config.json scenario weights) for the final decision
- A significant regression in ST is harder to accept than in heavy AoE

### Profileset Advantage

Profileset mode uses shared RNG seeds for paired comparison. This reduces variance compared to independent runs, making smaller deltas detectable at the same iteration count.

## 5. Context Window Management

Keep iterations lean to maximize the number of iterations per session:

- **Don't read full sim JSON** — use `iterate.js status` and `iterate.js compare` for summaries
- **Don't re-read guides every iteration** — read `apl-iteration-guide.md` and `apl-analysis-guide.md` once at startup
- **Save analysis to iteration log** — put reasoning in the accept/reject reason string so future sessions can read state
- **Minimize file reads** — only read `apls/current.simc` when you need to edit it, not every iteration
- **Use short reasons** — iteration log reasons should be one sentence summarizing the change and result

## 6. Resilience Patterns

### State Recovery

The iteration state uses atomic writes with rotating backups (5 kept). If the primary state file is corrupted:

1. `loadState()` catches JSON parse errors automatically
2. Scans `results/iteration-state.backup.*.json` in reverse chronological order
3. Restores the most recent valid backup as the primary state
4. Resumes operation transparently

If backups are also corrupted, re-initialize from `apls/current.simc` — the APL itself is the most important artifact, and git history preserves all accepted changes.

### Git Integration

Each accepted change should be committed immediately. This provides:

- **Recovery**: If state is lost, reconstruct iteration history from git log
- **Bisection**: If a later change causes issues, `git bisect` can find the culprit
- **Rollback**: Revert to any previous accepted state with `git checkout`

Commit message format: `iterate: <hypothesis summary> (<+/-X.XX%> weighted)`

### SimC Failure Taxonomy

| Failure Type     | Symptoms                                | Action                                       |
| ---------------- | --------------------------------------- | -------------------------------------------- |
| APL syntax error | SimC exits immediately with parse error | Fix candidate APL, retry                     |
| Missing ability  | "action not found" in SimC output       | Check talent requirements, reject hypothesis |
| Timeout          | No output after 10+ minutes             | Kill process, reject hypothesis              |
| Segfault/crash   | SimC exits with signal                  | Retry once; if repeated, stop loop           |
| JSON parse error | SimC output isn't valid JSON            | Check SimC binary version, retry             |

### Resource Constraints

- **Disk**: Each comparison produces ~1MB of JSON. Clean old comparison files periodically.
- **CPU**: Comparisons run scenarios in parallel using all cores. One comparison at a time.
- **Memory**: SimC profileset mode is memory-efficient. No special handling needed.

## 7. Parallelism Techniques

### Quick-Screen Batching

When multiple hypotheses exist in the same category (e.g., 5 threshold sweeps):

1. Generate 2-3 candidate APLs, each testing a different variant
2. Launch subagents to run `--quick` comparisons in parallel
3. Collect results, discard clear losers (any scenario regresses >1%)
4. Promote the best candidate to standard-fidelity testing
5. Accept or reject based on standard results

This is 2-3x faster than testing sequentially when hypotheses are independent.

### Hypothesis Grouping

Group hypotheses by independence:

- **Independent**: Different abilities, different action lists -> safe to batch
- **Dependent**: Same ability, same conditions -> must test sequentially (results interact)
- **Conflicting**: Opposite mutations (e.g., "move X higher" vs "remove X") -> pick one

### Subagent Delegation

For quick-screen batching, delegate to subagents with clear instructions:

1. Read `apls/current.simc`
2. Make the specified modification
3. Save as `apls/candidate_N.simc`
4. Run `node src/sim/iterate.js compare apls/candidate_N.simc --quick`
5. Report: hypothesis, weighted delta, any significant results

The main agent then decides which candidate (if any) to promote.
