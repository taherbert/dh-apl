#!/usr/bin/env node
// Bridge migration: reads legacy builds.db + findings.db → theorycraft.db
// One-time script for the DB-first architecture transition.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { initSpec } from "../src/engine/startup.js";
import { parseSpecArg } from "../src/util/parse-spec-arg.js";
import { resultsFile, dataFile, getSpecName } from "../src/engine/paths.js";
import { getDb, closeAll } from "../src/util/db.js";

initSpec(parseSpecArg());
const specName = getSpecName();

const stats = {
  builds: 0,
  archetypes: 0,
  factors: 0,
  synergies: 0,
  findings: 0,
  roster: 0,
  iterations: 0,
};

// --- 1. Migrate from legacy builds.db ---
const buildsDbPath = resultsFile("builds.db", specName);
if (existsSync(buildsDbPath)) {
  console.log(`\nMigrating from ${buildsDbPath}...`);
  const legacy = new DatabaseSync(buildsDbPath);
  const db = getDb(specName);

  db.exec("BEGIN");
  try {
    // Builds
    const builds = legacy.prepare("SELECT * FROM builds").all();
    const buildStmt = db.prepare(`
      INSERT OR IGNORE INTO builds (hash, spec, name, hero_tree, archetype, dps_st, dps_small_aoe, dps_big_aoe, weighted, rank, pinned, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of builds) {
      buildStmt.run(
        b.hash,
        specName,
        b.name || null,
        b.hero_tree || null,
        b.archetype || null,
        b.dps_st ?? null,
        b.dps_small_aoe ?? null,
        b.dps_big_aoe ?? null,
        b.weighted ?? null,
        b.rank ?? null,
        b.pinned ?? 0,
        b.discovered_at || new Date().toISOString(),
      );
      stats.builds++;
    }
    console.log(`  Builds: ${stats.builds}`);

    // Archetypes
    const archetypes = legacy.prepare("SELECT * FROM archetypes").all();
    const archStmt = db.prepare(`
      INSERT OR REPLACE INTO archetypes (name, spec, hero_tree, defining_talents, best_build_hash, build_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const a of archetypes) {
      archStmt.run(
        a.name,
        specName,
        a.hero_tree || null,
        a.defining_talents || "[]",
        a.best_build_hash || null,
        a.build_count ?? 0,
      );
      stats.archetypes++;
    }
    console.log(`  Archetypes: ${stats.archetypes}`);

    // Factors
    const factors = legacy.prepare("SELECT * FROM factors").all();
    const factorStmt = db.prepare(`
      INSERT OR REPLACE INTO factors (spec, talent, node_id, factor_type, main_effect, pct, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of factors) {
      factorStmt.run(
        specName,
        f.talent,
        f.node_id ?? null,
        f.factor_type || null,
        f.main_effect ?? null,
        f.pct ?? null,
        f.run_id || "legacy",
      );
      stats.factors++;
    }
    console.log(`  Factors: ${stats.factors}`);

    // Synergies
    const synergies = legacy.prepare("SELECT * FROM synergy_pairs").all();
    const synStmt = db.prepare(`
      INSERT OR REPLACE INTO synergies (talent_a, talent_b, spec, interaction, run_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const s of synergies) {
      synStmt.run(s.talent_a, s.talent_b, specName, s.synergy ?? 0, "legacy");
      stats.synergies++;
    }
    console.log(`  Synergies: ${stats.synergies}`);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  legacy.close();
} else {
  console.log("No legacy builds.db found, skipping.");
}

// --- 2. Migrate from legacy findings.db ---
const findingsDbPath = resultsFile("findings.db", specName);
if (existsSync(findingsDbPath)) {
  console.log(`\nMigrating from ${findingsDbPath}...`);
  const legacy = new DatabaseSync(findingsDbPath);
  const db = getDb(specName);

  db.exec("BEGIN");
  try {
    const findings = legacy.prepare("SELECT * FROM findings").all();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO findings (spec, insight, evidence, confidence, apl_version, status, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of findings) {
      stmt.run(
        specName,
        f.insight,
        f.evidence || null,
        f.confidence || "medium",
        f.apl_version || null,
        f.status || "active",
        f.tags || null,
        f.created_at || new Date().toISOString(),
      );
      stats.findings++;
    }
    console.log(`  Findings: ${stats.findings}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  legacy.close();
} else {
  console.log("No legacy findings.db found, skipping.");
}

// --- 3. Import roster from build-roster.json ---
const rosterPath = resultsFile("build-roster.json", specName);
if (existsSync(rosterPath)) {
  console.log(`\nImporting roster from ${rosterPath}...`);
  const data = JSON.parse(readFileSync(rosterPath, "utf-8"));
  const db = getDb(specName);

  db.exec("BEGIN");
  try {
    if (data.builds) {
      for (const b of data.builds) {
        const hash = b.hash;
        if (!hash) continue;
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
          b.overrides ? JSON.stringify(b.overrides) : null,
          b.lastDps?.st ?? null,
          b.lastDps?.small_aoe ?? null,
          b.lastDps?.big_aoe ?? null,
          b.lastDps?.weighted ?? null,
          b.source || "doe",
          b.validated ? 1 : 0,
          b.validationErrors ? JSON.stringify(b.validationErrors) : null,
          b.lastTestedAt || null,
        );
        stats.roster++;
      }
    }
    console.log(`  Roster builds upserted: ${stats.roster}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
} else {
  console.log("No build-roster.json found, skipping.");
}

// --- 4. Import iteration history from iteration-state.json ---
const iterStatePath = resultsFile("iteration-state.json", specName);
if (existsSync(iterStatePath)) {
  console.log(`\nImporting iteration history from ${iterStatePath}...`);
  const data = JSON.parse(readFileSync(iterStatePath, "utf-8"));
  const db = getDb(specName);

  db.exec("BEGIN");
  try {
    if (data.iterations) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO iterations (spec, fidelity, apl_diff, results, aggregate, decision, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of data.iterations) {
        stmt.run(
          specName,
          it.fidelity || "quick",
          it.diff || it.aplDiff || null,
          JSON.stringify(it.results || it.builds || {}),
          JSON.stringify(it.aggregate || it.summary || {}),
          it.decision || it.status || null,
          it.reason || null,
          it.timestamp || it.createdAt || new Date().toISOString(),
        );
        stats.iterations++;
      }
    }
    console.log(`  Iterations: ${stats.iterations}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
} else {
  console.log("No iteration-state.json found, skipping.");
}

closeAll();
console.log("\n=== Migration Complete ===");
console.log(stats);
