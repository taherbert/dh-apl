// Extracts Vengeance DH spell data from simc's spell_query into structured JSON.
// Gets spell IDs from Raidbots talent data instead of simc talent dump.

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpellQueryOutput, cleanSpell } from "./parser.js";
import { BASE_SPELL_IDS } from "../model/vengeance-base.js";
import {
  SIMC_BIN,
  SIMC_MAX_BUFFER,
  SPELL_QUERY_TIMEOUT_MS,
  SIMC_CLASS_SLUG,
  CLASS_NAME,
  SPEC_NAME,
} from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const RAW_DIR = join(DATA_DIR, "raw");

function runSpellQuery(query) {
  try {
    return execSync(`${SIMC_BIN} spell_query="${query}"`, {
      encoding: "utf-8",
      maxBuffer: SIMC_MAX_BUFFER,
      timeout: SPELL_QUERY_TIMEOUT_MS,
    });
  } catch (e) {
    if (e.stdout) return e.stdout;
    console.error(`spell_query failed for "${query}":`, e.message);
    return "";
  }
}

function extractSpells() {
  mkdirSync(RAW_DIR, { recursive: true });

  // Step 1: Get spell IDs from Raidbots talent data
  const raidbots = JSON.parse(
    readFileSync(join(DATA_DIR, "raidbots-talents.json"), "utf-8"),
  );
  const allNodes = [
    ...raidbots.classNodes,
    ...raidbots.specNodes,
    ...raidbots.heroNodes,
  ];
  const talentSpellIds = new Set();
  for (const node of allNodes) {
    for (const entry of node.entries) {
      if (entry.spellId > 0) talentSpellIds.add(entry.spellId);
    }
  }
  for (const id of BASE_SPELL_IDS) talentSpellIds.add(id);

  console.log(
    `Found ${talentSpellIds.size} spell IDs from Raidbots + base abilities`,
  );

  // Step 2: Get DH class spells
  console.log("Querying DH class spells...");
  const classRaw = runSpellQuery(`spell.class=${SIMC_CLASS_SLUG}`);
  writeFileSync(join(RAW_DIR, "dh_class_spells.txt"), classRaw);

  const classSpells = parseSpellQueryOutput(classRaw);
  console.log(`Parsed ${classSpells.length} class spells`);

  // Step 3: Query all talent spell IDs for full spell data
  console.log(`Querying ${talentSpellIds.size} talent spell IDs...`);
  const talentSpellRaws = [];
  for (const id of talentSpellIds) {
    if (!Number.isInteger(id) || id <= 0) {
      console.warn(`Skipping invalid spell ID: ${id}`);
      continue;
    }
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

  // Filter to DH-relevant
  const dhSpells = [...spellMap.values()].filter((spell) => {
    if (talentSpellIds.has(spell.id)) return true;
    if (spell.class?.includes(CLASS_NAME)) return true;
    if (spell.talentEntry) return true;
    if (spell.labels?.some((l) => l.includes(CLASS_NAME))) return true;
    return false;
  });

  const output = dhSpells.map(cleanSpell).sort((a, b) => a.id - b.id);

  writeFileSync(join(DATA_DIR, "spells.json"), JSON.stringify(output, null, 2));
  console.log(`\nWrote ${output.length} spells to data/spells.json`);

  const withTalent = output.filter((s) => s.talentEntry);
  const vengeance = output.filter(
    (s) => s.class?.includes(SPEC_NAME) || s.talentEntry?.spec === SPEC_NAME,
  );
  console.log(`  ${withTalent.length} with talent entries`);
  console.log(`  ${vengeance.length} ${SPEC_NAME}-specific`);
}

extractSpells();
