import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SIMC_DH_CPP } from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const OUTPUT = join(ROOT, "reference", "simc-talent-variables.json");

const src = readFileSync(SIMC_DH_CPP, "utf-8");

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
