// Structures DH talent data into organized class/spec/hero trees.
// Reads talents-raw.json (from extraction) and spells.json, outputs talents.json.
// Parses simc C++ source to determine Havoc vs Vengeance spec assignments.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const SIMC_DH_CPP =
  "/Users/tom/Documents/GitHub/simc/engine/class_modules/sc_demon_hunter.cpp";

// Parse the simc C++ source to build talent name → spec mapping.
// Looks for lines like: talent.vengeance.spirit_bomb = find_talent_spell(..., "Spirit Bomb" );
// and: talent.havoc.eye_beam = find_talent_spell(..., "Eye Beam" );
function parseSpecAssignments() {
  const src = readFileSync(SIMC_DH_CPP, "utf-8");
  const specByName = new Map();

  const re =
    /talent\.(havoc|vengeance)\.(\w+)\s*=\s*find_talent_spell\([^"]*"([^"]+)"/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const [, spec, , name] = match;
    // First assignment wins (some talents have multiple rank entries)
    if (!specByName.has(name)) {
      specByName.set(name, spec);
    }
  }

  return specByName;
}

function buildTalentTrees() {
  const rawTalents = JSON.parse(
    readFileSync(join(DATA_DIR, "talents-raw.json"), "utf-8"),
  );
  const spells = JSON.parse(
    readFileSync(join(DATA_DIR, "spells.json"), "utf-8"),
  );
  const spellMap = new Map(spells.map((s) => [s.id, s]));
  const specByName = parseSpecAssignments();

  console.log(
    `Parsed ${specByName.size} spec assignments from simc C++ (${[...specByName.values()].filter((s) => s === "vengeance").length} vengeance, ${[...specByName.values()].filter((s) => s === "havoc").length} havoc)`,
  );

  const trees = {
    class: { name: "Demon Hunter", talents: [] },
    spec: { name: "Vengeance", talents: [] },
    hero: {
      "Fel-Scarred": { subtreeId: 34, talents: [] },
      "Aldrachi Reaver": { subtreeId: 35, talents: [] },
    },
  };

  let havocSkipped = 0;

  for (const raw of rawTalents) {
    if (raw.tree === "selection") continue;

    const spell = spellMap.get(raw.spellId);

    // Determine spec from multiple sources:
    // 1. simc C++ talent.{spec}.{name} assignments (most authoritative)
    // 2. Spell data talentEntry.spec field
    const cppSpec = specByName.get(raw.name);
    const spellSpec = spell?.talentEntry?.spec?.toLowerCase();

    if (cppSpec === "havoc" || (!cppSpec && spellSpec === "havoc")) {
      havocSkipped++;
      continue;
    }

    const talent = {
      name: raw.name,
      entry: raw.entry,
      node: raw.node,
      row: raw.row,
      col: raw.col,
      maxRank: raw.maxRank,
      spellId: raw.spellId,
      spellName: spell?.name || raw.name,
      school: spell?.school || null,
      passive: spell?.passive || false,
      description: spell?.description || null,
    };

    // Determine what this talent does based on spell data
    if (spell) {
      talent.type = categorizeTalent(spell);
      if (spell.resource) talent.resource = spell.resource;
      if (spell.cooldown) talent.cooldown = spell.cooldown;
      if (spell.charges) talent.charges = spell.charges;
      if (spell.gcd) talent.gcd = spell.gcd;
      if (spell.duration) talent.duration = spell.duration;
      if (spell.affectingSpells) talent.affectedBy = spell.affectingSpells;
    }

    if (raw.tree === "class") {
      trees.class.talents.push(talent);
    } else if (raw.tree === "spec") {
      trees.spec.talents.push(talent);
    } else if (raw.tree === "hero") {
      const heroName = raw.heroSpec || `Subtree ${raw.subtree}`;
      if (trees.hero[heroName]) {
        trees.hero[heroName].talents.push(talent);
      }
    }
  }

  // Sort each tree's talents by row, then col
  const sortFn = (a, b) => a.row - b.row || a.col - b.col;
  trees.class.talents.sort(sortFn);
  trees.spec.talents.sort(sortFn);
  for (const hero of Object.values(trees.hero)) {
    hero.talents.sort(sortFn);
  }

  writeFileSync(join(DATA_DIR, "talents.json"), JSON.stringify(trees, null, 2));

  console.log(`Skipped ${havocSkipped} Havoc-only talents`);
  console.log("Wrote data/talents.json");
  console.log(`  Class tree: ${trees.class.talents.length} talents`);
  console.log(`  Spec tree: ${trees.spec.talents.length} talents`);
  for (const [name, hero] of Object.entries(trees.hero)) {
    console.log(`  Hero (${name}): ${hero.talents.length} talents`);
  }

  // Show talent type breakdown
  const allTalents = [
    ...trees.class.talents,
    ...trees.spec.talents,
    ...Object.values(trees.hero).flatMap((h) => h.talents),
  ];
  const typeCounts = {};
  for (const t of allTalents) {
    typeCounts[t.type || "unknown"] =
      (typeCounts[t.type || "unknown"] || 0) + 1;
  }
  console.log("\n  Type breakdown:");
  for (const [type, count] of Object.entries(typeCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${type}: ${count}`);
  }
}

function categorizeTalent(spell) {
  if (!spell.passive && spell.gcd) return "active_ability";
  if (!spell.passive && spell.cooldown && !spell.gcd) return "off_gcd_ability";

  // Check effects for modification patterns
  const effects = spell.effects || [];
  for (const e of effects) {
    const type = e.type?.toLowerCase() || "";
    if (type.includes("apply aura") && type.includes("add percent modifier"))
      return "spell_modifier";
    if (type.includes("apply aura") && type.includes("add flat modifier"))
      return "spell_modifier";
    if (type.includes("proc trigger spell")) return "proc_trigger";
    if (type.includes("apply aura") && type.includes("dummy"))
      return "passive_buff";
  }

  if (spell.passive) return "passive";
  return "other";
}

buildTalentTrees();
