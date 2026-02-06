// Temporal resource flow analysis — generates testable hypotheses about timing,
// pooling, and cycle management that static priority analysis misses.
// Usage: node src/analyze/theorycraft.js [workflow-results.json] [apl.simc]

import { readFileSync, existsSync } from "node:fs";
import { MUTATION_OPS } from "../apl/mutator.js";
import { parse, getActionLists } from "../apl/parser.js";
import { getSpecAdapter, loadSpecAdapter, config } from "../engine/startup.js";
import { dataFile } from "../engine/paths.js";

// --- Temporal hypothesis categories ---

const TEMPORAL_CATEGORIES = {
  TEMPORAL_POOLING: "Save resources for upcoming burst window",
  CYCLE_ALIGNMENT: "Align ability cycles for better resource utilization",
  COOLDOWN_SEQUENCING: "Order cooldowns to minimize resource waste",
  RESOURCE_GATING: "Adjust resource guards on cooldowns",
  HASTE_BREAKPOINT: "Exploit timing thresholds at specific haste levels",
};

// --- Spec Configuration ---
// Spec ID can be overridden for multi-spec support
let currentSpecId = config.spec.specName;

export function setSpecId(specId) {
  currentSpecId = specId;
}

// Load ability data from spec adapter
function loadAbilityData() {
  return getSpecAdapter().loadAbilityData();
}

let ABILITY_DATA = null;

function getAbilityData() {
  if (!ABILITY_DATA) ABILITY_DATA = loadAbilityData();
  return ABILITY_DATA;
}

// --- Resource Flow Modeling ---

export function analyzeResourceFlow(spellData, aplText, simResults) {
  const resources = buildResourceModels(spellData, simResults);
  const cycles = buildCooldownCycles(spellData, simResults);
  const conflicts = detectTimingConflicts(
    resources,
    cycles,
    simResults,
    aplText,
  );

  return { resources, cycles, conflicts };
}

function buildResourceModels(spellData, simResults) {
  const models = [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const resourceModels = specConfig.resourceModels || [];

  for (const rm of resourceModels) {
    const model = {
      name: rm.name,
      cap: rm.cap,
      generators: rm.generators.map((g) => ({
        ability: g.ability,
        amount: g.amount || (g.perTick ? g.perTick * (g.duration || 1) : 0),
        amountMeta: g.metaAmount,
        rechargeCd: g.rechargeCd,
        charges: g.charges,
        cooldown: g.cooldown || g.rechargeCd,
        perTick: g.perTick !== undefined,
        procRate: g.procRate,
        source: g.source,
      })),
      consumers: rm.consumers.map((c) => ({
        ability: c.ability,
        amount: c.cost || c.maxConsume || 0,
        maxConsume: c.maxConsume,
        cooldown: 0,
        valuePerUnit: c.valuePerUnit,
      })),
      flowRate: null,
      overflowRate: null,
    };

    if (simResults) {
      const st = findScenario(simResults, "st");
      if (st) {
        model.flowRate = estimateResourceFlow(st, rm.name, model);
        if (rm.consumers.some((c) => c.maxConsume)) {
          model.overflowRate = estimateOverflow(st, rm);
        }
      }
    }

    models.push(model);
  }

  // GCD model (universal)
  const gcdModel = {
    name: "gcds",
    cap: null,
    generators: [{ ability: "time", rate: "40/min at base haste" }],
    consumers: [{ ability: "all_gcd_abilities", rate: "depends on APL" }],
    flowRate: null,
  };

  if (simResults) {
    const st = findScenario(simResults, "st");
    if (st?.gcdEfficiency !== undefined) {
      gcdModel.flowRate = { efficiency: st.gcdEfficiency };
    }
  }

  models.push(gcdModel);

  return models;
}

// Generic overflow estimation for resources with maxConsume consumers
function estimateOverflow(scenario, resourceModel) {
  if (!scenario) return null;

  let generated = 0;
  let consumed = 0;

  for (const gen of resourceModel.generators) {
    const casts = getCastCount(scenario, gen.ability);
    generated += casts * (gen.amount || 0);
  }
  for (const con of resourceModel.consumers) {
    const casts = getCastCount(scenario, con.ability);
    consumed += casts * (con.maxConsume || con.cost || 0);
  }

  const overflow = Math.max(0, generated - consumed);
  return {
    estimated: overflow,
    generated,
    consumed,
    pctOfGenerated: generated > 0 ? (overflow / generated) * 100 : 0,
  };
}

function buildCooldownCycles(spellData, simResults) {
  const cdAbilities = Object.entries(getAbilityData())
    .filter(([, data]) => data.cooldown >= 10)
    .map(([name, data]) => ({ name, ...data }));

  return cdAbilities.map((ability) => {
    const baseGcd = 1.5;
    const gcdsPerCycle = Math.floor(ability.cooldown / baseGcd);

    const cycle = {
      ability: ability.name,
      cooldown: ability.cooldown,
      gcdsPerCycle,
      duration: ability.duration || 0,
      phases: buildCyclePhases(ability),
      resourceBudget: estimateCycleBudget(ability, gcdsPerCycle),
      simCasts: null,
    };

    if (simResults) {
      const st = findScenario(simResults, "st");
      cycle.simCasts = getCastCount(st, ability.name);
    }

    return cycle;
  });
}

function buildCyclePhases(ability) {
  const { name, cooldown, duration } = ability;

  if (duration) {
    return [
      { name: "active", duration, action: `${name} active` },
      {
        name: "recovery",
        duration: cooldown - duration,
        action: "build resources for next cast",
      },
    ];
  }

  return [
    { name: "cast", duration: 1.5, action: `cast ${name}` },
    {
      name: "recovery",
      duration: cooldown - 1.5,
      action: "fill with other abilities",
    },
  ];
}

function estimateCycleBudget(ability, gcdsPerCycle) {
  // Use spec config resource models to estimate budget per cycle
  const specConfig = getSpecAdapter().getSpecConfig();
  const budget = { gcdsAvailable: gcdsPerCycle };

  for (const rm of specConfig.resourceModels || []) {
    // Find the primary charge-based generator for this resource
    const primaryGen = rm.generators.find((g) => g.charges && g.rechargeCd);
    if (primaryGen) {
      const castsPerCycle = Math.floor(
        ability.cooldown / primaryGen.rechargeCd,
      );
      budget[`${rm.name}Generated`] = castsPerCycle * (primaryGen.amount || 0);
      budget[`${primaryGen.ability}Estimated`] = castsPerCycle;
    }
  }

  return budget;
}

// --- Timing Conflict Detection ---

function detectTimingConflicts(resources, cycles, simResults, aplText) {
  const conflicts = [];

  conflicts.push(...detectResourceCompetition(resources, cycles, simResults));
  conflicts.push(...detectCooldownCollisions(cycles, simResults));
  conflicts.push(...detectBurstWindowWaste(cycles, simResults));
  conflicts.push(...detectPoolingOpportunities(resources, cycles, simResults));
  conflicts.push(...detectResourceGatingIssues(cycles, simResults, aplText));

  return conflicts;
}

// Pattern A: Resource Competition — data-driven from resource models
function detectResourceCompetition(resources, cycles, simResults) {
  const conflicts = [];
  const st = findScenario(simResults, "st");
  if (!st) return conflicts;
  const fightLength = getFightLength(st);
  if (fightLength <= 0) return conflicts;

  for (const model of resources) {
    if (model.name === "gcds") continue;
    if (model.consumers.length < 2) continue;

    const consumerCasts = model.consumers
      .map((c) => ({ ...c, casts: getCastCount(st, c.ability) }))
      .filter((c) => c.casts > 0);
    if (consumerCasts.length < 2) continue;

    // For maxConsume resources: check if burst consumers are starved
    const burstConsumers = consumerCasts.filter(
      (c) => c.maxConsume && c.maxConsume > 2,
    );
    const continuousConsumers = consumerCasts.filter(
      (c) => !c.maxConsume || c.maxConsume <= 2,
    );

    if (burstConsumers.length > 0 && continuousConsumers.length > 0) {
      const primaryBurst = burstConsumers[0];
      const burstInterval = fightLength / primaryBurst.casts;
      const primaryGen = model.generators.find((g) => g.charges);

      if (primaryGen) {
        const genCasts = getCastCount(st, primaryGen.ability);
        const genPerInterval =
          genCasts > 0
            ? (burstInterval / fightLength) *
              genCasts *
              (primaryGen.amount || 0)
            : 0;
        const continuousConsumed = continuousConsumers.reduce(
          (sum, c) =>
            sum +
            (c.casts / primaryBurst.casts) * (c.maxConsume || c.amount || 0),
          0,
        );
        const netAvailable = genPerInterval - continuousConsumed;

        if (netAvailable < (model.cap || 5) * 0.7) {
          conflicts.push({
            type: "resource_competition",
            description: `${continuousConsumers.map((c) => c.ability).join(", ")} and ${primaryBurst.ability} compete for ${model.name}`,
            detail:
              `Continuous consumers use ~${continuousConsumed.toFixed(1)} ${model.name} between ${primaryBurst.ability} casts. ` +
              `${primaryGen.ability} generates ~${genPerInterval.toFixed(1)} per ${burstInterval.toFixed(0)}s interval. ` +
              `Net available for ${primaryBurst.ability}: ~${Math.max(0, netAvailable).toFixed(1)}`,
            consumers: consumerCasts.map((c) => c.ability),
            resource: model.name,
            severity:
              netAvailable < (model.cap || 5) * 0.35 ? "high" : "medium",
          });
        }
      }
    }

    // General spending vs generation rate check
    let totalSpend = 0;
    for (const c of consumerCasts) {
      totalSpend += c.casts * (c.amount || c.maxConsume || 0);
    }
    const spendPerSec = totalSpend / fightLength;

    let totalGen = 0;
    for (const g of model.generators) {
      const casts = getCastCount(st, g.ability);
      totalGen += casts * (g.amount || 0);
    }
    const genPerSec = totalGen / fightLength;

    if (spendPerSec > genPerSec * 0.9 && genPerSec > 0) {
      conflicts.push({
        type: "resource_competition",
        description: `High ${model.name} consumption rate relative to generation`,
        detail:
          `${model.name} spending: ~${spendPerSec.toFixed(1)}/s. Generation: ~${genPerSec.toFixed(1)}/s. ` +
          `Ratio: ${((spendPerSec / genPerSec) * 100).toFixed(0)}%`,
        consumers: consumerCasts.map((c) => c.ability),
        resource: model.name,
        severity: spendPerSec > genPerSec ? "high" : "low",
      });
    }
  }

  return conflicts;
}

// Pattern B: Cooldown Collisions — data-driven from burstWindows and synergies
function detectCooldownCollisions(cycles, simResults) {
  const conflicts = [];
  const st = findScenario(simResults, "st");
  if (!st) return conflicts;

  const specConfig = getSpecAdapter().getSpecConfig();
  const burstWindows = specConfig.burstWindows || [];
  const synergies = specConfig.synergies || [];

  // Check burst window sync targets for alignment
  for (const window of burstWindows) {
    const windowUptime = getBuffUptime(st, window.buff);
    if (windowUptime === undefined || windowUptime <= 0) continue;

    for (const syncTarget of window.syncTargets || []) {
      const targetCasts = getCastCount(st, syncTarget);
      const windowCasts = getCastCount(st, window.buff);

      if (targetCasts > 0 && windowCasts > 0) {
        const ratio = targetCasts / windowCasts;
        if (ratio < 0.8) {
          conflicts.push({
            type: "burst_window_waste",
            description: `${syncTarget} may not align with ${window.buff} windows`,
            detail:
              `${syncTarget} casts per ${window.buff} window: ~${ratio.toFixed(1)}. ` +
              `${window.buff} uptime: ${windowUptime}%. Sync for ${(window.damageAmp * 100).toFixed(0)}% ${window.school} amp.`,
            abilities: [syncTarget, window.buff],
            severity: "medium",
          });
        }
      }
    }
  }

  // Check synergy pairs for cooldown alignment
  for (const synergy of synergies) {
    const [buffA, buffB] = synergy.buffs;
    const cycleA = cycles.find((c) => c.ability === buffA);
    const cycleB = cycles.find((c) => c.ability === buffB);

    if (cycleA && cycleB) {
      const castsA = getCastCount(st, buffA);
      const castsB = getCastCount(st, buffB);
      const uptimeA = getBuffUptime(st, buffA);

      if (castsA > 0 && castsB > 0 && uptimeA !== undefined) {
        const cdDiff = Math.abs(cycleA.cooldown - cycleB.cooldown);
        if (cdDiff < 5) {
          conflicts.push({
            type: "cooldown_collision",
            description: `${buffA} and ${buffB} share ~${cycleA.cooldown}s cooldown — alignment opportunity`,
            detail:
              `${synergy.reason}. ${buffA} uptime: ${uptimeA}%. ` +
              `Both on similar CDs, should be synced.`,
            abilities: [buffA, buffB],
            severity: "info",
          });
        }
      }
    }
  }

  // Check resource models for generator + consumer collision
  const resourceModels = specConfig.resourceModels || [];
  for (const rm of resourceModels) {
    const burstGen = rm.generators.find(
      (g) => g.cooldown && g.cooldown >= 20 && g.amount >= 2,
    );
    const burstConsumer = rm.consumers.find(
      (c) => c.maxConsume && c.maxConsume >= 3,
    );

    if (burstGen && burstConsumer) {
      const genCasts = getCastCount(st, burstGen.ability);
      if (genCasts > 0) {
        const overflowData = estimateOverflow(st, rm);
        if (overflowData && overflowData.pctOfGenerated > 5) {
          conflicts.push({
            type: "cooldown_collision",
            description: `${burstGen.ability} ${rm.name} generation may overflow during ${burstConsumer.ability} CD`,
            detail:
              `${burstGen.ability} generates ${burstGen.amount} ${rm.name}. ` +
              `Overflow rate: ${overflowData.pctOfGenerated.toFixed(1)}%. ` +
              `Consider sequencing ${burstGen.ability} closer to ${burstConsumer.ability} readiness.`,
            abilities: [burstGen.ability, burstConsumer.ability],
            severity: overflowData.pctOfGenerated > 10 ? "high" : "medium",
          });
        }
      }
    }
  }

  return conflicts;
}

// Pattern C: Burst Window Waste — data-driven from burstWindows
function detectBurstWindowWaste(cycles, simResults) {
  const conflicts = [];
  const st = findScenario(simResults, "st");
  if (!st) return conflicts;

  const specConfig = getSpecAdapter().getSpecConfig();
  const burstWindows = specConfig.burstWindows || [];

  for (const window of burstWindows) {
    const uptime = getBuffUptime(st, window.buff);
    if (uptime === undefined || uptime <= 5) continue;

    // Check if resource bonus during window is being utilized
    if (window.resourceBonus) {
      const rb = window.resourceBonus;
      const abilityCasts = getCastCount(st, rb.ability);
      const fightLength = getFightLength(st);

      if (abilityCasts > 0 && fightLength > 0) {
        const fraction = uptime / 100;
        const expectedCastsDuringWindow = abilityCasts * fraction;
        const extraResource = expectedCastsDuringWindow * rb.bonus;

        if (extraResource > 5) {
          conflicts.push({
            type: "burst_window_waste",
            description: `${window.buff} generates extra ${rb.resource} — optimize spending`,
            detail:
              `~${expectedCastsDuringWindow.toFixed(0)} ${rb.ability} casts during ${window.buff} ` +
              `(${uptime}% uptime). Each generates +${rb.bonus} extra ${rb.resource}. ` +
              `Ensure spenders fire fast enough to avoid overflow during ${window.buff}.`,
            abilities: [rb.ability, window.buff],
            severity: "info",
          });
        }
      }
    }
  }

  return conflicts;
}

// Pattern E: Pooling Opportunities — data-driven from resource models
function detectPoolingOpportunities(resources, cycles, simResults) {
  const conflicts = [];
  const st = findScenario(simResults, "st");
  if (!st) return conflicts;

  for (const model of resources) {
    if (model.name === "gcds") continue;

    const burstConsumer = model.consumers.find(
      (c) => c.maxConsume && c.maxConsume >= 3,
    );
    const continuousConsumer = model.consumers.find(
      (c) => c.maxConsume && c.maxConsume <= 2,
    );
    if (!burstConsumer || !continuousConsumer) continue;

    const burstCasts = getCastCount(st, burstConsumer.ability);
    const fightLength = getFightLength(st);
    if (burstCasts <= 0 || fightLength <= 0) continue;

    const burstAbility = getAbilityData()[burstConsumer.ability];
    const contAbility = getAbilityData()[continuousConsumer.ability];
    const burstApCoeff = burstAbility?.apCoeff || 0;
    const contApCoeff = contAbility?.apCoeff || 0;

    if (burstApCoeff > 0 && contApCoeff > 0) {
      const poolingGain = (continuousConsumer.maxConsume || 2) * burstApCoeff;
      const poolingCost = contApCoeff;
      const netPerPool = poolingGain - poolingCost;
      const totalNet = netPerPool * burstCasts;

      conflicts.push({
        type: "pooling_analysis",
        description: `${model.name} pooling for ${burstConsumer.ability}: cost-benefit analysis`,
        detail:
          `Per pool window: gain ${poolingGain.toFixed(2)} AP (${continuousConsumer.maxConsume} extra ${burstConsumer.ability} ${model.name}) ` +
          `vs lose ${poolingCost.toFixed(2)} AP (skipped ${continuousConsumer.ability}). ` +
          `Net per window: ${netPerPool.toFixed(2)} AP. ` +
          `Over ${burstCasts} casts: ${totalNet.toFixed(1)} AP total. ` +
          `${netPerPool < 0 ? "POOLING NOT WORTH IT" : "Pooling may be beneficial"}.`,
        resource: model.name,
        burstConsumer: burstConsumer.ability,
        continuousConsumer: continuousConsumer.ability,
        costBenefit: {
          gain: poolingGain,
          loss: poolingCost,
          net: netPerPool,
          frequency: burstCasts,
          totalNet,
        },
        severity: netPerPool >= 0 ? "medium" : "info",
        recommendation:
          netPerPool < 0
            ? `DO NOT pool — ${continuousConsumer.ability} opportunity cost exceeds ${burstConsumer.ability} marginal gain`
            : `Consider pooling ${model.name} 2-3s before ${burstConsumer.ability} comes off cooldown`,
      });
    }
  }

  return conflicts;
}

// Pattern: Resource Gating Issues — generic APL-text scanning
function detectResourceGatingIssues(cycles, simResults, aplText) {
  const conflicts = [];
  const st = findScenario(simResults, "st");
  if (!aplText) return conflicts;

  const specConfig = getSpecAdapter().getSpecConfig();
  const resourceModels = specConfig.resourceModels || [];

  // Scan each resource model's generators for resource guards in the APL
  for (const rm of resourceModels) {
    const resourceName = rm.name;
    const cap = rm.cap;

    for (const gen of rm.generators) {
      if (!gen.ability || gen.procRate) continue;
      // Look for resource guards on this generator
      const pattern = new RegExp(
        `${gen.ability}.*?${resourceName}\\s*<=?\\s*(\\d+)`,
      );
      const match = aplText.match(pattern);
      if (!match) continue;

      const threshold = parseInt(match[1], 10);
      if (threshold > cap - 2) continue;

      const casts = getCastCount(st, gen.ability);
      const fightLength = getFightLength(st);
      const cd = gen.cooldown || gen.rechargeCd || 0;
      const theoreticalCasts =
        fightLength > 0 && cd > 0 ? Math.floor(fightLength / cd) : 0;

      if (theoreticalCasts > 0 && casts < theoreticalCasts * 0.85) {
        conflicts.push({
          type: "resource_gating",
          description: `${gen.ability} ${resourceName} guard (<=${threshold}) may be too restrictive`,
          detail:
            `Actual casts: ${casts}, theoretical max: ${theoreticalCasts}. ` +
            `Guard prevents casting when ${resourceName} > ${threshold}. ` +
            `Relaxing to <=${cap - 1} may allow more casts with minimal overflow.`,
          ability: gen.ability,
          resource: resourceName,
          currentThreshold: threshold,
          severity: "medium",
        });
      }
    }
  }

  return conflicts;
}

// Returns the default APL branch (action list name) from the spec config
function getDefaultAplBranch() {
  const specConfig = getSpecAdapter().getSpecConfig();
  const trees = specConfig.heroTrees || {};
  for (const treeConfig of Object.values(trees)) {
    if (treeConfig.aplBranch) return treeConfig.aplBranch;
  }
  return "default";
}

// Find which action list contains an ability by searching the APL text
function findListForAbility(aplText, ability) {
  if (!aplText) return getDefaultAplBranch();
  try {
    const ast = parse(aplText);
    const lists = getActionLists(ast);
    for (const list of lists) {
      if (
        list.entries.some((e) => e.type === "Action" && e.ability === ability)
      ) {
        return list.name;
      }
    }
  } catch {
    // Fall through to default
  }
  return getDefaultAplBranch();
}

// --- Hypothesis Generation ---

export function generateTemporalHypotheses(resourceFlow, aplText) {
  const { resources, cycles, conflicts } = resourceFlow;
  const hypotheses = [];

  for (const conflict of conflicts) {
    if (conflict.costBenefit?.net < -0.5 && conflict.severity !== "high") {
      continue;
    }
    const hypothesis = conflictToHypothesis(conflict, aplText);
    if (hypothesis) hypotheses.push(hypothesis);
  }

  hypotheses.push(...generateCycleAlignmentHypotheses(cycles, aplText));

  const seen = new Set();
  const unique = hypotheses.filter((h) => {
    const key = `${h.category}:${h.target || ""}:${h.hypothesis}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return unique;
}

// Generic conflict-to-hypothesis converter — reads conflict metadata instead of
// matching hardcoded ability names.
function conflictToHypothesis(conflict, aplText) {
  if (conflict.type === "resource_gating") {
    return {
      category: TEMPORAL_CATEGORIES.RESOURCE_GATING,
      hypothesis: `Relax ${conflict.ability} ${conflict.resource} guard (currently <=${conflict.currentThreshold})`,
      observation: conflict.detail,
      target: conflict.ability,
      priority: 7,
      confidence: "medium",
      aplMutation: {
        type: MUTATION_OPS.RELAX_THRESHOLD,
        list: findListForAbility(aplText, conflict.ability),
        ability: conflict.ability,
        resource: conflict.resource,
        reason: conflict.detail,
      },
      temporalAnalysis: {
        resourceFlow: conflict.resource,
        conflictType: "resource_gating",
      },
    };
  }

  if (conflict.type === "resource_competition") {
    const consumers = conflict.consumers || [];
    return {
      category: TEMPORAL_CATEGORIES.TEMPORAL_POOLING,
      hypothesis: `Evaluate ${consumers.join(" vs ")} competition for ${conflict.resource}`,
      observation: conflict.detail,
      target: consumers[0],
      priority: 5,
      confidence: "low",
      temporalAnalysis: {
        resourceFlow: conflict.resource,
        conflictType: "resource_competition",
      },
    };
  }

  if (conflict.type === "cooldown_collision") {
    const abilities = conflict.abilities || [];
    return {
      category: TEMPORAL_CATEGORIES.COOLDOWN_SEQUENCING,
      hypothesis: `Align ${abilities.join(" and ")} for better synergy`,
      observation: conflict.detail,
      target: abilities[0],
      priority: 6,
      confidence: conflict.severity === "info" ? "medium" : "high",
      temporalAnalysis: {
        conflictType: "cooldown_collision",
      },
    };
  }

  if (conflict.type === "burst_window_waste") {
    const abilities = conflict.abilities || [];
    return {
      category: TEMPORAL_CATEGORIES.CYCLE_ALIGNMENT,
      hypothesis: `Optimize ${abilities[0]} usage during ${abilities[1]} window`,
      observation: conflict.detail,
      target: abilities[0],
      priority: 7,
      confidence: "medium",
      temporalAnalysis: {
        conflictType: "burst_window_waste",
      },
    };
  }

  if (conflict.type === "pooling_analysis") {
    const cb = conflict.costBenefit;
    if (!cb) return null;

    const baseAnalysis = {
      resourceFlow: conflict.resource,
      opportunityCost: cb,
    };

    if (cb.net < 0) {
      return {
        category: TEMPORAL_CATEGORIES.TEMPORAL_POOLING,
        hypothesis: `${conflict.resource} pooling for ${conflict.burstConsumer} is NET NEGATIVE (${cb.net.toFixed(2)} AP/window)`,
        observation: conflict.detail,
        target: conflict.burstConsumer,
        priority: 3,
        confidence: "high",
        temporalAnalysis: {
          ...baseAnalysis,
          conflictType: "pooling_rejected",
        },
        counterArgument: conflict.recommendation,
      };
    }

    return {
      category: TEMPORAL_CATEGORIES.TEMPORAL_POOLING,
      hypothesis: `Pool ${conflict.resource} 2-3s before ${conflict.burstConsumer} CD (net +${cb.net.toFixed(2)} AP/window)`,
      observation: conflict.detail,
      target: conflict.continuousConsumer,
      priority: 6,
      confidence: "medium",
      temporalAnalysis: {
        ...baseAnalysis,
        conflictType: "pooling_opportunity",
      },
    };
  }

  return null;
}

// Generate cycle alignment hypotheses from burst windows with sync targets
function generateCycleAlignmentHypotheses(cycles, aplText) {
  const hypotheses = [];
  const specConfig = getSpecAdapter().getSpecConfig();
  const burstWindows = specConfig.burstWindows || [];

  for (const window of burstWindows) {
    if (!window.syncTargets?.length) continue;

    const windowCycle = cycles.find((c) => c.ability === window.buff);
    if (!windowCycle) continue;

    // Check if any sync target shares a similar cooldown
    for (const target of window.syncTargets) {
      const targetCycle = cycles.find((c) => c.ability === target);
      if (!targetCycle) continue;

      hypotheses.push({
        category: TEMPORAL_CATEGORIES.COOLDOWN_SEQUENCING,
        hypothesis: `Cast ${window.buff} before ${target} in cooldown sequence`,
        observation: `${window.buff} (${window.cooldown}s CD, ${window.duration}s duration) enables ${(window.damageAmp * 100).toFixed(0)}% ${window.school} amp. ${target} should fire during this window.`,
        target: window.buff,
        priority: 7,
        confidence: "high",
        aplMutation: {
          type: MUTATION_OPS.MOVE_UP,
          list: findListForAbility(aplText, window.buff),
          ability: window.buff,
          reason: `${window.buff} first enables damage amp for ${target}`,
        },
        temporalAnalysis: {
          resourceFlow: null,
          cycleLength: window.cooldown,
          conflictType: "cooldown_ordering",
          timingWindow: `every ${window.cooldown}s CD cycle`,
        },
      });
    }
  }

  return hypotheses;
}

// --- Sim Result Helpers ---

function findScenario(simResults, scenarioKey) {
  if (!simResults) return null;
  const scenarios = Array.isArray(simResults)
    ? simResults
    : simResults.scenarios || [];
  return scenarios.find((s) => s.scenario === scenarioKey && !s.error) || null;
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

function getFightLength(scenario) {
  if (!scenario) return 0;
  return scenario.fightLength || scenario.fight_length || 300; // default 5 min
}

function getBuffUptime(scenario, buffName) {
  if (!scenario) return undefined;

  if (scenario.buffUptimes?.[buffName] !== undefined) {
    return scenario.buffUptimes[buffName];
  }

  const buff = scenario.buffs?.find((b) => b.name === buffName);
  return buff?.uptime;
}

function estimateResourceFlow(scenario, resourceName, model) {
  const fightLength = getFightLength(scenario);
  if (fightLength <= 0) return null;

  // Find burst window that grants resource bonus for this resource
  const specConfig = getSpecAdapter().getSpecConfig();
  const bonusWindow = (specConfig.burstWindows || []).find(
    (w) => w.resourceBonus?.resource === resourceName,
  );
  const bonusUptime = bonusWindow
    ? (getBuffUptime(scenario, bonusWindow.buff) || 0) / 100
    : 0;

  let totalGen = 0;
  for (const gen of model.generators) {
    const casts = getCastCount(scenario, gen.ability);
    if (casts > 0) {
      const baseAmount = gen.amount || 0;
      const metaAmount = gen.amountMeta || baseAmount;
      const effective =
        baseAmount * (1 - bonusUptime) + metaAmount * bonusUptime;
      totalGen += casts * effective;
    }
  }

  let totalConsume = 0;
  for (const con of model.consumers) {
    const casts = getCastCount(scenario, con.ability);
    if (casts > 0) {
      const amount =
        typeof con.amount === "number" ? con.amount : con.maxConsume || 0;
      totalConsume += casts * amount;
    }
  }

  return {
    generationPerMin: (totalGen / fightLength) * 60,
    consumptionPerMin: (totalConsume / fightLength) * 60,
    netPerMin: ((totalGen - totalConsume) / fightLength) * 60,
  };
}

function normalizeAbilityName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

// --- Printing ---

export function printTemporalAnalysis(resourceFlow) {
  const { resources, cycles, conflicts } = resourceFlow;

  console.log("\n" + "=".repeat(70));
  console.log("Temporal Resource Flow Analysis");
  console.log("=".repeat(70));

  // Resource Flow Summary
  console.log("\n--- Resource Flow Summary ---\n");
  for (const r of resources) {
    console.log(`${r.name} (cap: ${r.cap || "n/a"})`);
    console.log(
      `  Generators: ${r.generators.map((g) => g.ability).join(", ")}`,
    );
    console.log(`  Consumers: ${r.consumers.map((c) => c.ability).join(", ")}`);
    if (r.flowRate) {
      console.log(
        `  Flow: +${r.flowRate.generationPerMin?.toFixed(0) || "?"}/min generated, ` +
          `-${r.flowRate.consumptionPerMin?.toFixed(0) || "?"}/min consumed, ` +
          `net ${r.flowRate.netPerMin?.toFixed(0) || "?"}/min`,
      );
    }
    if (r.overflowRate) {
      console.log(
        `  Overflow: ~${r.overflowRate.estimated} frags (~${r.overflowRate.pctOfGenerated.toFixed(1)}% of generated)`,
      );
    }
    console.log();
  }

  // Cooldown Cycles
  console.log("--- Cooldown Cycles ---\n");
  for (const c of cycles) {
    console.log(
      `${c.ability} (${c.cooldown}s CD, ${c.gcdsPerCycle} GCDs/cycle)`,
    );
    if (c.simCasts !== null && c.simCasts > 0) {
      console.log(`  Sim casts: ${c.simCasts}`);
    }
    if (c.resourceBudget) {
      const b = c.resourceBudget;
      const parts = Object.entries(b)
        .filter(([k]) => k.endsWith("Generated"))
        .map(([k, v]) => `~${v} ${k.replace("Generated", "")}`);
      if (parts.length > 0) {
        console.log(`  Budget: ${parts.join(", ")} per cycle`);
      }
    }
    console.log();
  }

  // Timing Conflicts
  console.log("--- Timing Conflicts ---\n");
  if (conflicts.length === 0) {
    console.log("No timing conflicts detected.\n");
  } else {
    for (const c of conflicts) {
      const severity = c.severity || "info";
      console.log(`[${severity.toUpperCase()}] ${c.description}`);
      console.log(`  ${c.detail}`);
      if (c.costBenefit) {
        const cb = c.costBenefit;
        console.log(
          `  Cost-benefit: gain ${cb.gain.toFixed(2)} AP, lose ${cb.loss.toFixed(2)} AP, net ${cb.net >= 0 ? "+" : ""}${cb.net.toFixed(2)} AP`,
        );
      }
      if (c.recommendation) {
        console.log(`  Recommendation: ${c.recommendation}`);
      }
      console.log();
    }
  }
}

export function printTemporalHypotheses(hypotheses) {
  if (hypotheses.length === 0) {
    console.log("No temporal hypotheses generated.\n");
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Temporal Hypotheses (${hypotheses.length} total)`);
  console.log("=".repeat(70));

  for (const h of hypotheses) {
    console.log(`\n[${h.confidence || "medium"}] ${h.hypothesis}`);
    console.log(`  Category: ${h.category}`);
    console.log(`  Observation: ${h.observation.slice(0, 120)}`);
    if (h.temporalAnalysis) {
      const ta = h.temporalAnalysis;
      if (ta.cycleLength) console.log(`  Cycle: ${ta.cycleLength}s`);
      if (ta.timingWindow) console.log(`  Window: ${ta.timingWindow}`);
      if (ta.opportunityCost) {
        const oc = ta.opportunityCost;
        console.log(
          `  Opp. cost: gain ${oc.gain.toFixed(2)}, loss ${oc.loss.toFixed(2)}, net ${oc.net >= 0 ? "+" : ""}${oc.net.toFixed(2)}`,
        );
      }
    }
    if (h.counterArgument) console.log(`  Counter: ${h.counterArgument}`);
    if (h.prediction) console.log(`  Prediction: ${h.prediction}`);
    if (h.aplMutation) {
      console.log(
        `  Mutation: ${h.aplMutation.type} on ${h.aplMutation.ability || h.aplMutation.list}`,
      );
    }
    console.log(`  Priority: ${(h.priority || 0).toFixed(1)}`);
  }
}

// --- CLI Entry Point ---

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadSpecAdapter();
  const resultsPath = process.argv[2];
  const aplPath = process.argv[3];

  if (!resultsPath && !aplPath) {
    console.log(
      "Usage: node src/analyze/theorycraft.js [workflow-results.json] [apl.simc]",
    );
    console.log("");
    console.log(
      "Runs temporal resource flow analysis and generates hypotheses.",
    );
    console.log(
      "If no arguments, runs with spell data only (theoretical analysis).",
    );
    process.exit(0);
  }

  let simResults = null;
  if (resultsPath && existsSync(resultsPath)) {
    simResults = JSON.parse(readFileSync(resultsPath, "utf-8"));
  }

  let aplText = null;
  if (aplPath && existsSync(aplPath)) {
    aplText = readFileSync(aplPath, "utf-8");
  }

  const spellDataPath = dataFile("spells.json");
  const spellData = existsSync(spellDataPath)
    ? JSON.parse(readFileSync(spellDataPath, "utf-8"))
    : [];

  const resourceFlow = analyzeResourceFlow(spellData, aplText, simResults);
  printTemporalAnalysis(resourceFlow);

  const hypotheses = generateTemporalHypotheses(resourceFlow, aplText);
  printTemporalHypotheses(hypotheses);

  console.log("\n--- JSON Output (top 5) ---");
  console.log(JSON.stringify(hypotheses.slice(0, 5), null, 2));
}
