// Verification script: compares extracted data against Raidbots (ground truth)
// and simc C++ source. Checks talent coverage, counts, choice nodes, hero trees,
// contamination, interaction quality, and talent coverage invariants.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SPELL_IDS, SET_BONUS_SPELL_IDS } from "./spec/vengeance.js";
import { SIMC_DIR, SIMC_DH_CPP, HERO_SUBTREES } from "./engine/startup.js";

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

  const ourClassCount = talents.class.talents.length;
  const ourSpecCount = talents.spec.talents.length;

  const rbClassEntries = raidbots.classNodes.reduce(
    (s, n) => s + n.entries.filter((e) => e.spellId).length,
    0,
  );
  const rbSpecEntries = raidbots.specNodes.reduce(
    (s, n) => s + n.entries.filter((e) => e.spellId).length,
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
      .reduce((s, n) => s + n.entries.filter((e) => e.spellId).length, 0);
    if (heroTalents.length === rbEntries) {
      pass(`Hero (${name}) entries match Raidbots: ${heroTalents.length}`);
    } else {
      fail(
        `Hero (${name}) entries: ours=${heroTalents.length}, Raidbots=${rbEntries}`,
      );
    }
  }

  const ourSpellIds = new Set(allOurTalents.map((t) => t.spellId));

  const allRbNodes = [
    ...raidbots.classNodes,
    ...raidbots.specNodes,
    ...raidbots.heroNodes,
  ];
  const missingFromUs = [];
  for (const node of allRbNodes) {
    for (const entry of node.entries) {
      if (!entry.spellId) continue;
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

const setBonusMissing = [...SET_BONUS_SPELL_IDS].filter(
  (id) => !spellMap.has(id),
);
if (setBonusMissing.length === 0) {
  pass(
    `${SET_BONUS_SPELL_IDS.size}/${SET_BONUS_SPELL_IDS.size} set bonus spell IDs found in spell data`,
  );
} else {
  warn(
    `${setBonusMissing.length} set bonus spell IDs not in spell data: ${setBonusMissing.join(", ")}`,
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
const unknownPct = total > 0 ? (unknownCount / total) * 100 : 0;

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

// Hard fail on any unknown
if (unknownCount === 0) {
  pass("Zero unknown interactions");
} else {
  fail(`${unknownCount} unknown interactions (must be 0)`);
  for (const i of interactions.interactions.filter(
    (x) => x.type === "unknown",
  )) {
    console.log(`    ${i.source.name} -> ${i.target.name}`);
  }
}

// Null target IDs on non-buff targets
const nullNonBuff = interactions.interactions.filter(
  (i) => i.target && i.target.id === null && !i.target.name.startsWith("buff:"),
);
if (nullNonBuff.length === 0) {
  pass("No null target IDs on non-buff targets");
} else {
  fail(`${nullNonBuff.length} null target IDs on non-buff targets`);
  for (const i of nullNonBuff) {
    console.log(`    ${i.source.name} -> ${i.target.name}`);
  }
}

// Undefined talent types
const undefinedTypes = allOurTalents.filter((t) => !t.type);
if (undefinedTypes.length === 0) {
  pass("All talents have a type classification");
} else {
  fail(`${undefinedTypes.length} talents with undefined type`);
  for (const t of undefinedTypes) {
    console.log(`    ${t.name} (${t.spellId})`);
  }
}

// === Talent Coverage ===

console.log("\n=== Talent Coverage ===\n");

const talentCategories = interactions.talentCategories || {};
const interactionSourceIds = new Set(
  Object.keys(interactions.byTalent || {}).map(Number),
);
const interactionTargetIds = new Set(
  interactions.interactions.map((i) => i.target.id).filter(Boolean),
);

let coverageGaps = 0;
const gapTalents = [];
for (const t of allOurTalents) {
  const category = talentCategories[t.name];
  if (category === "stat_passive") continue; // excluded from coverage requirement

  const hasInteraction =
    interactionSourceIds.has(t.spellId) || interactionTargetIds.has(t.spellId);

  if (!hasInteraction && category !== "cpp_only") {
    coverageGaps++;
    gapTalents.push(`${t.name} (${category || "uncategorized"})`);
  }
}

if (coverageGaps === 0) {
  pass("All non-stat-passive talents have interactions or are categorized");
} else {
  warn(`${coverageGaps} talent coverage gaps: ${gapTalents.join(", ")}`);
}

// Stat passive count
const statPassiveCount = Object.values(talentCategories).filter(
  (c) => c === "stat_passive",
).length;
const cppOnlyCount = Object.values(talentCategories).filter(
  (c) => c === "cpp_only",
).length;
console.log(`  Stat passives (excluded): ${statPassiveCount}`);
console.log(`  C++-only (expected gaps): ${cppOnlyCount}`);
console.log(`  Coverage gaps: ${coverageGaps}`);

// === Orphan Check ===

console.log("\n=== Orphan Check ===\n");

const allSpellIds = new Set(spells.map((s) => s.id));
const allTalentSpellIds = new Set(allOurTalents.map((t) => t.spellId));
let orphans = 0;
for (const i of interactions.interactions) {
  if (
    i.source.id &&
    !allSpellIds.has(i.source.id) &&
    !allTalentSpellIds.has(i.source.id)
  ) {
    orphans++;
    console.log(`    Orphan source: ${i.source.name} (${i.source.id})`);
  }
}
if (orphans === 0) {
  pass("No orphan interaction sources");
} else {
  warn(`${orphans} orphan interaction sources`);
}

// === Stale Spells ===

console.log("\n=== Stale Spells ===\n");

const interactionRefIds = new Set();
for (const i of interactions.interactions) {
  if (i.source.id) interactionRefIds.add(i.source.id);
  if (i.target?.id) interactionRefIds.add(i.target.id);
}

const staleSpells = spells.filter(
  (s) =>
    !allTalentSpellIds.has(s.id) &&
    !BASE_SPELL_IDS.has(s.id) &&
    !SET_BONUS_SPELL_IDS.has(s.id) &&
    !interactionRefIds.has(s.id),
);

if (staleSpells.length <= 1) {
  pass(
    `${staleSpells.length} unreferenced spell(s) in spells.json${staleSpells.length ? ` (${staleSpells.map((s) => s.name).join(", ")})` : ""}`,
  );
} else {
  warn(
    `${staleSpells.length} unreferenced spells in spells.json: ${staleSpells
      .slice(0, 5)
      .map((s) => `${s.name} (${s.id})`)
      .join(
        ", ",
      )}${staleSpells.length > 5 ? ` and ${staleSpells.length - 5} more` : ""}`,
  );
}

// === Cross-Tree Coverage ===

console.log("\n=== Cross-Tree Coverage ===\n");

const heroTalentNames = new Set(
  Object.values(talents.hero)
    .flatMap((h) => h.talents)
    .map((t) => t.name),
);
const heroWithCrossTree = new Set();
for (const i of interactions.interactions) {
  if (i.source.tree === "hero") {
    const targetTalent = allOurTalents.find((t) => t.spellId === i.target.id);
    if (!targetTalent || targetTalent.treeName !== "hero") {
      heroWithCrossTree.add(i.source.name);
    }
  }
  if (
    i.target.id &&
    heroTalentNames.has(i.target.name) &&
    i.source.tree !== "hero"
  ) {
    heroWithCrossTree.add(i.target.name);
  }
}

const heroTotal = [...heroTalentNames].length;
const heroCovered = heroWithCrossTree.size;
if (heroCovered > 0) {
  pass(
    `${heroCovered}/${heroTotal} hero talents interact with spec/class abilities`,
  );
} else {
  warn("No hero↔spec cross-tree interactions found");
}

// === Spot Check ===

console.log("\n=== Spot Check (10 random interactions) ===\n");

const shuffled = [...interactions.interactions].sort(() => Math.random() - 0.5);
for (const i of shuffled.slice(0, 10)) {
  console.log(
    `  ${i.source.name} → ${i.target.name} [${i.type}] (${i.discoveryMethod}, ${i.confidence})`,
  );
}

// === C++ Scanner Coverage ===

console.log("\n=== C++ Scanner Coverage ===\n");

const cppAllTalents = new Set([...cppVengeance, ...cppAldrachi]);
const cppAnnihilator = parseCppTalents("annihilator");
for (const n of cppAnnihilator) cppAllTalents.add(n);

const cppTalentsWithInteractions = new Set();
for (const name of cppAllTalents) {
  if (
    interactionSourceIds.has(
      allOurTalents.find((t) => t.name === name)?.spellId,
    )
  ) {
    cppTalentsWithInteractions.add(name);
  }
}

console.log(
  `  C++ talents: ${cppAllTalents.size}, with interactions: ${cppTalentsWithInteractions.size}`,
);
const cppCoverage =
  cppAllTalents.size > 0
    ? ((cppTalentsWithInteractions.size / cppAllTalents.size) * 100).toFixed(1)
    : "N/A";
console.log(`  C++ coverage: ${cppCoverage}%`);

// === Key Spells ===

console.log("\n=== Key Spells ===\n");

const keySpells = [
  [247454, "Spirit Bomb"],
  [228477, "Soul Cleave"],
  [204021, "Fiery Brand"],
  [263642, "Fracture"],
  [212084, "Fel Devastation"],
  [258920, "Immolation Aura"],
  [204596, "Sigil of Flame"],
];

for (const [id, name] of keySpells) {
  if (spellMap.has(id)) pass(`Key spell: ${name} (${id})`);
  else fail(`Key spell missing: ${name} (${id})`);
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

// Discovery method breakdown
const methodCounts = {};
for (const i of interactions.interactions) {
  methodCounts[i.discoveryMethod] = (methodCounts[i.discoveryMethod] || 0) + 1;
}
console.log("  Discovery methods:");
for (const [m, c] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${m}: ${c}`);
}

// === Enrichment Quality ===

console.log("\n=== Enrichment Quality ===\n");

const withMagnitude = interactions.interactions.filter(
  (i) => i.magnitude,
).length;
const withApplication = interactions.interactions.filter(
  (i) => i.application,
).length;
const withEffectDetails = interactions.interactions.filter(
  (i) => i.effectDetails,
).length;
const withCategories = interactions.interactions.filter(
  (i) => i.categories,
).length;

console.log(`  magnitude: ${withMagnitude}/${total}`);
console.log(`  application: ${withApplication}/${total}`);
console.log(`  effectDetails: ${withEffectDetails}/${total}`);
console.log(`  categories: ${withCategories}/${total}`);

if (withApplication === total) {
  pass("All interactions have application method");
} else {
  warn(`${total - withApplication} interactions missing application method`);
}

if (withCategories === total) {
  pass("All interactions have categories");
} else {
  warn(`${total - withCategories} interactions missing categories`);
}

const magnitudePct = total > 0 ? (withMagnitude / total) * 100 : 0;
if (magnitudePct >= 50) {
  pass(`Magnitude coverage: ${magnitudePct.toFixed(1)}% (>= 50%)`);
} else {
  warn(`Magnitude coverage: ${magnitudePct.toFixed(1)}% (< 50%)`);
}

// Spot check: spells.json should have schoolMask
const spellsWithSchoolMask = spells.filter((s) => s.schoolMask != null).length;
if (spellsWithSchoolMask > 0) {
  pass(`${spellsWithSchoolMask}/${spells.length} spells have schoolMask`);
} else {
  warn("No spells have schoolMask field");
}

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
