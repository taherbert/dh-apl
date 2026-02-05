// Temporal resource flow analysis — generates testable hypotheses about timing,
// pooling, and cycle management that static priority analysis misses.
// Usage: node src/analyze/theorycraft.js [workflow-results.json] [apl.simc]

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTATION_OPS } from "../apl/mutator.js";
import {
  loadAbilityData as loadAbilityDataFromConfig,
  getSpecConfig,
  getResourceFlow,
} from "../config/spec-abilities.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

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
let currentSpecId = "vengeance";

export function setSpecId(specId) {
  currentSpecId = specId;
}

// Load ability data from spec config (abstracts hardcoded values)
function loadAbilityData() {
  return loadAbilityDataFromConfig(currentSpecId);
}

const ABILITY_DATA = loadAbilityData();

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

  // Fury model
  const furyModel = {
    name: "fury",
    cap: 120,
    generators: [],
    consumers: [],
    flowRate: null,
    overflowRate: null,
  };

  furyModel.generators.push(
    {
      ability: "fracture",
      amount: ABILITY_DATA.fracture.furyGen,
      amountMeta: ABILITY_DATA.fracture.furyGenMeta,
      rechargeCd: ABILITY_DATA.fracture.rechargeCd,
      charges: ABILITY_DATA.fracture.charges,
    },
    {
      ability: "immolation_aura",
      amount:
        ABILITY_DATA.immolation_aura.furyPerTick *
        ABILITY_DATA.immolation_aura.duration,
      cooldown: ABILITY_DATA.immolation_aura.rechargeCd,
      charges: ABILITY_DATA.immolation_aura.charges,
      perTick: true,
    },
  );

  furyModel.consumers.push(
    {
      ability: "spirit_bomb",
      amount: ABILITY_DATA.spirit_bomb.furyCost,
      cooldown: ABILITY_DATA.spirit_bomb.cooldown,
    },
    {
      ability: "soul_cleave",
      amount: ABILITY_DATA.soul_cleave.furyCost,
      cooldown: 0,
    },
    {
      ability: "fel_devastation",
      amount: ABILITY_DATA.fel_devastation.furyCost,
      cooldown: ABILITY_DATA.fel_devastation.cooldown,
    },
  );

  if (simResults) {
    const st = findScenario(simResults, "st");
    if (st) {
      furyModel.flowRate = estimateResourceFlow(st, "fury", furyModel);
    }
  }

  models.push(furyModel);

  // Soul Fragments model
  const fragModel = {
    name: "soul_fragments",
    cap: 6,
    generators: [],
    consumers: [],
    flowRate: null,
    overflowRate: null,
  };

  fragModel.generators.push(
    {
      ability: "fracture",
      amount: ABILITY_DATA.fracture.fragGen,
      amountMeta: ABILITY_DATA.fracture.fragGenMeta,
      rechargeCd: ABILITY_DATA.fracture.rechargeCd,
      charges: ABILITY_DATA.fracture.charges,
    },
    {
      ability: "soul_carver",
      amount: ABILITY_DATA.soul_carver.fragGen,
      cooldown: ABILITY_DATA.soul_carver.cooldown,
    },
    {
      ability: "sigil_of_spite",
      amount: 3, // approximate average
      cooldown: ABILITY_DATA.sigil_of_spite.cooldown,
    },
    {
      ability: "fallout",
      procRate: 0.6, // 60% per IA tick in AoE, 100% ST
      source: "immolation_aura",
      perTick: true,
    },
  );

  fragModel.consumers.push(
    {
      ability: "spirit_bomb",
      amount: "up_to_5",
      maxConsume: 5,
      cooldown: ABILITY_DATA.spirit_bomb.cooldown,
      valuePerUnit: "+20% damage per fragment",
    },
    {
      ability: "soul_cleave",
      amount: "up_to_2",
      maxConsume: 2,
      cooldown: 0,
      valuePerUnit: "healing + Soul Furnace stacks",
    },
  );

  if (simResults) {
    const st = findScenario(simResults, "st");
    if (st) {
      fragModel.flowRate = estimateResourceFlow(
        st,
        "soul_fragments",
        fragModel,
      );
      fragModel.overflowRate = estimateFragmentOverflow(st);
    }
  }

  models.push(fragModel);

  // GCD model
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

function buildCooldownCycles(spellData, simResults) {
  const cdAbilities = Object.entries(ABILITY_DATA)
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
  const { rechargeCd, furyGen, fragGen } = ABILITY_DATA.fracture;
  const fracturesPerCycle = Math.floor(ability.cooldown / rechargeCd);

  return {
    furyGenerated: fracturesPerCycle * furyGen,
    fragsGenerated: fracturesPerCycle * fragGen,
    gcdsAvailable: gcdsPerCycle,
    fracturesEstimated: fracturesPerCycle,
  };
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

// Pattern A: Resource Competition
function detectResourceCompetition(resources, cycles, simResults) {
  const conflicts = [];
  const fragModel = resources.find((r) => r.name === "soul_fragments");
  if (!fragModel) return conflicts;

  const sbCycle = cycles.find((c) => c.ability === "spirit_bomb");
  if (!sbCycle) return conflicts;

  // SC (continuous consumer) vs SBomb (burst consumer every 25s)
  const st = findScenario(simResults, "st");
  const sbCasts = getCastCount(st, "spirit_bomb");
  const scCasts = getCastCount(st, "soul_cleave");
  const fightLength = getFightLength(st);

  if (sbCasts > 0 && scCasts > 0 && fightLength > 0) {
    // Estimate average fragments consumed by SC between SBomb casts
    const sbInterval = fightLength / sbCasts;
    const scBetweenSb = scCasts / sbCasts;
    const fragsConsumedBySc = scBetweenSb * 2; // up to 2 per SC

    // If SC consumes more frags than are generated between SBombs, SBomb may cast at low frags
    const fragsGenPerInterval =
      (sbInterval / ABILITY_DATA.fracture.rechargeCd) *
      ABILITY_DATA.fracture.fragGen;
    const netFrags = fragsGenPerInterval - fragsConsumedBySc;

    if (netFrags < 4) {
      conflicts.push({
        type: "resource_competition",
        description: "Soul Cleave and Spirit Bomb compete for Soul Fragments",
        detail:
          `SC consumes ~${fragsConsumedBySc.toFixed(1)} frags between SBomb casts. ` +
          `Fracture generates ~${fragsGenPerInterval.toFixed(1)} frags per ${sbInterval.toFixed(0)}s interval. ` +
          `Net fragments available for SBomb: ~${Math.max(0, netFrags).toFixed(1)}`,
        consumers: ["soul_cleave", "spirit_bomb"],
        resource: "soul_fragments",
        severity: netFrags < 2 ? "high" : "medium",
      });
    }
  }

  // Fury competition: SBomb (40) + SC (35) + FelDev (50) all draw from fury
  const furyModel = resources.find((r) => r.name === "fury");
  if (furyModel) {
    const felDevCasts = getCastCount(st, "fel_devastation");
    if (sbCasts > 0 && felDevCasts > 0 && fightLength > 0) {
      const totalFuryCost = sbCasts * 40 + scCasts * 35 + felDevCasts * 50;
      const furyPerSec = totalFuryCost / fightLength;
      // Estimate fury gen from Fracture casts
      const fracCasts = getCastCount(st, "fracture");
      const furyGen =
        fracCasts > 0
          ? (fracCasts * ABILITY_DATA.fracture.furyGen) / fightLength
          : 0;

      if (furyPerSec > furyGen * 0.9) {
        conflicts.push({
          type: "resource_competition",
          description: "High fury consumption rate relative to generation",
          detail:
            `Fury spending: ~${furyPerSec.toFixed(1)}/s. Generation: ~${furyGen.toFixed(1)}/s. ` +
            `Ratio: ${((furyPerSec / (furyGen || 1)) * 100).toFixed(0)}%`,
          consumers: ["spirit_bomb", "soul_cleave", "fel_devastation"],
          resource: "fury",
          severity: furyPerSec > furyGen ? "high" : "low",
        });
      }
    }
  }

  return conflicts;
}

// Pattern B: Cooldown Collisions
function detectCooldownCollisions(cycles, simResults) {
  const conflicts = [];
  const st = findScenario(simResults, "st");

  const soulCarverCycle = cycles.find((c) => c.ability === "soul_carver");
  const sbCycle = cycles.find((c) => c.ability === "spirit_bomb");

  if (soulCarverCycle && sbCycle) {
    // Soul Carver generates 3 frags. If SBomb is on CD when Carver fires,
    // those frags may overflow before SBomb is ready.
    const carverCasts = getCastCount(st, "soul_carver");
    const fightLength = getFightLength(st);

    if (carverCasts > 0 && fightLength > 0) {
      // Check if fragment overflow correlates with Carver timing
      const fragOverflow = estimateFragmentOverflow(st);
      if (fragOverflow && fragOverflow.pctOfGenerated > 5) {
        conflicts.push({
          type: "cooldown_collision",
          description:
            "Soul Carver fragment generation may overflow during Spirit Bomb CD",
          detail:
            `Soul Carver generates 3 fragments. SBomb CD is 25s. ` +
            `Fragment overflow rate: ${fragOverflow.pctOfGenerated.toFixed(1)}%. ` +
            `Consider sequencing Carver closer to SBomb readiness.`,
          abilities: ["soul_carver", "spirit_bomb"],
          severity: fragOverflow.pctOfGenerated > 10 ? "high" : "medium",
        });
      }
    }
  }

  // Fiery Brand (60s) + Soul Carver (60s) — same CD, should be synced
  const brandCycle = cycles.find((c) => c.ability === "fiery_brand");
  if (brandCycle && soulCarverCycle) {
    const brandUptime = getBuffUptime(st, "fiery_brand");
    const carverCasts = getCastCount(st, "soul_carver");
    if (brandUptime !== undefined && carverCasts > 0) {
      // Both 60s CDs — should be used together for Fiery Demise synergy
      conflicts.push({
        type: "cooldown_collision",
        description:
          "Fiery Brand and Soul Carver share 60s cooldown — alignment opportunity",
        detail:
          `Both on 60s CD. Fiery Brand uptime: ${brandUptime}%. ` +
          `Soul Carver should fire during Brand for Fiery Demise amp.`,
        abilities: ["fiery_brand", "soul_carver"],
        severity: "info",
      });
    }
  }

  return conflicts;
}

// Pattern C: Burst Window Waste
function detectBurstWindowWaste(cycles, simResults) {
  const conflicts = [];
  const st = findScenario(simResults, "st");
  if (!st) return conflicts;

  // Check if high-damage abilities fire outside damage amp windows
  const brandUptime = getBuffUptime(st, "fiery_brand");
  const metaUptime = getBuffUptime(st, "metamorphosis");

  // If Brand is up but Fel Dev isn't being used during it
  if (brandUptime !== undefined && brandUptime > 5) {
    const felDevCasts = getCastCount(st, "fel_devastation");
    const brandCasts = getCastCount(st, "fiery_brand");
    const fightLength = getFightLength(st);

    if (felDevCasts > 0 && brandCasts > 0 && fightLength > 0) {
      // Expected FelDev casts during Brand = brandUptime% * felDevCasts
      // If FelDev CD (40s) < Brand CD (60s), not all FelDevs can be in Brand
      const felDevPerBrand = felDevCasts / brandCasts;
      if (felDevPerBrand < 0.8) {
        conflicts.push({
          type: "burst_window_waste",
          description: "Fel Devastation may not align with Fiery Brand windows",
          detail:
            `FelDev casts per Brand window: ~${felDevPerBrand.toFixed(1)}. ` +
            `Brand uptime: ${brandUptime}%. FelDev should sync with Brand for 15% Fire amp.`,
          abilities: ["fel_devastation", "fiery_brand"],
          severity: "medium",
        });
      }
    }
  }

  // Meta window utilization
  if (metaUptime !== undefined && metaUptime > 5) {
    const fracCasts = getCastCount(st, "fracture");
    const fightLength = getFightLength(st);
    if (fracCasts > 0 && fightLength > 0) {
      // During Meta, Fracture generates 3 frags instead of 2.
      // High-value: extra frag gen should translate to more spender casts
      const metaDuration = ABILITY_DATA.metamorphosis.duration;
      const metaFraction = metaUptime / 100;
      const expectedMetaFractures = fracCasts * metaFraction;
      const extraFragsFromMeta = expectedMetaFractures; // +1 frag per Fracture in Meta

      if (extraFragsFromMeta > 5) {
        conflicts.push({
          type: "burst_window_waste",
          description:
            "Metamorphosis generates extra fragments — optimize spending",
          detail:
            `~${expectedMetaFractures.toFixed(0)} Fractures during Meta ` +
            `(${metaUptime}% uptime). Each generates +1 extra fragment. ` +
            `Ensure spenders fire fast enough to avoid overflow during Meta.`,
          abilities: ["fracture", "metamorphosis"],
          severity: "info",
        });
      }
    }
  }

  return conflicts;
}

// Pattern E: Pooling Opportunities
function detectPoolingOpportunities(resources, cycles, simResults) {
  const conflicts = [];
  const st = findScenario(simResults, "st");
  if (!st) return conflicts;

  const sbCycle = cycles.find((c) => c.ability === "spirit_bomb");
  if (!sbCycle) return conflicts;

  // Evaluate: should we pool fragments for SBomb?
  // Cost: skip 1 Soul Cleave to save 2 frags
  // Benefit: SBomb at 5 frags instead of 3
  const sbApCoeff = ABILITY_DATA.spirit_bomb.apCoeff; // 0.4 per frag
  const scApCoeff = ABILITY_DATA.soul_cleave.apCoeff; // 1.29

  // Value of 2 extra frags in SBomb vs 1 Soul Cleave
  const poolingGain = 2 * sbApCoeff; // +0.8 AP per SBomb from 2 extra frags
  const poolingCost = scApCoeff; // 1.29 AP from skipped SC

  const sbCasts = getCastCount(st, "spirit_bomb");
  const fightLength = getFightLength(st);

  if (sbCasts > 0 && fightLength > 0) {
    // How often would pooling apply? Roughly 1 pool window per SBomb cast
    const netPerPool = poolingGain - poolingCost;
    const totalNet = netPerPool * sbCasts;

    conflicts.push({
      type: "pooling_analysis",
      description: "Fragment pooling for Spirit Bomb: cost-benefit analysis",
      detail:
        `Per pool window: gain ${poolingGain.toFixed(2)} AP (2 extra SBomb frags) ` +
        `vs lose ${poolingCost.toFixed(2)} AP (skipped SC). ` +
        `Net per window: ${netPerPool.toFixed(2)} AP. ` +
        `Over ${sbCasts} SBombs: ${totalNet.toFixed(1)} AP total. ` +
        `${netPerPool < 0 ? "POOLING NOT WORTH IT" : "Pooling may be beneficial"}.`,
      resource: "soul_fragments",
      costBenefit: {
        gain: poolingGain,
        loss: poolingCost,
        net: netPerPool,
        frequency: sbCasts,
        totalNet,
      },
      severity: netPerPool >= 0 ? "medium" : "info",
      recommendation:
        netPerPool < 0
          ? "DO NOT pool — Soul Cleave opportunity cost exceeds Spirit Bomb marginal gain"
          : "Consider pooling fragments 2-3s before Spirit Bomb comes off cooldown",
    });
  }

  return conflicts;
}

// Pattern: Resource Gating Issues
function detectResourceGatingIssues(cycles, simResults, aplText) {
  const conflicts = [];
  const st = findScenario(simResults, "st");

  // Look for resource guards in APL conditions that may be too restrictive
  if (aplText) {
    // Sigil of Spite fragment guard
    const spiteMatch = aplText.match(
      /sigil_of_spite.*?soul_fragments\s*<=?\s*(\d+)/,
    );
    if (spiteMatch) {
      const threshold = parseInt(spiteMatch[1], 10);
      if (threshold <= 3) {
        const spiteCasts = getCastCount(st, "sigil_of_spite");
        const fightLength = getFightLength(st);
        const theoreticalCasts =
          fightLength > 0
            ? Math.floor(fightLength / ABILITY_DATA.sigil_of_spite.cooldown)
            : 0;

        if (spiteCasts < theoreticalCasts * 0.85) {
          conflicts.push({
            type: "resource_gating",
            description: `Sigil of Spite fragment guard (<=\u200B${threshold}) may be too restrictive`,
            detail:
              `Actual casts: ${spiteCasts}, theoretical max: ${theoreticalCasts}. ` +
              `Guard prevents casting when fragments > ${threshold}, but Spite generates fragments itself. ` +
              `Relaxing to <=5 may allow more casts with minimal overflow.`,
            ability: "sigil_of_spite",
            resource: "soul_fragments",
            currentThreshold: threshold,
            severity: "medium",
          });
        }
      }
    }

    // Fracture overflow guard
    const fractureGuard = aplText.match(
      /fracture.*?soul_fragments\s*<=?\s*(\d+)/,
    );
    if (fractureGuard) {
      const threshold = parseInt(fractureGuard[1], 10);
      if (threshold <= 4) {
        const fracCasts = getCastCount(st, "fracture");
        const fightLength = getFightLength(st);
        // At cap 6, with 2 frags per Fracture, guard at <=4 means
        // you can always Fracture without overflow. But the opportunity cost
        // of NOT fracturing (losing fury gen) may exceed overflow cost.
        conflicts.push({
          type: "resource_gating",
          description: `Fracture fragment guard (<=\u200B${threshold}) may cost DPS`,
          detail:
            `Fragment cap is 6, Fracture generates 2 (3 in Meta). ` +
            `Guard at <=\u200B${threshold} prevents Fracture at ${threshold + 1}+ frags. ` +
            `But Fracture is the primary fury generator — blocking it delays spenders.`,
          ability: "fracture",
          resource: "soul_fragments",
          currentThreshold: threshold,
          severity: "high",
        });
      }
    }
  }

  return conflicts;
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
    if (hypothesis) {
      hypotheses.push(hypothesis);
    }
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

function conflictToHypothesis(conflict, aplText) {
  const generators = {
    resource_gating: resourceGatingHypothesis,
    resource_competition: resourceCompetitionHypothesis,
    cooldown_collision: cooldownCollisionHypothesis,
    burst_window_waste: burstWindowHypothesis,
    pooling_analysis: poolingHypothesis,
  };

  return generators[conflict.type]?.(conflict) || null;
}

function resourceGatingHypothesis(conflict) {
  if (conflict.ability === "sigil_of_spite") {
    return {
      category: TEMPORAL_CATEGORIES.RESOURCE_GATING,
      hypothesis: `Relax Sigil of Spite fragment guard from <=${conflict.currentThreshold} to <=5`,
      observation: conflict.detail,
      target: "sigil_of_spite",
      priority: 7,
      confidence: "medium",
      aplMutation: {
        type: MUTATION_OPS.RELAX_THRESHOLD,
        list: "ar",
        ability: "sigil_of_spite",
        resource: "soul_fragments",
        adjustment: -(5 - conflict.currentThreshold), // negative = relax (increase threshold)
        reason: conflict.detail,
      },
      temporalAnalysis: {
        resourceFlow: "soul_fragments",
        cycleLength: ABILITY_DATA.sigil_of_spite.cooldown,
        conflictType: "resource_gating",
        timingWindow: "any time during 60s cycle",
      },
      prediction:
        "+0.2-0.4% DPS from more frequent Spite casts, slight increase in frag overflow",
    };
  }

  if (conflict.ability === "fracture") {
    return {
      category: TEMPORAL_CATEGORIES.RESOURCE_GATING,
      hypothesis: `Remove or relax Fracture fragment guard (currently <=${conflict.currentThreshold})`,
      observation: conflict.detail,
      target: "fracture",
      priority: 9,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.REMOVE_CONDITION,
        list: "ar",
        ability: "fracture",
        targetBuff: "soul_fragments", // will match soul_fragments conditions
        reason:
          "Fracture is the primary fury generator — blocking it delays spenders more than overflow costs",
      },
      temporalAnalysis: {
        resourceFlow: "soul_fragments",
        cycleLength: ABILITY_DATA.fracture.rechargeCd,
        conflictType: "resource_gating",
        timingWindow: "continuous — Fracture is charge-based",
      },
      prediction:
        "+5-10% DPS from unblocked fury generation, offset by minor fragment overflow",
    };
  }

  return null;
}

function resourceCompetitionHypothesis(conflict) {
  if (conflict.resource === "soul_fragments") {
    return {
      category: TEMPORAL_CATEGORIES.TEMPORAL_POOLING,
      hypothesis:
        "Evaluate Soul Cleave fragment consumption rate vs Spirit Bomb needs",
      observation: conflict.detail,
      target: "soul_cleave",
      priority: 5,
      confidence: "low",
      temporalAnalysis: {
        resourceFlow: "soul_fragments",
        conflictType: "resource_competition",
        timingWindow: `${ABILITY_DATA.spirit_bomb.cooldown}s Spirit Bomb cycle`,
      },
      prediction:
        "Marginal — pooling analysis typically shows net-negative for SC restriction",
    };
  }

  return null;
}

function cooldownCollisionHypothesis(conflict) {
  if (
    conflict.abilities?.includes("soul_carver") &&
    conflict.abilities?.includes("spirit_bomb")
  ) {
    return {
      category: TEMPORAL_CATEGORIES.COOLDOWN_SEQUENCING,
      hypothesis:
        "Sequence Soul Carver to fire 1-2 GCDs before Spirit Bomb is ready",
      observation: conflict.detail,
      target: "soul_carver",
      priority: 6,
      confidence: "medium",
      aplMutation: {
        type: MUTATION_OPS.ADD_CONDITION,
        list: "ar",
        ability: "soul_carver",
        condition: "cooldown.spirit_bomb.remains<3",
        operator: "&",
        allowFallback: true,
        reason:
          "Sync Soul Carver fragment generation with Spirit Bomb readiness",
      },
      temporalAnalysis: {
        resourceFlow: "soul_fragments",
        cycleLength: 60,
        conflictType: "cooldown_collision",
        timingWindow: "3s before SBomb comes off CD",
      },
      prediction:
        "+0.1-0.3% from better fragment utilization, risk of delaying Carver",
    };
  }

  if (
    conflict.abilities?.includes("fiery_brand") &&
    conflict.abilities?.includes("soul_carver")
  ) {
    return {
      category: TEMPORAL_CATEGORIES.COOLDOWN_SEQUENCING,
      hypothesis:
        "Ensure Soul Carver fires during Fiery Brand for Fiery Demise amp",
      observation: conflict.detail,
      target: "soul_carver",
      priority: 7,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.ADD_CONDITION,
        list: "ar",
        ability: "soul_carver",
        condition: "dot.fiery_brand.remains>3",
        operator: "&",
        allowFallback: true,
        reason:
          "Soul Carver benefits from Fiery Demise — use with 3+ sec Brand remaining",
      },
      temporalAnalysis: {
        resourceFlow: null,
        cycleLength: 60,
        conflictType: "cooldown_sync",
        timingWindow: "during Fiery Brand (10s window every 60s)",
      },
      prediction: "+0.3-0.6% from Fiery Demise amp on Soul Carver damage",
    };
  }

  return null;
}

function burstWindowHypothesis(conflict) {
  if (
    conflict.abilities?.includes("fel_devastation") &&
    conflict.abilities?.includes("fiery_brand")
  ) {
    return {
      category: TEMPORAL_CATEGORIES.COOLDOWN_SEQUENCING,
      hypothesis:
        "Sync Fel Devastation with Fiery Brand for 15% Fire damage amp",
      observation: conflict.detail,
      target: "fel_devastation",
      priority: 6,
      confidence: "medium",
      aplMutation: {
        type: MUTATION_OPS.ADD_CONDITION,
        list: "ar",
        ability: "fel_devastation",
        condition: "dot.fiery_brand.ticking",
        operator: "&",
        allowFallback: true,
        reason:
          "Prefer Fel Devastation during Fiery Brand for Fiery Demise amp",
      },
      temporalAnalysis: {
        resourceFlow: null,
        cycleLength: 40,
        conflictType: "burst_window_waste",
        timingWindow: "during Fiery Brand window",
      },
      prediction: "+0.2-0.5% from Fiery Demise amp on FelDev",
    };
  }

  if (
    conflict.abilities?.includes("fracture") &&
    conflict.abilities?.includes("metamorphosis")
  ) {
    return {
      category: TEMPORAL_CATEGORIES.CYCLE_ALIGNMENT,
      hypothesis:
        "Prioritize Fracture during Metamorphosis for +1 extra fragment per cast",
      observation: conflict.detail,
      target: "fracture",
      priority: 8,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.MOVE_UP,
        list: "ar",
        ability: "fracture",
        condition: "buff.metamorphosis.up",
        reason:
          "Fracture generates 3 frags during Meta (not 2) — prioritize for resource acceleration",
      },
      temporalAnalysis: {
        resourceFlow: "soul_fragments",
        cycleLength: 120,
        conflictType: "burst_window_utilization",
        timingWindow: `during Metamorphosis (${ABILITY_DATA.metamorphosis.duration}s window)`,
      },
      prediction:
        "+3-5% DPS from maximizing fragment generation during Meta windows",
    };
  }

  return null;
}

function poolingHypothesis(conflict) {
  const cb = conflict.costBenefit;
  if (!cb) return null;

  const sbCooldown = ABILITY_DATA.spirit_bomb.cooldown;
  const baseAnalysis = {
    resourceFlow: "soul_fragments",
    cycleLength: sbCooldown,
    opportunityCost: cb,
  };

  if (cb.net < 0) {
    return {
      category: TEMPORAL_CATEGORIES.TEMPORAL_POOLING,
      hypothesis: `Fragment pooling for Spirit Bomb is NET NEGATIVE (${cb.net.toFixed(2)} AP/window)`,
      observation: conflict.detail,
      target: "spirit_bomb",
      priority: 3,
      confidence: "high",
      temporalAnalysis: { ...baseAnalysis, conflictType: "pooling_rejected" },
      counterArgument: conflict.recommendation,
      prediction: `Pooling would lose ~${Math.abs(cb.totalNet).toFixed(1)} AP over the fight`,
    };
  }

  return {
    category: TEMPORAL_CATEGORIES.TEMPORAL_POOLING,
    hypothesis: `Pool fragments 2-3s before Spirit Bomb CD (net +${cb.net.toFixed(2)} AP/window)`,
    observation: conflict.detail,
    target: "soul_cleave",
    priority: 6,
    confidence: "medium",
    aplMutation: {
      type: MUTATION_OPS.ADD_CONDITION,
      list: "ar",
      ability: "soul_cleave",
      condition: "cooldown.spirit_bomb.remains>3|soul_fragments<=3",
      operator: "&",
      reason: "Pool fragments when Spirit Bomb is almost ready",
    },
    temporalAnalysis: { ...baseAnalysis, conflictType: "pooling_opportunity" },
    prediction: `+${cb.totalNet.toFixed(1)} AP over fight from better SBomb fragment counts`,
  };
}

function generateCycleAlignmentHypotheses(cycles, aplText) {
  const hypotheses = [];

  // Brand-first ordering: Brand before other 60s CDs
  const brandCycle = cycles.find((c) => c.ability === "fiery_brand");
  const carverCycle = cycles.find((c) => c.ability === "soul_carver");

  if (brandCycle && carverCycle) {
    hypotheses.push({
      category: TEMPORAL_CATEGORIES.COOLDOWN_SEQUENCING,
      hypothesis:
        "Cast Fiery Brand before Soul Carver/FelDev in cooldown sequence",
      observation: `Brand (60s CD, 10s duration) enables 15% Fire amp. Other cooldowns should fire during this window.`,
      target: "fiery_brand",
      priority: 7,
      confidence: "high",
      aplMutation: {
        type: MUTATION_OPS.MOVE_UP,
        list: "ar",
        ability: "fiery_brand",
        reason: "Brand first enables Fiery Demise amp for subsequent cooldowns",
      },
      temporalAnalysis: {
        resourceFlow: null,
        cycleLength: 60,
        conflictType: "cooldown_ordering",
        timingWindow: "every 60s CD cycle",
      },
      prediction:
        "+0.3-0.6% from Fiery Demise amplification of Soul Carver and FelDev",
    });
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

  const metaUptime = (getBuffUptime(scenario, "metamorphosis") || 0) / 100;

  let totalGen = 0;
  for (const gen of model.generators) {
    const casts = getCastCount(scenario, gen.ability);
    if (casts > 0) {
      const baseAmount = gen.amount || 0;
      const metaAmount = gen.amountMeta || baseAmount;
      const effective = baseAmount * (1 - metaUptime) + metaAmount * metaUptime;
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

// Approximate overflow — does not account for Fallout procs, Sigil of Spite
// generation, or Meta bonus (+1 frag per Fracture). Use sim logs for precision.
function estimateFragmentOverflow(scenario) {
  if (!scenario) return null;

  const generated =
    getCastCount(scenario, "fracture") * 2 +
    getCastCount(scenario, "soul_carver") * 3;
  const consumed =
    getCastCount(scenario, "spirit_bomb") * 4 +
    getCastCount(scenario, "soul_cleave") * 2;
  const overflow = Math.max(0, generated - consumed);

  return {
    estimated: overflow,
    generated,
    consumed,
    pctOfGenerated: generated > 0 ? (overflow / generated) * 100 : 0,
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
      console.log(
        `  Budget: ~${b.furyGenerated} fury, ~${b.fragsGenerated} frags per cycle`,
      );
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

  const spellDataPath = join(DATA_DIR, "spells.json");
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
