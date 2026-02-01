// Structures DH talent data into organized class/spec/hero trees.
// Reads talents-raw.json (from extraction) and spells.json, outputs talents.json.
// Parses simc C++ source to determine spec and hero tree assignments.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const SIMC_DH_CPP =
  "/Users/tom/Documents/GitHub/simc/engine/class_modules/sc_demon_hunter.cpp";

// Parse the simc C++ source to build talent name → category mapping.
// Categories: havoc, vengeance, devourer (spec trees) and
// aldrachi_reaver, annihilator, scarred (hero trees)
function parseTalentAssignments() {
  const src = readFileSync(SIMC_DH_CPP, "utf-8");
  const byName = new Map();

  // Spec talents: talent.{spec}.{var} = find_talent_spell(..., "Name")
  const specRe =
    /talent\.(havoc|vengeance|devourer)\.(\w+)\s*=\s*find_talent_spell\([^"]*"([^"]+)"/g;
  let match;
  while ((match = specRe.exec(src)) !== null) {
    const [, category, , name] = match;
    if (!byName.has(name)) byName.set(name, category);
  }

  // Hero talents: talent.{hero}.{var} = find_talent_spell(..., "Name")
  const heroRe =
    /talent\.(aldrachi_reaver|annihilator|scarred)\.(\w+)\s*=\s*find_talent_spell\([^"]*"([^"]+)"/g;
  while ((match = heroRe.exec(src)) !== null) {
    const [, category, , name] = match;
    if (!byName.has(name)) byName.set(name, category);
  }

  return byName;
}

const HERO_TREE_DISPLAY_NAMES = {
  aldrachi_reaver: "Aldrachi Reaver",
  annihilator: "Annihilator",
  scarred: "Scarred",
};

// Hero trees available to Vengeance
const VENGEANCE_HERO_TREES = new Set(["aldrachi_reaver", "annihilator"]);

function buildTalentTrees() {
  const rawTalents = JSON.parse(
    readFileSync(join(DATA_DIR, "talents-raw.json"), "utf-8"),
  );
  const spells = JSON.parse(
    readFileSync(join(DATA_DIR, "spells.json"), "utf-8"),
  );
  const spellMap = new Map(spells.map((s) => [s.id, s]));
  const assignments = parseTalentAssignments();

  const specCounts = {};
  for (const cat of assignments.values()) {
    specCounts[cat] = (specCounts[cat] || 0) + 1;
  }
  console.log(
    `Parsed ${assignments.size} talent assignments from simc C++:`,
    Object.entries(specCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", "),
  );

  const trees = {
    class: { name: "Demon Hunter", talents: [] },
    spec: { name: "Vengeance", talents: [] },
    hero: {
      "Aldrachi Reaver": { talents: [] },
      Annihilator: { talents: [] },
    },
  };

  let skipped = 0;

  for (const raw of rawTalents) {
    if (raw.tree === "selection") continue;

    const spell = spellMap.get(raw.spellId);
    const category = assignments.get(raw.name);
    const spellSpec = spell?.talentEntry?.spec?.toLowerCase();

    // Skip non-Vengeance spec talents
    if (
      category === "havoc" ||
      category === "devourer" ||
      (!category && (spellSpec === "havoc" || spellSpec === "devourer"))
    ) {
      skipped++;
      continue;
    }

    // Skip Scarred hero tree (Havoc/Devourer only in Midnight)
    if (category === "scarred") {
      skipped++;
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
      // Use C++ assignment to determine hero tree, not subtree ID
      const heroKey = HERO_TREE_DISPLAY_NAMES[category];
      if (heroKey && trees.hero[heroKey]) {
        trees.hero[heroKey].talents.push(talent);
      } else if (category === "aldrachi_reaver" || category === "annihilator") {
        trees.hero[HERO_TREE_DISPLAY_NAMES[category]].talents.push(talent);
      }
      // Hero talents without C++ assignment are unclassified — skip silently
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

  console.log(`Skipped ${skipped} non-Vengeance talents`);
  console.log("Wrote data/talents.json");
  console.log(`  Class tree: ${trees.class.talents.length} talents`);
  console.log(`  Spec tree: ${trees.spec.talents.length} talents`);
  for (const [name, hero] of Object.entries(trees.hero)) {
    console.log(`  Hero (${name}): ${hero.talents.length} talents`);
  }

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
