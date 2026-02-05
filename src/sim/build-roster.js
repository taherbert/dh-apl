// Build roster generator for multi-build evaluation.
// Two data sources:
//   1. AR builds: results/builds.json → hash decode → talent string overrides
//   2. Anni builds: apls/multi-build.simc → extract actor talent overrides
//
// Usage:
//   node src/sim/build-roster.js generate [--tier fast|standard|full]
//   node src/sim/build-roster.js show

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(ROOT, "results");
const ROSTER_PATH = join(RESULTS_DIR, "build-roster.json");
const BUILDS_PATH = join(RESULTS_DIR, "builds.json");
const MULTI_BUILD_PATH = join(ROOT, "apls", "multi-build.simc");
const PROFILE_PATH = join(ROOT, "apls", "profile.simc");

const TIER_LIMITS = {
  fast: 1, // 1 best build per archetype
  standard: 2, // 2 per archetype
  full: Infinity, // all alternates
};

// --- Hash-based build loading (AR from builds.json) ---

function loadARBuilds(tier) {
  if (!existsSync(BUILDS_PATH)) return [];

  const data = JSON.parse(readFileSync(BUILDS_PATH, "utf8"));
  const archetypes = data.archetypes || [];
  const limit = TIER_LIMITS[tier] || 1;
  const builds = [];

  const usedIds = new Set();
  for (const arch of archetypes) {
    if (arch.heroTree !== "aldrachi_reaver") continue;

    const candidates = [arch.bestBuild, ...(arch.alternateBuilds || [])];
    let added = 0;

    for (const candidate of candidates) {
      if (added >= limit) break;
      if (!candidate?.hash) continue;

      let id = `AR_${sanitizeId(arch.name)}_${added + 1}`;
      // Ensure unique IDs across archetypes
      if (usedIds.has(id)) {
        let suffix = 2;
        while (usedIds.has(`${id}_${suffix}`)) suffix++;
        id = `${id}_${suffix}`;
      }
      usedIds.add(id);

      builds.push({
        id,
        archetype: arch.name,
        heroTree: "aldrachi_reaver",
        hash: candidate.hash,
        // Hash-based builds use talents=<hash> directly in multi-actor files
        overrides: null,
        source: "builds.json",
      });
      added++;
    }
  }

  return builds;
}

// --- Multi-build.simc actor parsing (Anni) ---

function loadAnniBuilds() {
  if (!existsSync(MULTI_BUILD_PATH)) return [];

  const content = readFileSync(MULTI_BUILD_PATH, "utf8");
  const lines = content.split("\n");
  const actors = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Start of first actor: demonhunter="name"
    const dhMatch = trimmed.match(/^demonhunter="([^"]+)"/);
    if (dhMatch) {
      current = { name: dhMatch[1], overrides: {} };
      actors.push(current);
      continue;
    }

    // Start of copy actor: copy="name","source"
    const copyMatch = trimmed.match(/^copy="([^"]+)"/);
    if (copyMatch) {
      current = { name: copyMatch[1], overrides: {} };
      actors.push(current);
      continue;
    }

    if (!current) continue;

    // Extract talent override lines
    const classMatch = trimmed.match(/^class_talents=(.+)/);
    if (classMatch) {
      current.overrides.class_talents = classMatch[1];
      continue;
    }
    const specMatch = trimmed.match(/^spec_talents=(.+)/);
    if (specMatch) {
      current.overrides.spec_talents = specMatch[1];
      continue;
    }
    const heroMatch = trimmed.match(/^hero_talents=(.+)/);
    if (heroMatch) {
      current.overrides.hero_talents = heroMatch[1];
      continue;
    }
  }

  // Resolve inheritance: copy actors inherit from their source
  const byName = new Map(actors.map((a) => [a.name, a]));
  for (const actor of actors) {
    // Find the copy source
    const copyLine = content.match(
      new RegExp(`copy="${actor.name}","([^"]+)"`),
    );
    if (copyLine) {
      const source = byName.get(copyLine[1]);
      if (source) {
        // Inherit missing overrides from source
        for (const key of ["class_talents", "spec_talents", "hero_talents"]) {
          if (!actor.overrides[key] && source.overrides[key]) {
            actor.overrides[key] = source.overrides[key];
          }
        }
      }
    }
  }

  // Filter to Anni builds only (exclude AR reference)
  return actors
    .filter((a) => a.overrides.hero_talents === "annihilator")
    .map((a) => ({
      id: a.name,
      archetype: inferAnniArchetype(a.name),
      heroTree: "annihilator",
      hash: null,
      overrides: a.overrides,
      source: "multi-build.simc",
    }));
}

function inferAnniArchetype(actorName) {
  // Actor names like "Anni_CF_DiF_SC_FO" → "CF+DiF+SC+FO"
  const parts = actorName.replace(/^Anni_/, "").split("_");
  return parts.join("+") || actorName;
}

// --- AR reference from profile.simc ---

function loadProfileARReference() {
  if (!existsSync(PROFILE_PATH)) return null;

  const content = readFileSync(PROFILE_PATH, "utf8");
  const hashMatch = content.match(/^talents=(.+)$/m);
  if (!hashMatch) return null;

  const hash = hashMatch[1].trim();

  return {
    id: "AR_Profile_Reference",
    archetype: "Profile Reference",
    heroTree: "aldrachi_reaver",
    hash,
    overrides: null,
    source: "profile.simc",
  };
}

// --- Roster generation ---

export function generateRoster(tier = "fast") {
  console.log(`Generating build roster (tier: ${tier})...`);

  // Load AR builds from builds.json
  let arBuilds = loadARBuilds(tier);
  if (arBuilds.length === 0) {
    // Fallback: use profile.simc hash as single AR reference
    const profileRef = loadProfileARReference();
    if (profileRef) {
      arBuilds = [profileRef];
      console.log(
        "  No AR builds in builds.json — using profile.simc as AR reference",
      );
    }
  } else {
    console.log(`  Loaded ${arBuilds.length} AR builds from builds.json`);
  }

  // Load Anni builds from multi-build.simc
  const anniBuilds = loadAnniBuilds();
  console.log(
    `  Loaded ${anniBuilds.length} Anni builds from multi-build.simc`,
  );

  const allBuilds = [...arBuilds, ...anniBuilds];

  if (allBuilds.length === 0) {
    console.error(
      "No builds found. Run `npm run discover -- --ar-only` or ensure apls/multi-build.simc exists.",
    );
    process.exit(1);
  }

  const roster = {
    _schema: "roster-v1",
    _generated: new Date().toISOString(),
    _sources: {
      builds: existsSync(BUILDS_PATH) ? fileHash(BUILDS_PATH) : null,
      multiBuild: existsSync(MULTI_BUILD_PATH)
        ? fileHash(MULTI_BUILD_PATH)
        : null,
    },
    tier,
    builds: allBuilds,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(ROSTER_PATH, JSON.stringify(roster, null, 2));
  console.log(
    `\nRoster saved to results/build-roster.json (${allBuilds.length} builds)`,
  );

  return roster;
}

export function loadRoster() {
  if (!existsSync(ROSTER_PATH)) return null;
  return JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
}

export function showRoster() {
  const roster = loadRoster();
  if (!roster) {
    console.log("No roster found. Run: node src/sim/build-roster.js generate");
    return;
  }

  console.log(
    `Build Roster (${roster.tier} tier, ${roster.builds.length} builds)`,
  );
  console.log(`Generated: ${roster._generated}\n`);
  console.log(
    `${"ID".padEnd(30)} ${"Hero".padEnd(12)} ${"Archetype".padEnd(25)} ${"Source".padEnd(18)}`,
  );
  console.log("-".repeat(90));

  for (const b of roster.builds) {
    console.log(
      `${b.id.padEnd(30)} ${b.heroTree.padEnd(12)} ${(b.archetype || "").padEnd(25)} ${b.source.padEnd(18)}`,
    );
  }

  const arCount = roster.builds.filter(
    (b) => b.heroTree === "aldrachi_reaver",
  ).length;
  const anniCount = roster.builds.filter(
    (b) => b.heroTree === "annihilator",
  ).length;
  console.log(
    `\nSummary: ${arCount} AR + ${anniCount} Anni = ${roster.builds.length} total`,
  );
}

// --- Utilities ---

function sanitizeId(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 40);
}

function fileHash(path) {
  const content = readFileSync(path, "utf8");
  return createHash("md5").update(content).digest("hex").slice(0, 8);
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "generate": {
      let tier = "fast";
      const tierIdx = args.indexOf("--tier");
      if (tierIdx !== -1 && args[tierIdx + 1]) tier = args[tierIdx + 1];
      generateRoster(tier);
      break;
    }
    case "show":
      showRoster();
      break;
    default:
      console.log(`Build Roster Manager

Usage:
  node src/sim/build-roster.js generate [--tier fast|standard|full]
  node src/sim/build-roster.js show`);
      break;
  }
}
