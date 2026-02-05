// Extraction pipeline orchestrator.
// Coordinates data extraction from simc, raidbots, and C++ source.
// Usage: node src/engine/extract.js [--step=<step>] [--skip-fetch]

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SIMC_DH_CPP } from "./startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// Cache the C++ source for all scanners to share
let _cppSource = null;
let _cppLines = null;

export function loadCppSource(path = SIMC_DH_CPP) {
  if (_cppSource) return { source: _cppSource, lines: _cppLines };
  _cppSource = readFileSync(path, "utf-8");
  _cppLines = _cppSource.split("\n");
  return { source: _cppSource, lines: _cppLines };
}

export function clearCppCache() {
  _cppSource = null;
  _cppLines = null;
}

// Pipeline step definitions
const STEPS = {
  raidbots: {
    label: "Fetch Raidbots talent data",
    output: "data/raidbots-talents.json",
    run: () => import("../extract/raidbots.js"),
  },
  spells: {
    label: "Extract spell data",
    output: "data/spells.json",
    run: () => import("../extract/spells.js"),
  },
  talents: {
    label: "Build talent tree",
    output: "data/talents.json",
    run: () => import("../model/talents.js"),
  },
  "cpp-interactions": {
    label: "Scan C++ talent cross-references",
    output: "data/cpp-interactions.json",
    run: () => import("../extract/cpp-interactions.js"),
  },
  "cpp-effects": {
    label: "Scan C++ effect applications",
    output: "data/cpp-effects-inventory.json",
    run: () => import("../extract/cpp-effects-scanner.js"),
  },
  "cpp-procs": {
    label: "Scan C++ proc mechanics",
    output: "data/cpp-proc-mechanics.json",
    run: () => import("../extract/cpp-proc-scanner.js"),
  },
  interactions: {
    label: "Build interaction map",
    output: "data/interactions.json",
    run: () => import("../model/interactions.js"),
  },
};

// Sequential dependencies: later steps depend on earlier ones
const PIPELINE_ORDER = [
  "raidbots",
  "spells",
  "talents",
  ["cpp-interactions", "cpp-effects", "cpp-procs"], // parallel group
  "interactions",
];

export function getSteps() {
  return STEPS;
}

export function checkOutputs() {
  const results = {};
  for (const [name, step] of Object.entries(STEPS)) {
    const path = join(ROOT, step.output);
    results[name] = {
      exists: existsSync(path),
      label: step.label,
      output: step.output,
    };
  }
  return results;
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputs = checkOutputs();
  console.log("Extraction pipeline status:");
  for (const [name, info] of Object.entries(outputs)) {
    const status = info.exists ? "OK" : "MISSING";
    console.log(`  ${status}  ${name.padEnd(20)} → ${info.output}`);
  }
}
