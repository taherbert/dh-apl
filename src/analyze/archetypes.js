// Archetype definitions for Vengeance Demon Hunter builds.
// Archetypes are strategic build directions that inform hypothesis generation.
// Loaded from data/build-theory.json (curated) + results/builds.json (discovered).
// Usage: node src/analyze/archetypes.js [talents.json]

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const RESULTS_DIR = join(ROOT, "results");

const THEORY_PATH = join(DATA_DIR, "build-theory.json");

// --- Build theory loader ---

let _theoryCache = null;

function loadBuildTheory() {
  if (_theoryCache) return _theoryCache;
  try {
    _theoryCache = JSON.parse(readFileSync(THEORY_PATH, "utf8"));
    return _theoryCache;
  } catch (e) {
    throw new Error(`Failed to load build-theory.json: ${e.message}`);
  }
}

// Convert build-theory archetypes to the keyed format existing APIs expect.
// Maps buildArchetypes[] → { "ar-fragment-frailty": { heroTree, keyTalents, keyBuffs, ... }, ... }
function loadArchetypes() {
  const theory = loadBuildTheory();
  const result = {};
  for (const arch of theory.buildArchetypes) {
    result[arch.id] = {
      heroTree: arch.heroTree,
      description: arch.strengths,
      coreLoop: arch.coreLoop,
      keyTalents: arch.keyTalents || [],
      keyBuffs: arch.keyBuffs || [],
      keyAbilities: arch.keyAbilities || [],
      tradeoffs: arch.tradeoffs || arch.tensions,
      aplFocus: arch.aplFocus || [],
      clusters: arch.clusters || [],
      tensions: arch.tensions,
    };
  }
  return result;
}

// --- Core archetype detection ---

export function detectArchetype(talents, heroTree = null) {
  const archetypes = loadArchetypes();
  const matches = [];

  for (const [id, archetype] of Object.entries(archetypes)) {
    if (heroTree && archetype.heroTree !== heroTree) continue;

    // When talents is null but heroTree specified, return all archetypes for that tree
    // with baseline confidence (allows strategic hypotheses to use archetype context)
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

// --- Build theory knowledge exports ---

export function getSpecClusters() {
  return loadBuildTheory().specClusters;
}

export function getHeroTreeMechanics(heroTree) {
  return loadBuildTheory().heroTrees[heroTree] || null;
}

export function getClusterSynergies(clusterId, heroTree) {
  const synergies = loadBuildTheory().clusterSynergies;
  if (clusterId && heroTree) {
    return (
      synergies.find(
        (s) => s.cluster === clusterId && s.heroTree === heroTree,
      ) || null
    );
  }
  if (clusterId) return synergies.filter((s) => s.cluster === clusterId);
  if (heroTree) return synergies.filter((s) => s.heroTree === heroTree);
  return synergies;
}

export function getTensionPoints() {
  return loadBuildTheory().tensionPoints;
}

// --- Discovered archetypes from build discovery pipeline ---

let _discoveredCache = null;

function loadBuildsJson() {
  if (_discoveredCache) return _discoveredCache;
  const path = join(RESULTS_DIR, "builds.json");
  if (!existsSync(path)) return null;
  try {
    _discoveredCache = JSON.parse(readFileSync(path, "utf8"));
    return _discoveredCache;
  } catch {
    return null;
  }
}

export function loadDiscoveredArchetypes() {
  const data = loadBuildsJson();
  return data?.discoveredArchetypes || null;
}

export function getDiscoveredBuilds() {
  const data = loadBuildsJson();
  return data?.allBuilds || null;
}

export function getFactorImpacts() {
  const data = loadBuildsJson();
  return data?.factorImpacts || null;
}

export function getSynergyPairs() {
  const data = loadBuildsJson();
  return data?.synergyPairs || null;
}

export function getBestBuildHash(heroTree) {
  const archetypes = loadDiscoveredArchetypes();
  if (!archetypes) return null;
  const normalizedTree = heroTree.toLowerCase().replace(/\s+/g, "_");
  const match = archetypes.find((a) => a.heroTree === normalizedTree);
  return match?.bestBuild?.hash || null;
}

// --- Knowledge system helpers ---

const FINDINGS_PATH = join(RESULTS_DIR, "findings.json");
const MECHANICS_PATH = join(DATA_DIR, "mechanics.json");
const HYPOTHESES_PATH = join(RESULTS_DIR, "hypotheses.json");

// Load validated findings only
export function getValidatedFindings() {
  if (!existsSync(FINDINGS_PATH)) return [];
  try {
    const findings = JSON.parse(readFileSync(FINDINGS_PATH, "utf8"));
    return findings.filter((f) => f.status === "validated");
  } catch {
    return [];
  }
}

// Load mechanics for a topic
export function getMechanics(topic) {
  if (!existsSync(MECHANICS_PATH)) return null;
  try {
    const mechanics = JSON.parse(readFileSync(MECHANICS_PATH, "utf8"));
    return mechanics.mechanics?.[topic] || null;
  } catch {
    return null;
  }
}

// Check if hypothesis already tested
export function isHypothesisTested(id) {
  if (!existsSync(HYPOTHESES_PATH)) return false;
  try {
    const hypotheses = JSON.parse(readFileSync(HYPOTHESES_PATH, "utf8"));
    const h = hypotheses.hypotheses?.find((h) => h.id === id);
    return h?.tested ?? false;
  } catch {
    return false;
  }
}

// Load all untested hypotheses
export function getUntestedHypotheses() {
  if (!existsSync(HYPOTHESES_PATH)) return [];
  try {
    const hypotheses = JSON.parse(readFileSync(HYPOTHESES_PATH, "utf8"));
    return (hypotheses.hypotheses || []).filter((h) => !h.tested);
  } catch {
    return [];
  }
}

// --- CLI entry point ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const talentsPath = process.argv[2] || join(DATA_DIR, "talents.json");
  const archetypes = loadArchetypes();

  console.log("=".repeat(60));
  console.log("VDH Archetype System");
  console.log("=".repeat(60));

  // Show discovered archetypes first (from builds.json)
  const discovered = loadDiscoveredArchetypes();
  if (discovered) {
    console.log("\n--- Discovered Archetypes (from builds.json) ---\n");
    for (const arch of discovered) {
      console.log(`${arch.name} (${arch.heroTree})`);
      console.log(
        `  Defining talents: ${arch.definingTalents.join(", ") || "none"}`,
      );
      console.log(
        `  Best build: ${arch.bestBuild.name} — ${arch.bestBuild.weighted.toLocaleString()} weighted DPS`,
      );
      console.log(`  Hash: ${arch.bestBuild.hash?.slice(0, 40)}...`);
      console.log(`  Builds: ${arch.buildCount}`);
      console.log();
    }

    const impacts = getFactorImpacts();
    if (impacts) {
      console.log("--- Top Factor Impacts ---\n");
      for (const fi of impacts.slice(0, 10)) {
        const sign = fi.mainEffect >= 0 ? "+" : "";
        console.log(
          `  ${fi.talent.padEnd(25)} ${sign}${fi.mainEffect} (${sign}${fi.pct}%)`,
        );
      }
    }
  }

  // Show spec clusters
  const clusters = getSpecClusters();
  console.log("\n--- Spec Clusters ---\n");
  for (const cluster of clusters) {
    console.log(`${cluster.id} — ${cluster.name} (${cluster.role})`);
    console.log(`  Talents: ${cluster.talents.join(", ")}`);
    console.log(`  Loop: ${cluster.coreLoop}`);
    console.log();
  }

  // Show cluster synergies summary
  console.log("--- Cluster × Hero Tree Synergies ---\n");
  const synergies = getClusterSynergies();
  const grouped = {};
  for (const s of synergies) {
    grouped[s.cluster] = grouped[s.cluster] || {};
    grouped[s.cluster][s.heroTree] = s.rating;
  }
  console.log(`${"Cluster".padEnd(20)} ${"AR".padEnd(12)} Anni`);
  console.log("-".repeat(44));
  for (const [cluster, ratings] of Object.entries(grouped)) {
    console.log(
      `${cluster.padEnd(20)} ${(ratings.aldrachi_reaver || "-").padEnd(12)} ${ratings.annihilator || "-"}`,
    );
  }

  // Show theoretical archetypes
  console.log("\n--- Build Archetypes (from build-theory.json) ---\n");

  for (const [id, arch] of Object.entries(archetypes)) {
    console.log(`${id} (${arch.heroTree})`);
    console.log(`  Core loop: ${arch.coreLoop}`);
    console.log(`  Key talents: ${arch.keyTalents?.join(", ") || "none"}`);
    console.log(`  Key buffs: ${arch.keyBuffs?.join(", ") || "none"}`);
    console.log(`  Tradeoffs: ${arch.tradeoffs}`);
    console.log();
  }

  // Show tension points
  const tensions = getTensionPoints();
  console.log("--- Tension Points ---\n");
  for (const tp of tensions) {
    console.log(`${tp.id}: ${tp.description}`);
    console.log(`  ${tp.explanation}`);
    console.log(`  Affects: ${tp.affectedArchetypes.join(", ")}`);
    console.log();
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
}
