Walk through the active spec's APL and explain it — what every line does, why it's there, and how the pieces fit together as a rotation.

This is a comprehension tool, not an optimization tool. Use it to understand the current APL before trying to improve it with `/full-analysis`, `/theorycraft`, or `/optimize`.

## Setup

1. Run `node src/engine/startup.js` to determine the active spec. Use the spec name for all `{spec}` path references below.

2. Read the APL to explain. Use `$ARGUMENTS` if provided, else `apls/{spec}/{spec}.simc`, else `apls/{spec}/baseline.simc`.

3. **Load the knowledge base per `prompts/apl-analysis-guide.md` Section 0.** For comprehension, Tier 1 (spec adapter, spells) and Tier 2 (interactions, proc mechanics) are essential. Tier 3 (findings, builds) provides calibration context.

4. Check for recent sim results (`ls results/{spec}/`) — cast count data grounds the explanation in what actually happens vs what the APL intends.

## Walkthrough

### Structure Overview

Start with the big picture:

- What action lists exist? (default, hero tree branches, cooldowns, etc.)
- How does control flow between them? (run_action_list vs call_action_list)
- What's the overall architecture — flat priority, branching by hero tree, phase-based?

### Variable Definitions

Walk through every `variable,name=X` definition:

- What state does this variable capture?
- Where is it used? (Grep for `variable.X` in the APL)
- Is the computation correct given the current talent build? (Check for stale hardcoded values, wrong thresholds, missing talent gates)

### Action-by-Action Walkthrough

For each action list, walk through every line:

- **What it does:** ability name, resource cost, key effect
- **When it fires:** explain the `if=` condition in plain English
- **Why it's here at this priority:** what would go wrong if it were higher or lower?
- **Resource impact:** how does casting this affect resources, cooldowns, and buff states?

Flag anything that looks suspicious:

- Dead lines (conditions that can never be true given the talent build)
- Stale values (hardcoded numbers that don't account for current talents)
- Missing guards (abilities cast without checking important state)
- Ordering anomalies (a higher-value ability below a lower-value one without justification)

### Rotation Narrative

After the line-by-line, synthesize:

- What does a typical ST rotation cycle look like? (Describe 15-20 seconds of play)
- What changes in AoE? (Which conditionals activate at 3+ targets?)
- What happens during burst windows? Does the APL shift behavior?
- What's the "feel" of the rotation — GCD-locked, resource-gated, cooldown-paced?

## Output

### Structure Diagram

```
default → [precombat] → [externals] → hero tree branch
  ├── branch_a → [cooldowns] → [core priority]
  └── branch_b → [cooldowns] → [core priority]
```

### Variable Reference Table

| Variable | Purpose | Used In |
| -------- | ------- | ------- |

### Annotated APL

The full APL with inline comments explaining each line.

### Issues Found

Any dead lines, stale values, missing guards, or ordering anomalies flagged during the walkthrough.

### Suggested Next Steps

Based on what was found:

- If issues were found → "Fix these before optimizing: ..."
- If the APL looks sound → "Ready for `/full-analysis` or `/optimize`"
- If comprehension revealed questions → "These need investigation: ..."
