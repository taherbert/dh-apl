// Strategic hypothesis generator — archetype-aware hypothesis generation.
// Replaces shallow metric-based reasoning with strategic analysis informed by build context.
// Usage: node src/analyze/strategic-hypotheses.js <workflow-results.json>

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectArchetype,
  describeArchetype,
  getStrategicBuffs,
  getCoreAbilities,
} from "./archetypes.js";
import { parse, getActionLists, findAction } from "../apl/parser.js";
import {
  parseCondition,
  extractSemantics,
  findBuffReferences,
} from "../apl/condition-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// Strategic hypothesis categories
const STRATEGIC_CATEGORIES = {
  WINDOW_EFFICIENCY: "Maximize damage during key buff windows",
  RESOURCE_ALIGNMENT: "Ensure resources available when windows open",
  COOLDOWN_SYNC: "Align cooldowns for multiplicative stacking",
  FILLER_OPTIMIZATION: "Minimize loss during non-window periods",
  CONDITION_RELAXATION: "Relax overly restrictive conditions",
  PRIORITY_REORDER: "Adjust action priority for better sequencing",
};

// Mutation operation types
export const MUTATION_OPS = {
  ADD_CONDITION: "add_condition",
  REMOVE_CONDITION: "remove_condition",
  RELAX_THRESHOLD: "relax_threshold",
  TIGHTEN_THRESHOLD: "tighten_threshold",
  MOVE_UP: "move_up",
  MOVE_DOWN: "move_down",
};

export function generateStrategicHypotheses(workflowResults, aplText = null) {
  const hypotheses = [];
  let archetypeContext = null;
  let aplAst = null;
  let heroTree = null;

  if (aplText) {
    // 1. Check profile name (most reliable - explicit in APL header)
    heroTree = detectHeroTreeFromProfileName(aplText);

    // 2. Check APL structure (ar/anni action lists)
    aplAst = parse(aplText);
    if (!heroTree) {
      heroTree = detectHeroTreeFromApl(aplAst);
    }
  }

  // 3. Last resort: infer from buff uptimes (requires sim data)
  if (!heroTree) {
    heroTree = detectHeroTreeFromBuffs(workflowResults);
  }

  if (heroTree) {
    const matches = detectArchetype(null, heroTree);
    if (matches.length > 0) {
      archetypeContext = describeArchetype(matches[0].id);
    }
  }

  for (const scenario of normalizeScenarios(workflowResults)) {
    if (scenario.error) continue;

    hypotheses.push(
      ...generateWindowHypotheses(scenario, archetypeContext, aplAst),
      ...generateBuffUptimeHypotheses(scenario, archetypeContext, aplAst),
      ...generateCooldownHypotheses(scenario, archetypeContext, aplAst),
    );

    if (aplAst) {
      hypotheses.push(
        ...generateConditionHypotheses(scenario, archetypeContext, aplAst),
      );
    }
  }

  const seen = new Set();
  const unique = hypotheses.filter((h) => {
    const key = normalizeHypothesis(h);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return unique;
}

function getBuffUptime(scenario, buffName) {
  // Handle both formats: buffUptimes object or buffs array
  if (scenario.buffUptimes && scenario.buffUptimes[buffName] !== undefined) {
    return scenario.buffUptimes[buffName];
  }
  if (scenario.buffs) {
    const buff = scenario.buffs.find((b) => b.name === buffName);
    return buff?.uptime;
  }
  return undefined;
}

function detectHeroTreeFromProfileName(aplText) {
  // Look for profile name like: demonhunter="VDH_Midnight_Aldrachi_Reaver"
  const profileMatch = aplText.match(/demonhunter\s*=\s*"([^"]+)"/i);
  if (profileMatch) {
    const name = profileMatch[1].toLowerCase();
    if (name.includes("aldrachi") || name.includes("reaver")) {
      return "aldrachi_reaver";
    }
    if (name.includes("annihilator") || name.includes("anni")) {
      return "annihilator";
    }
  }
  return null;
}

function normalizeScenarios(workflowResults) {
  // Handle array format (summary JSON) or object with scenarios property
  if (Array.isArray(workflowResults)) {
    return workflowResults;
  }
  return workflowResults.scenarios || [];
}

function detectHeroTreeFromBuffs(workflowResults) {
  // AR-specific buffs: rending_strike, glaive_flurry, art_of_the_glaive
  // Anni-specific buffs: voidfall_building, voidfall_spending
  const arBuffs = ["rending_strike", "glaive_flurry", "art_of_the_glaive"];
  const anniBuffs = ["voidfall_building", "voidfall_spending"];

  for (const scenario of normalizeScenarios(workflowResults)) {
    if (scenario.error) continue;

    const hasArBuff = arBuffs.some((b) => {
      const uptime = getBuffUptime(scenario, b);
      return uptime !== undefined && uptime > 0;
    });
    const hasAnniBuff = anniBuffs.some((b) => {
      const uptime = getBuffUptime(scenario, b);
      return uptime !== undefined && uptime > 0;
    });

    if (hasArBuff && !hasAnniBuff) return "aldrachi_reaver";
    if (hasAnniBuff && !hasArBuff) return "annihilator";
  }

  return null;
}

function detectHeroTreeFromApl(aplAst) {
  const lists = getActionLists(aplAst);

  // Check which hero-specific action lists exist and have content
  const arList = lists.find((l) => l.name === "ar");
  const anniList = lists.find((l) => l.name === "anni");

  const hasArContent = arList && arList.entries.length > 0;
  const hasAnniContent = anniList && anniList.entries.length > 0;

  // If only one has content, use that
  if (hasArContent && !hasAnniContent) return "aldrachi_reaver";
  if (hasAnniContent && !hasArContent) return "annihilator";

  // Both have content: check the default list for hero_tree conditions
  // to see which is conditionally called (both may exist for completeness)
  const defaultList = lists.find((l) => l.name === "default");
  if (defaultList) {
    for (const entry of defaultList.entries) {
      if (entry.type === "RunActionList") {
        const condition = entry.modifiers?.get("if") || "";
        const targetList = entry.modifiers?.get("name");

        // Match the condition to the list being called
        if (
          targetList === "ar" &&
          condition.includes("hero_tree.aldrachi_reaver")
        ) {
          return "aldrachi_reaver";
        }
        if (
          targetList === "anni" &&
          condition.includes("hero_tree.annihilator")
        ) {
          return "annihilator";
        }
      }
    }
  }

  // Fallback: prefer ar as it's more common
  if (hasArContent) return "aldrachi_reaver";
  if (hasAnniContent) return "annihilator";
  return null;
}

function normalizeHypothesis(h) {
  return `${h.category}:${h.target || ""}:${h.metric || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9:]/g, "");
}

function generateWindowHypotheses(scenario, archetype, aplAst) {
  if (!archetype) return [];

  const hypotheses = [];
  for (const buff of archetype.keyBuffs || []) {
    const uptime = getBuffUptime(scenario, buff);
    if (uptime === undefined || uptime >= 30) continue;

    hypotheses.push({
      category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
      archetype: archetype.id,
      archetypeContext: archetype.description,
      strategicGoal: `Maximize ${buff} window uptime for ${archetype.coreLoop}`,
      observation: `${buff} uptime is ${uptime}% in ${scenario.scenarioName}`,
      metric: uptime,
      target: buff,
      hypothesis: `Improve ${buff} uptime to increase damage during buff windows`,
      scenario: scenario.scenario,
      priority: (30 - uptime) * 1.5,
      confidence: "high",
      aplMutation: generateBuffUptimeMutation(buff, aplAst),
    });
  }

  return hypotheses;
}

function generateBuffUptimeHypotheses(scenario, archetype, aplAst) {
  const hypotheses = [];
  const rendingStrike = getBuffUptime(scenario, "rending_strike");
  const glaiveFlurry = getBuffUptime(scenario, "glaive_flurry");

  if (rendingStrike !== undefined && rendingStrike < 15) {
    hypotheses.push({
      category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
      archetype: archetype?.id,
      archetypeContext: archetype
        ? `For ${archetype.id}, Rending Strike enables the empowered Soul Cleave/Fracture window. Low uptime means missing damage amplification.`
        : "Rending Strike enables empowered abilities during the AR window.",
      strategicGoal: "Improve Rending Strike window availability",
      observation: `rending_strike uptime only ${rendingStrike}% in ${scenario.scenarioName}`,
      metric: rendingStrike,
      target: "rending_strike",
      hypothesis: `Relax conditions on Reaver's Glaive to cast it more frequently`,
      scenario: scenario.scenario,
      priority: (15 - rendingStrike) * 2,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.REMOVE_CONDITION,
        list: "ar",
        ability: "reavers_glaive",
        targetBuff: "glaive_flurry",
        reason:
          "Allow Reaver's Glaive even during Glaive Flurry to improve Rending Strike uptime",
      },
    });
  }

  if (
    glaiveFlurry !== undefined &&
    glaiveFlurry < 20 &&
    rendingStrike !== undefined
  ) {
    hypotheses.push({
      category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
      archetype: archetype?.id,
      archetypeContext:
        "Glaive Flurry follows Rending Strike in the AR chain. If both are low, the rotation may be breaking.",
      strategicGoal: "Complete the full AR buff chain",
      observation: `glaive_flurry uptime only ${glaiveFlurry}% (rending_strike: ${rendingStrike}%) in ${scenario.scenarioName}`,
      metric: glaiveFlurry,
      target: "glaive_flurry",
      hypothesis: `Ensure Soul Cleave is prioritized during Rending Strike windows to proc Glaive Flurry`,
      scenario: scenario.scenario,
      priority: (20 - glaiveFlurry) * 1.5,
      confidence: "medium",
      aplMutation: {
        type: MUTATION_OPS.MOVE_UP,
        list: "ar",
        ability: "soul_cleave",
        condition: "buff.rending_strike.up",
        reason:
          "Prioritize Soul Cleave during Rending Strike to maintain Glaive Flurry",
      },
    });
  }

  const soulFurnace = getBuffUptime(scenario, "soul_furnace");
  if (soulFurnace !== undefined && soulFurnace < 20) {
    hypotheses.push({
      category: STRATEGIC_CATEGORIES.RESOURCE_ALIGNMENT,
      archetype: archetype?.id,
      archetypeContext:
        "Soul Furnace stacks to 10, then amplifies the next Spirit Bomb. Low uptime means spending fragments before reaching the threshold.",
      strategicGoal: "Align Spirit Bomb with Soul Furnace windows",
      observation: `Soul Furnace uptime only ${soulFurnace}% in ${scenario.scenarioName}`,
      metric: soulFurnace,
      target: "soul_furnace",
      hypothesis: `Add Soul Furnace threshold condition to Spirit Bomb`,
      scenario: scenario.scenario,
      priority: (20 - soulFurnace) * 1.2,
      confidence: "medium",
      aplMutation: {
        type: MUTATION_OPS.ADD_CONDITION,
        list: "ar",
        ability: "spirit_bomb",
        condition: "buff.soul_furnace.stack>=8|!talent.soul_furnace",
        reason: "Pool fragments until Soul Furnace reaches threshold",
      },
    });
  }

  return hypotheses;
}

function generateCooldownHypotheses(scenario, archetype, aplAst) {
  const metaUptime = getBuffUptime(scenario, "metamorphosis");
  if (metaUptime === undefined || metaUptime <= 15 || metaUptime >= 40) {
    return [];
  }

  const felDev = scenario.majorDamage?.find(
    (a) =>
      a.name.toLowerCase().includes("fel") &&
      a.name.toLowerCase().includes("devastation"),
  );

  if (!felDev || felDev.fraction <= 5) return [];

  return [
    {
      category: STRATEGIC_CATEGORIES.COOLDOWN_SYNC,
      archetype: archetype?.id,
      archetypeContext:
        "Metamorphosis grants +20% damage. High-value abilities should be used during Meta windows when possible.",
      strategicGoal: "Align Fel Devastation with Metamorphosis",
      observation: `Metamorphosis uptime is ${metaUptime}%, Fel Devastation is ${felDev.fraction}% of damage`,
      metric: metaUptime,
      target: "fel_devastation",
      hypothesis: `Prefer Fel Devastation during Metamorphosis windows`,
      scenario: scenario.scenario,
      priority: felDev.fraction * 0.5,
      confidence: "low",
      aplMutation: {
        type: MUTATION_OPS.ADD_CONDITION,
        list: "ar",
        ability: "fel_devastation",
        condition: "buff.metamorphosis.up",
        operator: "|",
        reason: "Prefer Fel Devastation during Meta for damage amp",
      },
    },
  ];
}

function generateConditionHypotheses(scenario, archetype, aplAst) {
  const targetListName = archetype?.aplFocus?.[0] || "ar";
  const list = getActionLists(aplAst).find((l) => l.name === targetListName);
  if (!list) return [];

  const hypotheses = [];
  for (const entry of list.entries) {
    if (entry.type !== "Action") continue;

    const condition = entry.modifiers?.get("if");
    if (!condition) continue;

    const ast = parseCondition(condition);
    const semantics = extractSemantics(ast);
    const buffCount = semantics.buffRequirements.length;
    const negatedBuffs = semantics.buffRequirements.filter((b) => b.negate);

    if (buffCount >= 2 && negatedBuffs.length >= 1) {
      hypotheses.push({
        category: STRATEGIC_CATEGORIES.CONDITION_RELAXATION,
        archetype: archetype?.id,
        archetypeContext: `Complex conditions on ${entry.ability} may prevent it from firing when useful.`,
        strategicGoal: `Evaluate ${entry.ability} condition complexity`,
        observation: `${entry.ability} has ${buffCount} buff checks (${negatedBuffs.length} negated)`,
        metric: buffCount,
        target: entry.ability,
        hypothesis: `Try removing one negated buff check from ${entry.ability}`,
        scenario: scenario.scenario,
        priority: buffCount * 0.8,
        confidence: "low",
        aplMutation: {
          type: MUTATION_OPS.REMOVE_CONDITION,
          list: targetListName,
          ability: entry.ability,
          targetBuff: negatedBuffs[0]?.buff,
          removeNegation: true,
          reason: `Remove !buff.${negatedBuffs[0]?.buff}.up check to allow more casts`,
        },
      });
    }
  }

  return hypotheses;
}

function generateBuffUptimeMutation(buff, aplAst) {
  if (!aplAst) {
    return {
      type: MUTATION_OPS.REMOVE_CONDITION,
      list: "ar",
      ability: "unknown",
      targetBuff: buff,
      reason: `Remove blocking conditions to improve ${buff} uptime`,
    };
  }

  for (const list of getActionLists(aplAst)) {
    for (const entry of list.entries) {
      if (entry.type !== "Action") continue;

      const condition = entry.modifiers?.get("if");
      if (!condition || !findBuffReferences(condition).includes(buff)) continue;

      const semantics = extractSemantics(parseCondition(condition));
      const negated = semantics.buffRequirements.find(
        (b) => b.buff === buff && b.negate,
      );

      if (negated) {
        return {
          type: MUTATION_OPS.REMOVE_CONDITION,
          list: list.name,
          ability: entry.ability,
          targetBuff: buff,
          reason: `Remove !buff.${buff}.up check to allow refreshing the buff`,
        };
      }
    }
  }

  return {
    type: MUTATION_OPS.MOVE_UP,
    list: "ar",
    ability: `ability_granting_${buff}`,
    reason: `Prioritize ability that grants ${buff}`,
  };
}

export function loadApl(aplPath) {
  return readFileSync(aplPath, "utf-8");
}

export function printHypotheses(hypotheses) {
  if (hypotheses.length === 0) {
    console.log("No strategic hypotheses generated.");
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Strategic Hypotheses (${hypotheses.length} total)`);
  console.log("=".repeat(70));

  for (const h of hypotheses.slice(0, 15)) {
    console.log(`\n[${h.confidence || "medium"}] ${h.strategicGoal}`);
    console.log(`  Category: ${h.category}`);
    console.log(`  Observation: ${h.observation}`);
    console.log(`  Hypothesis: ${h.hypothesis}`);
    if (h.archetypeContext) {
      console.log(`  Context: ${h.archetypeContext.slice(0, 100)}...`);
    }
    if (h.aplMutation) {
      console.log(
        `  Mutation: ${h.aplMutation.type} on ${h.aplMutation.ability || h.aplMutation.list}`,
      );
      console.log(`    Reason: ${h.aplMutation.reason}`);
    }
    console.log(`  Priority: ${(h.priority || 0).toFixed(1)}`);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const resultsPath = process.argv[2];
  const aplPath = process.argv[3];

  if (!resultsPath) {
    console.log(
      "Usage: node src/analyze/strategic-hypotheses.js <workflow-results.json> [apl-file.simc]",
    );
    process.exit(1);
  }

  const workflowResults = JSON.parse(readFileSync(resultsPath, "utf-8"));
  const aplText = aplPath ? loadApl(aplPath) : null;

  const hypotheses = generateStrategicHypotheses(workflowResults, aplText);
  printHypotheses(hypotheses);

  console.log("\n--- JSON Output ---");
  console.log(JSON.stringify(hypotheses.slice(0, 5), null, 2));
}
