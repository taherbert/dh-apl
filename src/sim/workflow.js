// Autonomous simulation workflow: single entry point for full sim→analyze cycle.
// Parses APL, runs across scenarios, returns structured JSON analysis.
// Usage: node src/sim/workflow.js <apl.simc> [scenario]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { runSimAsync, SCENARIOS } from "./runner.js";
import { cpus } from "node:os";
import {
  getSpecAdapter,
  loadSpecAdapter,
  initSpec,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { resultsDir, resultsFile } from "../engine/paths.js";

const ALL_SCENARIOS = Object.keys(SCENARIOS);

// Run full sim→analyze workflow for an APL file.
// Returns structured JSON with results across all scenarios.
export async function runWorkflow(aplPath, scenarios = ALL_SCENARIOS) {
  const aplInfo = {
    file: basename(aplPath),
  };

  // Run scenarios in parallel, splitting threads across them
  const totalCores = cpus().length;
  const threadsPerScenario = Math.max(
    1,
    Math.floor(totalCores / scenarios.length),
  );

  const scenarioResults = await Promise.all(
    scenarios.map(async (scenario) => {
      try {
        const result = await runSimAsync(aplPath, scenario, {
          simOverrides: { threads: threadsPerScenario },
        });
        return analyzeScenario(result);
      } catch (e) {
        return { scenario, error: e.message };
      }
    }),
  );

  // Cross-scenario analysis
  const crossAnalysis = analyzeCrossScenario(
    scenarioResults.filter((r) => !r.error),
  );

  return {
    apl: aplInfo,
    scenarios: scenarioResults,
    crossAnalysis,
    timestamp: new Date().toISOString(),
  };
}

// Analyze a single scenario result for optimization signals.
function analyzeScenario(result) {
  const damage = result.abilities.filter((a) => a.type === "damage");
  const healing = result.abilities.filter((a) => a.type === "heal");

  // Major contributors
  const majorDamage = damage
    .filter((a) => a.fraction > 0.05)
    .map((a) => ({
      name: a.name,
      fraction: +(a.fraction * 100).toFixed(1),
      dps: Math.round(a.dps),
      casts: +a.executes.toFixed(1),
    }));

  // Low contribution abilities (possible waste)
  const lowContrib = damage
    .filter((a) => a.fraction > 0 && a.fraction < 0.01 && a.executes > 0)
    .map((a) => ({
      name: a.name,
      fraction: +(a.fraction * 100).toFixed(2),
      casts: +a.executes.toFixed(1),
    }));

  // Key buff uptimes
  const { keyBuffs, offGcdAbilities } = getSpecAdapter().getSpecConfig();
  const buffUptimes = {};
  for (const name of keyBuffs) {
    const buff = result.buffs.find((b) => b.name.toLowerCase().includes(name));
    if (buff) buffUptimes[name] = +buff.uptime.toFixed(1);
  }

  // GCD efficiency: count on-GCD ability executes vs theoretical max GCDs
  const gcdAbilities = damage.filter(
    (a) => !offGcdAbilities.some((name) => a.name.toLowerCase().includes(name)),
  );
  const totalExecutes = gcdAbilities.reduce((sum, a) => sum + a.executes, 0);
  const fightLength = SCENARIOS[result.scenario]?.maxTime || 300;
  const theoreticalGcds = fightLength / 1.5;
  const gcdEfficiency = +Math.min(
    100,
    (totalExecutes / theoreticalGcds) * 100,
  ).toFixed(1);

  return {
    scenario: result.scenario,
    scenarioName: result.scenarioName,
    dps: Math.round(result.dps),
    hps: Math.round(result.hps),
    dtps: Math.round(result.dtps),
    majorDamage,
    lowContrib,
    buffUptimes,
    gcdEfficiency,
  };
}

// Cross-scenario analysis: identify abilities that scale differently across targets.
function analyzeCrossScenario(results) {
  if (results.length < 2) return {};

  const stResult = results.find((r) => r.scenario === "st");
  const aoeResult = results.find(
    (r) => r.scenario === "small_aoe" || r.scenario === "big_aoe",
  );
  if (!stResult || !aoeResult) return {};

  // Find abilities with big AoE scaling
  const stAbilities = new Map(stResult.majorDamage.map((a) => [a.name, a]));
  const aoeScaling = [];

  for (const a of aoeResult.majorDamage) {
    const st = stAbilities.get(a.name);
    if (st) {
      const fractionDelta = a.fraction - st.fraction;
      if (Math.abs(fractionDelta) > 5) {
        aoeScaling.push({
          name: a.name,
          stFraction: st.fraction,
          aoeFraction: a.fraction,
          delta: +fractionDelta.toFixed(1),
        });
      }
    }
  }

  // Buff uptime differences
  const buffDiffs = {};
  const { keyBuffs: crossKeyBuffs } = getSpecAdapter().getSpecConfig();
  for (const name of crossKeyBuffs) {
    const stUp = stResult.buffUptimes[name];
    const aoeUp = aoeResult.buffUptimes[name];
    if (
      stUp !== undefined &&
      aoeUp !== undefined &&
      Math.abs(stUp - aoeUp) > 10
    ) {
      buffDiffs[name] = {
        st: stUp,
        aoe: aoeUp,
        delta: +(aoeUp - stUp).toFixed(1),
      };
    }
  }

  return {
    aoeScaling: aoeScaling.sort(
      (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
    ),
    buffDiffs,
    dpsScaling: +(aoeResult.dps / stResult.dps).toFixed(2),
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  await initSpec(parseSpecArg());
  const aplPath = process.argv[2];
  const scenarioArg = process.argv[3];

  if (!aplPath) {
    console.log(
      "Usage: node src/sim/workflow.js <apl.simc> [st|small_aoe|big_aoe|all]",
    );
    process.exit(1);
  }

  const scenarios =
    scenarioArg && scenarioArg !== "all" ? [scenarioArg] : ALL_SCENARIOS;

  const output = await runWorkflow(aplPath, scenarios);

  mkdirSync(resultsDir(), { recursive: true });
  const outPath = resultsFile(`workflow_${basename(aplPath, ".simc")}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  // Print summary to stdout
  console.log(JSON.stringify(output, null, 2));
  console.error(`\nWorkflow results saved to ${outPath}`);
}
