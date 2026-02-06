// Build Theory Generator — auto-generates build-theory.json from data
// Creates initial cluster and archetype structure from talents.json and interactions.json
// Usage: node src/analyze/build-theory-generator.js [output.json]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dataFile } from "../engine/paths.js";
import { getSpecAdapter } from "../engine/startup.js";

// --- Cluster Detection ---

// Read cluster keywords and school clusters from spec adapter config.
// Falls back to empty objects if adapter not loaded (graceful degradation).
function getClusterKeywords() {
  try {
    return getSpecAdapter().getSpecConfig().clusterKeywords || {};
  } catch {
    return {};
  }
}

function getSchoolClusters() {
  try {
    return getSpecAdapter().getSpecConfig().schoolClusters || {};
  } catch {
    return {};
  }
}

function getHeroTreeAplBranch(treeId) {
  try {
    const heroTrees = getSpecAdapter().getSpecConfig().heroTrees || {};
    return heroTrees[treeId]?.aplBranch || treeId;
  } catch {
    return treeId;
  }
}

function detectClusterFromTalent(talent) {
  const name = talent.name.toLowerCase();
  const desc = (talent.description || "").toLowerCase();
  const combined = `${name} ${desc}`;

  const matches = [];

  for (const [clusterId, keywords] of Object.entries(getClusterKeywords())) {
    const score = keywords.filter((k) => combined.includes(k)).length;
    if (score > 0) {
      matches.push({ clusterId, score });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  return matches.length > 0 ? matches[0].clusterId : "misc";
}

// --- Synergy Detection ---

function detectSynergies(talents, interactions) {
  const synergies = [];
  const interactionsBySpell = interactions?.bySpell || {};

  // Look for talents that affect the same spells
  const spellToTalents = new Map();

  for (const talent of talents) {
    const affectedBy = talent.affectedBy || [];
    for (const effect of affectedBy) {
      const spellId = effect.id;
      if (!spellToTalents.has(spellId)) {
        spellToTalents.set(spellId, []);
      }
      spellToTalents.get(spellId).push(talent.name);
    }
  }

  // Talents affecting the same spell are potentially synergistic
  for (const [spellId, talentNames] of spellToTalents) {
    if (talentNames.length >= 2) {
      synergies.push({
        talents: talentNames,
        reason: `Both affect spell ${spellId}`,
        strength: talentNames.length > 2 ? "strong" : "moderate",
      });
    }
  }

  return synergies;
}

// --- Hero Tree Detection ---

function detectHeroTrees(talents) {
  const heroTrees = {};

  // Read hero tree config from spec adapter for subtree IDs and keywords
  let adapterHeroTrees = {};
  try {
    adapterHeroTrees = getSpecAdapter().getSpecConfig().heroTrees || {};
  } catch {
    // Graceful degradation if adapter not loaded
  }

  // Build set of known subtree IDs and profile keywords from adapter
  const subtreeToTree = new Map();
  const heroKeywords = new Map();
  for (const [treeId, treeConfig] of Object.entries(adapterHeroTrees)) {
    if (treeConfig.subtree) subtreeToTree.set(treeConfig.subtree, treeId);
    for (const kw of treeConfig.profileKeywords || []) {
      heroKeywords.set(kw, treeId);
    }
  }

  // Find hero tree talents by subtree ID, heroTree field, or keyword match
  const heroTreeTalents = talents.filter((t) => {
    if (t.subtree && subtreeToTree.has(t.subtree)) return true;
    if (t.heroTree) return true;
    const name = t.name.toLowerCase();
    for (const kw of heroKeywords.keys()) {
      if (name.includes(kw)) return true;
    }
    return false;
  });

  // Group by subtree, resolving to adapter tree IDs where possible
  for (const talent of heroTreeTalents) {
    const rawId = talent.subtree || talent.heroTree || "unknown";
    const treeId = subtreeToTree.get(rawId) || rawId;
    if (!heroTrees[treeId]) {
      // Pre-populate from adapter config if available
      const adapterConfig = adapterHeroTrees[treeId];
      heroTrees[treeId] = {
        talents: [],
        damageSchool: adapterConfig?.damageSchool || null,
        keyMechanics: [],
      };
    }
    heroTrees[treeId].talents.push(talent.name);

    // Detect damage school from description (fallback if not in adapter)
    if (!heroTrees[treeId].damageSchool) {
      const desc = (talent.description || "").toLowerCase();
      const schoolClusters = getSchoolClusters();
      for (const school of Object.keys(schoolClusters)) {
        if (desc.includes(school.toLowerCase())) {
          heroTrees[treeId].damageSchool = school;
          break;
        }
      }
    }
  }

  return heroTrees;
}

// --- Build Theory Generation ---

function generateBuildTheory(talents, interactions, spells) {
  const theory = {
    _schema: "build-theory-v1",
    _curated: false,
    _generated: new Date().toISOString(),
    _doc:
      "Auto-generated build theory. Review and curate before using. " +
      "This is a STARTING POINT — human analysis required for accuracy.",
    specClusters: [],
    heroTrees: {},
    clusterSynergies: [],
    buildArchetypes: [],
    tensionPoints: [],
  };

  // Flatten all talents
  const allTalents = [
    ...(talents.class?.talents || []),
    ...(talents.spec?.talents || []),
    ...(talents.heroTrees?.flatMap((ht) => ht.talents) || []),
  ];

  // Detect clusters
  const clusterTalents = new Map();
  for (const talent of allTalents) {
    const clusterId = detectClusterFromTalent(talent);
    if (!clusterTalents.has(clusterId)) {
      clusterTalents.set(clusterId, []);
    }
    clusterTalents.get(clusterId).push(talent);
  }

  // Build cluster entries
  for (const [clusterId, talents] of clusterTalents) {
    if (talents.length < 2) continue; // Skip single-talent clusters

    theory.specClusters.push({
      id: clusterId,
      name: clusterId
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
      talents: talents.map((t) => t.name),
      coreLoop: "Auto-detected cluster — manual description needed",
      keyMechanics: [],
      role: "unknown",
    });
  }

  // Detect hero trees
  theory.heroTrees = detectHeroTrees(allTalents);

  // Detect synergies
  const synergies = detectSynergies(allTalents, interactions);
  theory.clusterSynergies = synergies.slice(0, 20); // Limit to top 20

  // Generate initial archetypes (one per major cluster + hero tree combo)
  for (const cluster of theory.specClusters) {
    for (const [treeId, treeData] of Object.entries(theory.heroTrees)) {
      if (treeData.talents.length > 0) {
        theory.buildArchetypes.push({
          id: `${treeId}-${cluster.id}`,
          name: `${treeId} ${cluster.name}`.replace(/[_-]/g, " "),
          heroTree: treeId,
          clusters: [cluster.id],
          coreLoop: "Auto-generated — requires manual description",
          keyTalents: [
            ...cluster.talents.slice(0, 3),
            ...treeData.talents.slice(0, 2),
          ],
          keyBuffs: [],
          keyAbilities: [],
          strengths: "Unknown — simulation required",
          tensions: "Unknown — analysis required",
          tradeoffs: "Unknown — comparison required",
          aplFocus: [getHeroTreeAplBranch(treeId)],
        });
      }
    }
  }

  // Detect tension points (competing resources or mechanics)
  theory.tensionPoints = [
    {
      id: "auto-detected-resource-competition",
      description: "Resource competition detected — review manually",
      explanation:
        "Multiple talents/abilities compete for the same resource. " +
        "Analyze which should take priority in different scenarios.",
      affectedArchetypes: theory.buildArchetypes.map((a) => a.id).slice(0, 3),
    },
  ];

  return theory;
}

// --- Export Functions ---

export function generateTheory() {
  const talentsPath = dataFile("talents.json");
  const interactionsPath = dataFile("interactions-summary.json");
  const spellsPath = dataFile("spells-summary.json");

  if (!existsSync(talentsPath)) {
    throw new Error(
      `Talents file not found: ${talentsPath}. Run 'npm run build-data' first.`,
    );
  }

  const talents = JSON.parse(readFileSync(talentsPath, "utf-8"));
  const interactions = existsSync(interactionsPath)
    ? JSON.parse(readFileSync(interactionsPath, "utf-8"))
    : null;
  const spells = existsSync(spellsPath)
    ? JSON.parse(readFileSync(spellsPath, "utf-8"))
    : [];

  return generateBuildTheory(talents, interactions, spells);
}

export function printTheorySummary(theory) {
  console.log("\n" + "=".repeat(70));
  console.log("Auto-Generated Build Theory");
  console.log("=".repeat(70));

  console.log(`\nClusters: ${theory.specClusters.length}`);
  for (const cluster of theory.specClusters) {
    console.log(`  ${cluster.id}: ${cluster.talents.length} talents`);
  }

  console.log(`\nHero Trees: ${Object.keys(theory.heroTrees).length}`);
  for (const [id, tree] of Object.entries(theory.heroTrees)) {
    console.log(
      `  ${id}: ${tree.talents.length} talents, ${tree.damageSchool || "unknown"} school`,
    );
  }

  console.log(`\nArchetypes: ${theory.buildArchetypes.length}`);
  for (const arch of theory.buildArchetypes.slice(0, 5)) {
    console.log(`  ${arch.id}: ${arch.clusters.join(", ")}`);
  }

  console.log(`\nSynergies: ${theory.clusterSynergies.length}`);
  console.log(`Tension Points: ${theory.tensionPoints.length}`);

  console.log("\n" + "=".repeat(70));
  console.log("WARNING: This is auto-generated and requires manual curation.");
  console.log("Review clusters, archetypes, and synergies for accuracy.");
  console.log("=".repeat(70));
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadSpecAdapter } = await import("../engine/startup.js");
  await loadSpecAdapter();
  const outputPath = process.argv[2] || null;

  try {
    const theory = generateTheory();

    if (outputPath) {
      writeFileSync(outputPath, JSON.stringify(theory, null, 2));
      console.log(`Build theory written to: ${outputPath}`);
    } else {
      printTheorySummary(theory);
      console.log("\n--- JSON Output (truncated) ---");
      const preview = { ...theory };
      preview.buildArchetypes = preview.buildArchetypes.slice(0, 2);
      preview.clusterSynergies = preview.clusterSynergies.slice(0, 3);
      console.log(JSON.stringify(preview, null, 2));
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
