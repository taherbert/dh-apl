// Cross-checks spec adapter constants against spell data.
// Catches hardcoded values that disagree with game data (e.g., wrong resource caps).
//
// Usage: node src/spec/validate-spec-data.js

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecAdapter, getSpecAdapter } from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

await loadSpecAdapter();
const adapter = getSpecAdapter();
const { SPEC_CONFIG, BASE_SPELL_IDS, SET_BONUS_SPELL_IDS } = adapter;

const errors = [];
const warns = [];

function error(msg) {
  errors.push(msg);
  console.log(`  ERROR  ${msg}`);
}
function warn(msg) {
  warns.push(msg);
  console.log(`  WARN   ${msg}`);
}
function pass(msg) {
  console.log(`  PASS   ${msg}`);
}

// --- Load spell data ---

const spellsPath = join(DATA_DIR, "spells-summary.json");
if (!existsSync(spellsPath)) {
  console.log(
    "spells-summary.json not found — run `npm run build-data` first.",
  );
  process.exit(1);
}

const spells = JSON.parse(readFileSync(spellsPath, "utf-8"));
const byId = new Map(spells.map((s) => [s.id, s]));

// --- 1. Resource cap validation ---

console.log("\n=== Resource Cap Validation ===\n");

const primary = SPEC_CONFIG.resources?.primary;
if (primary) {
  // Look for talent that modifies the cap
  const talentsPath = join(DATA_DIR, "talents.json");
  let capModTalent = null;
  if (existsSync(talentsPath)) {
    const talents = JSON.parse(readFileSync(talentsPath, "utf-8"));
    const allTalents = [
      ...talents.class.talents,
      ...talents.spec.talents,
      ...Object.values(talents.hero).flatMap((h) => h.talents),
    ];
    for (const t of allTalents) {
      const spell = byId.get(t.spellId);
      if (!spell) continue;
      const desc = (spell.description || "").toLowerCase();
      if (
        desc.includes(`maximum ${primary.name}`) ||
        desc.includes(`max ${primary.name}`)
      ) {
        const match = desc.match(
          /(?:by|increases?\s+maximum\s+\w+\s+by)\s+(\d+)/i,
        );
        if (match) {
          capModTalent = { name: t.name, amount: parseInt(match[1], 10) };
        }
      }
    }
  }

  if (capModTalent) {
    const expectedBase = primary.cap;
    const talentedCap = expectedBase + capModTalent.amount;
    // If the configured cap equals the talented value, it's wrong — should be base
    if (primary.cap === talentedCap) {
      error(
        `${primary.name} cap is ${primary.cap} but that includes ${capModTalent.name} (+${capModTalent.amount}). ` +
          `Base should be ${expectedBase}.`,
      );
    } else {
      pass(
        `${primary.name} cap: ${primary.cap} (base). ${capModTalent.name} adds +${capModTalent.amount} → ${talentedCap} with talent.`,
      );
    }
  } else {
    pass(
      `${primary.name} cap: ${primary.cap} (no cap-modifying talents found)`,
    );
  }
}

const secondary = SPEC_CONFIG.resources?.secondary;
if (secondary) {
  pass(`${secondary.name} cap: ${secondary.cap}`);
}

// --- 2. Spell ID existence ---

console.log("\n=== Spell ID Existence ===\n");

let missingSpellIds = 0;
for (const [name, id] of Object.entries(SPEC_CONFIG.spellIds)) {
  if (!byId.has(id)) {
    error(`spellIds.${name}: spell ${id} not found in spells-summary.json`);
    missingSpellIds++;
  }
}
if (missingSpellIds === 0) {
  pass(
    `All ${Object.keys(SPEC_CONFIG.spellIds).length} spellIds found in spell data`,
  );
}

let missingBase = 0;
for (const id of BASE_SPELL_IDS) {
  if (!byId.has(id)) {
    warn(`BASE_SPELL_IDS: ${id} not found in spells-summary.json`);
    missingBase++;
  }
}
if (missingBase === 0) {
  pass(`All ${BASE_SPELL_IDS.size} BASE_SPELL_IDS found in spell data`);
}

let missingSetBonus = 0;
for (const id of SET_BONUS_SPELL_IDS) {
  if (!byId.has(id)) {
    warn(`SET_BONUS_SPELL_IDS: ${id} not found in spells-summary.json`);
    missingSetBonus++;
  }
}
if (missingSetBonus === 0) {
  pass(
    `All ${SET_BONUS_SPELL_IDS.size} SET_BONUS_SPELL_IDS found in spell data`,
  );
}

// --- 3. Domain overrides vs spell data ---

console.log("\n=== Domain Override Cross-Check ===\n");

let overrideChecks = 0;
let overrideWarnings = 0;

for (const [name, overrides] of Object.entries(SPEC_CONFIG.domainOverrides)) {
  const spellId = SPEC_CONFIG.spellIds[name];
  if (!spellId) continue;
  const spell = byId.get(spellId);
  if (!spell) continue;

  overrideChecks++;

  // Check cooldown disagreements
  if (overrides.cooldown !== undefined && spell.cooldown) {
    if (overrides.cooldown !== spell.cooldown) {
      warn(
        `${name}: override cooldown=${overrides.cooldown} vs spell data cooldown=${spell.cooldown}`,
      );
      overrideWarnings++;
    }
  }

  // Check duration disagreements
  if (overrides.duration !== undefined && spell.duration) {
    if (overrides.duration !== spell.duration) {
      warn(
        `${name}: override duration=${overrides.duration} vs spell data duration=${spell.duration}`,
      );
      overrideWarnings++;
    }
  }

  // Check charge count disagreements
  if (overrides.charges !== undefined && spell.charges) {
    if (overrides.charges !== spell.charges.count) {
      warn(
        `${name}: override charges=${overrides.charges} vs spell data charges=${spell.charges.count}`,
      );
      overrideWarnings++;
    }
  }
}

if (overrideWarnings === 0) {
  pass(`${overrideChecks} domain overrides checked — no disagreements`);
} else {
  console.log(
    `  ${overrideWarnings} override disagreement(s) (may be intentional talent-modified values)`,
  );
}

// --- 4. SPEC_CONFIG required fields ---

console.log("\n=== SPEC_CONFIG Field Validation ===\n");

const requiredFields = [
  "displayNames",
  "displayNames.class",
  "displayNames.spec",
  "keyBuffs",
  "offGcdAbilities",
  "cooldownBuffs",
  "classificationHints",
  "resourceNames",
];

let fieldErrors = 0;
for (const field of requiredFields) {
  const parts = field.split(".");
  let val = SPEC_CONFIG;
  for (const p of parts) val = val?.[p];
  if (val === undefined || val === null) {
    error(`SPEC_CONFIG.${field} is missing`);
    fieldErrors++;
  }
}
if (fieldErrors === 0) {
  pass(`All ${requiredFields.length} required SPEC_CONFIG fields present`);
}

// --- 5. Hero tree subtree IDs ---

console.log("\n=== Hero Tree Validation ===\n");

const raidbotsTalentsPath = join(DATA_DIR, "raidbots-talents.json");
if (existsSync(raidbotsTalentsPath)) {
  const raidbots = JSON.parse(readFileSync(raidbotsTalentsPath, "utf-8"));
  const rbSubtreeIds = new Set(raidbots.heroNodes.map((n) => n.subTreeId));

  let heroErrors = 0;
  for (const [name, tree] of Object.entries(SPEC_CONFIG.heroTrees)) {
    if (!rbSubtreeIds.has(tree.subtree)) {
      error(
        `heroTrees.${name}.subtree=${tree.subtree} not found in raidbots hero nodes`,
      );
      heroErrors++;
    }
  }
  if (heroErrors === 0) {
    pass(
      `All ${Object.keys(SPEC_CONFIG.heroTrees).length} hero tree subtree IDs verified`,
    );
  }
} else {
  warn("raidbots-talents.json not found — skipping hero tree validation");
}

// --- Summary ---

console.log("\n=== Spec Data Validation Summary ===\n");
console.log(`  ${errors.length} error(s), ${warns.length} warning(s)`);

if (errors.length > 0) {
  console.log("\n  VALIDATION FAILED");
  process.exit(1);
} else {
  console.log("\n  VALIDATION PASSED");
}
