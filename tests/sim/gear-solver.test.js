import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { solveGearSet } from "../../src/sim/gear-solver.js";

function baseInput(overrides = {}) {
  return {
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
        {
          id: "ring1",
          simc: "finger1=ring1,id=23,ilevel=289",
          epScore: 520,
        },
      ],
      finger2: [
        {
          id: "ring2",
          simc: "finger2=ring2,id=24,ilevel=289",
          epScore: 510,
        },
      ],
    },
    scaleFactors: { Agi: 40, Haste: 22, Crit: 21, Mastery: 17, Vers: 19 },
    maxCrafted: 2,
    maxEmbellishments: 2,
    ...overrides,
  };
}

describe("solveGearSet", () => {
  it("returns ranked configurations from minimal input", () => {
    const result = solveGearSet(baseInput());

    assert.ok(Array.isArray(result.configurations));
    assert.ok(result.configurations.length > 0);
    assert.ok(result.configurations.length <= 10);

    const best = result.configurations[0];
    assert.ok(best.score > 0);
    assert.ok(best.slots);
    assert.equal(Object.keys(best.slots).length, 16);

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

  it("evaluates mini-set pairs as atomic options AND individual pieces", () => {
    const result = solveGearSet(
      baseInput({
        miniSetResults: [
          {
            setId: 1966,
            setName: "Murder Row Materials",
            pairs: [
              {
                slot1: "wrists",
                slot2: "chest",
                pairDpsBonus: 2500,
                item1: {
                  id: "row_walkers_deflectors",
                  simc: "wrists=row_walkers_deflectors,id=244612,bonus_id=8793/13454,ilevel=285",
                  isCrafted: true,
                  isBuiltInEmb: true,
                },
                item2: {
                  id: "row_walkers_insurance",
                  simc: "chest=row_walkers_insurance,id=244613,bonus_id=8793/13454,ilevel=285",
                  isCrafted: true,
                  isBuiltInEmb: true,
                },
              },
            ],
            individuals: [
              {
                id: "row_walkers_deflectors",
                slot: "wrists",
                weightedDps: 72000,
                simc: "wrists=row_walkers_deflectors,id=244612,bonus_id=8793/13454,ilevel=285",
                isCrafted: true,
                isBuiltInEmb: true,
              },
            ],
          },
        ],
      }),
    );

    // The solver should have evaluated configs with mini-set options
    const hasPairConfig = result.configurations.some(
      (c) =>
        c.slots.wrists?.id === "row_walkers_deflectors" &&
        c.slots.chest?.id === "row_walkers_insurance",
    );
    const hasStandardConfig = result.configurations.some(
      (c) => c.embConfig === "hunt_hunt",
    );
    // Both types should be present
    assert.ok(hasPairConfig, "Solver must evaluate mini-set pair configs");
    assert.ok(
      hasStandardConfig,
      "Solver must also produce standard emb configs",
    );

    // Verify pair configs still satisfy all constraints
    for (const config of result.configurations) {
      const tierCount = Object.values(config.slots).filter(
        (s) => s.isTier,
      ).length;
      assert.equal(tierCount, 4, "All configs must have 4 tier pieces");

      const embCount = Object.values(config.slots).filter(
        (s) => s.embellishment,
      ).length;
      assert.equal(embCount, 2, "All configs must have 2 embellishments");

      const craftedCount = Object.values(config.slots).filter(
        (s) => s.isCrafted,
      ).length;
      assert.ok(craftedCount <= 2, "All configs must have at most 2 crafted");
    }
  });

  it("prevents same ring in both finger slots", () => {
    const result = solveGearSet(
      baseInput({
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
          // Same ring ID in both finger slots — solver must not use it twice
          finger1: [
            {
              id: "best_ring",
              itemId: 999,
              simc: "finger1=best_ring,id=999,ilevel=289",
              epScore: 600,
            },
            {
              id: "second_ring",
              itemId: 998,
              simc: "finger1=second_ring,id=998,ilevel=289",
              epScore: 400,
            },
          ],
          finger2: [
            {
              id: "best_ring",
              itemId: 999,
              simc: "finger2=best_ring,id=999,ilevel=289",
              epScore: 600,
            },
            {
              id: "third_ring",
              itemId: 997,
              simc: "finger2=third_ring,id=997,ilevel=289",
              epScore: 350,
            },
          ],
        },
      }),
    );

    for (const config of result.configurations) {
      const f1 = config.slots.finger1;
      const f2 = config.slots.finger2;
      if (f1.id !== "__placeholder__" && f2.id !== "__placeholder__") {
        assert.notEqual(
          f1.itemId ?? f1.id,
          f2.itemId ?? f2.id,
          "Same ring must not appear in both finger slots",
        );
      }
    }
  });

  it("respects unique-equip restrictions", () => {
    const result = solveGearSet(
      baseInput({
        effectItemResults: {
          main_hand: [
            {
              candidateId: "unique_weapon_a",
              weightedDps: 80000,
              simc: "main_hand=unique_weapon_a,id=500,ilevel=289",
              uniqueEquipped: "unique_set_1",
            },
          ],
          off_hand: [
            {
              candidateId: "unique_weapon_b",
              weightedDps: 79000,
              simc: "off_hand=unique_weapon_b,id=501,ilevel=289",
              uniqueEquipped: "unique_set_1",
            },
            {
              candidateId: "normal_oh",
              weightedDps: 74000,
              simc: "off_hand=normal_oh,id=502,ilevel=289",
            },
          ],
        },
      }),
    );

    for (const config of result.configurations) {
      const mh = config.slots.main_hand;
      const oh = config.slots.off_hand;
      if (mh.uniqueEquipped && oh.uniqueEquipped) {
        assert.notEqual(
          mh.uniqueEquipped,
          oh.uniqueEquipped,
          "Unique-equipped items from same group must not coexist",
        );
      }
    }
  });
});
