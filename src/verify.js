// Verification script: compares extracted data against Raidbots (ground truth)
// and simc C++ source. Checks talent coverage, counts, choice nodes, hero trees,
// contamination, and interaction quality.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SPELL_IDS } from "./model/vengeance-base.js";
import { SIMC_DIR, SIMC_DH_CPP, HERO_SUBTREES } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

const src = readFileSync(SIMC_DH_CPP, "utf-8");
const talents = JSON.parse(
  readFileSync(join(DATA_DIR, "talents.json"), "utf-8"),
);
const spells = JSON.parse(readFileSync(join(DATA_DIR, "spells.json"), "utf-8"));
const interactions = JSON.parse(
  readFileSync(join(DATA_DIR, "interactions.json"), "utf-8"),
);

const hasRaidbots = existsSync(join(DATA_DIR, "raidbots-talents.json"));
const raidbots = hasRaidbots
  ? JSON.parse(readFileSync(join(DATA_DIR, "raidbots-talents.json"), "utf-8"))
  : null;

const allOurTalents = [
  ...talents.class.talents,
  ...talents.spec.talents,
  ...Object.values(talents.hero).flatMap((h) => h.talents),
];

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

// === Raidbots Verification ===

if (raidbots) {
  console.log("\n=== Raidbots Verification ===\n");

  const rbHeroCounts = {};
  for (const node of raidbots.heroNodes) {
    const name = HERO_SUBTREES[node.subTreeId] || `subtree-${node.subTreeId}`;
    rbHeroCounts[name] = (rbHeroCounts[name] || 0) + 1;
  }

  // Count our talent entries (not nodes — choice nodes produce multiple entries)
  const ourClassCount = talents.class.talents.length;
  const ourSpecCount = talents.spec.talents.length;

  // Raidbots counts are nodes, our counts include choice node entries
  // Compare entry counts: total entries across all Raidbots nodes
  const rbClassEntries = raidbots.classNodes.reduce(
    (s, n) => s + n.entries.length,
    0,
  );
  const rbSpecEntries = raidbots.specNodes.reduce(
    (s, n) => s + n.entries.length,
    0,
  );

  if (ourClassCount === rbClassEntries) {
    pass(`Class talent entries match Raidbots: ${ourClassCount}`);
  } else {
    fail(
      `Class talent entries: ours=${ourClassCount}, Raidbots=${rbClassEntries}`,
    );
  }

  if (ourSpecCount === rbSpecEntries) {
    pass(`Spec talent entries match Raidbots: ${ourSpecCount}`);
  } else {
    fail(
      `Spec talent entries: ours=${ourSpecCount}, Raidbots=${rbSpecEntries}`,
    );
  }

  for (const [name] of Object.entries(rbHeroCounts)) {
    const heroTalents = talents.hero[name]?.talents || [];
    const rbEntries = raidbots.heroNodes
      .filter((n) => HERO_SUBTREES[n.subTreeId] === name)
      .reduce((s, n) => s + n.entries.length, 0);
    if (heroTalents.length === rbEntries) {
      pass(`Hero (${name}) entries match Raidbots: ${heroTalents.length}`);
    } else {
      fail(
        `Hero (${name}) entries: ours=${heroTalents.length}, Raidbots=${rbEntries}`,
      );
    }
  }

  // Every Raidbots talent name+spellId exists in our data
  const ourSpellIds = new Set(allOurTalents.map((t) => t.spellId));

  const allRbNodes = [
    ...raidbots.classNodes,
    ...raidbots.specNodes,
    ...raidbots.heroNodes,
  ];
  const missingFromUs = [];
  for (const node of allRbNodes) {
    for (const entry of node.entries) {
      if (!ourSpellIds.has(entry.spellId)) {
        missingFromUs.push(`${entry.name} (${entry.spellId})`);
      }
    }
  }

  if (missingFromUs.length === 0) {
    pass("All Raidbots talent spellIds present in our data");
  } else {
    fail(`Missing from our data: ${missingFromUs.join(", ")}`);
  }

  // No stale talents (in our data but not Raidbots)
  const rbSpellIds = new Set();
  for (const node of allRbNodes) {
    for (const entry of node.entries) rbSpellIds.add(entry.spellId);
  }

  const staleTalents = [];
  for (const t of allOurTalents) {
    if (!rbSpellIds.has(t.spellId))
      staleTalents.push(`${t.name} (${t.spellId})`);
  }

  if (staleTalents.length === 0) {
    pass("No stale talents (all match Raidbots)");
  } else {
    fail(`Stale talents not in Raidbots: ${staleTalents.join(", ")}`);
  }

  // Choice node completeness
  const choiceNodes = allRbNodes.filter((n) => n.type === "choice");
  let choiceMissing = 0;
  for (const node of choiceNodes) {
    for (const entry of node.entries) {
      if (!ourSpellIds.has(entry.spellId)) {
        console.log(
          `    Missing choice option: ${entry.name} (${entry.spellId}) from node "${node.name}"`,
        );
        choiceMissing++;
      }
    }
  }
  if (choiceMissing === 0) {
    pass(`All ${choiceNodes.length} choice nodes complete`);
  } else {
    fail(`${choiceMissing} missing choice node options`);
  }
}

// === C++ Cross-Reference ===

console.log("\n=== C++ Cross-Reference ===\n");

function parseCppTalents(prefix) {
  const re = new RegExp(
    `talent\\.${prefix}\\.(\\w+)\\s*=\\s*find_talent_spell\\([^"]*"([^"]+)"`,
    "g",
  );
  const names = new Set();
  let match;
  while ((match = re.exec(src)) !== null) names.add(match[2]);
  return names;
}

const cppVengeance = parseCppTalents("vengeance");
const cppAldrachi = parseCppTalents("aldrachi_reaver");
const cppHavoc = parseCppTalents("havoc");
const cppDevourer = parseCppTalents("devourer");
const cppScarred = parseCppTalents("scarred");

console.log(
  `C++ talent counts: vengeance=${cppVengeance.size}, aldrachi=${cppAldrachi.size}, scarred=${cppScarred.size}`,
);

const allOurTalentNames = allOurTalents.map((t) => t.name);

const havocLeaks = allOurTalentNames.filter(
  (n) => cppHavoc.has(n) && !cppVengeance.has(n),
);
const devourerLeaks = allOurTalentNames.filter(
  (n) => cppDevourer.has(n) && !cppVengeance.has(n),
);
const scarredLeaks = allOurTalentNames.filter(
  (n) => cppScarred.has(n) && !cppVengeance.has(n) && !cppAldrachi.has(n),
);

if (havocLeaks.length === 0) pass("No Havoc talent contamination");
else fail(`Havoc contamination: ${havocLeaks.join(", ")}`);

if (devourerLeaks.length === 0) pass("No Devourer talent contamination");
else fail(`Devourer contamination: ${devourerLeaks.join(", ")}`);

if (scarredLeaks.length === 0) pass("No Scarred hero tree contamination");
else fail(`Scarred hero tree contamination: ${scarredLeaks.join(", ")}`);

// === Base Spell IDs ===

console.log("\n=== Base Spell IDs ===\n");

const spellMap = new Map(spells.map((s) => [s.id, s]));
const baseMissing = [...BASE_SPELL_IDS].filter((id) => !spellMap.has(id));

pass(
  `${BASE_SPELL_IDS.size - baseMissing.length}/${BASE_SPELL_IDS.size} base spell IDs found in spell data`,
);
if (baseMissing.length > 0) {
  warn(
    `${baseMissing.length} base spell IDs not in spell data: ${baseMissing.join(", ")}`,
  );
}

// === Interaction Quality ===

console.log("\n=== Interaction Quality ===\n");

const total = interactions.interactions.length;
const typeCounts = {};
for (const i of interactions.interactions) {
  typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
}
const unknownCount = typeCounts["unknown"] || 0;
const unknownPct = (unknownCount / total) * 100;

console.log(`  Total interactions: ${total}`);
console.log(
  `  Typed: ${total - unknownCount} (${(100 - unknownPct).toFixed(1)}%)`,
);
console.log(`  Unknown: ${unknownCount} (${unknownPct.toFixed(1)}%)`);

for (const [type, count] of Object.entries(typeCounts).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`    ${type}: ${count}`);
}

if (unknownCount === 0) {
  pass("Zero unknown interactions");
} else if (unknownPct < 20) {
  warn(`Unknown interaction rate ${unknownPct.toFixed(1)}% (target: 0%)`);
} else {
  fail(`Unknown interaction rate ${unknownPct.toFixed(1)}% (target: 0%)`);
}

// === Summary Counts ===

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

// === simc Version ===

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

// === Results ===

console.log("\n=== Results ===\n");
console.log(`  ${passed} passed, ${failed} failed, ${warnings} warnings`);
if (failed > 0) {
  console.log("\n  VERIFICATION FAILED");
  process.exit(1);
} else {
  console.log("\n  VERIFICATION PASSED");
}
