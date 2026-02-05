// Strategic hypothesis generator — archetype-aware hypothesis generation.
// Replaces shallow metric-based reasoning with strategic analysis informed by build context.
// Usage: node src/analyze/strategic-hypotheses.js <workflow-results.json>

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectArchetype, describeArchetype } from "./archetypes.js";
import { parse, getActionLists } from "../apl/parser.js";
import {
  parseCondition,
  extractSemantics,
  findBuffReferences,
} from "../apl/condition-parser.js";
import { MUTATION_OPS } from "../apl/mutator.js";
import {
  getHeroTrees,
  detectHeroTreeFromProfileName as detectFromProfile,
  detectHeroTreeFromBuffs as detectFromBuffs,
} from "../spec/vengeance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// --- Spec Configuration ---
let currentSpecId = "vengeance";

export function setSpecId(specId) {
  currentSpecId = specId;
}

// Strategic hypothesis categories
const STRATEGIC_CATEGORIES = {
  WINDOW_EFFICIENCY: "Maximize damage during key buff windows",
  RESOURCE_ALIGNMENT: "Ensure resources available when windows open",
  COOLDOWN_SYNC: "Align cooldowns for multiplicative stacking",
  FILLER_OPTIMIZATION: "Minimize loss during non-window periods",
  CONDITION_RELAXATION: "Relax overly restrictive conditions",
  PRIORITY_REORDER: "Adjust action priority for better sequencing",
};

// Re-export for backwards compatibility
export { MUTATION_OPS };

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
  // Use config-based detection which checks profile keywords
  const result = detectFromProfile(aplText, currentSpecId);
  if (result) return result;

  // Fallback: Look for profile name like: demonhunter="VDH_Midnight_Aldrachi_Reaver"
  const profileMatch = aplText.match(/demonhunter\s*=\s*"([^"]+)"/i);
  if (profileMatch) {
    const trees = getHeroTrees(currentSpecId);
    const name = profileMatch[1].toLowerCase();
    for (const [treeId, treeConfig] of Object.entries(trees)) {
      if (treeConfig.profileKeywords?.some((kw) => name.includes(kw))) {
        return treeId;
      }
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

function getCastCount(scenario, abilityName) {
  if (!scenario) return 0;
  for (const a of [
    ...(scenario.majorDamage || []),
    ...(scenario.lowContrib || []),
  ]) {
    if (normalizeAbilityName(a.name) === abilityName) return a.casts || 0;
  }
  return 0;
}

function normalizeAbilityName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
}

function detectHeroTreeFromBuffs(workflowResults) {
  // Use config-based detection first
  const result = detectFromBuffs(workflowResults, currentSpecId);
  if (result) return result;

  // Fallback: manual detection using config-defined buffs
  const trees = getHeroTrees(currentSpecId);
  const hasAnyBuff = (scenario, buffs) =>
    buffs.some((b) => getBuffUptime(scenario, b) > 0);

  for (const scenario of normalizeScenarios(workflowResults)) {
    if (scenario.error) continue;

    const treeMatches = [];
    for (const [treeId, treeConfig] of Object.entries(trees)) {
      if (hasAnyBuff(scenario, treeConfig.keyBuffs || [])) {
        treeMatches.push(treeId);
      }
    }

    // Return if exactly one tree matches
    if (treeMatches.length === 1) return treeMatches[0];
  }

  return null;
}

function detectHeroTreeFromApl(aplAst) {
  const lists = getActionLists(aplAst);
  const arList = lists.find((l) => l.name === "ar");
  const anniList = lists.find((l) => l.name === "anni");
  const hasArContent = arList?.entries.length > 0;
  const hasAnniContent = anniList?.entries.length > 0;

  if (hasArContent && !hasAnniContent) return "aldrachi_reaver";
  if (hasAnniContent && !hasArContent) return "annihilator";

  // Both have content: check default list for hero_tree conditions
  const defaultList = lists.find((l) => l.name === "default");
  for (const entry of defaultList?.entries || []) {
    if (entry.type !== "RunActionList") continue;

    const condition = entry.modifiers?.get("if") || "";
    const targetList = entry.modifiers?.get("name");

    if (
      targetList === "ar" &&
      condition.includes("hero_tree.aldrachi_reaver")
    ) {
      return "aldrachi_reaver";
    }
    if (targetList === "anni" && condition.includes("hero_tree.annihilator")) {
      return "annihilator";
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
  const reaversMark = getBuffUptime(scenario, "reavers_mark");

  // AR buff chain sequencing — critical for DPS
  if (
    archetype?.heroTree === "aldrachi_reaver" &&
    rendingStrike !== undefined &&
    glaiveFlurry !== undefined
  ) {
    // If Rending Strike is up but Glaive Flurry is much lower, sequence is broken
    if (rendingStrike > 5 && glaiveFlurry < rendingStrike * 0.5) {
      hypotheses.push({
        category: STRATEGIC_CATEGORIES.PRIORITY_REORDER,
        archetype: archetype?.id,
        archetypeContext:
          "After Reaver's Glaive, the correct sequence is ALWAYS Fracture (empowered) → Soul Cleave (empowered). Fracture deals +10% damage and applies Reaver's Mark. Soul Cleave deals +20% damage and triggers Aldrachi Tactics for faster regen. Breaking this sequence loses significant DPS.",
        strategicGoal:
          "Enforce Fracture→Soul Cleave sequence after Reaver's Glaive",
        observation: `Rending Strike ${rendingStrike}% but Glaive Flurry only ${glaiveFlurry}% — sequence may be broken`,
        metric: glaiveFlurry,
        target: "soul_cleave",
        hypothesis: `Ensure Soul Cleave follows Fracture during Rending Strike window`,
        scenario: scenario.scenario,
        priority: (rendingStrike - glaiveFlurry) * 2,
        confidence: "high",
        aplMutation: {
          type: MUTATION_OPS.MOVE_UP,
          list: "ar",
          ability: "soul_cleave",
          condition: "buff.rending_strike.up&!buff.glaive_flurry.up",
          reason:
            "Force Soul Cleave after empowered Fracture to complete the AR chain",
        },
      });
    }
  }

  // Reaver's Mark uptime — indicates Fracture is landing during Rending Strike
  if (reaversMark !== undefined && reaversMark < 10 && rendingStrike > 5) {
    hypotheses.push({
      category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
      archetype: archetype?.id,
      archetypeContext:
        "Reaver's Mark is applied when Fracture hits during Rending Strike. Low uptime means Fracture isn't being used during the window.",
      strategicGoal: "Ensure Fracture lands during Rending Strike",
      observation: `Reaver's Mark uptime only ${reaversMark}% (Rending Strike: ${rendingStrike}%)`,
      metric: reaversMark,
      target: "fracture",
      hypothesis: `Prioritize Fracture immediately after Reaver's Glaive`,
      scenario: scenario.scenario,
      priority: (10 - reaversMark) * 1.5,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.MOVE_UP,
        list: "ar",
        ability: "fracture",
        condition: "buff.rending_strike.up&!debuff.reavers_mark.up",
        reason:
          "Cast Fracture first during Rending Strike to apply Reaver's Mark",
      },
    });
  }

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
  const hypotheses = [];

  // Fiery Brand synergy — align Fire damage abilities during Fiery Brand window
  const fieryBrandUptime = getBuffUptime(scenario, "fiery_brand");
  if (fieryBrandUptime !== undefined && fieryBrandUptime > 10) {
    const felDev = scenario.majorDamage?.find(
      (a) =>
        a.name.toLowerCase().includes("fel") &&
        a.name.toLowerCase().includes("devastation"),
    );

    if (felDev && felDev.fraction > 3) {
      hypotheses.push({
        category: STRATEGIC_CATEGORIES.COOLDOWN_SYNC,
        archetype: archetype?.id,
        archetypeContext:
          "Fiery Brand provides 15% Fire damage amp via Fiery Demise. Fel Devastation deals Fire damage and should be synced with Fiery Brand windows.",
        strategicGoal: "Align Fel Devastation with Fiery Brand",
        observation: `Fiery Brand uptime is ${fieryBrandUptime}%, Fel Devastation is ${felDev.fraction}% of damage`,
        metric: fieryBrandUptime,
        target: "fel_devastation",
        hypothesis: `Sync Fel Devastation with Fiery Brand for 15% Fire damage amp`,
        scenario: scenario.scenario,
        priority: felDev.fraction * 0.8,
        confidence: "high",
        aplMutation: {
          type: MUTATION_OPS.ADD_CONDITION,
          list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          ability: "fel_devastation",
          condition: "dot.fiery_brand.ticking",
          operator: "&",
          allowFallback: true,
          reason:
            "Prefer Fel Devastation during Fiery Brand for Fiery Demise amp",
        },
      });
    }

    // Soul Carver + Fiery Brand synergy
    const soulCarver = scenario.majorDamage?.find((a) =>
      a.name.toLowerCase().includes("soul_carver"),
    );
    if (soulCarver && soulCarver.fraction > 2) {
      hypotheses.push({
        category: STRATEGIC_CATEGORIES.COOLDOWN_SYNC,
        archetype: archetype?.id,
        archetypeContext:
          "Soul Carver benefits from Fiery Demise. Use with 3+ seconds of Fiery Brand remaining.",
        strategicGoal: "Align Soul Carver with Fiery Brand",
        observation: `Soul Carver is ${soulCarver.fraction}% of damage`,
        metric: soulCarver.fraction,
        target: "soul_carver",
        hypothesis: `Sync Soul Carver with Fiery Brand (3+ sec remaining)`,
        scenario: scenario.scenario,
        priority: soulCarver.fraction * 0.6,
        confidence: "medium",
        aplMutation: {
          type: MUTATION_OPS.ADD_CONDITION,
          list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          ability: "soul_carver",
          condition: "dot.fiery_brand.remains>3",
          operator: "&",
          allowFallback: true,
          reason: "Use Soul Carver with 3+ sec Fiery Brand for Fiery Demise",
        },
      });
    }
  }

  // Metamorphosis synergy (general)
  const metaUptime = getBuffUptime(scenario, "metamorphosis");
  if (metaUptime !== undefined && metaUptime > 15 && metaUptime < 40) {
    const felDev = scenario.majorDamage?.find(
      (a) =>
        a.name.toLowerCase().includes("fel") &&
        a.name.toLowerCase().includes("devastation"),
    );

    if (felDev && felDev.fraction > 5) {
      hypotheses.push({
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
          list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          ability: "fel_devastation",
          condition: "buff.metamorphosis.up",
          operator: "|",
          reason: "Prefer Fel Devastation during Meta for damage amp",
        },
      });
    }
  }

  // Annihilator-specific: Voidfall + Spirit Bomb + Meta cycling
  if (archetype?.heroTree === "annihilator") {
    hypotheses.push(...generateAnnihilatorHypotheses(scenario, archetype));
  }

  return hypotheses;
}

function generateAnnihilatorHypotheses(scenario, archetype) {
  const hypotheses = [];

  // Voidfall stack management - SimC uses voidfall_building and voidfall_spending buffs
  const voidfallBuilding = getBuffUptime(scenario, "voidfall_building");
  const voidfallSpending = getBuffUptime(scenario, "voidfall_spending");
  const hasVoidfallData =
    voidfallBuilding !== undefined || voidfallSpending !== undefined;

  if (hasVoidfallData) {
    hypotheses.push({
      category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
      archetype: archetype?.id,
      archetypeContext:
        "Voidfall stacks to 3 from Fracture (35% chance) and Metamorphosis. At 3 stacks, Soul Cleave or Spirit Bomb triggers fel meteors.",
      strategicGoal: "Optimize Voidfall stack spending",
      observation: `Voidfall tracking active in ${scenario.scenarioName}`,
      metric: voidfallSpending ?? voidfallBuilding,
      target: "voidfall",
      hypothesis: `Ensure Spirit Bomb/Soul Cleave fire at 3 Voidfall stacks`,
      scenario: scenario.scenario,
      priority: 8,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.ADD_CONDITION,
        list: "anni",
        ability: "spirit_bomb",
        condition: "buff.voidfall_spending.stack=3",
        operator: "&",
        reason: "Trigger Spirit Bomb at max Voidfall stacks for meteor burst",
      },
    });

    // Spend Voidfall before Meta
    hypotheses.push({
      category: STRATEGIC_CATEGORIES.RESOURCE_ALIGNMENT,
      archetype: archetype?.id,
      archetypeContext:
        "Metamorphosis grants up to 3 Voidfall stacks. Spending stacks before Meta avoids overcapping and wastes no value.",
      strategicGoal: "Spend Voidfall before Metamorphosis",
      observation: `Voidfall stack management in ${scenario.scenarioName}`,
      metric: voidfallSpending ?? voidfallBuilding,
      target: "metamorphosis",
      hypothesis: `Add condition to spend Voidfall before using Meta`,
      scenario: scenario.scenario,
      priority: 7,
      confidence: "medium",
      aplMutation: {
        type: MUTATION_OPS.ADD_CONDITION,
        list: "anni",
        ability: "metamorphosis",
        condition: "buff.voidfall_spending.stack<2",
        operator: "&",
        reason: "Avoid Meta when Voidfall is high to prevent overcapping",
      },
    });
  }

  // Spirit Bomb threshold during Meta (3+ frags, not 4+)
  const metaUptime = getBuffUptime(scenario, "metamorphosis");
  if (metaUptime !== undefined && metaUptime > 10) {
    hypotheses.push({
      category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
      archetype: archetype?.id,
      archetypeContext:
        "During Metamorphosis, Fracture generates 3 Soul Fragments instead of 2. Spirit Bomb threshold should be lowered to 3+ fragments during Meta.",
      strategicGoal: "Lower Spirit Bomb threshold during Metamorphosis",
      observation: `Metamorphosis uptime is ${metaUptime}%`,
      metric: metaUptime,
      target: "spirit_bomb",
      hypothesis: `Use Spirit Bomb at 3+ fragments during Meta (not 4+)`,
      scenario: scenario.scenario,
      priority: 6,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.RELAX_THRESHOLD,
        list: "anni",
        ability: "spirit_bomb",
        condition: "soul_fragments>=3",
        metaCondition: "buff.metamorphosis.up",
        reason: "Fracture generates 3 fragments during Meta — lower threshold",
      },
    });
  }

  return hypotheses;
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

// --- Deep Hypothesis Generation ---
// Generates compound, mechanism-backed hypotheses with full structure

// Deep hypothesis categories extend strategic categories with more specificity
const DEEP_HYPOTHESIS_CATEGORIES = {
  ...STRATEGIC_CATEGORIES,
  META_WINDOW_OPTIMIZATION:
    "Optimize ability usage during Metamorphosis windows",
  FRAGMENT_ECONOMY_RESTRUCTURE:
    "Restructure fragment generation/consumption patterns",
  FURY_POOLING: "Pool fury for upcoming burst windows",
  PHASE_EXTRACTION: "Extract phase-specific logic into sub-lists",
  STATE_MACHINE_ALIGNMENT: "Align APL with hero tree state machine transitions",
  MULTI_PART_CHANGE: "Compound hypothesis requiring multiple APL mutations",
};

export function generateDeepHypotheses(workflowResults, aplText, buildTheory) {
  const hypotheses = [];
  const archetype = detectArchetypeFromContext(workflowResults, aplText);

  // Generate hypotheses from each specialized analyst perspective
  hypotheses.push(
    ...generateFragmentEconomyHypotheses(workflowResults, aplText, archetype),
  );
  hypotheses.push(
    ...generateBurstWindowHypotheses(workflowResults, aplText, archetype),
  );
  hypotheses.push(
    ...generateStateMachineHypotheses(workflowResults, aplText, archetype),
  );
  hypotheses.push(
    ...generateCompoundHypotheses(workflowResults, aplText, archetype),
  );

  // Dedupe and rank
  const seen = new Set();
  const unique = hypotheses.filter((h) => {
    const key = `${h.id || h.hypothesis}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return unique;
}

function detectArchetypeFromContext(workflowResults, aplText) {
  let heroTree = null;
  if (aplText) {
    heroTree = detectHeroTreeFromProfileName(aplText);
    if (!heroTree) {
      const ast = parse(aplText);
      heroTree = detectHeroTreeFromApl(ast);
    }
  }
  if (!heroTree) {
    heroTree = detectHeroTreeFromBuffs(workflowResults);
  }

  if (heroTree) {
    const matches = detectArchetype(null, heroTree);
    if (matches.length > 0) {
      return describeArchetype(matches[0].id);
    }
  }
  return null;
}

function generateFragmentEconomyHypotheses(
  workflowResults,
  aplText,
  archetype,
) {
  const hypotheses = [];
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);
  const aoe = scenarios.find(
    (s) => (s.scenario === "small_aoe" || s.scenario === "big_aoe") && !s.error,
  );

  if (!st) return hypotheses;

  // Fragment overflow analysis
  const fractureCasts = getCastCount(st, "fracture");
  const sbCasts = getCastCount(st, "spirit_bomb");
  const scCasts = getCastCount(st, "soul_cleave");
  const metaUptime = getBuffUptime(st, "metamorphosis") || 0;

  const estimatedFragsGen =
    fractureCasts * 2 + fractureCasts * (metaUptime / 100); // +1 during Meta
  const estimatedFragsConsumed = sbCasts * 4 + scCasts * 2;
  const estimatedOverflow = Math.max(
    0,
    estimatedFragsGen - estimatedFragsConsumed,
  );

  if (estimatedOverflow > fractureCasts * 0.2) {
    hypotheses.push({
      id: "fragment-overflow-mitigation",
      category: DEEP_HYPOTHESIS_CATEGORIES.FRAGMENT_ECONOMY_RESTRUCTURE,
      systemicIssue:
        "Fragment generation exceeds consumption capacity, leading to waste",
      mechanism:
        `Fracture generates ${fractureCasts * 2} base frags + ~${Math.round((fractureCasts * metaUptime) / 100)} Meta bonus = ` +
        `~${Math.round(estimatedFragsGen)} total. SBomb consumes ${sbCasts * 4}, SC consumes ${scCasts * 2}. ` +
        `Estimated ${Math.round(estimatedOverflow)} fragments (~${((estimatedOverflow / estimatedFragsGen) * 100).toFixed(0)}%) wasted.`,
      proposedChanges: [
        {
          type: MUTATION_OPS.INSERT_ACTION,
          list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          ability: "spirit_bomb",
          if: "soul_fragments>=4&cooldown.spirit_bomb.up",
          position: "top",
          description: "Emergency SBomb at 4+ frags when ready",
        },
      ],
      expectedImpact:
        "+0.5-1.5% DPS from converting wasted fragments to Spirit Bomb damage",
      counterArgument:
        "Lower SBomb threshold may fire with suboptimal fragment counts. " +
        "However, 4-frag SBomb still deals 80% of 5-frag damage while preventing 100% frag loss.",
      dependencies: [],
      archetypeSpecific: false,
      priority: Math.min(15, estimatedOverflow * 0.5),
      confidence: estimatedOverflow > 20 ? "high" : "medium",
      scenario: "st",
    });
  }

  // Meta fragment acceleration
  if (metaUptime > 10 && metaUptime < 50) {
    const extraFragsFromMeta = fractureCasts * (metaUptime / 100);
    const aplHasFractureMetaPriority = aplText?.includes(
      "fracture,if=buff.metamorphosis.up",
    );

    if (!aplHasFractureMetaPriority && extraFragsFromMeta > 5) {
      hypotheses.push({
        id: "meta-fracture-priority",
        category: DEEP_HYPOTHESIS_CATEGORIES.META_WINDOW_OPTIMIZATION,
        systemicIssue:
          "Fragment economy shifts during Meta (+1 frag per Fracture) but APL doesn't adapt",
        mechanism:
          `Fracture generates 3 frags during Meta vs 2 normally. At ${metaUptime.toFixed(0)}% Meta uptime, ` +
          `~${Math.round(extraFragsFromMeta)} extra frags are available. Spirit Bomb scales at 0.4 AP/frag, ` +
          `so each Meta-Fracture adds ~0.16 AP to the next SBomb. Over ${fractureCasts} Fractures, ` +
          `this is ~${(extraFragsFromMeta * 0.16).toFixed(1)} AP worth of value.`,
        proposedChanges: [
          {
            type: MUTATION_OPS.INSERT_ACTION,
            list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
            ability: "fracture",
            if: "buff.metamorphosis.up&cooldown.fracture.charges>=1",
            before: "fracture",
            description: "Prioritize Fracture during Meta for extra fragment",
          },
        ],
        expectedImpact: "+3-5% ST DPS from maximizing fragment gen during Meta",
        counterArgument:
          "Fracture charges may not be available. But recharge is 3.75s at 20% haste, " +
          "so 4 charges regenerate during 15s Meta window.",
        dependencies: [],
        archetypeSpecific: false,
        priority: Math.min(20, extraFragsFromMeta * 2),
        confidence: "high",
        scenario: "st",
      });
    }
  }

  return hypotheses;
}

function generateBurstWindowHypotheses(workflowResults, aplText, archetype) {
  const hypotheses = [];
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);

  if (!st) return hypotheses;

  const brandUptime = getBuffUptime(st, "fiery_brand") || 0;
  const metaUptime = getBuffUptime(st, "metamorphosis") || 0;
  const felDevCasts = getCastCount(st, "fel_devastation");
  const soulCarverCasts = getCastCount(st, "soul_carver");
  const fightLength = st.fightLength || 300;

  // Fiery Brand window utilization
  if (brandUptime > 5 && felDevCasts > 0) {
    const brandCasts = Math.floor(fightLength / 60); // ~60s CD
    const felDevPerBrand = felDevCasts / brandCasts;

    // Check if FelDev is aligned with Brand
    const aplHasFelDevBrandSync = aplText?.includes(
      "fel_devastation,if=dot.fiery_brand",
    );

    if (!aplHasFelDevBrandSync && felDevPerBrand < 0.9) {
      hypotheses.push({
        id: "feldev-brand-sync",
        category: DEEP_HYPOTHESIS_CATEGORIES.WINDOW_EFFICIENCY,
        systemicIssue:
          "Fel Devastation fires outside Fiery Brand windows, missing 15% Fire damage amp",
        mechanism:
          `Fiery Brand is up ${brandUptime.toFixed(1)}% (~${((brandUptime / 100) * fightLength).toFixed(0)}s total). ` +
          `FelDev fires ${felDevCasts} times, but only ~${(felDevPerBrand * brandCasts).toFixed(1)} of those ` +
          `can align with Brand. Fiery Demise provides +15% Fire damage. FelDev is 100% Fire damage.`,
        proposedChanges: [
          {
            type: MUTATION_OPS.ADD_CONDITION,
            list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
            ability: "fel_devastation",
            condition:
              "dot.fiery_brand.ticking|cooldown.fiery_brand.remains>25",
            operator: "&",
            description:
              "Prefer FelDev during Brand, but allow if Brand is far",
          },
        ],
        expectedImpact:
          "+0.3-0.8% DPS from Fiery Demise amplification on Fel Devastation",
        counterArgument:
          "Holding FelDev for Brand delays casts. But with a 25s fallback, " +
          "max delay is ~10s on a 40s CD (25% waste) vs 15% damage gain on a 5s channel.",
        dependencies: [],
        archetypeSpecific: false,
        priority: 12,
        confidence: "medium",
        scenario: "st",
      });
    }
  }

  // Soul Carver + Brand sync
  if (soulCarverCasts > 0 && brandUptime > 5) {
    const aplHasCarverBrandSync = aplText?.includes(
      "soul_carver,if=dot.fiery_brand",
    );

    if (!aplHasCarverBrandSync) {
      hypotheses.push({
        id: "carver-brand-sync",
        category: DEEP_HYPOTHESIS_CATEGORIES.COOLDOWN_SYNC,
        systemicIssue:
          "Soul Carver fires independently of Fiery Brand despite both being 60s CDs",
        mechanism:
          "Soul Carver and Fiery Brand share 60s cooldown. Soul Carver deals Fire damage " +
          "and benefits from Fiery Demise +15% amp. With identical CDs, perfect alignment is possible " +
          "at zero cost — but requires explicit APL logic to fire Brand first.",
        proposedChanges: [
          {
            type: MUTATION_OPS.ADD_CONDITION,
            list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
            ability: "soul_carver",
            condition: "dot.fiery_brand.remains>3|!talent.fiery_demise",
            operator: "&",
            description:
              "Soul Carver during Brand window (3s+ remaining) or if no Fiery Demise",
          },
        ],
        expectedImpact: "+0.3-0.6% DPS from Fiery Demise amp on Soul Carver",
        counterArgument:
          "If Brand is delayed, Carver is also delayed. But CDs are same length, " +
          "so after initial alignment they stay synced.",
        dependencies: [],
        archetypeSpecific: false,
        priority: 10,
        confidence: "high",
        scenario: "st",
      });
    }
  }

  return hypotheses;
}

function generateStateMachineHypotheses(workflowResults, aplText, archetype) {
  const hypotheses = [];
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);

  if (!st || !archetype) return hypotheses;

  // AR-specific: Rending Strike / Glaive Flurry cycle
  if (archetype.heroTree === "aldrachi_reaver") {
    const rendingUptime = getBuffUptime(st, "rending_strike") || 0;
    const glaiveFlurryUptime = getBuffUptime(st, "glaive_flurry") || 0;

    // Check for cycle breakage
    if (rendingUptime > 5 && glaiveFlurryUptime < rendingUptime * 0.7) {
      hypotheses.push({
        id: "ar-cycle-completion",
        category: DEEP_HYPOTHESIS_CATEGORIES.STATE_MACHINE_ALIGNMENT,
        systemicIssue:
          "AR cycle not completing — Rending Strike procs but Glaive Flurry often doesn't follow",
        mechanism:
          `Rending Strike uptime: ${rendingUptime.toFixed(1)}%, Glaive Flurry: ${glaiveFlurryUptime.toFixed(1)}%. ` +
          "After Reaver's Glaive, the correct sequence is: Fracture (empowered, +10%, applies Mark) → " +
          "Soul Cleave (empowered, +20%, triggers Glaive Flurry). If SC doesn't fire during Rending Strike, " +
          "the cycle breaks and +20% damage amp + Aldrachi Tactics CDR are lost.",
        proposedChanges: [
          {
            type: MUTATION_OPS.ADD_PHASE,
            parentList: "ar",
            phaseName: "empowered",
            condition: "buff.rending_strike.up",
            entries: [
              {
                ability: "fracture",
                if: "!debuff.reavers_mark.up&cooldown.fracture.charges>=1",
              },
              { ability: "soul_cleave", if: "fury>=30" },
            ],
            insertPosition: "top",
            description: "Extract empowered phase into sub-list",
          },
        ],
        expectedImpact:
          "+1-3% DPS from completing AR cycle and capturing full damage amps",
        counterArgument:
          "Sub-list adds complexity. But the empowered window is time-limited (6s), " +
          "so explicit priority is needed to prevent fillers from wasting it.",
        dependencies: [],
        archetypeSpecific: true,
        priority: Math.max(5, (rendingUptime - glaiveFlurryUptime) * 0.8),
        confidence: "high",
        scenario: "st",
      });
    }
  }

  // Anni-specific: Voidfall cycle
  if (archetype.heroTree === "annihilator") {
    const voidfallBuilding = getBuffUptime(st, "voidfall_building") || 0;
    const voidfallSpending = getBuffUptime(st, "voidfall_spending") || 0;

    if (voidfallBuilding > 0 || voidfallSpending > 0) {
      hypotheses.push({
        id: "anni-voidfall-optimization",
        category: DEEP_HYPOTHESIS_CATEGORIES.STATE_MACHINE_ALIGNMENT,
        systemicIssue: "Voidfall stack management may not be optimal",
        mechanism:
          "Voidfall builds to 3 stacks from Fracture (35% chance) and Metamorphosis grants full stacks. " +
          `At 3 stacks, spenders trigger fel meteors. Building: ${voidfallBuilding.toFixed(1)}%, Spending: ${voidfallSpending.toFixed(1)}%. ` +
          "Key: don't waste spenders during building phase, don't waste Meta when already at 3 stacks.",
        proposedChanges: [
          {
            type: MUTATION_OPS.ADD_VARIABLE,
            list: "anni",
            name: "voidfall_ready",
            value: "buff.voidfall_spending.stack>=3",
            position: "top",
            description: "Track when Voidfall is ready for spending",
          },
          {
            type: MUTATION_OPS.ADD_CONDITION,
            list: "anni",
            ability: "spirit_bomb",
            condition: "variable.voidfall_ready|buff.voidfall_building.stack<2",
            operator: "&",
            description:
              "Prefer SBomb when Voidfall ready, or during building to prevent overcap",
          },
        ],
        expectedImpact: "+0.5-2% DPS from better Voidfall meteor triggering",
        counterArgument:
          "Voidfall stacking is somewhat RNG (35% proc). Delaying spenders for stacks " +
          "may not be worth the lost casts. Test confirms.",
        dependencies: [],
        archetypeSpecific: true,
        priority: 8,
        confidence: "medium",
        scenario: "st",
      });
    }
  }

  return hypotheses;
}

function generateCompoundHypotheses(workflowResults, aplText, archetype) {
  const hypotheses = [];
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);

  if (!st) return hypotheses;

  // Resource pooling for burst window compound hypothesis
  const metaUptime = getBuffUptime(st, "metamorphosis") || 0;
  const brandUptime = getBuffUptime(st, "fiery_brand") || 0;
  const fractureCasts = getCastCount(st, "fracture");
  const sbCasts = getCastCount(st, "spirit_bomb");

  // Meta preparation phase
  if (metaUptime > 10 && metaUptime < 40) {
    const metaCd = 120; // base CD
    const metaWindow = 15; // duration
    const fightLength = st.fightLength || 300;
    const metaCasts = Math.floor(fightLength / metaCd);

    hypotheses.push({
      id: "meta-prep-phase",
      category: DEEP_HYPOTHESIS_CATEGORIES.MULTI_PART_CHANGE,
      systemicIssue:
        "Metamorphosis window has fixed duration but APL doesn't pre-pool resources",
      mechanism:
        `Meta provides +20% damage for ${metaWindow}s every ${metaCd}s (~${metaCasts} casts/fight). ` +
        "During Meta, Fracture generates 3 frags (not 2), making fragment economy temporarily rich. " +
        "But entering Meta with low fury/frags means the first few GCDs are spent building, not dealing damage. " +
        "Pre-pooling 2-3s before Meta maximizes window value.",
      proposedChanges: [
        {
          type: MUTATION_OPS.ADD_VARIABLE,
          list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          name: "meta_soon",
          value: "cooldown.metamorphosis.remains<5&!buff.metamorphosis.up",
          position: "top",
          description: "Flag when Meta is approaching",
        },
        {
          type: MUTATION_OPS.ADD_PHASE,
          parentList: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          phaseName: "meta_prep",
          condition: "variable.meta_soon",
          entries: [
            {
              ability: "fracture",
              if: "cooldown.fracture.charges>=2",
              description: "Build charges for Meta",
            },
            {
              ability: "spirit_bomb",
              if: "soul_fragments>=5",
              description: "Dump high-count SBomb before Meta",
            },
          ],
          insertPosition: "top",
          description: "Pre-Meta resource preparation phase",
        },
      ],
      expectedImpact:
        "+0.5-1.5% DPS from entering Meta with full resources and exiting with depleted pool",
      counterArgument:
        "5s of reduced aggression pre-Meta may cost more than the burst window gains. " +
        "But the +20% damage amp during Meta is multiplicative with all other modifiers.",
      dependencies: [],
      archetypeSpecific: false,
      priority: 15,
      confidence: "medium",
      scenario: "st",
    });
  }

  // Brand window resource optimization
  if (brandUptime > 10 && sbCasts > 0) {
    hypotheses.push({
      id: "brand-window-optimization",
      category: DEEP_HYPOTHESIS_CATEGORIES.MULTI_PART_CHANGE,
      systemicIssue:
        "Fiery Brand window has fixed duration but fragment spending may not align",
      mechanism:
        "Fiery Demise provides +15% Fire damage during Brand (10s window). " +
        "Spirit Bomb deals Fire damage, so SBomb during Brand is +15% more effective. " +
        "Optimal: enter Brand with 4-5 fragments, cast SBomb immediately, rebuild during window.",
      proposedChanges: [
        {
          type: MUTATION_OPS.ADD_VARIABLE,
          list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          name: "brand_window",
          value: "dot.fiery_brand.ticking&talent.fiery_demise",
          position: "top",
          description: "Track active Fiery Brand window",
        },
        {
          type: MUTATION_OPS.ADD_CONDITION,
          list: archetype?.heroTree === "annihilator" ? "anni" : "ar",
          ability: "spirit_bomb",
          condition: "variable.brand_window|soul_fragments>=5",
          operator: "|",
          description: "SBomb eagerly during Brand, or at 5 frags outside",
        },
      ],
      expectedImpact:
        "+0.3-0.8% DPS from better Spirit Bomb timing in Fiery Demise window",
      counterArgument:
        "Lower SBomb threshold during Brand may fire with 3-4 frags. " +
        "But +15% on 3-frag SBomb > +0% on 5-frag SBomb outside window.",
      dependencies: [],
      archetypeSpecific: false,
      priority: 10,
      confidence: "medium",
      scenario: "st",
    });
  }

  return hypotheses;
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
