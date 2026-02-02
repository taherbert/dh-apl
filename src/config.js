// Central configuration. Change DATA_ENV to switch all data sources.
export const DATA_ENV = "ptr"; // "live" | "ptr"

export const RAIDBOTS_BASE = `https://www.raidbots.com/static/data/${DATA_ENV}`;
export const SIMC_DIR = "/Users/tom/Documents/GitHub/simc";
export const SIMC_BIN = `${SIMC_DIR}/engine/simc`;
export const SIMC_DH_CPP = `${SIMC_DIR}/engine/class_modules/sc_demon_hunter.cpp`;

export const RAIDBOTS_TALENTS = `${RAIDBOTS_BASE}/talents.json`;

export const SPEC_ID = 581;
export const HERO_SUBTREES = { 35: "Aldrachi Reaver", 124: "Annihilator" };
