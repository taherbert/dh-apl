# APL Engine Rebuild — Spec-Agnostic, Claude-Autonomous

## Vision

A clean-slate rebuild of the SimC APL optimization engine designed for:

- **Claude autonomy** — Minimal human input, maximum self-direction
- **Spec-agnostic** — Works for any WoW spec (testing with VDH)
- **Single sources of truth** — No duplication, clear data ownership
- **Auto-sync with upstream** — Check simc on startup, rebuild if needed

---

## Core Principles

### 1. Single Config File

One JSON file (`config.json` in project root) for all human-editable configuration:

```json
{
  "spec": {
    "className": "demonhunter",
    "specName": "vengeance",
    "specId": 581,
    "heroTrees": ["aldrachi_reaver", "annihilator"]
  },
  "simc": {
    "path": "/path/to/simc",
    "branch": "midnight"
  },
  "simulation": {
    "scenarios": { "st": 0.5, "small_aoe": 0.3, "big_aoe": 0.2 },
    "fidelity": { "quick": 1.0, "standard": 0.3, "confirm": 0.1 }
  }
}
```

No `.env` files. No scattered constants. One file.

### 2. Data Structure for Claude

Optimize file organization for LLM context windows:

- **Small, focused files** over monolithic blobs
- **Structured JSON** with `_schema` and `_doc` fields
- **Summary files** for common queries (full data available if needed)
- **SQLite** for large datasets requiring queries (builds, findings)

### 3. Clear Directory Structure

```
dh-apl/
├── config.json                    # Single human config
├── src/
│   ├── engine/                    # Core engine (spec-agnostic)
│   │   ├── extract.js             # Data extraction from simc/raidbots
│   │   ├── model.js               # Talent/spell/interaction modeling
│   │   ├── analyze.js             # Hypothesis generation
│   │   ├── simulate.js            # SimC runner
│   │   ├── iterate.js             # APL iteration loop
│   │   └── startup.js             # Upstream sync + rebuild check
│   ├── spec/                      # Spec-specific adapters
│   │   └── vengeance.js           # VDH spell IDs, domain knowledge
│   └── util/                      # Shared utilities
├── data/
│   ├── generated/                 # Auto-generated (gitignored)
│   │   ├── spells.json
│   │   ├── talents.json
│   │   └── interactions.json
│   └── knowledge/                 # Curated knowledge (committed)
│       ├── mechanics.json         # Verified C++ mechanics
│       └── build-theory.json      # Archetype theory
├── results/
│   ├── builds.db                  # SQLite: discovered builds
│   ├── findings.db                # SQLite: empirical findings
│   └── session/                   # Current session state
├── apls/
│   ├── profile.simc               # Character profile
│   └── [spec].simc                # APL files
└── plans/
    └── rebuild.md                 # This plan (persists across contexts)
```

### 4. Startup Autonomy

On every session start:

1. Check `simc` branch HEAD vs last-synced commit
2. If changed: auto-rebuild data pipeline
3. Load config.json and validate
4. Report readiness or blocking issues

---

## Implementation Phases

### Phase 1: Foundation — Single Config + Startup Check ✅

**Goal:** Single entry point for config, auto-sync with upstream.

**Completed:**

- [x] `config.json` — all human-editable config (spec, simc paths, scenarios, fidelity)
- [x] `src/engine/startup.js` — loads config, derives paths, checks simc sync, backward-compat exports
- [x] `src/spec/vengeance.js` — consolidated from `vengeance-base.js` + `spec-abilities.js`
- [x] All 14 source files rewired from old imports → new locations
- [x] Deleted: `src/config.js`, `src/config/spec-abilities.js`, `src/model/vengeance-base.js`
- [x] Verified: `startup.js` loads, `verify.js` runs, all modules import cleanly

---

### Phase 2: Spec Adapter Pattern

**Goal:** Spec-agnostic engine with pluggable spec adapters.

**Tasks:**

1. Create spec adapter interface:
   ```javascript
   // src/spec/interface.js
   export interface SpecAdapter {
     spellIds: Record<string, number>;
     domainOverrides: Record<string, object>;
     heroTrees: Record<string, HeroTreeConfig>;
     resourceFlow: ResourceFlowConfig;
     validateApl(apl: string): ValidationResult;
   }
   ```
2. Implement `src/spec/vengeance.js` conforming to interface
3. Engine loads spec adapter from config.json `spec.specName`

**Files:**

- CREATE: `src/spec/interface.js`
- CREATE: `src/spec/vengeance.js`
- MODIFY: Engine modules to use adapter

---

### Phase 3: Data Pipeline Cleanup

**Goal:** Clean extraction pipeline, proper file separation.

**Tasks:**

1. Consolidate extraction into `src/engine/extract.js`:
   - Batch spell queries (not N+1)
   - Single pass through C++ source
   - Output to `data/generated/`
2. Create `src/engine/model.js`:
   - Build talent tree from raidbots
   - Build interactions from spell data + C++ scan
   - Output structured JSON with schemas
3. Integrate cpp-effects-inventory into interactions (Phase 4 in old plan)

**Files:**

- CREATE: `src/engine/extract.js` (consolidate raidbots.js, spells.js, cpp-\*.js)
- CREATE: `src/engine/model.js` (consolidate talents.js, interactions.js)
- DELETE: Redundant extraction files

---

### Phase 4: SQLite for Large Datasets

**Goal:** Queryable storage for builds and findings.

**Tasks:**

1. Create `results/builds.db` with schema:
   ```sql
   CREATE TABLE builds (
     hash TEXT PRIMARY KEY,
     spec TEXT,
     hero_tree TEXT,
     talents JSON,
     dps_st REAL, dps_aoe REAL, dps_weighted REAL,
     archetype TEXT,
     discovered_at TEXT
   );
   CREATE TABLE factors (
     talent TEXT, impact REAL, pct REAL
   );
   ```
2. Create `results/findings.db`:
   ```sql
   CREATE TABLE findings (
     id TEXT PRIMARY KEY,
     hypothesis TEXT,
     status TEXT, -- validated, rejected, superseded
     impact JSON,
     evidence JSON,
     created_at TEXT
   );
   ```
3. Utilities: `src/util/db.js` with helpers

**Files:**

- CREATE: `src/util/db.js`
- MODIFY: `src/discover/build-discovery.js` → write to SQLite
- MODIFY: `src/sim/iterate.js` → write findings to SQLite

---

### Phase 5: Wire Synthesizer + Analysis Pipeline

**Goal:** Complete analysis pipeline with synthesis.

**Tasks:**

1. Wire `src/analyze/synthesizer.js` into iteration loop
2. Specialist outputs → synthesis → ranked hypotheses
3. Auto-test top hypotheses in priority order
4. Findings auto-recorded to SQLite

**Files:**

- MODIFY: `src/sim/iterate.js`
- MODIFY: `src/analyze/synthesizer.js`
- ADD: npm script `synthesize`

---

### Phase 6: Schema Validation + Staleness

**Goal:** Data integrity and freshness detection.

**Tasks:**

1. JSON schemas for all data files
2. Staleness detection based on mtimes + simc commit
3. Validation on load, fail early on corruption

**Files:**

- CREATE: `schemas/*.schema.json`
- CREATE: `src/util/validate.js`
- CREATE: `src/util/staleness.js`

---

### Phase 7: Team-Based Parallel Execution

**Goal:** Leverage Claude's Team construct for parallel agent work on complex tasks.

**Context:** Claude Opus 4.6 supports spawning named teams of agents that share a task list and communicate via messages. This enables parallel work — e.g., one agent researches while another implements, or multiple agents tackle independent file changes simultaneously.

**Tasks:**

1. Add team-aware workflow to `/optimize` and `/full-analysis` skills:
   - Team lead creates tasks from the hypothesis queue
   - Spawn specialized teammates (Explore for research, general-purpose for implementation)
   - Agents claim tasks, work in parallel, mark complete
2. Define team patterns for common workflows:
   - **Build discovery:** One agent runs DoE sims, another analyzes results
   - **APL iteration:** One agent generates hypotheses, another tests them
   - **Multi-spec:** Parallel spec optimization with shared infrastructure
3. Add team orchestration helpers:
   - Task dependency templates (e.g., "analyze" blocks "implement")
   - Result aggregation from multiple agent outputs
4. Update skill prompts to offer team mode when work is parallelizable

**Files:**

- MODIFY: `.claude/commands/optimize.md` — add team orchestration option
- MODIFY: `.claude/commands/full-analysis.md` — add parallel analysis mode
- CREATE: `.claude/commands/team-optimize.md` — dedicated team workflow skill (optional)

**Notes:**

- Teams are experimental — expect rough edges
- Main value is parallelism on independent subtasks
- Team config: `~/.claude/teams/{name}/config.json`, tasks: `~/.claude/tasks/{name}/`
- Each teammate has its own context window — they don't share conversation history

---

## Session Persistence

This plan file persists at: `plans/rebuild.md` (symlinked from `.claude/plans/`)

On context clear, resume by:

1. Reading this plan
2. Checking which phases are complete (file existence)
3. Continuing from first incomplete phase

---

## Success Criteria

1. **Zero scattered config** — All human config in `config.json`
2. **Auto-sync** — Startup detects simc changes and rebuilds
3. **Spec-agnostic** — Adding new spec = creating one adapter file
4. **SQLite for large data** — Builds/findings queryable
5. **Synthesis wired** — Hypothesis ranking uses consensus
6. **Claude-autonomous** — Minimal human intervention per session
