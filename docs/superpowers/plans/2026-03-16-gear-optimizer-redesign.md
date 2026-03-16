# Gear Optimizer Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sequential priority-waterfall gear pipeline with a constraint-based full-set optimizer that produces deterministic, correct gear profiles.

**Architecture:** Sim all components (embellishments, effect items, trinkets, mini-sets) needed for the report anyway, feed sim results + EP into a constraint solver that enumerates valid full gear sets, validate top candidates as complete 16-slot sets, and write the profile from scratch using gear-candidates.json as sole source of truth.

**Tech Stack:** Node.js ESM, SQLite (via `src/util/db.js`), SimC profileset mode (via `src/sim/profilesets.js` and `src/sim/runner.js`).

**Spec:** `docs/superpowers/specs/2026-03-16-gear-optimizer-redesign.md`

---

## File Structure

| File                                    | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `src/sim/gear.js`                       | Pipeline orchestration: phase sequencing, CLI, sim dispatch, DB persistence. PRESERVE sim infrastructure (`runBuildScenarioSims`, `runWithConcurrency`, `simConcurrency`, `aggregateGearResults`, `pruneResults`, `screenSlot`, DB helpers). REWRITE: `cmdRun`, `cmdWriteProfile`, `buildGearLines`. REMOVE: `buildEnchantMap`, `applySlotEnchant`, `applyStatAlloc`, `resolveComboOverrides`, `getTierLines`, `applyGemQueueToLines`, `buildGemQueue`.                                                                              |
| `src/sim/gear-solver.js`                | NEW: Constraint solver. Enumerates valid gear sets from component sim results + EP scores. Pure function, no I/O.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/sim/gear-profile-writer.js`        | NEW: Profile assembly. Generates profile.simc from scratch using gear-candidates.json + solver output + gem/enchant results. Includes verification checks.                                                                                                                                                                                                                                                                                                                                                                           |
| `src/sim/gear.js` (existing helpers)    | PRESERVE as-is: `loadGearCandidates`, `getRepresentativeBuilds`, `getBaseProfile`, `getGearTarget`, `scoreEp`, `countSockets`, `isCraftedSimc`, `isSignificant`, `computeWeightedDps`, `aggregateGearResults`, `pruneResults`, `screenSlot`, `saveGearResults`, `queryGearResults`, `getGearResults`, `getBestGear`, `clearGearResults`, `cmdStatus`, `cmdResults`, `isPhaseComplete`, `isGearValidationPassed`, `generateEmbellishmentPairs`, `generatePairedSlotCombinations`, `pairedSlotScreenCandidates`, `detectCraftedSlots`. |
| `tests/sim/gear-solver.test.js`         | NEW: Unit tests for constraint solver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/sim/gear-profile-writer.test.js` | NEW: Unit tests for profile writer verification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Chunk 1: Constraint Solver (`gear-solver.js`)

The solver is the core new component. It takes structured inputs from sim results and EP, enumerates valid configurations subject to hard constraints, scores them, and returns ranked candidates. It has zero I/O — pure function, fully testable.

### Task 1: Define solver input/output types and scaffold

**Files:**

- Create: `src/sim/gear-solver.js`
- Create: `tests/sim/gear-solver.test.js`

- [ ] **Step 1: Write the failing test for solver interface**

```js
// tests/sim/gear-solver.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sim/gear-solver.test.js`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement the solver scaffold**

Create `src/sim/gear-solver.js` with the `solveGearSet` function. The solver must:

1. **Enumerate tier skip options** (5 choices: which tier slot to skip, fill with best alternative)
2. **For each tier config, enumerate embellishment placements** (from `embellishmentResults`, which already encode slot assignments)
3. **Check constraints**: crafted count <= 2, emb count == 2, no unique-equip conflicts
4. **Fill remaining slots**: effect items from `effectItemResults` (sim-ranked), stat-sticks from `statStickCandidates` (EP-ranked)
5. **Score**: sum of embellishment weighted DPS delta + effect item DPS deltas + stat-stick EP scores
6. **Return top 10** configurations sorted by score descending

Each configuration is a map of slot -> `{ id, simc, isTier, isCrafted, embellishment, epScore, simDps }`.

```js
// src/sim/gear-solver.js

export function solveGearSet(input) {
  const {
    tierConfig,
    embellishmentResults,
    effectItemResults,
    miniSetResults,
    statStickCandidates,
    scaleFactors,
    maxCrafted = 2,
    maxEmbellishments = 2,
  } = input;

  const configs = [];

  // Enumerate tier skip options
  const tierSlotNames = Object.keys(tierConfig.slots);
  for (let skipIdx = 0; skipIdx < tierSlotNames.length; skipIdx++) {
    const skipSlot = tierSlotNames[skipIdx];
    const alternatives = tierConfig.alternatives[skipSlot] || [];
    if (alternatives.length === 0) continue;

    // Build tier assignment for this skip option
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

    // For each embellishment config
    for (const emb of embellishmentResults) {
      // Check if embellishment slots conflict with tier slots
      const embSlots = emb.slots || [];
      const tierConflict = embSlots.some((s) => tierAssignment[s]);
      if (tierConflict) continue;

      // Check crafted + emb limits
      const craftedFromEmb = emb.crafted ? embSlots.length : 0;
      const embFromEmb = emb.embCount || 0;
      if (craftedFromEmb > maxCrafted) continue;
      if (embFromEmb > maxEmbellishments) continue;

      // Build the configuration
      const slotMap = { ...tierAssignment };
      let craftedCount = craftedFromEmb;
      let embCount = embFromEmb;

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
      const altIsCrafted =
        bestAlt.simc?.includes("crafted_stats") ||
        bestAlt.simc?.includes("bonus_id=8793");
      if (altIsCrafted && craftedCount >= maxCrafted) continue;
      slotMap[skipSlot] = {
        id: bestAlt.id,
        simc: bestAlt.simc,
        isTier: false,
        isCrafted: altIsCrafted,
        embellishment: null,
      };
      if (altIsCrafted) craftedCount++;

      // Fill effect item slots (weapons, etc.)
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

      // Fill trinket slots as placeholders (trinkets evaluated later)
      for (const slot of ["trinket1", "trinket2"]) {
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

      // Score the configuration
      const score = scoreConfiguration(slotMap, emb);

      // Validate constraints
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

      configs.push({
        slots: slotMap,
        score,
        embConfig: emb.candidateId,
        tierSkip: skipSlot,
      });
    }
  }

  // Also try baseline (no tier skip) if tier count allows it
  // (current profile may already have 4pc without skipping)

  // Sort by score, return top 10
  configs.sort((a, b) => b.score - a.score);
  return { configurations: configs.slice(0, 10) };
}

function scoreConfiguration(slotMap, embResult) {
  let score = 0;

  // Embellishment contribution (sim-measured DPS)
  score += embResult.weightedDps || 0;

  // Effect item contributions
  for (const slot of Object.values(slotMap)) {
    if (slot.simDps) score += slot.simDps;
    if (slot.epScore) score += slot.epScore;
  }

  return score;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sim/gear-solver.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/sim/gear-solver.js tests/sim/gear-solver.test.js
git commit -m "feat(gear): scaffold constraint solver with basic test"
```

### Task 2: Add mini-set support to the solver

**Files:**

- Modify: `src/sim/gear-solver.js`
- Modify: `tests/sim/gear-solver.test.js`

- [ ] **Step 1: Write the failing test for mini-set handling**

```js
it("evaluates mini-set pairs as atomic options AND individual pieces", () => {
  const result = solveGearSet({
    // ... standard tier/emb/effect setup ...
    miniSetResults: [
      {
        setId: 1966,
        setName: "Murder Row Materials",
        pairs: [
          {
            slot1: "wrist",
            slot2: "chest",
            pairDpsBonus: 2500, // 2P bonus DPS
            item1: {
              id: "row_walkers_deflectors",
              simc: "wrist=row_walkers_deflectors,id=244612,bonus_id=8793/13454,ilevel=285",
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
        // Individual piece rankings (may be BiS without the set bonus)
        individuals: [
          {
            id: "row_walkers_deflectors",
            slot: "wrist",
            weightedDps: 72000,
            isCrafted: true,
            isBuiltInEmb: true,
          },
        ],
      },
    ],
    // ...
  });

  // The solver should have evaluated configs with:
  // 1. The 2P pair (uses 2 crafted + 2 emb slots, adds pairDpsBonus)
  // 2. Individual pieces as standalone options
  // Both should appear in configurations
  const hasPairConfig = result.configurations.some(
    (c) =>
      c.slots.wrist?.id === "row_walkers_deflectors" &&
      c.slots.chest?.id === "row_walkers_insurance",
  );
  const hasIndividualConfig = result.configurations.some(
    (c) =>
      c.slots.wrist?.id === "row_walkers_deflectors" &&
      c.slots.chest?.id !== "row_walkers_insurance",
  );
  // At least one type should be present (depends on scoring)
  assert.ok(
    hasPairConfig || hasIndividualConfig,
    "Solver must evaluate mini-set options",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement mini-set enumeration in the solver**

Add mini-set pairs as additional configuration branches:

- A mini-set pair occupies 2 specific slots, uses 2 crafted slots and (if built-in emb) 2 emb slots
- The pair gets `pairDpsBonus` added to its score
- Individual mini-set pieces are added to `effectItemResults` or `statStickCandidates` as standalone options
- Constraint checking ensures mini-set pair doesn't exceed crafted/emb limits

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gear): add mini-set pair and individual evaluation to solver"
```

### Task 3: Add unique-equip and ring dedup constraints

**Files:**

- Modify: `src/sim/gear-solver.js`
- Modify: `tests/sim/gear-solver.test.js`

- [ ] **Step 1: Write failing tests**

Test that:

- Same ring can't appear in both finger1 and finger2
- Unique-equipped trinkets can't both be selected
- Items flagged `uniqueEquipped: true` are tracked across all slots

- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement unique-equip tracking**

Add `equippedItemIds` set to the configuration builder. Before placing any item, check its item ID against the set. For paired items (trinkets, rings), check both IDs.

- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gear): add unique-equip and ring dedup constraints to solver"
```

### Task 4: Solver edge cases and robustness

**Files:**

- Modify: `src/sim/gear-solver.js`
- Modify: `tests/sim/gear-solver.test.js`

- [ ] **Step 1: Write edge case tests**

- Empty alternatives for all tier slots (no skip possible, use all 5 tier pieces if that's 4pc compatible)
- Zero embellishment results (should produce configs with no embellishments — though the constraint requires exactly 2, so this should produce 0 valid configs)
- A slot with no candidates (should be filled from the existing profile or marked as missing)
- Embellishment that claims a tier slot (should be skipped)
- Mini-set pair where one piece is in a tier slot (pair only valid if that tier slot is the skipped one)

- [ ] **Step 2-4: Implement and verify**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gear): solver edge cases - empty slots, tier conflicts, constraint violations"
```

---

## Chunk 2: Profile Writer (`gear-profile-writer.js`)

The profile writer generates profile.simc from scratch. It reads ONLY the preamble (talents, flask, food, overrides) from the old profile. All gear lines come from the solver output + gear-candidates.json.

### Task 5: Scaffold profile writer with verification

**Files:**

- Create: `src/sim/gear-profile-writer.js`
- Create: `tests/sim/gear-profile-writer.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleProfile,
  verifyProfile,
} from "../../src/sim/gear-profile-writer.js";

describe("assembleProfile", () => {
  it("generates a complete profile from solver output", () => {
    const preamble = [
      'demonhunter="VDH_Midnight"',
      "spec=vengeance",
      "level=90",
      "race=night_elf",
      "role=tank",
      "talents=CUkAAAA...",
    ];

    const solverOutput = {
      head: { simc: "head=tier_head,id=1,ilevel=289" },
      neck: { simc: "neck=necklace,id=2,ilevel=289,gem_id=240983" },
      // ... all 16 slots
    };

    const gemConfig = { type: "diverse", gemIds: [240983, 240902, 240918] };
    const enchantConfig = {
      chest: 7985,
      legs: 8159,
      shoulder: 7971,
      weapon_mh: 7983,
      weapon_oh: 7983,
      ring: 7967,
    };

    const profile = assembleProfile({
      preamble,
      solverOutput,
      gemConfig,
      enchantConfig,
    });

    assert.ok(profile.includes('demonhunter="VDH_Midnight"'));
    assert.ok(profile.includes("head=tier_head"));
    assert.ok(profile.includes("neck=necklace"));
    // All 16 slots present
    for (const slot of [
      "head",
      "neck",
      "shoulder",
      "back",
      "chest",
      "wrist",
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
    ]) {
      assert.ok(profile.includes(`${slot}=`), `Missing slot: ${slot}`);
    }
  });
});

describe("verifyProfile", () => {
  it("catches multi-gem corruption", () => {
    const gearCandidates = {
      slots: {
        neck: {
          candidates: [
            {
              id: "necklace",
              simc: "neck=necklace,id=2,ilevel=289,gem_id=240983",
            },
          ],
        },
      },
    };
    const profileLines = ["neck=necklace,id=2,ilevel=289,gem_id=240983/240902"];
    const result = verifyProfile(profileLines, gearCandidates);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes("gem count"));
  });

  it("catches embellishment overflow", () => {
    const profileLines = [
      "wrist=item1,id=1,embellishment=hunt",
      "waist=item2,id=2,embellishment=void",
      "feet=world_tree_rootwraps,id=244601,bonus_id=8793/13454",
    ];
    const gearCandidates = {
      embellishments: {
        builtInItems: [{ id: "world_tree_rootwraps", slot: "feet" }],
      },
    };
    const result = verifyProfile(profileLines, gearCandidates);
    assert.ok(result.errors.some((e) => e.includes("embellishment")));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement `assembleProfile` and `verifyProfile`**

`assembleProfile`:

- Takes preamble lines, solver slot output, gem config, enchant config
- For each of the 16 slots in canonical order, builds the SimC line from `solverOutput[slot].simc`
- Applies gem_id based on socket count from the candidate's simc string (count `/` separators in existing `gem_id=`)
- Applies enchant_id from enchantConfig
- Applies `crafted_stats=` from solver output
- Applies `embellishment=` from solver output
- Returns the complete profile as a string

`verifyProfile`:

- Checks gem count per item matches socket count in gear-candidates.json
- Checks total embellishments = 2 (explicit + built-in)
- Checks total crafted items <= 2
- Checks no `embellishment=X` on built-in embellishment items
- Returns `{ valid: boolean, errors: string[] }`

- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gear): profile writer with verification checks"
```

### Task 6: Gem and enchant application

**Files:**

- Modify: `src/sim/gear-profile-writer.js`
- Modify: `tests/sim/gear-profile-writer.test.js`

- [ ] **Step 1: Write failing tests for gem socket counting and enchant application**

Test that:

- An item with `gem_id=240983` in gear-candidates gets exactly 1 gem
- An item with `gem_id=240983/240983` gets exactly 2 gems
- An item with no `gem_id=` gets no gem
- Enchants are applied to the correct slots (chest, legs, shoulder, weapons, rings)
- The `finger1` and `finger2` slots both get the `ring` enchant

- [ ] **Step 2-4: Implement and verify**

Socket counting: parse the candidate's `simc` string from gear-candidates.json, count gems by splitting `gem_id=` value on `/`. This is the SOURCE OF TRUTH for socket count — never read from the old profile.

- [ ] **Step 5: Commit**

```
git commit -m "feat(gear): gem socket counting from candidates + enchant application"
```

---

## Chunk 3: Pipeline Orchestration (rewrite `cmdRun` in `gear.js`)

This chunk replaces the phase sequencing in `gear.js`. The existing sim infrastructure (`runBuildScenarioSims`, `runWithConcurrency`, `aggregateGearResults`, etc.) is preserved. The `cmd*` phase functions are refactored to produce structured outputs that feed the solver.

### Task 7: New `cmdRun` orchestration

**Files:**

- Modify: `src/sim/gear.js` (rewrite `cmdRun` at line 3484, ~135 lines)

- [ ] **Step 1: Write the new `cmdRun` function**

The new `cmdRun` calls phases in this order:

```
Phase 1:  cmdScaleFactors (existing, preserved)
Phase 1b: cmdEpReweight (existing, preserved)
Phase 2a: cmdEmbellishments (refactored from cmdCombinations)
Phase 2b: cmdEffectItems (refactored from cmdProcEval)
Phase 2c: cmdMiniSets (refactored from cmdEvalSets)
Phase 2d: cmdTrinketScreen (refactored from cmdCombinations)
Phase 3:  solveGearSet (NEW — gear-solver.js)
Phase 4:  cmdFullSetValidation (NEW — sims top 10 complete sets)
Phase 5a: cmdTrinketPairs (refactored — sims against winning set)
Phase 5b: cmdCrossValidation (NEW — trinket × emb cross-check)
Phase 6a: cmdEmbRecheck (NEW — re-sims embs against winning set)
Phase 6b: cmdEpRecheck (NEW — re-derives scale factors from winning set)
Phase 7:  cmdGems (existing, modified to use winning set)
Phase 7b: cmdEnchants (existing, modified to use winning set)
Phase 7c: cmdFinalValidation (existing cmdValidate, modified)
Phase 8:  writeProfile (NEW — gear-profile-writer.js)
```

Each phase checks `isPhaseComplete()` for incremental resume. `--reset` clears all state. `--force` re-runs all.

- [ ] **Step 2: Implement phase-by-phase**, preserving existing sim infrastructure.

Key changes to existing `cmd*` functions:

- `cmdCombinations` split into `cmdEmbellishments` (Phase 2a) and `cmdTrinketScreen` (Phase 2d)
- `cmdProcEval` becomes `cmdEffectItems` (Phase 2b) — same logic, structured output
- `cmdEvalSets` becomes `cmdMiniSets` (Phase 2c) — same logic, structured output
- NEW `cmdFullSetValidation` — sims top 10 solver configurations as complete profilesets
- NEW `cmdTrinketPairs` — pairs against winning set, not old profile
- NEW `cmdCrossValidation` — top 3 trinket pairs × top 3 emb configs
- NEW `cmdEmbRecheck` — re-sims top 10 emb pairs against winning set
- NEW `cmdEpRecheck` — re-runs scale factors against winning set
- `cmdWriteProfile` replaced by `gear-profile-writer.js`

- [ ] **Step 3: Wire solver into the pipeline**

After Phase 2 completes, collect results into solver input format:

```js
const solverInput = {
  tierConfig: buildTierConfig(gearData),
  embellishmentResults: collectEmbResults(),
  effectItemResults: collectEffectResults(),
  miniSetResults: collectMiniSetResults(),
  statStickCandidates: collectEpRanked(gearData, sf),
  scaleFactors: sf,
};
const { configurations } = solveGearSet(solverInput);
```

- [ ] **Step 4: Test incrementally**

Run `SPEC=vengeance node src/sim/gear.js status` after each phase to verify state tracking works.

- [ ] **Step 5: Commit after each major phase integration**

```
git commit -m "feat(gear): new pipeline orchestration with constraint solver"
```

### Task 8: Phase 4 — Full-set validation

**Files:**

- Modify: `src/sim/gear.js`

- [ ] **Step 1: Implement `cmdFullSetValidation`**

Takes the top 10 configurations from the solver. For each, builds a complete SimC profileset variant with ALL 16 slots specified. Sims at standard fidelity using `runBuildScenarioSims`. Aggregates and ranks by weighted DPS.

The key difference from the old Phase 11: this sims MULTIPLE complete sets, not just one assembled set vs baseline.

- [ ] **Step 2: Store results and select winner**

Winner is the configuration with the highest validated weighted DPS. Store in session_state as `gear_phase4_winner`.

- [ ] **Step 3: Commit**

```
git commit -m "feat(gear): Phase 4 full-set validation of top 10 solver configs"
```

### Task 9: Phases 5-6 — Trinket pairing, cross-validation, re-evaluation

**Files:**

- Modify: `src/sim/gear.js`

- [ ] **Step 1: Implement `cmdTrinketPairs`**

Takes Phase 2d screen survivors. Generates C(K,2) pairs. Sims each pair AS PART OF the winning gear set from Phase 4 (not the old profile). Uses `runBuildScenarioSims` with the pair items overriding trinket1/trinket2 slots in the winning set.

- [ ] **Step 2: Implement `cmdCrossValidation`**

Takes top 3 trinket pairs × top 3 embellishment configs. For each of the 9 combinations, builds a complete 16-slot gear set and sims at standard fidelity. If a different combination wins, update the winning set.

- [ ] **Step 3: Implement `cmdEmbRecheck`**

Re-sims top 10 embellishment pairs against the winning set (not the old profile). If a different emb pair wins, re-run Phase 4 validation with the new emb config and update the winner.

- [ ] **Step 4: Implement `cmdEpRecheck`**

Re-derives scale factors from the winning set. Re-EP-ranks stat-stick slots. If any slot's winner changes, substitutes and re-validates.

- [ ] **Step 5: Commit**

```
git commit -m "feat(gear): trinket pairing, cross-validation, emb/EP re-evaluation"
```

### Task 10: Phase 7-8 — Gems, enchants, final validation, profile write

**Files:**

- Modify: `src/sim/gear.js`
- Uses: `src/sim/gear-profile-writer.js`

- [ ] **Step 1: Wire gem and enchant phases to the winning set**

Modify `cmdGems` and `cmdEnchants` to use the winning configuration's gear lines instead of `buildGearLines()`. The gem socket count comes from gear-candidates.json, not from the old profile.

- [ ] **Step 2: Wire `gear-profile-writer.js` into `cmdRun`**

After all phases complete:

```js
const profile = assembleProfile({
  preamble: readPreamble(getGearTarget(gearData)),
  solverOutput: winningConfig.slots,
  gemConfig: gemState,
  enchantConfig: enchantState,
});
const verification = verifyProfile(profile.split("\n"), gearData);
if (!verification.valid) {
  console.error("Profile verification FAILED:", verification.errors);
  process.exit(1);
}
writeFileSync(getGearTarget(gearData), profile);
```

- [ ] **Step 3: Run a quick single-profile sim to sanity-check DPS**

After writing profile.simc, sim it locally with `iterations=100` and check DPS is in the expected range (60-80k ST for VDH). If DPS is below 50k, abort with an error — the profile is broken.

- [ ] **Step 4: Commit**

```
git commit -m "feat(gear): gems, enchants, final validation, and profile writer integration"
```

---

## Chunk 4: Cleanup and Validation

### Task 11: Remove dead code

**Files:**

- Modify: `src/sim/gear.js`

- [ ] **Step 1: Remove replaced functions**

Delete:

- `buildGearLines` (line 2989-3266) — replaced by solver + profile writer
- `resolveComboOverrides` (line 320-358) — replaced by solver's direct slot assignment
- `applyStatAlloc` (line 2889-2903) — inlined into profile writer
- `applySlotEnchant` (line 2870-2886) — inlined into profile writer
- `buildEnchantMap` (line 2906-2947) — inlined into profile writer
- `getTierLines` (line 2951-2976) — replaced by solver's tier config
- `applyGemQueueToLines` (line 1299-1318) — replaced by profile writer
- `buildGemQueue` (line 1250-1296) — replaced by profile writer
- Old `cmdWriteProfile` (line 3271-3413) — replaced by profile writer

- [ ] **Step 2: Update `cmdStatus` to reflect new phases**
- [ ] **Step 3: Commit**

```
git commit -m "refactor(gear): remove replaced assembly functions"
```

### Task 12: End-to-end validation

**Files:**

- All modified files

- [ ] **Step 1: Run the new pipeline end-to-end**

```bash
SPEC=vengeance npm run gear:run -- --reset
```

- [ ] **Step 2: Verify output profile**

Check:

- DPS sanity (quick sim, expect 60-80k ST)
- Gem counts match gear-candidates.json
- Embellishment count = 2
- Crafted count <= 2
- All 16 slots populated
- Tier count = 4

- [ ] **Step 3: Compare against old pipeline output**

If the old pipeline's last output exists, sim both profiles at confirm fidelity and compare. The new system's output should be equal or better DPS.

- [ ] **Step 4: Run `/showcase --skip-sims` to verify report renders**
- [ ] **Step 5: Commit**

```
git commit -m "feat(gear): end-to-end validation of new gear optimizer"
```

### Task 13: Update skills and documentation

**Files:**

- Modify: `.claude/skills/gear/SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update /gear skill with new phase descriptions**
- [ ] **Step 2: Update CLAUDE.md gear pipeline section**
- [ ] **Step 3: Commit**

```
git commit -m "docs: update gear pipeline documentation for new optimizer"
```
