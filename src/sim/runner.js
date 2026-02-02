// Runs simc simulations and parses JSON results.
// Usage: node src/sim/runner.js <profile.simc> [scenario]
// Scenarios: st (default), small_aoe, big_aoe, all

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIMC_BIN,
  SIMC_MAX_BUFFER,
  SIMC_TIMEOUT_MS,
  SIMC_THREADS,
} from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(ROOT, "results");

export const SCENARIOS = {
  st: { name: "Patchwerk ST", maxTime: 300, targets: 1, iterations: 1000 },
  small_aoe: {
    name: "Small AoE (3 targets)",
    maxTime: 75,
    targets: 3,
    iterations: 1000,
  },
  big_aoe: {
    name: "Large AoE (10 targets)",
    maxTime: 60,
    targets: 10,
    iterations: 1000,
  },
};

function scenarioOverrides(scenario) {
  const s = SCENARIOS[scenario];
  return `max_time=${s.maxTime} desired_targets=${s.targets} iterations=${s.iterations}`;
}

export function runSim(profilePath, scenario = "st", extraOverrides = "") {
  const config = SCENARIOS[scenario];
  if (!config)
    throw new Error(
      `Unknown scenario: ${scenario}. Valid: ${Object.keys(SCENARIOS).join(", ")}`,
    );

  mkdirSync(RESULTS_DIR, { recursive: true });

  const profileName = basename(profilePath, ".simc");
  const jsonPath = join(RESULTS_DIR, `${profileName}_${scenario}.json`);

  const cmd = [
    SIMC_BIN,
    profilePath,
    scenarioOverrides(scenario),
    extraOverrides,
    `json2=${jsonPath}`,
    `threads=${SIMC_THREADS}`,
  ]
    .filter(Boolean)
    .join(" ");

  console.log(`Running ${config.name}...`);
  try {
    execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: SIMC_MAX_BUFFER,
      timeout: SIMC_TIMEOUT_MS,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-5).join("\n"));
    throw new Error(`SimC failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return parseResults(data, scenario);
}

function parseResults(data, scenario) {
  const player = data.sim?.players?.[0];
  if (!player) {
    throw new Error(
      "No player data in simulation results — simc may have failed silently",
    );
  }

  const result = {
    scenario,
    scenarioName: SCENARIOS[scenario].name,
    player: player.name,
    dps: player.collected_data.dps.mean,
    hps: player.collected_data.hps?.mean || 0,
    dtps: player.collected_data.dtps?.mean || 0,
    abilities: [],
    buffs: [],
  };

  // Parse ability breakdown
  for (const stat of player.stats) {
    if (stat.type === "damage" || stat.type === "heal") {
      result.abilities.push({
        name: stat.spell_name || stat.name,
        id: stat.id,
        type: stat.type,
        dps: stat.portion_aps?.mean || 0,
        fraction: stat.portion_amount || 0,
        executes: stat.num_executes?.mean || 0,
        school: stat.school,
      });
    }
  }
  result.abilities.sort((a, b) => b.dps - a.dps);

  // Parse buff uptimes
  for (const buff of player.buffs || []) {
    if (buff.uptime && buff.uptime > 0) {
      result.buffs.push({
        name: buff.name,
        uptime: buff.uptime,
        refreshCount: buff.trigger || 0,
      });
    }
  }
  result.buffs.sort((a, b) => b.uptime - a.uptime);

  return result;
}

export function printResults(result) {
  console.log(`\n=== ${result.scenarioName} ===`);
  console.log(`DPS: ${Math.round(result.dps).toLocaleString()}`);
  console.log(`HPS: ${Math.round(result.hps).toLocaleString()}`);
  console.log(`DTPS: ${Math.round(result.dtps).toLocaleString()}`);

  console.log("\nTop abilities:");
  for (const a of result.abilities.slice(0, 15)) {
    const pct = (a.fraction * 100).toFixed(1);
    console.log(
      `  ${a.name.padEnd(30)} ${Math.round(a.dps).toLocaleString().padStart(12)} (${pct}%) [${a.executes.toFixed(1)} casts]`,
    );
  }

  console.log("\nKey buff uptimes:");
  for (const b of result.buffs.filter((b) => b.uptime > 5).slice(0, 15)) {
    console.log(`  ${b.name.padEnd(35)} ${b.uptime.toFixed(1)}%`);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const profilePath = process.argv[2];
  const scenario = process.argv[3] || "all";

  if (!profilePath) {
    console.log(
      "Usage: node src/sim/runner.js <profile.simc> [st|small_aoe|big_aoe|all]",
    );
    process.exit(1);
  }

  const scenarios = scenario === "all" ? Object.keys(SCENARIOS) : [scenario];
  const results = [];

  for (const s of scenarios) {
    const result = runSim(profilePath, s);
    printResults(result);
    results.push(result);
  }

  const summaryPath = join(
    RESULTS_DIR,
    `${basename(profilePath, ".simc")}_summary.json`,
  );
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nSummary saved to ${summaryPath}`);
}
