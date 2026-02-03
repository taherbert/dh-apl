// Central configuration. Change DATA_ENV to switch all data sources.
export const DATA_ENV = "beta"; // "live" | "ptr" | "beta"

if (!["live", "ptr", "beta"].includes(DATA_ENV)) {
  throw new Error(
    `Invalid DATA_ENV: "${DATA_ENV}". Must be "live", "ptr", or "beta".`,
  );
}

export const RAIDBOTS_BASE = `https://www.raidbots.com/static/data/${DATA_ENV}`;
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export const SIMC_DIR = "/Users/tom/Documents/GitHub/simc";
const LOCAL_BIN = join(ROOT, "bin", "simc");
export const SIMC_BIN = existsSync(LOCAL_BIN)
  ? LOCAL_BIN
  : `${SIMC_DIR}/engine/simc`;
export const SIMC_DH_CPP = `${SIMC_DIR}/engine/class_modules/sc_demon_hunter.cpp`;

export const RAIDBOTS_TALENTS = `${RAIDBOTS_BASE}/talents.json`;

export const SPEC_ID = 581;
export const HERO_SUBTREES = { 35: "Aldrachi Reaver", 124: "Annihilator" };
