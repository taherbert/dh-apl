// Archetype definitions for Vengeance Demon Hunter builds.
// Archetypes are strategic build directions that inform hypothesis generation.
// Usage: node src/analyze/archetypes.js [talents.json]

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

function collapseWhitespace(text) {
  return text.trim().replace(/\s+/g, " ");
}

// Seed archetypes — known strategic build directions within each hero tree.
const SEED_ARCHETYPES = {
  "ar-spirit-bomb-burst": {
    heroTree: "aldrachi_reaver",
    description: collapseWhitespace(`
      Pool soul fragments until Soul Furnace reaches 8+ stacks, then spend with
      Spirit Bomb for massive AoE burst. The core loop is: generate fragments
      via Fracture/Fallout → wait for Soul Furnace threshold → Spirit Bomb →
      repeat. Sacrifices consistent damage for periodic burst windows.
    `),
    coreLoop:
      "fragment generation → Soul Furnace threshold → Spirit Bomb burst",
    keyTalents: ["Spirit Bomb", "Soul Furnace", "Fracture", "Fallout"],
    keyBuffs: ["soul_furnace"],
    keyAbilities: ["spirit_bomb", "fracture"],
    tradeoffs:
      "Burst over sustain; weaker in pure ST where fragments come slower",
    aplFocus: ["ar"],
  },

  "ar-soul-cleave-sustain": {
    heroTree: "aldrachi_reaver",
    description: collapseWhitespace(`
      Skip Spirit Bomb entirely. Use Soul Cleave as primary spender for consistent
      damage + self-healing. Stronger in sustained ST/small cleave where fragment
      income is lower and you can't reliably stack Soul Furnace.
    `),
    coreLoop: "Fracture → Soul Cleave → repeat",
    keyTalents: ["Soul Cleave", "Void Reaver", "Focused Cleave"],
    excludeTalents: ["Spirit Bomb"],
    keyBuffs: [],
    keyAbilities: ["soul_cleave", "fracture"],
    tradeoffs: "Sustain over burst; weaker in large AoE",
    aplFocus: ["ar"],
  },

  "ar-reaver-window": {
    heroTree: "aldrachi_reaver",
    description: collapseWhitespace(`
      Maximize Aldrachi Reaver's unique buff chain: Art of the Glaive stacks →
      Reaver's Glaive → Rending Strike window → empowered Soul Cleave/Fracture.
      The core loop is tightly sequenced: build AotG stacks, fire Reaver's Glaive,
      then execute the Rending Strike rotation before the buff expires.
    `),
    coreLoop: "AotG stacks → Reaver's Glaive → Soul Cleave → Fracture",
    keyTalents: [
      "Art of the Glaive",
      "Rending Strike",
      "Glaive Flurry",
      "Keen Edge",
    ],
    keyBuffs: [
      "art_of_the_glaive",
      "rending_strike",
      "glaive_flurry",
      "reavers_mark",
    ],
    keyAbilities: ["reavers_glaive", "soul_cleave", "fracture"],
    tradeoffs: "High skill ceiling; DPS loss if chain is broken or mistimed",
    aplFocus: ["ar"],
  },

  "ar-fiery-demise": {
    heroTree: "aldrachi_reaver",
    description: collapseWhitespace(`
      Build around Fiery Brand and Fiery Demise for sustained fire damage amp.
      Maintain Fiery Brand on targets, use Burning Alive to spread, and align
      high-damage abilities during the debuff window.
    `),
    coreLoop: "Fiery Brand → spread via Burning Alive → damage during debuff",
    keyTalents: [
      "Fiery Brand",
      "Fiery Demise",
      "Burning Alive",
      "Charred Flesh",
    ],
    keyBuffs: ["fiery_brand"],
    keyAbilities: ["fiery_brand", "immolation_aura", "sigil_of_flame"],
    tradeoffs:
      "Strong multi-target sustain; requires Fiery Brand uptime management",
    aplFocus: ["ar"],
  },

  "anni-voidfall-burst": {
    heroTree: "annihilator",
    description: collapseWhitespace(`
      Execute the Voidfall cycle: build Voidfall stacks via Fracture, then spend
      at 3 stacks for massive burst. The APL must track building vs spending phases
      and not interrupt the cycle prematurely.
    `),
    coreLoop:
      "Fracture (building) → Soul Cleave (spending) → Spirit Bomb at 3 stacks",
    keyTalents: ["Voidfall", "Catastrophe", "Dark Matter"],
    keyBuffs: ["voidfall_building", "voidfall_spending"],
    keyAbilities: ["fracture", "soul_cleave", "spirit_bomb"],
    tradeoffs: "High burst potential; punished by interrupting the cycle",
    aplFocus: ["anni"],
  },

  "anni-sustained": {
    heroTree: "annihilator",
    description: collapseWhitespace(`
      Less reliant on Voidfall cycle timing. Use Annihilator's passive damage
      bonuses without strict phase tracking. More forgiving but lower ceiling.
    `),
    coreLoop: "Standard priority with Annihilator passives",
    keyTalents: ["Annihilator", "World Killer"],
    keyBuffs: [],
    keyAbilities: ["soul_cleave", "fracture", "fel_devastation"],
    tradeoffs: "Lower ceiling but more forgiving",
    aplFocus: ["anni"],
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
  const archetype = SEED_ARCHETYPES[archetypeId];
  if (!archetype) return null;

  return {
    id: archetypeId,
    heroTree: archetype.heroTree,
    description: archetype.description,
    coreLoop: archetype.coreLoop,
    keyBuffs: archetype.keyBuffs || [],
    keyAbilities: archetype.keyAbilities || [],
    tradeoffs: archetype.tradeoffs,
    aplFocus: archetype.aplFocus || [],
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

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const talentsPath = process.argv[2] || join(DATA_DIR, "talents.json");

  console.log("=".repeat(60));
  console.log("VDH Archetype System");
  console.log("=".repeat(60));

  console.log("\n--- Available Archetypes ---\n");

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
