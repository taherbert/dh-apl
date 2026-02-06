// Persistent build roster for multi-build evaluation.
// Version-controlled at data/{spec}/build-roster.json alongside build-theory.json.
// Builds are imported from multiple sources and validated against talent tree rules.
//
// Sources:
//   1. DoE discovery: results/builds.json → hash-based builds per archetype
//   2. Multi-build.simc: apls/{spec}/multi-build.simc → override-based builds
//   3. Profile reference: apls/{spec}/profile.simc → hash from current profile
//   4. Manual: add <hash> --archetype "Name" --hero <tree>
//
// Usage:
//   node src/sim/build-roster.js show
//   node src/sim/build-roster.js import-doe
//   node src/sim/build-roster.js import-multi-build
//   node src/sim/build-roster.js import-profile
//   node src/sim/build-roster.js add <hash> --archetype "Name" --hero <tree>
//   node src/sim/build-roster.js validate
//   node src/sim/build-roster.js prune [--threshold 1.0]
//   node src/sim/build-roster.js migrate

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { config, getSpecAdapter, loadSpecAdapter } from "../engine/startup.js";
import {
  dataDir,
  dataFile,
  resultsFile,
  aplsDir,
  ensureSpecDirs,
} from "../engine/paths.js";
import { validateBuild } from "../util/validate-build.js";

const ROSTER_PATH = dataFile("build-roster.json");
const BUILDS_PATH = resultsFile("builds.json");
const MULTI_BUILD_PATH = join(aplsDir(), "multi-build.simc");
const PROFILE_PATH = join(aplsDir(), "profile.simc");

// --- Roster I/O ---

export function loadRoster() {
  if (!existsSync(ROSTER_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
  } catch (e) {
    console.error(`Failed to read roster: ${e.message}`);
    return null;
  }
}

function saveRoster(roster) {
  ensureSpecDirs();
  roster._updated = new Date().toISOString();

  const content = JSON.stringify(roster, null, 2);
  const tmpPath = ROSTER_PATH + ".tmp";
  writeFileSync(tmpPath, content);

  // Backup existing file before overwriting
  if (existsSync(ROSTER_PATH)) {
    const backupPath = ROSTER_PATH + ".bak";
    try {
      copyFileSync(ROSTER_PATH, backupPath);
    } catch {
      // Non-fatal: backup failed, proceed anyway
    }
  }

  renameSync(tmpPath, ROSTER_PATH);
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

    roster.builds.push({
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
    });
    added++;
  }

  return { added, skipped, invalid };
}

// --- Import from DoE discovery (builds.json) ---

export function importFromDoe(roster) {
  if (!roster) roster = loadRoster() || createEmptyRoster();

  if (!existsSync(BUILDS_PATH)) {
    console.error(`builds.json not found at ${BUILDS_PATH}`);
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const data = JSON.parse(readFileSync(BUILDS_PATH, "utf8"));
  const archetypes = data.discoveredArchetypes || [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const primaryTree = Object.entries(specConfig.heroTrees).find(
    ([, cfg]) => cfg.buildMethod === "doe",
  )?.[0];

  if (!primaryTree) {
    console.error("No DoE hero tree configured");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const newBuilds = [];
  const usedIds = new Set(roster.builds.map((b) => b.id));

  for (const arch of archetypes) {
    if (arch.heroTree !== primaryTree) continue;

    // bestBuild + up to 2 alternates
    const candidates = [arch.bestBuild, ...(arch.alternateBuilds || [])].slice(
      0,
      3,
    );
    let added = 0;

    for (const candidate of candidates) {
      if (!candidate?.hash) continue;

      const prefix = primaryTree
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
        heroTree: primaryTree,
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

// --- Import from multi-build.simc ---

export function importFromMultiBuild(roster) {
  if (!roster) roster = loadRoster() || createEmptyRoster();

  if (!existsSync(MULTI_BUILD_PATH)) {
    console.error(`multi-build.simc not found at ${MULTI_BUILD_PATH}`);
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const className = config.spec.className;
  const specConfig = getSpecAdapter().getSpecConfig();
  const secondaryTrees = Object.entries(specConfig.heroTrees)
    .filter(([, cfg]) => cfg.buildMethod === "multi-actor")
    .map(([name]) => name);

  if (secondaryTrees.length === 0) {
    console.error("No multi-actor hero tree configured");
    return { added: 0, skipped: 0, invalid: 0 };
  }
  const secondaryTree = secondaryTrees[0];

  const content = readFileSync(MULTI_BUILD_PATH, "utf8");
  const actors = [];
  let current = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    const actorMatch = trimmed.match(new RegExp(`^${className}="([^"]+)"`));
    const copyMatch = trimmed.match(/^copy="([^"]+)"/);

    if (actorMatch || copyMatch) {
      current = { name: (actorMatch || copyMatch)[1], overrides: {} };
      actors.push(current);
      continue;
    }

    if (!current) continue;

    for (const key of ["class_talents", "spec_talents", "hero_talents"]) {
      const m = trimmed.match(new RegExp(`^${key}=(.+)`));
      if (m) {
        current.overrides[key] = m[1];
        break;
      }
    }
  }

  // Resolve copy inheritance
  const byName = new Map(actors.map((a) => [a.name, a]));
  for (const actor of actors) {
    const copyLine = content.match(
      new RegExp(`copy="${actor.name}","([^"]+)"`),
    );
    if (!copyLine) continue;
    const source = byName.get(copyLine[1]);
    if (!source) continue;
    for (const key of ["class_talents", "spec_talents", "hero_talents"]) {
      if (!actor.overrides[key] && source.overrides[key]) {
        actor.overrides[key] = source.overrides[key];
      }
    }
  }

  const newBuilds = actors
    .filter((a) => a.overrides.hero_talents === secondaryTree)
    .map((a) => ({
      id: a.name,
      archetype: inferArchetype(a.name),
      heroTree: secondaryTree,
      hash: null,
      overrides: a.overrides,
    }));

  console.log(
    `Importing ${newBuilds.length} multi-build actors from multi-build.simc...`,
  );
  const result = addBuilds(roster, newBuilds, { source: "multi-build" });
  if (result.added > 0) saveRoster(roster);
  return result;
}

// --- Import from profile.simc ---

export function importFromProfile(roster) {
  if (!roster) roster = loadRoster() || createEmptyRoster();

  if (!existsSync(PROFILE_PATH)) {
    console.error(`profile.simc not found at ${PROFILE_PATH}`);
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const specConfig = getSpecAdapter().getSpecConfig();
  const [primaryTree] = Object.keys(specConfig.heroTrees);

  const content = readFileSync(PROFILE_PATH, "utf8");
  const hashMatch = content.match(/^talents=(.+)$/m);
  if (!hashMatch) {
    console.error("No talents= line found in profile.simc");
    return { added: 0, skipped: 0, invalid: 0 };
  }

  const hash = hashMatch[1].trim();
  const prefix = primaryTree
    .split("_")
    .map((w) => w[0].toUpperCase())
    .join("");

  const newBuilds = [
    {
      id: `${prefix}_Profile_Reference`,
      archetype: "Profile Reference",
      heroTree: primaryTree,
      hash,
      overrides: null,
    },
  ];

  console.log("Importing profile reference build...");
  const result = addBuilds(roster, newBuilds, { source: "profile" });
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
      "No roster found. Run: node src/sim/build-roster.js migrate  (or import-doe/import-multi-build)",
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

  // 2. Import from multi-build.simc
  const mbResult = importFromMultiBuild(roster);
  console.log(
    `  Multi-build: ${mbResult.added} added, ${mbResult.skipped} existing, ${mbResult.invalid} invalid`,
  );

  // 3. Import from profile.simc
  const profResult = importFromProfile(roster);
  console.log(
    `  Profile: ${profResult.added} added, ${profResult.skipped} existing, ${profResult.invalid} invalid`,
  );

  // 4. Validate all
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

// --- Utilities ---

function sanitizeId(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 40);
}

function inferArchetype(actorName) {
  return (
    actorName
      .replace(/^Anni_/, "")
      .split("_")
      .join("+") || actorName
  );
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadSpecAdapter();
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

    case "import-multi-build": {
      const result = importFromMultiBuild();
      console.log(
        `Done: ${result.added} added, ${result.skipped} existing, ${result.invalid} invalid`,
      );
      break;
    }

    case "import-profile": {
      const result = importFromProfile();
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

    case "migrate":
      migrate();
      break;

    default:
      console.log(`Build Roster Manager (persistent)

Usage:
  node src/sim/build-roster.js show                              Show roster
  node src/sim/build-roster.js import-doe                        Import from builds.json
  node src/sim/build-roster.js import-multi-build                Import from multi-build.simc
  node src/sim/build-roster.js import-profile                    Import from profile.simc
  node src/sim/build-roster.js add <hash> --archetype "N" --hero <tree>  Add manually
  node src/sim/build-roster.js validate                          Re-validate all builds
  node src/sim/build-roster.js prune [--threshold 1.0]           Prune redundant builds
  node src/sim/build-roster.js migrate                           One-time migration from v1`);
      break;
  }
}
