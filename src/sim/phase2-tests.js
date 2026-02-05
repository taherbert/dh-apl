// Phase 2: Simulation-Driven Priority Discovery
// Runs profileset tests to discover optimal AR priority ordering.
// VDH-specific: these tests are tied to Vengeance mechanics and are not spec-agnostic.
// Usage: node src/sim/phase2-tests.js [test-name] [scenario]
// Tests: spb-threshold, fracture-guard, cooldown-order, felblade, core-order, all

import {
  generateProfileset,
  runProfileset,
  printProfilesetResults,
} from "./profilesets.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(ROOT, "results");
const APL_PATH = join(ROOT, "apls", `${config.spec.specName}.simc`);

// Shared AR list prefix (trinkets, potion, externals, sub-list calls)
const AR_PREFIX = [
  "use_item,slot=trinket1,if=!trinket.1.is.tome_of_lights_devotion&(!variable.trinket_1_buffs|(variable.trinket_1_buffs&((buff.metamorphosis.up)|(buff.metamorphosis.up&cooldown.metamorphosis.remains<10)|(cooldown.metamorphosis.remains>trinket.1.cooldown.duration)|(variable.trinket_2_buffs&trinket.2.cooldown.remains<cooldown.metamorphosis.remains))))",
  "use_item,slot=trinket2,if=!trinket.2.is.tome_of_lights_devotion&(!variable.trinket_2_buffs|(variable.trinket_2_buffs&((buff.metamorphosis.up)|(buff.metamorphosis.up&cooldown.metamorphosis.remains<10)|(cooldown.metamorphosis.remains>trinket.2.cooldown.duration)|(variable.trinket_1_buffs&trinket.1.cooldown.remains<cooldown.metamorphosis.remains))))",
  "use_item,name=tome_of_lights_devotion,if=buff.inner_resilience.up",
  "potion,use_off_gcd=1,if=(buff.rending_strike.up&buff.glaive_flurry.up)|prev_gcd.1.reavers_glaive",
  "call_action_list,name=externals,if=(buff.rending_strike.up&buff.glaive_flurry.up)|prev_gcd.1.reavers_glaive",
  "call_action_list,name=ar_empowered",
  "call_action_list,name=ar_cooldowns",
];

const AR_FILLERS = [
  "immolation_aura",
  "vengeful_retreat,if=talent.unhindered_assault",
  "throw_glaive",
];

// Format an array of action lines as SimC action list overrides.
function buildActionList(listName, actions) {
  return actions.map((action, i) =>
    i === 0
      ? `actions.${listName}=${action}`
      : `actions.${listName}+=/${action}`,
  );
}

function buildArList(coreRotation) {
  return buildActionList("ar", [...AR_PREFIX, ...coreRotation, ...AR_FILLERS]);
}

function buildCooldownList(cooldowns) {
  return buildActionList("ar_cooldowns", cooldowns);
}

// === TEST 1: Spirit Bomb fragment threshold ===
function spbThresholdTest() {
  const variants = [];
  for (const threshold of [2, 3, 4, 5]) {
    const core = [
      `spirit_bomb,if=soul_fragments>=${threshold}`,
      `fracture,if=soul_fragments<=4`,
      "immolation_aura,if=talent.fallout",
      "sigil_of_flame",
      "soul_cleave",
      "felblade",
    ];
    variants.push({
      name: `spb_at_${threshold}_frags`,
      overrides: buildArList(core),
    });
  }
  return { label: "spb_threshold", variants };
}

// === TEST 2: Fracture overflow guard threshold ===
function fractureGuardTest() {
  const variants = [];
  for (const guard of [3, 4, 5, 6]) {
    const guardLabel = guard === 6 ? "no_guard" : `guard_${guard}`;
    const fractureCondition =
      guard === 6 ? "fracture" : `fracture,if=soul_fragments<=${guard}`;
    const core = [
      "spirit_bomb,if=soul_fragments>=4",
      fractureCondition,
      "immolation_aura,if=talent.fallout",
      "sigil_of_flame",
      "soul_cleave",
      "felblade",
    ];
    variants.push({
      name: `frac_${guardLabel}`,
      overrides: buildArList(core),
    });
  }
  return { label: "fracture_guard", variants };
}

// === TEST 3: Cooldown sub-list ordering ===
function cooldownOrderTest() {
  const abilities = {
    spite: "sigil_of_spite,if=soul_fragments<=3",
    brand: "fiery_brand,if=talent.fiery_demise&!dot.fiery_brand.ticking",
    carver:
      "soul_carver,if=!talent.fiery_demise|(talent.fiery_demise&dot.fiery_brand.ticking)",
    feldev: "fel_devastation,if=!buff.rending_strike.up&!buff.glaive_flurry.up",
  };

  // Test key orderings (not all 24 permutations)
  const orderings = [
    {
      name: "spite_brand_carver_feldev",
      keys: ["spite", "brand", "carver", "feldev"],
    },
    {
      name: "brand_carver_spite_feldev",
      keys: ["brand", "carver", "spite", "feldev"],
    },
    {
      name: "brand_spite_carver_feldev",
      keys: ["brand", "spite", "carver", "feldev"],
    },
    {
      name: "feldev_spite_brand_carver",
      keys: ["feldev", "spite", "brand", "carver"],
    },
    {
      name: "spite_feldev_brand_carver",
      keys: ["spite", "feldev", "brand", "carver"],
    },
    {
      name: "brand_feldev_spite_carver",
      keys: ["brand", "feldev", "spite", "carver"],
    },
  ];

  const variants = orderings.map((o) => ({
    name: `cd_${o.name}`,
    overrides: buildCooldownList(o.keys.map((k) => abilities[k])),
  }));

  return { label: "cooldown_order", variants };
}

// === TEST 4: Felblade value ===
function felbladeTest() {
  const positions = [
    {
      name: "fb_after_fracture",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "fracture,if=soul_fragments<=4",
        "felblade",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "soul_cleave",
      ],
    },
    {
      name: "fb_after_spb",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "felblade",
        "fracture,if=soul_fragments<=4",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "soul_cleave",
      ],
    },
    {
      name: "fb_low_priority",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "fracture,if=soul_fragments<=4",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "soul_cleave",
        "felblade",
      ],
    },
    {
      name: "fb_removed",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "fracture,if=soul_fragments<=4",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "soul_cleave",
      ],
    },
  ];

  const variants = positions.map((p) => ({
    name: p.name,
    overrides: buildArList(p.core),
  }));

  return { label: "felblade_value", variants };
}

// === TEST 5: Core rotation ordering ===
function coreOrderTest() {
  const orderings = [
    {
      name: "spb_frac_immo_sigil_sc_fb",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "fracture,if=soul_fragments<=4",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "soul_cleave",
        "felblade",
      ],
    },
    {
      name: "frac_spb_immo_sigil_sc_fb",
      core: [
        "fracture,if=soul_fragments<=4",
        "spirit_bomb,if=soul_fragments>=4",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "soul_cleave",
        "felblade",
      ],
    },
    {
      name: "spb_immo_frac_sigil_sc_fb",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "immolation_aura,if=talent.fallout",
        "fracture,if=soul_fragments<=4",
        "sigil_of_flame",
        "soul_cleave",
        "felblade",
      ],
    },
    {
      name: "spb_frac_sc_immo_sigil_fb",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "fracture,if=soul_fragments<=4",
        "soul_cleave",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "felblade",
      ],
    },
    {
      name: "immo_spb_frac_sigil_sc_fb",
      core: [
        "immolation_aura,if=talent.fallout",
        "spirit_bomb,if=soul_fragments>=4",
        "fracture,if=soul_fragments<=4",
        "sigil_of_flame",
        "soul_cleave",
        "felblade",
      ],
    },
    {
      // Fracture above Meta check: use it aggressively in Meta
      name: "spb_frac_meta_frac_immo_sigil_sc_fb",
      core: [
        "spirit_bomb,if=soul_fragments>=4",
        "fracture,if=buff.metamorphosis.up",
        "fracture,if=soul_fragments<=4",
        "immolation_aura,if=talent.fallout",
        "sigil_of_flame",
        "soul_cleave",
        "felblade",
      ],
    },
  ];

  const variants = orderings.map((o) => ({
    name: o.name,
    overrides: buildArList(o.core),
  }));

  return { label: "core_order", variants };
}

const ALL_TESTS = {
  "spb-threshold": spbThresholdTest,
  "fracture-guard": fractureGuardTest,
  "cooldown-order": cooldownOrderTest,
  felblade: felbladeTest,
  "core-order": coreOrderTest,
};

// Run a single test
function runTest(testName, scenario, simOverrides) {
  const testFn = ALL_TESTS[testName];
  if (!testFn)
    throw new Error(
      `Unknown test: ${testName}. Valid: ${Object.keys(ALL_TESTS).join(", ")}`,
    );

  const { label, variants } = testFn();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${testName} (${variants.length} variants, ${scenario})`);
  console.log("=".repeat(60));

  const simcContent = generateProfileset(APL_PATH, variants);
  const results = runProfileset(simcContent, scenario, label, { simOverrides });
  printProfilesetResults(results);

  // Save results
  const outPath = join(RESULTS_DIR, `phase2_${label}_${scenario}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));

  return results;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const testName = process.argv[2] || "all";
  const scenario = process.argv[3] || "st";

  // Quick mode: faster iterations for discovery
  const simOverrides = { target_error: 1.0, iterations: 1000000 };

  mkdirSync(RESULTS_DIR, { recursive: true });

  const allResults = {};

  if (testName === "all") {
    for (const name of Object.keys(ALL_TESTS)) {
      allResults[name] = runTest(name, scenario, simOverrides);
    }
  } else {
    allResults[testName] = runTest(testName, scenario, simOverrides);
  }

  // Print summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("PHASE 2 RESULTS SUMMARY");
  console.log("=".repeat(60));

  for (const [name, results] of Object.entries(allResults)) {
    console.log(`\n${name}:`);
    const best = results.variants[0];
    const worst = results.variants[results.variants.length - 1];
    if (best && worst) {
      const baselineDps = results.baseline.dps;
      const bestDelta = (
        ((best.dps - baselineDps) / baselineDps) *
        100
      ).toFixed(1);
      const worstDelta = (
        ((worst.dps - baselineDps) / baselineDps) *
        100
      ).toFixed(1);
      console.log(`  Best:  ${best.name} (${bestDelta}%)`);
      console.log(`  Worst: ${worst.name} (${worstDelta}%)`);
      console.log(
        `  Spread: ${(((best.dps - worst.dps) / worst.dps) * 100).toFixed(1)}% between best and worst`,
      );
    }
  }
}
