# APL Iteration Methodology Guide

Reference for the autonomous APL optimization loop (`/iterate-apl`). Complements `prompts/apl-analysis-guide.md` with iteration-specific strategy.

## 1. Mutation Taxonomy

Types of APL changes, ordered by risk/impact:

### Low Risk

- **Threshold sweep:** Vary numeric condition values (`fury>=N`, `soul_fragments>=N`, `active_enemies>=N`). Small, isolated, easy to measure.
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

### Reading the APL for Edit Targets

1. Identify the ability from the hypothesis
2. Find it in `apls/current.simc` — note which action list it's in and its position
3. Read surrounding actions to understand priority context
4. Check both hero tree branches (actions.ar._ and actions.anni._) if the ability appears in both

## 3. Avoiding Local Optima

When improvements plateau (3+ consecutive rejections):

### Escape Strategies

1. **Compound mutation:** Try two changes that individually regressed but might synergize. E.g., lowering a threshold AND adding a new condition.

2. **Reversal test:** Reverse a previously accepted change to see if later changes made it obsolete. The accept history in iteration state tracks all changes.

3. **Radical reorder:** Swap the top 3-5 priority actions in a sub-list. Large perturbation to escape local optima.

4. **Reference import:** Compare against `reference/vengeance-apl.simc` (the simc default APL). If it handles something differently, try that approach.

5. **Category rotation:** If threshold sweeps are exhausted, switch to priority reordering. If reordering is exhausted, try condition changes. Cycle through mutation types.

### When to Stop

- 10 consecutive rejections with no new hypothesis categories to try
- All hypotheses exhausted and escape strategies tried
- Remaining hypotheses are all defensive/survivability (skip for DPS optimization)

## 4. Statistical Confidence

### SimC Statistics

SimC reports `mean_stddev` (standard error of the mean) directly in profileset output when available. This is more precise than computing `stddev / sqrt(iterations)` manually, since simc accounts for autocorrelation. The comparison code uses `mean_stddev` when present and falls back to the manual computation.

A delta is **statistically significant** when:

```
|delta| > 2 × stderr  (≈95% confidence)
```

### target_error and Adaptive Iteration Counts

Instead of fixed iteration counts, comparison runs use `target_error` to let simc converge naturally. Lower target_error = more iterations = tighter confidence intervals:

| Tier     | target_error | Typical StdErr | Detectable Delta |
| -------- | ------------ | -------------- | ---------------- |
| Quick    | 1.0          | ~0.5%          | >1.0%            |
| Standard | 0.3          | ~0.15%         | >0.3%            |
| Confirm  | 0.1          | ~0.05%         | >0.1%            |

This is faster than fixed iterations for easy-to-converge scenarios and uses more iterations only when variance is high.

### Tiered Testing Strategy

1. **Quick screen** (`--quick`, target_error=1.0): Reject obvious losers fast. Never accept based on quick alone.
2. **Standard** (default, target_error=0.3): Normal comparison. Sufficient for >0.3% deltas.
3. **Confirm** (`--confirm`, target_error=0.1): Only for marginal changes where standard is inconclusive.

### When Scenarios Disagree

If one scenario improves and another regresses:

- Escalate both to `--confirm` for higher confidence
- Use the weighted score (50% ST, 30% 5T, 20% 10T) for the final decision
- A significant regression in ST is harder to accept than in 10T

### Profileset Advantage

Profileset mode uses shared RNG seeds for paired comparison. This reduces variance compared to independent runs, making smaller deltas detectable at the same iteration count.

## 5. Context Window Management

Keep iterations lean to maximize the number of iterations per session:

- **Don't read full sim JSON** — use `iterate.js status` and `iterate.js compare` for summaries
- **Don't re-read guides every iteration** — read `apl-iteration-guide.md` and `apl-analysis-guide.md` once at startup
- **Save analysis to iteration log** — put reasoning in the accept/reject reason string so future sessions can read state
- **Minimize file reads** — only read `apls/current.simc` when you need to edit it, not every iteration
- **Use short reasons** — iteration log reasons should be one sentence summarizing the change and result
