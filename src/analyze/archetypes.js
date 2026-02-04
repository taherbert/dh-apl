// Archetype definitions for Vengeance Demon Hunter builds.
// Archetypes are strategic build directions that inform hypothesis generation.
// Usage: node src/analyze/archetypes.js [talents.json]

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const RESULTS_DIR = join(ROOT, "results");

function collapseWhitespace(text) {
  return text.trim().replace(/\s+/g, " ");
}

// Seed archetypes — known strategic build directions within each hero tree.
// Updated with Midnight 12.0 mechanics from community guides.
const SEED_ARCHETYPES = {
  "ar-reaver-window": {
    heroTree: "aldrachi_reaver",
    description: collapseWhitespace(`
      Maximize Aldrachi Reaver's unique buff chain. Consume 20 Soul Fragments or
      cast Sigil of Spite to convert Throw Glaive into Reaver's Glaive. This
      enhances your next Fracture (+10% damage) and Soul Cleave (+20% damage).
      CRITICAL: Always sequence Fracture → Soul Cleave after Reaver's Glaive to
      apply Reaver's Mark and trigger Aldrachi Tactics for faster regeneration.
    `),
    coreLoop:
      "Sigil of Spite/fragments → Reaver's Glaive → Fracture (empowered) → Soul Cleave (empowered)",
    keyTalents: [
      "Art of the Glaive",
      "Rending Strike",
      "Glaive Flurry",
      "Keen Edge",
      "Aldrachi Tactics",
      "Bladecraft",
    ],
    keyBuffs: [
      "art_of_the_glaive",
      "rending_strike",
      "glaive_flurry",
      "reavers_mark",
    ],
    keyAbilities: [
      "reavers_glaive",
      "sigil_of_spite",
      "fracture",
      "soul_cleave",
    ],
    tradeoffs:
      "High skill ceiling; DPS loss if Fracture→Soul Cleave sequence is broken",
    aplFocus: ["ar"],
    sequencingRules: [
      "After Reaver's Glaive, ALWAYS cast Fracture first, then Soul Cleave",
      "Fracture with Rending Strike applies Reaver's Mark (7% → 14% damage taken)",
      "Second empowered ability shatters additional Soul Fragment via Aldrachi Tactics",
      "Bladecraft allows Reaver's Mark to stack up to 3x",
    ],
  },

  "ar-fiery-demise": {
    heroTree: "aldrachi_reaver",
    description: collapseWhitespace(`
      Build around Fiery Brand and Fiery Demise for fire damage amplification.
      Fiery Brand provides 15% Fire damage amp on target. Align fire abilities
      during the debuff window: Fel Devastation, Soul Carver, Sigil of Spite.
      Use Burning Alive to spread Fiery Brand in AoE.
    `),
    coreLoop:
      "Fiery Brand → Fel Devastation/Soul Carver/Sigil of Spite during window → spread via Burning Alive",
    keyTalents: [
      "Fiery Brand",
      "Fiery Demise",
      "Burning Alive",
      "Charred Flesh",
      "Down in Flames",
    ],
    keyBuffs: ["fiery_brand"],
    keyAbilities: [
      "fiery_brand",
      "fel_devastation",
      "soul_carver",
      "sigil_of_spite",
    ],
    tradeoffs:
      "Strong burst windows; requires tracking Fiery Brand uptime for ability alignment",
    aplFocus: ["ar"],
    synergies: [
      "Fel Devastation deals Fire damage — sync with Fiery Brand",
      "Soul Carver benefits from Fiery Demise — use with 3+ sec Fiery Brand remaining",
      "Sigil of Spite syncs with Fiery Brand for damage amp",
    ],
  },

  "ar-spirit-bomb-cooldown": {
    heroTree: "aldrachi_reaver",
    description: collapseWhitespace(`
      In Midnight, Spirit Bomb is a 25-second cooldown (affected by Haste), not a
      regular spender. Use it as a burst damage window, ideally with 5 Soul
      Fragments and Soul Furnace stacks if talented. Soul Cleave is now the
      primary spender for routine damage.
    `),
    coreLoop:
      "Soul Cleave as primary spender → Spirit Bomb on cooldown with max fragments",
    keyTalents: ["Spirit Bomb", "Soul Furnace", "Fracture", "Fallout"],
    keyBuffs: ["soul_furnace"],
    keyAbilities: ["spirit_bomb", "soul_cleave", "fracture"],
    tradeoffs:
      "Spirit Bomb is burst, not sustain; don't hold it too long waiting for perfect conditions",
    aplFocus: ["ar"],
    mechanicChanges: [
      "Spirit Bomb is now 25s cooldown baseline (reduced by Haste)",
      "Soul Cleave is primary spender in Midnight",
      "Soul Furnace still amplifies Spirit Bomb at 8+ stacks",
    ],
  },

  "anni-voidfall-burst": {
    heroTree: "annihilator",
    description: collapseWhitespace(`
      Execute the Voidfall cycle: Fracture has 35% chance to grant Voidfall stacks
      (max 3). At 3 stacks, Soul Cleave or Spirit Bomb triggers fel meteors for
      massive Shadowflame burst. Key synergy: Metamorphosis grants up to 3 stacks
      and resets Spirit Bomb via Mass Acceleration. Spend stacks BEFORE using
      Meta to avoid waste.
    `),
    coreLoop:
      "Fracture (build Voidfall) → spend at 3 stacks → Spirit Bomb before Meta → Meta resets Spirit Bomb",
    keyTalents: [
      "Voidfall",
      "Catastrophe",
      "Dark Matter",
      "Mass Acceleration",
      "World Killer",
      "Swift Erasure",
      "Phase Shift",
    ],
    keyBuffs: ["voidfall_building", "voidfall_spending"],
    keyAbilities: ["fracture", "soul_cleave", "spirit_bomb", "metamorphosis"],
    tradeoffs:
      "High burst potential; requires tracking Voidfall stacks and Meta timing",
    aplFocus: ["anni"],
    voidfallRules: [
      "Fracture has 35% chance to grant 1 Voidfall stack",
      "Max 3 stacks — Soul Cleave or Spirit Bomb at 3 triggers meteors",
      "Swift Erasure: +2% Haste per stack",
      "Metamorphosis grants up to 3 stacks — spend before Meta to avoid overcapping",
      "Mass Acceleration resets Spirit Bomb cooldown when Meta activates",
      "World Killer reduces Meta cooldown when meteors are called",
    ],
  },

  "anni-meta-cycling": {
    heroTree: "annihilator",
    description: collapseWhitespace(`
      Focus on Metamorphosis uptime through World Killer cooldown reduction.
      Each meteor set reduces Meta cooldown. Spam Fracture during Meta (3 fragments
      per cast) to rapidly generate fragments and Voidfall stacks. Spirit Bomb
      at 3+ fragments during Meta (not 4+) due to increased fragment generation.
    `),
    coreLoop:
      "Spirit Bomb at 3 Voidfall → Meta → Fracture spam → quick Spirit Bomb at 3+ frags",
    keyTalents: [
      "World Killer",
      "Mass Acceleration",
      "Untethered Rage",
      "Voidfall",
    ],
    keyBuffs: ["metamorphosis", "voidfall_building", "voidfall_spending"],
    keyAbilities: ["metamorphosis", "spirit_bomb", "fracture", "soul_cleave"],
    tradeoffs:
      "Requires tight cooldown tracking; Spirit Bomb threshold changes during Meta",
    aplFocus: ["anni"],
    metaRules: [
      "During Meta, Fracture generates 3 Soul Fragments (not 2)",
      "Spirit Bomb at 3+ fragments during Meta (threshold lowered)",
      "World Killer: each meteor set reduces Meta cooldown",
      "Chain: Voidfall spend → Meta → Mass Acceleration Spirit Bomb reset → burst",
    ],
  },
};

export function detectArchetype(talents, heroTree = null) {
  const matches = [];

  for (const [id, archetype] of Object.entries(SEED_ARCHETYPES)) {
    if (heroTree && archetype.heroTree !== heroTree) continue;

    // When talents is null but heroTree specified, return all archetypes for that tree
    // with baseline confidence (allows strategic hypotheses to use archetype context)
    if (!talents && heroTree) {
      matches.push({
        id,
        archetype,
        score: 0,
        maxScore: 0,
        confidence: 0.5, // baseline confidence when we can't score
      });
      continue;
    }

    let score = 0;
    let maxScore = 0;

    for (const talent of archetype.keyTalents || []) {
      maxScore += 2;
      if (hasTalent(talents, talent)) score += 2;
    }

    for (const talent of archetype.excludeTalents || []) {
      if (hasTalent(talents, talent)) score -= 3;
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
  const arch = SEED_ARCHETYPES[archetypeId];
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
  return Object.entries(SEED_ARCHETYPES)
    .filter(([, arch]) => arch.heroTree === heroTree)
    .map(([id, arch]) => ({ id, ...arch }));
}

export function getStrategicBuffs(archetypeId) {
  return SEED_ARCHETYPES[archetypeId]?.keyBuffs || [];
}

export function getCoreAbilities(archetypeId) {
  return SEED_ARCHETYPES[archetypeId]?.keyAbilities || [];
}

export function getAllArchetypes() {
  return { ...SEED_ARCHETYPES };
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

// Load discovered archetypes from results/builds.json.
// Returns array of { name, heroTree, definingTalents, bestBuild, ... } or null if unavailable.
export function loadDiscoveredArchetypes() {
  const data = loadBuildsJson();
  return data?.archetypes || null;
}

// Load all discovered builds ranked by weighted DPS.
// Returns array of { name, hash, heroTree, dps, weighted, rank } or null.
export function getDiscoveredBuilds() {
  const data = loadBuildsJson();
  return data?.allBuilds || null;
}

// Get factor impacts from discovery.
export function getFactorImpacts() {
  const data = loadBuildsJson();
  return data?.factorImpacts || null;
}

// Get synergy pairs from discovery.
export function getSynergyPairs() {
  const data = loadBuildsJson();
  return data?.synergyPairs || null;
}

// Get the best build hash for a specific hero tree.
export function getBestBuildHash(heroTree) {
  const archetypes = loadDiscoveredArchetypes();
  if (!archetypes) return null;
  const normalizedTree = heroTree.toLowerCase().replace(/\s+/g, "_");
  const match = archetypes.find((a) => a.heroTree === normalizedTree);
  return match?.bestBuild?.hash || null;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const talentsPath = process.argv[2] || join(DATA_DIR, "talents.json");

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

  console.log("\n--- Seed Archetypes (strategic context) ---\n");

  for (const [id, arch] of Object.entries(SEED_ARCHETYPES)) {
    console.log(`${id} (${arch.heroTree})`);
    console.log(`  Core loop: ${arch.coreLoop}`);
    console.log(`  Key talents: ${arch.keyTalents?.join(", ") || "none"}`);
    console.log(`  Key buffs: ${arch.keyBuffs?.join(", ") || "none"}`);
    console.log(`  Tradeoffs: ${arch.tradeoffs}`);
    console.log();
  }

  // If talents file provided, try to detect archetype
  try {
    const talents = JSON.parse(readFileSync(talentsPath, "utf-8"));

    console.log("--- Archetype Detection ---\n");

    // Try AR detection
    const arMatches = detectArchetype(talents, "aldrachi_reaver");
    console.log("Aldrachi Reaver matches:");
    for (const match of arMatches) {
      console.log(
        `  ${match.id}: ${(match.confidence * 100).toFixed(0)}% confidence`,
      );
    }

    // Try Annihilator detection
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
