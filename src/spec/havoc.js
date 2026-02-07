// Havoc Demon Hunter spec adapter.
// DPS spec with Fury as primary resource.
//
// Structure:
//   Section 1 — Human domain knowledge (edit when game mechanics change)
//   Section 2 — Machine-validated data (cross-checked by validate-spec-data.js)
//   Section 3 — Auto-derived functions (generated from SPEC_CONFIG by common.js)

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
  specId: "havoc",
  className: "demonhunter",
  cppClassName: "demon_hunter",
  role: "dps",

  displayNames: {
    class: "Demon Hunter",
    spec: "Havoc",
  },

  resources: {
    primary: { name: "fury", cap: 120 },
  },

  spellIds: {
    chaos_strike: 162794,
    eye_beam: 198013,
    blade_dance: 188499,
    annihilation: 201427,
    death_sweep: 210152,
    immolation_aura: 258920,
    metamorphosis: 191427,
    vengeful_retreat: 198793,
    throw_glaive: 185123,
    felblade: 232893,
    essence_break: 258860,
    the_hunt: 370965,
    reavers_glaive: 442294,
    fel_rush: 195072,
    chaos_nova: 179057,
    sigil_of_spite: 390163,
  },

  domainOverrides: {
    chaos_strike: { furyBase: 40 },
    eye_beam: { channelDuration: 2, tickInterval: 0.2 },
    blade_dance: { furyBase: 35, aoeTargets: 8 },
    immolation_aura: {
      charges: 2,
      rechargeCd: 30,
      furyPerTick: 6,
      tickInterval: 1,
    },
    metamorphosis: { duration: 24, damageAmp: 0.2 },
    felblade: { furyGen: 40 },
    essence_break: { duration: 4, damageAmp: 0.8 },
  },

  // Non-DPS talents excluded from DoE factor space.
  // Pure defensive, utility, or mobility-only — never contribute to damage output.
  excludedTalents: [
    // Class defensive/utility
    "Vengeful Bonds",
    "Disrupting Fury",
    "Illidari Knowledge",
    "Master of the Glaive",
    "Champion of the Glaive",
    "Aura of Pain",
    "Felblade",
    "Pursuit",
    "Soul Rending",
    "Unrestrained Fury",
    "Netherwalk",
    "Darkness",
    "Swallowed Anger",
    "Long Night",
    "Pitch Black",
    "Sigil of Misery",
    "Sigil of Silence",
    "Erratic Felheart",
    // Havoc spec defensive/utility
    "Blur",
    "Desperate Instincts",
  ],

  heroTrees: {
    aldrachi_reaver: {
      displayName: "Aldrachi Reaver",
      subtree: 35,
      buildMethod: "doe",
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
      choiceLocks: {},
    },
    fel_scarred: {
      displayName: "Fel-Scarred",
      subtree: 34,
      buildMethod: "doe",
      damageSchool: "Fire",
      keyBuffs: [
        "demonsurge",
        "demonsurge_death_sweep",
        "demonsurge_annihilation",
        "demonsurge_abyssal_gaze",
        "student_of_suffering",
      ],
      aplBranch: "fs",
      profileKeywords: ["felscarred", "fel-scarred", "fel_scarred", "scarred"],
      choiceLocks: {},
    },
  },

  resourceFlow: {
    furyGenerators: [
      { ability: "demons_bite", base: 25 },
      { ability: "demon_blades", perProc: 12, passive: true },
      { ability: "immolation_aura", perTick: 6, duration: 6 },
      { ability: "felblade", amount: 40 },
    ],
    furyConsumers: [
      { ability: "chaos_strike", cost: 40 },
      { ability: "blade_dance", cost: 35 },
      { ability: "eye_beam", cost: 30 },
      { ability: "essence_break", cost: 0 },
    ],
  },

  buffWindows: [
    {
      buff: "metamorphosis",
      ability: "metamorphosis",
      duration: 24,
      damageAmp: 0.2,
      school: "all",
    },
    {
      buff: "essence_break",
      ability: "essence_break",
      duration: 4,
      damageAmp: 0.8,
      school: "Chaos",
    },
  ],

  synergies: [
    {
      buffs: ["essence_break", "blade_dance"],
      reason: "Blade Dance benefits from Essence Break damage amp",
    },
    {
      buffs: ["essence_break", "death_sweep"],
      reason: "Death Sweep benefits from Essence Break damage amp",
    },
    {
      buffs: ["metamorphosis", "eye_beam"],
      reason: "Eye Beam becomes Abyssal Gaze in Meta (Felscarred)",
    },
  ],

  keyBuffs: [
    "metamorphosis",
    "essence_break",
    "immolation_aura",
    "initiative",
    "inertia",
    "inner_demon",
    "rending_strike",
    "glaive_flurry",
    "reavers_mark",
    "thrill_of_the_fight",
    "demonsurge",
  ],

  offGcdAbilities: ["auto_attack", "vengeful_retreat"],

  cooldownBuffs: ["metamorphosis", "the_hunt"],

  classificationHints: {
    damage_modifier: [
      "essence_break",
      "inertia",
      "initiative",
      "momentum",
      "burning wound",
      "serrated glaive",
      "chaos theory",
      "ragefire",
      "inner demon",
      "any means necessary",
      "know your enemy",
      "growing inferno",
    ],
    buff_grant: [
      "rending_strike",
      "glaive_flurry",
      "reavers_mark",
      "demonsurge",
      "metamorphosis",
    ],
    mechanic_change: ["demonsurge", "thrill_of_the_fight", "art_of_the_glaive"],
    cooldown_modifier: ["cycle_of_hatred", "shattered_destiny"],
    resource_modifier: [
      "demon_blades",
      "tactical_retreat",
      "insatiable_hunger",
    ],
    duration_modifier: [],
    proc_trigger: ["inner_demon", "ragefire"],
  },

  resourceNames: ["fury"],

  resourceModels: [
    {
      name: "fury",
      cap: 120,
      baseCap: 120,
      generators: [
        { ability: "demon_blades", perProc: 12, passive: true },
        {
          ability: "immolation_aura",
          perTick: 6,
          duration: 6,
          charges: 2,
          rechargeCd: 30,
        },
        { ability: "felblade", amount: 40, cooldown: 15 },
      ],
      consumers: [
        { ability: "chaos_strike", cost: 40 },
        { ability: "blade_dance", cost: 35 },
        { ability: "eye_beam", cost: 30 },
      ],
    },
  ],

  burstWindows: [
    {
      buff: "metamorphosis",
      cooldown: 240,
      duration: 24,
      damageAmp: 0.2,
      school: "all",
      syncTargets: ["eye_beam", "blade_dance", "essence_break"],
    },
    {
      buff: "essence_break",
      cooldown: 40,
      duration: 4,
      damageAmp: 0.8,
      school: "Chaos",
      syncTargets: ["blade_dance", "death_sweep", "chaos_strike"],
    },
  ],

  stateMachines: {
    aldrachi_reaver: {
      name: "AR Cycle",
      description: "Rending Strike → empowered Chaos Strike → Glaive Flurry",
      states: [
        {
          name: "rending_strike",
          buff: "rending_strike",
          trigger: "auto_proc",
          next: "empowered_strike",
        },
        {
          name: "empowered_strike",
          ability: "chaos_strike",
          appliesBuff: "reavers_mark",
          next: "glaive_flurry",
        },
        {
          name: "glaive_flurry",
          buff: "glaive_flurry",
          trigger: "reavers_glaive",
          next: "rending_strike",
        },
      ],
      uptimeTargets: {
        rending_strike: 40,
        glaive_flurry: 30,
        reavers_mark: 50,
      },
    },
    fel_scarred: {
      name: "Demonsurge Cycle",
      description:
        "Build Demonsurge stacks via sigils/eye beam → spend via empowered abilities",
      states: [
        {
          name: "building",
          buff: "demonsurge_hardcast",
          stacksFrom: ["sigil_of_flame", "eye_beam"],
          maxStacks: 2,
        },
        {
          name: "spending",
          abilities: ["death_sweep", "annihilation"],
          trigger: "demonsurge_ready",
        },
      ],
      uptimeTargets: {},
    },
  },

  clusterKeywords: {
    "blade-dance": ["blade", "dance", "sweep", "first_blood"],
    "eye-beam": ["eye", "beam", "abyssal", "gaze", "furious"],
    "chaos-strike": ["chaos", "strike", "annihilation", "critical"],
    movement: ["rush", "retreat", "momentum", "initiative", "inertia"],
    "reaver-cycle": ["reaver", "glaive", "rending", "flurry", "mark"],
    "demonsurge-cycle": ["demonsurge", "sigil", "doom", "student"],
    cooldown: ["metamorphosis", "hunt", "essence_break"],
  },

  schoolClusters: {
    Chaos: "chaos-damage",
    Fire: "fire-damage",
    Physical: "physical-damage",
  },
};

export const SET_BONUS_SPELL_IDS = new Set([
  // No Havoc-specific tier set IDs known for Midnight yet
]);

export const STRUCT_TO_ABILITY_MAP = {
  chaos_strike: "Chaos Strike",
  chaos_strike_base: "Chaos Strike",
  annihilation: "Chaos Strike",
  blade_dance: "Blade Dance",
  blade_dance_base: "Blade Dance",
  death_sweep: "Blade Dance",
  eye_beam: "Eye Beam",
  eye_beam_base: "Eye Beam",
  immolation_aura: "Immolation Aura",
  metamorphosis: "Metamorphosis",
  vengeful_retreat: "Vengeful Retreat",
  throw_glaive: "Throw Glaive",
  felblade: "Felblade",
  essence_break: "Essence Break",
  the_hunt: "The Hunt",
  fel_rush: "Fel Rush",
  reavers_glaive: "Throw Glaive",
  auto_attack: "Auto Attack",
  auto_attack_damage: "Auto Attack",
  pick_up_fragment: "Consume Soul",
  sigil_of_flame: "Sigil of Flame",
  sigil_of_flame_base: "Sigil of Flame",
  sigil_of_flame_damage: "Sigil of Flame",
  sigil_of_flame_damage_base: "Sigil of Flame",
  sigil_of_doom: "Sigil of Flame",
  sigil_of_doom_damage: "Sigil of Flame",
  glaive_tempest: "Glaive Tempest",
  art_of_the_glaive: "Art of the Glaive",
  wounded_quarry: "Throw Glaive",
};

export const CPP_SCANNER_SEEDS = [
  ["Essence Break", "Chaos Strike"],
  ["First Blood", "Blade Dance"],
  ["Furious Gaze", "Eye Beam"],
  ["Cycle of Hatred", "Eye Beam"],
  ["Ragefire", "Immolation Aura"],
  ["Growing Inferno", "Immolation Aura"],
  ["Burning Wound", "Chaos Strike"],
];

const SIBLING_SPECS = {
  siblingSpec: "vengeance",
  siblingHeroTrees: ["annihilator"],
};

// ================================================================
// SECTION 2: MACHINE-VALIDATED DATA
// Sourced from SimC DBC but maintained here for bootstrap ordering.
// validate-spec-data.js cross-checks these against the DBC source.
// If validation fails, update these values from the DBC output.
// ================================================================

export const BASE_SPELL_IDS = new Set([
  162794, // Chaos Strike
  198013, // Eye Beam
  188499, // Blade Dance
  201427, // Annihilation
  210152, // Death Sweep
  258920, // Immolation Aura
  191427, // Metamorphosis (Havoc)
  198793, // Vengeful Retreat
  185123, // Throw Glaive
  195072, // Fel Rush
  179057, // Chaos Nova
  162243, // Demon's Bite
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
  return new Map();
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

export function getCppScannerSeedList() {
  return CPP_SCANNER_SEEDS;
}

export function getSiblingSpecs() {
  return SIBLING_SPECS;
}
