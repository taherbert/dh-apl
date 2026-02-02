# Plan: Vengeance DH APL Framework — Midnight Expansion

## Goal

Build the foundation for creating an optimal Vengeance Demon Hunter APL targeting the Midnight expansion. The core insight: **understanding spell/talent interactions deeply** is the prerequisite to everything else. We build tools to extract, map, and visualize those interactions, then use that understanding to craft and test APLs.

## Prerequisites

- [x] simc on `midnight` branch and built
- [x] Node.js available (v23.11.0)
- [x] SimC binary at `/Users/tom/Documents/GitHub/simc/engine/simc`

## Steps

### Step 0: Save Plan to Repo

- [x] Create `PLAN.md`
- [x] Update `CLAUDE.md` with architecture and session protocol

### Step 1: Project Scaffold

- [x] `package.json` — ESM module
- [x] `.gitignore` — Add `data/raw/`, `results/`
- [x] Directory structure: `src/{extract,model,visualize,sim,apl}`, `data/`, `apls/`, `results/`

### Step 2: Spell Data Extraction & Parsing

- [x] `src/extract/parser.js` — spell_query text → JSON parser
- [x] `src/extract/spells.js` — runs simc spell_query, produces `data/spells.json`
- Note: ~104 spells extracted from Raidbots spell IDs + base abilities + class spells
- Note: Descriptions contain simc template variables ($s1, $s2, etc.) — future: resolve to actual values

### Step 3: Talent Tree Mapping

- [x] `src/model/talents.js` — structures talent data into class/spec/hero trees
- [x] Output: `data/talents.json`
- [x] Raidbots integration: 42 class nodes, 42 spec nodes, 14+14 hero nodes
- [x] Talent entries (with choice node expansion): 45 class, 44 spec, 17 Aldrachi Reaver, 16 Annihilator
- Note: Raidbots is authoritative for tree structure; simc C++ is implementation reference
- Note: Devourer is a third DH spec (Intellect caster), not a hero tree
- Note: Vengeance hero trees in Midnight: Aldrachi Reaver (subtree 35) + Annihilator (subtree 124)
- Note: Class node spell IDs are identical across all three DH specs

### Step 4: Interaction Mapping

- [x] `src/model/interaction-types.js` — interaction category definitions + effect/name heuristics
- [x] `src/model/interactions.js` — merges spell_data + C++ scanner + effect scan
- [x] `src/extract/cpp-interactions.js` — C++ cross-reference scanner (talent↔talent, talent→ability)
- [x] `src/visualize/audit-report.js` — comprehensive audit report
- [x] Output: `data/interactions.json`, `data/cpp-interactions.json`, `data/audit-report.md`
- [x] **Zero unknown interactions** (was 10)
- [x] **266 interactions** (was 190): 190 spell_data + 59 cpp_scanner + 17 effect_scan
- [x] **114 talents** have interactions (was 70), 11 stat passives excluded, 44 C++-only
- [x] Verification: 20 passed, 0 failed, 2 warnings (orphan sub-spells, 1 active ability gap)

### Step 5: Visualization

- [x] `src/visualize/text-report.js` — markdown ability/talent report
- [x] `src/visualize/graph.js` — Mermaid interaction graph
- [x] Output: `data/ability-report.md`, `data/interaction-graph.mermaid`

### Step 6: SimC Runner

- [x] `src/sim/runner.js` — executes simc, parses JSON output
- [x] `src/sim/analyze.js` — extracts optimization signals
- [x] Three scenarios: Patchwerk ST, Small AoE (3 targets), Large AoE (10 targets)

### Step 7: Baseline APL

- [x] Copy TWW3 vengeance APL as `apls/baseline.simc`
- [x] Copy TWW3 profile as `apls/profile.simc`
- [x] Run baseline simulation, record reference numbers

**Baseline Results (Fel-Scarred, TWW3 profile, 1000 iterations):**

| Scenario        | DPS        | HPS     |
| --------------- | ---------- | ------- |
| Patchwerk ST    | 3,087,582  | 890,439 |
| Small AoE (3T)  | 8,238,623  | 806,147 |
| Large AoE (10T) | 18,732,678 | 737,423 |

**Key ST findings:**

- Burning Blades 20.5%, Demonsurge 12.3%, Soul Cleave 10.0% of damage
- Spirit Bomb is 50.8% of healing (via Frailty)
- Demon Spikes uptime: 63.8%, Metamorphosis uptime: 39.0%
- Soul Furnace damage amp uptime only 11.2% — potential optimization target

### Step 8: Raidbots Integration & Project Setup

- [x] `src/config.js` — Central config (DATA_ENV, paths, Raidbots URLs, VDH identifiers)
- [x] `src/extract/raidbots.js` — Fetch Raidbots talent data → `data/raidbots-talents.json`
- [x] Refactored `src/model/talents.js` — Raidbots as primary source (replaces DBC talent dump)
- [x] Refactored `src/extract/spells.js` — Spell IDs from Raidbots (removed `parseTalentDump()`)
- [x] Updated `src/verify.js` — Raidbots-based verification (count matching, stale detection, choice nodes)
- [x] `.claude/commands/` skills: verify, build, sim, audit
- [x] Updated `package.json` — `fetch-raidbots` script, updated `build-data` pipeline
- [x] Updated `.claude/settings.local.json` — `npm run *` permission
- [x] Updated `CLAUDE.md` — Data sources, environment toggle, hero trees, choice nodes
- [x] Rewritten `prompts/verify-data.md` — Raidbots as primary authority

**Current verification status:** 18 passed, 0 failed, 1 warning (5.3% unknown interactions)

## Current Data Pipeline

```
npm run fetch-raidbots  →  data/raidbots-talents.json (from Raidbots API)
npm run extract         →  data/spells.json (simc spell_query for each Raidbots spell ID)
npm run talents         →  data/talents.json (structured class/spec/hero trees)
npm run interactions    →  data/interactions.json (talent → spell interaction graph)
npm run report          →  data/ability-report.md
npm run graph           →  data/interaction-graph.mermaid

npm run build-data      →  runs all of the above in sequence
npm run verify          →  validates data against Raidbots + simc C++
```

## Known Gaps

- 10 unknown-type interactions (~5.3%) — need SpellDataDump effect data to classify
- Demonsurge (452435) not found in simc spell_query — not yet in compiled binary's spell data
- Baseline APL uses TWW3 Fel-Scarred profile — needs Midnight/Aldrachi Reaver and Annihilator profiles
- Spell descriptions contain unresolved template variables ($s1, $s2)

### Step 9: SimC Reference Data Extraction

- [x] `reference/vengeance-apl.simc` — simc default VDH APL
- [x] `reference/simc-talent-variables.json` — C++ talent variable names (219 total across all trees)
- [x] `reference/spelldatadump-vdh.txt` — Full DH spell effect data from SpellDataDump
- [x] `reference/trait-data.md` — Key simc structs: trait_data_t, player_talent_t, soul_fragment enum
- [x] `reference/tww3-profiles/` — TWW3 VDH profiles (base + Aldrachi Reaver)
- [x] `reference/apl-conversion/` — ConvertAPL.py + generate_demon_hunter.py
- [x] `reference/wiki/` — 15 SimC wiki pages (APL syntax, expressions, DH options, etc.)
- [x] `src/extract/simc-talents.js` — Extracts talent variables from sc_demon_hunter.cpp
- [x] Updated `package.json` with `extract-simc` script
- [x] Updated `CLAUDE.md` with reference directory documentation

## Phase 2: APL Tooling Pipeline

Build all tooling needed to programmatically create, test, and iterate on VDH APLs, then establish a workflow where Claude can autonomously run simulation loops and reason about improvements.

### Step 10: Resolve Spell Template Variables

- [x] Add `resolvedDescription` field to each spell in `data/spells.json`
- [x] Substitute `$s1`/`$s2`/`$s3` → effect N's `scaledValue` or `baseValue`
- [x] Substitute `$d` → spell duration, `$t1`/`$t2` → tick period, `$a1` → radius
- [x] Handle `$SpellIds1` cross-references, `$?sSpellId[yes][no]` conditionals
- [x] Handle `${expr}` arithmetic (e.g., `$s1*2`, `$s1/1000`)
- [x] Target ~85-90% resolution; leave unresolvable as raw template
- Note: `src/extract/template-resolver.js` — standalone module, integrated into spells.js
- Note: 110/167 spells fully resolved (65.9%), 22 partial, 35 unresolved
- Note: 65.4% variable-level resolution; remaining are stat-dependent ($AGI, $sw), compound conditionals, and sub-spells missing from binary
- Note: Also fetches 43 sub-spells referenced in descriptions for better resolution

### Step 11: APL Parser/Generator

- [x] `src/apl/parser.js` — Parse `.simc` APL text into AST, serialize back
- [x] AST nodes: ActionList, RawSection, Action, Variable, RunActionList, Comment
- [x] Operations: `parse()`, `serialize()`, `getActionLists()`, `findAction()`, `insertAction()`, `removeAction()`, `replaceCondition()`, `createAction()`, `createVariable()`
- [x] Round-trip fidelity: `serialize(parse(text))` produces PERFECT output
- Note: Preserves document order — non-APL lines (gear, profile) stay in position
- Note: baseline.simc: 10 action lists, 166 actions, perfect round-trip
- Note: reference/vengeance-apl.simc: 5 action lists, 67 actions, perfect round-trip

### Step 12: Talent Combination Generator

- [x] `src/model/talent-combos.js` — Generate valid talent sets from tree graph
- [x] Validation: entry nodes, `prev` connectivity, `reqPoints` gates, choice node exclusivity
- [x] Hero tree simplification: enumerate choice node combinations only
- [x] Anchor-based generation: key build-defining picks + BFS/greedy fill
- [x] Output ~20-50 curated builds with SimC talent strings
- Note: 48 valid builds (32 Aldrachi Reaver, 16 Annihilator), 4 anchor sets × hero choice combos
- Note: BFS backwards path-finding for anchor connectivity, greedy fill for remaining budget

### Step 13: Batch Testing via Profilesets

- [x] `src/sim/profilesets.js` — Generate and run SimC profileset files
- [x] Support talent, APL, and action line overrides per variant
- [x] Parse ranked JSON results with delta comparison
- [x] Regression testing: golden results, flag >1% regressions
- Note: Uses SimC native profileset mode for memory-efficient batch comparison
- Note: Golden results stored in `results/golden/`, >1% warn, >3% error thresholds

### Step 14: Autonomous Simulation Workflow

- [ ] `src/sim/workflow.js` — Single entry point for full sim→analyze cycle
- [ ] Parse APL, run across scenarios, return structured JSON analysis
- [ ] No user interaction required; designed for Claude to call

### Step 15: APL Reasoning Framework

- [ ] `src/analyze/reasoning.js` — Generate improvement hypotheses from sim results
- [ ] Analysis: underused abilities, buff uptime gaps, cooldown alignment, conditional tightness
- [ ] Output ranked hypotheses with category, confidence, suggested tests

### Dependency Order

```
Step 10 (template vars) ──────────────────────────────────┐
Step 11 (APL parser) ──────┬──────────────────────────────┤
Step 12 (talent combos) ───┤                              │
                           ├─→ Step 13 (profilesets) ──→ Step 14 (workflow) ──→ Step 15 (reasoning)
```

## Findings & Notes

- SimC `midnight` branch version string still shows "thewarwithin" — the version identifier hasn't been updated
- Raidbots returns spec-specific talent trees (filtered by specId), but class node spell IDs are identical across all DH specs
- DBC subtree IDs map correctly to hero trees: 35 = Aldrachi Reaver, 124 = Annihilator
- simc binary built Sep 5 2025; some newer spells (e.g., Demonsurge) not in binary's spell data
- Buff uptimes from simc JSON are percentages (0-100), not fractions (0-1)
- GCD efficiency metric needs refinement for AoE scenarios (currently counts per-target hits)
