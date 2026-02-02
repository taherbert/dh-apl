// APL Reasoning Framework: generates improvement hypotheses from sim results.
// Takes simulation results + interaction data + APL and produces ranked hypotheses.
// Usage: node src/analyze/reasoning.js <workflow-results.json>

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

function loadInteractions() {
  return JSON.parse(readFileSync(join(DATA_DIR, "interactions.json"), "utf-8"));
}

function loadTalents() {
  return JSON.parse(readFileSync(join(DATA_DIR, "talents.json"), "utf-8"));
}

// Generate improvement hypotheses from workflow results.
export function generateHypotheses(workflowResults) {
  const interactions = loadInteractions();
  const hypotheses = [];

  for (const scenario of workflowResults.scenarios) {
    if (scenario.error) continue;

    hypotheses.push(...analyzeUnderusedAbilities(scenario, interactions));
    hypotheses.push(...analyzeBuffUptimeGaps(scenario, interactions));
    hypotheses.push(...analyzeCooldownAlignment(scenario, interactions));
    hypotheses.push(...analyzeConditionalTightness(scenario));
    hypotheses.push(...analyzeAoeMismatch(scenario, workflowResults));
  }

  // Deduplicate by hypothesis text
  const seen = new Set();
  const unique = hypotheses.filter((h) => {
    if (seen.has(h.hypothesis)) return false;
    seen.add(h.hypothesis);
    return true;
  });

  // Sort by confidence (high > medium > low), then by category
  const confidenceOrder = { high: 0, medium: 1, low: 2 };
  unique.sort(
    (a, b) =>
      (confidenceOrder[a.confidence] || 2) -
      (confidenceOrder[b.confidence] || 2),
  );

  return unique;
}

// Abilities with many interaction sources but low DPS contribution.
function analyzeUnderusedAbilities(scenario, interactions) {
  const hypotheses = [];
  const bySpell = interactions.bySpell || {};

  for (const [spellName, data] of Object.entries(bySpell)) {
    const interactionCount = data.modifiers?.length || 0;
    if (interactionCount < 3) continue;

    // Check if this ability has low contribution in the scenario
    const ability = scenario.majorDamage?.find(
      (a) =>
        a.name.toLowerCase().replace(/[_ ]/g, "") ===
        spellName.toLowerCase().replace(/[_ ]/g, ""),
    );
    const lowAbility = scenario.lowContrib?.find(
      (a) =>
        a.name.toLowerCase().replace(/[_ ]/g, "") ===
        spellName.toLowerCase().replace(/[_ ]/g, ""),
    );

    if (lowAbility && interactionCount >= 3) {
      hypotheses.push({
        hypothesis: `${spellName} has ${interactionCount} talent modifiers but contributes <1% DPS in ${scenario.scenarioName} — APL may not be using it optimally`,
        category: "underused_ability",
        confidence: "medium",
        affectedAbilities: [spellName],
        scenario: scenario.scenario,
        suggestedTest: `Check ${spellName} conditions — it may be gated too tightly or positioned too low in priority`,
      });
    }

    // Also flag abilities that are major contributors but have even more untapped modifiers
    if (ability && interactionCount >= 5 && ability.fraction < 15) {
      const modifierNames = (data.modifiers || [])
        .filter((m) => m.type === "damage_modifier")
        .map((m) => m.source?.name)
        .filter(Boolean)
        .slice(0, 3);

      if (modifierNames.length >= 2) {
        hypotheses.push({
          hypothesis: `${spellName} (${ability.fraction}% DPS) has ${interactionCount} modifiers including ${modifierNames.join(", ")} — ensuring buff alignment could increase its contribution`,
          category: "modifier_alignment",
          confidence: "low",
          affectedAbilities: [spellName, ...modifierNames],
          scenario: scenario.scenario,
          suggestedTest: `Try adding buff.X.up conditions to ${spellName} usage to align with damage modifiers`,
        });
      }
    }
  }

  return hypotheses;
}

// Buffs with many beneficiaries but low uptime.
function analyzeBuffUptimeGaps(scenario, interactions) {
  const hypotheses = [];
  const byTalent = interactions.byTalent || {};

  for (const [talentName, data] of Object.entries(byTalent)) {
    const targets = data.targets || [];
    if (targets.length < 2) continue;

    // Check if this talent's associated buff has low uptime
    const normalizedName = talentName.toLowerCase().replace(/[' ]/g, "_");
    const buffUptime = scenario.buffUptimes?.[normalizedName];

    if (buffUptime !== undefined && buffUptime < 40 && targets.length >= 3) {
      hypotheses.push({
        hypothesis: `${talentName} buff uptime is only ${buffUptime}% but it modifies ${targets.length} abilities — maintaining it better could amplify multiple damage sources`,
        category: "buff_uptime_gap",
        confidence: "high",
        affectedAbilities: [
          talentName,
          ...targets.map((t) => t.name).slice(0, 4),
        ],
        scenario: scenario.scenario,
        suggestedTest: `Prioritize ${talentName} refresh higher in APL when uptime drops below threshold`,
      });
    }
  }

  // Special case: Soul Furnace
  const soulFurnace = scenario.buffUptimes?.soul_furnace;
  if (soulFurnace !== undefined && soulFurnace < 20) {
    hypotheses.push({
      hypothesis: `Soul Furnace damage amp uptime is only ${soulFurnace}% — Spirit Bomb/Soul Cleave may not be aligning with 10-stack windows`,
      category: "cooldown_alignment",
      confidence: "high",
      affectedAbilities: ["soul_furnace", "spirit_bomb", "soul_cleave"],
      scenario: scenario.scenario,
      suggestedTest:
        "Try: spirit_bomb,if=soul_fragments>=4&(buff.soul_furnace.stack>=8|!talent.soul_furnace)",
    });
  }

  // Demon Spikes uptime
  const demonSpikes = scenario.buffUptimes?.demon_spikes;
  if (demonSpikes !== undefined && demonSpikes < 50) {
    hypotheses.push({
      hypothesis: `Demon Spikes uptime is ${demonSpikes}% — below 50% threshold for tank survivability`,
      category: "defensive_uptime",
      confidence: "high",
      affectedAbilities: ["demon_spikes"],
      scenario: scenario.scenario,
      suggestedTest:
        "Increase Demon Spikes priority or relax conditions for casting it",
    });
  }

  return hypotheses;
}

// Talents that amplify each other but aren't aligned in usage.
function analyzeCooldownAlignment(scenario, interactions) {
  const hypotheses = [];

  // Check Fiery Brand + Fiery Demise interaction
  const fieryBrand = scenario.buffUptimes?.fiery_brand;
  const majorAbilities = scenario.majorDamage || [];
  const fieryDemiseContrib = majorAbilities.find(
    (a) =>
      a.name.toLowerCase().includes("fiery") &&
      a.name.toLowerCase().includes("demise"),
  );

  if (fieryBrand !== undefined && fieryBrand < 30 && fieryDemiseContrib) {
    hypotheses.push({
      hypothesis: `Fiery Brand uptime is ${fieryBrand}% but Fiery Demise is a damage source — extending Fiery Brand uptime could amplify overall damage`,
      category: "cooldown_alignment",
      confidence: "medium",
      affectedAbilities: ["fiery_brand", "fiery_demise"],
      scenario: scenario.scenario,
      suggestedTest:
        "Ensure Fiery Brand is used on cooldown and spread via Burning Alive talent",
    });
  }

  // Check Metamorphosis alignment with big cooldowns
  const meta = scenario.buffUptimes?.metamorphosis;
  if (meta !== undefined && meta > 20 && meta < 50) {
    hypotheses.push({
      hypothesis: `Metamorphosis uptime is ${meta}% — ensure high-value abilities (Fel Devastation, Soul Carver) are used during Meta windows`,
      category: "cooldown_alignment",
      confidence: "low",
      affectedAbilities: ["metamorphosis", "fel_devastation", "soul_carver"],
      scenario: scenario.scenario,
      suggestedTest:
        "Add buff.metamorphosis.up preference to Fel Devastation/Soul Carver conditions",
    });
  }

  return hypotheses;
}

// Actions with very narrow conditions that rarely fire.
function analyzeConditionalTightness(scenario) {
  const hypotheses = [];

  // Low GCD efficiency suggests possible dead time
  if (scenario.gcdEfficiency < 85) {
    hypotheses.push({
      hypothesis: `GCD efficiency is ${scenario.gcdEfficiency}% in ${scenario.scenarioName} — there may be dead GCDs from resource starvation or overly tight conditions`,
      category: "conditional_tightness",
      confidence: "medium",
      affectedAbilities: [],
      scenario: scenario.scenario,
      suggestedTest:
        "Review conditions on filler abilities — ensure there's always something to cast",
    });
  }

  return hypotheses;
}

// Abilities that scale with targets but may be gated behind ST conditions.
function analyzeAoeMismatch(scenario, workflowResults) {
  const hypotheses = [];
  const cross = workflowResults.crossAnalysis;

  if (!cross?.aoeScaling || scenario.scenario === "st") return hypotheses;

  for (const scaling of cross.aoeScaling) {
    if (scaling.delta > 10) {
      hypotheses.push({
        hypothesis: `${scaling.name} goes from ${scaling.stFraction}% to ${scaling.aoeFraction}% DPS share in AoE — verify it's not gated behind single-target conditions`,
        category: "aoe_mismatch",
        confidence: "medium",
        affectedAbilities: [scaling.name],
        scenario: scenario.scenario,
        suggestedTest: `Check if ${scaling.name} has unnecessary spell_targets restrictions in AoE list`,
      });
    }
  }

  return hypotheses;
}

// Print hypotheses as readable output.
export function printHypotheses(hypotheses) {
  if (hypotheses.length === 0) {
    console.log("No improvement hypotheses generated.");
    return;
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`APL Improvement Hypotheses (${hypotheses.length} total)`);
  console.log("=".repeat(70));

  const byCategory = {};
  for (const h of hypotheses) {
    (byCategory[h.category] ||= []).push(h);
  }

  for (const [category, items] of Object.entries(byCategory)) {
    console.log(`\n--- ${category.replace(/_/g, " ").toUpperCase()} ---`);
    for (const h of items) {
      const conf = `[${h.confidence}]`.padEnd(10);
      console.log(`\n  ${conf} ${h.hypothesis}`);
      if (h.suggestedTest) {
        console.log(`  Test: ${h.suggestedTest}`);
      }
      if (h.affectedAbilities.length > 0) {
        console.log(`  Abilities: ${h.affectedAbilities.join(", ")}`);
      }
    }
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const resultsPath = process.argv[2];

  if (!resultsPath) {
    console.log("Usage: node src/analyze/reasoning.js <workflow-results.json>");
    console.log(
      "\nGenerates improvement hypotheses from simulation workflow output.",
    );
    process.exit(1);
  }

  const workflowResults = JSON.parse(readFileSync(resultsPath, "utf-8"));
  const hypotheses = generateHypotheses(workflowResults);

  printHypotheses(hypotheses);

  // Also output as JSON
  console.log("\n" + JSON.stringify(hypotheses, null, 2));
}
