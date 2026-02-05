// Engine startup: loads config.json, derives paths, checks simc sync.
// Single source of truth for all configuration values.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// --- Load and validate config.json ---

const CONFIG_PATH = join(ROOT, "config.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config.json at ${CONFIG_PATH}`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  validate(config);
  return config;
}

function validate(config) {
  const required = [
    ["spec.className", config.spec?.className],
    ["spec.specName", config.spec?.specName],
    ["spec.specId", config.spec?.specId],
    ["simc.dir", config.simc?.dir],
    ["simc.branch", config.simc?.branch],
    ["data.env", config.data?.env],
    ["data.raidbots", config.data?.raidbots],
    ["simulation.scenarios", config.simulation?.scenarios],
    ["simulation.scenarioWeights", config.simulation?.scenarioWeights],
    ["simulation.fidelity", config.simulation?.fidelity],
  ];
  for (const [path, value] of required) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`config.json: missing required field "${path}"`);
    }
  }
  if (!["live", "ptr", "beta"].includes(config.data.env)) {
    throw new Error(
      `config.json: data.env must be "live", "ptr", or "beta" (got "${config.data.env}")`,
    );
  }
  if (!existsSync(config.simc.dir)) {
    throw new Error(`config.json: simc.dir not found: ${config.simc.dir}`);
  }
}

const config = loadConfig();

// --- Derived values (backward-compatible exports) ---

export const DATA_ENV = config.data.env;
export const SIMC_DIR = config.simc.dir;
export const SIMC_BRANCH = config.simc.branch;

const LOCAL_BIN = join(ROOT, "bin", "simc");
export const SIMC_BIN = existsSync(LOCAL_BIN)
  ? LOCAL_BIN
  : join(SIMC_DIR, "engine", "simc");

export const SIMC_DH_CPP = join(
  SIMC_DIR,
  config.simc.cppModule || "engine/class_modules/sc_demon_hunter.cpp",
);

export const RAIDBOTS_BASE = `${config.data.raidbots}/${DATA_ENV}`;
export const RAIDBOTS_TALENTS = `${RAIDBOTS_BASE}/talents.json`;

export const SPEC_ID = config.spec.specId;

// HERO_SUBTREES: numeric subtree ID → Title Case name.
// config.json stores snake_case; consumers expect Title Case (e.g., "Aldrachi Reaver").
function toTitleCase(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
export const HERO_SUBTREES = Object.fromEntries(
  Object.entries(config.spec.heroSubtrees || {}).map(([k, v]) => [
    Number(k),
    toTitleCase(v),
  ]),
);

// Simulation config exports
export const SCENARIOS = config.simulation.scenarios;
export const SCENARIO_WEIGHTS = config.simulation.scenarioWeights;
export const FIDELITY_TIERS = config.simulation.fidelity;
export const SIM_DEFAULTS = config.simulation.defaults;

// Full config object for advanced use
export { config };

// --- Dynamic spec adapter loading ---

let _specAdapter = null;

export async function loadSpecAdapter(specName = config.spec.specName) {
  if (_specAdapter) return _specAdapter;

  const adapterPath = join(ROOT, "src", "spec", `${specName}.js`);
  if (!existsSync(adapterPath)) {
    throw new Error(
      `No spec adapter found at src/spec/${specName}.js. ` +
        `Create one following the contract in src/spec/interface.js.`,
    );
  }

  const mod = await import(`../spec/${specName}.js`);

  const { validateAdapter } = await import("../spec/interface.js");
  const { valid, missing } = validateAdapter(mod, specName);
  if (!valid) {
    throw new Error(
      `Spec adapter "${specName}" missing required exports: ${missing.join(", ")}`,
    );
  }

  _specAdapter = mod;
  return mod;
}

export function getSpecAdapter() {
  if (!_specAdapter) {
    throw new Error("Spec adapter not loaded. Call loadSpecAdapter() first.");
  }
  return _specAdapter;
}

// --- Upstream sync check ---

const METADATA_PATH = join(ROOT, "reference", ".refresh-metadata.json");

export function checkSync() {
  const simcDir = config.simc.dir;
  const branch = config.simc.branch;

  // Get current simc HEAD
  let currentHead;
  try {
    currentHead = execSync("git rev-parse HEAD", {
      cwd: simcDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    return {
      synced: false,
      reason: "Cannot read simc git HEAD",
      currentHead: null,
      lastHead: null,
    };
  }

  // Get last synced commit
  let lastHead = null;
  if (existsSync(METADATA_PATH)) {
    try {
      const meta = JSON.parse(readFileSync(METADATA_PATH, "utf-8"));
      lastHead = meta.simc?.commit || null;
    } catch {
      // Corrupt metadata — treat as unsynced
    }
  }

  if (!lastHead) {
    return {
      synced: false,
      reason: "No previous sync recorded",
      currentHead,
      lastHead,
    };
  }

  if (currentHead !== lastHead) {
    return {
      synced: false,
      reason: `simc HEAD changed: ${lastHead.slice(0, 8)} → ${currentHead.slice(0, 8)}`,
      currentHead,
      lastHead,
    };
  }

  return { synced: true, currentHead, lastHead };
}

// --- Status report ---

export function reportStatus() {
  const sync = checkSync();
  const lines = [
    `Spec: ${config.spec.className} / ${config.spec.specName}`,
    `Data env: ${DATA_ENV}`,
    `SimC: ${SIMC_DIR} (${SIMC_BRANCH})`,
    `Binary: ${SIMC_BIN}${existsSync(SIMC_BIN) ? "" : " (NOT FOUND)"}`,
    `Sync: ${sync.synced ? "up to date" : sync.reason}`,
  ];
  return lines.join("\n");
}

// CLI: node src/engine/startup.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(reportStatus());
  const sync = checkSync();
  if (!sync.synced) {
    console.log("\nRun `npm run refresh` to rebuild from upstream.");
  }
}
