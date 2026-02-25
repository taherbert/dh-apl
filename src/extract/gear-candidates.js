// Fetches current-expansion items, enchants, and embellishments from Raidbots
// and refreshes data/{spec}/gear-candidates.json.
//
// Auto-generates: paired_slots (trinkets, rings), slots (non-crafted gear), enchants.
// Preserves: baseline, ilvl_tiers, tier, embellishments, stat_allocations, flagged,
//            crafted items in slot candidates (detected by bonus_id in simc string),
//            crafted/manually-added paired candidates (trinkets, rings).
//
// Usage: SPEC=vengeance node src/extract/gear-candidates.js

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { config, DATA_ENV, initSpec } from "../engine/startup.js";
import { dataFile } from "../engine/paths.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";

// --- Constants ---

const DH_CLASS_ID = 12;

// WoW inventory type → SimC slot name
const INV_TYPE_SLOT = {
  1: "head",
  2: "neck",
  3: "shoulder",
  5: "chest",
  6: "waist",
  7: "legs",
  8: "feet",
  9: "wrists",
  10: "hands",
  11: "finger",
  12: "trinket",
  13: "weapon", // one-hand — eligible for main_hand or off_hand
  16: "back",
  21: "main_hand",
  22: "off_hand",
};

// DH weapon subclasses
const DH_WEAPON_SUBTYPES = new Set([
  0, // One-handed axes
  4, // Fist weapons
  7, // One-handed swords
  13, // Warglaives
]);

// Inventory types that produce weapon candidates
const WEAPON_INV_TYPES = new Set([13, 21, 22]);

// Slots that auto-generate goes into (excludes tier slots and paired slots).
// Value is the SimC slot name used in item strings (differs from key for wrists).
const INDIVIDUAL_SLOTS = {
  neck: "neck",
  back: "back",
  wrists: "wrist",
  waist: "waist",
  feet: "feet",
  main_hand: "main_hand",
  off_hand: "off_hand",
};

// Tier-piece slots — always managed manually via the tier config
const TIER_SLOTS = new Set(["head", "shoulder", "chest", "hands", "legs"]);

// Enchant category name → our enchant section key
const ENCHANT_CATEGORY_MAP = {
  "Weapon Enchantments": "weapon",
  "Ring Enchantments": "ring",
  "Cloak Enchantments": "cloak",
  "Wrist Enchantments": "wrist",
  "Foot Enchantments": "foot",
};

// Stat IDs → normalized stat key (for item stat extraction)
const STAT_ID_MAP = {
  3: "agi",
  71: "agi",
  72: "agi",
  73: "agi",
  32: "crit",
  35: "haste",
  36: "mastery",
  40: "vers",
  7: "stamina",
};

// Enchant stat type name → normalized key (for enchant/gem stat extraction)
const ENCHANT_STAT_NAME_MAP = {
  agi: "agi",
  agility: "agi",
  haste: "haste",
  "haste rating": "haste",
  crit: "crit",
  "crit strike": "crit",
  "critical strike": "crit",
  mastery: "mastery",
  versatility: "vers",
  vers: "vers",
};

// Stat IDs that carry Agility (for trinket filtering and tagging)
const AGILITY_STAT_IDS = new Set([3, 71, 72, 73]);
const PRIMARY_STAT_IDS = new Set([3, 4, 5, 71, 72, 73, 74]);

// Stat types that affect DPS (for enchant filtering)
const DPS_STAT_TYPES = new Set([
  "agi",
  "agility",
  "mastery",
  "haste",
  "crit",
  "versatility",
  "vers",
  "damage",
]);

// Crafted item marker — these are preserved across refreshes
const CRAFTED_SIMC_RE = /bonus_id=/;

// Return an object containing only the specified keys that exist on `obj`.
function pick(obj, ...keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] != null) out[k] = obj[k];
  }
  return out;
}

// --- Stat extraction ---

function extractStats(item) {
  const out = {};
  for (const { id, value } of item.stats || []) {
    const key = STAT_ID_MAP[id];
    if (key) out[key] = (out[key] || 0) + value;
  }
  return Object.keys(out).length ? out : null;
}

function extractEnchantStats(enchant) {
  const out = {};
  for (const { type, value } of enchant.stats || []) {
    const key = ENCHANT_STAT_NAME_MAP[type.toLowerCase()];
    if (key) out[key] = (out[key] || 0) + value;
  }
  return Object.keys(out).length ? out : null;
}

// --- Utilities ---

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Convert a display name to a SimC-compatible identifier.
// Matches SimC's internal naming: lowercase, apostrophes dropped,
// hyphens → underscores, remaining non-alphanumeric-space dropped, spaces → underscores.
function toSimcName(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/-/g, "_")
    .replace(/[^a-z0-9\s_]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

function buildGemString(item, defaultGemId) {
  if (!defaultGemId || !item.hasSockets || !item.socketInfo?.sockets?.length)
    return "";
  return Array(item.socketInfo.sockets.length).fill(defaultGemId).join("/");
}

// Build a SimC item string. Without a slot prefix, produces a paired-slot simc_base.
function buildSimcString(slot, item, ilvl, defaultGemId) {
  const name = toSimcName(item.name);
  const gems = buildGemString(item, defaultGemId);
  const gemSuffix = gems ? `,gem_id=${gems}` : "";
  const prefix = slot ? `${slot}=` : "";
  return `${prefix}${name},id=${item.id},ilevel=${ilvl}${gemSuffix}`;
}

// Detect the current expansion from item data (highest expansion number seen).
function detectExpansion(items) {
  let max = 0;
  for (const item of items) {
    if (item.expansion != null && item.expansion > max) max = item.expansion;
  }
  if (max === 0)
    throw new Error(
      "Could not detect expansion — no items with expansion field found",
    );
  return max;
}

// --- Item filtering ---

function isDHUsable(item) {
  if (item.allowableClasses && !item.allowableClasses.includes(DH_CLASS_ID)) {
    return false;
  }

  const { itemClass, itemSubClass, inventoryType } = item;

  if (itemClass === 4) {
    // Armor
    if (itemSubClass === 2) return true; // Leather
    if (itemSubClass === 0) {
      // Accessories (neck, finger, trinket, back)
      if (inventoryType === 2 || inventoryType === 11 || inventoryType === 16)
        return true;
      if (inventoryType === 12) return isTrinketForDH(item);
    }
  } else if (itemClass === 2) {
    // Weapon
    return (
      DH_WEAPON_SUBTYPES.has(itemSubClass) &&
      WEAPON_INV_TYPES.has(inventoryType)
    );
  }

  return false;
}

function isTrinketForDH(item) {
  if (!item.stats) return true;
  const hasAgi = item.stats.some((s) => AGILITY_STAT_IDS.has(s.id));
  const hasPrimary = item.stats.some((s) => PRIMARY_STAT_IDS.has(s.id));
  return hasAgi || !hasPrimary;
}

function hasAgilityStats(item) {
  if (!item.stats) return false;
  return item.stats.some((s) => AGILITY_STAT_IDS.has(s.id));
}

const PVP_PREFIXES = ["Gladiator", "Combatant", "Aspirant", "Veteran"];

function isPvp(item) {
  return (
    PVP_PREFIXES.some((p) => item.name.startsWith(p)) ||
    /\bS\d+\b/.test(item.name) ||
    !!item.pvp
  );
}

function isCrafted(item) {
  return !!(item.profession || item.craftingQuality != null);
}

// --- Enchant filtering ---

function isDHUsableEnchant(enchant) {
  if (enchant.categoryName === "Runes") return false;

  // Exclude intellect-only enchants (no agi/str component)
  if (enchant.stats) {
    const types = new Set(enchant.stats.map((s) => s.type.toLowerCase()));
    if (
      (types.has("int") || types.has("intellect")) &&
      !types.has("agi") &&
      !types.has("agility") &&
      !types.has("str") &&
      !types.has("strength")
    ) {
      return false;
    }
  }

  // Must affect DPS via stats or display name
  const hasDpsStat = enchant.stats?.some((s) =>
    DPS_STAT_TYPES.has(s.type.toLowerCase()),
  );
  const hasDpsKeyword = [
    "agility",
    "mastery",
    "haste",
    "crit",
    "versatility",
    "damage",
  ].some((k) => enchant.displayName.toLowerCase().includes(k));

  if (!hasDpsStat && !hasDpsKeyword) return false;

  // Weapon enchants: must support a DH weapon subtype
  if (enchant.equipRequirements?.itemClass === 2) {
    // Bitmask check for warglaives(8192), swords(64), axes(1), fist(256)
    const dhMask = 8192 | 64 | 1 | 256;
    return !!(enchant.equipRequirements.itemSubClassMask & dhMask);
  }

  return true;
}

// Keep only highest craftingQuality per base enchant name
function deduplicateEnchants(enchants) {
  const best = new Map();
  for (const e of enchants) {
    const key = e.baseDisplayName || e.displayName;
    const existing = best.get(key);
    if (
      !existing ||
      (e.craftingQuality ?? 0) > (existing.craftingQuality ?? 0)
    ) {
      best.set(key, e);
    }
  }
  return [...best.values()];
}

// Merge auto-generated candidates with existing entries.
// For items found in the new fetch: preserve existing tags (manual overrides like "proc").
// For crafted items not in the new fetch: preserve entirely.
function mergePreservingCrafted(
  newItems,
  existingCandidates,
  simcField = "simc",
) {
  const existingById = new Map(
    (existingCandidates || []).map((c) => [c.id, c]),
  );

  const merged = newItems.map((item) => {
    const existing = existingById.get(item.id);
    if (!existing) return item;
    // Merge tags: keep manually-set tags from existing run
    const mergedTags = [
      ...new Set([...(item.tags || []), ...(existing.tags || [])]),
    ];
    return { ...item, tags: mergedTags };
  });

  const allIds = new Set(newItems.map((c) => c.id));
  const preserved = (existingCandidates || []).filter(
    (c) => CRAFTED_SIMC_RE.test(c[simcField] || "") && !allIds.has(c.id),
  );
  return [...merged, ...preserved];
}

// --- Main ---

async function main() {
  const specName = parseSpecArg();
  await initSpec(specName);

  const base = `${config.data.raidbots}/${DATA_ENV}`;

  console.log(`Fetching Raidbots data (${DATA_ENV})...`);
  const [items, enchants] = await Promise.all([
    fetchJson(`${base}/equippable-items.json`),
    fetchJson(`${base}/enchantments.json`),
  ]);

  // Load current file to preserve manual fields
  const candidatesPath = dataFile("gear-candidates.json");
  const current = existsSync(candidatesPath)
    ? JSON.parse(readFileSync(candidatesPath, "utf-8"))
    : { version: 2 };

  const expansion = detectExpansion(items);
  const ilvlTiers = current.ilvl_tiers || [];
  const maxIlvl =
    ilvlTiers.length > 0 ? Math.max(...ilvlTiers.map((t) => t.ilvl)) : 289;
  const defaultGemId = current._defaultGem || 0;

  console.log(
    `Detected expansion ${expansion}, target ilvl ${maxIlvl}${defaultGemId ? `, default gem ${defaultGemId}` : ", no default gem (set _defaultGem in gear-candidates.json)"}`,
  );

  // Filter: current expansion, epic+ quality, DH-usable, non-PvP, non-crafted
  const eligible = items.filter(
    (item) =>
      item.expansion === expansion &&
      item.quality >= 3 &&
      item.itemClass != null &&
      isDHUsable(item) &&
      !isPvp(item) &&
      !isCrafted(item),
  );

  console.log(`${eligible.length} eligible items from ${items.length} total`);

  // Group by slot
  const bySlot = new Map();
  for (const item of eligible) {
    const rawSlot = INV_TYPE_SLOT[item.inventoryType];
    if (!rawSlot || TIER_SLOTS.has(rawSlot)) continue;

    const slotsToAdd =
      rawSlot === "weapon" ? ["main_hand", "off_hand"] : [rawSlot];

    for (const slot of slotsToAdd) {
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(item);
    }
  }

  // --- paired_slots: trinkets and rings ---
  const trinketItems = bySlot.get("trinket") || [];
  const newTrinkets = trinketItems.map((item) => {
    const isAgi = hasAgilityStats(item);
    const stats = extractStats(item);
    return {
      id: toSimcName(item.name),
      label: item.name,
      simc_base: buildSimcString(null, item, maxIlvl, defaultGemId),
      ...(stats ? { stats } : {}),
      tags: [
        item.onUseTrinket ? "on-use" : "passive",
        ...(isAgi ? ["agi"] : []),
      ],
      ...(item.uniqueEquipped ? { uniqueEquipped: true } : {}),
    };
  });
  const trinkets = mergePreservingCrafted(
    newTrinkets,
    current.paired_slots?.trinkets?.candidates,
    "simc_base",
  );

  const ringItems = bySlot.get("finger") || [];
  const newRings = ringItems.map((item) => {
    const stats = extractStats(item);
    return {
      id: toSimcName(item.name),
      label: item.name,
      simc_base: buildSimcString(null, item, maxIlvl, defaultGemId),
      ...(stats ? { stats } : {}),
      tags: [],
    };
  });
  const rings = mergePreservingCrafted(
    newRings,
    current.paired_slots?.rings?.candidates,
    "simc_base",
  );

  // --- individual slots ---
  const slots = {};
  for (const [slot, simcSlot] of Object.entries(INDIVIDUAL_SLOTS)) {
    const isOffHand = slot === "off_hand";
    const newItems = (bySlot.get(slot) || []).map((item) => {
      const stats = extractStats(item);
      return {
        id: isOffHand ? `${toSimcName(item.name)}_oh` : toSimcName(item.name),
        label: isOffHand ? `${item.name} (OH)` : item.name,
        simc: buildSimcString(simcSlot, item, maxIlvl, defaultGemId),
        ...(stats ? { stats } : {}),
        tags: [],
      };
    });

    const all = mergePreservingCrafted(
      newItems,
      current.slots?.[slot]?.candidates,
    );
    if (all.length > 0) slots[slot] = { candidates: all };
  }

  // --- enchants ---
  // Filter for DH-usable, current expansion, best quality
  const dhEnchants = deduplicateEnchants(
    enchants.filter(
      (e) =>
        e.expansion === expansion &&
        isDHUsableEnchant(e) &&
        (e.craftingQuality == null || e.craftingQuality === 3) &&
        ENCHANT_CATEGORY_MAP[e.categoryName],
    ),
  );

  console.log(`${dhEnchants.length} DH-usable enchants`);

  function toEnchantCandidate(e, includeStats = false) {
    const stats = includeStats ? extractEnchantStats(e) : null;
    return {
      id: toSimcName(e.baseDisplayName || e.displayName),
      label: e.displayName,
      enchant_id: e.id,
      ...(stats ? { stats } : {}),
      tags: [],
    };
  }

  // Group enchants by category and build output sections.
  // Stat-only slots (cloak, wrist, foot) include stats for EP ranking.
  const ENCHANT_SECTIONS = [
    {
      category: "weapon",
      keys: ["weapon_mh", "weapon_oh"],
      baseSlots: ["main_hand", "off_hand"],
      includeStats: false,
    },
    {
      category: "ring",
      keys: ["ring"],
      baseSlots: ["finger1"],
      includeStats: false,
    },
    {
      category: "cloak",
      keys: ["cloak"],
      baseSlots: ["back"],
      includeStats: true,
    },
    {
      category: "wrist",
      keys: ["wrist"],
      baseSlots: ["wrist"],
      includeStats: true,
    },
    {
      category: "foot",
      keys: ["foot"],
      baseSlots: ["feet"],
      includeStats: true,
    },
  ];

  const enchantSection = {};
  for (const { category, keys, baseSlots, includeStats } of ENCHANT_SECTIONS) {
    const filtered = dhEnchants.filter(
      (e) => ENCHANT_CATEGORY_MAP[e.categoryName] === category,
    );
    if (filtered.length === 0) continue;

    const candidates = filtered.map((e) => toEnchantCandidate(e, includeStats));
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const defaultBase = `${baseSlots[i] || baseSlots[0]}=,id=0,ilevel=${maxIlvl}`;
      enchantSection[key] = {
        base_item: current.enchants?.[key]?.base_item || defaultBase,
        candidates,
      };
    }
  }

  // --- gems: socket enchants from enchantments.json ---
  const newGems = deduplicateEnchants(
    enchants.filter(
      (e) =>
        e.expansion === expansion &&
        e.slot === "socket" &&
        (e.craftingQuality == null || e.craftingQuality === 3),
    ),
  ).map((e) => toEnchantCandidate(e, true));
  // Preserve existing gems if none fetched (data may not expose socket enchants)
  const gems = newGems.length > 0 ? newGems : current.gems || [];

  // --- Write output ---
  const output = {
    version: 2,
    baseline: current.baseline || `apls/${specName}/profile.simc`,
    ilvl_tiers: current.ilvl_tiers || [],
    // tier config is always manually maintained — preserve as-is
    ...(current.tier ? { tier: current.tier } : {}),
    paired_slots: {
      trinkets: {
        slots: ["trinket1", "trinket2"],
        topK: current.paired_slots?.trinkets?.topK ?? 5,
        candidates: trinkets,
      },
      rings: {
        slots: ["finger1", "finger2"],
        topK: current.paired_slots?.rings?.topK ?? 5,
        candidates: rings,
      },
    },
    slots,
    enchants: enchantSection,
    ...(gems.length ? { gems } : {}),
    // Preserved fields: manually-maintained sections carried forward as-is
    ...pick(
      current,
      "embellishments",
      "stat_allocations",
      "flagged",
      "_defaultGem",
    ),
  };

  writeFileSync(candidatesPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${candidatesPath}`);
  console.log(`  Trinkets: ${trinkets.length}`);
  console.log(`  Rings: ${rings.length}`);
  for (const [slot, data] of Object.entries(slots)) {
    console.log(`  ${slot}: ${data.candidates.length} candidates`);
  }
  console.log(`  Enchants: ${Object.keys(enchantSection).join(", ")}`);
  if (gems.length) console.log(`  Gems: ${gems.length}`);
  console.log(
    `\nNote: tier, embellishments.pairs, stat_allocations, and flagged are preserved from existing file.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
