// Spec-specific ability configuration — loaded by theorycraft.js and strategic-hypotheses.js
// Abstracts hardcoded ability names so the system can work with other specs

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

// --- Spec Configurations ---
// Each spec defines its key abilities, resources, and domain-specific overrides

const SPEC_CONFIGS = {
  vengeance: {
    specId: "vengeance",
    className: "demonhunter",
    role: "tank",

    // Primary and secondary resources
    resources: {
      primary: { name: "fury", cap: 120 },
      secondary: { name: "soul_fragments", cap: 6 },
    },

    // Key spell IDs for analysis
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

    // Domain-specific values not derivable from spell data
    // These encode game mechanics verified via C++ analysis
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

    // Hero trees with their key buffs and mechanics
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

    // Resource flow analysis parameters
    resourceFlow: {
      // Fury generators
      furyGenerators: [
        { ability: "fracture", base: 25, meta: 40 },
        { ability: "immolation_aura", perTick: 3, duration: 6 },
        { ability: "felblade", amount: 15 },
      ],
      // Fury consumers
      furyConsumers: [
        { ability: "spirit_bomb", cost: 40 },
        { ability: "soul_cleave", cost: 35 },
        { ability: "fel_devastation", cost: 50 },
      ],
      // Fragment generators
      fragGenerators: [
        { ability: "fracture", base: 2, meta: 3 },
        { ability: "soul_carver", amount: 3 },
        { ability: "sigil_of_spite", amount: 3 },
        { ability: "fallout", procRate: 0.6, source: "immolation_aura" },
      ],
      // Fragment consumers
      fragConsumers: [
        { ability: "spirit_bomb", maxConsume: 5 },
        { ability: "soul_cleave", maxConsume: 2 },
      ],
    },

    // Buff windows that matter for damage alignment
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

    // Key synergies for hypothesis generation
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
  },

  // Add other specs here...
};

// --- Loading Functions ---

let _cachedConfig = null;
let _cachedAbilityData = null;

export function getSpecConfig(specId = "vengeance") {
  const config = SPEC_CONFIGS[specId];
  if (!config) {
    throw new Error(
      `Unknown spec: ${specId}. Available: ${Object.keys(SPEC_CONFIGS).join(", ")}`,
    );
  }
  return config;
}

export function loadAbilityData(specId = "vengeance") {
  if (_cachedAbilityData) return _cachedAbilityData;

  const config = getSpecConfig(specId);
  const spellsPath = join(DATA_DIR, "spells-summary.json");

  if (!existsSync(spellsPath)) {
    // Fall back to domain overrides only
    _cachedAbilityData = Object.freeze({ ...config.domainOverrides });
    return _cachedAbilityData;
  }

  const spells = JSON.parse(readFileSync(spellsPath, "utf-8"));
  const byId = new Map(spells.map((s) => [s.id, s]));

  const result = {};

  for (const [name, spellId] of Object.entries(config.spellIds)) {
    const spell = byId.get(spellId);
    if (!spell) {
      result[name] = { ...(config.domainOverrides[name] || {}) };
      continue;
    }

    const entry = {};

    // Cooldown handling
    if (spell.charges) {
      if (spell.charges.count > 1) {
        entry.charges = spell.charges.count;
        entry.rechargeCd = spell.charges.cooldown;
        entry.cooldown = 0;
      } else {
        entry.cooldown = spell.charges.cooldown;
      }
    } else if (spell.cooldown) {
      entry.cooldown = spell.cooldown;
    } else {
      entry.cooldown = 0;
    }

    if (spell.duration) entry.duration = spell.duration;
    if (spell.gcd !== undefined) entry.gcd = spell.gcd > 0;

    // Resource cost
    if (spell.resource) {
      const furyMatch = spell.resource.match(/(\d+)\s*fury/i);
      if (furyMatch) entry.furyCost = parseInt(furyMatch[1], 10);
    }

    // Resource generation
    if (spell.generates) {
      for (const gen of spell.generates) {
        const furyMatch = gen.match(/(\d+)\s*fury/i);
        if (furyMatch) entry.furyGen = parseInt(furyMatch[1], 10);
        const fragMatch = gen.match(/(\d+)\s*soul\s*fragment/i);
        if (fragMatch) entry.fragGen = parseInt(fragMatch[1], 10);
      }
    }

    // Merge domain overrides
    Object.assign(entry, config.domainOverrides[name] || {});

    result[name] = entry;
  }

  _cachedAbilityData = Object.freeze(result);
  return _cachedAbilityData;
}

export function getHeroTrees(specId = "vengeance") {
  const config = getSpecConfig(specId);
  return config.heroTrees;
}

export function getResourceFlow(specId = "vengeance") {
  const config = getSpecConfig(specId);
  return config.resourceFlow;
}

export function detectHeroTreeFromProfileName(aplText, specId = "vengeance") {
  const trees = getHeroTrees(specId);

  for (const [treeId, treeConfig] of Object.entries(trees)) {
    for (const keyword of treeConfig.profileKeywords) {
      if (aplText.toLowerCase().includes(keyword)) {
        return treeId;
      }
    }
  }
  return null;
}

export function detectHeroTreeFromBuffs(workflowResults, specId = "vengeance") {
  const trees = getHeroTrees(specId);
  const scenarios = Array.isArray(workflowResults)
    ? workflowResults
    : workflowResults.scenarios || [];

  for (const scenario of scenarios) {
    if (scenario.error) continue;

    for (const [treeId, treeConfig] of Object.entries(trees)) {
      const hasTreeBuff = treeConfig.keyBuffs.some((buff) => {
        const uptime =
          scenario.buffUptimes?.[buff] ??
          scenario.buffs?.find((b) => b.name === buff)?.uptime;
        return uptime !== undefined && uptime > 0;
      });

      if (hasTreeBuff) return treeId;
    }
  }

  return null;
}

// For backwards compatibility with existing code
export function getSpellIds(specId = "vengeance") {
  return getSpecConfig(specId).spellIds;
}

export function getDomainOverrides(specId = "vengeance") {
  return getSpecConfig(specId).domainOverrides;
}

// Clear cache (useful for testing)
export function clearCache() {
  _cachedConfig = null;
  _cachedAbilityData = null;
}
