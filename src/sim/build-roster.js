// Persistent build roster for multi-build evaluation.
// DB-first: all reads/writes go through theorycraft.db via db.js.
// No JSON file I/O — the DB is the single source of truth.
//
// Sources:
//   1. Cluster roster: systematic cluster permutations × hero tree × variant
//   2. Community: config.{spec}.json communityBuilds → Wowhead/Icy-Veins hashes
//   3. Baseline: apls/{spec}/baseline.simc → SimC default APL talent hash
//   4. Manual: add <hash> --archetype "Name" --hero <tree>
//
// Usage:
//   node src/sim/build-roster.js generate                          Build full layered roster (recommended)
//   node src/sim/build-roster.js show
//   node src/sim/build-roster.js import-doe
//   node src/sim/build-roster.js import-community
//   node src/sim/build-roster.js import-baseline
//   node src/sim/build-roster.js add <hash> --archetype "Name" --hero <tree>
//   node src/sim/build-roster.js validate
//   node src/sim/build-roster.js audit
//   node src/sim/build-roster.js prune [--threshold 1.0]
//   node src/sim/build-roster.js update-dps [--fidelity quick|standard|confirm]
//   node src/sim/build-roster.js generate-hashes
//   node src/sim/build-roster.js generate-names

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  getSpecAdapter,
  initSpec,
  config,
  SCENARIOS,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { dataFile, resultsFile, aplsDir } from "../engine/paths.js";
import { validateBuild, validateHash } from "../util/validate-build.js";
import {
  decode,
  loadFullNodeList,
  overridesToHash,
  normalizeClassTree,
  getBaselineClassSelections,
} from "../util/talent-string.js";
import {
  specHeroFingerprint,
  detectHeroTree,
  detectHeroVariant,
  decodeTalentNames,
  abbrev,
} from "../util/talent-fingerprint.js";
import {
  getHeroChoiceLocks,
  generateClusterRoster,
} from "../model/talent-combos.js";
import {
  upsertBuild,
  setRosterMembership,
  clearAllRosterMembership,
  updateBuildDps as dbUpdateBuildDps,
  updateBuildDisplayName,
  getRosterBuilds,
  queryBuilds,
  getArchetypes,
  getFactors,
  withTransaction,
  closeAll,
} from "../util/db.js";

function normalizeTreeName(tree) {
  if (!tree) return tree;
  return tree.replace(/\s+/g, "_").toLowerCase();
}

const HERO_ABBREVS = {
  aldrachi_reaver: "AR",
  "Aldrachi Reaver": "AR",
  annihilator: "Anni",
  Annihilator: "Anni",
  void_scarred: "VS",
  "Void Scarred": "VS",
  "Void-Scarred": "VS",
};

function heroAbbrev(tree) {
  if (!tree) return "??";
  if (HERO_ABBREVS[tree]) return HERO_ABBREVS[tree];
  return tree
    .split(/[\s_]+/)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

function sourcePrefix(source) {
  switch (source) {
    case "community:wowhead":
      return "WH";
    case "community:icy-veins":
      return "IV";
    case "baseline":
    case "doe":
    case "cluster":
      return null;
    default:
      return source;
  }
}

function sourceAbbrev(sourceName) {
  switch (sourceName) {
    case "wowhead":
      return "WH";
    case "icy-veins":
      return "IV";
    default:
      return sourceName.toUpperCase().slice(0, 2);
  }
}

// Regenerate ALL displayNames from talent diffs.
// Names depend on which OTHER builds exist in the same hero tree group,
// so we always regenerate everything rather than naming incrementally.
export function generateDisplayNames(builds) {
  if (!builds?.length) return;

  // Load DoE factor impacts for ranking varying talents
  const factorsByName = new Map();
  try {
    const factors = getFactors({ limit: 200 });
    for (const f of factors) {
      if (!factorsByName.has(f.talent)) {
        factorsByName.set(f.talent, Math.abs(f.pct));
      }
    }
  } catch {
    // Non-fatal
  }

  // Decode all hashes into spec talent sets
  const decoded = new Map();
  for (const b of builds) {
    if (!b.hash) continue;
    try {
      const result = decodeTalentNames(b.hash);
      decoded.set(b.hash, {
        specTalents: new Set(result.specTalents),
        heroTree: result.heroTree,
      });
    } catch {
      // Skip builds that fail to decode
    }
  }

  // Group builds by heroTree
  const groups = {};
  for (const b of builds) {
    const tree = b.heroTree || b.hero_tree || "unknown";
    if (!groups[tree]) groups[tree] = [];
    groups[tree].push(b);
  }

  // For each group, find varying talents and generate names
  for (const [tree, treeBuilds] of Object.entries(groups)) {
    const decodedBuilds = treeBuilds.filter((b) => decoded.has(b.hash));
    if (decodedBuilds.length === 0) {
      for (const b of treeBuilds) {
        const name = `${heroAbbrev(tree)} #${treeBuilds.indexOf(b) + 1}`;
        b.displayName = name;
      }
      continue;
    }

    // Universal = present in ALL builds; varying = present in SOME
    const allTalentSets = decodedBuilds.map(
      (b) => decoded.get(b.hash).specTalents,
    );
    const universalTalents = new Set(
      [...allTalentSets[0]].filter((t) => allTalentSets.every((s) => s.has(t))),
    );

    const varyingTalentSet = new Set();
    for (const s of allTalentSets) {
      for (const t of s) {
        if (!universalTalents.has(t)) varyingTalentSet.add(t);
      }
    }

    const ha = heroAbbrev(tree);

    function buildSignature(hash, selectedTalents) {
      const d = decoded.get(hash);
      return d ? selectedTalents.filter((t) => d.specTalents.has(t)) : null;
    }

    function signatureKey(sig, source) {
      const talentStr = sig.length > 0 ? sig.map(abbrev).join(" + ") : "Base";
      const prefix = sourcePrefix(source);
      return prefix ? `${prefix}: ${talentStr}` : talentStr;
    }

    function countCollisions(selectedTalents) {
      const nameGroups = new Map();
      for (const b of treeBuilds) {
        if (b.source === "baseline" || !decoded.has(b.hash)) continue;
        const sig = buildSignature(b.hash, selectedTalents);
        const key = signatureKey(sig, b.source);
        if (!nameGroups.has(key)) nameGroups.set(key, []);
        nameGroups.get(key).push(b);
      }
      let collisions = 0;
      for (const arr of nameGroups.values()) {
        if (arr.length > 1) collisions += arr.length - 1;
      }
      return collisions;
    }

    // Greedy talent selection for minimum unique signatures
    const selectedTalents = [];
    const remainingTalents = new Set(varyingTalentSet);
    const MAX_TALENTS = 4;

    while (selectedTalents.length < MAX_TALENTS && remainingTalents.size > 0) {
      let bestTalent = null;
      let bestReduction = 0;
      let bestImpact = 0;

      const currentCollisions = countCollisions(selectedTalents);
      if (currentCollisions === 0) break;

      for (const t of remainingTalents) {
        const candidate = [...selectedTalents, t];
        const newCollisions = countCollisions(candidate);
        const reduction = currentCollisions - newCollisions;
        const impact = factorsByName?.get(t) || 0;

        if (
          reduction > bestReduction ||
          (reduction === bestReduction && impact > bestImpact)
        ) {
          bestTalent = t;
          bestReduction = reduction;
          bestImpact = impact;
        }
      }

      if (!bestTalent || bestReduction === 0) break;
      selectedTalents.push(bestTalent);
      remainingTalents.delete(bestTalent);
    }

    // Sort by factor impact for consistent display order
    selectedTalents.sort((a, b) => {
      const impA = factorsByName?.get(a) || 0;
      const impB = factorsByName?.get(b) || 0;
      return impB - impA;
    });

    // Assign names
    const nameMap = new Map();
    for (const b of treeBuilds) {
      const d = decoded.get(b.hash);
      if (!d) {
        const prefix = sourcePrefix(b.source);
        const label = b.archetype || "Unknown";
        b.displayName = prefix ? `${prefix}: ${label}` : label;
        continue;
      }

      const sig = buildSignature(b.hash, selectedTalents);
      b.displayName = signatureKey(sig, b.source);

      if (!nameMap.has(b.displayName)) nameMap.set(b.displayName, []);
      nameMap.get(b.displayName).push(b);
    }

    // Disambiguate collisions using hero choice variant name
    const specConfig = getSpecAdapter().getSpecConfig();
    for (const [name, dupes] of nameMap) {
      if (dupes.length <= 1) continue;

      // Try hero variant disambiguation
      const variantNames = new Map();
      for (const b of dupes) {
        const treeCfg = specConfig?.heroTrees?.[tree];
        const choiceLocks = treeCfg?.choiceLocks || {};
        try {
          const { variant } = detectHeroVariant(b.hash, null, choiceLocks);
          if (variant) variantNames.set(b, abbrev(variant));
        } catch {
          // Non-fatal
        }
      }

      // Always append variant when available, then #N within subgroups
      const subgroups = new Map();
      for (const b of dupes) {
        const v = variantNames.get(b) || "";
        if (!subgroups.has(v)) subgroups.set(v, []);
        subgroups.get(v).push(b);
      }
      for (const [v, group] of subgroups) {
        const suffix = v ? ` (${v})` : "";
        if (group.length === 1) {
          group[0].displayName = `${name}${suffix}`;
        } else {
          for (let i = 0; i < group.length; i++) {
            group[i].displayName = `${name}${suffix} #${i + 1}`;
          }
        }
      }
    }
  }

  // Write display names back to DB
  for (const b of builds) {
    if (b.displayName && b.hash) {
      try {
        updateBuildDisplayName(b.hash, b.displayName);
      } catch {
        // Non-fatal
      }
    }
  }
}

// --- Roster read (DB-first) ---

// Returns a roster-shaped object for backward compat with iterate.js and showcase.js.
// Reads from the DB — no JSON file involved.
export function loadRoster() {
  try {
    const builds = getRosterBuilds();
    if (!builds || builds.length === 0) return null;

    return {
      _schema: "roster-db",
      builds: builds.map((b) => ({
        id: b.name || b.hash?.slice(0, 20),
        displayName: b.displayName || b.display_name || null,
        archetype: b.archetype || "Unknown",
        heroTree: b.heroTree || b.hero_tree,
        hash: b.hash,
        overrides: b.overrides || null,
        source: b.source || "doe",
        validated: !!b.validated,
        validationErrors: b.validationErrors || null,
        lastDps: b.weighted
          ? {
              st: b.dps_st || 0,
              small_aoe: b.dps_small_aoe || 0,
              big_aoe: b.dps_big_aoe || 0,
              weighted: b.weighted || 0,
            }
          : null,
        lastTestedAt: b.lastTestedAt || b.last_tested_at || null,
      })),
    };
  } catch {
    return null;
  }
}

// --- Spec+hero fingerprint dedup ---

function isDuplicateBySpecHero(existingHashes, hash) {
  try {
    const fp = specHeroFingerprint(hash);
    return existingHashes.some((h) => {
      try {
        return specHeroFingerprint(h) === fp;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// --- Fingerprint-based dedup helper ---

function isDuplicateByFingerprint(existingFingerprints, hash) {
  try {
    return existingFingerprints.has(specHeroFingerprint(hash));
  } catch {
    return false;
  }
}

function addFingerprint(fingerprintSet, hash) {
  try {
    fingerprintSet.add(specHeroFingerprint(hash));
  } catch {
    // Non-fatal: fingerprint computation can fail for malformed hashes
  }
}

// --- Classify community builds into DoE archetypes ---

// Match a build against DoE-discovered archetypes by checking defining talents.
// Returns the best-matching archetype name, or a fallback like "Community AR".
function classifyBuildArchetype(hash, archetypes, heroTree) {
  if (!archetypes || archetypes.length === 0) {
    return `Community ${heroAbbrev(heroTree)}`;
  }

  let specTalents;
  try {
    const decoded = decodeTalentNames(hash);
    specTalents = new Set(decoded.specTalents);
  } catch {
    return `Community ${heroAbbrev(heroTree)}`;
  }

  // Filter archetypes to same hero tree
  const normalizedTree = normalizeTreeName(heroTree);
  const treeArchetypes = archetypes.filter((a) => {
    const aTree = normalizeTreeName(a.heroTree || a.hero_tree);
    return aTree === normalizedTree;
  });

  if (treeArchetypes.length === 0) {
    return `Community ${heroAbbrev(heroTree)}`;
  }

  let bestMatch = null;
  let bestCount = 0;

  for (const arch of treeArchetypes) {
    const defining =
      typeof arch.definingTalents === "string"
        ? JSON.parse(arch.definingTalents)
        : arch.definingTalents || [];
    if (defining.length === 0) continue;

    // All defining talents must be present
    const allPresent = defining.every((t) => specTalents.has(t));
    if (allPresent && defining.length > bestCount) {
      bestMatch = arch.name;
      bestCount = defining.length;
    }
  }

  return bestMatch || `${normalizedTree}: unclassified`;
}

// --- Unified import: baseline (fingerprint-aware) ---

function importBaselineUnified(existingFingerprints) {
  const baselinePath = join(aplsDir(), "baseline.simc");
  if (!existsSync(baselinePath)) {
    console.log("  No baseline.simc found — skipping");
    return { added: 0, hash: null };
  }

  const content = readFileSync(baselinePath, "utf8");
  const match = content.match(/^\s*talents\s*=\s*([A-Za-z0-9+/]+)/m);
  if (!match) {
    console.log("  No talents= line in baseline.simc — skipping");
    return { added: 0, hash: null };
  }

  const hash = match[1];
  let heroTree;
  try {
    heroTree = normalizeTreeName(detectHeroTree(hash));
  } catch {
    console.log("  Cannot detect hero tree from baseline — skipping");
    return { added: 0, hash: null };
  }

  const ha = heroAbbrev(heroTree);
  upsertBuild({
    hash,
    name: `baseline_${ha}`,
    displayName: null,
    heroTree,
    archetype: "Baseline",
    source: "baseline",
    inRoster: true,
    validated: 1,
  });

  addFingerprint(existingFingerprints, hash);

  console.log(`  Baseline: ${ha} (1 build)`);
  return { added: 1, hash };
}

// --- Unified import: community (fingerprint-aware) ---

function importCommunityUnified(existingFingerprints, archetypes) {
  const communityBuilds = config.communityBuilds;
  if (!communityBuilds || communityBuilds.length === 0) {
    console.log("  No community builds configured — skipping");
    return { added: 0, skipped: 0 };
  }

  const baselineClassSelections = getBaselineClassSelections();
  let added = 0;
  let skipped = 0;
  const variantCounters = {};

  for (const cb of communityBuilds) {
    const rawHash = cb.hash;
    const sourceName = cb.source;

    let heroTree;
    try {
      heroTree = normalizeTreeName(detectHeroTree(rawHash));
    } catch {
      skipped++;
      continue;
    }
    if (!heroTree) {
      skipped++;
      continue;
    }

    let normalizedHash;
    try {
      normalizedHash = normalizeClassTree(rawHash, baselineClassSelections);
    } catch {
      skipped++;
      continue;
    }

    if (isDuplicateByFingerprint(existingFingerprints, normalizedHash)) {
      skipped++;
      continue;
    }

    const fullSource = `community:${sourceName}`;
    const ha = heroAbbrev(heroTree);
    const counterKey = `${sourceName}|${heroTree}`;
    variantCounters[counterKey] = (variantCounters[counterKey] || 0) + 1;
    const n = variantCounters[counterKey];
    const srcPrefix = sourceAbbrev(sourceName);
    const name = `${srcPrefix}_${ha}_${n}`;

    // Classify into DoE archetype
    const archetype = classifyBuildArchetype(
      normalizedHash,
      archetypes,
      heroTree,
    );

    const validation = validateBuild({ hash: normalizedHash });
    upsertBuild({
      hash: normalizedHash,
      name,
      heroTree,
      archetype,
      source: fullSource,
      inRoster: true,
      validated: validation.valid ? 1 : 0,
      validationErrors: validation.valid ? null : validation.errors,
    });

    addFingerprint(existingFingerprints, normalizedHash);
    added++;
  }

  console.log(`  Community: ${added} added, ${skipped} skipped`);
  return { added, skipped };
}

// --- Unified import: DoE (fingerprint-aware, variant-aware) ---
// For each archetype, ensures coverage of all hero variants (unlocked choice nodes).
// Picks 1 representative build per variant per archetype. DPS is used only as a
// --- Unified generate command ---

export function generate() {
  console.log("=== Generating Build Roster ===\n");

  const archetypes = getArchetypes();

  withTransaction(() => {
    // Phase 0: Clear roster membership (preserves build records + DPS data)
    clearAllRosterMembership();
    console.log("Phase 0: Cleared roster membership\n");

    // Build fingerprint cache for cross-source dedup
    const fingerprints = new Set();

    // Phase 1: Import baseline
    console.log("Phase 1: Baseline");
    importBaselineUnified(fingerprints);

    // Phase 2: Import community (dedup against baseline)
    console.log("\nPhase 2: Community builds");
    importCommunityUnified(fingerprints, archetypes);

    // Phase 3: Generate cluster roster
    // Systematic exploration of cluster permutations × hero tree × variant
    console.log("\nPhase 3: Cluster roster");
    const clusterBuilds = generateClusterRoster();
    let clusterAdded = 0;
    let clusterSkipped = 0;
    let clusterInvalid = 0;

    for (const cb of clusterBuilds) {
      if (!cb.hash) {
        clusterInvalid++;
        continue;
      }

      if (isDuplicateByFingerprint(fingerprints, cb.hash)) {
        clusterSkipped++;
        continue;
      }

      const heroTree = normalizeTreeName(cb.heroTree);
      const ha = heroAbbrev(heroTree);
      const variantTag = cb.variant ? `_${cb.variant}` : "";
      const name = `${ha}_${sanitizeId(cb.template)}${variantTag}_${clusterAdded + 1}`;
      const archetype = `Apex ${cb.apexRank}: ${cb.template}`;

      const validation = validateBuild({ hash: cb.hash });
      if (!validation.valid) clusterInvalid++;

      upsertBuild({
        hash: cb.hash,
        name,
        heroTree,
        archetype,
        source: "cluster",
        inRoster: true,
        validated: validation.valid ? 1 : 0,
        validationErrors: validation.valid ? null : validation.errors,
      });

      addFingerprint(fingerprints, cb.hash);
      clusterAdded++;
    }

    console.log(
      `  Cluster: ${clusterAdded} added, ${clusterSkipped} duplicates${clusterInvalid ? `, ${clusterInvalid} invalid` : ""}`,
    );

    // Phase 4: Generate display names
    console.log("\nPhase 4: Display names");
    const allRoster = getRosterBuilds();
    generateDisplayNames(allRoster);
    console.log(`  Generated names for ${allRoster.length} builds`);
  });

  // Phase 5: Show structured summary
  console.log("");
  showRoster();
}

// --- Import from DoE discovery (standalone, incremental) ---

export function importFromDoe() {
  const dbArchetypes = getArchetypes();
  if (!dbArchetypes || dbArchetypes.length === 0) {
    console.error("No archetypes found in DB. Run build discovery first.");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const specConfig = getSpecAdapter().getSpecConfig();
  const doeTrees = new Set();
  for (const [name, cfg] of Object.entries(specConfig.heroTrees)) {
    if (cfg.buildMethod === "doe") {
      doeTrees.add(name);
      doeTrees.add(name.replace(/_/g, "-"));
    }
  }

  if (doeTrees.size === 0) {
    console.error("No DoE hero trees configured");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  // Clear stale DoE roster entries so we only keep current archetypes
  const existingBuilds = getRosterBuilds();
  const currentArchNames = new Set(dbArchetypes.map((a) => a.name));
  for (const b of existingBuilds) {
    if (b.source === "doe" && !currentArchNames.has(b.archetype)) {
      setRosterMembership(b.hash, false);
    }
  }

  // Refresh after cleanup, dedup by hash
  const freshBuilds = getRosterBuilds();
  const existingHashes = new Set(freshBuilds.map((b) => b.hash));

  let added = 0;
  let skipped = 0;
  let invalid = 0;

  withTransaction(() => {
    for (const arch of dbArchetypes) {
      if (!doeTrees.has(arch.heroTree) && !doeTrees.has(arch.hero_tree))
        continue;

      const heroTree = arch.heroTree || arch.hero_tree;
      const bestHash = arch.bestBuildHash || arch.best_build_hash;
      if (!bestHash) continue;

      // Get builds for this archetype from DB
      const archBuilds = queryBuilds({ archetype: arch.name, limit: 5 });
      const candidates =
        archBuilds.length > 0 ? archBuilds : [{ hash: bestHash }];

      for (const candidate of candidates.slice(0, 5)) {
        if (!candidate.hash) continue;
        if (existingHashes.has(candidate.hash)) {
          skipped++;
          continue;
        }

        const validation = validateBuild({ hash: candidate.hash });
        if (!validation.valid) {
          console.warn(
            `  WARNING: Build ${candidate.hash.slice(0, 20)}... has validation errors: ${validation.errors.join("; ")}`,
          );
          invalid++;
        }

        const prefix = heroTree
          .split("_")
          .map((w) => w[0].toUpperCase())
          .join("");
        const name = `${prefix}_${sanitizeId(arch.name)}_${added + 1}`;

        upsertBuild({
          hash: candidate.hash,
          name,
          heroTree,
          archetype: arch.name,
          source: "doe",
          inRoster: true,
          validated: validation.valid ? 1 : 0,
          validationErrors: validation.valid ? null : validation.errors,
          dps_st: candidate.dps_st,
          dps_small_aoe: candidate.dps_small_aoe,
          dps_big_aoe: candidate.dps_big_aoe,
          weighted: candidate.weighted,
        });
        existingHashes.add(candidate.hash);
        added++;
      }
    }

    // Generate display names for all roster builds
    if (added > 0) {
      const allRoster = getRosterBuilds();
      generateDisplayNames(allRoster);
    }
  });

  console.log(`Imported ${added} DoE builds to roster.`);
  return { added, skipped, invalid };
}

// --- Import from community builds (config.{spec}.json) ---

export function importCommunity() {
  const communityBuilds = config.communityBuilds;
  if (!communityBuilds || communityBuilds.length === 0) {
    console.error("No communityBuilds found in config");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  console.log(
    `Processing ${communityBuilds.length} community builds from config...`,
  );

  const baselineClassSelections = getBaselineClassSelections();

  // Get existing roster hashes for fingerprint dedup
  const existingBuilds = getRosterBuilds();
  const existingHashes = existingBuilds.map((b) => b.hash).filter(Boolean);

  const variantCounters = {};
  let added = 0;
  let skipped = 0;
  const batchHashes = []; // Track hashes added in this batch

  withTransaction(() => {
    for (const cb of communityBuilds) {
      const rawHash = cb.hash;
      const sourceName = cb.source;

      let heroTree;
      try {
        heroTree = detectHeroTree(rawHash);
      } catch (e) {
        console.warn(
          `  SKIP: Cannot detect hero tree for hash ${rawHash.slice(0, 20)}...: ${e.message}`,
        );
        skipped++;
        continue;
      }

      if (!heroTree) {
        console.warn(
          `  SKIP: No hero tree detected for hash ${rawHash.slice(0, 20)}...`,
        );
        skipped++;
        continue;
      }

      heroTree = normalizeTreeName(heroTree);

      // Normalize class tree to canonical baseline
      let normalizedHash;
      try {
        normalizedHash = normalizeClassTree(rawHash, baselineClassSelections);
      } catch (e) {
        console.warn(
          `  SKIP: Class tree normalization failed for ${rawHash.slice(0, 20)}...: ${e.message}`,
        );
        skipped++;
        continue;
      }

      // Deduplicate by spec+hero fingerprint against existing roster
      if (isDuplicateBySpecHero(existingHashes, normalizedHash)) {
        console.log(
          `  SKIP (dup): ${sourceName} ${heroAbbrev(heroTree)} hash ${rawHash.slice(0, 20)}...`,
        );
        skipped++;
        continue;
      }

      // Also check against builds added in this batch
      if (isDuplicateBySpecHero(batchHashes, normalizedHash)) {
        console.log(
          `  SKIP (batch dup): ${sourceName} ${heroAbbrev(heroTree)} hash ${rawHash.slice(0, 20)}...`,
        );
        skipped++;
        continue;
      }

      const fullSource = `community:${sourceName}`;
      const ha = heroAbbrev(heroTree);

      const counterKey = `${sourceName}|${heroTree}`;
      variantCounters[counterKey] = (variantCounters[counterKey] || 0) + 1;
      const n = variantCounters[counterKey];

      const srcPrefix =
        sourceName === "wowhead"
          ? "WH"
          : sourceName === "icy-veins"
            ? "IV"
            : sourceName.toUpperCase().slice(0, 2);

      const name = `${srcPrefix}_${ha}_${n}`;

      const validation = validateBuild({ hash: normalizedHash });

      upsertBuild({
        hash: normalizedHash,
        name,
        heroTree,
        archetype: `Community ${ha}`,
        source: fullSource,
        inRoster: true,
        validated: validation.valid ? 1 : 0,
        validationErrors: validation.valid ? null : validation.errors,
      });

      batchHashes.push(normalizedHash);
      added++;
      console.log(`  ADD: ${srcPrefix} ${ha} #${n} (${heroTree})`);
    }

    // Generate display names for all roster builds
    if (added > 0) {
      const allRoster = getRosterBuilds();
      generateDisplayNames(allRoster);
    }
  });

  console.log(
    added > 0
      ? `Added ${added} community builds to roster.`
      : "No new community builds to add (all duplicates).",
  );
  return { added, skipped, invalid: 0 };
}

// --- Import from baseline.simc ---

export function importBaseline() {
  const baselinePath = join(aplsDir(), "baseline.simc");
  if (!existsSync(baselinePath)) {
    console.error(`baseline.simc not found at ${baselinePath}`);
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const content = readFileSync(baselinePath, "utf8");
  const match = content.match(/^\s*talents\s*=\s*([A-Za-z0-9+/]+)/m);
  if (!match) {
    console.error("No talents= line found in baseline.simc");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const hash = match[1];

  let heroTree;
  try {
    heroTree = detectHeroTree(hash);
  } catch (e) {
    console.error(`Cannot detect hero tree from baseline hash: ${e.message}`);
    return { added: 0, skipped: 0, invalid: 0 };
  }

  if (!heroTree) {
    console.error("No hero tree detected in baseline hash");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  heroTree = normalizeTreeName(heroTree);

  // Check for existing baseline build in DB
  const existingRoster = getRosterBuilds();
  const existingBaseline = existingRoster.find((b) => b.source === "baseline");

  if (existingBaseline) {
    // Update the existing baseline
    upsertBuild({
      hash,
      name: existingBaseline.name,
      displayName: null,
      heroTree,
      archetype: "Baseline",
      source: "baseline",
      inRoster: true,
      validated: 1,
    });
    console.log(`Updated existing baseline build (${heroAbbrev(heroTree)})`);
    return { added: 0, skipped: 1, invalid: 0 };
  }

  const ha = heroAbbrev(heroTree);
  const name = `baseline_${ha}`;

  upsertBuild({
    hash,
    name,
    displayName: null,
    heroTree,
    archetype: "Baseline",
    source: "baseline",
    inRoster: true,
    validated: 1,
  });

  console.log(`Imported baseline build (${ha})`);
  return { added: 1, skipped: 0, invalid: 0 };
}

// --- Update DPS for all roster builds ---

export async function updateAllDps({ fidelity = "quick" } = {}) {
  const builds = getRosterBuilds();
  if (!builds || builds.length === 0) {
    console.error("No roster builds found in DB.");
    return;
  }

  const { generateMultiActorContent } = await import("./multi-actor.js");
  const { runMultiActorAsync } = await import("./runner.js");

  const SCENARIO_WEIGHTS = { st: 0.5, small_aoe: 0.3, big_aoe: 0.2 };
  const FIDELITY_TIERS = {
    quick: { target_error: 1.0 },
    standard: { target_error: 0.3 },
    confirm: { target_error: 0.1 },
  };

  const tierConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.quick;

  // Build a roster-shaped object for multi-actor
  const roster = loadRoster();
  if (!roster) {
    console.error("Failed to load roster.");
    return;
  }

  const specName = config.spec.specName;
  const specAplPath = join(aplsDir(), `${specName}.simc`);
  const baselineAplPath = join(aplsDir(), "baseline.simc");
  const aplPath = existsSync(specAplPath) ? specAplPath : baselineAplPath;

  console.log(
    `Updating DPS for ${roster.builds.length} builds (${fidelity} fidelity)...`,
  );
  console.log(`APL: ${aplPath}\n`);

  const simcContent = generateMultiActorContent(roster, aplPath);

  const buildDps = {};
  for (const b of roster.builds) {
    buildDps[b.id] = { st: 0, small_aoe: 0, big_aoe: 0 };
  }

  const scenarioKeys = Object.keys(SCENARIOS);
  for (const scenario of scenarioKeys) {
    console.log(`  Scenario: ${scenario}...`);
    try {
      const results = await runMultiActorAsync(
        simcContent,
        scenario,
        "roster-dps",
        {
          simOverrides: { target_error: tierConfig.target_error },
        },
      );

      for (const [actorId, data] of results) {
        if (buildDps[actorId]) {
          buildDps[actorId][scenario] = Math.round(data.dps);
        }
      }
      console.log(`    Done (${results.size} actors)`);
    } catch (e) {
      console.error(`    FAILED: ${e.message}`);
    }
  }

  // Write DPS to DB for each build
  for (const b of roster.builds) {
    const dps = buildDps[b.id];
    if (!dps || !b.hash) continue;

    const weighted = scenarioKeys.reduce(
      (sum, s) => sum + (dps[s] || 0) * (SCENARIO_WEIGHTS[s] || 0),
      0,
    );

    dbUpdateBuildDps(b.hash, {
      st: dps.st || 0,
      small_aoe: dps.small_aoe || 0,
      big_aoe: dps.big_aoe || 0,
      weighted: Math.round(weighted),
    });
  }

  console.log(`\nDPS updated for ${roster.builds.length} builds.`);

  // Print summary table
  const updatedBuilds = getRosterBuilds();
  console.log(
    `\n${"Build".padEnd(30)} ${"1T".padStart(8)} ${"5T".padStart(8)} ${"10T".padStart(8)} ${"Weighted".padStart(10)}`,
  );
  console.log("-".repeat(68));
  for (const b of updatedBuilds) {
    const name = (b.displayName || b.name || b.hash?.slice(0, 20)).slice(0, 29);
    console.log(
      `${name.padEnd(30)} ${(b.dps_st || 0).toLocaleString().padStart(8)} ${(b.dps_small_aoe || 0).toLocaleString().padStart(8)} ${(b.dps_big_aoe || 0).toLocaleString().padStart(8)} ${(b.weighted || 0).toLocaleString().padStart(10)}`,
    );
  }
}

// --- Validate all builds ---

export function validateAll() {
  const builds = getRosterBuilds();
  if (!builds || builds.length === 0) {
    console.error("No roster builds found.");
    return { total: 0, valid: 0, invalid: 0, errors: [] };
  }

  let valid = 0;
  let invalid = 0;
  const errors = [];

  for (const build of builds) {
    const result = validateBuild({ hash: build.hash });
    if (result.valid) {
      upsertBuild({ ...build, validated: 1, validationErrors: null });
      valid++;
    } else {
      upsertBuild({ ...build, validated: 0, validationErrors: result.errors });
      errors.push({
        id: build.name || build.hash?.slice(0, 20),
        errors: result.errors,
      });
      invalid++;
    }
  }

  return { total: builds.length, valid, invalid, errors };
}

// --- Prune redundant builds ---

export function pruneBuilds({ threshold = 1.0 } = {}) {
  const builds = getRosterBuilds();
  if (!builds || builds.length === 0) {
    console.error("No roster builds found.");
    return { pruned: 0, remaining: 0 };
  }

  const groups = {};
  for (const build of builds) {
    const key = `${build.heroTree || build.hero_tree}|${build.archetype}`;
    (groups[key] ||= []).push(build);
  }

  let pruned = 0;
  for (const groupBuilds of Object.values(groups)) {
    if (groupBuilds.length <= 1) continue;

    groupBuilds.sort((a, b) => (b.weighted || 0) - (a.weighted || 0));
    const bestW = groupBuilds[0].weighted || 0;
    if (bestW === 0) continue;

    const minKeep = 2;
    let retained = 1; // best build is always kept
    for (let i = 1; i < groupBuilds.length; i++) {
      const w = groupBuilds[i].weighted || 0;
      if (w === 0) continue;

      const deltaPercent = ((bestW - w) / bestW) * 100;
      const shouldPrune = deltaPercent > threshold && retained >= minKeep;

      if (shouldPrune) {
        setRosterMembership(groupBuilds[i].hash, false);
        pruned++;
      } else {
        retained++;
      }
    }
  }

  return { pruned, remaining: getRosterBuilds().length };
}

// --- Update DPS for a single build (called by iterate.js) ---

export function updateDps(roster, buildId, dpsMap) {
  const build = roster?.builds.find((b) => b.id === buildId);
  if (!build) return;

  build.lastDps = {
    st: Math.round(dpsMap.st || 0),
    small_aoe: Math.round(dpsMap.small_aoe || 0),
    big_aoe: Math.round(dpsMap.big_aoe || 0),
    weighted: dpsMap.weighted || 0,
  };
  build.lastTestedAt = new Date().toISOString();

  if (build.hash) {
    try {
      dbUpdateBuildDps(build.hash, build.lastDps);
    } catch {
      // Non-fatal
    }
  }
}

// No-op: DPS is already written to DB by updateDps.
// Kept for backward compat with iterate.js.
export function saveRosterDps() {}

// --- Generate hashes for override-only builds ---

export function generateHashes() {
  const builds = getRosterBuilds();
  if (!builds || builds.length === 0) {
    console.error("No roster builds found.");
    return { generated: 0, failed: 0 };
  }

  let generated = 0;
  let failed = 0;

  for (const build of builds) {
    if (build.hash) continue;
    if (!build.overrides) {
      console.warn(`  SKIP: ${build.name || "?"} — no hash and no overrides`);
      continue;
    }

    try {
      const hash = overridesToHash(build.overrides, {
        heroChoiceLocks: getHeroChoiceLocks(),
      });
      const validation = validateHash(hash);
      if (!validation.valid) {
        console.error(
          `  FAIL: ${build.name || "?"} — hash validation: ${validation.errors.join("; ")}`,
        );
        failed++;
        continue;
      }
      // Write the generated hash back to DB
      upsertBuild({
        hash,
        name: build.name,
        heroTree: build.heroTree || build.hero_tree,
        archetype: build.archetype,
        source: build.source,
        inRoster: true,
        validated: 1,
      });
      generated++;
      console.log(`  OK: ${build.name || "?"} → ${hash.slice(0, 20)}...`);
    } catch (e) {
      console.error(`  FAIL: ${build.name || "?"} — ${e.message}`);
      failed++;
    }
  }

  return { generated, failed };
}

// --- Show ---

// Cluster column definitions for compact roster display.
// Order matches the display column order.
const CLUSTER_COLS = [
  { key: "brand", label: "Brand", width: 7 },
  { key: "harvest", label: "Harv", width: 6 },
  { key: "feldev", label: "FelDev", width: 8 },
  { key: "sc", label: "SC", width: 4 },
  { key: "sigil", label: "Sig", width: 5 },
];

// Resolve cluster status for a build from its archetype → template mapping.
// Key is "apexRank:templateName" to avoid collisions between same-named templates
// at different apex ranks.
function resolveClusterStatus(archetype, templates) {
  const match = archetype?.match(/^Apex (\d+):\s*(.+)$/);
  if (!match) {
    // Baseline or unknown: assume all clusters present
    return Object.fromEntries(CLUSTER_COLS.map((c) => [c.key, "full"]));
  }
  const tmpl = templates.get(`${match[1]}:${match[2]}`);
  if (!tmpl) {
    return Object.fromEntries(CLUSTER_COLS.map((c) => [c.key, "full"]));
  }
  return Object.fromEntries(
    CLUSTER_COLS.map((c) => [c.key, tmpl[c.key] || "absent"]),
  );
}

export function showRoster() {
  const builds = getRosterBuilds();
  if (!builds || builds.length === 0) {
    console.log("No roster builds found. Run: npm run roster generate");
    return;
  }

  let specConfig;
  try {
    specConfig = getSpecAdapter().getSpecConfig();
  } catch {
    specConfig = null;
  }

  // Build template lookup from SPEC_CONFIG, keyed by "apexRank:name"
  const templates = new Map();
  for (const t of specConfig?.rosterTemplates || []) {
    templates.set(`${t.apexRank}:${t.name}`, t.include);
  }

  const hasAnyDps = builds.some((b) => b.weighted);

  // Group builds by hero tree
  const byTree = {};
  for (const b of builds) {
    const tree = b.heroTree || b.hero_tree || "unknown";
    (byTree[tree] ||= []).push(b);
  }

  // Legend
  console.log(
    "  Brand=Fiery Brand cluster  Harv=Harvest cluster  FelDev=Fel Devastation cluster",
  );
  console.log("  SC=Soul Carver  Sig=Sigil  * = core only\n");

  console.log(`=== Build Roster (${builds.length} builds) ===`);

  for (const [tree, treeBuilds] of Object.entries(byTree)) {
    const displayTree =
      specConfig?.heroTrees?.[tree]?.displayName ||
      tree.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    // Sort flat: baseline first, then by apex rank, then by template name
    treeBuilds.sort((a, b) => {
      if (a.source === "baseline") return -1;
      if (b.source === "baseline") return 1;
      const apexA = parseInt(a.archetype?.match(/^Apex (\d+)/)?.[1] ?? "99");
      const apexB = parseInt(b.archetype?.match(/^Apex (\d+)/)?.[1] ?? "99");
      if (apexA !== apexB) return apexA - apexB;
      return (a.archetype || "").localeCompare(b.archetype || "");
    });

    console.log(`\n--- ${displayTree} (${treeBuilds.length} builds) ---`);

    // Column header
    let header = "  " + "Apex".padEnd(6);
    for (const col of CLUSTER_COLS) header += col.label.padEnd(col.width);
    if (hasAnyDps) header += "Weighted".padStart(10);
    console.log(header);
    console.log("  " + "-".repeat(header.length - 2));

    for (const b of treeBuilds) {
      const apexMatch = b.archetype?.match(/^Apex (\d+)/);
      const apexStr = apexMatch ? `A${apexMatch[1]}` : "BL";
      const status = resolveClusterStatus(b.archetype, templates);

      let line = "  " + apexStr.padEnd(6);
      for (const col of CLUSTER_COLS) {
        const s = status[col.key];
        let cell;
        if (s === "full") cell = col.label;
        else if (s === "core") cell = col.label + "*";
        else cell = "-";
        line += cell.padEnd(col.width);
      }
      if (hasAnyDps && b.weighted) {
        line += Math.round(b.weighted).toLocaleString().padStart(10);
      }
      console.log(line);
    }
  }

  // Summary
  const treeSummary = Object.entries(byTree)
    .map(([tree, treeBuilds]) => `${treeBuilds.length} ${heroAbbrev(tree)}`)
    .join(" + ");
  console.log(`\nSummary: ${treeSummary} = ${builds.length} total`);

  const archSet = new Set(builds.map((b) => b.archetype).filter(Boolean));
  console.log(`Templates: ${archSet.size}`);

  // Validation warnings
  const invalidBuilds = builds.filter((b) => !b.validated);
  if (invalidBuilds.length > 0) {
    console.log(`\nWARNING: ${invalidBuilds.length} invalid build(s):`);
    for (const b of invalidBuilds) {
      const errs = b.validationErrors ||
        b.validation_errors || ["unknown error"];
      console.log(
        `  ${b.name || b.hash?.slice(0, 20)}: ${(Array.isArray(errs) ? errs : [errs]).join("; ")}`,
      );
    }
  }
}

// --- Utilities ---

function sanitizeId(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 40);
}

// --- Audit: validate builds + analyze talent/hero coverage ---

export function auditRoster() {
  const builds = getRosterBuilds();
  if (!builds || builds.length === 0) {
    console.error("No roster builds found.");
    return;
  }

  const specConfig = getSpecAdapter().getSpecConfig();
  const nodes = loadFullNodeList();
  const total = builds.length;

  // 1. Validate all builds
  console.log("=== Build Validation ===\n");
  let valid = 0;
  let invalid = 0;
  for (const build of builds) {
    const result = validateBuild({ hash: build.hash });
    if (result.valid) {
      valid++;
    } else {
      invalid++;
      console.log(`  FAIL: ${build.name} — ${result.errors.join("; ")}`);
    }
  }
  console.log(`${valid} valid, ${invalid} invalid out of ${total}`);

  // 2. Hero tree distribution
  const byTree = {};
  for (const b of builds) {
    const tree = b.hero_tree || b.heroTree || "unknown";
    (byTree[tree] ||= []).push(b);
  }

  console.log("\n=== Hero Tree Distribution ===\n");
  for (const [tree, treeBuilds] of Object.entries(byTree)) {
    console.log(`${tree}: ${treeBuilds.length} builds`);
  }

  // 3. Archetype coverage
  const byArch = {};
  for (const b of builds) {
    const arch = b.archetype || "untagged";
    byArch[arch] = (byArch[arch] || 0) + 1;
  }
  const archCount = Object.keys(byArch).length;
  const minPerArch = Math.min(...Object.values(byArch));

  console.log(`\n=== Archetype Coverage (${archCount} archetypes) ===\n`);
  const archEntries = Object.entries(byArch).sort((a, b) => b[1] - a[1]);
  for (const [arch, count] of archEntries) {
    const flag = count < 2 ? " ← LOW" : "";
    console.log(`  ${count}x ${arch}${flag}`);
  }
  console.log(`\nMin per archetype: ${minPerArch}`);

  // 4. Hero choice node coverage (decode hashes)
  // Use raidbots data for hero subtree nodes (fullNodeList lacks subTreeId)
  const rbData = JSON.parse(
    readFileSync(dataFile("raidbots-talents.json"), "utf8"),
  );

  console.log("\n=== Hero Choice Coverage ===\n");
  for (const [treeName, treeConfig] of Object.entries(specConfig.heroTrees)) {
    const locks = treeConfig.choiceLocks || {};
    const treeBuilds = builds.filter(
      (b) =>
        (b.hero_tree || b.heroTree) === treeName ||
        (b.hero_tree || b.heroTree) ===
          treeConfig.displayName?.toLowerCase().replace(/\s+/g, "_"),
    );
    if (treeBuilds.length === 0) continue;

    // Hero subtrees in raidbots data are keyed by display name
    const subtreeNodes =
      rbData.heroSubtrees[treeConfig.displayName] ||
      rbData.heroSubtrees[treeName];
    if (!subtreeNodes) continue;

    const choiceNodes = subtreeNodes.filter(
      (n) => n.type === "choice" && n.entries?.length > 1,
    );

    for (const cNode of choiceNodes) {
      const counts = {};
      let missing = 0;
      for (const b of treeBuilds) {
        const { selections } = decode(b.hash, nodes);
        const sel = selections.get(cNode.id);
        if (!sel || sel.rank === 0) {
          missing++;
          continue;
        }
        const idx = sel.choiceIndex || 0;
        const entryName = cNode.entries[idx]?.name || `entry${idx}`;
        counts[entryName] = (counts[entryName] || 0) + 1;
      }

      const isLocked = cNode.id in locks;
      const status = isLocked ? "LOCKED" : "unlocked";
      const entries = cNode.entries
        .map((e, i) => {
          const c = counts[e.name] || 0;
          return `${e.name}=${c}`;
        })
        .join(", ");

      console.log(
        `  ${treeConfig.displayName} ${cNode.id} [${status}]: ${entries}`,
      );
    }
  }

  // 5. Spec talent frequency
  console.log("\n=== Spec Talent Frequency ===\n");
  const talentFreq = {};
  for (const b of builds) {
    const { selections } = decode(b.hash, nodes);
    for (const [nodeId, sel] of selections) {
      if (sel.rank <= 0) continue;
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      let name;
      if (sel.choiceIndex !== undefined && node.entries?.[sel.choiceIndex]) {
        name = node.entries[sel.choiceIndex].name;
      } else if (node.entries?.length >= 1 && node.entries[0]?.name) {
        name = node.entries[0].name;
      } else {
        name = node.name;
      }
      if (!name) continue;
      talentFreq[name] = (talentFreq[name] || 0) + 1;
    }
  }

  const excluded = new Set(specConfig.excludedTalents || []);
  const sorted = Object.entries(talentFreq).sort((a, b) => b[1] - a[1]);

  const alwaysOn = sorted.filter(([, c]) => c === total);
  const varied = sorted.filter(([, c]) => c > 0 && c < total);

  console.log(
    `Always present (${alwaysOn.length} talents at ${total}/${total}):`,
  );
  for (const [name] of alwaysOn) {
    const note = excluded.has(name) ? " ← in excludedTalents?" : "";
    console.log(`  ${name}${note}`);
  }

  console.log(`\nVaried (${varied.length} talents):`);
  for (const [name, count] of varied) {
    const pct = Math.round((count / total) * 100);
    const note = excluded.has(name) ? " [excluded]" : "";
    console.log(`  ${name}: ${count}/${total} (${pct}%)${note}`);
  }

  // 6. Check excluded talents that appear in roster
  const excludedInRoster = varied
    .filter(([name]) => excluded.has(name))
    .map(([name, count]) => `${name} (${count}/${total})`);
  if (excludedInRoster.length > 0) {
    console.log(
      "\nWARNING: Excluded (non-DPS) talents appearing in roster builds:",
    );
    console.log(`  ${excludedInRoster.join(", ")}`);
    console.log(
      "  (Expected: excluded talents appear as BFS connectivity fillers)",
    );
  }

  // Summary
  console.log("\n=== Summary ===\n");
  console.log(`Builds: ${total} (${valid} valid, ${invalid} invalid)`);
  console.log(`Hero trees: ${Object.keys(byTree).join(", ")}`);
  console.log(`Archetypes: ${archCount} (min ${minPerArch} per archetype)`);
  console.log(`Talents: ${alwaysOn.length} always-on, ${varied.length} varied`);
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  await initSpec(parseSpecArg());
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "generate":
      generate();
      break;

    case "show":
      showRoster();
      break;

    case "import-doe": {
      const result = importFromDoe();
      console.log(
        `Done: ${result.added} added, ${result.skipped} skipped, ${result.invalid} invalid`,
      );
      break;
    }

    case "import-community": {
      const result = importCommunity();
      console.log(`Done: ${result.added} added, ${result.skipped} skipped`);
      break;
    }

    case "import-baseline": {
      const result = importBaseline();
      console.log(`Done: ${result.added} added, ${result.skipped} skipped`);
      break;
    }

    case "add": {
      const hash = args[0];
      if (!hash) {
        console.error(
          'Usage: node src/sim/build-roster.js add <hash> --archetype "Name" --hero <tree>',
        );
        process.exit(1);
      }
      const archIdx = args.indexOf("--archetype");
      const heroIdx = args.indexOf("--hero");
      const archetype = archIdx !== -1 ? args[archIdx + 1] : "Manual";
      const heroTree = heroIdx !== -1 ? args[heroIdx + 1] : null;

      if (!heroTree) {
        console.error("--hero <tree> is required");
        process.exit(1);
      }

      const prefix = heroTree
        .split("_")
        .map((w) => w[0].toUpperCase())
        .join("");
      const name = `${prefix}_${sanitizeId(archetype)}_manual`;

      const validation = validateBuild({ hash });
      upsertBuild({
        hash,
        name,
        heroTree,
        archetype,
        source: "manual",
        inRoster: true,
        validated: validation.valid ? 1 : 0,
        validationErrors: validation.valid ? null : validation.errors,
      });

      console.log(`Added: ${name} (${heroTree})`);
      break;
    }

    case "validate": {
      const result = validateAll();
      console.log(
        `Validation: ${result.valid} valid, ${result.invalid} invalid out of ${result.total}`,
      );
      for (const e of result.errors) {
        console.log(`  ${e.id}: ${e.errors.join("; ")}`);
      }
      break;
    }

    case "audit":
      auditRoster();
      break;

    case "prune": {
      const thIdx = args.indexOf("--threshold");
      const threshold = thIdx !== -1 ? parseFloat(args[thIdx + 1]) : 1.0;
      const result = pruneBuilds({ threshold });
      console.log(
        `Pruned ${result.pruned} builds, ${result.remaining} remaining`,
      );
      break;
    }

    case "update-dps": {
      const fidIdx = args.indexOf("--fidelity");
      const fidelity = fidIdx !== -1 ? args[fidIdx + 1] : "quick";
      if (!["quick", "standard", "confirm"].includes(fidelity)) {
        console.error(
          `Invalid fidelity: ${fidelity}. Must be quick, standard, or confirm.`,
        );
        process.exit(1);
      }
      await updateAllDps({ fidelity });
      break;
    }

    case "generate-hashes": {
      const result = generateHashes();
      console.log(
        `Generated ${result.generated} hashes, ${result.failed} failed`,
      );
      break;
    }

    case "generate-names": {
      const builds = getRosterBuilds();
      if (!builds || builds.length === 0) {
        console.error("No roster builds found.");
        process.exit(1);
      }
      generateDisplayNames(builds);
      const named = builds.filter((b) => b.displayName).length;
      console.log(`Generated display names for ${named} builds.`);
      break;
    }

    default:
      console.log(`Build Roster Manager (DB-first)

Usage:
  node src/sim/build-roster.js generate                          Build full layered roster (recommended)
  node src/sim/build-roster.js show                              Show roster (hierarchical)
  node src/sim/build-roster.js import-doe                        Import from DB archetypes (DoE)
  node src/sim/build-roster.js import-community                  Import community builds from config
  node src/sim/build-roster.js import-baseline                   Import baseline.simc build
  node src/sim/build-roster.js add <hash> --archetype "N" --hero <tree>  Add manually
  node src/sim/build-roster.js validate                          Re-validate all builds
  node src/sim/build-roster.js audit                             Full coverage audit (validate + talent + hero)
  node src/sim/build-roster.js prune [--threshold 1.0]           Prune redundant builds
  node src/sim/build-roster.js update-dps [--fidelity quick|standard|confirm]  Sim all builds
  node src/sim/build-roster.js generate-hashes                   Generate hashes for override-only builds
  node src/sim/build-roster.js generate-names                    Retroactively assign display names`);
      break;
  }

  closeAll();
}
