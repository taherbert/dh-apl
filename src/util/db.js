// Unified SQLite database for the theorycrafting pipeline.
// Single theorycraft.db per spec — all knowledge, build, and iteration state.
// Uses Node.js 23 built-in sqlite module (no external deps).
//
// Database lives at results/{spec}/theorycraft.db
// JSON files are export snapshots for git tracking only.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { initSpec } from "../engine/startup.js";
import { parseSpecArg } from "./parse-spec-arg.js";
import {
  resultsFile,
  resultsDir,
  dataFile,
  ensureSpecDirs,
  getSpecName,
} from "../engine/paths.js";

// --- Schema ---

const SCHEMA_VERSION = 1;

const SCHEMA = `
-- ═══════════════════════════════════════════════════════════
-- KNOWLEDGE LAYER
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS theories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec TEXT NOT NULL,
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  category TEXT,
  status TEXT DEFAULT 'active',
  confidence REAL DEFAULT 0.5,
  parent_id INTEGER REFERENCES theories(id),
  evidence TEXT,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theory_id INTEGER REFERENCES theories(id),
  spec TEXT NOT NULL,
  summary TEXT NOT NULL,
  implementation TEXT,
  mutation TEXT,
  category TEXT,
  priority REAL DEFAULT 5.0,
  status TEXT DEFAULT 'pending',
  source TEXT,
  archetype TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  tested_at TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec TEXT NOT NULL,
  insight TEXT NOT NULL,
  evidence TEXT,
  confidence TEXT DEFAULT 'medium',
  scope TEXT DEFAULT 'universal',
  archetype TEXT,
  hero_tree TEXT,
  impact TEXT,
  mechanism TEXT,
  apl_version TEXT,
  status TEXT DEFAULT 'active',
  tags TEXT,
  iteration_id INTEGER REFERENCES iterations(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(insight, created_at)
);

-- ═══════════════════════════════════════════════════════════
-- BUILD LAYER
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS builds (
  hash TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  name TEXT,
  hero_tree TEXT,
  archetype TEXT,
  overrides TEXT,
  dps_st REAL,
  dps_small_aoe REAL,
  dps_big_aoe REAL,
  weighted REAL,
  rank INTEGER,
  source TEXT DEFAULT 'doe',
  pinned INTEGER DEFAULT 0,
  in_roster INTEGER DEFAULT 0,
  validated INTEGER DEFAULT 0,
  validation_errors TEXT,
  discovered_at TEXT DEFAULT (datetime('now')),
  last_tested_at TEXT
);

CREATE TABLE IF NOT EXISTS archetypes (
  name TEXT PRIMARY KEY,
  spec TEXT NOT NULL,
  hero_tree TEXT,
  defining_talents TEXT,
  description TEXT,
  core_loop TEXT,
  best_build_hash TEXT,
  build_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec TEXT NOT NULL,
  talent TEXT NOT NULL,
  node_id INTEGER,
  factor_type TEXT,
  main_effect REAL,
  pct REAL,
  run_id TEXT,
  UNIQUE(talent, run_id)
);

CREATE TABLE IF NOT EXISTS synergies (
  talent_a TEXT NOT NULL,
  talent_b TEXT NOT NULL,
  spec TEXT NOT NULL,
  interaction REAL,
  run_id TEXT,
  PRIMARY KEY (talent_a, talent_b, spec)
);

-- ═══════════════════════════════════════════════════════════
-- ITERATION LAYER
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS iterations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec TEXT NOT NULL,
  hypothesis_id INTEGER REFERENCES hypotheses(id),
  session_id TEXT,
  fidelity TEXT,
  apl_diff TEXT,
  results TEXT NOT NULL,
  aggregate TEXT NOT NULL,
  decision TEXT,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_state (
  key TEXT NOT NULL,
  spec TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (key, spec)
);

CREATE TABLE IF NOT EXISTS baseline_dps (
  build_hash TEXT NOT NULL,
  spec TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scenario TEXT NOT NULL,
  dps REAL NOT NULL,
  is_current INTEGER DEFAULT 0,
  PRIMARY KEY (build_hash, spec, session_id, scenario, is_current)
);

-- ═══════════════════════════════════════════════════════════
-- METADATA
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_info (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ═══════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_theories_status ON theories(status);
CREATE INDEX IF NOT EXISTS idx_theories_category ON theories(category);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_hypotheses_theory ON hypotheses(theory_id);
CREATE INDEX IF NOT EXISTS idx_iterations_session ON iterations(session_id);
CREATE INDEX IF NOT EXISTS idx_iterations_decision ON iterations(decision);
CREATE INDEX IF NOT EXISTS idx_builds_weighted ON builds(weighted DESC);
CREATE INDEX IF NOT EXISTS idx_builds_roster ON builds(in_roster) WHERE in_roster = 1;
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_factors_talent ON factors(talent);
`;

// --- Database access ---

let _db = null;

export function getDb(spec) {
  if (_db) return _db;
  const dbPath = resultsFile("theorycraft.db", spec);
  ensureSpecDirs(spec);
  _db = new DatabaseSync(dbPath);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec(SCHEMA);

  // Track schema version
  const existing = _db
    .prepare("SELECT value FROM schema_info WHERE key = 'version'")
    .get();
  if (!existing) {
    _db
      .prepare("INSERT INTO schema_info (key, value) VALUES ('version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  return _db;
}

export function closeAll() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// --- Helpers ---

function jsonCol(val) {
  if (val == null) return null;
  return typeof val === "string" ? val : JSON.stringify(val);
}

function parseJson(val) {
  if (val == null) return null;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

function spec() {
  return getSpecName();
}

// --- Theory CRUD ---

export function addTheory(theory) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO theories (spec, title, reasoning, category, status, confidence, parent_id, evidence, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    theory.spec || spec(),
    theory.title,
    theory.reasoning,
    theory.category || null,
    theory.status || "active",
    theory.confidence ?? 0.5,
    theory.parentId ?? null,
    jsonCol(theory.evidence),
    jsonCol(theory.tags),
  );
  return Number(info.lastInsertRowid);
}

export function updateTheory(id, updates) {
  const db = getDb();
  const fields = [];
  const params = [];

  for (const [key, val] of Object.entries(updates)) {
    const col =
      key === "parentId"
        ? "parent_id"
        : key === "updatedAt"
          ? "updated_at"
          : key;
    if (["evidence", "tags"].includes(col)) {
      fields.push(`${col} = ?`);
      params.push(jsonCol(val));
    } else {
      fields.push(`${col} = ?`);
      params.push(val);
    }
  }
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE theories SET ${fields.join(", ")} WHERE id = ?`).run(
    ...params,
  );
}

export function getTheories({ status, category, limit = 50, spec: s } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM theories WHERE spec = ?";
  const params = [s || spec()];
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(limit);
  return db
    .prepare(sql)
    .all(...params)
    .map(rowToTheory);
}

export function getTheory(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM theories WHERE id = ?").get(id);
  return row ? rowToTheory(row) : null;
}

export function getTheoryChain(id) {
  const theories = [];
  let current = getTheory(id);
  while (current) {
    theories.unshift(current);
    current = current.parentId ? getTheory(current.parentId) : null;
  }
  return theories;
}

function rowToTheory(r) {
  return {
    ...r,
    parentId: r.parent_id,
    evidence: parseJson(r.evidence),
    tags: parseJson(r.tags),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// --- Hypothesis CRUD ---

export function addHypothesis(hypothesis) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO hypotheses (theory_id, spec, summary, implementation, mutation, category, priority, status, source, archetype)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    hypothesis.theoryId ?? null,
    hypothesis.spec || spec(),
    hypothesis.summary || hypothesis.hypothesis,
    hypothesis.implementation || null,
    jsonCol(hypothesis.mutation),
    hypothesis.category || null,
    hypothesis.priority ?? 5.0,
    hypothesis.status || "pending",
    hypothesis.source || null,
    hypothesis.archetype || null,
  );
  return Number(info.lastInsertRowid);
}

export function updateHypothesis(id, updates) {
  const db = getDb();
  const fields = [];
  const params = [];

  for (const [key, val] of Object.entries(updates)) {
    const col =
      key === "theoryId" ? "theory_id" : key === "testedAt" ? "tested_at" : key;
    if (col === "mutation") {
      fields.push(`${col} = ?`);
      params.push(jsonCol(val));
    } else {
      fields.push(`${col} = ?`);
      params.push(val);
    }
  }
  params.push(id);
  db.prepare(`UPDATE hypotheses SET ${fields.join(", ")} WHERE id = ?`).run(
    ...params,
  );
}

export function getHypotheses({
  status,
  theoryId,
  source,
  limit = 50,
  spec: s,
} = {}) {
  const db = getDb();
  let sql = "SELECT * FROM hypotheses WHERE spec = ?";
  const params = [s || spec()];
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (theoryId) {
    sql += " AND theory_id = ?";
    params.push(theoryId);
  }
  if (source) {
    sql += " AND source = ?";
    params.push(source);
  }
  sql += " ORDER BY priority DESC, id ASC LIMIT ?";
  params.push(limit);
  return db
    .prepare(sql)
    .all(...params)
    .map(rowToHypothesis);
}

export function popNextHypothesis(s) {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM hypotheses WHERE spec = ? AND status = 'pending' ORDER BY priority DESC, id ASC LIMIT 1",
    )
    .get(s || spec());
  if (!row) return null;
  db.prepare(
    "UPDATE hypotheses SET status = 'testing', tested_at = datetime('now') WHERE id = ?",
  ).run(row.id);
  return rowToHypothesis(row);
}

function rowToHypothesis(r) {
  return {
    ...r,
    theoryId: r.theory_id,
    mutation: parseJson(r.mutation),
    createdAt: r.created_at,
    testedAt: r.tested_at,
  };
}

// --- Finding CRUD ---

export function addFinding(finding) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO findings (spec, insight, evidence, confidence, scope, archetype, hero_tree, impact, mechanism, apl_version, status, tags, iteration_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    finding.spec || spec(),
    finding.insight,
    finding.evidence || null,
    finding.confidence || "medium",
    finding.scope || "universal",
    finding.archetype || null,
    finding.heroTree || finding.hero_tree || null,
    jsonCol(finding.impact),
    finding.mechanism || null,
    finding.aplVersion || finding.apl_version || null,
    finding.status || "active",
    jsonCol(finding.tags),
    finding.iterationId ?? finding.iteration_id ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function getFindings({ status, confidence, limit = 100, spec: s } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM findings WHERE spec = ?";
  const params = [s || spec()];
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (confidence) {
    sql += " AND confidence = ?";
    params.push(confidence);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  return db
    .prepare(sql)
    .all(...params)
    .map(rowToFinding);
}

function rowToFinding(r) {
  return {
    ...r,
    heroTree: r.hero_tree,
    impact: parseJson(r.impact),
    tags: parseJson(r.tags),
    iterationId: r.iteration_id,
    createdAt: r.created_at,
  };
}

// --- Iteration CRUD ---

export function addIteration(iteration) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO iterations (spec, hypothesis_id, session_id, fidelity, apl_diff, results, aggregate, decision, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    iteration.spec || spec(),
    iteration.hypothesisId ?? null,
    iteration.sessionId || null,
    iteration.fidelity || null,
    iteration.aplDiff || null,
    jsonCol(iteration.results),
    jsonCol(iteration.aggregate),
    iteration.decision || null,
    iteration.reason || null,
  );
  return Number(info.lastInsertRowid);
}

export function getIterations({
  sessionId,
  decision,
  limit = 100,
  spec: s,
} = {}) {
  const db = getDb();
  let sql = "SELECT * FROM iterations WHERE spec = ?";
  const params = [s || spec()];
  if (sessionId) {
    sql += " AND session_id = ?";
    params.push(sessionId);
  }
  if (decision) {
    sql += " AND decision = ?";
    params.push(decision);
  }
  sql += " ORDER BY id ASC LIMIT ?";
  params.push(limit);
  return db
    .prepare(sql)
    .all(...params)
    .map(rowToIteration);
}

export function getSessionSummary(sessionId, s) {
  const db = getDb();
  const specName = s || spec();
  const iters = db
    .prepare(
      "SELECT * FROM iterations WHERE spec = ? AND session_id = ? ORDER BY id ASC",
    )
    .all(specName, sessionId)
    .map(rowToIteration);

  const accepted = iters.filter((i) => i.decision === "accepted");
  const rejected = iters.filter((i) => i.decision === "rejected");
  const totalDelta = accepted.reduce(
    (sum, i) => sum + (i.aggregate?.meanWeighted || 0),
    0,
  );

  return {
    total: iters.length,
    accepted: accepted.length,
    rejected: rejected.length,
    totalDelta,
    iterations: iters,
  };
}

function rowToIteration(r) {
  return {
    ...r,
    hypothesisId: r.hypothesis_id,
    sessionId: r.session_id,
    aplDiff: r.apl_diff,
    results: parseJson(r.results),
    aggregate: parseJson(r.aggregate),
    createdAt: r.created_at,
  };
}

// --- Session State ---

export function setSessionState(key, value, s) {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO session_state (key, spec, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `,
  ).run(key, s || spec(), jsonCol(value));
}

export function getSessionState(key, s) {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM session_state WHERE key = ? AND spec = ?")
    .get(key, s || spec());
  return row ? parseJson(row.value) : null;
}

export function getAllSessionState(s) {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM session_state WHERE spec = ?")
    .all(s || spec());
  const state = {};
  for (const r of rows) state[r.key] = parseJson(r.value);
  return state;
}

export function clearSession(s) {
  const db = getDb();
  const specName = s || spec();
  db.prepare("DELETE FROM session_state WHERE spec = ?").run(specName);
  db.prepare("DELETE FROM baseline_dps WHERE spec = ?").run(specName);
}

// --- Baseline DPS ---

export function setBaselineDps(
  buildHash,
  scenario,
  dps,
  { sessionId, isCurrent = false, spec: s } = {},
) {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO baseline_dps (build_hash, spec, session_id, scenario, dps, is_current)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    buildHash,
    s || spec(),
    sessionId || "",
    scenario,
    dps,
    isCurrent ? 1 : 0,
  );
}

export function getBaselineDps(sessionId, { isCurrent = false, spec: s } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT build_hash, scenario, dps FROM baseline_dps WHERE spec = ? AND session_id = ? AND is_current = ?",
    )
    .all(s || spec(), sessionId, isCurrent ? 1 : 0);

  const result = {};
  for (const r of rows) {
    if (!result[r.build_hash]) result[r.build_hash] = {};
    result[r.build_hash][r.scenario] = r.dps;
  }
  return result;
}

export function updateBaselineDpsCurrent(
  sessionId,
  buildHash,
  scenario,
  dps,
  s,
) {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO baseline_dps (build_hash, spec, session_id, scenario, dps, is_current)
    VALUES (?, ?, ?, ?, ?, 1)
  `,
  ).run(buildHash, s || spec(), sessionId, scenario, dps);
}

// --- Build Operations ---

export function upsertBuild(build) {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO builds (hash, spec, name, hero_tree, archetype, overrides, dps_st, dps_small_aoe, dps_big_aoe, weighted, rank, source, pinned, in_roster, validated, validation_errors, last_tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    build.hash,
    build.spec || spec(),
    build.name || null,
    build.heroTree || build.hero_tree || null,
    build.archetype || null,
    jsonCol(build.overrides),
    build.dps?.st ?? build.dps_st ?? null,
    build.dps?.small_aoe ?? build.dps_small_aoe ?? null,
    build.dps?.big_aoe ?? build.dps_big_aoe ?? null,
    build.weighted ?? null,
    build.rank ?? null,
    build.source || "doe",
    build.pinned ? 1 : 0,
    build.inRoster ?? build.in_roster ?? 0,
    build.validated ? 1 : 0,
    jsonCol(build.validationErrors || build.validation_errors),
    build.lastTestedAt || build.last_tested_at || null,
  );
}

export function queryBuilds({
  heroTree,
  minWeighted,
  archetype,
  inRoster,
  limit = 50,
  spec: s,
} = {}) {
  const db = getDb();
  let sql = "SELECT * FROM builds WHERE spec = ?";
  const params = [s || spec()];
  if (heroTree) {
    sql += " AND hero_tree = ?";
    params.push(heroTree);
  }
  if (minWeighted != null) {
    sql += " AND weighted >= ?";
    params.push(minWeighted);
  }
  if (archetype) {
    sql += " AND archetype = ?";
    params.push(archetype);
  }
  if (inRoster != null) {
    sql += " AND in_roster = ?";
    params.push(inRoster ? 1 : 0);
  }
  sql += " ORDER BY weighted DESC LIMIT ?";
  params.push(limit);
  return db
    .prepare(sql)
    .all(...params)
    .map(rowToBuild);
}

export function getTopBuilds(n = 10) {
  return queryBuilds({ limit: n });
}

export function getRosterBuilds(s) {
  return queryBuilds({ inRoster: true, limit: 200, spec: s });
}

export function setRosterMembership(hash, inRoster, s) {
  const db = getDb();
  db.prepare("UPDATE builds SET in_roster = ? WHERE hash = ? AND spec = ?").run(
    inRoster ? 1 : 0,
    hash,
    s || spec(),
  );
}

export function updateBuildDps(hash, dps, s) {
  const db = getDb();
  const weighted =
    (dps.st || 0) * 0.5 + (dps.small_aoe || 0) * 0.3 + (dps.big_aoe || 0) * 0.2;
  db.prepare(
    `
    UPDATE builds SET dps_st = ?, dps_small_aoe = ?, dps_big_aoe = ?, weighted = ?, last_tested_at = datetime('now')
    WHERE hash = ? AND spec = ?
  `,
  ).run(
    dps.st ?? null,
    dps.small_aoe ?? null,
    dps.big_aoe ?? null,
    weighted,
    hash,
    s || spec(),
  );
}

function rowToBuild(r) {
  return {
    ...r,
    heroTree: r.hero_tree,
    overrides: parseJson(r.overrides),
    inRoster: !!r.in_roster,
    validationErrors: parseJson(r.validation_errors),
    lastTestedAt: r.last_tested_at,
    discoveredAt: r.discovered_at,
  };
}

// --- Archetype Operations ---

export function upsertArchetype(archetype) {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO archetypes (name, spec, hero_tree, defining_talents, description, core_loop, best_build_hash, build_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    archetype.name,
    archetype.spec || spec(),
    archetype.heroTree || archetype.hero_tree || null,
    jsonCol(archetype.definingTalents || archetype.defining_talents),
    archetype.description || null,
    archetype.coreLoop || archetype.core_loop || null,
    archetype.bestBuild?.hash || archetype.best_build_hash || null,
    archetype.buildCount ?? archetype.build_count ?? 0,
  );
}

export function getArchetypes(s) {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM archetypes WHERE spec = ? ORDER BY build_count DESC",
    )
    .all(s || spec())
    .map((r) => ({
      ...r,
      heroTree: r.hero_tree,
      definingTalents: parseJson(r.defining_talents),
      coreLoop: r.core_loop,
      bestBuildHash: r.best_build_hash,
      buildCount: r.build_count,
    }));
}

// --- Factor Operations ---

export function upsertFactor(factor, runId) {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO factors (spec, talent, node_id, factor_type, main_effect, pct, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    factor.spec || spec(),
    factor.talent,
    factor.nodeId ?? factor.node_id ?? null,
    factor.factorType || factor.factor_type || null,
    factor.mainEffect ?? factor.main_effect ?? null,
    factor.pct ?? null,
    runId,
  );
}

export function getFactors({ runId, limit = 200, spec: s } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM factors WHERE spec = ?";
  const params = [s || spec()];
  if (runId) {
    sql += " AND run_id = ?";
    params.push(runId);
  }
  sql += " ORDER BY ABS(main_effect) DESC LIMIT ?";
  params.push(limit);
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => ({
      ...r,
      nodeId: r.node_id,
      factorType: r.factor_type,
      mainEffect: r.main_effect,
    }));
}

// --- Synergy Operations ---

export function upsertSynergy(talentA, talentB, interaction, runId, s) {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO synergies (talent_a, talent_b, spec, interaction, run_id)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(talentA, talentB, s || spec(), interaction, runId || null);
}

export function getSynergies({ runId, limit = 100, spec: s } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM synergies WHERE spec = ?";
  const params = [s || spec()];
  if (runId) {
    sql += " AND run_id = ?";
    params.push(runId);
  }
  sql += " ORDER BY ABS(interaction) DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// --- Legacy compatibility aliases ---

// Old API: getPendingHypotheses(limit)
export function getPendingHypotheses(limit = 20) {
  return getHypotheses({ status: "pending", limit });
}

// Old API: updateHypothesisStatus(id, status, findingId)
export function updateHypothesisStatus(id, status, findingId = null) {
  const updates = { status };
  if (findingId) updates.finding_id = findingId;
  if (status === "testing") updates.tested_at = new Date().toISOString();
  updateHypothesis(id, updates);
}

// Old API: getBuildsDb() / getFindingsDb() — return the unified DB
export function getBuildsDb() {
  return getDb();
}
export function getFindingsDb() {
  return getDb();
}

// --- JSON Export ---

export function exportToJson(s) {
  const specName = s || spec();
  ensureSpecDirs(specName);

  // Export builds.json
  const allBuilds = queryBuilds({ limit: 500, spec: specName });
  const factorsList = getFactors({ spec: specName });
  const archetypesList = getArchetypes(specName);
  const synergiesList = getSynergies({ spec: specName });

  const buildsExport = {
    _schema: "builds-v1",
    _generated: new Date().toISOString(),
    _source: "theorycraft.db",
    allBuilds: allBuilds.map((b) => ({
      hash: b.hash,
      name: b.name,
      heroTree: b.heroTree,
      archetype: b.archetype,
      dps: { st: b.dps_st, small_aoe: b.dps_small_aoe, big_aoe: b.dps_big_aoe },
      weighted: b.weighted,
      rank: b.rank,
      pinned: !!b.pinned,
    })),
    factorImpacts: factorsList.map((f) => ({
      talent: f.talent,
      nodeId: f.nodeId,
      factorType: f.factorType,
      mainEffect: f.mainEffect,
      pct: f.pct,
    })),
    discoveredArchetypes: archetypesList.map((a) => ({
      name: a.name,
      heroTree: a.heroTree,
      definingTalents: a.definingTalents,
      description: a.description,
      bestBuild: a.bestBuildHash ? { hash: a.bestBuildHash } : null,
      buildCount: a.buildCount,
    })),
    synergyPairs: synergiesList.map((s) => ({
      talents: [s.talent_a, s.talent_b],
      interaction: s.interaction,
    })),
  };
  writeFileSync(
    resultsFile("builds.json", specName),
    JSON.stringify(buildsExport, null, 2),
  );

  // Export findings.json
  const findingsList = getFindings({
    status: "active",
    limit: 500,
    spec: specName,
  }).concat(getFindings({ status: "validated", limit: 500, spec: specName }));
  const findingsExport = {
    _schema: "findings-v1",
    _generated: new Date().toISOString(),
    findings: findingsList.map((f) => ({
      date: f.createdAt?.slice(0, 10),
      insight: f.insight,
      evidence: f.evidence,
      confidence: f.confidence,
      scope: f.scope,
      archetype: f.archetype,
      heroTree: f.heroTree,
      impact: f.impact,
      mechanism: f.mechanism,
      aplVersion: f.apl_version,
      status: f.status,
      tags: f.tags,
    })),
  };
  writeFileSync(
    resultsFile("findings.json", specName),
    JSON.stringify(findingsExport, null, 2),
  );

  // Export hypotheses.json
  const hypothesesList = getHypotheses({ limit: 500, spec: specName });
  const hypothesesExport = {
    _schema: "hypotheses-v1",
    _generated: new Date().toISOString(),
    hypotheses: hypothesesList.map((h) => ({
      id: h.id,
      theoryId: h.theoryId,
      summary: h.summary,
      implementation: h.implementation,
      mutation: h.mutation,
      category: h.category,
      priority: h.priority,
      status: h.status,
      source: h.source,
      archetype: h.archetype,
      reason: h.reason,
    })),
  };
  writeFileSync(
    resultsFile("hypotheses.json", specName),
    JSON.stringify(hypothesesExport, null, 2),
  );

  // Export build-roster.json (to data/ dir)
  const rosterBuilds = getRosterBuilds(specName);
  const rosterExport = {
    _schema: "roster-v2",
    _updated: new Date().toISOString(),
    _source: "theorycraft.db",
    builds: rosterBuilds.map((b) => ({
      id: b.name || b.hash.slice(0, 12),
      archetype: b.archetype,
      heroTree: b.heroTree,
      hash: b.hash,
      overrides: b.overrides,
      source: b.source,
      addedAt: b.discoveredAt,
      validated: !!b.validated,
      validationErrors: b.validationErrors,
      lastDps: {
        st: b.dps_st,
        small_aoe: b.dps_small_aoe,
        big_aoe: b.dps_big_aoe,
        weighted: b.weighted,
      },
      lastTestedAt: b.lastTestedAt,
    })),
  };
  writeFileSync(
    dataFile("build-roster.json", specName),
    JSON.stringify(rosterExport, null, 2),
  );

  return {
    builds: allBuilds.length,
    findings: findingsList.length,
    hypotheses: hypothesesList.length,
    roster: rosterBuilds.length,
  };
}

// --- Migration from old DB + JSON files ---

export function migrateFromLegacy(s) {
  const specName = s || spec();
  const db = getDb(specName);
  let stats = {
    builds: 0,
    factors: 0,
    archetypes: 0,
    synergies: 0,
    findings: 0,
    hypotheses: 0,
  };

  db.exec("BEGIN");
  try {
    // Import from builds.json
    const buildsJsonPath = resultsFile("builds.json", specName);
    if (existsSync(buildsJsonPath)) {
      const data = JSON.parse(readFileSync(buildsJsonPath, "utf-8"));
      const runId = data._generated || "imported";

      if (data.allBuilds) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO builds (hash, spec, name, hero_tree, dps_st, dps_small_aoe, dps_big_aoe, weighted, rank, pinned)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const b of data.allBuilds) {
          stmt.run(
            b.hash,
            specName,
            b.name || null,
            b.heroTree || null,
            b.dps?.st ?? null,
            b.dps?.small_aoe ?? null,
            b.dps?.big_aoe ?? null,
            b.weighted ?? null,
            b.rank ?? null,
            b.pinned ? 1 : 0,
          );
          stats.builds++;
        }
      }

      if (data.discoveredArchetypes) {
        const archStmt = db.prepare(`
          INSERT OR REPLACE INTO archetypes (name, spec, hero_tree, defining_talents, best_build_hash, build_count)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const updateStmt = db.prepare(
          "UPDATE builds SET archetype = ? WHERE hash = ? AND spec = ?",
        );
        for (const a of data.discoveredArchetypes) {
          archStmt.run(
            a.name,
            specName,
            a.heroTree || null,
            jsonCol(a.definingTalents || []),
            a.bestBuild?.hash || null,
            a.buildCount ?? 0,
          );
          stats.archetypes++;
          if (a.bestBuild?.hash)
            updateStmt.run(a.name, a.bestBuild.hash, specName);
          for (const b of a.builds || []) {
            if (b.hash) updateStmt.run(a.name, b.hash, specName);
          }
        }
      }

      if (data.factorImpacts) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO factors (spec, talent, node_id, factor_type, main_effect, pct, run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const f of data.factorImpacts) {
          stmt.run(
            specName,
            f.talent,
            f.nodeId ?? null,
            f.factorType || null,
            f.mainEffect ?? null,
            f.pct ?? null,
            runId,
          );
          stats.factors++;
        }
      }

      if (data.synergyPairs) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO synergies (talent_a, talent_b, spec, interaction, run_id)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const pair of data.synergyPairs) {
          const [a, b] = pair.talents || [];
          if (a && b) {
            stmt.run(a, b, specName, pair.pct ?? pair.interaction ?? 0, runId);
            stats.synergies++;
          }
        }
      }
    }

    // Import from findings.json
    const findingsJsonPath = resultsFile("findings.json", specName);
    if (existsSync(findingsJsonPath)) {
      const data = JSON.parse(readFileSync(findingsJsonPath, "utf-8"));
      if (data.findings) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO findings (spec, insight, evidence, confidence, apl_version, status, tags, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const f of data.findings) {
          stmt.run(
            specName,
            f.insight,
            f.evidence || null,
            f.confidence || "medium",
            f.aplVersion || null,
            f.status || "pending",
            jsonCol(f.tags),
            f.date ? f.date + "T00:00:00" : new Date().toISOString(),
          );
          stats.findings++;
        }
      }
    }

    // Import from build-roster.json
    const rosterJsonPath = dataFile("build-roster.json", specName);
    if (existsSync(rosterJsonPath)) {
      const data = JSON.parse(readFileSync(rosterJsonPath, "utf-8"));
      if (data.builds) {
        for (const b of data.builds) {
          const hash = b.hash;
          if (!hash) continue;
          // Upsert build with roster flag
          db.prepare(
            `
            INSERT INTO builds (hash, spec, name, hero_tree, archetype, overrides, dps_st, dps_small_aoe, dps_big_aoe, weighted, source, in_roster, validated, validation_errors, last_tested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(hash) DO UPDATE SET
              in_roster = 1,
              archetype = COALESCE(excluded.archetype, builds.archetype),
              overrides = COALESCE(excluded.overrides, builds.overrides),
              dps_st = COALESCE(excluded.dps_st, builds.dps_st),
              dps_small_aoe = COALESCE(excluded.dps_small_aoe, builds.dps_small_aoe),
              dps_big_aoe = COALESCE(excluded.dps_big_aoe, builds.dps_big_aoe),
              weighted = COALESCE(excluded.weighted, builds.weighted),
              validated = COALESCE(excluded.validated, builds.validated),
              validation_errors = COALESCE(excluded.validation_errors, builds.validation_errors),
              last_tested_at = COALESCE(excluded.last_tested_at, builds.last_tested_at)
          `,
          ).run(
            hash,
            specName,
            b.id || null,
            b.heroTree || null,
            b.archetype || null,
            jsonCol(b.overrides),
            b.lastDps?.st ?? null,
            b.lastDps?.small_aoe ?? null,
            b.lastDps?.big_aoe ?? null,
            b.lastDps?.weighted ?? null,
            b.source || "doe",
            b.validated ? 1 : 0,
            jsonCol(b.validationErrors),
            b.lastTestedAt || null,
          );
        }
      }
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return stats;
}

// --- Legacy compat: importBuildsFromJson / importFindingsFromJson ---
// These are used by the old db:migrate CLI command. Redirect to unified migration.

export function importBuildsFromJson(jsonPath) {
  if (!existsSync(jsonPath)) return { imported: 0 };
  // The migration is now handled by migrateFromLegacy which reads all files.
  // For backward compat, just do the builds part inline.
  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const db = getDb();
  let imported = 0;
  if (data.allBuilds) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO builds (hash, spec, name, hero_tree, dps_st, dps_small_aoe, dps_big_aoe, weighted, rank, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of data.allBuilds) {
      stmt.run(
        b.hash,
        spec(),
        b.name || null,
        b.heroTree || null,
        b.dps?.st ?? null,
        b.dps?.small_aoe ?? null,
        b.dps?.big_aoe ?? null,
        b.weighted ?? null,
        b.rank ?? null,
        b.pinned ? 1 : 0,
      );
      imported++;
    }
  }
  return { imported };
}

export function importFindingsFromJson(jsonPath) {
  if (!existsSync(jsonPath)) return { imported: 0 };
  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const db = getDb();
  let imported = 0;
  if (data.findings) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO findings (spec, insight, evidence, confidence, apl_version, status, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of data.findings) {
      stmt.run(
        spec(),
        f.insight,
        f.evidence || null,
        f.confidence || "medium",
        f.aplVersion || null,
        f.status || "pending",
        jsonCol(f.tags),
        f.date ? f.date + "T00:00:00" : new Date().toISOString(),
      );
      imported++;
    }
  }
  return { imported };
}

// --- CLI ---

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await initSpec(parseSpecArg());
  const cmd = process.argv[2];

  if (cmd === "migrate") {
    console.log("Migrating legacy data to unified theorycraft.db...");
    const stats = migrateFromLegacy();
    console.log(
      `Imported: ${stats.builds} builds, ${stats.factors} factors, ${stats.archetypes} archetypes, ${stats.synergies} synergies, ${stats.findings} findings`,
    );
    closeAll();
  } else if (cmd === "export") {
    const counts = exportToJson();
    console.log(
      `Exported: ${counts.builds} builds, ${counts.findings} findings, ${counts.hypotheses} hypotheses, ${counts.roster} roster builds`,
    );
    closeAll();
  } else if (cmd === "status") {
    const db = getDb();
    const tables = [
      ["Theories", "theories"],
      ["Hypotheses", "hypotheses"],
      ["Findings", "findings"],
      ["Builds", "builds"],
      ["  (in roster)", "builds WHERE in_roster = 1"],
      ["Archetypes", "archetypes"],
      ["Factors", "factors"],
      ["Synergies", "synergies"],
      ["Iterations", "iterations"],
      ["Session state", "session_state"],
    ];
    console.log(`Database: ${resultsFile("theorycraft.db")}\n`);
    for (const [label, table] of tables) {
      const count = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n;
      console.log(`${label.padEnd(18)} ${count}`);
    }
    closeAll();
  } else if (cmd === "top") {
    const n = parseInt(process.argv[3]) || 10;
    const builds = getTopBuilds(n);
    for (const b of builds) {
      console.log(
        `${(b.rank || "-").toString().padStart(3)}. ${(b.name || b.hash).padEnd(40)} ${b.weighted?.toFixed(0) || "?"} weighted  (${b.hero_tree || "?"})`,
      );
    }
    closeAll();
  } else {
    console.log("Usage: node src/util/db.js <migrate|export|status|top [n]>");
  }
}
