// Constraint-based gear set solver.
// Enumerates valid full gear sets from component sim results + EP scores.
// Pure function, no I/O.

const ALL_SLOTS = [
  "head",
  "neck",
  "shoulder",
  "back",
  "chest",
  "wrists",
  "hands",
  "waist",
  "legs",
  "feet",
  "finger1",
  "finger2",
  "trinket1",
  "trinket2",
  "main_hand",
  "off_hand",
];

export function solveGearSet(input) {
  const {
    tierConfig,
    embellishmentResults,
    effectItemResults = {},
    miniSetResults = [],
    statStickCandidates = {},
    maxCrafted = 2,
    maxEmbellishments = 2,
  } = input;

  // Convert mini-set pairs into embellishment-format entries so they
  // participate in the same tier-skip x emb enumeration
  const allEmbOptions = [...embellishmentResults];
  const extendedEffectItems = shallowCopySlotArrays(effectItemResults);

  for (const miniSet of miniSetResults) {
    for (const pair of miniSet.pairs) {
      const item1Emb = pair.item1.isBuiltInEmb ? 1 : 0;
      const item2Emb = pair.item2.isBuiltInEmb ? 1 : 0;
      const item1Crafted = pair.item1.isCrafted ? 1 : 0;
      const item2Crafted = pair.item2.isCrafted ? 1 : 0;

      allEmbOptions.push({
        candidateId: `miniset_${miniSet.setId}_${pair.slot1}_${pair.slot2}`,
        weightedDps: pair.pairDpsBonus || 0,
        slots: [pair.slot1, pair.slot2],
        crafted: item1Crafted + item2Crafted > 0,
        embCount: item1Emb + item2Emb,
        slotSimc: {
          [pair.slot1]: pair.item1.simc,
          [pair.slot2]: pair.item2.simc,
        },
        slotIds: {
          [pair.slot1]: pair.item1.id,
          [pair.slot2]: pair.item2.id,
        },
        isMiniSetPair: true,
        miniSetId: miniSet.setId,
      });
    }

    // Add individual mini-set pieces to effect item pool
    const piecesToSort = new Set();
    for (const piece of miniSet.individuals || []) {
      if (!extendedEffectItems[piece.slot]) {
        extendedEffectItems[piece.slot] = [];
      }
      extendedEffectItems[piece.slot].push({
        candidateId: piece.id,
        weightedDps: piece.weightedDps,
        simc: piece.simc,
        isCrafted: piece.isCrafted,
        isBuiltInEmb: piece.isBuiltInEmb,
      });
      piecesToSort.add(piece.slot);
    }
    for (const slot of piecesToSort) {
      extendedEffectItems[slot].sort((a, b) => b.weightedDps - a.weightedDps);
    }
  }

  const configs = [];
  const tierSlotNames = Object.keys(tierConfig.slots);
  const tierCount = tierSlotNames.length - 1;

  // Tier count is structurally fixed at tierSlotNames.length - 1 for all skip options.
  // If that doesn't match requiredCount, no valid configs are possible.
  if (tierCount !== tierConfig.requiredCount) {
    return { configurations: [] };
  }

  for (let skipIdx = 0; skipIdx < tierSlotNames.length; skipIdx++) {
    const skipSlot = tierSlotNames[skipIdx];
    const alternatives = tierConfig.alternatives[skipSlot] || [];

    // Build tier assignment: 4 tier pieces
    const tierAssignment = {};
    for (const slot of tierSlotNames) {
      if (slot === skipSlot) continue;
      tierAssignment[slot] = {
        id: `tier_${slot}`,
        simc: tierConfig.slots[slot].simc,
        isTier: true,
        isCrafted: false,
        embellishment: null,
      };
    }

    for (const emb of allEmbOptions) {
      const embSlots = emb.slots || [];

      if (embSlots.some((s) => tierAssignment[s])) continue;

      const craftedFromEmb = emb.crafted ? embSlots.length : 0;
      const embFromEmb = emb.embCount || 0;
      if (craftedFromEmb > maxCrafted) continue;
      if (embFromEmb > maxEmbellishments) continue;

      const slotMap = { ...tierAssignment };
      let craftedCount = craftedFromEmb;
      let embCount = embFromEmb;

      for (const slot of embSlots) {
        slotMap[slot] = {
          id: emb.slotIds?.[slot] || emb.candidateId,
          simc: emb.slotSimc?.[slot] || "",
          isTier: false,
          isCrafted: true,
          embellishment: true,
        };
      }

      // Fill the skipped tier slot with best alternative (unless emb already covers it)
      if (!slotMap[skipSlot]) {
        if (alternatives.length === 0) continue;
        const bestAlt = alternatives[0];
        const altIsCrafted = isCraftedLine(bestAlt.simc);
        if (altIsCrafted && craftedCount >= maxCrafted) continue;
        slotMap[skipSlot] = {
          id: bestAlt.id,
          simc: bestAlt.simc,
          isTier: false,
          isCrafted: altIsCrafted,
          embellishment: null,
        };
        if (altIsCrafted) craftedCount++;
      }

      // Track used item IDs for dedup (rings) and unique-equip groups
      const usedItemIds = new Set();
      const usedUniqueGroups = new Set();

      // Fill effect item slots (includes individual mini-set pieces)
      for (const [slot, candidates] of Object.entries(extendedEffectItems)) {
        if (slotMap[slot]) continue;
        if (candidates.length === 0) continue;
        const best = pickBestCandidate(
          candidates,
          usedItemIds,
          usedUniqueGroups,
        );
        if (!best) continue;
        const itemId = best.itemId;
        slotMap[slot] = {
          id: best.candidateId,
          simc: best.simc,
          isTier: false,
          isCrafted: false,
          embellishment: null,
          simDps: best.weightedDps,
          uniqueEquipped: best.uniqueEquipped || null,
          itemId,
        };
        if (itemId) usedItemIds.add(itemId);
        if (best.uniqueEquipped) usedUniqueGroups.add(best.uniqueEquipped);
      }

      // Fill stat-stick slots (with ring dedup via itemId ?? id)
      for (const [slot, candidates] of Object.entries(statStickCandidates)) {
        if (slotMap[slot]) continue;
        if (candidates.length === 0) continue;
        const best = pickBestCandidate(
          candidates,
          usedItemIds,
          usedUniqueGroups,
        );
        if (!best) continue;
        const itemId = best.itemId ?? best.id;
        slotMap[slot] = {
          id: best.id,
          simc: best.simc,
          isTier: false,
          isCrafted: false,
          embellishment: null,
          epScore: best.epScore,
          itemId,
        };
        usedItemIds.add(itemId);
      }

      // Fill any remaining slots (trinkets, etc.) as placeholders
      for (const slot of ALL_SLOTS) {
        if (!slotMap[slot]) {
          slotMap[slot] = {
            id: "__placeholder__",
            simc: "",
            isTier: false,
            isCrafted: false,
            embellishment: null,
          };
        }
      }

      // Validate constraints not tracked incrementally
      if (craftedCount > maxCrafted) continue;
      if (embCount !== maxEmbellishments) continue;

      const score = scoreConfiguration(slotMap, emb);

      configs.push({
        slots: slotMap,
        score,
        embConfig: emb.candidateId,
        tierSkip: skipSlot,
      });
    }
  }

  configs.sort((a, b) => b.score - a.score);
  return { configurations: configs.slice(0, 10) };
}

function scoreConfiguration(slotMap, embResult) {
  let score = 0;
  score += embResult.weightedDps || 0;
  for (const slot of Object.values(slotMap)) {
    if (slot.simDps) score += slot.simDps;
    if (slot.epScore) score += slot.epScore;
  }
  return score;
}

function pickBestCandidate(candidates, usedItemIds, usedUniqueGroups) {
  for (const c of candidates) {
    const itemId = c.itemId ?? c.id;
    if (itemId && usedItemIds.has(itemId)) continue;
    if (c.uniqueEquipped && usedUniqueGroups.has(c.uniqueEquipped)) continue;
    return c;
  }
  return null;
}

function shallowCopySlotArrays(effectItemResults) {
  const copy = {};
  for (const [slot, candidates] of Object.entries(effectItemResults)) {
    copy[slot] = [...candidates];
  }
  return copy;
}

function isCraftedLine(simc) {
  if (!simc) return false;
  return simc.includes("crafted_stats") || simc.includes("bonus_id=8793");
}
