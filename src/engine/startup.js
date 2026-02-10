// Engine startup: loads config.json (global) + config.{spec}.json (per-spec).
// Single source of truth for all configuration values.
//
// Config is loaded in two phases:
//   1. loadConfig() at import time — global settings (simc, data, simulation)
//   2. initSpec(specName) at runtime — merges per-spec overrides, sets spec name
//
// Entry points call initSpec() with the spec name from --spec flag or SPEC env var.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ROOT, setSpecName, REFERENCE_DIR } from "./paths.js";

// --- Load and validate config.json ---

const CONFIG_PATH = join(ROOT, "config.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config.json at ${CONFIG_PATH}`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  validateGlobal(config);
  return config;
}

function validateGlobal(config) {
  const required = [
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

function validateSpec(config) {
  const required = [
    ["spec.className", config.spec?.className],
    ["spec.specName", config.spec?.specName],
    ["spec.specId", config.spec?.specId],
  ];
  for (const [path, value] of required) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`config: missing required field "${path}" after merge`);
    }
  }
}

// Deep-merge source into target (mutates target)
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const config = loadConfig();

// --- initSpec: merge per-spec config and initialize spec context ---

let _specInitialized = false;

export async function initSpec(specName) {
  if (_specInitialized) return getSpecAdapter();

  const specConfigPath = join(ROOT, `config.${specName}.json`);
  if (!existsSync(specConfigPath)) {
    throw new Error(
      `Missing per-spec config: config.${specName}.json\n` +
        `Create it with at minimum: { "spec": { "className": "...", "specName": "${specName}", "specId": ... } }`,
    );
  }

  const specConfig = JSON.parse(readFileSync(specConfigPath, "utf-8"));
  deepMerge(config, specConfig);
  validateSpec(config);

  // Re-derive DATA_ENV in case per-spec config overrode it
  DATA_ENV = config.data.env;
  RAIDBOTS_BASE = `${config.data.raidbots}/${DATA_ENV}`;
  RAIDBOTS_TALENTS = `${RAIDBOTS_BASE}/talents.json`;

  // Derive SimC source paths from className/specName
  const classSnake =
    SIMC_CLASS_NAMES[config.spec.className] || config.spec.className;
  SIMC_CPP = join(SIMC_DIR, "engine/class_modules", `sc_${classSnake}.cpp`);
  SIMC_APL_PATH = join(
    SIMC_DIR,
    "engine/class_modules/apl",
    classSnake,
    `${config.spec.specName}.simc`,
  );

  setSpecName(config.spec.specName);
  _specInitialized = true;

  return loadSpecAdapter(specName);
}

export function isSpecInitialized() {
  return _specInitialized;
}

// --- Derived values ---

export let DATA_ENV = config.data.env;
export const SIMC_DIR = config.simc.dir;
export const SIMC_BRANCH = config.simc.branch;

const LOCAL_BIN = join(ROOT, "bin", "simc");
export const SIMC_BIN = existsSync(LOCAL_BIN)
  ? LOCAL_BIN
  : join(SIMC_DIR, "engine", "simc");

// SimC uses snake_case for multi-word class names
const SIMC_CLASS_NAMES = {
  demonhunter: "demon_hunter",
  deathknight: "death_knight",
};

export let SIMC_CPP;
export let SIMC_APL_PATH;

let RAIDBOTS_BASE = `${config.data.raidbots}/${DATA_ENV}`;
export let RAIDBOTS_TALENTS = `${RAIDBOTS_BASE}/talents.json`;

export function getSpecId() {
  if (!_specInitialized) {
    throw new Error("Spec not initialized. Call initSpec() first.");
  }
  return config.spec.specId;
}

export function toTitleCase(s) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// HERO_SUBTREES: numeric subtree ID → Title Case name.
// Derived from spec adapter after loadSpecAdapter() is called.
// Falls back to empty object before adapter is loaded.
let HERO_SUBTREES = {};
export { HERO_SUBTREES };

// Simulation config exports
export const SCENARIOS = config.simulation.scenarios;
export const SCENARIO_WEIGHTS = config.simulation.scenarioWeights;
export const FIDELITY_TIERS = config.simulation.fidelity;
export const SIM_DEFAULTS = config.simulation.defaults;

// Full config object for advanced use
export { config };

// Re-export from paths.js for backward compatibility
export { ROOT };

// --- Display names from adapter ---

export function getDisplayNames() {
  return getSpecAdapter().getSpecConfig().displayNames;
}

// --- Dynamic spec adapter loading ---

let _specAdapter = null;

export async function loadSpecAdapter(specName) {
  if (_specAdapter) return _specAdapter;

  if (!specName) {
    if (!_specInitialized) {
      throw new Error(
        "loadSpecAdapter() requires specName or initSpec() to be called first.",
      );
    }
    specName = config.spec.specName;
  }

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

  // Derive HERO_SUBTREES from adapter
  const specConfig = mod.getSpecConfig();
  HERO_SUBTREES = Object.fromEntries(
    Object.entries(specConfig.heroTrees).map(([name, data]) => [
      data.subtree,
      data.displayName || toTitleCase(name),
    ]),
  );

  return mod;
}

export function getSpecAdapter() {
  if (!_specAdapter) {
    throw new Error("Spec adapter not loaded. Call initSpec() first.");
  }
  return _specAdapter;
}

// --- Upstream sync check ---

const METADATA_PATH = join(REFERENCE_DIR, ".refresh-metadata.json");

export function checkSync() {
  const simcDir = config.simc.dir;

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
  const specLine = _specInitialized
    ? `Spec: ${config.spec.className} / ${config.spec.specName}`
    : "Spec: (not selected)";
  const lines = [
    specLine,
    `Data env: ${DATA_ENV}`,
    `SimC: ${SIMC_DIR} (${SIMC_BRANCH})`,
    `Binary: ${SIMC_BIN}${existsSync(SIMC_BIN) ? "" : " (NOT FOUND)"}`,
    `Sync: ${sync.synced ? "up to date" : sync.reason}`,
  ];
  return lines.join("\n");
}

// CLI: node src/engine/startup.js --spec <name>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { parseSpecArg } = await import("../util/parse-spec-arg.js");
  await initSpec(parseSpecArg());
  console.log(reportStatus());
  const sync = checkSync();
  if (!sync.synced) {
    console.log("\nRun `npm run refresh` to rebuild from upstream.");
  }
}
