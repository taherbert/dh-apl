// Havoc Demon Hunter spec adapter.
// Single source of truth for all Havoc-specific domain knowledge.
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
  specId: "havoc",
  className: "demonhunter",
  cppClassName: "demon_hunter", // C++ snake_case form (not derivable from className)
  role: "dps",

  displayNames: {
    class: "Demon Hunter",
    spec: "Havoc",
  },

  // Fury cap = BASE value without talents.
  // Havoc does not use soul fragments as a primary resource.
  resources: {
    primary: { name: "fury", cap: 100 },
  },

  spellIds: {
    chaos_strike: 162794,
    annihilation: 201427,
    blade_dance: 188499,
    death_sweep: 210152,
    eye_beam: 198013,
    fel_rush: 195072,
    fel_rush_damage: 192611,
    metamorphosis: 187827,
    immolation_aura: 258920,
    throw_glaive: 185123,
    vengeful_retreat: 198793,
    demons_bite: 162243,
    demon_blades: 203555,
    essence_break: 258860,
    glaive_tempest: 342817,
    the_hunt: 370965,
    felblade: 232893,
  },

  domainOverrides: {
    chaos_strike: { furyRefundChance: 0.4, school: "Chaos" },
    blade_dance: { school: "Physical", aoeTargets: 8 },
    eye_beam: { channel: true, school: "Chaos", aoeTargets: 8 },
    fel_rush: { school: "Chaos", offGcd: false },
    metamorphosis: { duration: 24, damageAmp: 0.2 },
    immolation_aura: { school: "Fire", furyPerTick: 2 },
    throw_glaive: { school: "Physical" },
    demons_bite: { furyGen: 20, school: "Physical" },
    essence_break: { school: "Chaos", debuffDuration: 4 },
  },

  // Talent locks/bans/exclusions live in config.havoc.json under "talents".
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
    essence_break: {
      core: ["Essence Break"],
      extended: ["Know Your Enemy", "Cycle of Hatred"],
    },
    inertia: {
      core: ["Inertia"],
      extended: ["Unbound Chaos"],
    },
    burn: {
      core: ["Burning Wound"],
      extended: ["A Fire Inside", "Ragefire"],
    },
    hunt: {
      core: ["The Hunt"],
    },
    glaive: {
      core: ["Glaive Tempest"],
      extended: ["Screaming Brutality"],
    },
  },

  // Roster templates: apex rank x cluster inclusion -> crossed with hero trees.
  // Each template produces 1 build per hero tree (all hero choice nodes locked).
  // Target: ~30 templates -> ~60 builds (balanced AR/FS).
  rosterTemplates: [
    // --- Apex 0 (no apex, max S3 budget) ---
    // 4-cluster combos: all C(4,3) selections from {EB, Burn, Hunt, Glaive} + Inertia
    {
      name: "EB+Burn",
      apexRank: 0,
      include: {
        essence_break: "full",
        inertia: "full",
        burn: "full",
        glaive: "full",
      },
    },
    {
      name: "EB+Hunt",
      apexRank: 0,
      include: {
        essence_break: "full",
        inertia: "full",
        hunt: "full",
        glaive: "full",
      },
    },
    {
      name: "Burn+Hunt",
      apexRank: 0,
      include: {
        inertia: "full",
        burn: "full",
        hunt: "full",
        glaive: "full",
      },
    },
    {
      name: "EB+Burn+Hunt",
      apexRank: 0,
      include: {
        essence_break: "full",
        inertia: "full",
        burn: "full",
        hunt: "full",
      },
    },
    // 5-cluster: all at mixed investment
    {
      name: "All Clusters",
      apexRank: 0,
      include: {
        essence_break: "core",
        inertia: "full",
        burn: "core",
        hunt: "core",
        glaive: "core",
      },
    },
    // 3-cluster: leaner builds testing cluster value
    {
      name: "EB+Glaive",
      apexRank: 0,
      include: { essence_break: "full", inertia: "full", glaive: "full" },
    },
    {
      name: "Burn+Glaive",
      apexRank: 0,
      include: { inertia: "full", burn: "full", glaive: "full" },
    },
    {
      name: "Hunt+Glaive",
      apexRank: 0,
      include: { inertia: "full", hunt: "full", glaive: "full" },
    },

    // --- Apex 1 (Eternal Hunt rank 1) ---
    {
      name: "EB+Burn",
      apexRank: 1,
      include: {
        essence_break: "full",
        inertia: "full",
        burn: "full",
        glaive: "core",
      },
    },
    {
      name: "EB+Hunt",
      apexRank: 1,
      include: {
        essence_break: "full",
        inertia: "full",
        hunt: "full",
        glaive: "full",
      },
    },
    {
      name: "Burn+Hunt",
      apexRank: 1,
      include: {
        inertia: "core",
        burn: "full",
        hunt: "full",
        glaive: "full",
      },
    },
    {
      name: "EB+Burn+Hunt",
      apexRank: 1,
      include: {
        essence_break: "full",
        inertia: "core",
        burn: "full",
        hunt: "full",
      },
    },
    {
      name: "Hunt+Glaive",
      apexRank: 1,
      include: { inertia: "full", hunt: "full", glaive: "full" },
    },
    {
      name: "EB+Glaive",
      apexRank: 1,
      include: { essence_break: "full", inertia: "full", glaive: "full" },
    },
    {
      name: "Burn+Glaive",
      apexRank: 1,
      include: { inertia: "full", burn: "full", glaive: "full" },
    },

    // --- Apex 2 (Eternal Hunt rank 2) ---
    {
      name: "EB Focus",
      apexRank: 2,
      include: {
        essence_break: "full",
        inertia: "full",
        burn: "core",
        glaive: "full",
      },
    },
    {
      name: "Burn Focus",
      apexRank: 2,
      include: { inertia: "full", burn: "full", glaive: "full" },
    },
    {
      name: "Hunt Focus",
      apexRank: 2,
      include: { inertia: "core", essence_break: "full", hunt: "full" },
    },
    {
      name: "Glaive Focus",
      apexRank: 2,
      include: { inertia: "full", glaive: "full" },
    },
    {
      name: "EB+Hunt",
      apexRank: 2,
      include: { essence_break: "full", inertia: "core", hunt: "full" },
    },
    {
      name: "Burn+Hunt",
      apexRank: 2,
      include: { inertia: "core", burn: "full", hunt: "full" },
    },
    {
      name: "EB+Burn",
      apexRank: 2,
      include: { essence_break: "full", inertia: "core", burn: "full" },
    },

    // --- Apex 3 (Eternal Hunt rank 3) ---
    {
      name: "EB Core",
      apexRank: 3,
      include: { inertia: "core", essence_break: "full", glaive: "core" },
    },
    {
      name: "Burn Core",
      apexRank: 3,
      include: { inertia: "core", burn: "full", glaive: "core" },
    },
    {
      name: "Hunt Core",
      apexRank: 3,
      include: { inertia: "core", hunt: "full", glaive: "core" },
    },
    {
      name: "Glaive Core",
      apexRank: 3,
      include: { inertia: "core", glaive: "full" },
    },
    {
      name: "EB+Burn",
      apexRank: 3,
      include: { essence_break: "core", inertia: "core", burn: "core" },
    },
    {
      name: "EB+Hunt",
      apexRank: 3,
      include: { essence_break: "core", inertia: "core", hunt: "core" },
    },
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
      // Same choice locks as Vengeance AR - identical hero tree node IDs
      // 94911: Unhindered Assault (DPS via Felblade reset)
      // 94896: Both defensive (Army Unto Oneself / Incorruptible Spirit)
      // 94910: Lock to halve AR roster (Keen Engagement vs Preemptive Strike within noise)
      choiceLocks: { 94911: 1, 94896: 0, 94910: 0 },
    },
    fel_scarred: {
      displayName: "Fel-Scarred",
      subtree: 34,
      buildMethod: "doe",
      damageSchool: "Fire",
      keyBuffs: [
        "demonsurge",
        "monster_rising",
        "demonic_intensity",
        "burning_blades",
        "enduring_torment",
      ],
      aplBranch: "fs",
      profileKeywords: ["fel_scarred", "fel-scarred", "felscarred"],
      // 94913: Wave of Debilitation vs Pursuit of Angriness (both utility, zero DPS)
      // 94899: Set Fire to the Pain vs Improved Soul Rending (both defensive, zero DPS)
      // 94902: Student of Suffering vs Flamebound (both DPS; Student gives Mastery + Fury
      //        from Eye Beam which is higher ST value than Flamebound's Immo Aura crit bonus)
      choiceLocks: { 94913: 0, 94899: 0, 94902: 0 },
    },
  },

  resourceFlow: {
    furyGenerators: [
      { ability: "demons_bite", base: 20 },
      { ability: "immolation_aura", perTick: 2, duration: 6 },
      { ability: "felblade", amount: 40 },
      { ability: "demon_blades", procRate: "passive", amount: 12 },
    ],
    furyConsumers: [
      { ability: "chaos_strike", cost: 40 },
      { ability: "blade_dance", cost: 35 },
      { ability: "eye_beam", cost: 30 },
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
      buff: "essence_break_debuff",
      ability: "essence_break",
      duration: 4,
      damageAmp: 0.8,
      school: "Chaos",
    },
    {
      buff: "inertia",
      ability: "fel_rush",
      duration: 5,
      damageAmp: 0.18,
      school: "all",
    },
  ],

  synergies: [
    {
      buffs: ["metamorphosis", "chaos_strike"],
      reason: "CS becomes Annihilation during Meta with higher damage",
    },
    {
      buffs: ["metamorphosis", "blade_dance"],
      reason: "BD becomes Death Sweep during Meta with higher damage",
    },
    {
      buffs: ["essence_break_debuff", "chaos_strike"],
      reason: "CS benefits from Essence Break damage amp",
    },
    {
      buffs: ["essence_break_debuff", "blade_dance"],
      reason: "BD benefits from Essence Break damage amp",
    },
    {
      buffs: ["inertia", "eye_beam"],
      reason: "Eye Beam benefits from Inertia damage amp window",
    },
    {
      buffs: ["demonic", "eye_beam"],
      reason: "Eye Beam triggers Metamorphosis via Demonic talent",
    },
  ],

  keyBuffs: [
    "metamorphosis",
    "inertia",
    "furious_gaze",
    "essence_break_debuff",
    "unbound_chaos",
    "initiative",
    "inner_demon",
    "burning_wound",
    "chaos_theory",
    "tactical_retreat",
    "rending_strike",
    "glaive_flurry",
    "demonsurge",
    "monster_rising",
  ],

  offGcdAbilities: ["auto_attack"],

  cooldownBuffs: ["metamorphosis", "the_hunt"],

  classificationHints: {
    damage_modifier: [
      "critical_chaos",
      "know_your_enemy",
      "first_blood",
      "isolated_prey",
      "inertia",
      "exergy",
      "chaos_theory",
      "burning_blades",
      "monster_rising",
      "demonic_intensity",
      "serrated_glaive",
      "burning_wound",
      "dancing_with_fate",
      "chaotic_disposition",
    ],
    buff_grant: [
      "furious_gaze",
      "initiative",
      "unbound_chaos",
      "tactical_retreat",
      "inner_demon",
      "demonsurge",
      "metamorphosis",
    ],
    mechanic_change: [
      "demonic",
      "essence_break",
      "demon_blades",
      "shattered_destiny",
      "thrill_of_the_fight",
    ],
    cooldown_modifier: [
      "cycle_of_hatred",
      "chaotic_transformation",
      "rush_of_chaos",
    ],
    resource_modifier: [
      "blind_fury",
      "burning_hatred",
      "demon_blades",
      "tactical_retreat",
    ],
    duration_modifier: ["shattered_destiny", "enduring_torment"],
    proc_trigger: [
      "relentless_onslaught",
      "ragefire",
      "screaming_brutality",
      "furious_throws",
      "undying_embers",
    ],
  },

  resourceNames: ["fury", "health"],

  resourceModels: [
    {
      name: "fury",
      cap: 100,
      baseCap: 100,
      generators: [
        { ability: "demons_bite", amount: 20, cooldown: 0 },
        { ability: "immolation_aura", perTick: 2, duration: 6 },
        { ability: "felblade", amount: 40, cooldown: 15 },
        { ability: "demon_blades", amount: 12, passive: true },
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
      resourceBonus: {
        resource: "abilities",
        description: "CS becomes Annihilation, BD becomes Death Sweep",
      },
      syncTargets: ["chaos_strike", "blade_dance", "eye_beam"],
    },
    {
      buff: "essence_break_debuff",
      cooldown: 25,
      duration: 4,
      damageAmp: 0.8,
      school: "Chaos",
      syncTargets: ["chaos_strike", "blade_dance"],
    },
  ],

  stateMachines: {
    aldrachi_reaver: {
      name: "AR Cycle",
      description: "Rending Strike -> empowered attack -> Glaive Flurry",
      states: [
        {
          name: "rending_strike",
          buff: "rending_strike",
          trigger: "auto_proc",
          next: "empowered_attack",
        },
        {
          name: "empowered_attack",
          ability: "chaos_strike",
          appliesBuff: "reavers_mark",
          next: "glaive_flurry",
        },
        {
          name: "glaive_flurry",
          buff: "glaive_flurry",
          trigger: "empowered_spender",
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
      description: "Violent Transformation -> Demonsurge empowered abilities",
      states: [
        {
          name: "building",
          trigger: "metamorphosis_or_eye_beam",
          next: "empowered",
        },
        {
          name: "empowered",
          buff: "demonsurge",
          abilities: ["eye_beam", "fel_rush"],
          next: "building",
        },
      ],
      uptimeTargets: {},
    },
  },

  hypothesisPatterns: [
    {
      id: "burst_window_sync",
      category: "COOLDOWN_SYNC",
      template:
        "Align {ability} cast within {buff} window for {amp}% {school} amp",
      appliesWhen: (config) =>
        config.burstWindows.some((w) => w.syncTargets?.length > 0),
    },
    {
      id: "resource_overflow",
      category: "RESOURCE_GATING",
      template: "Pool {resource} below cap before {consumer} to avoid overflow",
      appliesWhen: (config) => config.resourceModels.some((r) => r.cap),
    },
    {
      id: "meta_enhancement",
      category: "CYCLE_ALIGNMENT",
      template:
        "Prioritize {ability} during Metamorphosis for enhanced version",
      appliesWhen: (config) => config.burstWindows.some((w) => w.resourceBonus),
    },
    {
      id: "state_machine_completion",
      category: "PRIORITY_REORDER",
      template:
        "Ensure {stateMachine} cycle completes: uptime targets {targets}",
      appliesWhen: (config) =>
        Object.keys(config.stateMachines || {}).length > 0,
    },
    {
      id: "essence_break_alignment",
      category: "COOLDOWN_SYNC",
      template: "Pack spenders into Essence Break window for {amp}% amp",
      appliesWhen: (config) =>
        config.burstWindows.some((w) => w.buff === "essence_break_debuff"),
    },
  ],

  clusterKeywords: {
    "eye-beam": ["eye", "beam", "demonic", "furious", "gaze", "blind", "fury"],
    "chaos-strike": ["chaos", "strike", "annihilation", "critical", "refund"],
    "blade-dance": ["blade", "dance", "death", "sweep", "first_blood", "trail"],
    mobility: ["fel_rush", "vengeful_retreat", "inertia", "momentum"],
    "burn-dot": ["burning", "wound", "ragefire", "fire_inside", "inferno"],
    cooldown: ["metamorphosis", "hunt", "essence_break"],
    immolation: ["immolation", "aura", "unbound_chaos"],
  },

  schoolClusters: {
    Chaos: "chaos-damage",
    Fire: "fire-damage",
    Physical: "physical-damage",
  },
};

export const SET_BONUS_SPELL_IDS = new Set([
  // Populate when Havoc tier sets are added to SimC
]);

// C++ struct -> display ability name mapping
export const STRUCT_TO_ABILITY_MAP = {
  auto_attack: "Auto Attack",
  auto_attack_damage: "Auto Attack",
  chaos_strike_base: "Chaos Strike",
  chaos_strike: "Chaos Strike",
  annihilation: "Chaos Strike",
  blade_dance_base: "Blade Dance",
  blade_dance: "Blade Dance",
  death_sweep: "Blade Dance",
  eye_beam_base: "Eye Beam",
  eye_beam: "Eye Beam",
  abyssal_gaze: "Eye Beam",
  fel_rush: "Fel Rush",
  metamorphosis: "Metamorphosis",
  immolation_aura: "Immolation Aura",
  throw_glaive: "Throw Glaive",
  vengeful_retreat: "Vengeful Retreat",
  essence_break: "Essence Break",
  glaive_tempest: "Glaive Tempest",
  the_hunt: "The Hunt",
  demon_blades: "Demon Blades",
  felblade: "Felblade",
  burning_wound: "Burning Wound",
  inner_demon: "Inner Demon",
  relentless_onslaught: "Relentless Onslaught",
  ragefire: "Ragefire",
  collective_anguish: "Collective Anguish",
  pick_up_fragment: "Pick Up Fragment",
  // AR hero
  art_of_the_glaive: "Art of the Glaive",
  reavers_glaive: "Reaver's Glaive",
  warblades_hunger: "Warblade's Hunger",
  wounded_quarry: "Wounded Quarry",
  preemptive_strike: "Preemptive Strike",
  // FS hero
  demonsurge: "Demonsurge",
  burning_blades: "Burning Blades",
};

export const CPP_SCANNER_SEEDS = [
  ["First Blood", "Blade Dance"],
  ["Essence Break", "Essence Break"],
  ["Burning Wound", "Burning Wound"],
  ["Cycle of Hatred", "Eye Beam"],
  ["Furious Gaze", "Eye Beam"],
  ["Inertia", "Fel Rush"],
  ["Ragefire", "Immolation Aura"],
];

// Sibling spec/hero tree names for contamination detection
const SIBLING_SPECS = {
  siblingSpec: "vengeance",
  siblingHeroTrees: ["annihilator", "void_scarred"],
};

// ================================================================
// SECTION 2: MACHINE-VALIDATED DATA
// Sourced from SimC DBC but maintained here for bootstrap ordering.
// validate-spec-data.js cross-checks these against the DBC source.
// If validation fails, update these values from the DBC output.
// ================================================================

export const BASE_SPELL_IDS = new Set([
  162794, // Chaos Strike
  193840, // Chaos Strike Fury
  197125, // Chaos Strike Refund
  201427, // Annihilation
  188499, // Blade Dance
  210152, // Death Sweep
  195072, // Fel Rush (cast)
  192611, // Fel Rush (damage)
  187827, // Metamorphosis
  200166, // Metamorphosis (impact)
  258920, // Immolation Aura
  185123, // Throw Glaive
  198793, // Vengeful Retreat
  162243, // Demon's Bite
  203555, // Demon Blades
  206478, // Demonic Appetite
  212612, // Havoc Demon Hunter (spec aura)
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
  // Populate when Havoc tier sets are added
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

export function getSiblingSpecs() {
  return SIBLING_SPECS;
}
