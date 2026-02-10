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
import { config } from "../engine/startup.js";

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

  // Talent locks/bans/exclusions live in config.devourer.json under "talents".
  get lockedTalents() {
    return config.talents?.locked || [];
  },
  get bannedTalents() {
    return config.talents?.banned || [];
  },
  get excludedTalents() {
    return config.talents?.excluded || [];
  },

  // Talent clusters: groups of related S3 DPS talents that create meaningful
  // playstyle variation. Each cluster has core (minimum investment) and optional
  // extended talents. Builds include or exclude entire clusters.
  talentClusters: {
    melee: {
      core: ["Singular Strikes"],
      extended: ["Soulforged Blades", "Devourer's Bite"],
    },
    voidray: {
      core: ["Demonic Instinct"],
      extended: ["Voidglare Boon"],
    },
    star: {
      core: ["Impending Apocalypse"],
      extended: ["Star Fragments", "Calamitous"],
    },
    hunt: {
      core: ["The Hunt"],
    },
    sustain: {
      core: ["Rolling Torment"],
      extended: ["Voidrush"],
    },
  },

  // Roster templates: apex rank × cluster inclusion → crossed with hero trees.
  //
  // S3 gate: total S3 ≤ 14 - apex (34 spec pts - 20 gate).
  // Config-locked S3: DE(2) + Erad(1) = 3pt, PLUS Eradicate connectivity:
  //   Erad → StarFrag(1) → [VgBoon(1) OR RollTorm(1)] = 2pt extra.
  // Hidden cluster costs from S3 prereq chains:
  //   hunt: The Hunt(1) forces Voidrush(+1) + melee gateway(+1 if melee absent)
  //   melee full: DevBite forces Demonic Instinct(+2 if voidray absent)
  // Key sharing that eliminates double-counting:
  //   DevBite ↔ DI (voidray), Hunt ↔ Voidrush (sustain),
  //   Erad ↔ StarFrag (star full) ↔ gateway (voidray full / sustain core+)
  rosterTemplates: [
    // --- Apex 0 (max S3 = 14) ---
    {
      name: "No Hunt",
      apexRank: 0,
      include: {
        melee: "full",
        voidray: "full",
        star: "full",
        sustain: "full",
      },
      // 3+3+3+2+3(config) = 14. DevBite↔DI, Voidrush↔melee, Erad↔StarFrag↔RT.
    },
    {
      name: "No Sustain",
      apexRank: 0,
      include: { melee: "full", voidray: "full", star: "full", hunt: "full" },
      // 3+3+3+1+3+1(Voidrush forced) = 14. Erad↔StarFrag↔VgBoon.
    },
    {
      name: "No Star",
      apexRank: 0,
      include: {
        melee: "full",
        voidray: "full",
        hunt: "full",
        sustain: "full",
      },
      // 3+3+1+2+3+1(StarFrag forced) = 13. Hunt↔Voidrush(sustain), Erad↔StarFrag↔RT.
    },
    {
      name: "Broad Core",
      apexRank: 0,
      include: {
        melee: "full",
        voidray: "core",
        star: "full",
        hunt: "full",
        sustain: "core",
      },
      // 3+2+3+1+1+3+1(Voidrush) = 14. All 5 clusters at reduced investment.
    },

    // --- Apex 1 (max S3 = 13) ---
    {
      name: "No Hunt",
      apexRank: 1,
      include: {
        melee: "full",
        voidray: "core",
        star: "full",
        sustain: "full",
      },
      // 3+2+3+2+3 = 13. DevBite↔DI, Voidrush↔melee, Erad↔StarFrag↔RT.
    },
    {
      name: "No Star",
      apexRank: 1,
      include: {
        melee: "full",
        voidray: "full",
        hunt: "full",
        sustain: "full",
      },
      // 3+3+1+2+3+1(StarFrag) = 13. Hunt↔Voidrush(sustain), Erad↔StarFrag↔RT.
    },
    {
      name: "Balanced",
      apexRank: 1,
      include: {
        melee: "core",
        voidray: "core",
        star: "full",
        hunt: "full",
        sustain: "core",
      },
      // 1+2+3+1+1+3+1(Voidrush) = 12. Lighter melee, all clusters represented.
    },

    // --- Apex 2 (max S3 = 12) ---
    {
      name: "Melee+VR+Star",
      apexRank: 2,
      include: { melee: "full", voidray: "full", star: "full" },
      // 3+3+3+3 = 12. DevBite↔DI, Erad↔StarFrag↔VgBoon.
    },
    {
      name: "Core+Sustain",
      apexRank: 2,
      include: {
        melee: "full",
        voidray: "core",
        star: "full",
        sustain: "core",
      },
      // 3+2+3+1+3 = 12. Erad↔StarFrag↔RT.
    },
    {
      name: "Hunt Focus",
      apexRank: 2,
      include: {
        melee: "full",
        voidray: "core",
        hunt: "full",
        sustain: "core",
      },
      // 3+2+1+1+3+1(Voidrush)+1(StarFrag) = 12. Erad↔StarFrag↔RT.
    },

    // --- Apex 3 (max S3 = 11) ---
    {
      name: "VoidRay+Star",
      apexRank: 3,
      include: {
        melee: "core",
        voidray: "full",
        star: "full",
        sustain: "core",
      },
      // 1+3+3+1+3 = 11. Erad↔StarFrag↔VgBoon.
    },
    {
      name: "Core Everything",
      apexRank: 3,
      include: {
        melee: "core",
        voidray: "core",
        star: "core",
        hunt: "full",
        sustain: "core",
      },
      // 1+2+1+1+1+3+1(Voidrush)+1(StarFrag) = 11. All clusters at minimal cost.
    },
    {
      name: "Melee Focus",
      apexRank: 3,
      include: { melee: "full", voidray: "core", sustain: "full" },
      // 3+2+2+3+1(StarFrag) = 11. DevBite↔DI, Voidrush↔melee, Erad↔StarFrag↔RT.
    },

    // --- Apex 4 (max S3 = 10) ---
    {
      name: "Star+VR",
      apexRank: 4,
      include: {
        melee: "core",
        voidray: "full",
        star: "core",
        sustain: "core",
      },
      // 1+3+1+1+3+1(StarFrag) = 10. Midnight synergizes with CS (always crits).
    },
    {
      name: "Core All",
      apexRank: 4,
      include: {
        melee: "core",
        voidray: "core",
        star: "core",
        sustain: "core",
      },
      // 1+2+1+1+3+1(StarFrag) = 9. BFS fills 1pt spare.
    },
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
      // 110114: Wave of Debilitation vs Pursuit of Angriness — both pure utility, zero DPS
      // 110117: Set Fire to the Pain vs Improved Soul Rending — both purely defensive
      choiceLocks: { 110114: 0, 110117: 0 },
    },
    annihilator: {
      displayName: "Annihilator",
      subtree: 124,
      buildMethod: "doe",
      damageSchool: "Shadowflame",
      keyBuffs: ["voidfall_building", "voidfall_spending", "catastrophe"],
      aplBranch: "anni",
      profileKeywords: ["annihilator", "anni"],
      // 109448: Path to Oblivion vs State of Matter — pure utility, zero DPS (same as VDH)
      choiceLocks: { 109448: 1 },
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
