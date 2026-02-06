// Model pipeline orchestrator.
// Coordinates talent tree building and interaction graph construction.
// Usage: node src/engine/model.js

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "./startup.js"; // ensures setSpecName() is called
import { dataFile } from "./paths.js";

const REQUIRED_INPUTS = {
  talents: ["raidbots-talents.json", "spells.json"],
  interactions: [
    "spells.json",
    "talents.json",
    "cpp-interactions.json",
    "cpp-effects-inventory.json",
    "cpp-proc-mechanics.json",
  ],
};

export function checkInputs() {
  const results = {};
  for (const [step, inputs] of Object.entries(REQUIRED_INPUTS)) {
    const missing = inputs.filter((f) => !existsSync(dataFile(f)));
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
