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
    scaleFactors,
    maxCrafted = 2,
    maxEmbellishments = 2,
  } = input;

  // Convert mini-set pairs into embellishment-format entries so they
  // participate in the same tier-skip x emb enumeration
  const allEmbOptions = [...embellishmentResults];
  const extendedEffectItems = deepCopyEffectItems(effectItemResults);

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
      // Re-sort by DPS descending
      extendedEffectItems[piece.slot].sort(
        (a, b) => b.weightedDps - a.weightedDps,
      );
    }
  }

  const configs = [];
  const tierSlotNames = Object.keys(tierConfig.slots);

  // Enumerate tier skip options: for each tier slot that has alternatives,
  // skip it and use the best alternative
  for (let skipIdx = 0; skipIdx < tierSlotNames.length; skipIdx++) {
    const skipSlot = tierSlotNames[skipIdx];
    const alternatives = tierConfig.alternatives[skipSlot] || [];
    if (alternatives.length === 0) continue;

    // Build tier assignment: 4 tier pieces + 1 alternative
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

    // For each embellishment configuration (standard + mini-set pairs)
    for (const emb of allEmbOptions) {
      const embSlots = emb.slots || [];

      // Check if embellishment slots conflict with tier slots
      if (embSlots.some((s) => tierAssignment[s])) continue;

      // Check crafted + emb limits
      const craftedFromEmb = emb.crafted ? embSlots.length : 0;
      const embFromEmb = emb.embCount || 0;
      if (craftedFromEmb > maxCrafted) continue;
      if (embFromEmb > maxEmbellishments) continue;

      const slotMap = { ...tierAssignment };
      let craftedCount = craftedFromEmb;

      // Place embellishment items (mini-set pairs have per-slot IDs)
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

      // Fill effect item slots (includes individual mini-set pieces)
      for (const [slot, candidates] of Object.entries(extendedEffectItems)) {
        if (slotMap[slot]) continue;
        if (candidates.length === 0) continue;
        const best = candidates[0];
        slotMap[slot] = {
          id: best.candidateId,
          simc: best.simc,
          isTier: false,
          isCrafted: false,
          embellishment: null,
          simDps: best.weightedDps,
        };
      }

      // Fill stat-stick slots
      for (const [slot, candidates] of Object.entries(statStickCandidates)) {
        if (slotMap[slot]) continue;
        if (candidates.length === 0) continue;
        const best = candidates[0];
        slotMap[slot] = {
          id: best.id,
          simc: best.simc,
          isTier: false,
          isCrafted: false,
          embellishment: null,
          epScore: best.epScore,
        };
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

      // Validate hard constraints
      const totalCrafted = Object.values(slotMap).filter(
        (s) => s.isCrafted,
      ).length;
      const totalEmb = Object.values(slotMap).filter(
        (s) => s.embellishment,
      ).length;
      const totalTier = Object.values(slotMap).filter((s) => s.isTier).length;
      if (totalCrafted > maxCrafted) continue;
      if (totalEmb !== maxEmbellishments) continue;
      if (totalTier !== tierConfig.requiredCount) continue;

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

function deepCopyEffectItems(effectItemResults) {
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
