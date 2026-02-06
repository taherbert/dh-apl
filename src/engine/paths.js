// Centralized path resolution for multi-spec data isolation.
// Single source of truth for all directory and file paths.
//
// Per-spec directories: data/{spec}/, results/{spec}/, apls/{spec}/
// Shared directories: reference/ (cross-spec C++ source)
//
// Usage:
//   import { dataDir, dataFile, resultsDir, resultsFile, aplsDir } from "../engine/paths.js";
//   const spells = readFileSync(dataFile("spells.json"), "utf-8");

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");

// Spec name — set once by startup.js, read by all consumers
let _specName = null;

export function setSpecName(name) {
  _specName = name;
}

export function getSpecName() {
  if (!_specName) throw new Error("Spec name not set. Call startup.js first.");
  return _specName;
}

// Per-spec directories
export function dataDir(spec = getSpecName()) {
  return join(ROOT, "data", spec);
}

export function resultsDir(spec = getSpecName()) {
  return join(ROOT, "results", spec);
}

export function aplsDir(spec = getSpecName()) {
  return join(ROOT, "apls", spec);
}

// Shared (not per-spec)
export const REFERENCE_DIR = join(ROOT, "reference");

// Convenience: specific file paths used by many modules
export function dataFile(filename, spec) {
  return join(dataDir(spec), filename);
}

export function resultsFile(filename, spec) {
  return join(resultsDir(spec), filename);
}

// Ensure per-spec directories exist
export function ensureSpecDirs(spec = getSpecName()) {
  for (const dir of [dataDir(spec), resultsDir(spec), aplsDir(spec)]) {
    mkdirSync(dir, { recursive: true });
  }
}
