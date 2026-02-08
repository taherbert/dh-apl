import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIMC_CPP, initSpec } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { REFERENCE_DIR } from "../engine/paths.js";

function extractSimcTalents() {
  const OUTPUT = join(REFERENCE_DIR, "simc-talent-variables.json");

  const src = readFileSync(SIMC_CPP, "utf-8");

  // Match find_talent_spell patterns:
  //   talent.vengeance.spirit_bomb = find_talent_spell( talent_tree::SPECIALIZATION, "Spirit Bomb" );
  //   talent.aldrachi_reaver.art_of_the_glaive = find_talent_spell( talent_tree::HERO, "Art of the Glaive", ... );
  const pattern =
    /talent\.(\w+)\.(\w+)\s*=\s*find_talent_spell\(\s*talent_tree::(\w+),\s*"([^"]+)"/g;

  const results = {};
  let match;
  while ((match = pattern.exec(src)) !== null) {
    const [, tree, variable, treeType, spellName] = match;
    if (!results[tree]) results[tree] = [];
    results[tree].push({ variable, treeType, spellName });
  }

  // Sort each tree's entries
  for (const tree of Object.keys(results)) {
    results[tree].sort((a, b) => a.variable.localeCompare(b.variable));
  }

  const totalCount = Object.values(results).reduce((s, a) => s + a.length, 0);
  writeFileSync(OUTPUT, JSON.stringify(results, null, 2) + "\n");

  console.log(`Wrote ${OUTPUT}`);
  for (const [tree, entries] of Object.entries(results)) {
    console.log(`  ${tree}: ${entries.length} variables`);
  }
  console.log(`  Total: ${totalCount}`);
}

(async () => {
  await initSpec(parseSpecArg());
  extractSimcTalents();
})();
