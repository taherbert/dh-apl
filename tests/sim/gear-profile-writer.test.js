import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleProfile,
  verifyProfile,
  countSockets,
} from "../../src/sim/gear-profile-writer.js";

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

function basePreamble() {
  return [
    'demonhunter="VDH_Midnight"',
    "spec=vengeance",
    "level=90",
    "race=night_elf",
    "timeofday=night",
    "role=tank",
    "position=front",
    "talents=CUkAAAA...",
    "",
    "flask=flask_of_the_magisters_2",
    "potion=lights_potential_2",
    "food=silvermoon_parade",
    "augmentation=void_touched",
    "",
    "override.arcane_intellect=1",
    "override.battle_shout=1",
  ];
}

function baseSolverOutput() {
  return {
    head: { simc: "head=tier_head,id=250033,ilevel=289,gem_id=240983" },
    neck: { simc: "neck=ribbon,id=249337,ilevel=289,gem_id=240983/240983" },
    shoulder: { simc: "shoulder=tier_shoulder,id=250031,ilevel=289" },
    back: { simc: "back=imperators_banner,id=249335,ilevel=289" },
    chest: { simc: "chest=tier_chest,id=251216,ilevel=289" },
    wrists: {
      simc: "wrists=agents_deflectors,id=244576,bonus_id=8793/13454,ilevel=285",
      isCrafted: true,
      craftedStats: "32/36",
      embellishment: "prismatic_focusing_iris",
    },
    hands: { simc: "hands=tier_hands,id=250034,ilevel=289" },
    waist: { simc: "waist=rootwalker_harness,id=251189,ilevel=289" },
    legs: { simc: "legs=tier_legs,id=250032,ilevel=289" },
    feet: { simc: "feet=footpads,id=151317,ilevel=289" },
    finger1: {
      simc: "finger1=omission_of_light,id=251093,ilevel=289,gem_id=240983/240902",
    },
    finger2: {
      simc: "finger2=occlusion_of_void,id=251217,ilevel=289,gem_id=240902/240902",
    },
    trinket1: { simc: "trinket1=gaze_of_the_alnseer,id=249343,ilevel=289" },
    trinket2: { simc: "trinket2=algethar_puzzle_box,id=193701,ilevel=289" },
    main_hand: { simc: "main_hand=lightless_lament,id=251143,ilevel=289" },
    off_hand: {
      simc: "off_hand=everforged_longsword,id=222440,bonus_id=8793/13454,ilevel=285",
      isCrafted: true,
      craftedStats: "32/36",
      embellishment: "darkmoon_sigil_hunt",
    },
  };
}

describe("assembleProfile", () => {
  it("generates a complete profile from solver output", () => {
    const profile = assembleProfile({
      preamble: basePreamble(),
      solverOutput: baseSolverOutput(),
      gemConfig: { primaryGemId: 240983, secondaryGemIds: [240902, 240918] },
      enchantConfig: {
        chest: 7985,
        legs: 8159,
        shoulder: 7971,
        main_hand: 8039,
        off_hand: 7983,
        finger1: 7967,
        finger2: 7967,
      },
    });

    // Preamble preserved
    assert.ok(profile.includes('demonhunter="VDH_Midnight"'));
    assert.ok(profile.includes("flask=flask_of_the_magisters_2"));
    assert.ok(profile.includes("override.arcane_intellect=1"));

    // All 16 slots present
    for (const slot of ALL_SLOTS) {
      assert.ok(profile.includes(`${slot}=`), `Missing slot: ${slot}`);
    }

    // Enchants applied to correct slots
    assert.ok(
      profile.includes("chest=tier_chest") &&
        profile.includes("enchant_id=7985"),
    );
    assert.ok(
      profile.includes("shoulder=tier_shoulder") &&
        profile.includes("enchant_id=7971"),
    );
    assert.ok(
      profile.includes("main_hand=lightless_lament") &&
        profile.includes("enchant_id=8039"),
    );

    // Crafted stats and embellishments applied
    assert.ok(profile.includes("crafted_stats=32/36"));
    assert.ok(profile.includes("embellishment=prismatic_focusing_iris"));
    assert.ok(profile.includes("embellishment=darkmoon_sigil_hunt"));
  });

  it("applies correct gem count from candidate simc", () => {
    const profile = assembleProfile({
      preamble: basePreamble(),
      solverOutput: baseSolverOutput(),
      gemConfig: { primaryGemId: 240983, secondaryGemIds: [240902] },
      enchantConfig: {},
    });

    const lines = profile.split("\n");

    // head has gem_id=240983 (1 socket) -> should get 1 gem
    const headLine = lines.find((l) => l.startsWith("head="));
    const headGems = headLine.match(/gem_id=([^,\n]+)/)?.[1];
    assert.equal(headGems.split("/").length, 1, "Head has 1 socket");

    // neck has gem_id=240983/240983 (2 sockets) -> should get 2 gems
    const neckLine = lines.find((l) => l.startsWith("neck="));
    const neckGems = neckLine.match(/gem_id=([^,\n]+)/)?.[1];
    assert.equal(neckGems.split("/").length, 2, "Neck has 2 sockets");

    // back has no gem_id -> no gems
    const backLine = lines.find((l) => l.startsWith("back="));
    assert.ok(!backLine.includes("gem_id="), "Back has no sockets");
  });

  it("applies finger1 and finger2 enchants from ring config", () => {
    const profile = assembleProfile({
      preamble: basePreamble(),
      solverOutput: baseSolverOutput(),
      gemConfig: { primaryGemId: 240983, secondaryGemIds: [] },
      enchantConfig: { finger1: 7967, finger2: 7967 },
    });

    const lines = profile.split("\n");
    const f1 = lines.find((l) => l.startsWith("finger1="));
    const f2 = lines.find((l) => l.startsWith("finger2="));
    assert.ok(
      f1.includes("enchant_id=7967"),
      "finger1 should have ring enchant",
    );
    assert.ok(
      f2.includes("enchant_id=7967"),
      "finger2 should have ring enchant",
    );
  });
});

describe("verifyProfile", () => {
  it("passes for a valid profile", () => {
    const profileLines = [
      "head=tier_head,id=250033,ilevel=289,gem_id=240983",
      "neck=ribbon,id=249337,ilevel=289,gem_id=240983/240983",
      "wrists=agents_deflectors,id=244576,bonus_id=8793/13454,ilevel=285,crafted_stats=32/36,embellishment=prismatic_focusing_iris",
      "off_hand=everforged,id=222440,bonus_id=8793/13454,ilevel=285,crafted_stats=32/36,embellishment=darkmoon_sigil_hunt",
    ];
    const gearCandidates = {
      slots: {
        neck: {
          candidates: [
            {
              id: "ribbon",
              simc: "neck=ribbon,id=249337,ilevel=289,gem_id=240983/240983",
            },
          ],
        },
      },
    };
    const result = verifyProfile(profileLines, gearCandidates);
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
  });

  it("catches multi-gem corruption", () => {
    const profileLines = [
      "neck=ribbon,id=249337,ilevel=289,gem_id=240983/240902/240918",
    ];
    const gearCandidates = {
      slots: {
        neck: {
          candidates: [
            {
              id: "ribbon",
              simc: "neck=ribbon,id=249337,ilevel=289,gem_id=240983/240983",
            },
          ],
        },
      },
    };
    const result = verifyProfile(profileLines, gearCandidates);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("gem count"));
  });

  it("catches embellishment overflow", () => {
    const profileLines = [
      "wrists=item1,id=1,embellishment=hunt",
      "waist=item2,id=2,embellishment=void",
      "feet=item3,id=3,embellishment=rot",
    ];
    const gearCandidates = { slots: {} };
    const result = verifyProfile(profileLines, gearCandidates);
    assert.ok(result.errors.some((e) => e.includes("embellishment")));
  });

  it("catches crafted overflow", () => {
    const profileLines = [
      "wrists=item1,id=1,bonus_id=8793/13454,embellishment=a",
      "waist=item2,id=2,bonus_id=8793/13454,embellishment=b",
      "feet=item3,id=3,bonus_id=8793/13454",
    ];
    const gearCandidates = { slots: {} };
    const result = verifyProfile(profileLines, gearCandidates);
    assert.ok(result.errors.some((e) => e.includes("crafted")));
  });
});

describe("countSockets", () => {
  it("counts 0 for no gem_id", () => {
    assert.equal(countSockets("head=tier_head,id=1,ilevel=289"), 0);
  });

  it("counts 1 for single gem", () => {
    assert.equal(
      countSockets("head=tier_head,id=1,ilevel=289,gem_id=240983"),
      1,
    );
  });

  it("counts 2 for two gems", () => {
    assert.equal(
      countSockets("neck=ribbon,id=2,ilevel=289,gem_id=240983/240983"),
      2,
    );
  });

  it("counts 3 for three gems", () => {
    assert.equal(countSockets("neck=ribbon,id=2,ilevel=289,gem_id=1/2/3"), 3);
  });
});
