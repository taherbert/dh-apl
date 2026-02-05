// Spec adapter contract — documents what a spec adapter must export.
// This file is not imported directly. It exists as documentation and
// for future runtime validation of adapter conformance.
//
// To add a new spec:
// 1. Create src/spec/{specname}.js exporting these symbols
// 2. Set spec.specName in config.json
// 3. Run `npm run build-data` to generate data for the new spec

/**
 * @typedef {Object} SpecAdapter
 *
 * Required exports from a spec adapter module:
 *
 * @property {Set<number>} BASE_SPELL_IDS
 *   Spell IDs granted by the spec (not talents). Used by extraction to seed
 *   the spell catalog. These are find_specialization_spell() calls in simc C++.
 *
 * @property {Set<number>} SET_BONUS_SPELL_IDS
 *   Spell IDs from tier set bonuses. Separate from base abilities since they
 *   come from gear. Included in spell extraction.
 *
 * @property {Object} SPEC_CONFIG
 *   Static spec configuration:
 *   - specId {string} — e.g. "vengeance"
 *   - className {string} — e.g. "demonhunter"
 *   - role {string} — "tank" | "dps" | "healer"
 *   - resources {{ primary: {name, cap}, secondary?: {name, cap} }}
 *   - spellIds {Record<string, number>} — key ability name → spell ID
 *   - domainOverrides {Record<string, Object>} — mechanical values not in spell data
 *   - heroTrees {Record<string, HeroTreeConfig>} — hero tree metadata
 *   - resourceFlow {ResourceFlowConfig} — generator/consumer mappings
 *   - buffWindows {Array} — damage amp windows for alignment analysis
 *   - synergies {Array} — key buff synergies for hypothesis generation
 *
 * @property {function(): Object} getSpecConfig
 *   Returns SPEC_CONFIG.
 *
 * @property {function(): Object} loadAbilityData
 *   Merges spell data from spells-summary.json with domain overrides.
 *   Returns frozen object keyed by ability name.
 *
 * @property {function(): Object} getHeroTrees
 *   Returns hero tree configs from SPEC_CONFIG.
 *
 * @property {function(): Object} getResourceFlow
 *   Returns resource flow config from SPEC_CONFIG.
 *
 * @property {function(string): string|null} detectHeroTreeFromProfileName
 *   Given APL text, detects which hero tree is active from profile keywords.
 *
 * @property {function(Object): string|null} detectHeroTreeFromBuffs
 *   Given workflow results, detects hero tree from buff uptimes.
 *
 * @property {function(): Record<string, number>} getSpellIds
 *   Returns spell ID map from SPEC_CONFIG.
 *
 * @property {function(): Record<string, Object>} getDomainOverrides
 *   Returns domain override map from SPEC_CONFIG.
 *
 * @property {function(): void} clearCache
 *   Clears any cached ability data (for testing/reloads).
 */

const REQUIRED_EXPORTS = [
  "BASE_SPELL_IDS",
  "SET_BONUS_SPELL_IDS",
  "SPEC_CONFIG",
  "getSpecConfig",
  "loadAbilityData",
  "getHeroTrees",
  "getResourceFlow",
  "detectHeroTreeFromProfileName",
  "detectHeroTreeFromBuffs",
  "getSpellIds",
  "getDomainOverrides",
  "clearCache",
];

/**
 * Validates that a loaded module conforms to the spec adapter contract.
 * @param {Object} mod — The imported module
 * @param {string} specName — For error messages
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateAdapter(mod, specName) {
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in mod));
  return {
    valid: missing.length === 0,
    missing,
  };
}

export { REQUIRED_EXPORTS };
