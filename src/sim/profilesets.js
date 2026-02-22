// Generate and run SimC profileset files for batch comparison.
// Supports talent, APL, and action line overrides per variant.
// Usage: node src/sim/profilesets.js <base-profile.simc> [scenario]

import { execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { SCENARIOS, SIM_DEFAULTS } from "./runner.js";
import { SIMC_BIN, DATA_ENV, initSpec } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { resultsDir, resultsFile, dataFile } from "../engine/paths.js";

const SIMC = SIMC_BIN;
function goldenDir() {
  return join(resultsDir(), "golden");
}

export function resolveInputDirectives(content, sourceDir, seen = new Set()) {
  return content
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*input\s*=\s*(.+)\s*$/);
      if (!match) return [line];

      const ref = match[1].trim();
      let refPath = resolve(sourceDir, ref);

      if (!existsSync(refPath)) {
        const cwdPath = resolve(process.cwd(), ref);
        if (existsSync(cwdPath)) {
          refPath = cwdPath;
        }
      }

      if (seen.has(refPath)) {
        return [`# [circular input= skipped: ${ref}]`];
      }
      if (!existsSync(refPath)) {
        return [`# [input= not found: ${ref}]`];
      }

      seen.add(refPath);
      const included = readFileSync(refPath, "utf-8");
      return resolveInputDirectives(included, dirname(refPath), seen).split(
        "\n",
      );
    })
    .join("\n");
}

export function generateProfileset(baseProfilePath, variants) {
  const raw = readFileSync(baseProfilePath, "utf-8");
  const base = resolveInputDirectives(raw, dirname(resolve(baseProfilePath)));
  const lines = [base, ""];

  for (const variant of variants) {
    const safeName = variant.name.replace(/\./g, "_").replace(/\s+/g, "_");
    if (variant.overrides.length === 0) {
      continue;
    }

    lines.push(`profileset.${safeName}=${variant.overrides[0]}`);
    for (let i = 1; i < variant.overrides.length; i++) {
      lines.push(`profileset.${safeName}+=${variant.overrides[i]}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const execFileAsync = promisify(execFile);

// Prepare simc args and write the input file for a profileset run.
function prepareProfileset(simcContent, scenario, label, simOverrides) {
  const config = SCENARIOS[scenario];
  if (!config) {
    throw new Error(`Unknown scenario: ${scenario}`);
  }

  mkdirSync(resultsDir(), { recursive: true });

  const simcPath = resultsFile(`${label}_${scenario}.simc`);
  const jsonPath = resultsFile(`${label}_${scenario}.json`);
  writeFileSync(simcPath, simcContent);

  const merged = { ...SIM_DEFAULTS, ...simOverrides };
  const workThreads =
    merged.profileset_work_threads ||
    Math.max(1, Math.floor(merged.threads / 4));
  const initThreads = Math.min(4, Math.max(1, Math.floor(merged.threads / 3)));

  const args = [
    simcPath,
    `max_time=${config.maxTime}`,
    `desired_targets=${config.desiredTargets}`,
    ...(config.fightStyle ? [`fight_style=${config.fightStyle}`] : []),
    `target_error=${merged.target_error}`,
    `iterations=${merged.iterations}`,
    `json2=${jsonPath}`,
    `threads=${merged.threads}`,
    `profileset_work_threads=${workThreads}`,
    `profileset_init_threads=${initThreads}`,
    "profileset_metric=dps",
    "buff_uptime_timeline=0",
    "buff_stack_uptime_timeline=0",
  ];
  if (DATA_ENV === "ptr" || DATA_ENV === "beta") {
    args.unshift("ptr=1");
  }

  console.log(`Running profileset: ${config.name}...`);
  return { args, jsonPath, scenario };
}

export function runProfileset(
  simcContent,
  scenario = "st",
  label = "profileset",
  { simOverrides = {} } = {},
) {
  const { args, jsonPath } = prepareProfileset(
    simcContent,
    scenario,
    label,
    simOverrides,
  );

  try {
    execSync([SIMC, ...args].join(" "), {
      encoding: "utf-8",
      maxBuffer: 100 * 1024 * 1024,
      timeout: 1800000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
    throw new Error(`SimC profileset failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return parseProfilesetResults(data, scenario);
}

export async function runProfilesetAsync(
  simcContent,
  scenario = "st",
  label = "profileset",
  { simOverrides = {} } = {},
) {
  const { args, jsonPath } = prepareProfileset(
    simcContent,
    scenario,
    label,
    simOverrides,
  );

  try {
    await execFileAsync(SIMC, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 1800000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
    throw new Error(`SimC profileset failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return parseProfilesetResults(data, scenario);
}

function parseProfilesetResults(data, scenario) {
  const baseline = data.sim.players[0];
  const profilesets = data.sim.profilesets?.results || [];

  const baselineDPS = baseline.collected_data.dps.mean;

  const results = {
    scenario,
    scenarioName: SCENARIOS[scenario].name,
    baseline: {
      name: baseline.name,
      dps: baselineDPS,
      hps: baseline.collected_data.hps?.mean || 0,
    },
    variants: [],
  };

  for (const ps of profilesets) {
    results.variants.push({
      name: ps.name,
      dps: ps.mean,
      dpsMin: ps.min,
      dpsMax: ps.max,
      dpsMedian: ps.median,
      dpsStdDev: ps.stddev || 0,
      dpsMeanStdDev: ps.mean_stddev || 0,
      dpsMeanError: ps.mean_error || 0,
      iterations: ps.iterations || 0,
    });
  }

  results.variants.sort((a, b) => b.dps - a.dps);
  return results;
}

export function generateRosterProfilesetContent(roster, aplPath) {
  const builds = roster.builds;
  if (builds.length === 0) {
    throw new Error("Roster has no builds");
  }
  if (!builds.every((b) => b.hash)) {
    throw new Error("All builds must have talent hashes for profileset mode");
  }

  const resolvedAplPath = resolve(aplPath);
  const rawApl = readFileSync(resolvedAplPath, "utf-8");
  const resolved = resolveInputDirectives(rawApl, dirname(resolvedAplPath));

  const first = builds[0];
  let foundTalents = false;
  const lines = resolved.split("\n").map((line) => {
    if (!line.trim().startsWith("#") && line.match(/^\s*talents\s*=/)) {
      foundTalents = true;
      return `talents=${first.hash}`;
    }
    return line;
  });

  // If no talents= line existed (e.g., profile.simc has no talents), append one
  if (!foundTalents) {
    lines.push(`talents=${first.hash}`);
  }

  const output = [];
  output.push(`# Profileset comparison (auto-generated)`);
  output.push(`# Roster: ${builds.length} builds, baseline: ${first.id}`);
  output.push("");
  output.push(...lines);
  output.push("");

  for (let i = 1; i < builds.length; i++) {
    const build = builds[i];
    const safeName = build.id.replace(/\./g, "_").replace(/\s+/g, "_");
    output.push(`profileset.${safeName}=talents=${build.hash}`);
  }

  return output.join("\n");
}

export function profilesetResultsToActorMap(profilesetResults, roster) {
  const actorMap = new Map();
  const builds = roster.builds;

  actorMap.set(builds[0].id, {
    dps: profilesetResults.baseline.dps,
    hps: profilesetResults.baseline.hps || 0,
    dtps: 0,
  });

  const nameToId = new Map();
  for (let i = 1; i < builds.length; i++) {
    const safeName = builds[i].id.replace(/\./g, "_").replace(/\s+/g, "_");
    nameToId.set(safeName, builds[i].id);
  }

  for (const variant of profilesetResults.variants) {
    const buildId = nameToId.get(variant.name) || variant.name;
    actorMap.set(buildId, { dps: variant.dps, hps: 0, dtps: 0 });
  }

  return actorMap;
}

export function compareResults(baselineDPS, results) {
  return results.variants.map((v) => {
    const delta = v.dps - baselineDPS;
    const pctChange = (delta / baselineDPS) * 100;
    return {
      name: v.name,
      dps: v.dps,
      delta: Math.round(delta),
      pctChange: +pctChange.toFixed(2),
    };
  });
}

export function saveGolden(label, results) {
  mkdirSync(goldenDir(), { recursive: true });
  const path = join(goldenDir(), `${label}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
  console.log(`Golden results saved to ${path}`);
}

export function loadGolden(label) {
  const path = join(goldenDir(), `${label}.json`);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function checkRegressions(
  current,
  golden,
  warnThreshold = 1,
  errorThreshold = 3,
) {
  if (!golden) {
    return { passed: true, regressions: [], warnings: [] };
  }

  const regressions = [];
  const warnings = [];

  const goldenByName = new Map();
  for (const v of golden.variants || []) {
    goldenByName.set(v.name, v);
  }

  for (const v of current.variants || []) {
    const g = goldenByName.get(v.name);
    if (!g) {
      continue;
    }

    const pctChange = ((v.dps - g.dps) / g.dps) * 100;
    if (pctChange < -errorThreshold) {
      regressions.push({
        name: v.name,
        oldDPS: Math.round(g.dps),
        newDPS: Math.round(v.dps),
        pctChange: +pctChange.toFixed(2),
      });
    } else if (pctChange < -warnThreshold) {
      warnings.push({
        name: v.name,
        oldDPS: Math.round(g.dps),
        newDPS: Math.round(v.dps),
        pctChange: +pctChange.toFixed(2),
      });
    }
  }

  return {
    passed: regressions.length === 0,
    regressions,
    warnings,
  };
}

export function printProfilesetResults(results) {
  console.log(`\n=== ${results.scenarioName} ===`);
  console.log(
    `Baseline: ${results.baseline.name} — ${Math.round(results.baseline.dps).toLocaleString()} DPS`,
  );

  if (results.variants.length === 0) {
    console.log("No profileset variants found.");
    return;
  }

  console.log(
    `\nRank  ${"Name".padEnd(50)} ${"DPS".padStart(12)}  ${"Delta".padStart(8)}  ${"Change".padStart(8)}`,
  );
  console.log("-".repeat(90));

  for (let i = 0; i < results.variants.length; i++) {
    const v = results.variants[i];
    const delta = v.dps - results.baseline.dps;
    const pctChange = (delta / results.baseline.dps) * 100;
    const sign = delta >= 0 ? "+" : "";

    console.log(
      `${String(i + 1).padStart(4)}  ${v.name.padEnd(50)} ${Math.round(v.dps).toLocaleString().padStart(12)}  ${(sign + Math.round(delta)).padStart(8)}  ${(sign + pctChange.toFixed(1) + "%").padStart(8)}`,
    );
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  await initSpec(parseSpecArg());
  const profilePath = process.argv[2];
  const scenario = process.argv[3] || "st";

  if (!profilePath) {
    console.log(
      "Usage: node src/sim/profilesets.js <base-profile.simc> [scenario]",
    );
    console.log(
      "\nGenerates a demo profileset with 3 talent variants and runs it.",
    );
    process.exit(1);
  }

  const combosPath = dataFile("talent-combos.json");
  if (!existsSync(combosPath)) {
    console.log("No talent-combos.json found. Run talent-combos.js first.");
    process.exit(1);
  }

  const combosData = JSON.parse(readFileSync(combosPath, "utf-8"));
  const combos = combosData.builds || [];
  const variants = combos.slice(0, 3).map((build) => ({
    name: build.name,
    overrides: [`talents=${build.talentString || ""}`].filter(
      (o) => !o.endsWith("="),
    ),
  }));

  if (variants.length === 0) {
    console.log("No valid variants to test.");
    process.exit(1);
  }

  const simcContent = generateProfileset(profilePath, variants);
  console.log(`Generated profileset with ${variants.length} variants`);

  const results = runProfileset(simcContent, scenario, "demo");
  printProfilesetResults(results);

  const goldenLabel = `demo_${scenario}`;
  const golden = loadGolden(goldenLabel);
  if (!golden) {
    saveGolden(goldenLabel, results);
  } else {
    const check = checkRegressions(results, golden);
    if (!check.passed) {
      console.log("\n!! REGRESSIONS DETECTED:");
      for (const r of check.regressions) {
        console.log(`  ${r.name}: ${r.oldDPS} → ${r.newDPS} (${r.pctChange}%)`);
      }
    }
    if (check.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of check.warnings) {
        console.log(`  ${w.name}: ${w.oldDPS} → ${w.newDPS} (${w.pctChange}%)`);
      }
    }
    if (check.passed && check.warnings.length === 0) {
      console.log("\nNo regressions detected.");
    }
  }
}
