// Extracts Vengeance DH spell data from simc's spell_query into structured JSON.
// Also parses the talent query to get all spell IDs referenced by DH talents.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpellQueryOutput, cleanSpell } from "./parser.js";
import { BASE_SPELL_IDS } from "../model/vengeance-base.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SIMC = "/Users/tom/Documents/GitHub/simc/engine/simc";
const DATA_DIR = join(ROOT, "data");
const RAW_DIR = join(DATA_DIR, "raw");

const SUBTREE_NAMES = {
  34: "Fel-Scarred",
  35: "Aldrachi Reaver",
};

function runSpellQuery(query) {
  try {
    return execSync(`${SIMC} spell_query="${query}"`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
    });
  } catch (e) {
    if (e.stdout) return e.stdout;
    console.error(`spell_query failed for "${query}":`, e.message);
    return "";
  }
}

function parseTalentDump(text) {
  const talents = [];
  let current = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("SimulationCraft")) continue;
    if (line.trim() === "") {
      if (current) {
        talents.push(current);
        current = null;
      }
      continue;
    }
    const match = line.match(/^(\w[\w\s]*?)\s{2,}: (.+)$/);
    if (!match) continue;
    if (!current) current = {};
    const [, key, val] = match;
    switch (key.trim()) {
      case "Name":
        current.name = val.trim();
        break;
      case "Entry":
        current.entry = parseInt(val);
        break;
      case "Node":
        current.node = parseInt(val);
        break;
      case "Definition":
        current.definition = parseInt(val);
        break;
      case "Tree":
        current.tree = val.trim();
        break;
      case "Class":
        current.class = val.trim();
        break;
      case "Column":
        current.col = parseInt(val);
        break;
      case "Row":
        current.row = parseInt(val);
        break;
      case "Max Rank":
        current.maxRank = parseInt(val);
        break;
      case "Spell":
        current.spellId = parseInt(val);
        break;
      case "Subtree":
        current.subtree = parseInt(val);
        break;
    }
  }
  if (current) talents.push(current);
  return talents;
}

function extractSpells() {
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });

  // Step 1: Get all talent data to find DH talent spell IDs
  console.log("Querying all talents...");
  const talentRaw = runSpellQuery("talent");
  writeFileSync(join(RAW_DIR, "all_talents.txt"), talentRaw);

  const allTalents = parseTalentDump(talentRaw);
  const dhTalents = allTalents.filter(
    (t) => t.class === "demonhunter" && t.spellId > 0,
  );

  // Annotate hero tree subtree names
  for (const t of dhTalents) {
    if (t.tree === "hero" && SUBTREE_NAMES[t.subtree]) {
      t.heroSpec = SUBTREE_NAMES[t.subtree];
    }
  }

  console.log(`Found ${dhTalents.length} DH talents with spell IDs`);
  writeFileSync(
    join(DATA_DIR, "talents-raw.json"),
    JSON.stringify(dhTalents, null, 2),
  );

  // Collect all unique talent spell IDs plus base abilities not in talent tree
  const talentSpellIds = new Set(dhTalents.map((t) => t.spellId));

  for (const id of BASE_SPELL_IDS) talentSpellIds.add(id);

  // Step 2: Get DH class spells
  console.log("Querying DH class spells...");
  const classRaw = runSpellQuery("spell.class=demon_hunter");
  writeFileSync(join(RAW_DIR, "dh_class_spells.txt"), classRaw);

  const classSpells = parseSpellQueryOutput(classRaw);
  console.log(`Parsed ${classSpells.length} class spells`);

  // Step 3: Query all talent spell IDs for full spell data
  console.log(`Querying ${talentSpellIds.size} talent spell IDs...`);
  const talentSpellRaws = [];
  for (const id of talentSpellIds) {
    const raw = runSpellQuery(`spell.id=${id}`);
    if (raw.includes(`id=${id}`)) talentSpellRaws.push(raw);
  }
  const talentSpellRaw = talentSpellRaws.join("\n");
  writeFileSync(join(RAW_DIR, "dh_talent_spells.txt"), talentSpellRaw);

  const talentSpells = parseSpellQueryOutput(talentSpellRaw);
  console.log(`Parsed ${talentSpells.length} talent spells`);

  // Step 4: Merge everything, deduplicating by ID (talent spells take priority)
  const spellMap = new Map();
  for (const spell of classSpells) {
    if (spell.id) spellMap.set(spell.id, spell);
  }
  for (const spell of talentSpells) {
    if (spell.id) spellMap.set(spell.id, spell);
  }

  // Filter to DH-relevant: has DH class, has talent entry, is a talent spell, or has DH labels
  const dhSpells = [...spellMap.values()].filter((spell) => {
    if (talentSpellIds.has(spell.id)) return true;
    if (spell.class?.includes("Demon Hunter")) return true;
    if (spell.talentEntry) return true;
    if (spell.labels?.some((l) => l.includes("Demon Hunter"))) return true;
    return false;
  });

  const output = dhSpells.map(cleanSpell).sort((a, b) => a.id - b.id);

  writeFileSync(join(DATA_DIR, "spells.json"), JSON.stringify(output, null, 2));
  console.log(`\nWrote ${output.length} spells to data/spells.json`);

  const withTalent = output.filter((s) => s.talentEntry);
  const vengeance = output.filter(
    (s) =>
      s.class?.includes("Vengeance") || s.talentEntry?.spec === "Vengeance",
  );
  console.log(`  ${withTalent.length} with talent entries`);
  console.log(`  ${vengeance.length} Vengeance-specific`);

  // Verify key spells
  const checks = [
    [247454, "Spirit Bomb"],
    [228477, "Soul Cleave"],
    [204021, "Fiery Brand"],
    [263642, "Fracture"],
    [212084, "Fel Devastation"],
    [258920, "Immolation Aura"],
    [204596, "Sigil of Flame"],
    [390163, "Sigil of Spite"],
    [452435, "Demonsurge"],
  ];
  for (const [id, name] of checks) {
    const found = output.find((s) => s.id === id);
    console.log(`  ${found ? "✓" : "✗"} ${name} (${id})`);
  }
}

extractSpells();
