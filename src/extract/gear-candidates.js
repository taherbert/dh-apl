// Fetches current-expansion items, enchants, and embellishments from Raidbots
// and refreshes data/{spec}/gear-candidates.json.
//
// Auto-generates: paired_slots (trinkets), slots (non-crafted gear incl. rings), enchants,
//                 gems, _defaultGem (highest agi gem detected automatically).
// Reads from gear-config.json: ilvl_tiers, tier, embellishments, flagged.
// Crafted items in slot candidates (bonus_id) are preserved across refreshes.
// stat_allocations and sets are NOT stored here — generated at runtime in gear.js.
//
// Per-item ilvl: uses equippable-items-full.json (has sources[]) + instances.json to
// determine each item's max obtainable ilvl. World boss items (instance flags=2) are
// capped at the Hero-track ilvl (second-highest tier); all other items use Myth-track max.
// Items with no sources array are excluded entirely — their ilvl cannot be verified.
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

// --- Stat extraction ---

function extractStats(item) {
  const out = {};
  for (const stat of item.stats || []) {
    const key = STAT_ID_MAP[stat.id];
    // Raidbots beta uses "alloc" instead of "value" for stat quantities
    const val = stat.value ?? stat.alloc ?? 0;
    if (key && val) out[key] = (out[key] || 0) + val;
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

function parseWowheadStats(tooltip) {
  const out = {};
  const patterns = [
    [/\+?([\d,]+)\s+Agility/, "agi"],
    [/\+?([\d,]+)\s+\[(?:Agility|Agi)\s+or\s+/, "agi"],
    [/\+?([\d,]+)\s+Critical Strike/, "crit"],
    [/\+?([\d,]+)\s+Haste/, "haste"],
    [/\+?([\d,]+)\s+Mastery/, "mastery"],
    [/\+?([\d,]+)\s+Versatility/, "vers"],
  ];
  for (const [re, key] of patterns) {
    const m = tooltip.match(re);
    if (m) out[key] = parseInt(m[1].replace(/,/g, ""), 10);
  }
  return Object.keys(out).length ? out : null;
}

async function fetchWowheadStats(itemId, ilvl) {
  const urls = [
    `https://nether.wowhead.com/tooltip/item/${itemId}?ilvl=${ilvl}`,
    `https://nether.wowhead.com/tooltip/item/${itemId}?dataEnv=2&ilvl=${ilvl}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.tooltip) continue;
      const stats = parseWowheadStats(data.tooltip);
      if (stats) return stats;
    } catch {
      // try next
    }
  }
  return null;
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

// PvP item name keywords — any item containing these words is PvP
const PVP_KEYWORDS = [
  "Gladiator",
  "Combatant",
  "Aspirant",
  "Veteran",
  "Galactic",
  "Novice",
];

function isPvp(item) {
  return (
    PVP_KEYWORDS.some((k) => item.name.includes(k)) ||
    /\bS\d+\b/.test(item.name) ||
    !!item.pvp
  );
}

function isDNT(item) {
  return (
    item.name.includes("[DNT]") ||
    item.name.startsWith("Test Item") ||
    item.name.startsWith("TEMPLATE") ||
    /^Item - \w/.test(item.name)
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
// For crafted items not in the new fetch (detected by bonus_id): preserve entirely.
// No manual tag preservation — proc tagging is replaced by ALWAYS_SIM_SLOTS in gear.js.
function mergePreservingCrafted(
  newItems,
  existingCandidates,
  simcField = "simc",
) {
  const allIds = new Set(newItems.map((c) => c.id));
  const preserved = (existingCandidates || []).filter(
    (c) => CRAFTED_SIMC_RE.test(c[simcField] || "") && !allIds.has(c.id),
  );
  return [...newItems, ...preserved];
}

// --- Main ---

async function main() {
  const specName = parseSpecArg();
  await initSpec(specName);

  const base = `${config.data.raidbots}/${DATA_ENV}`;

  console.log(`Fetching Raidbots data (${DATA_ENV})...`);
  const [items, enchants, instances] = await Promise.all([
    fetchJson(`${base}/equippable-items-full.json`),
    fetchJson(`${base}/enchantments.json`),
    fetchJson(`${base}/instances.json`),
  ]);

  // Load spec config (manually maintained: ilvl_tiers, tier, embellishments, flagged)
  const configPath = dataFile("gear-config.json");
  const gearConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf-8"))
    : {};

  // Load current candidates file only to preserve crafted items across refreshes
  const candidatesPath = dataFile("gear-candidates.json");
  const current = existsSync(candidatesPath)
    ? JSON.parse(readFileSync(candidatesPath, "utf-8"))
    : { version: 2 };

  const expansion = detectExpansion(items);
  const sortedTiers = [...(gearConfig.ilvl_tiers || [])].sort(
    (a, b) => a.ilvl - b.ilvl,
  );
  const maxIlvl = sortedTiers.length > 0 ? sortedTiers.at(-1).ilvl : 289;
  // World boss items are not upgradeable — cap at the second-highest tier (Hero track).
  const worldBossIlvl =
    sortedTiers.length >= 2 ? sortedTiers.at(-2).ilvl : maxIlvl;
  // Use current _defaultGem as placeholder for simc string generation; recomputed after gem fetch.
  const placeholderGemId = current._defaultGem || 0;

  // Build world boss instance ID set from instances.json.
  // World bosses are raid-type instances with flags=2; items from only these sources
  // cannot be upgraded beyond Hero track and are capped at worldBossIlvl.
  const worldBossInstanceIds = new Set(
    instances
      .filter((inst) => inst.type === "raid" && inst.flags === 2)
      .map((inst) => inst.id),
  );
  if (worldBossInstanceIds.size > 0) {
    console.log(
      `World boss instances: [${[...worldBossInstanceIds].join(", ")}] (max ilvl: ${worldBossIlvl})`,
    );
  }

  // Returns the max obtainable ilvl for an item based on its drop sources.
  // Items with sources exclusively from world boss instances are capped at worldBossIlvl.
  // All other items (raid, M+ dungeons, regular dungeons) can be fully upgraded → maxIlvl.
  function getItemMaxIlvl(item) {
    const sources = item.sources || [];
    if (sources.length === 0) return maxIlvl;
    const hasWorldBossSource = sources.some((s) =>
      worldBossInstanceIds.has(s.instanceId),
    );
    const hasNonWorldBossSource = sources.some(
      (s) => !worldBossInstanceIds.has(s.instanceId),
    );
    // Only cap if ALL sources are world boss (an item with both world boss and
    // dungeon sources can still reach maxIlvl via the non-world-boss drop).
    if (hasWorldBossSource && !hasNonWorldBossSource) return worldBossIlvl;
    return maxIlvl;
  }

  console.log(`Detected expansion ${expansion}, target ilvl ${maxIlvl}`);

  // Filter: current expansion, epic+ quality, DH-usable, non-PvP, non-crafted,
  // and must have at least one known drop source so we can verify its max ilvl.
  // Items with no sources array (e.g. delve rewards not yet mapped in beta data)
  // are excluded — simming them at an unverified ilvl produces misleading rankings.
  const eligible = items.filter(
    (item) =>
      item.expansion === expansion &&
      item.quality >= 3 &&
      item.itemClass != null &&
      item.sources?.length > 0 &&
      isDHUsable(item) &&
      !isPvp(item) &&
      !isCrafted(item) &&
      !isDNT(item),
  );

  const noSource = items.filter(
    (item) =>
      item.expansion === expansion &&
      item.quality >= 3 &&
      item.itemClass != null &&
      isDHUsable(item) &&
      !isPvp(item) &&
      !isCrafted(item) &&
      !isDNT(item) &&
      !(item.sources?.length > 0),
  );
  if (noSource.length > 0) {
    console.log(
      `Skipped ${noSource.length} items with no known drop source: ${noSource.map((i) => i.name).join(", ")}`,
    );
  }
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
    const ilvl = getItemMaxIlvl(item);
    return {
      id: toSimcName(item.name),
      label: item.name,
      simc_base: buildSimcString(null, item, ilvl, placeholderGemId),
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
  const newRings1 = ringItems.map((item) => {
    const stats = extractStats(item);
    const ilvl = getItemMaxIlvl(item);
    return {
      id: toSimcName(item.name),
      label: item.name,
      simc: buildSimcString("finger1", item, ilvl, placeholderGemId),
      ...(stats ? { stats } : {}),
      tags: [],
    };
  });
  const newRings2 = ringItems.map((item) => {
    const stats = extractStats(item);
    const ilvl = getItemMaxIlvl(item);
    return {
      id: toSimcName(item.name),
      label: item.name,
      simc: buildSimcString("finger2", item, ilvl, placeholderGemId),
      ...(stats ? { stats } : {}),
      tags: [],
    };
  });
  const rings1 = mergePreservingCrafted(
    newRings1,
    current.slots?.finger1?.candidates,
  );
  const rings2 = mergePreservingCrafted(
    newRings2,
    current.slots?.finger2?.candidates,
  );

  // --- individual slots ---
  const slots = {};
  for (const [slot, simcSlot] of Object.entries(INDIVIDUAL_SLOTS)) {
    const isOffHand = slot === "off_hand";
    const newItems = (bySlot.get(slot) || []).map((item) => {
      const stats = extractStats(item);
      const ilvl = getItemMaxIlvl(item);
      return {
        id: isOffHand ? `${toSimcName(item.name)}_oh` : toSimcName(item.name),
        label: isOffHand ? `${item.name} (OH)` : item.name,
        simc: buildSimcString(simcSlot, item, ilvl, placeholderGemId),
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

  // --- Wowhead stat backfill ---
  // Items with null stats from Raidbots beta data get stats from Wowhead.
  const needStats = [];
  const allCandidateSections = [
    ...trinkets.map((c) => ({ c, simc: c.simc_base })),
    ...rings1.map((c) => ({ c, simc: c.simc })),
    ...rings2.map((c) => ({ c, simc: c.simc })),
    ...Object.values(slots).flatMap((s) =>
      s.candidates.map((c) => ({ c, simc: c.simc })),
    ),
  ];
  for (const { c, simc } of allCandidateSections) {
    // Fetch from Wowhead only when Raidbots has no stat data at all (pure proc items)
    if (!c.stats) {
      const idMatch = (simc || "").match(/,id=(\d+)/);
      const ilvlMatch = (simc || "").match(/ilevel=(\d+)/);
      if (idMatch) {
        needStats.push({
          c,
          id: parseInt(idMatch[1], 10),
          ilvl: ilvlMatch ? parseInt(ilvlMatch[1], 10) : maxIlvl,
        });
      }
    }
  }
  if (needStats.length > 0) {
    console.log(`Fetching stats for ${needStats.length} items from Wowhead...`);
    let fetched = 0;
    for (const { c, id, ilvl } of needStats) {
      const stats = await fetchWowheadStats(id, ilvl);
      if (stats) {
        c.stats = stats;
        fetched++;
      }
      // Small delay to avoid hammering Wowhead
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`  Got stats for ${fetched}/${needStats.length} items`);
  }

  // Copy stats from rings1 -> rings2 (same items, different slot prefix)
  const ring1StatsById = new Map(rings1.map((c) => [c.id, c.stats]));
  for (const c of rings2) {
    if (!c.stats) {
      const stats = ring1StatsById.get(c.id);
      if (stats) c.stats = stats;
    }
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

  // Auto-detect _defaultGem: gem with the highest agi stat value
  const defaultGemId = (() => {
    let bestId = 0,
      bestAgi = 0;
    for (const gem of gems) {
      const agi = gem.stats?.agi || 0;
      if (agi > bestAgi) {
        bestAgi = agi;
        bestId = gem.enchant_id || 0;
      }
    }
    return bestId;
  })();

  if (defaultGemId) {
    console.log(`Auto-detected default gem: enchant_id=${defaultGemId}`);
  } else {
    console.log("No agi gem found — _defaultGem not set.");
  }

  // --- Write output ---
  // ilvl_tiers, tier, embellishments, flagged come from gear-config.json.
  // stat_allocations and sets are NOT stored here — generated at runtime in gear.js.
  const output = {
    version: 2,
    baseline: current.baseline || `apls/${specName}/profile.simc`,
    ilvl_tiers: sortedTiers,
    ...(gearConfig.tier ? { tier: gearConfig.tier } : {}),
    paired_slots: {
      trinkets: {
        slots: ["trinket1", "trinket2"],
        topK: current.paired_slots?.trinkets?.topK ?? 5,
        candidates: trinkets,
      },
    },
    slots: {
      ...slots,
      finger1: { candidates: rings1 },
      finger2: { candidates: rings2 },
    },
    enchants: enchantSection,
    ...(gems.length ? { gems } : {}),
    ...(defaultGemId ? { _defaultGem: defaultGemId } : {}),
    ...(gearConfig.embellishments
      ? { embellishments: gearConfig.embellishments }
      : {}),
    ...(gearConfig.flagged ? { flagged: gearConfig.flagged } : {}),
  };

  writeFileSync(candidatesPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${candidatesPath}`);
  console.log(`  Trinkets: ${trinkets.length}`);
  console.log(`  Finger1 (rings): ${rings1.length} candidates`);
  console.log(`  Finger2 (rings): ${rings2.length} candidates`);
  for (const [slot, data] of Object.entries(slots)) {
    console.log(`  ${slot}: ${data.candidates.length} candidates`);
  }
  console.log(`  Enchants: ${Object.keys(enchantSection).join(", ")}`);
  if (gems.length) console.log(`  Gems: ${gems.length}`);
  if (gearConfig.tier)
    console.log(
      `  Tier: set_id=${gearConfig.tier.set_id} (from gear-config.json)`,
    );
  if (gearConfig.embellishments?.pairs?.length)
    console.log(
      `  Embellishments: ${gearConfig.embellishments.pairs.length} pairs (from gear-config.json)`,
    );

  // Log ilvl distribution across all candidates to confirm world boss capping
  const ilvlCounts = new Map();
  const allNewCandidates = [
    ...newTrinkets.map((c) => c.simc_base),
    ...newRings1.map((c) => c.simc),
    ...Object.values(slots).flatMap((s) =>
      s.candidates
        .filter((c) => !CRAFTED_SIMC_RE.test(c.simc))
        .map((c) => c.simc),
    ),
  ];
  for (const simc of allNewCandidates) {
    const m = (simc || "").match(/ilevel=(\d+)/);
    if (m) {
      const ilvl = parseInt(m[1], 10);
      ilvlCounts.set(ilvl, (ilvlCounts.get(ilvl) || 0) + 1);
    }
  }
  const ilvlSummary = [...ilvlCounts]
    .sort((a, b) => a[0] - b[0])
    .map(([ilvl, count]) => `${ilvl}:${count}`)
    .join(", ");
  console.log(`  ilvl distribution: ${ilvlSummary || "none"}`);

  console.log(
    `\nNote: edit data/{spec}/gear-config.json for ilvl_tiers, tier, embellishments, and flagged.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
