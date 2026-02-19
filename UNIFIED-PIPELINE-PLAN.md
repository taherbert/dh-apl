# Unified Hypothesis Pipeline — End-to-End

## Context

Steps 0-8 of the "Optimal Timeline Framework Evolution" are **complete** on branch `feature/timeline-framework-evolution`. We now have 6 independent hypothesis sources that don't talk to each other. The user wants a comprehensive view of the entire pipeline — from data extraction through deep analysis to iteration — with all sources unified by cross-source consensus and mutation inference.

---

## Problems to Solve

1. **No cross-source consensus:** When strategic-hypotheses and theory-generator both flag "Spirit Bomb should be higher priority during Fiery Brand," neither knows about the other. This convergent evidence should boost confidence.

2. **3 sources can't produce candidates:** Sources 4-6 write hypotheses to DB but can't feed `iterate.js generate` because they lack `aplMutation`. This means the richest analysis (state-sim-based) requires manual APL editing.

3. **`/optimize` doesn't use the new pipeline:** `pattern-analyze` (which chains optimal-timeline → apl-interpreter → divergence → pattern-analysis → cross-archetype-synthesis → theory-generator) isn't in `/optimize`. Phase 0f manually runs divergence per-archetype; the batch pipeline is more powerful.

4. **Specialist agents write to separate files, not directly to DB:** The 4 specialist outputs (Phase 1b) feed `synthesizer.js` but bypass the other 5 sources entirely.

---

## Implementation

### Step 0: Interaction-Map Enrichment for State-Sim Scoring

**Problem:** `buildScoreTable()` computes flat base scores from `domainOverrides.apCoeff` ignoring build-specific talent amplifiers.

**Architecture fix:**

**File: `src/spec/vengeance.js`** — Add `talentModifiers` to SPEC_CONFIG
**File: `src/analysis/vengeance/state-sim.js`** — Modify `buildScoreTable()` to accept `buildConfig.talents` and apply talent multipliers

### Step 1: `src/analyze/hypothesis-fingerprint.js` (~80 lines)

Semantic fingerprinting to detect when different sources flag the same underlying issue.

### Step 2: `src/analyze/infer-mutation.js` (~150 lines)

Generate `aplMutation` for hypotheses that lack them. Uses the APL parser and mutator.

### Step 3: `src/analyze/unify-hypotheses.js` (~200 lines)

Core unification: fingerprinting, consensus, mutation inference, ranking.

### Step 4: DB Schema Extension (~15 lines in `db.js`)

Add columns to `hypotheses` table: consensus_count, consensus_sources, fingerprint.

### Step 5: `iterate.js unify` Subcommand (~40 lines)

### Step 6: Update `/optimize` SKILL.md (~30 lines changed)

---

## Files Modified/Created

| Action | File                                    | ~Lines                     | Step |
| ------ | --------------------------------------- | -------------------------- | ---- |
| MODIFY | `src/spec/vengeance.js`                 | +30 (talentModifiers)      | 0    |
| MODIFY | `src/analysis/vengeance/state-sim.js`   | +30 (talent-aware scoring) | 0    |
| CREATE | `src/analyze/hypothesis-fingerprint.js` | ~80                        | 1    |
| CREATE | `src/analyze/infer-mutation.js`         | ~150                       | 2    |
| CREATE | `src/analyze/unify-hypotheses.js`       | ~200                       | 3    |
| MODIFY | `src/util/db.js`                        | +15 (schema migration)     | 4    |
| MODIFY | `src/sim/iterate.js`                    | +40 (unify subcommand)     | 5    |
| MODIFY | `.claude/skills/optimize/SKILL.md`      | ~30 lines changed          | 6    |

Total: ~3 new files (~430 lines), 5 modified files (~145 lines changed)
