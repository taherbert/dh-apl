// Vengeance Demon Hunter spec adapter.
// Single source of truth for all VDH-specific domain knowledge.
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
import { decodeAllTalents } from "../util/talent-fingerprint.js";

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
    fracture: {
      furyGenMeta: 40,
      fragGenMeta: 3,
      apCoeff: 1.035,
      school: "Physical",
      aoeTargets: 1,
    },
    spirit_bomb: {
      fragConsume: "up_to_5",
      apCoeff: 0.4,
      school: "Fire",
      aoeTargets: 5,
    },
    soul_cleave: {
      fragConsume: "up_to_2",
      apCoeff: 1.29,
      school: "Physical",
      aoeTargets: 5,
    },
    immolation_aura: {
      charges: 2,
      rechargeCd: 30,
      furyPerTick: 3,
      tickInterval: 1,
      apCoeff: 0.98,
      school: "Fire",
    },
    sigil_of_flame: { apCoeff: 0.792, school: "Fire", aoeTargets: 8 },
    fiery_brand: {
      duration: 10,
      damageAmp: 0.3,
      apCoeff: 1.0,
      school: "Fire",
      aoeTargets: 1,
    },
    soul_carver: { apCoeff: 2.08, school: "Fire", aoeTargets: 1 },
    fel_devastation: {
      gcd: false,
      apCoeff: 1.54,
      school: "Fire",
      aoeTargets: 5,
    },
    sigil_of_spite: {
      fragGen: "variable",
      apCoeff: 6.92,
      school: "Chromatic",
      aoeTargets: 8,
    },
    reavers_glaive: { apCoeff: 3.45, school: "Physical", aoeTargets: 1 },
    felblade: { apCoeff: 0.62, school: "Physical", aoeTargets: 1 },
    throw_glaive: { apCoeff: 0.41, school: "Physical", aoeTargets: 1 },
  },

  // Talent locks/bans/exclusions live in config.vengeance.json under "talents".
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
    brand: {
      core: ["Burning Alive"],
      extended: ["Charred Flesh", "Down in Flames"],
    },
    sigil: { core: ["Cycle of Binding"] },
    harvest: {
      core: ["Vulnerability"],
      extended: ["Soulcrush", "Focused Cleave"],
    },
    feldev: {
      core: ["Stoke the Flames"],
      extended: ["Vengeful Beast", "Darkglare Boon"],
    },
    sc: { core: ["Soul Carver"] },
  },

  // Roster templates: each specifies an Apex rank (0-4) and which clusters to
  // include. Crossed with hero tree × variant to produce the full roster.
  // Clusters not in `include` are excluded (their talents are added to the
  // exclusion set so BFS won't auto-select them).
  //
  // Two groups:
  //   1. APL Coverage (Apex 0-1): test APL with/without clusters at both apex levels
  //   2. Apex Scaling (Apex 2-4): focus-driven — what to skip flows from build identity
  rosterTemplates: [
    // --- APL Coverage: Apex 0 (no apex, 14 S3 budget, 13 demand — 1 spare) ---
    // Names describe the two major clusters that define the build's identity.
    // At Apex 0-1, nearly everything is present; the name highlights the focus.
    {
      name: "Complete",
      apexRank: 0,
      include: {
        brand: "full",
        sigil: "full",
        harvest: "full",
        feldev: "full",
        sc: "full",
      },
    },
    {
      name: "Harvest + Fel Dev",
      apexRank: 0,
      include: { sigil: "full", harvest: "full", feldev: "full", sc: "full" },
    },
    {
      name: "Brand + Fel Dev",
      apexRank: 0,
      include: { brand: "full", sigil: "full", feldev: "full", sc: "full" },
    },
    {
      name: "Brand + Harvest",
      apexRank: 0,
      include: { brand: "full", sigil: "full", harvest: "full", sc: "full" },
    },

    // --- APL Coverage: Apex 1 (same cluster coverage, apex.1 active) ---
    {
      name: "Complete",
      apexRank: 1,
      include: {
        brand: "full",
        sigil: "full",
        harvest: "full",
        feldev: "full",
        sc: "full",
      },
    },
    {
      name: "Harvest + Fel Dev",
      apexRank: 1,
      include: { sigil: "full", harvest: "full", feldev: "full", sc: "full" },
    },
    {
      name: "Brand + Fel Dev",
      apexRank: 1,
      include: { brand: "full", sigil: "full", feldev: "full", sc: "full" },
    },
    {
      name: "Brand + Harvest",
      apexRank: 1,
      include: { brand: "full", sigil: "full", harvest: "full", sc: "full" },
    },

    // --- Apex 2 (skip 1 pt) — two meaningful 1-pt standalone drops ---
    {
      name: "No Soul Carver",
      apexRank: 2,
      include: {
        brand: "full",
        sigil: "full",
        harvest: "full",
        feldev: "full",
      },
    },
    {
      name: "No Sigil",
      apexRank: 2,
      include: { brand: "full", harvest: "full", feldev: "full", sc: "full" },
    },

    // --- Apex 3 (skip 2 pts) — focus determines what to sacrifice ---
    // Three majors: drop both standalones, keep all three major clusters full
    {
      name: "Three Majors",
      apexRank: 3,
      include: { brand: "full", harvest: "full", feldev: "full" },
    },
    // Core Fel Dev: narrow FelDev to core, keep soul + fire economy intact
    {
      name: "Core Fel Dev",
      apexRank: 3,
      include: {
        brand: "full",
        sigil: "full",
        harvest: "full",
        feldev: "core",
        sc: "full",
      },
    },
    // Core Harvest: narrow Harvest to core (Vuln only), keep brand + fel dev
    {
      name: "Core Harvest",
      apexRank: 3,
      include: {
        brand: "full",
        sigil: "full",
        harvest: "core",
        feldev: "full",
      },
    },

    // --- Apex 4 (skip 3 pts) — focus defines which cluster to sacrifice ---
    // Brand + Harvest: sacrifice FelDev entirely
    {
      name: "Brand + Harvest",
      apexRank: 4,
      include: { brand: "full", sigil: "full", harvest: "full", sc: "full" },
    },
    // Brand + Fel Dev: sacrifice Harvest entirely
    {
      name: "Brand + Fel Dev",
      apexRank: 4,
      include: { brand: "full", sigil: "full", feldev: "full", sc: "full" },
    },
    // Harvest + Fel Dev: sacrifice Brand extended (keep BA for fire synergy)
    {
      name: "Harvest + Fel Dev",
      apexRank: 4,
      include: {
        brand: "core",
        sigil: "full",
        harvest: "full",
        feldev: "full",
        sc: "full",
      },
    },
    // Balanced: sacrifice FelDev extended + SC, keep all cluster cores
    {
      name: "Balanced",
      apexRank: 4,
      include: {
        brand: "full",
        sigil: "full",
        harvest: "full",
        feldev: "core",
      },
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
      // Hero choice locks: defensive-only choices locked to 0, DPS-relevant unlocked for DoE
      // 94911: Locked to Unhindered Assault (DPS via Felblade reset)
      // 94896: Locked to 0 (Army Unto Oneself / Incorruptible Spirit both defensive)
      // 94910: Locked to Keen Engagement (KE vs PS is within noise; lock to halve AR roster)
      choiceLocks: { 94911: 1, 94896: 0, 94910: 0 },
    },
    annihilator: {
      displayName: "Annihilator",
      subtree: 124,
      buildMethod: "doe",
      damageSchool: "Shadowflame",
      keyBuffs: ["voidfall_building", "voidfall_spending", "catastrophe"],
      aplBranch: "anni",
      profileKeywords: ["annihilator", "anni"],
      // 109448: Locked to State of Matter (both options are pure utility, zero DPS)
      // 109448: Locked to State of Matter (both options are pure utility, zero DPS)
      // 109450: Locked to Harness the Cosmos (+15% meteor always beats Doomsayer opener burst)
      choiceLocks: { 109448: 1, 109450: 1 },
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
      damageAmp: 0.3,
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

  // Build-specific talent modifiers for state-sim scoring enrichment.
  // Each key is a talent name (snake_case), each value maps ability → multiplier.
  // Applied multiplicatively to base apCoeff scores when the talent is present.
  // Hand-authored from interactions-summary.json, cross-referenced with SimC C++ source.
  talentModifiers: {
    stoke_the_flames: { fel_devastation: 1.3 },
    meteoric_rise: { fel_devastation: 1.15 },
    ascending_flame: { sigil_of_flame: 1.5 },
    celestial_echoes: { fracture: 1.25 },
    tempered_steel: {
      fracture: 1.12,
      soul_cleave: 1.12,
      reavers_glaive: 1.12,
      throw_glaive: 1.12,
    },
    keen_edge: {
      fracture: 1.1,
      soul_cleave: 1.1,
      reavers_glaive: 1.2, // Keen Edge: RG +20%, other Physical +10%
      throw_glaive: 1.1,
    },
    volatile_flameblood: { immolation_aura: 1.1 },
    incisive_blade: { soul_cleave: 1.1 },
    // fiery_demise is NOT here — it's a dynamic FB-window amp, handled in scoreDpgcd
  },

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

  // ---- Analysis-driven sections (read by analysis modules) ----

  resourceModels: [
    {
      name: "fury",
      cap: 120,
      baseCap: 100,
      generators: [
        {
          ability: "fracture",
          amount: 25,
          metaAmount: 40,
          charges: 2,
          rechargeCd: 4.5,
        },
        {
          ability: "immolation_aura",
          perTick: 3,
          duration: 6,
          charges: 2,
          rechargeCd: 30,
        },
        { ability: "felblade", amount: 15, cooldown: 15 },
      ],
      consumers: [
        { ability: "spirit_bomb", cost: 40 },
        { ability: "soul_cleave", cost: 35 },
        { ability: "fel_devastation", cost: 50 },
      ],
    },
    {
      name: "soul_fragments",
      cap: 6,
      generators: [
        {
          ability: "fracture",
          amount: 2,
          metaAmount: 3,
          charges: 2,
          rechargeCd: 4.5,
        },
        { ability: "soul_carver", amount: 3, cooldown: 30 },
        { ability: "sigil_of_spite", amount: 3, cooldown: 60 },
        {
          ability: "fallout",
          procRate: 0.6,
          source: "immolation_aura",
          perTick: true,
        },
      ],
      consumers: [
        {
          ability: "spirit_bomb",
          maxConsume: 5,
          valuePerUnit: "+20% damage per fragment",
        },
        {
          ability: "soul_cleave",
          maxConsume: 2,
          valuePerUnit: "healing + Soul Furnace stacks",
        },
      ],
    },
  ],

  burstWindows: [
    {
      buff: "fiery_brand",
      cooldown: 60,
      duration: 10,
      damageAmp: 0.3,
      school: "Fire",
      talentDep: "fiery_demise",
      syncTargets: ["soul_carver", "fel_devastation"],
    },
    {
      buff: "metamorphosis",
      cooldown: 180,
      duration: 15,
      damageAmp: 0.2,
      school: "all",
      resourceBonus: {
        resource: "soul_fragments",
        ability: "fracture",
        bonus: 1,
      },
      syncTargets: ["fracture", "spirit_bomb"],
    },
  ],

  setBonus: {
    twoPiece: { target: "fracture", modifier: 1.35 },
    fourPiece: {
      ability: "explosion_of_the_soul",
      procChance: 0.3,
      apCoeff: 1.8,
      school: "Fire",
      aoeTargetCap: 5,
      trigger: "fracture",
    },
  },

  tuning: {
    vfSpendingBonus: 100,
    arWoundedQuarryAmp: 1.3,
    arBladecraftAmp: 1.5,
    windowValuation: { fieryBrand: 60 },
  },

  stateMachines: {
    aldrachi_reaver: {
      name: "AR Cycle",
      description:
        "Rending Strike → empowered Fracture → empowered Soul Cleave → Glaive Flurry",
      states: [
        {
          name: "rending_strike",
          buff: "rending_strike",
          trigger: "auto_proc",
          next: "empowered_fracture",
        },
        {
          name: "empowered_fracture",
          ability: "fracture",
          appliesBuff: "reavers_mark",
          ampPercent: 10,
          next: "empowered_soul_cleave",
        },
        {
          name: "empowered_soul_cleave",
          ability: "soul_cleave",
          ampPercent: 20,
          triggersBuff: "glaive_flurry",
          next: "rending_strike",
        },
      ],
      uptimeTargets: {
        rending_strike: 40,
        glaive_flurry: 30,
        reavers_mark: 50,
      },
    },
    annihilator: {
      name: "Voidfall Cycle",
      description: "Build Voidfall stacks → spend at 3 for fel meteors",
      states: [
        {
          name: "building",
          buff: "voidfall_building",
          stacksFrom: ["fracture", "metamorphosis"],
          maxStacks: 3,
        },
        {
          name: "spending",
          buff: "voidfall_spending",
          trigger: "spirit_bomb|soul_cleave",
          effect: "fel_meteors",
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
      id: "meta_resource_bonus",
      category: "CYCLE_ALIGNMENT",
      template:
        "Prioritize {ability} during {buff} for {bonus} extra {resource}",
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
      id: "fragment_pooling",
      category: "TEMPORAL_POOLING",
      template: "Pool {resource} for {consumer} when {condition}",
      appliesWhen: (config) =>
        config.resourceModels.some((r) =>
          r.consumers.some((c) => c.maxConsume),
        ),
    },
    {
      id: "soul_furnace_threshold",
      category: "CONDITION_RELAXATION",
      template: "Adjust {buff} stack threshold from {current} to {proposed}",
      buffName: "soul_furnace",
      appliesWhen: () => true,
    },
  ],

  clusterKeywords: {
    "fire-brand": ["fiery", "brand", "fire", "burn", "flame"],
    "immolation-aura": ["immolation", "aura", "flames", "engulf"],
    sigil: ["sigil", "quickened", "concentrated", "chains"],
    frailty: ["frailty", "spirit_bomb", "vulnerability", "soulcrush"],
    fragment: ["fragment", "soul", "fracture", "consume", "shatter"],
    cooldown: ["devastation", "carver", "metamorphosis", "fel"],
    physical: ["cleave", "physical", "glaive", "strike"],
  },

  schoolClusters: {
    Fire: "fire-damage",
    Physical: "physical-damage",
    Chaos: "chaos-damage",
    Shadowflame: "shadowflame-damage",
  },

  // Scenario definitions for pattern analysis. Each scenario defines the fight
  // parameters; builds come from the roster (or fallback analysisArchetypes).
  scenarios: {
    st: { target_count: 1, durations: [120, 300] },
    small_aoe: { target_count: 5, durations: [75] },
    big_aoe: { target_count: 10, durations: [60] },
  },

  // Fallback build configs when no roster is populated. Prefer roster-derived
  // configs via rosterBuildToConfig() — these are only used as a safety net.
  analysisArchetypes: {
    st: {
      "anni-apex3-dgb": {
        heroTree: "annihilator",
        apexRank: 3,
        haste: 0.2,
        target_count: 1,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          soul_carver: false,
          soul_sigils: false,
          quickened_sigils: false,
          cycle_of_binding: false,
          vulnerability: false,
        },
      },
      "anni-apex3-nodgb": {
        heroTree: "annihilator",
        apexRank: 3,
        haste: 0.2,
        target_count: 1,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: false,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          soul_carver: false,
        },
      },
      "anni-apex0-fullstack": {
        heroTree: "annihilator",
        apexRank: 0,
        haste: 0.2,
        target_count: 1,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          soul_carver: true,
          soul_sigils: true,
          cycle_of_binding: true,
          vulnerability: true,
          fallout: true,
        },
      },
      "ar-apex3-dgb": {
        heroTree: "aldrachi_reaver",
        apexRank: 3,
        haste: 0.2,
        target_count: 1,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          art_of_the_glaive: true,
          soul_carver: false,
          soul_sigils: false,
          quickened_sigils: false,
          cycle_of_binding: false,
          vulnerability: false,
        },
      },
      "ar-apex3-nodgb": {
        heroTree: "aldrachi_reaver",
        apexRank: 3,
        haste: 0.2,
        target_count: 1,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: false,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          art_of_the_glaive: true,
          soul_carver: false,
          soul_sigils: false,
          quickened_sigils: false,
        },
      },
    },
    small_aoe: {
      "anni-apex3-dgb-5t": {
        heroTree: "annihilator",
        apexRank: 3,
        haste: 0.2,
        target_count: 5,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          soul_carver: false,
        },
      },
      "anni-apex0-fullstack-5t": {
        heroTree: "annihilator",
        apexRank: 0,
        haste: 0.2,
        target_count: 5,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          soul_carver: true,
          soul_sigils: true,
          cycle_of_binding: true,
          vulnerability: true,
          fallout: true,
        },
      },
      "ar-apex3-dgb-5t": {
        heroTree: "aldrachi_reaver",
        apexRank: 3,
        haste: 0.2,
        target_count: 5,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          art_of_the_glaive: true,
          soul_carver: false,
        },
      },
    },
    big_aoe: {
      "anni-apex3-dgb-10t": {
        heroTree: "annihilator",
        apexRank: 3,
        haste: 0.2,
        target_count: 10,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          soul_carver: false,
        },
      },
      "ar-apex3-dgb-10t": {
        heroTree: "aldrachi_reaver",
        apexRank: 3,
        haste: 0.2,
        target_count: 10,
        talents: {
          fiery_demise: true,
          fiery_brand: true,
          charred_flesh: true,
          burning_alive: true,
          down_in_flames: true,
          darkglare_boon: true,
          meteoric_rise: true,
          stoke_the_flames: true,
          vengeful_beast: true,
          untethered_rage: true,
          fallout: true,
          art_of_the_glaive: true,
          soul_carver: false,
        },
      },
    },
  },
};

// Flatten scenario-grouped archetypes into a single name→config map.
// Used by CLI tools (optimal-timeline, divergence, apl-interpreter) that take --build.
export function flattenArchetypes(archetypes = SPEC_CONFIG.analysisArchetypes) {
  const flat = {};
  for (const [scenario, builds] of Object.entries(archetypes)) {
    if (typeof builds !== "object") continue;
    // Handle both flat (legacy) and grouped (scenario-keyed) structures
    if (builds.heroTree !== undefined) {
      flat[scenario] = builds; // legacy flat entry
    } else {
      for (const [name, config] of Object.entries(builds)) {
        flat[name] = { ...config, _scenario: scenario };
      }
    }
  }
  return flat;
}

// Convert a roster DB row into a state-sim-compatible buildConfig.
// Decodes the talent hash to derive talent flags, avoiding hardcoded duplication.
export function rosterBuildToConfig(dbRow) {
  const { hash, hero_tree, archetype } = dbRow;
  const { specTalents, heroTalents } = decodeAllTalents(hash);

  const talents = {};
  for (const name of [...specTalents, ...heroTalents]) {
    const key = name.toLowerCase().replace(/['']/g, "").replace(/\s+/g, "_");
    talents[key] = true;
  }

  const apexMatch = archetype?.match(/Apex\s+(\d+)/i);
  const apexRank = apexMatch ? parseInt(apexMatch[1], 10) : 0;

  return {
    heroTree: hero_tree,
    apexRank,
    haste: 0.2,
    talents,
    _rosterHash: hash,
    _name: dbRow.name || `${hero_tree}-apex${apexRank}`,
  };
}

// Select representative builds covering distinct (heroTree × apexRank) axes.
// Returns one build per combo (first match wins), keeping the build count manageable.
function selectRepresentativeBuilds(configs) {
  const seen = new Set();
  const reps = [];
  for (const cfg of configs) {
    const key = `${cfg.heroTree}|${cfg.apexRank}`;
    if (!seen.has(key)) {
      seen.add(key);
      reps.push(cfg);
    }
  }
  return reps;
}

// Build scenario-grouped analysis configs from roster builds + scenarios config.
// Returns the same structure as analysisArchetypes for drop-in compatibility.
// Selects representative builds per (heroTree × apexRank) to keep analysis tractable.
export function buildAnalysisFromRoster(rosterBuilds) {
  const scenarios = SPEC_CONFIG.scenarios;
  if (!scenarios || rosterBuilds.length === 0) return null;

  const allConfigs = rosterBuilds.map((b) => rosterBuildToConfig(b));
  const reps = selectRepresentativeBuilds(allConfigs);
  const result = {};

  for (const [scenarioName, scenarioCfg] of Object.entries(scenarios)) {
    result[scenarioName] = {};
    for (const cfg of reps) {
      const suffix =
        scenarioCfg.target_count > 1 ? `-${scenarioCfg.target_count}t` : "";
      const key = `${cfg._name}${suffix}`;
      result[scenarioName][key] = {
        ...cfg,
        target_count: scenarioCfg.target_count,
      };
    }
  }

  return result;
}

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
  siblingHeroTrees: ["fel_scarred", "void_scarred"],
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
