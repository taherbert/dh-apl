// Persistent build roster for multi-build evaluation.
// Version-controlled at data/{spec}/build-roster.json alongside build-theory.json.
// Builds are imported from multiple sources and validated against talent tree rules.
//
// Sources:
//   1. DoE discovery: results/builds.json → hash-based builds per archetype
//   2. Manual: add <hash> --archetype "Name" --hero <tree>
//
// Usage:
//   node src/sim/build-roster.js show
//   node src/sim/build-roster.js import-doe
//   node src/sim/build-roster.js add <hash> --archetype "Name" --hero <tree>
//   node src/sim/build-roster.js validate
//   node src/sim/build-roster.js prune [--threshold 1.0]
//   node src/sim/build-roster.js migrate

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { getSpecAdapter, initSpec } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { dataFile, resultsFile, ensureSpecDirs } from "../engine/paths.js";
import { validateBuild, validateHash } from "../util/validate-build.js";
import { overridesToHash } from "../util/talent-string.js";
import { getHeroChoiceLocks } from "../model/talent-combos.js";
import {
  upsertBuild,
  setRosterMembership,
  updateBuildDps as dbUpdateBuildDps,
  getRosterBuilds,
} from "../util/db.js";

function rosterPath() {
  return dataFile("build-roster.json");
}
function buildsPath() {
  return resultsFile("builds.json");
}
// --- Roster I/O ---

export function loadRoster() {
  if (!existsSync(rosterPath())) return null;
  try {
    return JSON.parse(readFileSync(rosterPath(), "utf8"));
  } catch (e) {
    console.error(`Failed to read roster: ${e.message}`);
    return null;
  }
}

function saveRoster(roster) {
  ensureSpecDirs();
  roster._updated = new Date().toISOString();

  const content = JSON.stringify(roster, null, 2);
  const path = rosterPath();
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, content);

  // Backup existing file before overwriting
  if (existsSync(path)) {
    const backupPath = path + ".bak";
    try {
      copyFileSync(path, backupPath);
    } catch {
      // Non-fatal: backup failed, proceed anyway
    }
  }

  renameSync(tmpPath, path);
}

function createEmptyRoster() {
  return {
    _schema: "roster-v2",
    _updated: new Date().toISOString(),
    builds: [],
  };
}

// --- Deduplication ---

// Canonical key for a build — used to detect duplicates.
function buildKey(build) {
  if (build.hash) return `hash:${build.hash}`;
  if (build.overrides) {
    const parts = ["class_talents", "spec_talents", "hero_talents"]
      .filter((key) => build.overrides[key])
      .map((key) => `${key}=${build.overrides[key]}`);
    return `overrides:${parts.sort().join("&")}`;
  }
  return `id:${build.id}`;
}

function isDuplicate(roster, build) {
  const key = buildKey(build);
  return roster.builds.some((b) => buildKey(b) === key);
}

// --- Import: Add builds to roster ---

// Add builds to roster with deduplication and validation.
// Returns { added, skipped, invalid }
export function addBuilds(roster, newBuilds, { source = "manual" } = {}) {
  let added = 0;
  let skipped = 0;
  let invalid = 0;

  for (const build of newBuilds) {
    const key = buildKey(build);
    const existing = roster.builds.find((b) => buildKey(b) === key);

    if (existing) {
      if (build.lastDps) {
        existing.lastDps = build.lastDps;
        existing.lastTestedAt = build.lastTestedAt || new Date().toISOString();
      }
      skipped++;
      continue;
    }

    const validation = validateBuild(build);
    if (!validation.valid) {
      console.warn(
        `  WARNING: Build ${build.id} has validation errors: ${validation.errors.join("; ")}`,
      );
      invalid++;
    }

    const rosterBuild = {
      id: build.id,
      archetype: build.archetype || "Unknown",
      heroTree: build.heroTree,
      hash: build.hash || null,
      overrides: build.overrides || null,
      source,
      addedAt: new Date().toISOString(),
      validated: validation.valid,
      validationErrors: validation.valid ? undefined : validation.errors,
      lastDps: build.lastDps || null,
      lastTestedAt: build.lastTestedAt || null,
    };
    roster.builds.push(rosterBuild);

    // Sync to DB
    if (rosterBuild.hash) {
      try {
        upsertBuild({
          hash: rosterBuild.hash,
          name: rosterBuild.id,
          heroTree: rosterBuild.heroTree,
          archetype: rosterBuild.archetype,
          overrides: rosterBuild.overrides,
          source,
          inRoster: true,
          validated: rosterBuild.validated ? 1 : 0,
          dps_st: rosterBuild.lastDps?.st,
          dps_small_aoe: rosterBuild.lastDps?.small_aoe,
          dps_big_aoe: rosterBuild.lastDps?.big_aoe,
          weighted: rosterBuild.lastDps?.weighted,
        });
      } catch {
        // DB sync is non-fatal
      }
    }

    added++;
  }

  return { added, skipped, invalid };
}

// --- Import from DoE discovery (builds.json) ---

export function importFromDoe(roster) {
  if (!roster) roster = loadRoster() || createEmptyRoster();

  if (!existsSync(buildsPath())) {
    console.error(`builds.json not found at ${buildsPath()}`);
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const data = JSON.parse(readFileSync(buildsPath(), "utf8"));
  const archetypes = data.discoveredArchetypes || [];
  const specConfig = getSpecAdapter().getSpecConfig();
  // Build DoE tree set with both config key and normalized forms for matching
  const doeTrees = new Set();
  for (const [name, cfg] of Object.entries(specConfig.heroTrees)) {
    if (cfg.buildMethod === "doe") {
      doeTrees.add(name); // e.g., "void_scarred"
      doeTrees.add(name.replace(/_/g, "-")); // e.g., "void-scarred"
    }
  }

  if (doeTrees.size === 0) {
    console.error("No DoE hero trees configured");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const newBuilds = [];
  const usedIds = new Set(roster.builds.map((b) => b.id));

  for (const arch of archetypes) {
    if (!doeTrees.has(arch.heroTree)) continue;

    // bestBuild + up to 2 alternates
    const candidates = [arch.bestBuild, ...(arch.alternateBuilds || [])].slice(
      0,
      3,
    );
    let added = 0;

    for (const candidate of candidates) {
      if (!candidate?.hash) continue;

      const prefix = arch.heroTree
        .split("_")
        .map((w) => w[0].toUpperCase())
        .join("");
      let id = `${prefix}_${sanitizeId(arch.name)}_${added + 1}`;
      while (usedIds.has(id)) id += "_2";
      usedIds.add(id);

      const dps = candidate.dps || {};
      newBuilds.push({
        id,
        archetype: arch.name,
        heroTree: arch.heroTree,
        hash: candidate.hash,
        overrides: null,
        lastDps: {
          st: Math.round(dps.st || 0),
          small_aoe: Math.round(dps.small_aoe || 0),
          big_aoe: Math.round(dps.big_aoe || 0),
          weighted: candidate.weighted || 0,
        },
        lastTestedAt: data._generated || new Date().toISOString(),
      });
      added++;
    }
  }

  console.log(`Importing ${newBuilds.length} DoE builds from builds.json...`);
  const result = addBuilds(roster, newBuilds, { source: "doe" });
  if (result.added > 0) saveRoster(roster);
  return result;
}

// --- Validate all builds ---

export function validateAll(roster) {
  if (!roster) roster = loadRoster();
  if (!roster) {
    console.error("No roster found.");
    return { total: 0, valid: 0, invalid: 0, errors: [] };
  }

  let valid = 0;
  let invalid = 0;
  const errors = [];

  for (const build of roster.builds) {
    const result = validateBuild(build);
    build.validated = result.valid;
    if (result.valid) {
      delete build.validationErrors;
      valid++;
    } else {
      build.validationErrors = result.errors;
      errors.push({ id: build.id, errors: result.errors });
      invalid++;
    }
  }

  saveRoster(roster);
  return { total: roster.builds.length, valid, invalid, errors };
}

// --- Prune redundant builds ---

export function pruneBuilds(roster, { threshold = 1.0 } = {}) {
  if (!roster) roster = loadRoster();
  if (!roster) {
    console.error("No roster found.");
    return { pruned: 0, remaining: 0 };
  }

  const groups = {};
  for (const build of roster.builds) {
    const key = `${build.heroTree}|${build.archetype}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(build);
  }

  const toPrune = new Set();
  for (const builds of Object.values(groups)) {
    if (builds.length <= 1) continue;

    builds.sort(
      (a, b) => (b.lastDps?.weighted || 0) - (a.lastDps?.weighted || 0),
    );

    const bestW = builds[0].lastDps?.weighted || 0;
    if (bestW === 0) continue;

    for (let i = 1; i < builds.length; i++) {
      const w = builds[i].lastDps?.weighted || 0;
      if (w === 0 || ((bestW - w) / bestW) * 100 <= threshold) continue;
      toPrune.add(builds[i].id);
    }
  }

  const before = roster.builds.length;
  roster.builds = roster.builds.filter((b) => !toPrune.has(b.id));
  const pruned = before - roster.builds.length;

  if (pruned > 0) saveRoster(roster);
  return { pruned, remaining: roster.builds.length };
}

// --- Update DPS for a build ---

export function updateDps(roster, buildId, dpsMap) {
  if (!roster) roster = loadRoster();
  if (!roster) return;

  const build = roster.builds.find((b) => b.id === buildId);
  if (!build) return;

  build.lastDps = {
    st: Math.round(dpsMap.st || 0),
    small_aoe: Math.round(dpsMap.small_aoe || 0),
    big_aoe: Math.round(dpsMap.big_aoe || 0),
    weighted: dpsMap.weighted || 0,
  };
  build.lastTestedAt = new Date().toISOString();

  // Sync DPS to DB
  if (build.hash) {
    try {
      dbUpdateBuildDps(build.hash, build.lastDps);
    } catch {
      // DB sync is non-fatal
    }
  }
}

// Save roster after batch DPS updates.
export function saveRosterDps(roster) {
  if (roster) saveRoster(roster);
}

// --- Show ---

export function showRoster() {
  const roster = loadRoster();
  if (!roster) {
    console.log(
      "No roster found. Run: node src/sim/build-roster.js migrate  (or import-doe)",
    );
    return;
  }

  console.log(`Build Roster (${roster.builds.length} builds)`);
  console.log(`Updated: ${roster._updated}\n`);

  const hasAnyDps = roster.builds.some((b) => b.lastDps);
  if (hasAnyDps) {
    console.log(
      `${"ID".padEnd(28)} ${"V".padEnd(2)} ${"Hero".padEnd(12)} ${"Archetype".padEnd(30)} ${"Source".padEnd(14)} ${"Weighted".padStart(10)}`,
    );
    console.log("-".repeat(100));
    for (const b of roster.builds) {
      const v = b.validated ? "Y" : "N";
      const w = b.lastDps?.weighted
        ? Math.round(b.lastDps.weighted).toLocaleString()
        : "—";
      console.log(
        `${b.id.padEnd(28)} ${v.padEnd(2)} ${b.heroTree.padEnd(12)} ${(b.archetype || "").padEnd(30)} ${b.source.padEnd(14)} ${w.padStart(10)}`,
      );
    }
  } else {
    console.log(
      `${"ID".padEnd(28)} ${"V".padEnd(2)} ${"Hero".padEnd(12)} ${"Archetype".padEnd(30)} ${"Source".padEnd(14)}`,
    );
    console.log("-".repeat(90));
    for (const b of roster.builds) {
      const v = b.validated ? "Y" : "N";
      console.log(
        `${b.id.padEnd(28)} ${v.padEnd(2)} ${b.heroTree.padEnd(12)} ${(b.archetype || "").padEnd(30)} ${b.source.padEnd(14)}`,
      );
    }
  }

  // Group by hero tree
  const treeCounts = {};
  for (const b of roster.builds) {
    treeCounts[b.heroTree] = (treeCounts[b.heroTree] || 0) + 1;
  }
  const summary = Object.entries(treeCounts)
    .map(([tree, count]) => `${count} ${tree}`)
    .join(" + ");
  console.log(`\nSummary: ${summary} = ${roster.builds.length} total`);

  // Show validation status
  const invalidBuilds = roster.builds.filter((b) => !b.validated);
  if (invalidBuilds.length > 0) {
    console.log(`\nWARNING: ${invalidBuilds.length} invalid build(s):`);
    for (const b of invalidBuilds) {
      console.log(
        `  ${b.id}: ${(b.validationErrors || ["unknown error"]).join("; ")}`,
      );
    }
  }
}

// --- Migration from v1 (results/build-roster.json) to v2 (data/build-roster.json) ---

export function migrate() {
  console.log("Migrating to persistent build roster (v2)...\n");

  const roster = createEmptyRoster();

  // 1. Import from DoE (builds.json)
  const doeResult = importFromDoe(roster);
  console.log(
    `  DoE: ${doeResult.added} added, ${doeResult.skipped} existing, ${doeResult.invalid} invalid`,
  );

  // 2. Validate all
  const valResult = validateAll(roster);
  console.log(
    `\nValidation: ${valResult.valid} valid, ${valResult.invalid} invalid out of ${valResult.total} builds`,
  );

  if (valResult.errors.length > 0) {
    for (const e of valResult.errors) {
      console.log(`  ${e.id}: ${e.errors.join("; ")}`);
    }
  }

  console.log(
    `\nRoster saved to data/build-roster.json (${roster.builds.length} builds)`,
  );
  return roster;
}

// --- Generate hashes for override-only builds ---

export function generateHashes(roster) {
  if (!roster) roster = loadRoster();
  if (!roster) {
    console.error("No roster found.");
    return { generated: 0, failed: 0 };
  }

  let generated = 0;
  let failed = 0;

  for (const build of roster.builds) {
    if (build.hash) continue;
    if (!build.overrides) {
      console.warn(`  SKIP: ${build.id} — no hash and no overrides`);
      continue;
    }

    try {
      const hash = overridesToHash(build.overrides, {
        heroChoiceLocks: getHeroChoiceLocks(),
      });
      const validation = validateHash(hash);
      if (!validation.valid) {
        console.error(
          `  FAIL: ${build.id} — hash validation: ${validation.errors.join("; ")}`,
        );
        failed++;
        continue;
      }
      build.hash = hash;
      delete build.overrides;
      build.validated = true;
      delete build.validationErrors;
      generated++;
      console.log(`  OK: ${build.id} → ${hash.slice(0, 20)}...`);
    } catch (e) {
      console.error(`  FAIL: ${build.id} — ${e.message}`);
      failed++;
    }
  }

  if (generated > 0) saveRoster(roster);
  return { generated, failed };
}

// --- Utilities ---

function sanitizeId(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 40);
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  await initSpec(parseSpecArg());
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "show":
      showRoster();
      break;

    case "import-doe": {
      const result = importFromDoe();
      console.log(
        `Done: ${result.added} added, ${result.skipped} existing, ${result.invalid} invalid`,
      );
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

      const roster = loadRoster() || createEmptyRoster();
      const prefix = heroTree
        .split("_")
        .map((w) => w[0].toUpperCase())
        .join("");
      const id = `${prefix}_${sanitizeId(archetype)}_manual`;

      const result = addBuilds(
        roster,
        [{ id, archetype, heroTree, hash, overrides: null }],
        { source: "manual" },
      );
      if (result.added > 0) saveRoster(roster);
      console.log(
        `Done: ${result.added} added, ${result.skipped} existing, ${result.invalid} invalid`,
      );
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

    case "prune": {
      const thIdx = args.indexOf("--threshold");
      const threshold = thIdx !== -1 ? parseFloat(args[thIdx + 1]) : 1.0;
      const result = pruneBuilds(null, { threshold });
      console.log(
        `Pruned ${result.pruned} builds, ${result.remaining} remaining`,
      );
      break;
    }

    case "generate-hashes": {
      const result = generateHashes();
      console.log(
        `Generated ${result.generated} hashes, ${result.failed} failed`,
      );
      break;
    }

    case "migrate":
      migrate();
      break;

    default:
      console.log(`Build Roster Manager (persistent)

Usage:
  node src/sim/build-roster.js show                              Show roster
  node src/sim/build-roster.js import-doe                        Import from builds.json
  node src/sim/build-roster.js add <hash> --archetype "N" --hero <tree>  Add manually
  node src/sim/build-roster.js validate                          Re-validate all builds
  node src/sim/build-roster.js prune [--threshold 1.0]           Prune redundant builds
  node src/sim/build-roster.js generate-hashes                   Generate hashes for override-only builds
  node src/sim/build-roster.js migrate                           One-time migration from v1`);
      break;
  }
}
