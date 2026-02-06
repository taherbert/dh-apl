// {SpecName} spec adapter template.
// Copy this file to src/spec/{specid}.js and fill in the blanks.
//
// Structure:
//   Section 1 — Human domain knowledge (edit when game mechanics change)
//   Section 2 — Machine-validated data (cross-checked by validate-spec-data.js)
//   Section 3 — Auto-derived functions (generated from SPEC_CONFIG by common.js)
//
// After filling in:
//   1. Set spec.specName in config.json to match specId below
//   2. Run `npm run build-data` to generate data files
//   3. Run `node src/spec/validate-spec-data.js` to verify constants
//   4. Run `/bootstrap` to generate APL scaffold and build theory

import {
  buildAbilityData,
  matchHeroTreeFromText,
  matchHeroTreeFromBuffs,
  createCache,
  deriveClassSpellQuery,
  deriveCppStructPatterns,
  deriveSpecSpellFilter,
  deriveTalentTreePattern,
  deriveKeySpellIds,
} from "./common.js";
import { dataDir } from "../engine/paths.js";

// ================================================================
// SECTION 1: HUMAN DOMAIN KNOWLEDGE
// Edit this section when game mechanics, abilities, or set bonuses
// change. This is the only section that requires manual curation.
// ================================================================

export const SPEC_CONFIG = {
  // ---- Identity ----
  specId: "SPEC_ID", // lowercase, no spaces (e.g., "vengeance", "havoc", "arms")
  className: "CLASS_NAME", // lowercase, no spaces (e.g., "demonhunter", "warrior")
  cppClassName: "CPP_CLASS_NAME", // C++ snake_case form (e.g., "demon_hunter", "warrior")
  role: "ROLE", // "tank", "dps", "healer"

  displayNames: {
    class: "Class Name", // e.g., "Demon Hunter", "Warrior"
    spec: "Spec Name", // e.g., "Vengeance", "Arms"
  },

  // ---- Resources ----
  // cap = BASE value without talents. validate-spec-data.js catches talent-inflated values.
  resources: {
    primary: { name: "RESOURCE", cap: 100 },
    // secondary: { name: "SECONDARY_RESOURCE", cap: 5 },  // uncomment if applicable
  },

  // ---- Core Abilities ----
  // ability_name → spell ID. Used by loadAbilityData() to merge with spell data.
  spellIds: {
    // example_ability: 123456,
  },

  // ---- Domain Overrides ----
  // Mechanical values not derivable from spell data (proc rates, hidden coefficients, etc.)
  domainOverrides: {
    // example_ability: { apCoeff: 1.5, charges: 2 },
  },

  // ---- Hero Trees ----
  // Each hero tree gets a key matching its SimC identifier.
  heroTrees: {
    // hero_tree_one: {
    //   displayName: "Hero Tree One",   // human-readable name (used in reports, filters)
    //   subtree: 0,                     // subtree ID from talent data
    //   buildMethod: "doe",             // "doe" = DoE discovery pipeline, "multi-actor" = manual .simc file
    //   damageSchool: "Physical",
    //   keyBuffs: ["buff_a", "buff_b"],
    //   aplBranch: "ht1",              // action list name in APL; generates --ht1-only CLI flag
    //   profileKeywords: ["hero", "tree"],  // keywords for auto-detection
    // },
    // hero_tree_two: {
    //   displayName: "Hero Tree Two",
    //   subtree: 0,
    //   buildMethod: "multi-actor",
    //   damageSchool: "Fire",
    //   keyBuffs: ["buff_c"],
    //   aplBranch: "ht2",
    //   profileKeywords: ["other", "tree"],
    // },
  },

  // ---- Resource Flow (simple form) ----
  // Used by basic resource analysis. For detailed models, see resourceModels below.
  resourceFlow: {
    // primaryGenerators: [
    //   { ability: "generator", base: 25 },
    // ],
    // primaryConsumers: [
    //   { ability: "spender", cost: 40 },
    // ],
  },

  // ---- Buff Windows ----
  // Damage amplification periods that the APL should be aware of.
  buffWindows: [
    // { buff: "major_cd", ability: "major_cd", duration: 15, damageAmp: 0.2, school: "all" },
  ],

  // ---- Synergies ----
  // Known ability synergy pairs (buff alignment, combo sequences).
  synergies: [
    // { buffs: ["buff_a", "ability_b"], reason: "B benefits from A's damage amp" },
  ],

  // ---- Buff/Ability Classification ----
  keyBuffs: [
    // "important_buff_1", "important_buff_2",
  ],

  offGcdAbilities: [
    "auto_attack",
    // Add spec abilities that don't consume GCDs
  ],

  cooldownBuffs: [
    // Major cooldown buffs (excluded from "low uptime" warnings)
  ],

  classificationHints: {
    damage_modifier: [],
    buff_grant: [],
    mechanic_change: [],
    cooldown_modifier: [],
    resource_modifier: [],
    duration_modifier: [],
    proc_trigger: [],
  },

  resourceNames: [
    // "fury", "soul_fragments", "health", etc.
  ],

  // ---- Analysis-Driven Sections (optional but recommended) ----
  // These enable data-driven hypothesis generation in analysis modules.

  // Detailed resource models with generation/consumption rates.
  // resourceModels: [
  //   {
  //     name: "primary_resource",
  //     cap: 100,
  //     baseCap: 100,
  //     generators: [
  //       { ability: "generator", amount: 25, charges: 2, rechargeCd: 4.5 },
  //     ],
  //     consumers: [
  //       { ability: "spender", cost: 40 },
  //     ],
  //   },
  // ],

  // Burst windows with cooldown alignment targets.
  // burstWindows: [
  //   {
  //     buff: "major_cd",
  //     cooldown: 120,
  //     duration: 15,
  //     damageAmp: 0.2,
  //     school: "all",
  //     syncTargets: ["ability_a", "ability_b"],
  //   },
  // ],

  // State machines for hero tree cycles.
  // stateMachines: {
  //   hero_tree_one: {
  //     name: "Cycle Name",
  //     description: "Step A → Step B → Step C",
  //     states: [
  //       { name: "state_a", buff: "buff_a", trigger: "auto_proc", next: "state_b" },
  //       { name: "state_b", ability: "ability_x", next: "state_a" },
  //     ],
  //     uptimeTargets: { buff_a: 40 },
  //   },
  // },

  // Parameterized hypothesis templates for analysis modules.
  // hypothesisPatterns: [
  //   {
  //     id: "burst_window_sync",
  //     category: "COOLDOWN_SYNC",
  //     template: "Align {ability} within {buff} window for {amp}% amp",
  //     appliesWhen: (config) => config.burstWindows?.some(w => w.syncTargets?.length > 0),
  //   },
  // ],

  // Keyword clusters for interaction grouping.
  // clusterKeywords: {
  //   "cluster-name": ["keyword1", "keyword2"],
  // },

  // Damage school → cluster mapping.
  // schoolClusters: {
  //   Fire: "fire-damage",
  //   Physical: "physical-damage",
  // },
};

export const SET_BONUS_SPELL_IDS = new Set([
  // Tier set spell IDs
  // 123456, // Spec X.Y Class Set 2pc
  // 123457, // Spec X.Y Class Set 4pc
]);

// C++ struct → display ability name mapping.
// Used by cpp-interactions.js to resolve struct contexts.
export const STRUCT_TO_ABILITY_MAP = {
  // auto_attack: "Auto Attack",
  // example_ability: "Example Ability",
};

// C++ scanner seed list: [talentName, expectedAbility] pairs for validation.
// These known talent→ability relationships verify the scanner is working.
export const CPP_SCANNER_SEEDS = [
  // ["Talent Name", "Expected Ability"],
];

// Set bonus interaction data (if set bonuses modify abilities).
// const SET_BONUS_INTERACTION_DATA = { ... };

// Sibling spec/hero tree names for contamination detection in verify.js.
const SIBLING_SPECS = {
  siblingSpec: "SIBLING_SPEC", // e.g., "havoc" for vengeance
  siblingHeroTrees: [], // hero trees belonging to sibling specs
};

// ================================================================
// SECTION 2: MACHINE-VALIDATED DATA
// Sourced from SimC DBC but maintained here for bootstrap ordering.
// validate-spec-data.js cross-checks these against the DBC source.
// If validation fails, update these values from the DBC output.
// ================================================================

export const BASE_SPELL_IDS = new Set([
  // Spell IDs from find_specialization_spell() in simc C++.
  // These are baseline abilities granted by the spec, not talents.
  // Run `npm run extract` and check the output to populate this.
]);

// ================================================================
// SECTION 3: AUTO-DERIVED (do not edit)
// Generated by common.js from SPEC_CONFIG. Changing Section 1
// automatically updates these.
// ================================================================

const _cache = createCache();

export function getSpecConfig() {
  return SPEC_CONFIG;
}

export const loadAbilityData = () =>
  _cache.get(() =>
    buildAbilityData(
      SPEC_CONFIG.spellIds,
      SPEC_CONFIG.domainOverrides,
      SPEC_CONFIG.resources,
      dataDir(),
    ),
  );

export function getHeroTrees() {
  return SPEC_CONFIG.heroTrees;
}

export function getResourceFlow() {
  return SPEC_CONFIG.resourceFlow;
}

export const detectHeroTreeFromProfileName = (text) =>
  matchHeroTreeFromText(SPEC_CONFIG.heroTrees, text);

export const detectHeroTreeFromBuffs = (results) =>
  matchHeroTreeFromBuffs(SPEC_CONFIG.heroTrees, results);

export function getSpellIds() {
  return SPEC_CONFIG.spellIds;
}

export function getDomainOverrides() {
  return SPEC_CONFIG.domainOverrides;
}

export const clearCache = () => _cache.clear();

export function getStructToAbilityMap() {
  return STRUCT_TO_ABILITY_MAP;
}

export function getTalentTreePattern() {
  return deriveTalentTreePattern(SPEC_CONFIG);
}

export function getSetBonusSpells() {
  // Fill in with tier set spell IDs + metadata
  return new Map([
    // [123456, { name: "spec_X.Y", pieceCount: 2, displayName: "Spec X.Y Class Set 2pc" }],
    // [123457, { name: "spec_X.Y", pieceCount: 4, displayName: "Spec X.Y Class Set 4pc" }],
  ]);
}

export function getClassSpellQuery() {
  return deriveClassSpellQuery(SPEC_CONFIG);
}

export function getSpecSpellFilter() {
  return deriveSpecSpellFilter(SPEC_CONFIG);
}

export function getCppStructPatterns() {
  return deriveCppStructPatterns(SPEC_CONFIG);
}

export function getKeySpellIds() {
  return deriveKeySpellIds(SPEC_CONFIG);
}

// Uncomment and fill in if the spec has set bonus interactions.
// export function getManualSetBonusInteractions(spellMap) {
//   return [];
// }

// Uncomment and fill in if the spec has C++ scanner seed data.
// export function getCppScannerSeedList() {
//   return CPP_SCANNER_SEEDS;
// }

export function getSiblingSpecs() {
  return SIBLING_SPECS;
}
