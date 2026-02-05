// Talent-APL Coupling Detection — identifies build-APL dependencies
// Analyzes which talents require specific APL adaptations
// Usage: node src/analyze/talent-apl-coupling.js [talents.json] [apl.simc]

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const APL_DIR = join(ROOT, "apls");

// --- Coupling Categories ---

const COUPLING_CATEGORIES = {
  ABILITY_UNLOCK: "Talent unlocks a new ability that must be added to APL",
  ABILITY_MODIFY: "Talent modifies existing ability behavior/resource cost",
  RESOURCE_CHANGE: "Talent changes resource generation or caps",
  COOLDOWN_CHANGE: "Talent modifies cooldown timing",
  PROC_MECHANIC: "Talent adds proc that should be tracked or optimized",
  BUFF_WINDOW: "Talent creates damage window that APL should align to",
  CONDITION_GATE: "APL conditions should check for this talent",
  HERO_TREE_ROUTING: "Talent determines which hero tree branch to use",
};

// --- Talent Analysis ---

function analyzeTalent(talent, spells) {
  const couplings = [];
  const name = talent.name;
  const description = talent.description || "";
  const spellId = talent.spellId;

  // Find corresponding spell
  const spell = spells.find((s) => s.id === spellId);

  // Check for ability unlock patterns
  if (talent.entryType === "active" && spell && !spell.passive) {
    couplings.push({
      category: COUPLING_CATEGORIES.ABILITY_UNLOCK,
      talent: name,
      detail: `Unlocks ${spell.name} — must add to APL`,
      aplAction:
        `Add actions+=/` + spell.name.toLowerCase().replace(/\s+/g, "_"),
      priority: "high",
    });
  }

  // Check for resource modifications
  const resourcePatterns = [
    /generates?\s+(\d+)\s+(additional\s+)?(fury|soul\s*fragment)/i,
    /reduces?\s+(the\s+)?cooldown/i,
    /increases?\s+maximum\s+(fury|soul\s*fragment)/i,
    /additional\s+charge/i,
  ];

  for (const pattern of resourcePatterns) {
    if (pattern.test(description)) {
      couplings.push({
        category: COUPLING_CATEGORIES.RESOURCE_CHANGE,
        talent: name,
        detail: `Modifies resource economy: ${description.slice(0, 100)}...`,
        aplAction: "Review resource thresholds and conditions",
        priority: "medium",
      });
      break;
    }
  }

  // Check for proc mechanics
  const procPatterns = [
    /(\d+)%\s+chance/i,
    /has\s+a\s+chance\s+to/i,
    /when\s+you\s+(cast|deal|consume|generate)/i,
    /each\s+time\s+you/i,
  ];

  for (const pattern of procPatterns) {
    if (pattern.test(description)) {
      couplings.push({
        category: COUPLING_CATEGORIES.PROC_MECHANIC,
        talent: name,
        detail: `Introduces proc mechanic: ${description.slice(0, 100)}...`,
        aplAction: "Consider tracking proc buff in conditions",
        priority: "medium",
      });
      break;
    }
  }

  // Check for buff/debuff windows
  const windowPatterns = [
    /increases?\s+(damage|fire damage|physical damage)\s+(you\s+deal\s+)?by\s+(\d+)%/i,
    /deals?\s+(\d+)%\s+(increased|additional)\s+damage/i,
    /for\s+(\d+)\s+sec/i,
  ];

  for (const pattern of windowPatterns) {
    if (pattern.test(description)) {
      couplings.push({
        category: COUPLING_CATEGORIES.BUFF_WINDOW,
        talent: name,
        detail: `Creates damage window: ${description.slice(0, 100)}...`,
        aplAction: "Add buff tracking variable and align damage abilities",
        priority: "high",
      });
      break;
    }
  }

  // Check for cooldown modifications
  const cdPatterns = [
    /reduces?\s+(the\s+)?cooldown\s+(of\s+\w+\s+)?by\s+(\d+)/i,
    /(\d+)\s+sec\s+reduced\s+cooldown/i,
    /resets?\s+the\s+cooldown/i,
  ];

  for (const pattern of cdPatterns) {
    if (pattern.test(description)) {
      couplings.push({
        category: COUPLING_CATEGORIES.COOLDOWN_CHANGE,
        talent: name,
        detail: `Modifies cooldown: ${description.slice(0, 100)}...`,
        aplAction: "Review cooldown sequencing and alignment",
        priority: "medium",
      });
      break;
    }
  }

  return couplings;
}

// --- APL Analysis ---

function analyzeAplForTalentRefs(aplText) {
  const talentRefs = new Set();
  const buffRefs = new Set();
  const abilityRefs = new Set();

  // Find talent.X references
  const talentPattern = /talent\.(\w+)/g;
  let match;
  while ((match = talentPattern.exec(aplText)) !== null) {
    talentRefs.add(match[1]);
  }

  // Find buff.X references
  const buffPattern = /buff\.(\w+)/g;
  while ((match = buffPattern.exec(aplText)) !== null) {
    buffRefs.add(match[1]);
  }

  // Find ability names (lines starting with actions)
  const actionPattern = /actions[^=]*=\/?(\w+)/g;
  while ((match = actionPattern.exec(aplText)) !== null) {
    if (
      ![
        "variable",
        "call_action_list",
        "run_action_list",
        "snapshot_stats",
      ].includes(match[1])
    ) {
      abilityRefs.add(match[1]);
    }
  }

  return { talentRefs, buffRefs, abilityRefs };
}

// --- Coupling Report ---

function generateCouplingReport(talents, spells, aplText) {
  const allCouplings = [];
  const aplAnalysis = aplText ? analyzeAplForTalentRefs(aplText) : null;

  // Analyze each talent
  const allTalents = [
    ...(talents.class?.talents || []),
    ...(talents.spec?.talents || []),
    ...(talents.heroTrees?.flatMap((ht) => ht.talents) || []),
  ];

  for (const talent of allTalents) {
    const couplings = analyzeTalent(talent, spells);
    allCouplings.push(...couplings);
  }

  // Cross-reference with APL if provided
  if (aplAnalysis) {
    const missingTalentGates = [];
    const unusedAbilities = [];

    for (const coupling of allCouplings) {
      if (coupling.category === COUPLING_CATEGORIES.ABILITY_UNLOCK) {
        const abilityName = coupling.talent.toLowerCase().replace(/\s+/g, "_");
        if (!aplAnalysis.abilityRefs.has(abilityName)) {
          missingTalentGates.push({
            talent: coupling.talent,
            issue: "Ability unlocked by talent not found in APL",
            suggestion: coupling.aplAction,
          });
        }
      }
    }

    return { allCouplings, missingTalentGates, unusedAbilities, aplAnalysis };
  }

  return {
    allCouplings,
    missingTalentGates: [],
    unusedAbilities: [],
    aplAnalysis: null,
  };
}

// --- Export Functions ---

export function detectCouplings(talentsPath, aplPath = null) {
  const talents = JSON.parse(readFileSync(talentsPath, "utf-8"));
  const spellsPath = join(DATA_DIR, "spells-summary.json");
  const spells = existsSync(spellsPath)
    ? JSON.parse(readFileSync(spellsPath, "utf-8"))
    : [];

  const aplText =
    aplPath && existsSync(aplPath) ? readFileSync(aplPath, "utf-8") : null;

  return generateCouplingReport(talents, spells, aplText);
}

export function printCouplingReport(report) {
  console.log("\n" + "=".repeat(70));
  console.log("Talent-APL Coupling Analysis");
  console.log("=".repeat(70));

  // Group by category
  const byCategory = {};
  for (const coupling of report.allCouplings) {
    const cat = coupling.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(coupling);
  }

  for (const [category, couplings] of Object.entries(byCategory)) {
    console.log(`\n--- ${category} ---`);
    for (const c of couplings) {
      console.log(`  [${c.priority}] ${c.talent}`);
      console.log(`    Detail: ${c.detail.slice(0, 80)}`);
      console.log(`    Action: ${c.aplAction}`);
    }
  }

  if (report.missingTalentGates.length > 0) {
    console.log("\n--- Missing Talent Gates ---");
    for (const m of report.missingTalentGates) {
      console.log(`  ${m.talent}: ${m.issue}`);
      console.log(`    Suggestion: ${m.suggestion}`);
    }
  }

  if (report.aplAnalysis) {
    console.log("\n--- APL Cross-Reference ---");
    console.log(
      `  Talent refs: ${[...report.aplAnalysis.talentRefs].join(", ")}`,
    );
    console.log(
      `  Buff refs: ${[...report.aplAnalysis.buffRefs].slice(0, 10).join(", ")}...`,
    );
    console.log(
      `  Abilities: ${[...report.aplAnalysis.abilityRefs].join(", ")}`,
    );
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Total couplings found: ${report.allCouplings.length}`);
  console.log(
    `High priority: ${report.allCouplings.filter((c) => c.priority === "high").length}`,
  );
  console.log(
    `Medium priority: ${report.allCouplings.filter((c) => c.priority === "medium").length}`,
  );
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const talentsPath = process.argv[2] || join(DATA_DIR, "talents.json");
  const aplPath = process.argv[3] || join(APL_DIR, "vengeance.simc");

  if (!existsSync(talentsPath)) {
    console.error(`Talents file not found: ${talentsPath}`);
    process.exit(1);
  }

  const report = detectCouplings(talentsPath, aplPath);
  printCouplingReport(report);

  console.log("\n--- JSON Summary (first 5) ---");
  console.log(JSON.stringify(report.allCouplings.slice(0, 5), null, 2));
}
