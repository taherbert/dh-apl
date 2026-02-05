// Extracts spec spell data from simc's spell_query into structured JSON.
// Gets spell IDs from Raidbots talent data instead of simc talent dump.

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpellQueryOutput, cleanSpell } from "./parser.js";
import { resolveAllDescriptions } from "./template-resolver.js";
import {
  SIMC_BIN,
  config,
  loadSpecAdapter,
  getSpecAdapter,
  getDisplayNames,
} from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const RAW_DIR = join(DATA_DIR, "raw");

function runSpellQuery(query) {
  try {
    return execSync(`${SIMC_BIN} spell_query="${query}"`, {
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

// Batch spell queries: union IDs with | operator to avoid N+1 subprocess spawns.
// Chunks to avoid command line length limits.
const BATCH_SIZE = 50;

function runBatchSpellQuery(ids) {
  const idArray = [...ids].filter((id) => Number.isInteger(id) && id > 0);
  if (idArray.length === 0) return "";

  const chunks = [];
  for (let i = 0; i < idArray.length; i += BATCH_SIZE) {
    chunks.push(idArray.slice(i, i + BATCH_SIZE));
  }

  const results = [];
  for (const chunk of chunks) {
    const query = chunk.map((id) => `spell.id=${id}`).join("|");
    const raw = runSpellQuery(query);
    if (raw) results.push(raw);
  }
  return results.join("\n");
}

async function extractSpells() {
  await loadSpecAdapter();
  const adapter = getSpecAdapter();
  const { BASE_SPELL_IDS, SET_BONUS_SPELL_IDS } = adapter;
  const classSpellQuery = adapter.getClassSpellQuery();
  const specSpellFilter = adapter.getSpecSpellFilter();

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
  for (const id of SET_BONUS_SPELL_IDS) talentSpellIds.add(id);

  console.log(
    `Found ${talentSpellIds.size} spell IDs from Raidbots + base abilities`,
  );

  // Step 2: Get class spells
  console.log("Querying class spells...");
  const classRaw = runSpellQuery(classSpellQuery);
  writeFileSync(join(RAW_DIR, "class_spells.txt"), classRaw);

  const classSpells = parseSpellQueryOutput(classRaw);
  console.log(`Parsed ${classSpells.length} class spells`);

  // Step 3: Query all talent spell IDs (batched to avoid N+1 subprocess spawns)
  console.log(
    `Querying ${talentSpellIds.size} talent spell IDs in batches of ${BATCH_SIZE}...`,
  );
  const talentSpellRaw = runBatchSpellQuery(talentSpellIds);
  writeFileSync(join(RAW_DIR, "talent_spells.txt"), talentSpellRaw);

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

  // Step 5: Fetch modifier spells referenced in affectingSpells but not yet extracted.
  // Only scan primary spells (Raidbots talents + base abilities) to avoid pulling in
  // legacy modifiers from old class spells still in simc's data.
  const missingModifierIds = new Set();
  for (const spell of spellMap.values()) {
    if (!talentSpellIds.has(spell.id)) continue;
    for (const ref of spell.affectingSpells || []) {
      if (ref.id && !spellMap.has(ref.id)) missingModifierIds.add(ref.id);
    }
  }

  // Build talent name set for filtering modifiers to current VDH
  const raidbotTalentNames = new Set();
  for (const node of allNodes) {
    raidbotTalentNames.add(node.name);
    for (const entry of node.entries) {
      if (entry.name) raidbotTalentNames.add(entry.name);
    }
  }
  const baseSpellNames = new Set(
    [...spellMap.values()]
      .filter((s) => BASE_SPELL_IDS.has(s.id) || SET_BONUS_SPELL_IDS.has(s.id))
      .map((s) => s.name),
  );

  if (missingModifierIds.size > 0) {
    console.log(
      `Fetching ${missingModifierIds.size} modifier spells (batched)...`,
    );
    const modRaw = runBatchSpellQuery(missingModifierIds);
    const modSpells = parseSpellQueryOutput(modRaw);
    let kept = 0;
    let skipped = 0;
    for (const spell of modSpells) {
      if (!spell.id) continue;
      const name = spell.name || "";
      const isCurrent =
        raidbotTalentNames.has(name) ||
        baseSpellNames.has(name) ||
        spell.talentEntry ||
        name.startsWith("Mastery:") ||
        specSpellFilter(spell);
      if (isCurrent) {
        spellMap.set(spell.id, spell);
        kept++;
      } else {
        skipped++;
      }
    }
    console.log(
      `Modifier spells: ${kept} kept, ${skipped} skipped (legacy/irrelevant)`,
    );
  }

  // Filter to class-relevant spells
  const className = getDisplayNames().class;
  const relevantSpells = [...spellMap.values()].filter((spell) => {
    if (talentSpellIds.has(spell.id)) return true;
    if (spell.class?.includes(className)) return true;
    if (spell.talentEntry) return true;
    if (spell.labels?.some((l) => l.includes(className))) return true;
    return false;
  });

  const output = relevantSpells.map(cleanSpell).sort((a, b) => a.id - b.id);

  // Fetch sub-spells referenced in descriptions (e.g., $204598s1 → spell 204598)
  const descReferencedIds = new Set();
  for (const spell of output) {
    if (!spell.description) continue;
    const refs = spell.description.matchAll(/\$(\d{4,})(?:[sdatxmo]\d*|d)/g);
    for (const m of refs) descReferencedIds.add(parseInt(m[1]));
    // Also $@spelldesc references
    const descRefs = spell.description.matchAll(/\$@spelldesc(\d+)/g);
    for (const m of descRefs) descReferencedIds.add(parseInt(m[1]));
  }
  const missingDescRefs = [...descReferencedIds].filter(
    (id) => !spellMap.has(id) && !output.find((s) => s.id === id),
  );
  if (missingDescRefs.length > 0) {
    console.log(
      `\nFetching ${missingDescRefs.length} sub-spells referenced in descriptions (batched)...`,
    );
    const descRaw = runBatchSpellQuery(new Set(missingDescRefs));
    const descSpells = parseSpellQueryOutput(descRaw);
    let fetched = 0;
    for (const spell of descSpells) {
      if (spell.id) {
        output.push(cleanSpell(spell));
        fetched++;
      }
    }
    output.sort((a, b) => a.id - b.id);
    console.log(`Fetched ${fetched} sub-spells for template resolution`);
  }

  // Resolve template variables in descriptions
  const stats = resolveAllDescriptions(output);
  console.log(
    `\nTemplate resolution: ${stats.resolved} fully resolved, ${stats.partial} partial, ${stats.unresolved} unresolved out of ${stats.total}`,
  );

  writeFileSync(join(DATA_DIR, "spells.json"), JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.length} spells to data/spells.json`);

  const specName = getDisplayNames().spec;
  const withTalent = output.filter((s) => s.talentEntry);
  const specSpecific = output.filter(
    (s) => s.class?.includes(specName) || s.talentEntry?.spec === specName,
  );
  console.log(`  ${withTalent.length} with talent entries`);
  console.log(`  ${specSpecific.length} ${specName}-specific`);

  const keySpells = adapter.getKeySpellIds?.() || [];
  for (const [id, name] of keySpells) {
    const found = output.find((s) => s.id === id);
    console.log(`  ${found ? "\u2713" : "\u2717"} ${name} (${id})`);
  }
}

extractSpells().catch((e) => {
  console.error(e);
  process.exit(1);
});
