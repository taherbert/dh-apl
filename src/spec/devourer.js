// Devourer Demon Hunter spec adapter.
// Single source of truth for all Devourer-specific domain knowledge.
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
  specId: "devourer",
  className: "demonhunter",
  cppClassName: "demon_hunter",
  role: "dps",

  displayNames: {
    class: "Demon Hunter",
    spec: "Devourer",
  },

  // Fury cap = BASE value. Unique: fury drains continuously outside Metamorphosis.
  // Soul fragment cap is 10 (higher than VDH's 6).
  resources: {
    primary: { name: "fury", cap: 100 },
    secondary: { name: "soul_fragments", cap: 10 },
  },

  // Spell IDs populated after data pipeline run (Step 3).
  spellIds: {
    consume: 473662,
    devour: 1217610,
    voidblade: 1245414,
    void_ray: 0, // populated after extraction
    reap: 1226019,
    cull: 1245453,
    eradicate: 0, // populated after extraction
    collapsing_star: 1221150,
    soul_immolation: 0, // populated after extraction
    hungering_slash: 1239123,
    pierce_the_veil: 1245483,
    reapers_toll: 1245470,
    predators_wake: 0, // populated after extraction
    the_hunt: 0, // populated after extraction (shared class ability)
    metamorphosis: 0, // populated after extraction (Void Meta variant)
    vengeful_retreat: 198793,
    immolation_aura: 258920,
    throw_glaive: 185123,
  },

  domainOverrides: {
    consume: { fragConsume: "all" },
    devour: { fragConsume: "all", inMeta: true },
    voidblade: { furyGen: 20 },
    void_ray: { channel: true },
    reap: { fragConsume: 4, minFrags: 4 },
    cull: { fragConsume: 4, minFrags: 4, inMeta: true },
    collapsing_star: { soulCost: true },
    hungering_slash: { furyGen: 15, combo: true },
  },

  // Talents forced always-on in DoE factor space.
  // Collapsing Star: SimC asserts when Void Metamorphosis triggers without it
  // (buff.cpp:1793 — collapsing_star_stack->trigger(0) from midnight3 code path)
  requiredTalents: ["Collapsing Star"],

  // Non-DPS spec talents excluded from DoE factor space.
  excludedTalents: [
    // Defensive / utility — zero DPS contribution
    "Tempered Soul",
    "Sigil of Silence",
    "Sigil of Chains",
    "Chains of Anger",
    "Quickened Sigils",
    "Illidari Knowledge",
    "Soul Rending",
    "Demonic",
    "Pursuit of Angriness",
    "Wave of Debilitation",
  ],

  // Hero trees — Devourer uses Void-Scarred + Annihilator (shared with VDH).
  // No hero tree routing in APL — inline talent.voidsurge/talent.voidfall checks.
  heroTrees: {
    void_scarred: {
      displayName: "Void-Scarred",
      subtree: 126,
      buildMethod: "doe",
      damageSchool: "Shadow",
      keyBuffs: [
        "voidsurge",
        "monster_rising",
        "demonic_intensity",
        "burning_blades",
        "enduring_torment",
      ],
      aplBranch: "vs",
      profileKeywords: ["void_scarred", "void-scarred", "voidscarred"],
      choiceLocks: {},
    },
    annihilator: {
      displayName: "Annihilator",
      subtree: 124,
      buildMethod: "doe",
      damageSchool: "Shadowflame",
      keyBuffs: ["voidfall_building", "voidfall_spending", "catastrophe"],
      aplBranch: "anni",
      profileKeywords: ["annihilator", "anni"],
      choiceLocks: {},
    },
  },

  resourceFlow: {
    furyGenerators: [
      { ability: "voidblade", base: 20 },
      { ability: "hungering_slash", base: 15 },
      { ability: "immolation_aura", perTick: 6 },
      { ability: "consume", amount: "variable" },
    ],
    furyConsumers: [
      { ability: "void_ray", channel: true },
      { ability: "collapsing_star", cost: "souls" },
    ],
    fragGenerators: [
      { ability: "entropy", procRate: "every_8s" },
      { ability: "consume", amount: "produces_from_kills" },
    ],
    fragConsumers: [
      { ability: "reap", consume: 4 },
      { ability: "cull", consume: 4 },
      { ability: "consume", consume: "all" },
      { ability: "devour", consume: "all" },
    ],
  },

  buffWindows: [
    {
      buff: "metamorphosis",
      ability: "metamorphosis",
      duration: 15,
      damageAmp: 0.2,
      school: "all",
    },
    {
      buff: "eradicate",
      ability: "eradicate",
      duration: 6,
      damageAmp: 0.1,
      school: "all",
    },
  ],

  synergies: [
    {
      buffs: ["void_metamorphosis_stack", "consume"],
      reason: "Soul consumption builds Void Meta stacks toward transformation",
    },
    {
      buffs: ["metamorphosis", "cull"],
      reason: "Cull replaces Reap during Meta with enhanced damage",
    },
    {
      buffs: ["eradicate", "void_ray"],
      reason: "Void Ray triggers Eradicate buff for burst",
    },
    {
      buffs: ["voidblade", "hungering_slash"],
      reason: "Melee combo: Hungering Slash follows Voidblade",
    },
  ],

  keyBuffs: [
    "metamorphosis",
    "void_metamorphosis_stack",
    "eradicate",
    "hungering_slash",
    "collapsing_star_stacking",
    "collapsing_star_ready",
    "moment_of_craving",
    "voidstep",
    "voidfall_building",
    "voidfall_spending",
    "monster_rising",
    "emptiness",
    "impending_apocalypse",
    "rolling_torment",
    "dark_matter",
  ],

  offGcdAbilities: ["auto_attack"],

  cooldownBuffs: ["metamorphosis"],

  classificationHints: {
    damage_modifier: [
      "eradicate",
      "emptiness",
      "soulshaper",
      "focused_ray",
      "singular_strikes",
      "burning_blades",
      "monster_rising",
      "impending_apocalypse",
      "dark_matter",
    ],
    buff_grant: [
      "void_metamorphosis",
      "feast_of_souls",
      "moment_of_craving",
      "voidstep",
    ],
    mechanic_change: ["voidsurge", "demonsurge", "voidfall", "collapsing_star"],
    cooldown_modifier: ["voidpurge", "voidrush", "rolling_torment"],
    resource_modifier: [
      "soul_glutton",
      "gift_of_the_void",
      "voidglare_boon",
      "predators_thirst",
    ],
    duration_modifier: ["enduring_torment"],
    proc_trigger: ["spontaneous_immolation", "entropy", "undying_embers"],
  },

  resourceNames: [
    "fury",
    "soul_fragments",
    "health",
    "souls_consumed",
    "void_metamorphosis_stack",
  ],

  // Detailed resource models for analysis
  resourceModels: [
    {
      name: "fury",
      cap: 100,
      baseCap: 100,
      generators: [
        { ability: "voidblade", amount: 20, cooldown: 6 },
        { ability: "hungering_slash", amount: 15 },
        { ability: "immolation_aura", perTick: 6, duration: 6 },
        { ability: "consume", amount: "variable" },
      ],
      consumers: [{ ability: "void_ray", channel: true }],
      // Unique: fury drains outside Meta (0.065/sec base + 0.012/sec per stack)
      drain: {
        active: "outside_metamorphosis",
        baseRate: 0.065,
        perStackRate: 0.012,
        talentReduction: { soul_glutton: 0.25 },
      },
    },
    {
      name: "soul_fragments",
      cap: 10,
      generators: [
        { ability: "entropy", interval: 8, passive: true },
        { ability: "consume", produces: "from_kills" },
      ],
      consumers: [
        { ability: "reap", consume: 4, minRequired: 4 },
        { ability: "cull", consume: 4, minRequired: 4 },
        { ability: "consume", consume: "all" },
        { ability: "devour", consume: "all" },
      ],
    },
    {
      name: "void_metamorphosis_stack",
      cap: "dynamic",
      generators: [{ ability: "consume/devour", perFragment: 1 }],
      consumers: [
        {
          ability: "metamorphosis",
          consume: "all",
          trigger: "at_max_stacks",
        },
      ],
    },
  ],

  burstWindows: [
    {
      buff: "metamorphosis",
      cooldown: 0, // triggered by void meta stacks, not CD
      duration: 15,
      damageAmp: 0.2,
      school: "all",
      resourceBonus: {
        resource: "abilities",
        description: "Devour replaces Consume, Cull replaces Reap",
      },
      syncTargets: ["cull", "devour", "void_ray"],
    },
  ],

  stateMachines: {
    void_metamorphosis: {
      name: "Void Meta Cycle",
      description:
        "Build stacks via soul consumption → Meta at max → burst → drain fury",
      states: [
        {
          name: "building",
          buff: "void_metamorphosis_stack",
          trigger: "consume/devour souls",
          next: "active",
        },
        {
          name: "active",
          buff: "metamorphosis",
          duration: 15,
          enhancedAbilities: ["cull", "devour"],
          next: "draining",
        },
        {
          name: "draining",
          effect: "fury_drain",
          next: "building",
        },
      ],
      uptimeTargets: {},
    },
    annihilator: {
      name: "Voidfall Cycle",
      description: "Build Voidfall stacks → spend for fel meteors",
      states: [
        {
          name: "building",
          buff: "voidfall_building",
          stacksFrom: ["reap", "consume"],
          maxStacks: 3,
        },
        {
          name: "spending",
          buff: "voidfall_spending",
          trigger: "reap|cull",
          effect: "fel_meteors",
        },
      ],
      uptimeTargets: {},
    },
  },

  hypothesisPatterns: [
    {
      id: "meta_soul_threshold",
      category: "RESOURCE_GATING",
      template:
        "Adjust soul consumption threshold before Meta to {threshold} for faster entry",
      appliesWhen: (config) =>
        config.resourceModels.some(
          (r) => r.name === "void_metamorphosis_stack",
        ),
    },
    {
      id: "fury_drain_management",
      category: "TEMPORAL_POOLING",
      template: "Pool fury before {ability} to offset drain rate of {rate}/sec",
      appliesWhen: (config) => config.resourceModels.some((r) => r.drain),
    },
    {
      id: "reap_soul_threshold",
      category: "RESOURCE_GATING",
      template: "Reap at {threshold} souls instead of 4 when {condition}",
      appliesWhen: (config) =>
        config.resourceModels.some((r) =>
          r.consumers.some((c) => c.minRequired),
        ),
    },
    {
      id: "burst_window_sync",
      category: "COOLDOWN_SYNC",
      template:
        "Align {ability} cast within {buff} window for {amp}% {school} amp",
      appliesWhen: (config) =>
        config.burstWindows.some((w) => w.syncTargets?.length > 0),
    },
    {
      id: "state_machine_completion",
      category: "PRIORITY_REORDER",
      template:
        "Ensure {stateMachine} cycle completes: uptime targets {targets}",
      appliesWhen: (config) =>
        Object.keys(config.stateMachines || {}).length > 0,
    },
  ],

  clusterKeywords: {
    "void-ray": ["void", "ray", "channel", "eradicate"],
    "soul-consumption": [
      "soul",
      "consume",
      "devour",
      "fragment",
      "reap",
      "cull",
    ],
    "collapsing-star": ["star", "collapsing", "dark_matter", "emptiness"],
    melee: ["voidblade", "hungering", "slash", "pierce", "toll"],
    cooldown: ["metamorphosis", "hunt", "predators_wake"],
    immolation: ["immolation", "aura", "soul_immolation", "flame"],
  },

  schoolClusters: {
    Shadow: "shadow-damage",
    Chaos: "chaos-damage",
    Fire: "fire-damage",
    Shadowflame: "shadowflame-damage",
    Physical: "physical-damage",
  },
};

export const SET_BONUS_SPELL_IDS = new Set([
  // Populate when Devourer tier sets are added to SimC
]);

// C++ struct → display ability name mapping
export const STRUCT_TO_ABILITY_MAP = {
  consume: "Consume",
  devour: "Devour",
  voidblade: "Voidblade",
  void_ray: "Void Ray",
  void_ray_tick: "Void Ray",
  collapsing_star: "Collapsing Star",
  soul_immolation: "Soul Immolation",
  reap: "Reap",
  reap_base: "Reap",
  cull: "Cull",
  eradicate: "Eradicate",
  hungering_slash: "Hungering Slash",
  pierce_the_veil: "Pierce the Veil",
  reapers_toll: "Reaper's Toll",
  predators_wake: "Predator's Wake",
  the_hunt: "The Hunt",
  metamorphosis: "Metamorphosis",
  vengeful_retreat: "Vengeful Retreat",
  immolation_aura: "Immolation Aura",
  throw_glaive: "Throw Glaive",
  auto_attack_damage: "Auto Attack",
  auto_attack: "Auto Attack",
  pick_up_fragment: "Consume Soul",
  voidfall_meteor_base: "Voidfall",
  voidfall_meteor: "Voidfall",
  world_killer: "Voidfall",
  catastrophe: "Catastrophe",
};

export const CPP_SCANNER_SEEDS = [
  ["Eradicate", "Void Ray"],
  ["Soul Glutton", "Consume"],
  ["Collapsing Star", "Collapsing Star"],
  ["Hungering Slash", "Hungering Slash"],
  ["Voidrush", "Voidblade"],
];

// Sibling spec/hero tree names for contamination detection
const SIBLING_SPECS = {
  siblingSpec: "vengeance",
  siblingHeroTrees: ["aldrachi_reaver"],
};

// ================================================================
// SECTION 2: MACHINE-VALIDATED DATA
// Sourced from SimC DBC but maintained here for bootstrap ordering.
// validate-spec-data.js cross-checks these against the DBC source.
// If validation fails, update these values from the DBC output.
// ================================================================

export const BASE_SPELL_IDS = new Set([
  473662, // Consume
  1217610, // Devour
  1245414, // Voidblade
  1226019, // Reap
  1245453, // Cull
  1221150, // Collapsing Star
  1239123, // Hungering Slash
  198793, // Vengeful Retreat
  258920, // Immolation Aura
  185123, // Throw Glaive
  1225789, // Void Metamorphosis Stack
  1217607, // Void Metamorphosis
  1232310, // Feast of Souls Buff
  1241532, // Devourer's Bite Debuff
  1225826, // Eradicate
  1213649, // Void Ray Tick
  1238495, // Moment of Craving Buff
  1221162, // Collapsing Star Damage
  1227702, // Collapsing Star Stacking Buff
  1221171, // Collapsing Star Ready Buff
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
  return new Map([
    // Populate when tier sets exist
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

export function getSiblingSpecs() {
  return SIBLING_SPECS;
}
