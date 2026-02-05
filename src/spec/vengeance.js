// Vengeance Demon Hunter spec adapter.
// Single source of truth for all VDH-specific domain knowledge.
//
// Structure:
//   Section 1 — Human domain knowledge (edit when game mechanics change)
//   Section 2 — Machine-validated data (cross-checked by validate-spec-data.js)
//   Section 3 — Auto-derived functions (generated from SPEC_CONFIG by common.js)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

// ================================================================
// SECTION 1: HUMAN DOMAIN KNOWLEDGE
// Edit this section when game mechanics, abilities, or set bonuses
// change. This is the only section that requires manual curation.
// ================================================================

export const SPEC_CONFIG = {
  specId: "vengeance",
  className: "demonhunter",
  cppClassName: "demon_hunter", // C++ snake_case form (not derivable from className)
  role: "tank",

  displayNames: {
    class: "Demon Hunter",
    spec: "Vengeance",
  },

  resources: {
    primary: { name: "fury", cap: 100 },
    secondary: { name: "soul_fragments", cap: 6 },
  },

  spellIds: {
    fracture: 263642,
    spirit_bomb: 247454,
    soul_cleave: 228477,
    immolation_aura: 258920,
    sigil_of_flame: 204596,
    fiery_brand: 204021,
    soul_carver: 207407,
    fel_devastation: 212084,
    sigil_of_spite: 390163,
    metamorphosis: 187827,
    reavers_glaive: 442294,
    felblade: 232893,
    throw_glaive: 185123,
  },

  domainOverrides: {
    fracture: { furyGenMeta: 40, fragGenMeta: 3, apCoeff: 1.035 },
    spirit_bomb: { fragConsume: "up_to_5", apCoeff: 0.4 },
    soul_cleave: { fragConsume: "up_to_2", apCoeff: 1.29 },
    immolation_aura: {
      charges: 2,
      rechargeCd: 30,
      furyPerTick: 3,
      tickInterval: 1,
    },
    sigil_of_flame: { apCoeff: 0.792 },
    fiery_brand: { duration: 10, damageAmp: 0.15 },
    soul_carver: { apCoeff: 2.08 },
    fel_devastation: { gcd: false, apCoeff: 1.54 },
    sigil_of_spite: { fragGen: "variable", apCoeff: 6.92 },
    reavers_glaive: { apCoeff: 3.45 },
  },

  heroTrees: {
    aldrachi_reaver: {
      subtree: 35,
      damageSchool: "Physical",
      keyBuffs: [
        "rending_strike",
        "glaive_flurry",
        "reavers_mark",
        "art_of_the_glaive",
        "thrill_of_the_fight",
      ],
      aplBranch: "ar",
      profileKeywords: ["aldrachi", "reaver"],
    },
    annihilator: {
      subtree: 124,
      damageSchool: "Shadowflame",
      keyBuffs: ["voidfall_building", "voidfall_spending", "catastrophe"],
      aplBranch: "anni",
      profileKeywords: ["annihilator", "anni"],
    },
  },

  resourceFlow: {
    furyGenerators: [
      { ability: "fracture", base: 25, meta: 40 },
      { ability: "immolation_aura", perTick: 3, duration: 6 },
      { ability: "felblade", amount: 15 },
    ],
    furyConsumers: [
      { ability: "spirit_bomb", cost: 40 },
      { ability: "soul_cleave", cost: 35 },
      { ability: "fel_devastation", cost: 50 },
    ],
    fragGenerators: [
      { ability: "fracture", base: 2, meta: 3 },
      { ability: "soul_carver", amount: 3 },
      { ability: "sigil_of_spite", amount: 3 },
      { ability: "fallout", procRate: 0.6, source: "immolation_aura" },
    ],
    fragConsumers: [
      { ability: "spirit_bomb", maxConsume: 5 },
      { ability: "soul_cleave", maxConsume: 2 },
    ],
  },

  buffWindows: [
    {
      buff: "fiery_brand",
      ability: "fiery_brand",
      duration: 10,
      damageAmp: 0.15,
      school: "Fire",
    },
    {
      buff: "metamorphosis",
      ability: "metamorphosis",
      duration: 15,
      damageAmp: 0.2,
      school: "all",
    },
  ],

  synergies: [
    {
      buffs: ["fiery_brand", "soul_carver"],
      reason: "Soul Carver benefits from Fiery Demise",
    },
    {
      buffs: ["fiery_brand", "fel_devastation"],
      reason: "FelDev is Fire school, benefits from Fiery Demise",
    },
    {
      buffs: ["metamorphosis", "fracture"],
      reason: "Fracture generates +1 frag during Meta",
    },
  ],

  // Buffs to track in workflow/analyze for optimization signals
  keyBuffs: [
    "demon_spikes",
    "fiery_brand",
    "metamorphosis",
    "immolation_aura",
    "frailty",
    "soul_furnace",
    "art_of_the_glaive",
    "reavers_mark",
    "thrill_of_the_fight",
    "rending_strike",
    "glaive_flurry",
  ],

  // Abilities that don't consume GCDs (excluded from GCD efficiency calc)
  offGcdAbilities: ["auto_attack", "melee", "immolation_aura"],

  // Buffs that are major cooldowns (excluded from "low uptime" warnings)
  cooldownBuffs: ["fiery_brand", "metamorphosis", "fel_devastation"],

  // Fallback name→category hints for interaction classification
  classificationHints: {
    damage_modifier: [
      "empowerment",
      "any means necessary",
      "chaos blades",
      "seething chaos",
      "exergy",
      "inertia",
      "demon soul",
      "burning blades",
      "fires of fel",
      "fiery demise",
      "mastery:",
      "immolation aura",
      "soul furnace",
      "bionic stabilizer",
      "serrated glaive",
      "burning wound",
      "scarred strikes",
      "soul flame",
      "accelerated blade",
    ],
    buff_grant: [
      "mark",
      "brand",
      "reaver",
      "revel in pain",
      "spirit of the darkness flame",
      "fiery resolve",
      "soul rending",
      "metamorphosis",
      "demon hide",
    ],
    mechanic_change: ["thrill of the fight", "demonsurge", "evasive action"],
    cooldown_modifier: [
      "first of the illidari",
      "fel defender",
      "rush of chaos",
    ],
    resource_modifier: [
      "unleashed power",
      "prepared",
      "shear fury",
      "tactical retreat",
    ],
    duration_modifier: ["cover of darkness", "extended spikes"],
    proc_trigger: ["luck of the draw"],
  },

  // Known resource identifiers for APL condition parsing
  resourceNames: [
    "fury",
    "soul_fragments",
    "health",
    "soul_fragments.total",
    "souls_consumed",
  ],
};

export const SET_BONUS_SPELL_IDS = new Set([
  1264808, // Vengeance 12.0 Class Set 2pc
  1264809, // Vengeance 12.0 Class Set 4pc
  1276488, // Explosion of the Soul (4pc proc) — 1.8x AP Fire AoE, 12yd radius
]);

// C++ struct → display ability name mapping
export const STRUCT_TO_ABILITY_MAP = {
  soul_cleave: "Soul Cleave",
  spirit_bomb: "Spirit Bomb",
  fiery_brand: "Fiery Brand",
  fracture: "Fracture",
  fel_devastation: "Fel Devastation",
  immolation_aura: "Immolation Aura",
  sigil_of_flame: "Sigil of Flame",
  demon_spikes: "Demon Spikes",
  metamorphosis: "Metamorphosis",
  throw_glaive: "Throw Glaive",
  vengeful_retreat: "Vengeful Retreat",
  infernal_strike: "Infernal Strike",
  shear: "Shear",
  the_hunt: "The Hunt",
  elysian_decree: "Elysian Decree",
  sigil_of_misery: "Sigil of Misery",
  sigil_of_silence: "Sigil of Silence",
  sigil_of_spite: "Sigil of Spite",
  felblade: "Felblade",
  soul_carver: "Soul Carver",
  darkness: "Darkness",
  chaos_nova: "Chaos Nova",
  consume_magic: "Consume Magic",
  bulk_extraction: "Bulk Extraction",
  consume_soul: "Consume Soul",
  soul_cleave_heal: "Soul Cleave",
  feast_of_souls_heal: "Soul Cleave",
  frailty_heal: "Frailty",
  soul_barrier: "Soul Barrier",
  demon_hunter_sigil: "Sigil of Flame",
  sigil_of_flame_damage_base: "Sigil of Flame",
  sigil_of_flame_damage: "Sigil of Flame",
  sigil_of_flame_base: "Sigil of Flame",
  sigil_of_doom_damage: "Sigil of Flame",
  sigil_of_doom: "Sigil of Flame",
  retaliation: "Demon Spikes",
  eye_beam_base: "Eye Beam",
  eye_beam: "Eye Beam",
  blade_dance_base: "Blade Dance",
  blade_dance: "Blade Dance",
  death_sweep: "Blade Dance",
  chaos_strike_base: "Chaos Strike",
  chaos_strike: "Chaos Strike",
  annihilation: "Chaos Strike",
  auto_attack_damage: "Auto Attack",
  auto_attack: "Auto Attack",
  pick_up_fragment: "Consume Soul",
  reap_base: "Soul Cleave",
  eradicate: "Soul Cleave",
  cull: "Soul Cleave",
  reap: "Soul Cleave",
  voidfall_meteor_base: "Voidfall",
  voidfall_meteor: "Voidfall",
  world_killer: "Voidfall",
  catastrophe: "Soul Cleave",
  collapsing_star: "Soul Cleave",
  art_of_the_glaive: "Art of the Glaive",
  preemptive_strike: "Throw Glaive",
  warblades_hunger: "Fracture",
  wounded_quarry: "Throw Glaive",
  reavers_glaive: "Throw Glaive",
};

// C++ scanner seed list: [talentName, expectedAbility] pairs for validation
export const CPP_SCANNER_SEEDS = [
  ["Charred Flesh", "Immolation Aura"],
  ["Feed the Demon", "Consume Soul"],
  ["Burning Alive", "Fiery Brand"],
  ["Cycle of Binding", "Sigil of Flame"],
  ["Soul Sigils", "Sigil of Flame"],
  ["Feast of Souls", "Soul Cleave"],
  ["Darkglare Boon", "Fel Devastation"],
  ["Focused Cleave", "Soul Cleave"],
  ["Fallout", "Immolation Aura"],
  ["Volatile Flameblood", "Immolation Aura"],
  ["Frailty", "Soul Cleave"],
  ["Frailty", "Spirit Bomb"],
  ["Ascending Flame", "Sigil of Flame"],
  ["Meteoric Rise", "Fel Devastation"],
];

// Set bonus interaction data literals (referenced by getManualSetBonusInteractions)
const SET_BONUS_INTERACTION_DATA = {
  twoPiece: {
    sourceId: 1264808,
    sourceName: "Vengeance 12.0 Class Set 2pc",
    targetId: 225919,
    targetFallbackName: "Fracture",
    magnitude: { value: 35, unit: "percent", stacking: "multiplicative" },
  },
  fourPiece: {
    sourceId: 1264809,
    sourceName: "Vengeance 12.0 Class Set 4pc",
    targetId: 1276488,
    targetName: "Explosion of the Soul",
    procInfo: { procChance: 0.3, internalCooldown: 0.5 },
    triggerSpell: { id: 263642, name: "Fracture" },
  },
};

// Sibling spec/hero tree names (for contamination detection in verify.js)
const SIBLING_SPECS = {
  siblingSpec: "havoc",
  siblingHeroTrees: ["devourer", "scarred"],
};

// ================================================================
// SECTION 2: MACHINE-VALIDATED DATA
// Sourced from SimC DBC but maintained here for bootstrap ordering.
// validate-spec-data.js cross-checks these against the DBC source.
// If validation fails, update these values from the DBC output.
// ================================================================

export const BASE_SPELL_IDS = new Set([
  228477, // Soul Cleave
  228478, // Soul Cleave (damage component)
  258920, // Immolation Aura
  204596, // Sigil of Flame
  203720, // Demon Spikes
  203819, // Demon Spikes (buff)
  187827, // Metamorphosis (Vengeance)
  198793, // Vengeful Retreat
  185123, // Throw Glaive
  203782, // Shear
  263642, // Fracture
  189112, // Infernal Strike (impact)
  320378, // Immolation Aura CDR
  247455, // Spirit Bomb damage
  247456, // Frailty debuff
  203981, // Soul Fragments
  207744, // Fiery Brand debuff
  343010, // Fiery Brand modifier
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
      DATA_DIR,
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
  return new Map([
    [
      1264808,
      {
        name: "vengeance_12.0",
        pieceCount: 2,
        displayName: "Vengeance 12.0 Class Set 2pc",
      },
    ],
    [
      1264809,
      {
        name: "vengeance_12.0",
        pieceCount: 4,
        displayName: "Vengeance 12.0 Class Set 4pc",
      },
    ],
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

export function getManualSetBonusInteractions(spellMap) {
  const d = SET_BONUS_INTERACTION_DATA;
  return [
    {
      source: {
        id: d.twoPiece.sourceId,
        name: d.twoPiece.sourceName,
        isTalent: false,
        isSetBonus: true,
        setBonus: { name: "vengeance_12.0", pieceCount: 2 },
        tree: null,
        heroSpec: null,
      },
      target: {
        id: d.twoPiece.targetId,
        name:
          spellMap?.get(d.twoPiece.targetId)?.name ||
          d.twoPiece.targetFallbackName,
      },
      type: "damage_modifier",
      discoveryMethod: "manual",
      confidence: "high",
      magnitude: d.twoPiece.magnitude,
    },
    {
      source: {
        id: d.fourPiece.sourceId,
        name: d.fourPiece.sourceName,
        isTalent: false,
        isSetBonus: true,
        setBonus: { name: "vengeance_12.0", pieceCount: 4 },
        tree: null,
        heroSpec: null,
      },
      target: {
        id: d.fourPiece.targetId,
        name: d.fourPiece.targetName,
      },
      type: "proc_trigger",
      discoveryMethod: "manual",
      confidence: "high",
      procInfo: d.fourPiece.procInfo,
      triggerSpell: d.fourPiece.triggerSpell,
    },
  ];
}

export function getCppScannerSeedList() {
  return CPP_SCANNER_SEEDS;
}

export function getSiblingSpecs() {
  return SIBLING_SPECS;
}
