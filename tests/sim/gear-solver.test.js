import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { solveGearSet } from "../../src/sim/gear-solver.js";

describe("solveGearSet", () => {
  it("returns ranked configurations from minimal input", () => {
    const result = solveGearSet({
      tierConfig: {
        setId: 1979,
        requiredCount: 4,
        slots: {
          head: { simc: "head=tier_head,id=1,ilevel=289" },
          shoulder: { simc: "shoulder=tier_shoulder,id=2,ilevel=289" },
          chest: { simc: "chest=tier_chest,id=3,ilevel=289" },
          hands: { simc: "hands=tier_hands,id=4,ilevel=289" },
          legs: { simc: "legs=tier_legs,id=5,ilevel=289" },
        },
        alternatives: {
          head: [
            {
              id: "alt_head",
              simc: "head=alt_head,id=10,ilevel=289",
              stats: { agi: 100, crit: 50 },
            },
          ],
          shoulder: [],
          chest: [
            {
              id: "alt_chest",
              simc: "chest=alt_chest,id=11,ilevel=289",
              stats: { agi: 100, haste: 50 },
            },
          ],
          hands: [],
          legs: [],
        },
      },
      embellishmentResults: [
        {
          candidateId: "hunt_hunt",
          weightedDps: 130000,
          slots: ["waist", "wrists"],
          crafted: true,
          embCount: 2,
        },
      ],
      effectItemResults: {
        main_hand: [
          {
            candidateId: "lightless_lament",
            weightedDps: 75000,
            simc: "main_hand=lightless_lament,id=260408,ilevel=289",
          },
        ],
        off_hand: [
          {
            candidateId: "singularity_slicer",
            weightedDps: 74000,
            simc: "off_hand=singularity_slicer,id=260409,ilevel=289",
          },
        ],
      },
      miniSetResults: [],
      statStickCandidates: {
        neck: [
          { id: "neck1", simc: "neck=neck1,id=20,ilevel=289", epScore: 500 },
        ],
        back: [
          { id: "back1", simc: "back=back1,id=21,ilevel=289", epScore: 480 },
        ],
        feet: [
          { id: "feet1", simc: "feet=feet1,id=22,ilevel=289", epScore: 460 },
        ],
        finger1: [
          { id: "ring1", simc: "finger1=ring1,id=23,ilevel=289", epScore: 520 },
        ],
        finger2: [
          { id: "ring2", simc: "finger2=ring2,id=24,ilevel=289", epScore: 510 },
        ],
      },
      scaleFactors: { Agi: 40, Haste: 22, Crit: 21, Mastery: 17, Vers: 19 },
      maxCrafted: 2,
      maxEmbellishments: 2,
    });

    assert.ok(Array.isArray(result.configurations));
    assert.ok(result.configurations.length > 0);
    assert.ok(result.configurations.length <= 10);

    const best = result.configurations[0];
    assert.ok(best.score > 0);
    assert.ok(best.slots);
    assert.equal(Object.keys(best.slots).length, 16);

    // Verify constraints
    const tierSlots = ["head", "shoulder", "chest", "hands", "legs"];
    const tierCount = tierSlots.filter((s) => best.slots[s]?.isTier).length;
    assert.equal(tierCount, 4, "Must have exactly 4 tier pieces");

    const craftedCount = Object.values(best.slots).filter(
      (s) => s.isCrafted,
    ).length;
    assert.ok(craftedCount <= 2, "Must have at most 2 crafted items");

    const embCount = Object.values(best.slots).filter(
      (s) => s.embellishment,
    ).length;
    assert.equal(embCount, 2, "Must have exactly 2 embellishments");
  });
});
