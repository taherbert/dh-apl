# Multi-Spec Architecture: Per-Spec Data Isolation & Generic Analysis

## Progress Tracker

- [x] Phase 1: Centralized paths module + migrate 46 files
- [x] Phase 2: SPEC_CONFIG expansion (resourceModels, burstWindows, stateMachines, etc.)
- [x] Phase 3: Refactor analysis modules to be data-driven
- [x] Phase 4: Rewrite skill prompts as generic methodology guides
- [x] Phase 5: Rename SIMC_DH_CPP → SIMC_CPP
- [x] Phase 6: Cruft removal + data migration to per-spec dirs
- [x] Phase 7: Verification (see results below)
- [x] Phase 8: Skill layer fix + orphan cleanup (see results below)

**Status: COMPLETE**

---

## Phase 1: Centralized Path Module — COMPLETE

All 46 source files migrated to use `src/engine/paths.js`. Verified: zero remaining `__dirname`/`ROOT`/`DATA_DIR`/`RESULTS_DIR` local definitions outside paths.js, zero `SIMC_DH_CPP` references.

Files migrated: extract/ (9), model/ (3), analyze/ (8), sim/ (8), visualize/ (5), discover/ (1), util/ (3), spec/ (3), engine/ (2), apl/ (2), root (1), + paths.js created.

---

## Phase 2: SPEC_CONFIG Expansion — COMPLETE

Added to vengeance.js: resourceModels, burstWindows, stateMachines, hypothesisPatterns, clusterKeywords, schoolClusters. interface.js updated.

---

## Phase 3: Refactor Analysis Modules — COMPLETE

- theorycraft.js — Resource model building reads from SPEC_CONFIG.resourceModels (done by agent)
- strategic-hypotheses.js — Fully genericized: zero hardcoded VDH ability/buff names. All hypothesis generators read from SPEC_CONFIG (stateMachines, burstWindows, resourceModels, synergies). Helper functions resolve APL branch names from heroTrees config. Deep hypothesis categories renamed to be spec-agnostic.
- reasoning.js — Cooldown alignment reads from SPEC_CONFIG.burstWindows and synergies. hypothesisPatterns loop added.
- build-theory-generator.js — Hero tree detection reads subtree IDs and keywords from adapter config. aplFocus resolved via heroTrees[].aplBranch. School detection falls back to schoolClusters config.

---

## Phase 4: Skill Prompts — COMPLETE

All prompt files genericized or already spec-agnostic. interaction-data-fixes.md deleted. fix-talent-strings.md and apl-gen-thoughts.md cleaned of VDH references.

---

## Phase 5: SimC Config Path Generalization — COMPLETE

All SIMC_DH_CPP references replaced with SIMC_CPP. Completed as part of Phase 1 migrations.

---

## Phase 6: Cruft Removal + Data Migration — COMPLETE

- Data files moved: data/\*.json → data/vengeance/
- Results files moved: results/\*.json → results/vengeance/
- APL files moved: apls/\*.simc → apls/vengeance/
- .gitignore updated for per-spec patterns
- CLAUDE.md updated with per-spec architecture
- PLAN.md deleted, interaction-data-fixes.md deleted

---

## Phase 7: Verification Results

- [x] `node src/engine/startup.js` — config loads, spec adapter validates
- [x] `node src/engine/extract.js` — all 7 pipeline outputs found in data/vengeance/
- [x] `node src/engine/model.js` — all inputs READY
- [x] `node src/verify.js` — 33 passed, 1 pre-existing failure (2 null target IDs), 3 warnings
- [x] `node src/spec/validate-spec-data.js` — PASSED (0 errors, 2 warnings)
- [x] `node src/util/validate.js` — all 9 data schemas OK
- [x] `node src/sim/iterate.js status` — iteration state loads, 15 iterations tracked
- [x] `npm run report` — report generates to data/vengeance/ability-report.md
- [x] Grep check: remaining VDH references only in spec adapter, config defaults, and comments
- [ ] Skeleton havoc.js adapter test — deferred (requires game data for second spec)

### Bug fixes during verification

- `extract.js` — STEPS output paths updated from root-relative to `dataFile()`
- `model.js` — Added startup.js import for setSpecName(), paths updated to `dataFile()`
- `validate.js` — Schema keys changed from `"data/file.json"` to `"file.json"`, fixed stale `relPath` variable
- `iterate.js` — Fixed `MUTATION_OPS` import (was importing from wrong module)

---

## Phase 8: Skill Layer Fix + Orphan Cleanup — COMPLETE

All 12 `.claude/commands/` skills were updated for per-spec paths and generic language:

**Major rewrites (4 skills via subagents):**

- `optimize.md` — Master orchestrator: 4 parallel specialist subagents, synthesis, deep iteration loop. All paths use `{spec}` placeholders. Human-reviewable outputs: `analysis_summary.md`, `dashboard.md`, `changelog.md`, `checkpoint.md`. User confirmation gate before testing.
- `full-analysis.md` — Deep theorycraft: all VDH ability names replaced with generic methodology. References `SPEC_CONFIG` fields. Parallel subagents for Phase 4 validation.
- `iterate-apl.md` — Autonomous iteration: all paths per-spec, hero-tree-agnostic language, parallelism strategy via Task tool, explicit human-reviewable outputs section.
- `talent-analysis.md` — Talent interaction analysis: all VDH examples replaced with generic patterns. References `specConfig` for abilities, resources, hero trees.

**Direct updates (8 skills):**

- `analyze-apl.md` — APL walkthrough: per-spec paths, generic hero tree branching
- `theorycraft.md` — Resource flow: per-spec paths, `SPEC_CONFIG.resourceModels`, generic cooldown mapping
- `bootstrap.md` — Fresh spec bootstrap: per-spec paths, removed "not VDH" phrasing, updated spec extension instructions
- `sim.md` — Simulation runner: per-spec paths, default APL resolution
- `build.md` — Data build: per-spec paths, generic expected counts
- `verify.md` — Verification: per-spec paths, generic data locations
- `audit.md` — No changes needed (delegates to prompt which is already generic)
- `simc-reference.md` — No changes needed (reads from shared `reference/wiki/`)

**Orphaned prompts deleted (4):**

- `prompts/data-sources-and-setup.md`
- `prompts/audit-interactions.md`
- `prompts/fix-talent-strings.md`
- `prompts/apl-gen-thoughts.md`

**Active prompts retained (3):**

- `prompts/apl-analysis-guide.md` — used by `/full-analysis`
- `prompts/apl-iteration-guide.md` — used by `/iterate-apl`
- `prompts/verify-data.md` — used by `/audit`

### Verification

- Grep: zero "VDH", zero "Vengeance Demon Hunter" in `.claude/commands/`
- Grep: zero bare `data/file.json` paths (all use `data/{spec}/` pattern)
- Grep: zero bare `results/file.json` paths (all use `results/{spec}/` pattern)
- Grep: zero bare `apls/file.simc` paths (all use `apls/{spec}/` pattern)
- Team orchestration: `/optimize` has 4 parallel specialists, `/iterate-apl` has parallelism strategy, `/full-analysis` has parallel validation
- Human-reviewable outputs: `dashboard.md`, `changelog.md`, `analysis_summary.md`, `talent_analysis.md`, `findings.json`, `checkpoint.md` all present
- User confirmation gates: `/optimize` Phase 2e, `/full-analysis` Phase 3 end
