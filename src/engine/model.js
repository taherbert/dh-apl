// Model pipeline orchestrator.
// Coordinates talent tree building and interaction graph construction.
// Usage: node src/engine/model.js

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

const REQUIRED_INPUTS = {
  talents: ["data/raidbots-talents.json", "data/spells.json"],
  interactions: [
    "data/spells.json",
    "data/talents.json",
    "data/cpp-interactions.json",
    "data/cpp-effects-inventory.json",
    "data/cpp-proc-mechanics.json",
  ],
};

export function checkInputs() {
  const results = {};
  for (const [step, inputs] of Object.entries(REQUIRED_INPUTS)) {
    const missing = inputs.filter((f) => !existsSync(join(ROOT, f)));
    results[step] = {
      ready: missing.length === 0,
      missing,
    };
  }
  return results;
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const inputs = checkInputs();
  console.log("Model pipeline status:");
  for (const [step, info] of Object.entries(inputs)) {
    const status = info.ready ? "READY" : "BLOCKED";
    console.log(`  ${status}  ${step}`);
    if (!info.ready) {
      for (const f of info.missing) console.log(`         missing: ${f}`);
    }
  }
}
