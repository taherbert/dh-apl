// APL Scaffold Generator — creates APL skeleton from spell data
// Generates a starting APL for any spec based on spells-summary.json and talents.json
// Usage: node src/apl/scaffold.js [spec] [hero-tree] [output.simc]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

// --- Spec Configuration ---

const SPEC_CONFIG = {
  vengeance: {
    specId: "vengeance",
    className: "demonhunter",
    role: "tank",
    primaryResource: "fury",
    secondaryResource: "soul_fragments",
    resourceCap: { fury: 120, soul_fragments: 6 },
    keyMechanics: ["fury", "soul_fragments", "metamorphosis"],
    // Keywords to identify spec-relevant spells
    spellKeywords: [
      "demon_spikes",
      "soul_cleave",
      "spirit_bomb",
      "fracture",
      "immolation_aura",
      "sigil_of_flame",
      "fiery_brand",
      "fel_devastation",
      "soul_carver",
      "metamorphosis",
      "felblade",
      "throw_glaive",
      "vengeful_retreat",
      "infernal_strike",
    ],
  },
  // Add other specs here
};

// --- Spell Classification ---

function classifySpell(spell) {
  const classification = {
    type: "unknown",
    priority: 0,
    category: "filler",
    resource: null,
    generates: null,
    cooldown: null,
    isGcd: true,
    isAoe: false,
    isBuff: false,
    isDebuff: false,
    conditions: [],
  };

  // Cooldown classification
  if (spell.cooldown && spell.cooldown >= 60) {
    classification.category = "major_cooldown";
    classification.priority = 100 - spell.cooldown / 10;
  } else if (spell.cooldown && spell.cooldown >= 20) {
    classification.category = "minor_cooldown";
    classification.priority = 50 - spell.cooldown / 5;
  }

  // Resource classification
  if (spell.resource) {
    const match = spell.resource.match(/(\d+)\s*(\w+)/i);
    if (match) {
      classification.resource = {
        cost: parseInt(match[1], 10),
        type: match[2].toLowerCase(),
      };
      classification.category = "spender";
      classification.priority = 30 + classification.resource.cost / 5;
    }
  }

  if (spell.generates && spell.generates.length > 0) {
    classification.generates = [];
    for (const gen of spell.generates) {
      const match = gen.match(/(\d+)\s*(\w+)/i);
      if (match) {
        classification.generates.push({
          amount: parseInt(match[1], 10),
          type: match[2].toLowerCase(),
        });
      }
    }
    if (classification.category === "filler") {
      classification.category = "generator";
      classification.priority = 20;
    }
  }

  // GCD classification
  if (spell.gcd === 0 || spell.gcd === false) {
    classification.isGcd = false;
    classification.conditions.push("use_off_gcd=1");
  }

  // AoE classification
  if (spell.aoeRadius && spell.aoeRadius > 0) {
    classification.isAoe = true;
  }

  // Duration implies buff/debuff
  if (spell.duration && spell.duration > 0) {
    if (spell.description?.toLowerCase().includes("damage you take")) {
      classification.isDebuff = true;
    } else {
      classification.isBuff = true;
    }
  }

  // Passive check
  if (spell.passive) {
    classification.type = "passive";
    classification.priority = -1;
  }

  classification.cooldown = spell.cooldown || 0;

  return classification;
}

// --- APL Generation ---

function generateScaffoldApl(specConfig, spells, talents) {
  const lines = [];
  const actionsByCategory = {
    precombat: [],
    cooldowns: [],
    spenders: [],
    generators: [],
    fillers: [],
    defensives: [],
  };

  // Filter and classify spells
  const relevantSpells = spells.filter((s) => {
    const name = s.name.toLowerCase().replace(/\s+/g, "_");
    return (
      specConfig.spellKeywords.some((k) => name.includes(k)) ||
      specConfig.spellKeywords.some((k) => s.name.toLowerCase().includes(k))
    );
  });

  for (const spell of relevantSpells) {
    const classification = classifySpell(spell);
    if (classification.type === "passive") continue;

    const abilityName = spell.name.toLowerCase().replace(/\s+/g, "_");
    const action = { name: abilityName, spell, classification };

    switch (classification.category) {
      case "major_cooldown":
      case "minor_cooldown":
        actionsByCategory.cooldowns.push(action);
        break;
      case "spender":
        actionsByCategory.spenders.push(action);
        break;
      case "generator":
        actionsByCategory.generators.push(action);
        break;
      default:
        actionsByCategory.fillers.push(action);
    }
  }

  // Sort each category by priority
  for (const category of Object.keys(actionsByCategory)) {
    actionsByCategory[category].sort(
      (a, b) => b.classification.priority - a.classification.priority,
    );
  }

  // Generate APL structure
  lines.push("# === Auto-generated APL Scaffold ===");
  lines.push(`# Spec: ${specConfig.specId}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push("#");
  lines.push("# WARNING: This is a STARTING POINT, not a finished APL.");
  lines.push("# Review conditions, add talent gates, and optimize priorities.");
  lines.push("");

  // Profile reference
  lines.push("input=apls/profile.simc");
  lines.push("");

  // Precombat
  lines.push("# === Precombat ===");
  lines.push("actions.precombat=/snapshot_stats");

  // Add abilities that make sense to pre-cast
  for (const action of actionsByCategory.cooldowns) {
    if (action.classification.isBuff && action.classification.cooldown >= 30) {
      lines.push(`# Consider: actions.precombat+=/` + action.name);
    }
  }
  lines.push("");

  // Default action list
  lines.push("# === Default (runs every cycle) ===");
  lines.push("actions=/auto_attack");
  lines.push("# Interrupt");
  lines.push("actions+=/disrupt,if=target.debuff.casting.react");
  lines.push("");

  // Off-GCD abilities
  lines.push("# Off-GCD abilities");
  for (const action of [
    ...actionsByCategory.cooldowns,
    ...actionsByCategory.spenders,
  ]) {
    if (!action.classification.isGcd) {
      lines.push(`actions+=/` + action.name + `,use_off_gcd=1`);
    }
  }
  lines.push("");

  // Cooldowns
  if (actionsByCategory.cooldowns.length > 0) {
    lines.push("# === Cooldowns ===");
    lines.push("actions+=/call_action_list,name=cooldowns");
    lines.push("");
  }

  // Core rotation
  lines.push("# === Core Rotation ===");

  // Spenders first (consume resources)
  lines.push("# Spenders");
  for (const action of actionsByCategory.spenders) {
    if (action.classification.isGcd) {
      let condition = "";
      if (action.classification.resource) {
        const { cost, type } = action.classification.resource;
        condition = `,if=${type}>=${cost}`;
      }
      lines.push(`actions+=/` + action.name + condition);
    }
  }

  // Generators (build resources)
  lines.push("# Generators");
  for (const action of actionsByCategory.generators) {
    if (action.classification.isGcd) {
      lines.push(`actions+=/` + action.name);
    }
  }

  // Fillers
  lines.push("# Fillers");
  for (const action of actionsByCategory.fillers) {
    if (action.classification.isGcd) {
      lines.push(`actions+=/` + action.name);
    }
  }
  lines.push("");

  // Cooldowns action list
  if (actionsByCategory.cooldowns.length > 0) {
    lines.push("# === Cooldowns ===");
    for (const action of actionsByCategory.cooldowns) {
      if (action.classification.isGcd) {
        lines.push(`actions.cooldowns=/` + action.name);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Scaffold Analysis Report ---

function generateAnalysisReport(specConfig, spells) {
  const report = [];
  report.push("# APL Scaffold Analysis Report");
  report.push("");
  report.push(`## Spec: ${specConfig.specId}`);
  report.push("");

  const relevantSpells = spells.filter((s) => {
    const name = s.name.toLowerCase().replace(/\s+/g, "_");
    return (
      specConfig.spellKeywords.some((k) => name.includes(k)) ||
      specConfig.spellKeywords.some((k) => s.name.toLowerCase().includes(k))
    );
  });

  report.push("## Identified Abilities");
  report.push("");
  report.push("| Ability | Category | Cooldown | Resource | Notes |");
  report.push("|---------|----------|----------|----------|-------|");

  for (const spell of relevantSpells) {
    const classification = classifySpell(spell);
    if (classification.type === "passive") continue;

    const name = spell.name;
    const category = classification.category;
    const cd = classification.cooldown ? `${classification.cooldown}s` : "-";
    const resource = classification.resource
      ? `${classification.resource.cost} ${classification.resource.type}`
      : classification.generates
        ? `+${classification.generates.map((g) => `${g.amount} ${g.type}`).join(", ")}`
        : "-";
    const notes = [
      classification.isAoe ? "AoE" : "",
      classification.isBuff ? "Buff" : "",
      classification.isDebuff ? "Debuff" : "",
      !classification.isGcd ? "Off-GCD" : "",
    ]
      .filter(Boolean)
      .join(", ");

    report.push(`| ${name} | ${category} | ${cd} | ${resource} | ${notes} |`);
  }

  report.push("");
  report.push("## Missing Information");
  report.push("");
  report.push("The scaffold generator cannot determine:");
  report.push("1. **Talent gates** — which abilities require specific talents");
  report.push(
    "2. **Hero tree routing** — which abilities belong to which hero tree",
  );
  report.push(
    "3. **Buff/debuff windows** — optimal timing for damage amplifiers",
  );
  report.push(
    "4. **Resource thresholds** — optimal fragment counts, fury pooling points",
  );
  report.push(
    "5. **Priority ordering** — which spenders beat which generators in practice",
  );
  report.push("");
  report.push("These require manual analysis or simulation to determine.");

  return report.join("\n");
}

// --- Main Entry Point ---

export function scaffold(specId, heroTree = null) {
  const specConfig = SPEC_CONFIG[specId];
  if (!specConfig) {
    throw new Error(
      `Unknown spec: ${specId}. Available: ${Object.keys(SPEC_CONFIG).join(", ")}`,
    );
  }

  const spellsPath = join(DATA_DIR, "spells-summary.json");
  const talentsPath = join(DATA_DIR, "talents.json");

  if (!existsSync(spellsPath)) {
    throw new Error(
      `Spells data not found: ${spellsPath}. Run 'npm run build-data' first.`,
    );
  }

  const spells = JSON.parse(readFileSync(spellsPath, "utf-8"));
  const talents = existsSync(talentsPath)
    ? JSON.parse(readFileSync(talentsPath, "utf-8"))
    : null;

  const aplContent = generateScaffoldApl(specConfig, spells, talents);
  const analysisReport = generateAnalysisReport(specConfig, spells);

  return { aplContent, analysisReport };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const specId = process.argv[2] || "vengeance";
  const heroTree = process.argv[3] || null;
  const outputPath = process.argv[4] || null;

  console.log(`Generating APL scaffold for ${specId}...`);

  try {
    const { aplContent, analysisReport } = scaffold(specId, heroTree);

    if (outputPath) {
      writeFileSync(outputPath, aplContent);
      console.log(`APL written to: ${outputPath}`);

      const reportPath = outputPath.replace(".simc", "-analysis.md");
      writeFileSync(reportPath, analysisReport);
      console.log(`Analysis report written to: ${reportPath}`);
    } else {
      console.log("\n" + "=".repeat(70));
      console.log("Generated APL Scaffold");
      console.log("=".repeat(70));
      console.log(aplContent);
      console.log("\n" + "=".repeat(70));
      console.log("Analysis Report");
      console.log("=".repeat(70));
      console.log(analysisReport);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
