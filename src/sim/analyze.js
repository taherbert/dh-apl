// Extracts optimization-relevant signals from simulation results.
// Identifies cooldown waste, resource overcap, buff uptime issues,
// DPGCD rankings, and per-archetype differentials.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS } from "./runner.js";
import { getSpecAdapter, initSpec } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { resultsDir } from "../engine/paths.js";

// ── Public API ──────────────────────────────────────────────────

/**
 * Full analysis of one or more scenario results from a summary JSON.
 * Returns structured analysis object (also prints to console).
 */
export function analyze(summaryPath) {
  const results = JSON.parse(readFileSync(summaryPath, "utf-8"));
  const analyses = [];

  for (const result of results) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Analysis: ${result.scenarioName}`);
    console.log(`${"=".repeat(60)}`);

    const analysis = {
      scenario: result.scenario,
      scenarioName: result.scenarioName,
      dps: result.dps,
      dpsContribution: analyzeDPSContribution(result),
      buffUptime: analyzeBuffUptime(result),
      gcdUsage: analyzeGCDUsage(result),
      resourceWaste: analyzeResourceWaste(result),
      cooldownUtilization: analyzeCooldownUtilization(result),
      dpgcd: analyzeDPGCD(result),
    };
    analyses.push(analysis);
  }

  return analyses;
}

/**
 * Compare results across multiple builds for the same scenario.
 * Identifies where the APL underserves specific archetypes.
 */
export function analyzeArchetypeDifferential(buildResults) {
  if (!buildResults || buildResults.length < 2) return null;

  const abilityMap = new Map();

  for (const build of buildResults) {
    for (const ability of build.abilities || []) {
      if (ability.type !== "damage") continue;
      if (!abilityMap.has(ability.name)) {
        abilityMap.set(ability.name, []);
      }
      abilityMap.get(ability.name).push({
        build: build.player,
        dps: ability.dps,
        fraction: ability.fraction,
        executes: ability.executes,
      });
    }
  }

  const differential = {
    highVariance: [],
    buildSpecific: [],
    universal: [],
  };

  for (const [name, entries] of abilityMap) {
    if (entries.length < 2) {
      differential.buildSpecific.push({
        ability: name,
        builds: entries.map((e) => e.build),
        avgDps: entries[0].dps,
      });
      continue;
    }

    const fractions = entries.map((e) => e.fraction);
    const min = Math.min(...fractions);
    const max = Math.max(...fractions);
    const range = max - min;

    if (range > 0.05) {
      const sorted = [...entries].sort((a, b) => b.fraction - a.fraction);
      differential.highVariance.push({
        ability: name,
        range: range,
        best: { build: sorted[0].build, fraction: sorted[0].fraction },
        worst: {
          build: sorted.at(-1).build,
          fraction: sorted.at(-1).fraction,
        },
      });
    } else {
      differential.universal.push({
        ability: name,
        avgFraction: (min + max) / 2,
      });
    }
  }

  differential.highVariance.sort((a, b) => b.range - a.range);

  if (differential.highVariance.length) {
    console.log("\n--- Archetype Differential ---");
    console.log("\nHigh-variance abilities (>5% DPS fraction spread):");
    for (const d of differential.highVariance.slice(0, 10)) {
      console.log(
        `  ${d.ability.padEnd(25)} ${(d.range * 100).toFixed(1)}% spread  ` +
          `(${d.best.build}: ${(d.best.fraction * 100).toFixed(1)}% → ${d.worst.build}: ${(d.worst.fraction * 100).toFixed(1)}%)`,
      );
    }
  }

  return differential;
}

// ── Internal analysis functions ─────────────────────────────────

function analyzeDPSContribution(result) {
  console.log("\n--- DPS Contribution ---");

  const damage = result.abilities.filter((a) => a.type === "damage");

  const lowContrib = damage.filter((a) => a.fraction > 0 && a.fraction < 0.01);
  if (lowContrib.length) {
    console.log("\nLow-contribution abilities (<1% DPS):");
    for (const a of lowContrib) {
      console.log(
        `  ${a.name}: ${(a.fraction * 100).toFixed(2)}% (${a.executes.toFixed(1)} casts)`,
      );
    }
  }

  const highContrib = damage.filter((a) => a.fraction > 0.1);
  console.log("\nMajor contributors (>10% DPS):");
  for (const a of highContrib) {
    console.log(
      `  ${a.name}: ${(a.fraction * 100).toFixed(1)}% (${Math.round(a.dps).toLocaleString()} DPS)`,
    );
  }

  return { lowContrib, highContrib };
}

function analyzeBuffUptime(result) {
  console.log("\n--- Buff Uptime Analysis ---");

  let keyBuffs;
  try {
    keyBuffs = getSpecAdapter().getSpecConfig().keyBuffs;
  } catch {
    keyBuffs = [];
  }

  const found = result.buffs.filter((b) =>
    keyBuffs.some((kb) => b.name.toLowerCase().includes(kb)),
  );

  const warnings = [];
  if (found.length) {
    console.log("\nKey buff uptimes:");
    for (const b of found) {
      const upPct = b.uptime.toFixed(1);
      const status = b.uptime < 30 ? " LOW" : b.uptime > 90 ? " HIGH" : "";
      console.log(`  ${b.name.padEnd(35)} ${upPct}%${status}`);
    }
  }

  try {
    const { keyBuffs: kb, cooldownBuffs } = getSpecAdapter().getSpecConfig();
    for (const buffName of kb) {
      if (cooldownBuffs.includes(buffName)) continue;
      const buff = result.buffs.find((b) =>
        b.name.toLowerCase().includes(buffName),
      );
      if (buff && buff.uptime < 50) {
        const msg = `${buff.name} uptime is ${buff.uptime.toFixed(1)}%`;
        warnings.push(msg);
        console.log(`\n  Warning: ${msg}`);
      }
    }
  } catch {
    // Adapter not loaded
  }

  return { found, warnings };
}

function analyzeGCDUsage(result) {
  console.log("\n--- GCD Analysis ---");

  const fightLength =
    result.combatLength || SCENARIOS[result.scenario]?.maxTime || 300;
  const estimatedGCDs = fightLength / 1.5;

  let offGcd;
  try {
    offGcd = new Set(getSpecAdapter().getSpecConfig().offGcdAbilities || []);
  } catch {
    offGcd = new Set(["auto_attack", "melee"]);
  }

  const onGcdAbilities = result.abilities.filter(
    (a) =>
      a.type === "damage" &&
      !offGcd.has(a.name.toLowerCase().replace(/ /g, "_")),
  );
  const totalCasts = onGcdAbilities.reduce((sum, a) => sum + a.executes, 0);

  const efficiency = totalCasts / estimatedGCDs;
  console.log(`  Fight length: ${fightLength.toFixed(0)}s`);
  console.log(`  Estimated GCDs available: ${estimatedGCDs.toFixed(0)}`);
  console.log(`  On-GCD damage casts: ${totalCasts.toFixed(0)}`);
  console.log(`  GCD efficiency: ${(efficiency * 100).toFixed(1)}%`);

  if (efficiency < 0.85) {
    console.log(
      "  Warning: Low GCD efficiency — dead GCDs from resource starvation or cooldown gaps",
    );
  }

  return { fightLength, estimatedGCDs, totalCasts, efficiency };
}

/**
 * Resource waste analysis — estimates overcap from ability data + spec config.
 * Uses resourceWaste data from SimC collected_data when available,
 * falls back to estimation from ability cast counts and spec resource flow.
 */
function analyzeResourceWaste(result) {
  // If SimC provided resource_lost data directly, use it
  if (result.resourceWaste && Object.keys(result.resourceWaste).length > 0) {
    console.log("\n--- Resource Waste (SimC tracked) ---");
    const waste = {};
    for (const [resType, data] of Object.entries(result.resourceWaste)) {
      console.log(
        `  ${resType}: ${Math.round(data.totalLost)} total lost (${data.perSecond.toFixed(1)}/s)`,
      );
      waste[resType] = data;
    }
    return waste;
  }

  // Fallback: estimate resource waste from spec config + cast counts
  let specConfig;
  try {
    specConfig = getSpecAdapter().getSpecConfig();
  } catch {
    return {};
  }

  const { resources, resourceFlow } = specConfig;
  if (!resources || !resourceFlow) return {};

  console.log("\n--- Resource Waste (estimated) ---");
  const fightLength =
    result.combatLength || SCENARIOS[result.scenario]?.maxTime || 300;
  const waste = {};

  // Estimate primary resource generation and spending
  const primaryName = resources.primary.name;
  const genKey = `${primaryName}Generators`;
  const conKey = `${primaryName}Consumers`;
  if (resources.primary && resourceFlow[genKey] && resourceFlow[conKey]) {
    const cap = resources.primary.cap;
    let totalGenPerSec = 0;
    let totalSpendPerSec = 0;

    for (const gen of resourceFlow[genKey]) {
      const ability = result.abilities.find(
        (a) => a.name.toLowerCase().replace(/ /g, "_") === gen.ability,
      );
      if (!ability) continue;
      const castsPerSec = ability.executes / fightLength;
      totalGenPerSec += castsPerSec * (gen.base || gen.amount || 0);
    }

    for (const con of resourceFlow[conKey]) {
      const ability = result.abilities.find(
        (a) => a.name.toLowerCase().replace(/ /g, "_") === con.ability,
      );
      if (!ability) continue;
      const castsPerSec = ability.executes / fightLength;
      totalSpendPerSec += castsPerSec * con.cost;
    }

    const netGenPerSec = totalGenPerSec - totalSpendPerSec;
    if (netGenPerSec > 0) {
      const estimatedWasteRate = netGenPerSec * 0.15; // rough overcap factor
      waste[resources.primary.name] = {
        genPerSec: totalGenPerSec,
        spendPerSec: totalSpendPerSec,
        netPerSec: netGenPerSec,
        cap,
        estimatedWastePerSec: estimatedWasteRate,
      };
      console.log(
        `  ${resources.primary.name}: gen ${totalGenPerSec.toFixed(1)}/s, spend ${totalSpendPerSec.toFixed(1)}/s, net +${netGenPerSec.toFixed(1)}/s (cap ${cap})`,
      );
    }
  }

  return waste;
}

/**
 * Cooldown utilization — identifies cooldowns with wasted time.
 * Uses cooldown.wasteSec from SimC when available, otherwise estimates
 * from buff uptime vs expected uptime.
 */
function analyzeCooldownUtilization(result) {
  let cdBuffs;
  try {
    cdBuffs = getSpecAdapter().getSpecConfig().cooldownBuffs || [];
  } catch {
    cdBuffs = [];
  }

  if (!cdBuffs.length) return [];

  console.log("\n--- Cooldown Utilization ---");
  const fightLength =
    result.combatLength || SCENARIOS[result.scenario]?.maxTime || 300;
  const utilization = [];

  // Check ability-level cooldown waste from SimC data
  for (const ability of result.abilities) {
    if (!ability.cooldown || ability.cooldown.duration <= 0) continue;
    if (ability.executes < 1) continue;

    const cd = ability.cooldown;
    const expectedCasts = Math.floor(fightLength / cd.duration) + 1;
    const usedPct = (ability.executes / expectedCasts) * 100;

    if (cd.wasteSec > 0 || usedPct < 85) {
      const entry = {
        ability: ability.name,
        cooldownDuration: cd.duration,
        actualCasts: ability.executes,
        expectedCasts,
        utilization: usedPct,
        wastedSec: cd.wasteSec,
      };
      utilization.push(entry);

      const wasteStr =
        cd.wasteSec > 0 ? ` (${cd.wasteSec.toFixed(1)}s wasted)` : "";
      console.log(
        `  ${ability.name.padEnd(25)} ${ability.executes.toFixed(1)}/${expectedCasts} casts  ` +
          `${usedPct.toFixed(0)}% util${wasteStr}`,
      );
    }
  }

  // Also check buff-level: compare cooldown buff uptime to expected uptime
  let buffWindows;
  try {
    buffWindows = getSpecAdapter().getSpecConfig().buffWindows || [];
  } catch {
    buffWindows = [];
  }

  for (const bw of buffWindows) {
    const buff = result.buffs.find((b) =>
      b.name.toLowerCase().includes(bw.buff),
    );
    if (!buff) continue;

    const expectedUptime =
      (bw.duration / (bw.duration + (bw.cooldown || 60))) * 100;
    if (buff.uptime < expectedUptime * 0.8) {
      const entry = {
        buff: buff.name,
        actualUptime: buff.uptime,
        expectedUptime,
        gap: expectedUptime - buff.uptime,
      };
      utilization.push(entry);
      console.log(
        `  ${buff.name.padEnd(25)} ${buff.uptime.toFixed(1)}% uptime (expected ~${expectedUptime.toFixed(0)}%)`,
      );
    }
  }

  if (!utilization.length) {
    console.log("  All cooldowns at good utilization.");
  }

  return utilization;
}

/**
 * DPGCD (Damage Per GCD) analysis — ranks abilities by DPS efficiency per GCD spent.
 * Critical metric: the APL should maximize time spent on highest-DPGCD abilities.
 */
function analyzeDPGCD(result) {
  const fightLength =
    result.combatLength || SCENARIOS[result.scenario]?.maxTime || 300;

  let offGcd;
  try {
    offGcd = new Set(getSpecAdapter().getSpecConfig().offGcdAbilities || []);
  } catch {
    offGcd = new Set(["auto_attack", "melee"]);
  }

  const damage = result.abilities.filter(
    (a) =>
      a.type === "damage" &&
      a.executes > 0 &&
      !offGcd.has(a.name.toLowerCase().replace(/ /g, "_")),
  );

  const dpgcdList = damage.map((a) => {
    const totalDamage = a.dps * fightLength;
    const dpgcd = a.executes > 0 ? totalDamage / a.executes : 0;
    return {
      name: a.name,
      dpgcd,
      executes: a.executes,
      fraction: a.fraction,
      dps: a.dps,
    };
  });

  dpgcdList.sort((a, b) => b.dpgcd - a.dpgcd);

  console.log("\n--- DPGCD Ranking ---");
  for (const a of dpgcdList.slice(0, 10)) {
    console.log(
      `  ${a.name.padEnd(25)} ${Math.round(a.dpgcd).toLocaleString().padStart(10)} dmg/cast  ` +
        `(${(a.fraction * 100).toFixed(1)}%, ${a.executes.toFixed(1)} casts)`,
    );
  }

  return dpgcdList;
}

// ── CLI ─────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  await initSpec(parseSpecArg());
  const RESULTS_DIR = resultsDir();
  const path = process.argv[2];
  if (!path) {
    console.log("Usage: node src/sim/analyze.js <summary.json>");
    console.log("  Or: node src/sim/analyze.js (uses most recent baseline)");

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(RESULTS_DIR).filter((f) =>
      f.endsWith("_summary.json"),
    );
    if (files.length) {
      console.log(`\nFound: ${files.join(", ")}`);
      analyze(join(RESULTS_DIR, files[files.length - 1]));
    }
    process.exit(0);
  }
  analyze(path);
}
