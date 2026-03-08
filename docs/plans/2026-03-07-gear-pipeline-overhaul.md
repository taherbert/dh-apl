# Gear Pipeline Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the gear pipeline to converge on globally optimal gear instead of a local EP optimum, closing the ~5% DPS gap vs Raidbots Top Gear.

**Architecture:** Keep the EP-based pipeline but add iterative reweighting using existing stat curve data, a combinatorial validation phase for stat synergy discovery, sim-based gem optimization, and data completeness fixes. The pipeline phases remain sequential but Phase 1 outputs better weights and Phase 3b validates combinations.

**Tech Stack:** Node.js ESM, SimC profilesets, SQLite (session_state table)

---

### Task 1: Add Missing Crafted Stat Pair

**Files:**

- Modify: `src/sim/gear.js:352-358` (CRAFTED_STAT_PAIRS array)

**Step 1: Add vers_mastery pair**

In `src/sim/gear.js`, add the missing pair to `CRAFTED_STAT_PAIRS`:

```js
const CRAFTED_STAT_PAIRS = [
  { id: "crit_haste", label: "Crit/Haste", crafted_stats: "32/36" },
  { id: "crit_vers", label: "Crit/Vers", crafted_stats: "32/40" },
  { id: "crit_mastery", label: "Crit/Mastery", crafted_stats: "32/49" },
  { id: "haste_vers", label: "Haste/Vers", crafted_stats: "36/40" },
  { id: "haste_mastery", label: "Haste/Mastery", crafted_stats: "36/49" },
  { id: "vers_mastery", label: "Vers/Mastery", crafted_stats: "40/49" },
];
```

**Step 2: Verify**

Run: `SPEC=havoc node src/sim/gear.js status`
Expected: no errors, pipeline status prints normally.

**Step 3: Commit**

```
git add src/sim/gear.js
git commit -m "feat(gear): add vers_mastery crafted stat pair"
```

---

### Task 2: Fix Data Completeness — Back Slot and Enchants

The `gear:fetch-candidates` script already maps `back` in `INDIVIDUAL_SLOTS` (line 62) and maps cloak/foot/wrist/shoulder enchant categories (lines 74-93). But the Raidbots data source may not be returning them. This task diagnoses and fixes why.

**Files:**

- Modify: `src/extract/gear-candidates.js` — debug/fix back slot and enchant extraction
- Output: `data/havoc/gear-candidates.json` — will gain `back` slot and additional enchant sections

**Step 1: Run fetch-candidates with verbose output to diagnose**

```bash
SPEC=havoc npm run gear:fetch-candidates 2>&1 | tee /tmp/fetch-output.txt
```

Check output for:

- How many `back` items were found (should be >0 if cloaks exist in Raidbots data)
- Which enchant categories were detected
- Any filtering that removes back or enchant candidates

**Step 2: Fix the extraction**

If back items aren't in the Raidbots item pool:

- Check if `INV_TYPE_SLOT` includes the right inventory type for cloaks (type 16 = back/cloak). Currently line 33 maps type 16 to nothing. Add: `16: "back"` if missing.
- If Raidbots doesn't provide back items at all, add manual back candidates to `gear-config.json` similar to tier alternatives.

If enchants are missing:

- Check if the Raidbots enchant data groups them under different category names than what `ENCHANT_CATEGORY_MAP` expects.
- Add any missing category name mappings.

**Step 3: Verify gear-candidates.json has the new data**

```bash
node -e "const gc=JSON.parse(require('fs').readFileSync('data/havoc/gear-candidates.json','utf-8')); console.log('back:', gc.slots?.back?.candidates?.length || 0); console.log('enchants:', Object.keys(gc.enchants||{}).join(', '));"
```

Expected: `back: >0` and enchant keys should include `cloak`, `foot`, `wrist`, `shoulder` in addition to existing ones.

**Step 4: Commit**

```
git add src/extract/gear-candidates.js data/havoc/gear-candidates.json
git commit -m "fix(gear): extract back slot and missing enchant categories"
```

---

### Task 3: Multi-Scenario Scale Factors (Phase 1)

Currently `cmdScaleFactors` only computes for the `st` scenario (line 388). Change it to compute per-scenario and combine with `SCENARIO_WEIGHTS`.

**Files:**

- Modify: `src/sim/gear.js:384-481` (cmdScaleFactors function)

**Step 1: Restructure cmdScaleFactors to loop over scenarios**

Replace the single-scenario sim with a loop:

```js
async function cmdScaleFactors(args) {
  const fidelity = parseFidelity(args, "standard");
  const gearData = loadGearCandidates();
  const profilePath = getBaseProfile(gearData);
  const fidelityConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.standard;
  mkdirSync(resultsDir(), { recursive: true });
  const { threadsPerSim } = simConcurrency(1);

  console.log(
    `\nPhase 1: Scale Factors (${fidelity} fidelity, ${threadsPerSim} threads)`,
  );

  const perScenario = {};
  const statKeys = ["Agi", "Haste", "Crit", "Mastery", "Vers"];

  for (const scenario of Object.keys(SCENARIOS)) {
    const scConfig = SCENARIOS[scenario];
    const outputPath = resultsFile(`gear_scale_factors_${scenario}.json`);

    const simArgs = [
      profilePath,
      "calculate_scale_factors=1",
      "scale_only=Agi/Haste/Crit/Mastery/Vers",
      `json2=${outputPath}`,
      `threads=${threadsPerSim}`,
      `max_time=${scConfig.maxTime}`,
      `desired_targets=${scConfig.desiredTargets}`,
      ...(scConfig.fightStyle ? [`fight_style=${scConfig.fightStyle}`] : []),
      ...(scConfig.routeFile ? readRouteFile(scConfig.routeFile) : []),
      ...(scConfig.overrides || []),
      `target_error=${fidelityConfig.target_error}`,
      `iterations=${fidelityConfig.iterations || SIM_DEFAULTS.iterations}`,
    ];
    if (DATA_ENV === "ptr" || DATA_ENV === "beta") simArgs.unshift("ptr=1");

    // Only compute DPS plot on ST (used by Phase 1b reweighting)
    if (scenario === "st") {
      simArgs.push(
        "dps_plot_stat=crit,haste,mastery,versatility",
        "dps_plot_points=21",
        `dps_plot_step=${DPS_PLOT_STEP}`,
      );
    }

    console.log(`  ${scConfig.name}...`);
    try {
      await execSimcWithFallback(simArgs, (a) =>
        execFileAsync(SIMC_BIN, a, {
          maxBuffer: 100 * 1024 * 1024,
          timeout: 1800000,
        }),
      );
    } catch (e) {
      if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
      throw new Error(`SimC scale factors failed (${scenario}): ${e.message}`);
    }

    const data = JSON.parse(readFileSync(outputPath, "utf-8"));
    perScenario[scenario] = data.sim.players[0].scale_factors;

    // Extract DPS plot from ST scenario
    if (scenario === "st") {
      // ... existing DPS plot extraction code (lines 438-474) ...
    }
  }

  // Combine per-scenario scale factors using SCENARIO_WEIGHTS
  const combined = {};
  for (const stat of statKeys) {
    combined[stat] = 0;
    for (const [scenario, weight] of Object.entries(SCENARIO_WEIGHTS)) {
      combined[stat] += (perScenario[scenario]?.[stat] || 0) * weight;
    }
  }

  setSessionState("gear_scale_factors", {
    ...combined,
    perScenario,
    timestamp: new Date().toISOString(),
  });

  console.log("Weighted scale factors:");
  for (const stat of statKeys) {
    console.log(`  ${stat}: ${combined[stat].toFixed(4)}`);
  }
}
```

Note: Import `readRouteFile` from `./runner.js` and `execSimcWithFallback` if not already imported.

**Step 2: Verify**

Run Phase 1 only:

```bash
SPEC=havoc node src/sim/gear.js scale-factors --quick
```

Expected: prints scale factors for each scenario, then weighted combined factors. Should complete in ~2 min with `--quick`.

**Step 3: Commit**

```
git add src/sim/gear.js
git commit -m "feat(gear): multi-scenario weighted scale factors"
```

---

### Task 4: Iterative EP Reweighting (Phase 1b)

After Phase 1 computes scale factors and DPS plot curves, add a Phase 1b that iteratively re-ranks items using interpolated EP weights from the stat curves. This breaks the self-reinforcing bias where scale factors computed at the current gear point lock the pipeline into a local stat optimum.

**Files:**

- Modify: `src/sim/gear.js` — new function `cmdEpReweight`, integrate into `cmdRun`

**Step 1: Implement EP reweighting loop**

Add after `cmdScaleFactors` (around line 482):

```js
// --- Phase 1b: Iterative EP Reweighting ---
// Uses DPS plot curves from Phase 1 to recompute scale factors at the
// stat point implied by EP-ranked gear, iterating until stable.

function cmdEpReweight(gearData) {
  const curves = getSessionState("gear_stat_curves");
  const sf = getSessionState("gear_scale_factors");
  if (!curves || !sf) {
    console.log(
      "Phase 1b: No stat curves or scale factors. Skipping reweight.",
    );
    return;
  }

  const statKeys = ["Crit", "Haste", "Mastery", "Vers"];
  const curveMap = buildCurveMap(curves);
  if (!curveMap) {
    console.log("Phase 1b: Could not parse stat curves. Skipping.");
    return;
  }

  let currentSf = { ...sf };
  let prevWinners = null;
  const MAX_ITERS = 5;

  console.log(
    `\nPhase 1b: Iterative EP Reweighting (max ${MAX_ITERS} iterations)`,
  );

  for (let iter = 1; iter <= MAX_ITERS; iter++) {
    // EP-rank all items with current scale factors
    const winners = epRankAll(gearData, currentSf);
    const winnerKey = JSON.stringify(winners);
    if (winnerKey === prevWinners) {
      console.log(`  Iteration ${iter}: converged (no item changes).`);
      break;
    }
    prevWinners = winnerKey;

    // Compute total stat budget of EP-selected gear
    const totalStats = computeGearStats(winners, gearData);
    console.log(
      `  Iteration ${iter}: ${statKeys.map((s) => `${s}=${totalStats[s.toLowerCase()] || 0}`).join(" ")}`,
    );

    // Interpolate DPS derivatives at the new stat point
    const newSf = { ...currentSf };
    for (const stat of statKeys) {
      const rating = totalStats[stat.toLowerCase()] || 0;
      const derivative = interpolateDerivative(
        curveMap,
        stat,
        rating,
        curves.baselineStats[stat.toLowerCase()] || 0,
        curves.step,
      );
      if (derivative != null) {
        newSf[stat] = derivative;
      }
    }

    currentSf = newSf;
  }

  // Store converged scale factors
  setSessionState("gear_scale_factors", {
    ...currentSf,
    reweighted: true,
    timestamp: new Date().toISOString(),
  });

  console.log("Reweighted scale factors:");
  for (const stat of ["Agi", ...statKeys]) {
    if (currentSf[stat] != null) {
      console.log(`  ${stat}: ${currentSf[stat].toFixed(4)}`);
    }
  }
}
```

**Step 2: Implement helper functions**

```js
// Build a lookup from stat name to sorted array of {rating, dps} points
function buildCurveMap(curves) {
  if (!curves.curves || curves.curves.length === 0) return null;
  const map = {};
  for (const entry of curves.curves) {
    for (const [stat, points] of Object.entries(entry)) {
      map[stat] = points
        .map((p) => ({ rating: p.rating, dps: p.dps }))
        .sort((a, b) => a.rating - b.rating);
    }
  }
  return map;
}

// Interpolate the DPS derivative (slope) at a given rating offset from baseline
function interpolateDerivative(
  curveMap,
  stat,
  targetRating,
  baselineRating,
  step,
) {
  const points = curveMap[stat];
  if (!points || points.length < 2) return null;

  // Stat curve ratings are offsets from baseline. Convert target to offset.
  const offset = targetRating - baselineRating;

  // Find the two bracketing points
  let lo = points[0],
    hi = points[points.length - 1];
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].rating <= offset && points[i + 1].rating >= offset) {
      lo = points[i];
      hi = points[i + 1];
      break;
    }
  }

  // Derivative = slope between adjacent points, normalized per rating point
  if (hi.rating === lo.rating) return null;
  return (hi.dps - lo.dps) / (hi.rating - lo.rating);
}

// EP-rank all slots and return map of slot -> winner item id
function epRankAll(gearData, sf) {
  const winners = {};
  const bestGemEp = (gearData.gems || [])
    .filter((g) => g.stats)
    .reduce((max, g) => Math.max(max, scoreEp(g.stats, sf)), 0);

  for (const [slot, slotData] of Object.entries(gearData.slots || {})) {
    if (ALWAYS_SIM_SLOTS.has(slot)) continue;
    const candidates = slotData.candidates || [];
    if (candidates.length === 0) continue;
    const best = candidates
      .map((c) => ({
        id: c.id,
        ep: scoreEp(c.stats, sf) + countSockets(c.simc) * bestGemEp,
      }))
      .sort((a, b) => b.ep - a.ep)[0];
    winners[slot] = best?.id;
  }
  return winners;
}

// Sum up stats from the EP-selected gear across all slots
function computeGearStats(winners, gearData) {
  const totals = { crit: 0, haste: 0, mastery: 0, vers: 0 };
  for (const [slot, winnerId] of Object.entries(winners)) {
    const slotData = gearData.slots?.[slot];
    if (!slotData) continue;
    const candidate = slotData.candidates?.find((c) => c.id === winnerId);
    if (!candidate?.stats) continue;
    for (const [stat, val] of Object.entries(candidate.stats)) {
      if (stat in totals) totals[stat] += val;
    }
  }
  return totals;
}
```

**Step 3: Wire into cmdRun**

In `cmdRun` (line 2493), after Phase 3 EP ranking, add Phase 1b:

```js
if (maxPhase >= 3) {
  console.log("\n========== PHASE 3: EP Ranking ==========\n");
  cmdEpRank(gearData);
  console.log("\n========== PHASE 1b: EP Reweighting ==========\n");
  cmdEpReweight(gearData);
  // Re-run EP ranking with reweighted scale factors
  console.log("\n========== PHASE 3 (reweighted): EP Ranking ==========\n");
  cmdEpRank(gearData);
}
```

**Step 4: Verify**

```bash
SPEC=havoc node src/sim/gear.js scale-factors --quick
SPEC=havoc node src/sim/gear.js ep-rank
```

Then manually call reweight:

```bash
SPEC=havoc node -e "..." # or add temporary CLI entry
```

Check that scale factors shift — crit/mastery should increase, haste/vers should decrease after reweighting if the Raidbots profile is the baseline.

**Step 5: Commit**

```
git add src/sim/gear.js
git commit -m "feat(gear): iterative EP reweighting using DPS plot curves (Phase 1b)"
```

---

### Task 5: Combinatorial Validation Phase (Phase 3b)

After EP ranking, take the top-2 candidates per slot and sim all combinations to find stat synergies EP misses.

**Files:**

- Modify: `src/sim/gear.js` — new `cmdCombinatorialValidation`, integrate into `cmdRun`

**Step 1: Implement combinatorial validation**

```js
// --- Phase 3b: Combinatorial Validation ---
// Sims the cross-product of top-N candidates per EP-ranked slot.
// Catches stat synergies that per-slot EP ranking misses.

async function cmdCombinatorialValidation(args) {
  const fidelity = parseFidelity(args, "quick");
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  // Collect top-2 per EP-ranked slot (excluding weapon/trinket/embellishment slots
  // which are handled by their own sim phases)
  const SIM_HANDLED_SLOTS = new Set([
    "main_hand",
    "off_hand",
    "trinket1",
    "trinket2",
  ]);
  const slotOptions = {};
  for (const slot of Object.keys(gearData.slots || {})) {
    if (SIM_HANDLED_SLOTS.has(slot)) continue;
    if (ALWAYS_SIM_SLOTS.has(slot)) continue;
    const results = getBestGear(3, slot);
    if (results.length < 2) continue;
    // Take top 2 distinct candidates
    const top = results
      .filter((r) => r.candidate_id !== "__baseline__")
      .slice(0, 2)
      .map((r) => r.candidate_id);
    if (top.length === 2) slotOptions[slot] = top;
  }

  const slots = Object.keys(slotOptions);
  if (slots.length === 0) {
    console.log("Phase 3b: No slots with 2+ EP candidates. Skipping.");
    return;
  }

  // Generate cross-product combinations
  const combos = [{}];
  for (const slot of slots) {
    const newCombos = [];
    for (const combo of combos) {
      for (const candidateId of slotOptions[slot]) {
        newCombos.push({ ...combo, [slot]: candidateId });
      }
    }
    combos.length = 0;
    combos.push(...newCombos);
  }

  console.log(
    `\nPhase 3b: Combinatorial Validation (${combos.length} combos across ${slots.length} slots, ${fidelity} fidelity)`,
  );

  // Build profileset variants — each combo overrides multiple slots
  const variants = combos.map((combo, i) => {
    const overrides = [];
    for (const [slot, candidateId] of Object.entries(combo)) {
      const candidate = gearData.slots[slot]?.candidates?.find(
        (c) => c.id === candidateId,
      );
      if (candidate) {
        overrides.push(applyStatAlloc(candidate.simc, slot));
      }
    }
    const name = `combo_${i}`;
    return { name, overrides };
  });

  // Add baseline (no overrides) for comparison
  variants.push({ name: "__baseline__", overrides: [] });

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelity,
    "gear_combo_validation",
  );

  // Aggregate and find best
  const aggregated = aggregateGearResults(
    results,
    variants.map((v) => ({ id: v.name })),
    builds,
  );

  const best = aggregated[0];
  console.log(
    `  Best combination: ${best.candidate_id} (weighted: ${best.weighted?.toFixed(0)})`,
  );

  // Store results — assembly uses Phase 3b winners over Phase 3 EP winners
  clearGearResults(3.5, "combinations");
  saveGearResults(3.5, "combinations", aggregated, fidelity);

  // If best is not baseline, decode which items won and store per-slot overrides
  if (best.candidate_id !== "__baseline__") {
    const comboIdx = parseInt(best.candidate_id.replace("combo_", ""));
    const winningCombo = combos[comboIdx];
    setSessionState("gear_phase3b_winners", {
      combo: winningCombo,
      weighted: best.weighted,
      timestamp: new Date().toISOString(),
    });
    console.log("  Winning slots:", JSON.stringify(winningCombo));
  }
}
```

**Step 2: Wire into cmdRun after Phase 3**

```js
if (maxPhase >= 3) {
  console.log("\n========== PHASE 3: EP Ranking ==========\n");
  cmdEpRank(gearData);
  console.log("\n========== PHASE 1b: EP Reweighting ==========\n");
  cmdEpReweight(gearData);
  console.log("\n========== PHASE 3 (reweighted): EP Ranking ==========\n");
  cmdEpRank(gearData);
  console.log("\n========== PHASE 3b: Combinatorial Validation ==========\n");
  await cmdCombinatorialValidation(fidelityArgs);
}
```

**Step 3: Update assembly to prefer Phase 3b winners**

In `buildGearLines` (line 2261), before falling back to Phase 3 EP results, check Phase 3b:

```js
// Phase 3b: combinatorial validation winners (if available)
const comboWinners = getSessionState("gear_phase3b_winners");
if (comboWinners?.combo) {
  for (const [slot, candidateId] of Object.entries(comboWinners.combo)) {
    if (coveredSlots.has(slot)) continue;
    const candidate = gearData.slots[slot]?.candidates?.find(
      (c) => c.id === candidateId,
    );
    if (!candidate || !canEquip(candidate)) continue;
    const line = applyStatAlloc(candidate.simc, slot);
    addLine(applySlotEnchant(line, slot, enchantMap), slot, candidate);
  }
}

// Phase 3: EP ranking winners for remaining individual slots
for (const slot of Object.keys(gearData.slots || {})) {
  // ...existing code...
}
```

**Step 4: Add CLI entry**

Add to the switch statement:

```js
  case "combo-validate":
    await cmdCombinatorialValidation(cleanArgs);
    break;
```

**Step 5: Verify**

```bash
SPEC=havoc node src/sim/gear.js combo-validate --quick
```

Expected: prints combination count, sims them, reports best. Should complete in <5min with --quick on remote.

**Step 6: Commit**

```
git add src/sim/gear.js
git commit -m "feat(gear): combinatorial validation phase (Phase 3b)"
```

---

### Task 6: Sim-Based Gem Optimization (Phase 9)

Replace EP-only gem ranking with sim-based evaluation that tests gem color diversity for Eversong Diamond bonus.

**Files:**

- Modify: `src/sim/gear.js:812-880` (cmdGems function)

**Step 1: Rewrite cmdGems to sim gem configurations**

```js
async function cmdGems(args, gearData) {
  const fidelity = parseFidelity(args, "quick");
  const gems = gearData.gems || [];
  if (gems.length === 0) {
    console.log("No gems configured.");
    return;
  }

  const sf = getSessionState("gear_scale_factors");
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  // Identify Midnight gem colors from gem IDs/labels
  // Group gems by color family for diversity optimization
  const gemsByColor = groupGemsByColor(gems);
  const uniqueColors = Object.keys(gemsByColor);

  // Generate candidate configurations:
  // 1. All-same: fill all sockets with the best gem of each color
  // 2. Max-diversity: one of each color + Eversong Diamond
  const configs = [];

  // Config: best unlimited gem per color (all-same)
  for (const [color, colorGems] of Object.entries(gemsByColor)) {
    if (!sf) break;
    const best = colorGems
      .filter((g) => !g.uniqueLimit || g.uniqueLimit === 0)
      .sort((a, b) => scoreEp(b.stats, sf) - scoreEp(a.stats, sf))[0];
    if (best) {
      configs.push({
        id: `all_${color}`,
        label: `All ${color}: ${best.label}`,
        gem: best,
        diverse: false,
      });
    }
  }

  // Config: max diversity with Eversong Diamond (crit effectiveness)
  const eversongDiamond = gems.find((g) =>
    g.label?.toLowerCase().includes("critical strike effectiveness"),
  );
  if (eversongDiamond && uniqueColors.length >= 3) {
    configs.push({
      id: "diverse_eversong",
      label: `Diverse + Eversong Diamond (${uniqueColors.length} colors)`,
      eversong: eversongDiamond,
      diverse: true,
      colors: uniqueColors,
    });
  }

  // EP-only fallback config
  if (sf) {
    const epBest = gems
      .filter((g) => g.stats && (!g.uniqueLimit || g.uniqueLimit === 0))
      .sort((a, b) => scoreEp(b.stats, sf) - scoreEp(a.stats, sf))[0];
    if (epBest) {
      configs.push({
        id: "ep_best",
        label: `EP best: ${epBest.label}`,
        gem: epBest,
        diverse: false,
      });
    }
  }

  if (configs.length <= 1) {
    // Fall back to EP-only (original behavior)
    cmdGemsEpOnly(gearData, sf);
    return;
  }

  console.log(
    `\nPhase 9: Gems — simming ${configs.length} configurations (${fidelity} fidelity)`,
  );

  // Build overrides for each config by replacing all gem_ids in gear lines
  const gearLines = buildGearLines(gearData);
  const socketSlots = gearLines.filter((l) => l.includes("gem_id="));

  const variants = configs.map((cfg) => ({
    name: cfg.id,
    overrides: buildGemOverrides(cfg, socketSlots, gems, gemsByColor),
  }));

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelity,
    "gear_gems",
  );

  const aggregated = aggregateGearResults(
    results,
    configs.map((c) => ({ id: c.id, label: c.label })),
    builds,
  );

  const best = aggregated[0];
  console.log(`  Best gem config: ${best.candidate_id}`);

  // Store result
  const winningConfig = configs.find((c) => c.id === best.candidate_id);
  setSessionState("gear_gems", {
    config: best.candidate_id,
    label: winningConfig?.label,
    diverse: winningConfig?.diverse || false,
    timestamp: new Date().toISOString(),
  });
}
```

**Step 2: Implement gem helpers**

```js
// Group gems by their Midnight color family
function groupGemsByColor(gems) {
  const groups = {};
  for (const g of gems) {
    // Determine color from stat composition or label
    // Midnight gems: Lapis (vers), Garnet (haste), Amethyst (mastery), Peridot (crit)
    let color = "unknown";
    if (g.stats?.vers && Object.keys(g.stats).length === 1) color = "lapis";
    else if (g.stats?.haste && Object.keys(g.stats).length === 1)
      color = "garnet";
    else if (g.stats?.mastery && Object.keys(g.stats).length === 1)
      color = "amethyst";
    else if (g.stats?.crit && Object.keys(g.stats).length === 1)
      color = "peridot";
    else if (g.stats?.vers) color = "lapis";
    else if (g.stats?.haste) color = "garnet";
    else if (g.stats?.mastery) color = "amethyst";
    else if (g.stats?.crit) color = "peridot";
    else if (g.stats?.agi) color = "diamond";
    if (!g.uniqueLimit || g.uniqueLimit === 0) {
      (groups[color] ||= []).push(g);
    }
  }
  return groups;
}

// Build SimC overrides that replace gem_ids in gear lines for a given config
function buildGemOverrides(config, socketSlots, allGems, gemsByColor) {
  // For diverse config: assign best gem of each color to successive sockets,
  // with Eversong Diamond in the first socket
  // For all-same config: replace all gem_ids with the single gem
  const overrides = [];

  if (config.diverse) {
    // Pick best unlimited gem per color
    const colorGems = {};
    for (const [color, cGems] of Object.entries(gemsByColor)) {
      if (color === "diamond") continue;
      const best = cGems.sort(
        (a, b) =>
          Math.max(...Object.values(b.stats || {})) -
          Math.max(...Object.values(a.stats || {})),
      )[0];
      if (best) colorGems[color] = best;
    }
    // Eversong Diamond goes in first socket, then one of each color, fill rest with best EP
    // This is a placeholder — actual override generation needs to replace gem_id= in simc lines
    // Implementation detail: build modified gear lines with specific gem_ids per socket
  }

  // For now, return gear line overrides with modified gem_ids
  // Actual implementation will iterate socketSlots and replace gem_id values
  return overrides;
}
```

Note: The gem override generation is complex because it needs to modify specific `gem_id=` values in gear lines. The implementer should study how the existing gem application works in `buildGearLines` (around line 2277) and adapt the override approach to use profileset overrides that replace individual slot gem_ids.

**Step 3: Update cmdGems signature in cmdRun**

Change `cmdGems(gearData)` call in `cmdRun` to `await cmdGems(fidelityArgs, gearData)` since it's now async.

**Step 4: Verify**

```bash
SPEC=havoc node src/sim/gear.js gems --quick
```

Expected: prints gem configurations tested, sim results, best config.

**Step 5: Commit**

```
git add src/sim/gear.js
git commit -m "feat(gear): sim-based gem optimization with diversity support (Phase 9)"
```

---

### Task 7: Multi-Build Scale Factors

Use top 3 builds instead of just roster[0] for scale factor computation and gear evaluation.

**Files:**

- Modify: `src/sim/gear.js:234-243` (getRepresentativeBuilds function)

**Step 1: Expand getRepresentativeBuilds**

```js
function getRepresentativeBuilds() {
  const roster = getRosterBuilds();
  if (roster.length === 0) {
    console.error("No roster builds found. Run: npm run roster generate");
    process.exit(1);
  }

  // Pick top builds covering both hero trees (if applicable)
  const seen = new Set();
  const picks = [];
  for (const build of roster) {
    if (picks.length >= 3) break;
    const tree = build.hero_tree || build.heroTree;
    // Always include the #1 build
    if (picks.length === 0) {
      picks.push(build);
      seen.add(tree);
      continue;
    }
    // Prioritize unseen hero trees, then highest weighted
    if (!seen.has(tree)) {
      picks.push(build);
      seen.add(tree);
    } else if (picks.length < 3) {
      picks.push(build);
    }
  }

  return picks;
}
```

**Step 2: Verify**

Phase 1 and Phase 4 sims should now run with 3 builds. Check that sim output shows 3 talent hashes.

```bash
SPEC=havoc node src/sim/gear.js scale-factors --quick
```

Expected: completes with 3x the sim time but produces averaged scale factors across builds.

Note: `cmdScaleFactors` currently only sims one profile. With multi-build, it needs to run scale factors per build and average them, OR use the representative build approach only for Phases 4+ (where profilesets already handle multiple builds). The implementer should decide: for Phase 1, it's simplest to keep single-build scale factors but pick the most representative build (highest weighted). Multi-build averaging is a future enhancement.

**Step 3: Commit**

```
git add src/sim/gear.js
git commit -m "feat(gear): multi-build representative builds for gear evaluation"
```

---

### Task 8: End-to-End Validation

Run the full pipeline with all fixes and compare against the Raidbots reference.

**Files:**

- No new code — this is a validation run

**Step 1: Clear gear pipeline state**

```bash
SPEC=havoc node -e "
import { initSpec } from './src/engine/startup.js';
import { getDb } from './src/util/db.js';
await initSpec('havoc');
const db = getDb();
db.prepare(\"DELETE FROM gear_results WHERE spec = 'havoc'\").run();
db.prepare(\"DELETE FROM session_state WHERE key LIKE 'gear_%'\").run();
console.log('Gear state cleared.');
"
```

**Step 2: Fetch fresh candidates**

```bash
SPEC=havoc npm run gear:fetch-candidates
```

Verify back slot and enchant categories are present.

**Step 3: Start remote and run full pipeline**

```bash
npm run remote:start
SPEC=havoc npm run gear:run
```

**Step 4: Compare assembled profile stats**

The assembled profile should have a stat distribution closer to the Raidbots reference:

- Crit: ~1200+ (was 780)
- Mastery: ~800+ (was 634)
- Versatility: <200 (was 574)
- Haste: ~300 (was 431)

**Step 5: Run report and verify DPS**

```bash
SPEC=havoc npm run report:dashboard
```

Top FS build should be ~100k+ ST DPS. If still below 98k, the pipeline needs further tuning.

**Step 6: Publish and commit**

```bash
SPEC=havoc npm run report:publish
npm run remote:stop
git add data/havoc/ apls/havoc/profile.simc src/sim/gear.js
git commit -m "feat(gear): pipeline overhaul — iterative EP, combinatorial validation, gem diversity"
```
