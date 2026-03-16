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

    // For each embellishment configuration
    for (const emb of embellishmentResults) {
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

      // Place embellishment items
      for (const slot of embSlots) {
        slotMap[slot] = {
          id: emb.candidateId,
          simc: emb.slotSimc?.[slot] || "",
          isTier: false,
          isCrafted: true,
          embellishment: true,
        };
      }

      // Fill the skipped tier slot with best alternative
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

      // Fill effect item slots
      for (const [slot, candidates] of Object.entries(effectItemResults)) {
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

function isCraftedLine(simc) {
  if (!simc) return false;
  return simc.includes("crafted_stats") || simc.includes("bonus_id=8793");
}
