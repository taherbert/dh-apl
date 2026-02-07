// Generate and run SimC profileset files for batch comparison.
// Supports talent, APL, and action line overrides per variant.
// Usage: node src/sim/profilesets.js <base-profile.simc> [scenario]

import { execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { SCENARIOS, SIM_DEFAULTS } from "./runner.js";
import { SIMC_BIN, DATA_ENV } from "../engine/startup.js";
import { resultsDir, resultsFile, dataFile } from "../engine/paths.js";

const SIMC = SIMC_BIN;
const GOLDEN_DIR = join(resultsDir(), "golden");

// Resolve `input=<filename>` directives by inlining referenced file contents.
// SimC resolves input= relative to CWD (verified experimentally).
// When we write profileset content to results/, those relative paths break.
// This function inlines them so the output is self-contained.
// Tries: sourceDir-relative first, then CWD-relative as fallback.
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
        if (existsSync(cwdPath)) refPath = cwdPath;
      }

      if (seen.has(refPath)) return [`# [circular input= skipped: ${ref}]`];
      if (!existsSync(refPath)) return [`# [input= not found: ${ref}]`];

      seen.add(refPath);
      const included = readFileSync(refPath, "utf-8");
      return resolveInputDirectives(included, dirname(refPath), seen).split(
        "\n",
      );
    })
    .join("\n");
}

// Generate a .simc profileset file from a base profile and variant list.
// Each variant: { name, overrides: string[] }
// overrides are SimC option lines (talents=..., actions=..., etc.)
export function generateProfileset(baseProfilePath, variants) {
  const raw = readFileSync(baseProfilePath, "utf-8");
  const base = resolveInputDirectives(raw, dirname(resolve(baseProfilePath)));
  const lines = [base, ""];

  for (const variant of variants) {
    const safeName = variant.name.replace(/\./g, "_").replace(/\s+/g, "_");
    if (variant.overrides.length === 0) continue;

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
  const workThreads = Math.max(1, Math.floor(merged.threads / 6));

  const args = [
    simcPath,
    `max_time=${config.maxTime}`,
    `desired_targets=${config.desiredTargets}`,
    `target_error=${merged.target_error}`,
    `iterations=${merged.iterations}`,
    `json2=${jsonPath}`,
    `threads=${merged.threads}`,
    `profileset_work_threads=${workThreads}`,
    "profileset_metric=dps",
  ];
  if (DATA_ENV === "ptr" || DATA_ENV === "beta") {
    args.unshift("ptr=1");
  }

  console.log(`Running profileset: ${config.name}...`);
  return { args, jsonPath, scenario };
}

// Run a profileset .simc file and parse JSON results.
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
      timeout: 600000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
    throw new Error(`SimC profileset failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return parseProfilesetResults(data, scenario);
}

// Async variant of runProfileset for parallel execution.
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
      timeout: 600000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
    throw new Error(`SimC profileset failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return parseProfilesetResults(data, scenario);
}

// Parse SimC JSON output for profileset results.
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

  // Sort by DPS descending
  results.variants.sort((a, b) => b.dps - a.dps);

  return results;
}

// Generate a profileset .simc file from a build roster + APL.
// Uses talents=<hash> for each build — requires all builds to have hashes.
// The baseline actor uses the first build's hash; each subsequent build
// becomes a profileset variant with a talents= override.
// Memory: only 2 actors in memory at a time (baseline + current variant).
export function generateRosterProfilesetContent(roster, aplPath) {
  const builds = roster.builds;
  if (builds.length === 0) throw new Error("Roster has no builds");
  if (!builds.every((b) => b.hash))
    throw new Error("All builds must have talent hashes for profileset mode");

  // Resolve the APL file (which inlines profile.simc via input= directive)
  const resolvedAplPath = resolve(aplPath);
  const rawApl = readFileSync(resolvedAplPath, "utf-8");
  const resolved = resolveInputDirectives(rawApl, dirname(resolvedAplPath));

  // Replace the profile's talents= line with the first build's hash
  const first = builds[0];
  const lines = resolved.split("\n").map((line) => {
    if (!line.trim().startsWith("#") && line.match(/^\s*talents\s*=/))
      return `talents=${first.hash}`;
    return line;
  });

  const output = [];
  output.push(`# Profileset comparison (auto-generated)`);
  output.push(`# Roster: ${builds.length} builds, baseline: ${first.id}`);
  output.push("");
  output.push(...lines);
  output.push("");

  // Each subsequent build becomes a profileset variant
  for (let i = 1; i < builds.length; i++) {
    const build = builds[i];
    const safeName = build.id.replace(/\./g, "_").replace(/\s+/g, "_");
    output.push(`profileset.${safeName}=talents=${build.hash}`);
  }

  return output.join("\n");
}

// Convert profileset results to the same Map<buildId, {dps, hps, dtps}> format
// used by runMultiActorAsync, so callers can use either mode interchangeably.
export function profilesetResultsToActorMap(profilesetResults, roster) {
  const actorMap = new Map();
  const builds = roster.builds;

  // Baseline actor = first build
  actorMap.set(builds[0].id, {
    dps: profilesetResults.baseline.dps,
    hps: profilesetResults.baseline.hps || 0,
    dtps: 0,
  });

  // Build a reverse map from sanitized profileset names back to build IDs
  const nameToId = new Map();
  for (let i = 1; i < builds.length; i++) {
    const safeName = builds[i].id.replace(/\./g, "_").replace(/\s+/g, "_");
    nameToId.set(safeName, builds[i].id);
  }

  // Map each variant's DPS back to its build ID
  for (const variant of profilesetResults.variants) {
    const buildId = nameToId.get(variant.name) || variant.name;
    actorMap.set(buildId, { dps: variant.dps, hps: 0, dtps: 0 });
  }

  return actorMap;
}

// Compare profileset results against a baseline DPS value.
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

// Save golden results for regression testing.
export function saveGolden(label, results) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const path = join(GOLDEN_DIR, `${label}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
  console.log(`Golden results saved to ${path}`);
}

// Load golden results.
export function loadGolden(label) {
  const path = join(GOLDEN_DIR, `${label}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// Check for regressions against golden results.
// Returns { passed: bool, regressions: [], warnings: [] }
export function checkRegressions(
  current,
  golden,
  warnThreshold = 1,
  errorThreshold = 3,
) {
  if (!golden) return { passed: true, regressions: [], warnings: [] };

  const regressions = [];
  const warnings = [];

  // Build golden lookup by variant name
  const goldenByName = new Map();
  for (const v of golden.variants || []) {
    goldenByName.set(v.name, v);
  }

  for (const v of current.variants || []) {
    const g = goldenByName.get(v.name);
    if (!g) continue;

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

// Print profileset results as a ranked table.
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

  // Demo: generate a simple profileset with talent string overrides
  const combosPath = dataFile("talent-combos.json");
  if (!existsSync(combosPath)) {
    console.log("No talent-combos.json found. Run talent-combos.js first.");
    process.exit(1);
  }

  const combosData = JSON.parse(readFileSync(combosPath, "utf-8"));
  const combos = combosData.builds || [];
  // Pick first 3 builds as demo variants
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

  // Save as golden if none exists
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
