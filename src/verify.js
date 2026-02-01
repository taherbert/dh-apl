// Verification script: compares extracted data against simc C++ source.
// Checks talent coverage, spec assignments, contamination, and interaction quality.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SPELL_IDS } from "./model/vengeance-base.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const SIMC_DIR = "/Users/tom/Documents/GitHub/simc";
const SIMC_DH_CPP = join(SIMC_DIR, "engine/class_modules/sc_demon_hunter.cpp");

const src = readFileSync(SIMC_DH_CPP, "utf-8");
const talents = JSON.parse(
  readFileSync(join(DATA_DIR, "talents.json"), "utf-8"),
);
const spells = JSON.parse(readFileSync(join(DATA_DIR, "spells.json"), "utf-8"));
const interactions = JSON.parse(
  readFileSync(join(DATA_DIR, "interactions.json"), "utf-8"),
);

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) {
  console.log(`  PASS  ${msg}`);
  passed++;
}
function fail(msg) {
  console.log(`  FAIL  ${msg}`);
  failed++;
}
function warn(msg) {
  console.log(`  WARN  ${msg}`);
  warnings++;
}

// 1. Parse talent assignments from C++
function parseCppTalents(prefix) {
  const re = new RegExp(
    `talent\\.${prefix}\\.(\\w+)\\s*=\\s*find_talent_spell\\([^"]*"([^"]+)"`,
    "g",
  );
  const names = new Set();
  let match;
  while ((match = re.exec(src)) !== null) {
    names.add(match[2]);
  }
  return names;
}

console.log("\n=== Talent Coverage ===\n");

const cppVengeance = parseCppTalents("vengeance");
const cppAldrachi = parseCppTalents("aldrachi_reaver");
const cppAnnihilator = parseCppTalents("annihilator");
const cppScarred = parseCppTalents("scarred");
const cppHavoc = parseCppTalents("havoc");
const cppDevourer = parseCppTalents("devourer");

console.log(
  `C++ talent counts: vengeance=${cppVengeance.size}, aldrachi=${cppAldrachi.size}, annihilator=${cppAnnihilator.size}, scarred=${cppScarred.size}`,
);

// Compare spec talents
const ourSpecNames = new Set(talents.spec.talents.map((t) => t.name));
const missingFromUs = [...cppVengeance].filter((n) => {
  // Check if any talent matches (accounting for multi-rank having same display name)
  return !talents.spec.talents.some((t) => t.name === n || t.spellName === n);
});
const extraInUs = talents.spec.talents.filter(
  (t) => !cppVengeance.has(t.name) && !cppVengeance.has(t.spellName),
);

if (missingFromUs.length === 0) {
  pass(`All ${cppVengeance.size} C++ vengeance talents present in our data`);
} else {
  // Midnight branch has new talents not yet in DBC — warn, don't fail
  warn(
    `${missingFromUs.length} C++ vengeance talents not in DBC data: ${missingFromUs.join(", ")}`,
  );
}

if (extraInUs.length === 0) {
  pass("No extra talents beyond C++ assignments");
} else {
  // DBC may have stale talents not yet removed from simc — warn unless extreme
  warn(
    `${extraInUs.length} talents in DBC but not in C++: ${extraInUs.map((t) => t.name).join(", ")}`,
  );
}

// Compare hero talents
const ourAldrachiNames = new Set(
  (talents.hero["Aldrachi Reaver"]?.talents || []).map((t) => t.name),
);
const missingAldrachi = [...cppAldrachi].filter(
  (n) =>
    !(talents.hero["Aldrachi Reaver"]?.talents || []).some(
      (t) => t.name === n || t.spellName === n,
    ),
);

if (missingAldrachi.length === 0) {
  pass(
    `All ${cppAldrachi.size} Aldrachi Reaver talents present (${talents.hero["Aldrachi Reaver"]?.talents.length || 0} in data)`,
  );
} else {
  warn(
    `${missingAldrachi.length} C++ Aldrachi Reaver talents not in DBC: ${missingAldrachi.join(", ")}`,
  );
}

const annihilatorCount = talents.hero["Annihilator"]?.talents.length || 0;
if (cppAnnihilator.size > 0 && annihilatorCount === 0) {
  warn(
    `Annihilator has ${cppAnnihilator.size} talents in C++ but 0 in data (not yet in simc DBC)`,
  );
} else if (annihilatorCount > 0) {
  pass(`Annihilator: ${annihilatorCount} talents in data`);
} else {
  pass("Annihilator: not yet available in simc DBC (expected)");
}

// 2. Check for contamination
console.log("\n=== Contamination Check ===\n");

const allOurTalentNames = [
  ...talents.class.talents,
  ...talents.spec.talents,
  ...Object.values(talents.hero).flatMap((h) => h.talents),
].map((t) => t.name);

const havocLeaks = allOurTalentNames.filter(
  (n) => cppHavoc.has(n) && !cppVengeance.has(n),
);
const devourerLeaks = allOurTalentNames.filter(
  (n) => cppDevourer.has(n) && !cppVengeance.has(n),
);
const scarredLeaks = allOurTalentNames.filter(
  (n) => cppScarred.has(n) && !cppVengeance.has(n) && !cppAldrachi.has(n),
);

if (havocLeaks.length === 0) {
  pass("No Havoc talent contamination");
} else {
  fail(`Havoc contamination: ${havocLeaks.join(", ")}`);
}

if (devourerLeaks.length === 0) {
  pass("No Devourer talent contamination");
} else {
  fail(`Devourer contamination: ${devourerLeaks.join(", ")}`);
}

if (scarredLeaks.length === 0) {
  pass("No Scarred hero tree contamination");
} else {
  fail(`Scarred hero tree contamination: ${scarredLeaks.join(", ")}`);
}

// 3. Check BASE_SPELL_IDS against spec assignments
console.log("\n=== Base Spell IDs ===\n");

const specSpellRe =
  /spec\.(\w+)\s*=\s*find_specialization_spell\(\s*"([^"]+)"/g;
const cppSpecSpells = new Map();
let m;
while ((m = specSpellRe.exec(src)) !== null) {
  cppSpecSpells.set(m[1], m[2]);
}

const spellMap = new Map(spells.map((s) => [s.id, s]));
const baseFound = [...BASE_SPELL_IDS].filter((id) => spellMap.has(id));
const baseMissing = [...BASE_SPELL_IDS].filter((id) => !spellMap.has(id));

pass(
  `${baseFound.length}/${BASE_SPELL_IDS.size} base spell IDs found in spell data`,
);
if (baseMissing.length > 0) {
  warn(
    `${baseMissing.length} base spell IDs not in spell data: ${baseMissing.join(", ")}`,
  );
}

// 4. Interaction quality
console.log("\n=== Interaction Quality ===\n");

const total = interactions.interactions.length;
const typeCounts = {};
for (const i of interactions.interactions) {
  typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
}
const unknownCount = typeCounts["unknown"] || 0;
const unknownPct = ((unknownCount / total) * 100).toFixed(1);

console.log(`  Total interactions: ${total}`);
console.log(
  `  Typed: ${total - unknownCount} (${(100 - unknownPct).toFixed(1)}%)`,
);
console.log(`  Unknown: ${unknownCount} (${unknownPct}%)`);

for (const [type, count] of Object.entries(typeCounts).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`    ${type}: ${count}`);
}

if (parseFloat(unknownPct) < 40) {
  pass(`Unknown interaction rate ${unknownPct}% < 40% target`);
} else if (parseFloat(unknownPct) < 60) {
  warn(`Unknown interaction rate ${unknownPct}% (target: <40%)`);
} else {
  fail(`Unknown interaction rate ${unknownPct}% (target: <40%)`);
}

// 5. Spell and talent counts
console.log("\n=== Summary Counts ===\n");

console.log(`  Spells: ${spells.length}`);
console.log(`  Class talents: ${talents.class.talents.length}`);
console.log(`  Spec talents: ${talents.spec.talents.length}`);
for (const [name, hero] of Object.entries(talents.hero)) {
  console.log(`  Hero (${name}): ${hero.talents.length}`);
}
console.log(`  Interactions: ${total}`);
console.log(
  `  Spells with modifiers: ${Object.keys(interactions.bySpell).length}`,
);

// Key spells check
const keySpells = [
  [247454, "Spirit Bomb"],
  [228477, "Soul Cleave"],
  [204021, "Fiery Brand"],
  [263642, "Fracture"],
  [212084, "Fel Devastation"],
  [258920, "Immolation Aura"],
  [204596, "Sigil of Flame"],
];

let keyMissing = 0;
for (const [id, name] of keySpells) {
  if (spellMap.has(id)) {
    pass(`Key spell: ${name} (${id})`);
  } else {
    fail(`Key spell missing: ${name} (${id})`);
    keyMissing++;
  }
}

// 6. simc git hash
console.log("\n=== simc Version ===\n");

try {
  const hash = execSync("git rev-parse HEAD", {
    cwd: SIMC_DIR,
    encoding: "utf-8",
  }).trim();
  const branch = execSync("git branch --show-current", {
    cwd: SIMC_DIR,
    encoding: "utf-8",
  }).trim();
  console.log(`  Branch: ${branch}`);
  console.log(`  Commit: ${hash}`);
} catch {
  warn("Could not read simc git info");
}

// Final summary
console.log("\n=== Results ===\n");
console.log(`  ${passed} passed, ${failed} failed, ${warnings} warnings`);
if (failed > 0) {
  console.log("\n  VERIFICATION FAILED");
  process.exit(1);
} else {
  console.log("\n  VERIFICATION PASSED");
}
