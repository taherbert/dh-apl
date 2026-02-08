// Strategic hypothesis generator — archetype-aware hypothesis generation.
// Replaces shallow metric-based reasoning with strategic analysis informed by build context.
// Usage: node src/analyze/strategic-hypotheses.js <workflow-results.json>

import { readFileSync, existsSync } from "node:fs";
import { detectArchetype, describeArchetype } from "./archetypes.js";
import { parse, getActionLists } from "../apl/parser.js";
import {
  parseCondition,
  extractSemantics,
  findBuffReferences,
} from "../apl/condition-parser.js";
import { MUTATION_OPS } from "../apl/mutator.js";
import {
  getSpecAdapter,
  loadSpecAdapter,
  initSpec,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { getSpecName } from "../engine/paths.js";

// --- Spec Configuration ---
let currentSpecId = null;

export function setSpecId(specId) {
  currentSpecId = specId;
}

function getCurrentSpecId() {
  return currentSpecId || getSpecName();
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

// Returns the APL branch name for a given hero tree, or the first configured branch as fallback
function getAplBranchForHeroTree(specConfig, heroTree) {
  if (heroTree && specConfig.heroTrees?.[heroTree]?.aplBranch) {
    return specConfig.heroTrees[heroTree].aplBranch;
  }
  return getDefaultAplBranch(specConfig);
}

// Returns the first configured APL branch as a default
function getDefaultAplBranch(specConfig) {
  const trees = specConfig.heroTrees || {};
  for (const treeConfig of Object.values(trees)) {
    if (treeConfig.aplBranch) return treeConfig.aplBranch;
  }
  return "default";
}

export function generateStrategicHypotheses(workflowResults, aplText = null) {
  const hypotheses = [];
  let archetypeContext = null;
  let aplAst = null;
  let heroTree = null;

  if (aplText) {
    // 1. Check profile name (most reliable - explicit in APL header)
    heroTree = detectHeroTreeFromProfileName(aplText);

    // 2. Check APL structure (hero tree branch action lists)
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
  const adapter = getSpecAdapter();
  const result = adapter.detectHeroTreeFromProfileName(
    aplText,
    getCurrentSpecId(),
  );
  if (result) return result;

  // Fallback: Look for profile name in APL text
  const trees = adapter.getHeroTrees(getCurrentSpecId());
  const profileMatch = aplText.match(
    new RegExp(`${adapter.SPEC_CONFIG.className}\\s*=\\s*"([^"]+)"`, "i"),
  );
  if (profileMatch) {
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
  const adapter = getSpecAdapter();
  const result = adapter.detectHeroTreeFromBuffs(
    workflowResults,
    getCurrentSpecId(),
  );
  if (result) return result;

  // Fallback: manual detection using config-defined buffs
  const trees = adapter.getHeroTrees(getCurrentSpecId());
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

    if (treeMatches.length === 1) return treeMatches[0];
  }

  return null;
}

function detectHeroTreeFromApl(aplAst) {
  const specConfig = getSpecAdapter().getSpecConfig();
  const heroTrees = specConfig.heroTrees || {};
  const lists = getActionLists(aplAst);

  // Build a map of aplBranch → heroTreeId for each configured hero tree
  const branchToTree = {};
  for (const [treeId, treeConfig] of Object.entries(heroTrees)) {
    if (treeConfig.aplBranch) {
      branchToTree[treeConfig.aplBranch] = treeId;
    }
  }

  // Check which APL branches have content
  const branchPresence = {};
  for (const [branch, treeId] of Object.entries(branchToTree)) {
    const list = lists.find((l) => l.name === branch);
    branchPresence[branch] = { treeId, hasContent: list?.entries.length > 0 };
  }

  const withContent = Object.values(branchPresence).filter((b) => b.hasContent);
  if (withContent.length === 1) return withContent[0].treeId;

  // Multiple branches have content: check default list for hero_tree conditions
  const defaultList = lists.find((l) => l.name === "default");
  for (const entry of defaultList?.entries || []) {
    if (entry.type !== "RunActionList") continue;

    const condition = entry.modifiers?.get("if") || "";
    const targetList = entry.modifiers?.get("name");

    for (const [branch, { treeId }] of Object.entries(branchPresence)) {
      if (targetList === branch && condition.includes(`hero_tree.${treeId}`)) {
        return treeId;
      }
    }
  }

  // Fallback: return the first branch with content
  if (withContent.length > 0) return withContent[0].treeId;
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
  const specConfig = getSpecAdapter().getSpecConfig();
  const stateMachines = specConfig.stateMachines || {};

  // Data-driven state machine uptime analysis
  for (const [smId, sm] of Object.entries(stateMachines)) {
    // Only analyze state machines matching the detected hero tree
    if (archetype?.heroTree && archetype.heroTree !== smId) continue;

    const uptimeTargets = sm.uptimeTargets || {};
    for (const state of sm.states || []) {
      if (!state.buff) continue;

      const uptime = getBuffUptime(scenario, state.buff);
      if (uptime === undefined) continue;

      const target = uptimeTargets[state.buff];
      if (target && uptime < target) {
        hypotheses.push({
          category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
          archetype: archetype?.id,
          archetypeContext: `${sm.name}: ${sm.description}. ${state.buff} is part of the cycle.`,
          strategicGoal: `Improve ${state.buff} uptime in ${sm.name}`,
          observation: `${state.buff} uptime only ${uptime}% (target: ${target}%) in ${scenario.scenarioName}`,
          metric: uptime,
          target: state.buff,
          hypothesis: `Improve ${state.buff} uptime to maintain ${sm.name} cycle`,
          scenario: scenario.scenario,
          priority: (target - uptime) * 1.5,
          confidence: "high",
        });
      }

      // Check for cycle breakage: earlier states high but later states low
      if (state.next) {
        const nextState = sm.states.find((s) => s.name === state.next);
        if (nextState?.buff) {
          const nextUptime = getBuffUptime(scenario, nextState.buff);
          if (
            nextUptime !== undefined &&
            uptime > 5 &&
            nextUptime < uptime * 0.5
          ) {
            hypotheses.push({
              category: STRATEGIC_CATEGORIES.PRIORITY_REORDER,
              archetype: archetype?.id,
              archetypeContext: `${sm.name}: ${sm.description}. ${state.buff} → ${nextState.buff} sequence may be broken.`,
              strategicGoal: `Ensure ${sm.name} cycle completes through ${nextState.buff}`,
              observation: `${state.buff} ${uptime}% but ${nextState.buff} only ${nextUptime}% — sequence may be broken`,
              metric: nextUptime,
              target: nextState.ability || nextState.buff,
              hypothesis: `Ensure ${nextState.ability || nextState.buff} fires during ${state.buff} window`,
              scenario: scenario.scenario,
              priority: (uptime - nextUptime) * 2,
              confidence: "high",
            });
          }
        }
      }
    }
  }

  // Generic buff-uptime hypotheses from SPEC_CONFIG hypothesis patterns
  for (const pattern of specConfig.hypothesisPatterns || []) {
    if (!pattern.buffName) continue;
    const uptime = getBuffUptime(scenario, pattern.buffName);
    if (uptime !== undefined && uptime < 20) {
      hypotheses.push({
        category: STRATEGIC_CATEGORIES[pattern.category] || pattern.category,
        archetype: archetype?.id,
        archetypeContext: pattern.template,
        strategicGoal: `Improve ${pattern.buffName} utilization`,
        observation: `${pattern.buffName} uptime only ${uptime}% in ${scenario.scenarioName}`,
        metric: uptime,
        target: pattern.buffName,
        hypothesis: pattern.template,
        scenario: scenario.scenario,
        priority: (20 - uptime) * 1.2,
        confidence: "medium",
      });
    }
  }

  return hypotheses;
}

function generateCooldownHypotheses(scenario, archetype, aplAst) {
  const hypotheses = [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const burstWindows = specConfig.burstWindows || [];
  const stateMachines = specConfig.stateMachines || {};
  const aplBranch = getAplBranchForHeroTree(specConfig, archetype?.heroTree);

  // Data-driven burst window sync analysis
  for (const window of burstWindows) {
    const uptime = getBuffUptime(scenario, window.buff);
    if (uptime === undefined || uptime <= 10) continue;

    for (const syncTarget of window.syncTargets || []) {
      const targetAbility = scenario.majorDamage?.find(
        (a) => normalizeAbilityName(a.name) === syncTarget,
      );
      if (!targetAbility || targetAbility.fraction <= 2) continue;

      hypotheses.push({
        category: STRATEGIC_CATEGORIES.COOLDOWN_SYNC,
        archetype: archetype?.id,
        archetypeContext: `${window.buff} provides ${(window.damageAmp * 100).toFixed(0)}% ${window.school} damage amp${window.talentDep ? ` via ${window.talentDep}` : ""}. ${syncTarget} should sync with ${window.buff} windows.`,
        strategicGoal: `Align ${syncTarget} with ${window.buff}`,
        observation: `${window.buff} uptime is ${uptime}%, ${syncTarget} is ${targetAbility.fraction}% of damage`,
        metric: uptime,
        target: syncTarget,
        hypothesis: `Sync ${syncTarget} with ${window.buff} for ${(window.damageAmp * 100).toFixed(0)}% ${window.school} damage amp`,
        scenario: scenario.scenario,
        priority: targetAbility.fraction * 0.8,
        confidence: "high",
        aplMutation: {
          type: MUTATION_OPS.ADD_CONDITION,
          list: aplBranch,
          ability: syncTarget,
          condition: `dot.${window.buff}.ticking`,
          operator: "&",
          allowFallback: true,
          reason: `Prefer ${syncTarget} during ${window.buff} for damage amp`,
        },
      });
    }

    // Resource bonus utilization during burst windows
    if (window.resourceBonus) {
      const rb = window.resourceBonus;
      const metaUptime = uptime;
      if (metaUptime > 10 && metaUptime < 50) {
        hypotheses.push({
          category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
          archetype: archetype?.id,
          archetypeContext: `During ${window.buff}, ${rb.ability} generates +${rb.bonus} ${rb.resource}. Threshold adjustments may optimize spending.`,
          strategicGoal: `Optimize ${rb.resource} spending during ${window.buff}`,
          observation: `${window.buff} uptime is ${metaUptime}%`,
          metric: metaUptime,
          target: rb.ability,
          hypothesis: `Adjust ${rb.resource} thresholds during ${window.buff} for extra generation`,
          scenario: scenario.scenario,
          priority: 6,
          confidence: "high",
        });
      }
    }
  }

  // State machine hypotheses for the active hero tree
  for (const [smId, sm] of Object.entries(stateMachines)) {
    if (archetype?.heroTree && archetype.heroTree !== smId) continue;
    const smAplBranch = specConfig.heroTrees?.[smId]?.aplBranch || aplBranch;

    for (const state of sm.states || []) {
      if (!state.buff) continue;

      const stateUptime = getBuffUptime(scenario, state.buff);
      if (stateUptime === undefined) continue;

      // Check for stack-based state machines (e.g., Voidfall)
      if (state.maxStacks) {
        hypotheses.push({
          category: STRATEGIC_CATEGORIES.WINDOW_EFFICIENCY,
          archetype: archetype?.id,
          archetypeContext: `${sm.name}: ${sm.description}`,
          strategicGoal: `Optimize ${state.buff} stack management`,
          observation: `${state.buff} tracking active in ${scenario.scenarioName}`,
          metric: stateUptime,
          target: state.buff,
          hypothesis: `Ensure spenders fire at ${state.maxStacks} ${state.buff} stacks`,
          scenario: scenario.scenario,
          priority: 8,
          confidence: "high",
        });
      }

      // Check for trigger-based spending states
      if (state.trigger) {
        const triggerAbilities = state.trigger.split("|");
        for (const trigger of triggerAbilities) {
          hypotheses.push({
            category: STRATEGIC_CATEGORIES.RESOURCE_ALIGNMENT,
            archetype: archetype?.id,
            archetypeContext: `${sm.name}: ${sm.description}. ${trigger} triggers ${state.effect || state.buff}.`,
            strategicGoal: `Align ${trigger} with ${state.buff} state`,
            observation: `${state.buff} management in ${scenario.scenarioName}`,
            metric: stateUptime,
            target: trigger,
            hypothesis: `Optimize ${trigger} timing for ${sm.name} cycle`,
            scenario: scenario.scenario,
            priority: 7,
            confidence: "medium",
          });
        }
      }
    }
  }

  return hypotheses;
}

function generateConditionHypotheses(scenario, archetype, aplAst) {
  const specConfig = getSpecAdapter().getSpecConfig();
  const targetListName =
    archetype?.aplFocus?.[0] ||
    getAplBranchForHeroTree(specConfig, archetype?.heroTree);
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
  const specConfig = getSpecAdapter().getSpecConfig();
  const defaultBranch = getDefaultAplBranch(specConfig);

  if (!aplAst) {
    return {
      type: MUTATION_OPS.REMOVE_CONDITION,
      list: defaultBranch,
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
    list: defaultBranch,
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
  BURST_WINDOW_OPTIMIZATION: "Optimize ability usage during burst windows",
  RESOURCE_ECONOMY_RESTRUCTURE:
    "Restructure resource generation/consumption patterns",
  RESOURCE_POOLING: "Pool resources for upcoming burst windows",
  PHASE_EXTRACTION: "Extract phase-specific logic into sub-lists",
  STATE_MACHINE_ALIGNMENT: "Align APL with hero tree state machine transitions",
  MULTI_PART_CHANGE: "Compound hypothesis requiring multiple APL mutations",
};

export function generateDeepHypotheses(workflowResults, aplText, buildTheory) {
  const hypotheses = [];
  const archetype = detectArchetypeFromContext(workflowResults, aplText);

  // Generate hypotheses from each specialized analyst perspective
  hypotheses.push(
    ...generateResourceEconomyHypotheses(workflowResults, aplText, archetype),
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

function generateResourceEconomyHypotheses(
  workflowResults,
  aplText,
  archetype,
) {
  const hypotheses = [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const resourceModels = specConfig.resourceModels || [];
  const burstWindows = specConfig.burstWindows || [];
  const aplBranch = getAplBranchForHeroTree(specConfig, archetype?.heroTree);
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);

  if (!st) return hypotheses;

  // Analyze each resource model with a capped consumer (secondary resources)
  for (const model of resourceModels) {
    const burstConsumer = model.consumers.find((c) => c.maxConsume);
    if (!burstConsumer) continue;

    // Estimate generation vs consumption from sim data
    let estimatedGen = 0;
    for (const gen of model.generators) {
      const casts = getCastCount(st, gen.ability);
      if (casts > 0 && gen.amount) {
        estimatedGen += casts * gen.amount;
        // Check for burst window bonuses on this generator
        for (const window of burstWindows) {
          if (
            window.resourceBonus?.resource === model.name &&
            window.resourceBonus.ability === gen.ability
          ) {
            const windowUptime = getBuffUptime(st, window.buff) || 0;
            estimatedGen +=
              casts * (windowUptime / 100) * window.resourceBonus.bonus;
          }
        }
      }
    }

    let estimatedConsumed = 0;
    for (const consumer of model.consumers) {
      const casts = getCastCount(st, consumer.ability);
      estimatedConsumed += casts * (consumer.maxConsume || 1);
    }

    const estimatedOverflow = Math.max(0, estimatedGen - estimatedConsumed);
    const primaryGen = model.generators[0];

    // Resource overflow hypothesis
    if (
      estimatedGen > 0 &&
      estimatedOverflow > (getCastCount(st, primaryGen?.ability) || 1) * 0.2
    ) {
      hypotheses.push({
        id: `${model.name}-overflow-mitigation`,
        category: DEEP_HYPOTHESIS_CATEGORIES.RESOURCE_ECONOMY_RESTRUCTURE,
        systemicIssue: `${model.name} generation exceeds consumption capacity, leading to waste`,
        mechanism:
          `Estimated ~${Math.round(estimatedGen)} ${model.name} generated, ~${Math.round(estimatedConsumed)} consumed. ` +
          `~${Math.round(estimatedOverflow)} (~${((estimatedOverflow / estimatedGen) * 100).toFixed(0)}%) wasted. ` +
          `Cap is ${model.cap}.`,
        proposedChanges: [
          {
            type: MUTATION_OPS.INSERT_ACTION,
            list: aplBranch,
            ability: burstConsumer.ability,
            if: `${model.name}>=${model.cap - 1}&cooldown.${burstConsumer.ability}.up`,
            position: "top",
            description: `Emergency ${burstConsumer.ability} near ${model.name} cap`,
          },
        ],
        expectedImpact: `+0.5-1.5% DPS from converting wasted ${model.name} to damage`,
        counterArgument:
          `Lower ${burstConsumer.ability} threshold may fire with suboptimal ${model.name} counts, ` +
          `but preventing cap waste outweighs partial-count loss.`,
        dependencies: [],
        archetypeSpecific: false,
        priority: Math.min(15, estimatedOverflow * 0.5),
        confidence: estimatedOverflow > 20 ? "high" : "medium",
        scenario: "st",
      });
    }

    // Burst window resource bonus acceleration hypothesis
    for (const window of burstWindows) {
      const rb = window.resourceBonus;
      if (!rb || rb.resource !== model.name) continue;

      const windowUptime = getBuffUptime(st, window.buff) || 0;
      if (windowUptime <= 10 || windowUptime >= 50) continue;

      const genAbilityCasts = getCastCount(st, rb.ability);
      const extraFromWindow = genAbilityCasts * (windowUptime / 100) * rb.bonus;
      const aplHasPriority = aplText?.includes(
        `${rb.ability},if=buff.${window.buff}.up`,
      );

      if (!aplHasPriority && extraFromWindow > 5) {
        hypotheses.push({
          id: `${window.buff}-${rb.ability}-priority`,
          category: DEEP_HYPOTHESIS_CATEGORIES.BURST_WINDOW_OPTIMIZATION,
          systemicIssue: `${model.name} economy shifts during ${window.buff} (+${rb.bonus} per ${rb.ability}) but APL doesn't adapt`,
          mechanism:
            `${rb.ability} generates +${rb.bonus} ${model.name} during ${window.buff}. ` +
            `At ${windowUptime.toFixed(0)}% uptime, ~${Math.round(extraFromWindow)} extra ${model.name} available. ` +
            `${burstConsumer.ability} scales with ${model.name} count.`,
          proposedChanges: [
            {
              type: MUTATION_OPS.INSERT_ACTION,
              list: aplBranch,
              ability: rb.ability,
              if: `buff.${window.buff}.up&cooldown.${rb.ability}.charges>=1`,
              before: rb.ability,
              description: `Prioritize ${rb.ability} during ${window.buff} for extra ${model.name}`,
            },
          ],
          expectedImpact: `+1-5% ST DPS from maximizing ${model.name} gen during ${window.buff}`,
          counterArgument:
            `${rb.ability} charges may not be available, but recharge during ${window.buff} ` +
            `window should provide enough.`,
          dependencies: [],
          archetypeSpecific: false,
          priority: Math.min(20, extraFromWindow * 2),
          confidence: "high",
          scenario: "st",
        });
      }
    }
  }

  return hypotheses;
}

function generateBurstWindowHypotheses(workflowResults, aplText, archetype) {
  const hypotheses = [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const burstWindows = specConfig.burstWindows || [];
  const aplBranch = getAplBranchForHeroTree(specConfig, archetype?.heroTree);
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);

  if (!st) return hypotheses;

  const fightLength = st.fightLength || 300;

  for (const window of burstWindows) {
    const windowUptime = getBuffUptime(st, window.buff) || 0;
    if (windowUptime <= 5) continue;

    const windowCasts = Math.floor(fightLength / (window.cooldown || 60));
    const ampPct = ((window.damageAmp || 0) * 100).toFixed(0);

    // Check each sync target for alignment
    for (const syncTarget of window.syncTargets || []) {
      const targetCasts = getCastCount(st, syncTarget);
      if (targetCasts <= 0) continue;

      const targetPerWindow = targetCasts / windowCasts;
      const aplHasSync = aplText?.includes(
        `${syncTarget},if=dot.${window.buff}`,
      );

      if (!aplHasSync && targetPerWindow < 0.9) {
        const halfCd = Math.floor((window.cooldown || 60) / 2);
        hypotheses.push({
          id: `${syncTarget}-${window.buff}-sync`,
          category: DEEP_HYPOTHESIS_CATEGORIES.WINDOW_EFFICIENCY,
          systemicIssue: `${syncTarget} fires outside ${window.buff} windows, missing ${ampPct}% ${window.school} damage amp`,
          mechanism:
            `${window.buff} is up ${windowUptime.toFixed(1)}% (~${((windowUptime / 100) * fightLength).toFixed(0)}s total). ` +
            `${syncTarget} fires ${targetCasts} times, but only ~${(targetPerWindow * windowCasts).toFixed(1)} ` +
            `can align with ${window.buff}.${window.talentDep ? ` ${window.talentDep} provides +${ampPct}% ${window.school} damage.` : ""}`,
          proposedChanges: [
            {
              type: MUTATION_OPS.ADD_CONDITION,
              list: aplBranch,
              ability: syncTarget,
              condition: `dot.${window.buff}.ticking|cooldown.${window.buff}.remains>${halfCd}`,
              operator: "&",
              description: `Prefer ${syncTarget} during ${window.buff}, but allow if ${window.buff} is far`,
            },
          ],
          expectedImpact: `+0.3-0.8% DPS from ${window.school} damage amp on ${syncTarget}`,
          counterArgument:
            `Holding ${syncTarget} for ${window.buff} delays casts. But with a ${halfCd}s fallback, ` +
            `the delay is bounded vs ${ampPct}% damage gain.`,
          dependencies: [],
          archetypeSpecific: false,
          priority: 12,
          confidence: "medium",
          scenario: "st",
        });
      }
    }
  }

  return hypotheses;
}

function generateStateMachineHypotheses(workflowResults, aplText, archetype) {
  const hypotheses = [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const stateMachines = specConfig.stateMachines || {};
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);

  if (!st || !archetype) return hypotheses;

  // Iterate over state machines matching the active hero tree
  for (const [smId, sm] of Object.entries(stateMachines)) {
    if (archetype.heroTree !== smId) continue;

    const aplBranch = getAplBranchForHeroTree(specConfig, smId);
    const states = sm.states || [];

    // Sequential cycle analysis: check if later states have lower uptime (cycle breakage)
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      if (!state.buff) continue;

      const stateUptime = getBuffUptime(st, state.buff) || 0;

      // Check for sequential cycle breakage with next state
      const nextStateName = state.next;
      if (nextStateName) {
        const nextState = states.find((s) => s.name === nextStateName);
        if (nextState?.buff || nextState?.triggersBuff) {
          const nextBuff = nextState.triggersBuff || nextState.buff;
          const nextUptime = nextBuff ? getBuffUptime(st, nextBuff) || 0 : 0;

          if (stateUptime > 5 && nextUptime < stateUptime * 0.7) {
            // Build proposedChanges from the state machine's ability references
            const proposedChanges = [];
            if (nextState.ability) {
              proposedChanges.push({
                type: MUTATION_OPS.ADD_PHASE,
                parentList: aplBranch,
                phaseName: `${sm.name.toLowerCase().replace(/\s+/g, "_")}_empowered`,
                condition: `buff.${state.buff}.up`,
                entries: states
                  .filter(
                    (s) =>
                      s.ability &&
                      s.name !== state.name &&
                      s.trigger !== "auto_proc",
                  )
                  .map((s) => ({
                    ability: s.ability,
                    if: s.appliesBuff
                      ? `!debuff.${s.appliesBuff}.up`
                      : undefined,
                  })),
                insertPosition: "top",
                description: `Extract ${sm.name} empowered phase into sub-list`,
              });
            }

            // Build mechanism description from state machine data
            const stateDescs = states
              .filter((s) => s.ability)
              .map((s) => {
                const parts = [s.ability];
                if (s.ampPercent) parts.push(`+${s.ampPercent}%`);
                if (s.appliesBuff) parts.push(`applies ${s.appliesBuff}`);
                if (s.triggersBuff) parts.push(`triggers ${s.triggersBuff}`);
                return parts.join(" (") + (parts.length > 1 ? ")" : "");
              })
              .join(" -> ");

            hypotheses.push({
              id: `${smId}-cycle-completion`,
              category: DEEP_HYPOTHESIS_CATEGORIES.STATE_MACHINE_ALIGNMENT,
              systemicIssue: `${sm.name} cycle not completing — ${state.buff} procs but ${nextBuff} often doesn't follow`,
              mechanism:
                `${state.buff} uptime: ${stateUptime.toFixed(1)}%, ${nextBuff}: ${nextUptime.toFixed(1)}%. ` +
                `${sm.description}. Sequence: ${stateDescs}. ` +
                `If cycle breaks at ${state.buff}, later damage amps are lost.`,
              proposedChanges,
              expectedImpact: `+1-3% DPS from completing ${sm.name} cycle and capturing full damage amps`,
              counterArgument:
                `Sub-list adds complexity. But the empowered window is time-limited, ` +
                `so explicit priority is needed to prevent fillers from wasting it.`,
              dependencies: [],
              archetypeSpecific: true,
              priority: Math.max(5, (stateUptime - nextUptime) * 0.8),
              confidence: "high",
              scenario: "st",
            });
          }
        }
      }

      // Stack-based state machine: building → spending pattern
      if (state.maxStacks) {
        const buildingUptime = stateUptime;
        // Find the spending state (the one with a trigger)
        const spendingState = states.find((s) => s.trigger && s !== state);
        const spendingUptime = spendingState?.buff
          ? getBuffUptime(st, spendingState.buff) || 0
          : 0;

        if (buildingUptime > 0 || spendingUptime > 0) {
          const spendingBuff = spendingState?.buff || state.buff;
          const triggerAbilities = spendingState?.trigger?.split("|") || [];
          const primaryConsumer = triggerAbilities[0];

          hypotheses.push({
            id: `${smId}-stack-optimization`,
            category: DEEP_HYPOTHESIS_CATEGORIES.STATE_MACHINE_ALIGNMENT,
            systemicIssue: `${sm.name} stack management may not be optimal`,
            mechanism:
              `${sm.description}. ` +
              `${state.buff} builds from ${(state.stacksFrom || []).join(", ")}. ` +
              `At ${state.maxStacks} stacks, ${triggerAbilities.join("/")} trigger ${spendingState?.effect || "bonus"}. ` +
              `Building: ${buildingUptime.toFixed(1)}%, Spending: ${spendingUptime.toFixed(1)}%.`,
            proposedChanges: [
              {
                type: MUTATION_OPS.ADD_VARIABLE,
                list: aplBranch,
                name: `${smId}_ready`,
                value: `buff.${spendingBuff}.stack>=${state.maxStacks}`,
                position: "top",
                description: `Track when ${sm.name} is ready for spending`,
              },
              ...(primaryConsumer
                ? [
                    {
                      type: MUTATION_OPS.ADD_CONDITION,
                      list: aplBranch,
                      ability: primaryConsumer,
                      condition: `variable.${smId}_ready|buff.${state.buff}.stack<${Math.max(1, state.maxStacks - 1)}`,
                      operator: "&",
                      description: `Prefer ${primaryConsumer} when ${sm.name} ready, or during building to prevent overcap`,
                    },
                  ]
                : []),
            ],
            expectedImpact: `+0.5-2% DPS from better ${sm.name} management`,
            counterArgument:
              `${sm.name} stacking may be RNG-dependent. Delaying spenders for stacks ` +
              `may not be worth the lost casts. Test confirms.`,
            dependencies: [],
            archetypeSpecific: true,
            priority: 8,
            confidence: "medium",
            scenario: "st",
          });
        }
      }
    }
  }

  return hypotheses;
}

function generateCompoundHypotheses(workflowResults, aplText, archetype) {
  const hypotheses = [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const burstWindows = specConfig.burstWindows || [];
  const resourceModels = specConfig.resourceModels || [];
  const aplBranch = getAplBranchForHeroTree(specConfig, archetype?.heroTree);
  const scenarios = normalizeScenarios(workflowResults);
  const st = scenarios.find((s) => s.scenario === "st" && !s.error);

  if (!st) return hypotheses;

  const fightLength = st.fightLength || 300;

  // Burst window pre-pooling hypotheses
  for (const window of burstWindows) {
    const windowUptime = getBuffUptime(st, window.buff) || 0;
    if (windowUptime <= 10 || windowUptime >= 40) continue;

    const cd = window.cooldown || 60;
    const dur = window.duration || 10;
    const ampPct = ((window.damageAmp || 0) * 100).toFixed(0);
    const windowCasts = Math.floor(fightLength / cd);

    // Build prep phase entries from resource models
    const prepEntries = [];
    for (const model of resourceModels) {
      const primaryGen = model.generators[0];
      if (primaryGen?.charges) {
        prepEntries.push({
          ability: primaryGen.ability,
          if: `cooldown.${primaryGen.ability}.charges>=2`,
          description: `Build ${primaryGen.ability} charges for ${window.buff}`,
        });
      }
      const burstConsumer = model.consumers.find((c) => c.maxConsume);
      if (burstConsumer) {
        prepEntries.push({
          ability: burstConsumer.ability,
          if: `${model.name}>=${model.cap || 5}`,
          description: `Dump ${model.name} via ${burstConsumer.ability} before ${window.buff}`,
        });
      }
    }

    if (prepEntries.length > 0) {
      hypotheses.push({
        id: `${window.buff}-prep-phase`,
        category: DEEP_HYPOTHESIS_CATEGORIES.MULTI_PART_CHANGE,
        systemicIssue: `${window.buff} window has fixed duration but APL doesn't pre-pool resources`,
        mechanism:
          `${window.buff} provides +${ampPct}% damage for ${dur}s every ${cd}s (~${windowCasts} casts/fight). ` +
          `Entering ${window.buff} with low resources means the first few GCDs are spent building, not dealing damage. ` +
          `Pre-pooling 2-3s before ${window.buff} maximizes window value.`,
        proposedChanges: [
          {
            type: MUTATION_OPS.ADD_VARIABLE,
            list: aplBranch,
            name: `${window.buff}_soon`,
            value: `cooldown.${window.buff}.remains<5&!buff.${window.buff}.up`,
            position: "top",
            description: `Flag when ${window.buff} is approaching`,
          },
          {
            type: MUTATION_OPS.ADD_PHASE,
            parentList: aplBranch,
            phaseName: `${window.buff}_prep`,
            condition: `variable.${window.buff}_soon`,
            entries: prepEntries,
            insertPosition: "top",
            description: `Pre-${window.buff} resource preparation phase`,
          },
        ],
        expectedImpact: `+0.5-1.5% DPS from entering ${window.buff} with full resources`,
        counterArgument:
          `5s of reduced aggression pre-${window.buff} may cost more than the burst window gains. ` +
          `But the +${ampPct}% damage amp during ${window.buff} is multiplicative with other modifiers.`,
        dependencies: [],
        archetypeSpecific: false,
        priority: 15,
        confidence: "medium",
        scenario: "st",
      });
    }
  }

  // Burst window resource spending optimization
  for (const window of burstWindows) {
    const windowUptime = getBuffUptime(st, window.buff) || 0;
    if (windowUptime <= 10) continue;

    const ampPct = ((window.damageAmp || 0) * 100).toFixed(0);

    // Find resources with burst consumers that benefit from this window
    for (const model of resourceModels) {
      const burstConsumer = model.consumers.find((c) => c.maxConsume);
      if (!burstConsumer) continue;

      const consumerCasts = getCastCount(st, burstConsumer.ability);
      if (consumerCasts <= 0) continue;

      hypotheses.push({
        id: `${window.buff}-${burstConsumer.ability}-optimization`,
        category: DEEP_HYPOTHESIS_CATEGORIES.MULTI_PART_CHANGE,
        systemicIssue: `${window.buff} window has fixed duration but ${model.name} spending may not align`,
        mechanism:
          `${window.buff} provides +${ampPct}% ${window.school} damage (${window.duration}s window). ` +
          `${burstConsumer.ability} benefits from this amp. Optimal: enter ${window.buff} with high ${model.name}, ` +
          `cast ${burstConsumer.ability} immediately, rebuild during window.`,
        proposedChanges: [
          {
            type: MUTATION_OPS.ADD_VARIABLE,
            list: aplBranch,
            name: `${window.buff}_window`,
            value: `dot.${window.buff}.ticking${window.talentDep ? `&talent.${window.talentDep}` : ""}`,
            position: "top",
            description: `Track active ${window.buff} window`,
          },
          {
            type: MUTATION_OPS.ADD_CONDITION,
            list: aplBranch,
            ability: burstConsumer.ability,
            condition: `variable.${window.buff}_window|${model.name}>=${model.cap || 5}`,
            operator: "|",
            description: `${burstConsumer.ability} eagerly during ${window.buff}, or at cap outside`,
          },
        ],
        expectedImpact: `+0.3-0.8% DPS from better ${burstConsumer.ability} timing in ${window.buff} window`,
        counterArgument:
          `Lower ${burstConsumer.ability} threshold during ${window.buff} may fire with suboptimal ${model.name} counts. ` +
          `But +${ampPct}% on partial ${burstConsumer.ability} > +0% on full ${burstConsumer.ability} outside window.`,
        dependencies: [],
        archetypeSpecific: false,
        priority: 10,
        confidence: "medium",
        scenario: "st",
      });
    }
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
  await initSpec(parseSpecArg());
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
