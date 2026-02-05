// Vengeance Demon Hunter spec adapter.
// Combines base spell data, ability config, resource flow, and hero tree info.
// This is the single source of truth for all VDH-specific knowledge.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");

// --- Base spell IDs (granted by spec, not talents) ---

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

export const SET_BONUS_SPELL_IDS = new Set([
  1264808, // Vengeance 12.0 Class Set 2pc
  1264809, // Vengeance 12.0 Class Set 4pc
  1276488, // Explosion of the Soul (4pc proc) — 1.8x AP Fire AoE, 12yd radius
]);

// --- Spec configuration ---

export const SPEC_CONFIG = {
  specId: "vengeance",
  className: "demonhunter",
  role: "tank",

  resources: {
    primary: { name: "fury", cap: 120 },
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
};

// --- Loading functions ---

let _cachedAbilityData = null;

export function getSpecConfig() {
  return SPEC_CONFIG;
}

export function loadAbilityData() {
  if (_cachedAbilityData) return _cachedAbilityData;

  const spellsPath = join(DATA_DIR, "spells-summary.json");

  if (!existsSync(spellsPath)) {
    _cachedAbilityData = Object.freeze({ ...SPEC_CONFIG.domainOverrides });
    return _cachedAbilityData;
  }

  const spells = JSON.parse(readFileSync(spellsPath, "utf-8"));
  const byId = new Map(spells.map((s) => [s.id, s]));

  const result = {};

  for (const [name, spellId] of Object.entries(SPEC_CONFIG.spellIds)) {
    const spell = byId.get(spellId);
    if (!spell) {
      result[name] = { ...(SPEC_CONFIG.domainOverrides[name] || {}) };
      continue;
    }

    const entry = {};

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

    if (spell.resource) {
      const furyMatch = spell.resource.match(/(\d+)\s*fury/i);
      if (furyMatch) entry.furyCost = parseInt(furyMatch[1], 10);
    }

    if (spell.generates) {
      for (const gen of spell.generates) {
        const furyMatch = gen.match(/(\d+)\s*fury/i);
        if (furyMatch) entry.furyGen = parseInt(furyMatch[1], 10);
        const fragMatch = gen.match(/(\d+)\s*soul\s*fragment/i);
        if (fragMatch) entry.fragGen = parseInt(fragMatch[1], 10);
      }
    }

    Object.assign(entry, SPEC_CONFIG.domainOverrides[name] || {});
    result[name] = entry;
  }

  _cachedAbilityData = Object.freeze(result);
  return _cachedAbilityData;
}

export function getHeroTrees() {
  return SPEC_CONFIG.heroTrees;
}

export function getResourceFlow() {
  return SPEC_CONFIG.resourceFlow;
}

export function detectHeroTreeFromProfileName(aplText) {
  for (const [treeId, treeConfig] of Object.entries(SPEC_CONFIG.heroTrees)) {
    for (const keyword of treeConfig.profileKeywords) {
      if (aplText.toLowerCase().includes(keyword)) {
        return treeId;
      }
    }
  }
  return null;
}

export function detectHeroTreeFromBuffs(workflowResults) {
  const scenarios = Array.isArray(workflowResults)
    ? workflowResults
    : workflowResults.scenarios || [];

  for (const scenario of scenarios) {
    if (scenario.error) continue;

    for (const [treeId, treeConfig] of Object.entries(SPEC_CONFIG.heroTrees)) {
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

export function getSpellIds() {
  return SPEC_CONFIG.spellIds;
}

export function getDomainOverrides() {
  return SPEC_CONFIG.domainOverrides;
}

export function clearCache() {
  _cachedAbilityData = null;
}
