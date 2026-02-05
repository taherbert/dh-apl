// Runs simc simulations and parses JSON results.
// Usage: node src/sim/runner.js <profile.simc> [scenario] [--html]
// Scenarios: st (default), small_aoe, big_aoe, all
// Options: --html generates HTML report alongside JSON

import { execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SIMC_BIN,
  DATA_ENV,
  SCENARIOS,
  SIM_DEFAULTS as _SIM_DEFAULTS,
} from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SIMC = SIMC_BIN;
const RESULTS_DIR = join(ROOT, "results");
const TOTAL_CORES = cpus().length;

// Re-export from config, adding runtime-only `threads` to defaults
export { SCENARIOS };
export const SIM_DEFAULTS = { threads: TOTAL_CORES, ..._SIM_DEFAULTS };

function buildOverrides(scenario, extraOverrides = {}) {
  const config = SCENARIOS[scenario];
  const merged = { ...SIM_DEFAULTS, ...extraOverrides };
  const overrides = [
    `max_time=${config.maxTime}`,
    `desired_targets=${config.desiredTargets}`,
    `target_error=${merged.target_error}`,
    `iterations=${merged.iterations}`,
  ];
  // PTR/beta data environments require ptr=1 for SimC to use ptr data tables
  if (DATA_ENV === "ptr" || DATA_ENV === "beta") {
    overrides.unshift("ptr=1");
  }
  return overrides;
}

export function prepareSim(
  profilePath,
  scenario = "st",
  { extraOverrides = "", simOverrides = {}, html = false } = {},
) {
  const config = SCENARIOS[scenario];
  if (!config)
    throw new Error(
      `Unknown scenario: ${scenario}. Valid: ${Object.keys(SCENARIOS).join(", ")}`,
    );

  mkdirSync(RESULTS_DIR, { recursive: true });

  const profileName = basename(profilePath, ".simc");
  const jsonPath = join(RESULTS_DIR, `${profileName}_${scenario}.json`);
  const htmlPath = html
    ? join(RESULTS_DIR, `${profileName}_${scenario}.html`)
    : null;

  const overrides = buildOverrides(scenario, simOverrides);
  const extras = extraOverrides ? extraOverrides.split(" ") : [];

  const args = [
    profilePath,
    ...overrides,
    ...extras,
    `json2=${jsonPath}`,
    `threads=${simOverrides.threads || SIM_DEFAULTS.threads}`,
  ];

  if (htmlPath) {
    args.push(`html=${htmlPath}`);
  }

  return { config, args, jsonPath, htmlPath, scenario };
}

export function runSim(profilePath, scenario = "st", opts = {}) {
  const { config, args, jsonPath, htmlPath } = prepareSim(
    profilePath,
    scenario,
    opts,
  );
  const cmd = [SIMC, ...args].join(" ");

  console.log(`Running ${config.name}...`);
  try {
    execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-5).join("\n"));
    throw new Error(`SimC failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const result = parseResults(data, scenario);
  if (htmlPath) result.htmlPath = htmlPath;
  return result;
}

const execFileAsync = promisify(execFile);

export async function runSimAsync(profilePath, scenario = "st", opts = {}) {
  const { config, args, jsonPath, htmlPath } = prepareSim(
    profilePath,
    scenario,
    opts,
  );

  console.log(`Running ${config.name}...`);
  try {
    await execFileAsync(SIMC, args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-5).join("\n"));
    throw new Error(`SimC failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const result = parseResults(data, scenario);
  if (htmlPath) result.htmlPath = htmlPath;
  return result;
}

function parseResults(data, scenario) {
  const player = data.sim.players[0];

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

// --- Multi-actor support ---

// Parse multi-actor SimC JSON output. Returns Map<actorName, {dps, hps, dtps}>.
export function parseMultiActorResults(data) {
  const results = new Map();
  for (const player of data.sim.players) {
    results.set(player.name, {
      dps: player.collected_data.dps.mean,
      hps: player.collected_data.hps?.mean || 0,
      dtps: player.collected_data.dtps?.mean || 0,
    });
  }
  return results;
}

// Write multi-actor .simc content to a temp file, run SimC, parse results.
// Returns Map<actorName, {dps, hps, dtps}>.
export async function runMultiActorAsync(
  simcContent,
  scenario = "st",
  label = "multi-actor",
  { simOverrides = {} } = {},
) {
  const config = SCENARIOS[scenario];
  if (!config) throw new Error(`Unknown scenario: ${scenario}`);

  mkdirSync(RESULTS_DIR, { recursive: true });

  const simcPath = join(RESULTS_DIR, `${label}_${scenario}.simc`);
  const jsonPath = join(RESULTS_DIR, `${label}_${scenario}.json`);
  writeFileSync(simcPath, simcContent);

  const merged = { ...SIM_DEFAULTS, ...simOverrides };
  const args = [
    simcPath,
    `max_time=${config.maxTime}`,
    `desired_targets=${config.desiredTargets}`,
    `target_error=${merged.target_error}`,
    `iterations=${merged.iterations}`,
    `json2=${jsonPath}`,
    `threads=${merged.threads || TOTAL_CORES}`,
  ];

  console.log(`Running multi-actor ${config.name} (${label})...`);
  try {
    await execFileAsync(SIMC, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 600000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
    throw new Error(`SimC multi-actor failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return parseMultiActorResults(data);
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const htmlFlag = args.includes("--html");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));

  const profilePath = positionalArgs[0];
  const scenario = positionalArgs[1] || "all";

  if (!profilePath) {
    console.log(
      "Usage: node src/sim/runner.js <profile.simc> [st|small_aoe|big_aoe|all] [--html]",
    );
    console.log("Options:");
    console.log("  --html    Generate HTML report alongside JSON");
    process.exit(1);
  }

  const scenarios = scenario === "all" ? Object.keys(SCENARIOS) : [scenario];
  const results = [];

  for (const s of scenarios) {
    const result = runSim(profilePath, s, { html: htmlFlag });
    printResults(result);
    if (result.htmlPath) {
      console.log(`HTML report: ${result.htmlPath}`);
    }
    results.push(result);
  }

  const summaryPath = join(
    RESULTS_DIR,
    `${basename(profilePath, ".simc")}_summary.json`,
  );
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nSummary saved to ${summaryPath}`);
}
