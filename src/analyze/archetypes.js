// Archetype definitions for spec builds.
// DB-first: all reads go through theorycraft.db via db.js.
// No JSON file I/O — the DB is the single source of truth.

import { initSpec } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { dataFile } from "../engine/paths.js";
import { readFileSync } from "node:fs";
import {
  getArchetypes as dbGetArchetypes,
  getTalentClusters,
  getClusterSynergies as dbGetClusterSynergies,
  getTensionPoints as dbGetTensionPoints,
  getFindings,
  getHypotheses,
  getFactors,
  getSynergies,
  queryBuilds,
  closeAll,
} from "../util/db.js";

// --- Archetype loading (DB-first) ---

function loadArchetypes() {
  const dbArchetypes = dbGetArchetypes();
  return Object.fromEntries(
    dbArchetypes.map((arch) => [
      arch.name,
      {
        heroTree: arch.heroTree || arch.hero_tree,
        description: arch.description,
        coreLoop: arch.coreLoop || arch.core_loop,
        keyTalents: arch.keyTalents || arch.key_talents || [],
        keyBuffs: [],
        keyAbilities: [],
        tradeoffs: arch.tensions,
        aplFocus: arch.aplFocus || arch.apl_focus || [],
        clusters: arch.definingTalents || arch.defining_talents || [],
        tensions: arch.tensions,
      },
    ]),
  );
}

// --- Core archetype detection ---

export function detectArchetype(talents, heroTree = null) {
  const archetypes = loadArchetypes();
  const matches = [];

  for (const [id, archetype] of Object.entries(archetypes)) {
    if (heroTree && archetype.heroTree !== heroTree) continue;

    if (!talents && heroTree) {
      matches.push({
        id,
        archetype,
        score: 0,
        maxScore: 0,
        confidence: 0.5,
      });
      continue;
    }

    let score = 0;
    let maxScore = 0;

    for (const talent of archetype.keyTalents || []) {
      maxScore += 2;
      if (hasTalent(talents, talent)) score += 2;
    }

    if (maxScore > 0 && score / maxScore >= 0.5) {
      matches.push({
        id,
        archetype,
        score,
        maxScore,
        confidence: score / maxScore,
      });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

function hasTalent(talents, talentName) {
  if (!talents) return false;
  const normalizedName = normalize(talentName);
  const entries = Array.isArray(talents) ? talents : Object.keys(talents);
  return entries.some((t) => normalize(t.name || t) === normalizedName);
}

function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function getPrimaryArchetype(talents, heroTree = null) {
  const matches = detectArchetype(talents, heroTree);
  return matches[0] || null;
}

export function describeArchetype(archetypeId) {
  const archetypes = loadArchetypes();
  const arch = archetypes[archetypeId];
  if (!arch) return null;

  return {
    id: archetypeId,
    heroTree: arch.heroTree,
    description: arch.description,
    coreLoop: arch.coreLoop,
    keyBuffs: arch.keyBuffs || [],
    keyAbilities: arch.keyAbilities || [],
    tradeoffs: arch.tradeoffs,
    aplFocus: arch.aplFocus || [],
  };
}

export function getArchetypesForTree(heroTree) {
  const archetypes = loadArchetypes();
  return Object.entries(archetypes)
    .filter(([, arch]) => arch.heroTree === heroTree)
    .map(([id, arch]) => ({ id, ...arch }));
}

export function getStrategicBuffs(archetypeId) {
  const archetypes = loadArchetypes();
  return archetypes[archetypeId]?.keyBuffs || [];
}

export function getCoreAbilities(archetypeId) {
  const archetypes = loadArchetypes();
  return archetypes[archetypeId]?.keyAbilities || [];
}

export function getAllArchetypes() {
  return { ...loadArchetypes() };
}

// --- Build theory knowledge exports (DB-first) ---

export function getSpecClusters() {
  return getTalentClusters();
}

export function getHeroTreeMechanics(heroTree) {
  // Hero tree mechanics are part of the spec adapter, not the DB.
  // Return null — callers should use getSpecAdapter().getSpecConfig().heroTrees[heroTree]
  return null;
}

export function getClusterSynergies(clusterId, heroTree) {
  const synergies = dbGetClusterSynergies();
  if (clusterId && heroTree) {
    return (
      synergies.find(
        (s) =>
          s.cluster === clusterId && (s.heroTree || s.hero_tree) === heroTree,
      ) || null
    );
  }
  if (clusterId) return synergies.filter((s) => s.cluster === clusterId);
  if (heroTree)
    return synergies.filter((s) => (s.heroTree || s.hero_tree) === heroTree);
  return synergies;
}

export function getTensionPoints() {
  return dbGetTensionPoints();
}

// --- Discovered archetypes from DB ---

export function loadDiscoveredArchetypes() {
  const archetypes = dbGetArchetypes();
  if (!archetypes || archetypes.length === 0) return null;
  return archetypes.map((a) => ({
    name: a.name,
    heroTree: a.heroTree || a.hero_tree,
    definingTalents: a.definingTalents || a.defining_talents || [],
    bestBuild: { hash: a.bestBuildHash || a.best_build_hash, weighted: 0 },
    buildCount: a.buildCount || a.build_count || 0,
  }));
}

export function getDiscoveredBuilds() {
  return queryBuilds({ limit: 500 });
}

export function getFactorImpacts() {
  const factors = getFactors({ limit: 200 });
  return factors.length > 0 ? factors : null;
}

export function getSynergyPairs() {
  const synergies = getSynergies({ limit: 100 });
  return synergies.length > 0 ? synergies : null;
}

export function getBestBuildHash(heroTree) {
  const archetypes = dbGetArchetypes();
  if (!archetypes) return null;
  const normalizedTree = heroTree.toLowerCase().replace(/\s+/g, "_");
  const match = archetypes.find(
    (a) => (a.heroTree || a.hero_tree) === normalizedTree,
  );
  return match?.bestBuildHash || match?.best_build_hash || null;
}

// --- Knowledge system helpers (DB-first) ---

export function getValidatedFindings() {
  return getFindings({ status: "validated" });
}

export function getMechanics(topic) {
  const findings = getFindings({ status: "validated" });
  const mechFindings = findings.filter(
    (f) => f.scope === "mechanic" && f.mechanism === topic,
  );
  if (mechFindings.length === 0) return null;

  const f = mechFindings[0];
  let evidence;
  try {
    evidence =
      typeof f.evidence === "string" ? JSON.parse(f.evidence) : f.evidence;
  } catch {
    evidence = {};
  }

  return {
    summary: f.insight,
    facts: evidence?.facts || [],
    simcExpressions: evidence?.simcExpressions || [],
    aplImplications: evidence?.aplImplications || [],
    verified: f.createdAt || f.created_at,
  };
}

export function isHypothesisTested(id) {
  const hypotheses = getHypotheses({ limit: 500 });
  const h = hypotheses.find((h) => h.id === id);
  return h ? h.status !== "pending" : false;
}

export function getUntestedHypotheses() {
  return getHypotheses({ status: "pending" });
}

// --- CLI entry point ---

if (import.meta.url === `file://${process.argv[1]}`) {
  await initSpec(parseSpecArg());
  const talentsPath = process.argv[2] || dataFile("talents.json");
  const archetypes = loadArchetypes();

  console.log("=".repeat(60));
  console.log("Archetype System (DB-first)");
  console.log("=".repeat(60));

  // Show discovered archetypes
  const discovered = loadDiscoveredArchetypes();
  if (discovered) {
    console.log("\n--- Discovered Archetypes ---\n");
    for (const arch of discovered) {
      console.log(`${arch.name} (${arch.heroTree})`);
      console.log(
        `  Defining talents: ${(arch.definingTalents || []).join(", ") || "none"}`,
      );
      if (arch.bestBuild?.hash) {
        console.log(
          `  Best build hash: ${arch.bestBuild.hash.slice(0, 40)}...`,
        );
      }
      console.log(`  Builds: ${arch.buildCount}`);
      console.log();
    }

    const impacts = getFactorImpacts();
    if (impacts) {
      console.log("--- Top Factor Impacts ---\n");
      for (const fi of impacts.slice(0, 10)) {
        const sign = (fi.mainEffect || fi.main_effect || 0) >= 0 ? "+" : "";
        console.log(
          `  ${fi.talent.padEnd(25)} ${sign}${fi.mainEffect || fi.main_effect || 0} (${sign}${fi.pct}%)`,
        );
      }
    }
  }

  // Show spec clusters
  const clusters = getSpecClusters();
  if (clusters.length > 0) {
    console.log("\n--- Spec Clusters ---\n");
    for (const cluster of clusters) {
      console.log(`${cluster.id} — ${cluster.name} (${cluster.role || "?"})`);
      const talents = Array.isArray(cluster.talents)
        ? cluster.talents.join(", ")
        : cluster.talents;
      console.log(`  Talents: ${talents}`);
      console.log(`  Loop: ${cluster.coreLoop || cluster.core_loop || "?"}`);
      console.log();
    }
  }

  // Show cluster synergies summary
  const synergies = getClusterSynergies();
  if (synergies.length > 0) {
    console.log("--- Cluster x Hero Tree Synergies ---\n");
    const grouped = {};
    for (const s of synergies) {
      const tree = s.heroTree || s.hero_tree;
      grouped[s.cluster] = grouped[s.cluster] || {};
      grouped[s.cluster][tree] = s.rating || s.synergy_rating;
    }
    console.log(`${"Cluster".padEnd(20)} ${"AR".padEnd(12)} Anni`);
    console.log("-".repeat(44));
    for (const [cluster, ratings] of Object.entries(grouped)) {
      console.log(
        `${cluster.padEnd(20)} ${(ratings.aldrachi_reaver || "-").padEnd(12)} ${ratings.annihilator || "-"}`,
      );
    }
  }

  // Show theoretical archetypes
  console.log("\n--- Build Archetypes ---\n");
  for (const [id, arch] of Object.entries(archetypes)) {
    console.log(`${id} (${arch.heroTree})`);
    console.log(`  Core loop: ${arch.coreLoop || "?"}`);
    console.log(`  Key talents: ${arch.keyTalents?.join(", ") || "none"}`);
    console.log(`  Tradeoffs: ${arch.tradeoffs || "?"}`);
    console.log();
  }

  // Show tension points
  const tensions = getTensionPoints();
  if (tensions.length > 0) {
    console.log("--- Tension Points ---\n");
    for (const tp of tensions) {
      console.log(`${tp.id}: ${tp.description}`);
      console.log(`  ${tp.explanation || ""}`);
      const affected = tp.affectedArchetypes || tp.affected_archetypes;
      if (affected) {
        const list = Array.isArray(affected) ? affected.join(", ") : affected;
        console.log(`  Affects: ${list}`);
      }
      console.log();
    }
  }

  // If talents file provided, try to detect archetype
  try {
    const talents = JSON.parse(readFileSync(talentsPath, "utf-8"));

    console.log("--- Archetype Detection ---\n");

    const arMatches = detectArchetype(talents, "aldrachi_reaver");
    console.log("Aldrachi Reaver matches:");
    for (const match of arMatches) {
      console.log(
        `  ${match.id}: ${(match.confidence * 100).toFixed(0)}% confidence`,
      );
    }

    const anniMatches = detectArchetype(talents, "annihilator");
    console.log("\nAnnihilator matches:");
    for (const match of anniMatches) {
      console.log(
        `  ${match.id}: ${(match.confidence * 100).toFixed(0)}% confidence`,
      );
    }
  } catch (e) {
    console.log(`(Could not load talents from ${talentsPath})`);
  }

  closeAll();
}
