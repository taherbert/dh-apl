// Central configuration. Change DATA_ENV to switch all data sources.
export const DATA_ENV = "live"; // "live" | "ptr"

export const RAIDBOTS_BASE = `https://www.raidbots.com/static/data/${DATA_ENV}`;
export const SIMC_DIR =
  process.env.SIMC_DIR || "/Users/tom/Documents/GitHub/simc";
export const SIMC_BIN = `${SIMC_DIR}/engine/simc`;
export const SIMC_DH_CPP = `${SIMC_DIR}/engine/class_modules/sc_demon_hunter.cpp`;

export const RAIDBOTS_TALENTS = `${RAIDBOTS_BASE}/talents.json`;

export const CLASS_NAME = "Demon Hunter";
export const SPEC_NAME = "Vengeance";
export const SIMC_CLASS_SLUG = "demon_hunter";
export const SPEC_ID = 581;
export const HERO_SUBTREES = { 35: "Aldrachi Reaver", 124: "Annihilator" };

export const SIMC_MAX_BUFFER = 50 * 1024 * 1024;
export const SIMC_TIMEOUT_MS = 300_000;
export const SPELL_QUERY_TIMEOUT_MS = 30_000;
export const FETCH_TIMEOUT_MS = 30_000;
export const SIMC_THREADS = 4;
