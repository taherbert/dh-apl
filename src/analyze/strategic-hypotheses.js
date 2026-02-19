// Strategic hypothesis generator — archetype-aware hypothesis generation.
// Replaces shallow metric-based reasoning with strategic analysis informed by build context.
// Usage: node src/analyze/strategic-hypotheses.js <workflow-results.json>

import { readFileSync, existsSync } from "node:fs";
import { parse, getActionLists } from "../apl/parser.js";
import { getArchetypes as dbGetArchetypes } from "../util/db.js";
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

// --- Archetype detection (folded from archetypes.js) ---

function loadArchetypes() {
  const dbArchetypes = dbGetArchetypes();
  return Object.fromEntries(
    dbArchetypes.map((arch) => [
      arch.name,
      {
        heroTree: arch.heroTree || arch.hero_tree,
        description: arch.description,
        coreLoop: arch.coreLoop || arch.core_loop,
        keyTalents: arch.keyTalents || arch.key_talents || [],
        keyBuffs: [],
        keyAbilities: [],
        tradeoffs: arch.tensions,
        aplFocus: arch.aplFocus || arch.apl_focus || [],
        clusters: arch.definingTalents || arch.defining_talents || [],
        tensions: arch.tensions,
      },
    ]),
  );
}

function detectArchetype(talents, heroTree = null) {
  const archetypes = loadArchetypes();
  const matches = [];

  for (const [id, archetype] of Object.entries(archetypes)) {
    if (heroTree && archetype.heroTree !== heroTree) continue;

    if (!talents && heroTree) {
      matches.push({ id, archetype, score: 0, maxScore: 0, confidence: 0.5 });
      continue;
    }

    let score = 0;
    let maxScore = 0;

    for (const talent of archetype.keyTalents || []) {
      maxScore += 2;
      if (hasTalent(talents, talent)) score += 2;
    }

    if (maxScore > 0 && score / maxScore >= 0.5) {
      matches.push({
        id,
        archetype,
        score,
        maxScore,
        confidence: score / maxScore,
      });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

function hasTalent(talents, talentName) {
  if (!talents) return false;
  const normalizedName = normalizeArchName(talentName);
  const entries = Array.isArray(talents) ? talents : Object.keys(talents);
  return entries.some((t) => normalizeArchName(t.name || t) === normalizedName);
}

function normalizeArchName(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function describeArchetype(archetypeId) {
  const archetypes = loadArchetypes();
  const arch = archetypes[archetypeId];
  if (!arch) return null;

  return {
    id: archetypeId,
    heroTree: arch.heroTree,
    description: arch.description,
    coreLoop: arch.coreLoop,
    keyBuffs: arch.keyBuffs || [],
    keyAbilities: arch.keyAbilities || [],
    tradeoffs: arch.tradeoffs,
    aplFocus: arch.aplFocus || [],
  };
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

// (Deep hypothesis generation removed — superseded by theory-generator.js)
// (generateResourceEconomyHypotheses, generateBurstWindowHypotheses,
//  generateStateMachineHypotheses, generateCompoundHypotheses removed)
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
