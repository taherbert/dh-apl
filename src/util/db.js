// SQLite database for builds and findings.
// Uses Node.js 23 built-in sqlite module (no external deps).
// Database files live in results/ alongside existing JSON.

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(ROOT, "results");

const BUILDS_DB_PATH = join(RESULTS_DIR, "builds.db");
const FINDINGS_DB_PATH = join(RESULTS_DIR, "findings.db");

// --- Schema definitions ---

const BUILDS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS builds (
    hash TEXT PRIMARY KEY,
    name TEXT,
    hero_tree TEXT,
    dps_st REAL,
    dps_small_aoe REAL,
    dps_big_aoe REAL,
    weighted REAL,
    rank INTEGER,
    archetype TEXT,
    pinned INTEGER DEFAULT 0,
    discovered_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS factors (
    talent TEXT NOT NULL,
    node_id INTEGER,
    factor_type TEXT,
    main_effect REAL,
    pct REAL,
    run_id TEXT,
    UNIQUE(talent, run_id)
  );

  CREATE TABLE IF NOT EXISTS archetypes (
    name TEXT PRIMARY KEY,
    hero_tree TEXT,
    defining_talents TEXT,  -- JSON array
    best_build_hash TEXT,
    build_count INTEGER
  );

  CREATE TABLE IF NOT EXISTS synergy_pairs (
    talent_a TEXT,
    talent_b TEXT,
    synergy REAL,
    PRIMARY KEY (talent_a, talent_b)
  );

  CREATE INDEX IF NOT EXISTS idx_builds_weighted ON builds(weighted DESC);
  CREATE INDEX IF NOT EXISTS idx_builds_hero_tree ON builds(hero_tree);
  CREATE INDEX IF NOT EXISTS idx_factors_talent ON factors(talent);

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    apl TEXT,
    fidelity TEXT,
    scenarios TEXT,  -- JSON
    weights TEXT,    -- JSON
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

const FINDINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    insight TEXT NOT NULL,
    evidence TEXT,
    confidence TEXT,
    build TEXT,
    apl_version TEXT,
    status TEXT DEFAULT 'pending',
    tags TEXT,  -- JSON array
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);

  CREATE TABLE IF NOT EXISTS hypotheses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis TEXT NOT NULL,
    category TEXT,
    priority REAL,
    source TEXT,
    status TEXT DEFAULT 'pending',
    finding_id INTEGER,
    mutation TEXT,  -- JSON
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (finding_id) REFERENCES findings(id)
  );
`;

// --- Database access ---

let _buildsDb = null;
let _findingsDb = null;

export function getBuildsDb() {
  if (_buildsDb) return _buildsDb;
  _buildsDb = new DatabaseSync(BUILDS_DB_PATH);
  _buildsDb.exec(BUILDS_SCHEMA);
  return _buildsDb;
}

export function getFindingsDb() {
  if (_findingsDb) return _findingsDb;
  _findingsDb = new DatabaseSync(FINDINGS_DB_PATH);
  _findingsDb.exec(FINDINGS_SCHEMA);
  return _findingsDb;
}

export function closeAll() {
  if (_buildsDb) {
    _buildsDb.close();
    _buildsDb = null;
  }
  if (_findingsDb) {
    _findingsDb.close();
    _findingsDb = null;
  }
}

// --- Build operations ---

export function upsertBuild(build) {
  const db = getBuildsDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO builds (hash, name, hero_tree, dps_st, dps_small_aoe, dps_big_aoe, weighted, rank, archetype, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    build.hash,
    build.name || null,
    build.heroTree || null,
    build.dps?.st ?? null,
    build.dps?.small_aoe ?? null,
    build.dps?.big_aoe ?? null,
    build.weighted ?? null,
    build.rank ?? null,
    build.archetype || null,
    build.pinned ? 1 : 0,
  );
}

export function upsertFactor(factor, runId) {
  const db = getBuildsDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO factors (talent, node_id, factor_type, main_effect, pct, run_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    factor.talent,
    factor.nodeId ?? null,
    factor.factorType || null,
    factor.mainEffect ?? null,
    factor.pct ?? null,
    runId,
  );
}

export function upsertArchetype(archetype) {
  const db = getBuildsDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO archetypes (name, hero_tree, defining_talents, best_build_hash, build_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    archetype.name,
    archetype.heroTree || null,
    JSON.stringify(archetype.definingTalents || []),
    archetype.bestBuild?.hash || null,
    archetype.buildCount ?? 0,
  );
}

export function queryBuilds({ heroTree, minWeighted, limit = 50 } = {}) {
  const db = getBuildsDb();
  let sql = "SELECT * FROM builds WHERE 1=1";
  const params = [];
  if (heroTree) {
    sql += " AND hero_tree = ?";
    params.push(heroTree);
  }
  if (minWeighted != null) {
    sql += " AND weighted >= ?";
    params.push(minWeighted);
  }
  sql += " ORDER BY weighted DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function getTopBuilds(n = 10) {
  return queryBuilds({ limit: n });
}

// --- Findings operations ---

export function addFinding(finding) {
  const db = getFindingsDb();
  const stmt = db.prepare(`
    INSERT INTO findings (date, insight, evidence, confidence, build, apl_version, status, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    finding.date || new Date().toISOString().slice(0, 10),
    finding.insight,
    finding.evidence || null,
    finding.confidence || "medium",
    finding.build || null,
    finding.aplVersion || null,
    finding.status || "pending",
    JSON.stringify(finding.tags || []),
  );
  return info.lastInsertRowid;
}

export function addHypothesis(hypothesis) {
  const db = getFindingsDb();
  const stmt = db.prepare(`
    INSERT INTO hypotheses (hypothesis, category, priority, source, status, finding_id, mutation)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    hypothesis.hypothesis,
    hypothesis.category || null,
    hypothesis.priority ?? 0,
    hypothesis.source || null,
    hypothesis.status || "pending",
    hypothesis.findingId ?? null,
    hypothesis.mutation ? JSON.stringify(hypothesis.mutation) : null,
  );
  return info.lastInsertRowid;
}

export function getFindings({ status, confidence, limit = 100 } = {}) {
  const db = getFindingsDb();
  let sql = "SELECT * FROM findings WHERE 1=1";
  const params = [];
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (confidence) {
    sql += " AND confidence = ?";
    params.push(confidence);
  }
  sql += " ORDER BY date DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") }));
}

export function getPendingHypotheses(limit = 20) {
  const db = getFindingsDb();
  return db
    .prepare(
      "SELECT * FROM hypotheses WHERE status = 'pending' ORDER BY priority DESC LIMIT ?",
    )
    .all(limit)
    .map((r) => ({
      ...r,
      mutation: r.mutation ? JSON.parse(r.mutation) : null,
    }));
}

export function updateHypothesisStatus(id, status, findingId = null) {
  const db = getFindingsDb();
  if (findingId) {
    db.prepare(
      "UPDATE hypotheses SET status = ?, finding_id = ? WHERE id = ?",
    ).run(status, findingId, id);
  } else {
    db.prepare("UPDATE hypotheses SET status = ? WHERE id = ?").run(status, id);
  }
}

// --- Migration: import from existing JSON ---

export function importBuildsFromJson(jsonPath) {
  if (!existsSync(jsonPath)) return { imported: 0 };

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const db = getBuildsDb();

  let imported = 0;

  // Import builds
  if (data.allBuilds) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO builds (hash, name, hero_tree, dps_st, dps_small_aoe, dps_big_aoe, weighted, rank, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of data.allBuilds) {
      stmt.run(
        b.hash,
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

  // Import factors
  const runId = data._generated || "imported";
  if (data.factorImpacts) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO factors (talent, node_id, factor_type, main_effect, pct, run_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const f of data.factorImpacts) {
      stmt.run(
        f.talent,
        f.nodeId ?? null,
        f.factorType || null,
        f.mainEffect ?? null,
        f.pct ?? null,
        runId,
      );
    }
  }

  // Import archetypes
  if (data.discoveredArchetypes) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO archetypes (name, hero_tree, defining_talents, best_build_hash, build_count)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const a of data.discoveredArchetypes) {
      stmt.run(
        a.name,
        a.heroTree || null,
        JSON.stringify(a.definingTalents || []),
        a.bestBuild?.hash || null,
        a.buildCount ?? 0,
      );
    }
  }

  // Import synergy pairs
  if (data.synergyPairs) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO synergy_pairs (talent_a, talent_b, synergy)
      VALUES (?, ?, ?)
    `);
    for (const pair of data.synergyPairs) {
      const [a, b] = pair.talents || [];
      if (a && b) stmt.run(a, b, pair.pct ?? pair.interaction ?? 0);
    }
  }

  return { imported };
}

export function importFindingsFromJson(jsonPath) {
  if (!existsSync(jsonPath)) return { imported: 0 };

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const db = getFindingsDb();

  let imported = 0;
  if (data.findings) {
    const stmt = db.prepare(`
      INSERT INTO findings (date, insight, evidence, confidence, build, apl_version, status, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of data.findings) {
      stmt.run(
        f.date || null,
        f.insight,
        f.evidence || null,
        f.confidence || "medium",
        f.build || null,
        f.aplVersion || null,
        f.status || "pending",
        JSON.stringify(f.tags || []),
      );
      imported++;
    }
  }

  return { imported };
}

// --- CLI ---

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];

  if (cmd === "migrate") {
    const buildsResult = importBuildsFromJson(join(RESULTS_DIR, "builds.json"));
    console.log(`Imported ${buildsResult.imported} builds to SQLite`);

    const findingsResult = importFindingsFromJson(
      join(RESULTS_DIR, "findings.json"),
    );
    console.log(`Imported ${findingsResult.imported} findings to SQLite`);

    closeAll();
  } else if (cmd === "status") {
    const bdb = getBuildsDb();
    const fdb = getFindingsDb();
    console.log(
      "Builds:",
      bdb.prepare("SELECT COUNT(*) as n FROM builds").get().n,
    );
    console.log(
      "Factors:",
      bdb.prepare("SELECT COUNT(*) as n FROM factors").get().n,
    );
    console.log(
      "Archetypes:",
      bdb.prepare("SELECT COUNT(*) as n FROM archetypes").get().n,
    );
    console.log(
      "Findings:",
      fdb.prepare("SELECT COUNT(*) as n FROM findings").get().n,
    );
    console.log(
      "Hypotheses:",
      fdb.prepare("SELECT COUNT(*) as n FROM hypotheses").get().n,
    );
    closeAll();
  } else if (cmd === "top") {
    const n = parseInt(process.argv[3]) || 10;
    const builds = getTopBuilds(n);
    for (const b of builds) {
      console.log(
        `${b.rank || "-"}. ${(b.name || b.hash).padEnd(40)} ${b.weighted?.toFixed(0) || "?"} weighted  (${b.hero_tree || "?"})`,
      );
    }
    closeAll();
  } else {
    console.log("Usage: node src/util/db.js <migrate|status|top [n]>");
  }
}
