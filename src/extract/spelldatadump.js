// Generates comprehensive SpellDataDump from simc spell_query.
// Queries all spells referenced by talents, base abilities, and class spells.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIMC_BIN,
  config,
  loadSpecAdapter,
  getSpecAdapter,
  getDisplayNames,
} from "../engine/startup.js";
import { dataDir, dataFile, REFERENCE_DIR } from "../engine/paths.js";

const OUTPUT = join(REFERENCE_DIR, `spelldatadump-${config.spec.specName}.txt`);

function runSpellQuery(query) {
  try {
    return execSync(`${SIMC_BIN} spell_query="${query}"`, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60000,
    });
  } catch (e) {
    if (e.stdout) return e.stdout;
    console.error(`spell_query failed for "${query}":`, e.message);
    return "";
  }
}

function collectSpellIds() {
  const adapter = getSpecAdapter();
  const ids = new Set();

  // Add base abilities
  for (const id of adapter.BASE_SPELL_IDS) ids.add(id);
  for (const id of adapter.SET_BONUS_SPELL_IDS) ids.add(id);

  // Add talent spell IDs from raidbots data
  const raidbots = JSON.parse(
    readFileSync(dataFile("raidbots-talents.json"), "utf-8"),
  );
  const allNodes = [
    ...raidbots.classNodes,
    ...raidbots.specNodes,
    ...raidbots.heroNodes,
  ];
  for (const { spellId } of allNodes.flatMap((n) => n.entries)) {
    if (spellId > 0) ids.add(spellId);
  }

  // Add spell IDs from existing spells.json (includes sub-spells and modifiers)
  try {
    const spells = JSON.parse(readFileSync(dataFile("spells.json"), "utf-8"));
    for (const spell of spells) {
      ids.add(spell.id);
      for (const { id } of spell.affectingSpells ?? []) {
        if (id > 0) ids.add(id);
      }
    }
  } catch {
    console.log("spells.json not found, using talent IDs only");
  }

  return [...ids]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
}

async function main() {
  await loadSpecAdapter();
  console.log("Collecting spell IDs...");
  const spellIds = collectSpellIds();
  console.log(`Found ${spellIds.length} unique spell IDs`);

  // Get simc version header
  const versionOutput = runSpellQuery("spell.id=1");
  const versionLine = versionOutput.split("\n")[0];
  console.log(`SimC version: ${versionLine}`);

  console.log("Querying spell data (this may take a moment)...");
  const outputs = [versionLine];
  let found = 0;

  for (const id of spellIds) {
    const output = runSpellQuery(`spell.id=${id}`);
    // Check if spell was found (output contains the spell name)
    if (output.includes(`(id=${id})`)) {
      // Extract just the spell entry, not the version header
      const lines = output.split("\n");
      const spellStart = lines.findIndex((l) => l.startsWith("Name"));
      if (spellStart >= 0) {
        outputs.push(lines.slice(spellStart).join("\n"));
        found++;
      }
    }
  }

  console.log(`Found ${found}/${spellIds.length} spells in simc data`);

  const content = outputs.join("\n");
  writeFileSync(OUTPUT, content);
  console.log(`Written to: ${OUTPUT}`);

  // Count spec-specific spells
  const { spec: specName, class: className } = getDisplayNames();
  const specLabel = `${specName} ${className}`;
  const specCount = (content.match(new RegExp(specLabel, "g")) || []).length;
  console.log(`${specLabel}-specific spells: ${specCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
