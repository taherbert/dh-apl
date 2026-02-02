// Autonomous simulation workflow: single entry point for full sim→analyze cycle.
// Parses APL, runs across scenarios, returns structured JSON analysis.
// Usage: node src/sim/workflow.js <apl.simc> [scenario]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { runSim } from "./runner.js";
import { parse, getActionLists, findAction } from "../apl/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(ROOT, "results");

const ALL_SCENARIOS = ["st", "small_aoe", "big_aoe"];

// Key VDH buffs to track for optimization signals
const KEY_BUFFS = [
  "demon_spikes",
  "fiery_brand",
  "metamorphosis",
  "immolation_aura",
  "frailty",
  "soul_furnace",
  "art_of_the_glaive",
  "reavers_mark",
  "thrill_of_the_fight",
  "rending_strike",
  "glaive_flurry",
];

// Run full sim→analyze workflow for an APL file.
// Returns structured JSON with results across all scenarios.
export async function runWorkflow(aplPath, scenarios = ALL_SCENARIOS) {
  const aplText = readFileSync(aplPath, "utf-8");

  // Parse APL for structure info
  const sections = parse(aplText);
  const actionLists = getActionLists(sections);
  const aplInfo = {
    file: basename(aplPath),
    actionLists: actionLists.map((l) => ({
      name: l.name,
      actionCount: l.entries.length,
    })),
    totalActions: actionLists.reduce((sum, l) => sum + l.entries.length, 0),
  };

  // Run each scenario
  const scenarioResults = [];
  for (const scenario of scenarios) {
    try {
      const result = runSim(aplPath, scenario);
      scenarioResults.push(analyzeScenario(result));
    } catch (e) {
      scenarioResults.push({
        scenario,
        error: e.message,
      });
    }
  }

  // Cross-scenario analysis
  const crossAnalysis = analyzeCrossScenario(
    scenarioResults.filter((r) => !r.error),
  );

  const output = {
    apl: aplInfo,
    scenarios: scenarioResults,
    crossAnalysis,
    timestamp: new Date().toISOString(),
  };

  return output;
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
  const buffUptimes = {};
  for (const name of KEY_BUFFS) {
    const buff = result.buffs.find((b) => b.name.toLowerCase().includes(name));
    if (buff) buffUptimes[name] = +buff.uptime.toFixed(1);
  }

  // GCD efficiency estimate
  const fightLength =
    result.scenario === "st" ? 300 : result.scenario === "small_aoe" ? 75 : 60;
  const estimatedGCDs = fightLength / 1.5;
  const totalCasts = damage.reduce((sum, a) => sum + a.executes, 0);
  const gcdEfficiency = +((totalCasts / estimatedGCDs) * 100).toFixed(1);

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
    totalCasts: Math.round(totalCasts),
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
  for (const name of KEY_BUFFS) {
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
    dpsScaling:
      aoeResult.dps && stResult.dps
        ? +(aoeResult.dps / stResult.dps).toFixed(2)
        : null,
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
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

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(
    RESULTS_DIR,
    `workflow_${basename(aplPath, ".simc")}.json`,
  );
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  // Print summary to stdout
  console.log(JSON.stringify(output, null, 2));
  console.error(`\nWorkflow results saved to ${outPath}`);
}
