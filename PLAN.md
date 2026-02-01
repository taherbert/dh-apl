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
- Note: 178 spells extracted, 106 with talent entries, 42 Vengeance-specific
- Note: Also extracts talent data from `talent` query (different format than `spell` query)
- Note: Descriptions contain simc template variables ($s1, $s2, etc.) — future: resolve to actual values

### Step 3: Talent Tree Mapping

- [x] `src/model/talents.js` — structures talent data into class/spec/hero trees
- [x] Output: `data/talents.json`
- Note: Class=41, Spec=48, Aldrachi Reaver=14 talents (Annihilator not yet in DBC)
- Note: DBC subtree IDs (34, 35) do NOT map to hero tree names — both contain mixed talents. Hero tree identity determined by C++ `talent.{tree}.*` assignments
- Note: Devourer is a third DH spec (Intellect caster), not a hero tree
- Note: Annihilator is the new Vengeance hero tree (replaces Fel-Scarred); C++ has 16 talents but simc binary (Sep 5) predates DBC updates — needs rebuild
- Note: Vengeance hero trees in Midnight: Aldrachi Reaver + Annihilator
- Note: Annihilator talent spells (Voidfall, Catastrophe, etc.) exist in SpellDataDump/demonhunter.txt (updated Feb 1) but not in compiled binary

### Step 4: Interaction Mapping

- [x] `src/model/interaction-types.js` — interaction category definitions
- [x] `src/model/interactions.js` — builds talent→spell interaction graph
- [x] Output: `data/interactions.json`
- Note: 207 interactions, 27 spells have modifiers, 70 modifier sources
- Note: Many "unknown" type interactions where modifier spell data not in collection

### Step 5: Visualization

- [x] `src/visualize/text-report.js` — markdown ability/talent report (838 lines)
- [x] `src/visualize/graph.js` — Mermaid interaction graph (38 nodes, 36 edges)
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

## Future Sessions

- APL parser/generator (AST-based)
- Talent combination generator
- Optimization loop (isolated variable testing)
- Hero tree comparison (Aldrachi Reaver vs Annihilator)
- Resolve spell description template variables to actual values
- Save simc wiki pages locally as reference

## Findings & Notes

- SimC `midnight` branch version string still shows "thewarwithin" — the version identifier hasn't been updated
- `spell.class=demon_hunter` query returns many shared/legacy spells, not DH-specific. Better approach: query `talent` for all talent spell IDs, then query each spell individually
- `talent` query has a different format than `spell` query (flat key-value vs nested)
- Buff uptimes from simc JSON are percentages (0-100), not fractions (0-1)
- GCD efficiency metric needs refinement for AoE scenarios (currently counts per-target hits)
- simc binary built Sep 5 2025; DBC updates exist since then (may include Annihilator talent data)
- Rebuilding simc may resolve missing Annihilator/new talent data
- C++ has 8 Vengeance spec talents not yet in DBC, and DBC has 12 talents not in C++ (midnight branch in flux)
- simc midnight branch version string still says "thewarwithin" despite Midnight-era code
