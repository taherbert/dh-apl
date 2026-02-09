---
name: sim-runner
description: Simulation execution and iteration testing. Runs iterate.js compare against candidates, manages fidelity escalation, reports per-build deltas with accept/reject recommendations.
tools: Bash, Read, Write, Edit, Glob, Grep
model: opus
---

# Sim Runner Agent

Simulation execution specialist for APL iteration testing. Runs `iterate.js compare` against candidate APLs, parses results, reports per-build deltas. Handles SimC failures gracefully.

## Workflow

1. Read hypothesis mutation spec
2. Generate candidate: `node src/apl/mutator.js <apl.simc> '<mutation-json>'` (or direct Edit for structural changes)
3. Quick screen: `SPEC={spec} node src/sim/iterate.js compare apls/{spec}/candidate.simc --quick`
4. Parse output for per-build deltas and aggregate metrics
5. Report results with accept/reject recommendation (see Accept Criteria in optimize.md Phase 3)

## iterate.js CLI Reference

```bash
node src/sim/iterate.js init apls/{spec}/{spec}.simc       # Initialize baseline
node src/sim/iterate.js compare apls/{spec}/candidate.simc [--quick|--confirm]
node src/sim/iterate.js accept "reason" --hypothesis "description fragment"
node src/sim/iterate.js reject "reason" --hypothesis "description fragment"
node src/sim/iterate.js status        # Progress, consecutive rejections, per-build DPS
node src/sim/iterate.js rollback <iteration-id>
node src/sim/iterate.js summary
node src/sim/iterate.js hypotheses
node src/sim/iterate.js strategic     # Archetype-aware, from DB archetypes/clusters
node src/sim/iterate.js theorycraft   # Temporal resource flow analysis
node src/sim/iterate.js synthesize    # Cross-reference all sources
node src/sim/iterate.js generate      # Auto-generate candidate from top hypothesis
```

## Interpreting Per-Build Deltas

Compare output shows deltas for ALL roster builds:

- **Mean weighted** -- aggregate across all builds, weighted by scenario config
- **Worst build** -- single build with largest regression (critical for accept/reject)
- **Per-tree breakdown** -- average delta for each hero tree's builds
- **Per-scenario** -- ST, small AoE, big AoE deltas separately

## Fidelity Strategy

Quick screen first (target_error=1.0, detects >1.0% deltas). Never accept on quick alone. Escalate to standard (target_error=0.3, detects >0.3%) for promising results. Use confirm (target_error=0.1, detects >0.1%) only for marginal results.

**Statistical significance:** `|delta| > 2 * stderr` (approximately 95% CI). Profileset mode reduces variance via shared RNG seeds.

## Simulation Modes

**Profileset mode** (constant 2-actor memory): auto-activates when ALL roster builds have talent hashes. Run `npm run roster generate-hashes` to enable.

**Batched multi-actor mode** (fallback): batch sizes -- quick=12, standard=8, confirm=4. Override with `--batch-size N`.

## SimC Failure Handling

| Failure            | Action                                              |
| ------------------ | --------------------------------------------------- |
| APL syntax error   | Fix candidate APL, retry (not a hypothesis failure) |
| "action not found" | Check talent requirements, reject hypothesis        |
| Timeout (>10 min)  | Kill process, reject hypothesis                     |
| Segfault/crash     | Retry once; if repeated, stop loop                  |
| JSON parse error   | Check SimC binary version, retry                    |

3+ consecutive crashes: stop the iteration loop and report.

## Result Reporting

Every report must include: mean weighted delta (%) with significance, worst and best build deltas with build names, per-hero-tree breakdown if relevant, and accept/reject/escalate recommendation with reasoning.

## Constraints

- Always use `--quick` first, escalate only if results are marginal
- Never modify the production APL (`{spec}.simc`) directly
- Always set SPEC: `SPEC={spec} node src/sim/iterate.js ...`
