// Gear optimization pipeline — tiered elimination across scenarios and builds.
// Screens gear candidates per-slot, tests combinations, optimizes stat allocations,
// and validates final selections at high fidelity.
//
// Usage:
//   SPEC=vengeance node src/sim/gear.js tier-config [--fidelity quick]
//   SPEC=vengeance node src/sim/gear.js screen [--slot X] [--fidelity quick]
//   SPEC=vengeance node src/sim/gear.js combinations [--type trinkets|rings|embellishments]
//   SPEC=vengeance node src/sim/gear.js stat-optimize
//   SPEC=vengeance node src/sim/gear.js validate [--fidelity confirm]
//   SPEC=vengeance node src/sim/gear.js run [--through phase0|phase1|phase2|phase3|phase4]
//   SPEC=vengeance node src/sim/gear.js status
//   SPEC=vengeance node src/sim/gear.js results [--slot X]
//   SPEC=vengeance node src/sim/gear.js export

import { cpus } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  initSpec,
  SCENARIOS,
  SCENARIO_WEIGHTS,
  FIDELITY_TIERS,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { dataFile, aplsDir, ROOT, getSpecName } from "../engine/paths.js";
import { generateProfileset, runProfilesetAsync } from "./profilesets.js";
import {
  getDb,
  closeAll,
  getRosterBuilds,
  getSessionState,
  setSessionState,
  withTransaction,
} from "../util/db.js";

// --- Concurrency helpers ---

const MIN_THREADS_PER_SIM = 4;

function simConcurrency(simCount) {
  const totalCores = cpus().length;
  const maxConcurrency = Math.max(
    1,
    Math.floor(totalCores / MIN_THREADS_PER_SIM),
  );
  const concurrency = Math.min(maxConcurrency, simCount);
  const threadsPerSim = Math.max(1, Math.floor(totalCores / concurrency));
  return { concurrency, threadsPerSim };
}

async function runWithConcurrency(taskFactories, maxConcurrency) {
  const results = new Array(taskFactories.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < taskFactories.length) {
      const i = nextIndex++;
      results[i] = await taskFactories[i]();
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(maxConcurrency, taskFactories.length); w++) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}

// --- Shared sim execution: run variants across builds x scenarios ---

async function runBuildScenarioSims(
  variants,
  builds,
  baseProfile,
  fidelityTier,
  label,
) {
  const tierConfig = FIDELITY_TIERS[fidelityTier] || FIDELITY_TIERS.quick;
  const scenarioKeys = Object.keys(SCENARIOS);

  const tasks = [];
  for (const build of builds) {
    for (const scenario of scenarioKeys) {
      tasks.push({ build, scenario });
    }
  }

  const { concurrency, threadsPerSim } = simConcurrency(tasks.length);
  const simOverrides = { ...tierConfig, threads: threadsPerSim };

  const taskFactories = tasks.map(({ build, scenario }) => async () => {
    const buildVariants = variants.map((v) => ({
      name: `${build.hash.slice(0, 8)}_${v.name}`,
      overrides: [`talents=${build.hash}`, ...v.overrides],
    }));

    const content = generateProfileset(baseProfile, buildVariants);
    const simLabel = `${label}_${build.hash.slice(0, 8)}`;

    const result = await runProfilesetAsync(content, scenario, simLabel, {
      simOverrides,
    });
    return { build, scenario, result };
  });

  return runWithConcurrency(taskFactories, concurrency);
}

// --- Gear candidates loading ---

function loadGearCandidates() {
  const path = dataFile("gear-candidates.json");
  if (!existsSync(path)) {
    console.error(`Gear candidates not found: ${path}`);
    console.error("Create data/{spec}/gear-candidates.json first.");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (data.version !== 2) {
    console.error(
      `gear-candidates.json version ${data.version || 1} is not supported. Upgrade to version 2.`,
    );
    process.exit(1);
  }
  return data;
}

// --- v2 helpers: build screenable slot lists ---

// For paired slots, screen slot 0 only with slot 1 cleared so scores
// are comparable to pair scores (which also have both slots defined).
function pairedSlotScreenCandidates(pairedData) {
  const [slot0, slot1] = pairedData.slots;
  return pairedData.candidates.map((c) => ({
    id: c.id,
    label: c.label,
    overrides: [`${slot0}=${c.simc_base}`, `${slot1}=`],
    tags: c.tags,
  }));
}

// For enchant slots, build full simc lines from base_item + enchant_id
function enchantSlotScreenCandidates(enchantData) {
  return enchantData.candidates.map((c) => ({
    id: c.id,
    label: c.label,
    simc: `${enchantData.base_item},enchant_id=${c.enchant_id}`,
    tags: c.tags,
  }));
}

// Combination types from paired_slots + embellishments
function getComboTypes(gearData) {
  const types = [...Object.keys(gearData.paired_slots || {})];
  if (gearData.embellishments?.pairs?.length > 0) types.push("embellishments");
  return types;
}

// Collect all screenable slots from v2 format
function getScreenableSlots(gearData) {
  const slots = { ...gearData.slots };

  for (const [name, data] of Object.entries(gearData.paired_slots || {})) {
    slots[name] = { candidates: pairedSlotScreenCandidates(data) };
  }

  for (const [name, data] of Object.entries(gearData.enchants || {})) {
    slots[name] = { candidates: enchantSlotScreenCandidates(data) };
  }

  return slots;
}

// --- Representative builds ---

function getRepresentativeBuilds() {
  const roster = getRosterBuilds();
  if (roster.length === 0) {
    console.error("No roster builds found. Run: npm run roster generate");
    process.exit(1);
  }

  // Use the single best build (roster is sorted by weighted DESC)
  return [roster[0]];
}

// --- Profile path resolution ---

function getBaseProfile(gearData) {
  const profilePath = resolve(ROOT, gearData.baseline);
  if (!existsSync(profilePath)) {
    console.error(`Baseline profile not found: ${profilePath}`);
    process.exit(1);
  }
  return profilePath;
}

// Reconstruct SimC override lines for a combination candidate ID.
function resolveComboOverrides(candidateId, gearData) {
  // Check explicit embellishment pairs
  const embPairs = gearData.embellishments?.pairs || [];
  const embMatch = embPairs.find((p) => p.id === candidateId);
  if (embMatch) return embMatch.overrides;

  // Auto-generated C(K,2) pairs from paired slots: "id1--id2"
  if (candidateId.includes("--")) {
    const [id1, id2] = candidateId.split("--");

    // Search all paired slot pools
    for (const [, pairedData] of Object.entries(gearData.paired_slots || {})) {
      const c1 = pairedData.candidates.find((c) => c.id === id1);
      const c2 = pairedData.candidates.find((c) => c.id === id2);
      if (c1 && c2) {
        return [
          `${pairedData.slots[0]}=${c1.simc_base}`,
          `${pairedData.slots[1]}=${c2.simc_base}`,
        ];
      }
    }
  }

  return [];
}

// --- APL warning check ---

function checkAplWarnings(candidates, slot) {
  if (!slot.startsWith("trinket") && slot !== "trinkets") return;
  const aplPath = resolve(aplsDir(), `${getSpecName()}.simc`);
  if (!existsSync(aplPath)) return;
  const aplContent = readFileSync(aplPath, "utf-8");

  for (const c of candidates) {
    if (!c.tags?.includes("on-use")) continue;
    const simcLine = c.overrides?.[0] ?? c.simc;
    const simcName = simcLine?.split("=")[1]?.split(",")[0];
    if (!simcName) continue;
    if (
      !aplContent.includes(simcName) &&
      !aplContent.includes("use_item,slot=")
    ) {
      console.log(
        `WARNING: trinket "${c.id}" has no use_item condition in the APL.`,
      );
      console.log(
        "         On-use effect fires on CD without APL optimization. Add a condition before Phase 4.\n",
      );
    }
  }
}

// --- Core: run a slot screen across all scenarios ---

async function screenSlot(slot, candidates, gearData, fidelityTier, builds) {
  const baseProfile = getBaseProfile(gearData);

  checkAplWarnings(candidates, slot);

  const variants = candidates.map((c) => ({
    name: c.id,
    overrides: c.overrides ?? [c.simc],
  }));

  if (variants.length === 0) {
    console.log(`No candidates for slot: ${slot}`);
    return [];
  }

  const scenarioCount = Object.keys(SCENARIOS).length;
  console.log(
    `Running ${candidates.length * builds.length * scenarioCount} sims (${candidates.length} candidates x ${builds.length} builds x ${scenarioCount} scenarios)...`,
  );

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelityTier,
    `gear_${slot}`,
  );
  return aggregateGearResults(results, candidates, builds);
}

// --- Aggregate results across scenarios and builds ---

function aggregateGearResults(results, candidates, builds) {
  const byCandidate = new Map();

  function getOrCreate(id) {
    if (!byCandidate.has(id)) {
      byCandidate.set(id, { scenarioDps: {}, buildDps: {} });
    }
    return byCandidate.get(id);
  }

  function record(entry, buildKey, scenario, dps) {
    if (!entry.buildDps[buildKey]) entry.buildDps[buildKey] = {};
    entry.buildDps[buildKey][scenario] = dps;
    if (!entry.scenarioDps[scenario]) entry.scenarioDps[scenario] = [];
    entry.scenarioDps[scenario].push(dps);
  }

  for (const { build, scenario, result } of results) {
    const buildKey = build.hash.slice(0, 8);

    for (const variant of result.variants) {
      const underscoreIdx = variant.name.indexOf("_");
      const candidateId =
        underscoreIdx >= 0
          ? variant.name.slice(underscoreIdx + 1)
          : variant.name;
      record(getOrCreate(candidateId), buildKey, scenario, variant.dps);
    }

    record(
      getOrCreate("__baseline__"),
      buildKey,
      scenario,
      result.baseline.dps,
    );
  }

  const candidateMap = new Map(candidates.map((c) => [c.id, c]));
  const ranked = [];

  for (const [candidateId, data] of byCandidate) {
    const avgScenarioDps = {};
    for (const [scenario, dpsValues] of Object.entries(data.scenarioDps)) {
      avgScenarioDps[scenario] =
        dpsValues.reduce((a, b) => a + b, 0) / dpsValues.length;
    }

    let weighted = 0;
    for (const [scenario, weight] of Object.entries(SCENARIO_WEIGHTS)) {
      weighted += (avgScenarioDps[scenario] || 0) * weight;
    }

    const candidate = candidateMap.get(candidateId);
    ranked.push({
      id: candidateId,
      label:
        candidateId === "__baseline__"
          ? "Baseline (current profile)"
          : candidate?.label || candidateId,
      dps_st: avgScenarioDps.st || 0,
      dps_dungeon_route: avgScenarioDps.dungeon_route || 0,
      dps_small_aoe: avgScenarioDps.small_aoe || 0,
      dps_big_aoe: avgScenarioDps.big_aoe || 0,
      weighted,
      buildDps: data.buildDps,
    });
  }

  ranked.sort((a, b) => b.weighted - a.weighted);
  return ranked;
}

// --- Pruning ---

function pruneResults(ranked, threshold = 0.5, minAdvancing = 1) {
  if (ranked.length === 0) return { advancing: [], pruned: [] };

  const best = ranked[0].weighted;
  const advancing = [];
  const pruned = [];

  for (const r of ranked) {
    if (r.id === "__baseline__") {
      advancing.push(r);
      continue;
    }
    const deltaPct = ((r.weighted - best) / best) * 100;
    r.delta_pct_weighted = deltaPct;

    // Count non-baseline advancing candidates
    const nonBaselineAdvancing = advancing.filter(
      (a) => a.id !== "__baseline__",
    ).length;

    if (deltaPct >= -threshold || nonBaselineAdvancing < minAdvancing) {
      advancing.push(r);
    } else {
      r.eliminated = true;
      pruned.push(r);
    }
  }

  return { advancing, pruned };
}

// --- DB persistence ---

function saveGearResults(phase, slot, results, fidelity, combinationType) {
  const db = getDb();
  const spec = getSpecName();
  const stmt = db.prepare(`
    INSERT INTO gear_results (spec, phase, slot, combination_type, candidate_id, label, dps_st, dps_dungeon_route, dps_small_aoe, dps_big_aoe, weighted, delta_pct_weighted, fidelity, eliminated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  withTransaction(() => {
    for (const r of results) {
      stmt.run(
        spec,
        phase,
        slot || null,
        combinationType || null,
        r.id,
        r.label,
        r.dps_st,
        r.dps_dungeon_route,
        r.dps_small_aoe,
        r.dps_big_aoe,
        r.weighted,
        r.delta_pct_weighted || 0,
        fidelity,
        r.eliminated ? 1 : 0,
      );
    }
  });
}

function getGearResults(phase, slot) {
  const db = getDb();
  const spec = getSpecName();
  let sql = "SELECT * FROM gear_results WHERE spec = ? AND phase = ?";
  const params = [spec, phase];
  if (slot) {
    sql += " AND slot = ?";
    params.push(slot);
  }
  sql += " ORDER BY weighted DESC";
  return db.prepare(sql).all(...params);
}

function getBestGear(phase) {
  const db = getDb();
  const spec = getSpecName();
  return db
    .prepare(
      "SELECT * FROM gear_results WHERE spec = ? AND phase = ? AND eliminated = 0 ORDER BY weighted DESC",
    )
    .all(spec, phase);
}

function clearGearResults(phase, slot) {
  const db = getDb();
  const spec = getSpecName();
  let sql = "DELETE FROM gear_results WHERE spec = ? AND phase = ?";
  const params = [spec, phase];
  if (slot) {
    sql += " AND slot = ?";
    params.push(slot);
  }
  db.prepare(sql).run(...params);
}

// --- Output formatting ---

function printSlotResults(slot, ranked, gearData) {
  const best = ranked[0];
  console.log(`\n=== Gear Screen: ${slot} ===`);
  console.log(
    `Best: ${best.label} — ${Math.round(best.weighted).toLocaleString()} DPS (weighted)\n`,
  );

  console.log(
    `${"Rank".padStart(4)}  ${"Candidate".padEnd(45)} ${"Weighted".padStart(10)}  ${"Delta".padStart(8)}  Status`,
  );
  console.log("-".repeat(85));

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const delta =
      i === 0
        ? "baseline"
        : `${(((r.weighted - best.weighted) / best.weighted) * 100).toFixed(2)}%`;
    const status = r.eliminated ? "[PRUNED]" : "";
    const flag = gearData.flagged?.[r.id] ? " *" : "";

    console.log(
      `${String(i + 1).padStart(4)}  ${(r.label + flag).padEnd(45)} ${Math.round(r.weighted).toLocaleString().padStart(10)}  ${delta.padStart(8)}  ${status}`,
    );
  }

  for (const r of ranked) {
    if (gearData.flagged?.[r.id]) {
      console.log(`\n  * ${r.label}: ${gearData.flagged[r.id]}`);
    }
  }
}

// --- CLI: tier-config (Phase 0) ---

async function cmdTierConfig(args) {
  const { values } = parseArgs({
    args,
    options: {
      fidelity: { type: "string", default: "quick" },
    },
    strict: false,
  });

  const fidelity = values.fidelity;
  const gearData = loadGearCandidates();
  const tier = gearData.tier;

  if (!tier) {
    console.log("No tier configuration in gear-candidates.json.");
    return;
  }

  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);
  const tierSlots = Object.keys(tier.items);

  console.log(
    `Representative builds: ${builds.map((b) => `${b.displayName || b.name || b.hash.slice(0, 12)} (${b.heroTree})`).join(", ")}`,
  );
  console.log(
    `\nPhase 0: Tier Configuration (set ${tier.set_id}, ${tier.required_count}pc required)`,
  );
  console.log(
    `Testing which tier slot to skip (${tierSlots.length} tier slots, alternatives per slot)...\n`,
  );

  // Baseline: all 5 tier pieces
  const allTierOverrides = tierSlots.map((s) => tier.items[s]);

  const variants = [{ name: "all_tier_5pc", overrides: allTierOverrides }];

  // For each tier slot, swap it for each alternative
  for (const slot of tierSlots) {
    const alts = tier.alternatives[slot] || [];
    for (const alt of alts) {
      const overrides = tierSlots
        .filter((s) => s !== slot)
        .map((s) => tier.items[s]);
      overrides.push(alt.simc);
      variants.push({
        name: `skip_${slot}_${alt.id}`,
        overrides,
      });
    }
  }

  const scenarioCount = Object.keys(SCENARIOS).length;
  console.log(
    `Running ${variants.length * builds.length * scenarioCount} sims (${variants.length} variants x ${builds.length} builds x ${scenarioCount} scenarios)...`,
  );

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelity,
    "gear_tier",
  );

  const candidates = variants.map((v) => ({
    id: v.name,
    label: v.name.replace(/_/g, " "),
  }));
  const ranked = aggregateGearResults(results, candidates, builds);

  printSlotResults("tier_config", ranked, gearData);

  clearGearResults(0);
  saveGearResults(0, "tier_config", ranked, fidelity);

  // Determine the best config
  const bestNonBaseline = ranked.find((r) => r.id !== "__baseline__");
  const bestConfig = bestNonBaseline?.id || "all_tier_5pc";

  setSessionState("gear_phase0", {
    best: bestConfig,
    fidelity,
    timestamp: new Date().toISOString(),
  });

  console.log(`\nBest tier config: ${bestConfig}`);
  if (bestConfig === "all_tier_5pc") {
    console.log("Recommendation: Use all 5 tier pieces (no skip needed).");
  } else {
    console.log(
      `Recommendation: Skip tier in the indicated slot, use the alternative.`,
    );
  }
}

// --- CLI: screen (Phase 1) ---

async function cmdScreen(args) {
  const { values } = parseArgs({
    args,
    options: {
      slot: { type: "string" },
      fidelity: { type: "string", default: "quick" },
    },
    strict: false,
  });

  const fidelity = values.fidelity;
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();

  console.log(
    `Representative builds: ${builds.map((b) => `${b.displayName || b.name || b.hash.slice(0, 12)} (${b.heroTree})`).join(", ")}`,
  );

  const screenable = getScreenableSlots(gearData);
  const slotsToScreen = values.slot ? [values.slot] : Object.keys(screenable);

  for (const slot of slotsToScreen) {
    const slotData = screenable[slot];
    if (!slotData) {
      console.error(`Unknown slot: ${slot}`);
      continue;
    }
    if (slotData.candidates.length <= 1) {
      console.log(`Slot ${slot}: only 1 candidate, skipping.`);
      continue;
    }

    console.log(
      `\nScreening slot: ${slot} (${slotData.candidates.length} candidates, ${fidelity} fidelity)`,
    );

    const ranked = await screenSlot(
      slot,
      slotData.candidates,
      gearData,
      fidelity,
      builds,
    );
    // Paired slots: advance topK candidates for C(K,2) pair generation.
    // Screening can't capture pairing synergies (gem diversity, set bonuses),
    // so we advance more candidates and let Phase 2 sort it out.
    const pairedData = gearData.paired_slots?.[slot];
    const minAdvancing = pairedData ? pairedData.topK || 4 : 1;
    const { advancing, pruned } = pruneResults(ranked, 0.5, minAdvancing);

    printSlotResults(slot, ranked, gearData);

    clearGearResults(1, slot);
    saveGearResults(1, slot, ranked, fidelity);

    console.log(
      `\nAdvancing ${advancing.length} candidates to Phase 2 (within 0.5% of best${pairedData ? `, min ${minAdvancing} for pairing` : ""})`,
    );
    if (pruned.length > 0) {
      console.log(`Eliminated ${pruned.length} candidates.`);
    }

    setSessionState(`gear_phase1_${slot}`, {
      advancing: advancing.map((r) => r.id),
      pruned: pruned.map((r) => r.id),
      fidelity,
      timestamp: new Date().toISOString(),
    });
  }
}

// --- CLI: combinations (Phase 2) ---

async function cmdCombinations(args) {
  const { values } = parseArgs({
    args,
    options: {
      type: { type: "string" },
      fidelity: { type: "string", default: "standard" },
    },
    strict: false,
  });

  const fidelity = values.fidelity;
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  const types = values.type ? [values.type] : getComboTypes(gearData);

  for (const type of types) {
    let pairs;

    if (gearData.paired_slots?.[type]) {
      // Generate C(K,2) pairs from Phase 1 top-K results
      pairs = generatePairedSlotCombinations(type, gearData);
      if (pairs.length === 0) {
        console.log(
          `No valid pairs for ${type}. Run Phase 1 first (screen --slot ${type}).`,
        );
        continue;
      }
      console.log(`Generated ${pairs.length} ${type} pairs from Phase 1 top-K`);
    } else if (type === "embellishments") {
      pairs = gearData.embellishments.pairs;
    } else {
      console.error(`Unknown combination type: ${type}`);
      continue;
    }

    const variants = pairs.map((p) => ({
      name: p.id,
      overrides: p.overrides,
    }));

    const scenarioCount = Object.keys(SCENARIOS).length;
    console.log(
      `\nRunning ${type} combinations: ${pairs.length} pairs x ${builds.length} builds x ${scenarioCount} scenarios (${fidelity} fidelity)`,
    );

    const results = await runBuildScenarioSims(
      variants,
      builds,
      baseProfile,
      fidelity,
      `gear_combo_${type}`,
    );
    const ranked = aggregateGearResults(
      results,
      pairs.map((p) => ({ id: p.id, label: p.label })),
      builds,
    );
    const { advancing, pruned } = pruneResults(ranked, 1.0);

    printSlotResults(type, ranked, gearData);

    clearGearResults(2, type);
    saveGearResults(2, type, ranked, fidelity, type);

    setSessionState(`gear_phase2_${type}`, {
      advancing: advancing.map((r) => r.id),
      pruned: pruned.map((r) => r.id),
      fidelity,
      timestamp: new Date().toISOString(),
    });
  }
}

// Generate C(K,2) pairs from a single paired slot pool using Phase 1 results
function generatePairedSlotCombinations(poolName, gearData) {
  const pairedData = gearData.paired_slots[poolName];
  if (!pairedData) return [];

  const topK = pairedData.topK || 5;

  // Phase 1 screened this pool under the poolName key (e.g., "trinkets")
  const phase1Results = getGearResults(1, poolName).filter(
    (r) => !r.eliminated && r.candidate_id !== "__baseline__",
  );

  const topCandidates = phase1Results.slice(0, topK);
  if (topCandidates.length < 2) {
    console.log(
      `Only ${topCandidates.length} advancing candidates for ${poolName} — need at least 2 for pairs.`,
    );
    return [];
  }

  const candidateMap = new Map(pairedData.candidates.map((c) => [c.id, c]));

  // C(K,2) combinations
  const pairs = [];
  for (let i = 0; i < topCandidates.length; i++) {
    for (let j = i + 1; j < topCandidates.length; j++) {
      const a = topCandidates[i];
      const b = topCandidates[j];
      const cA = candidateMap.get(a.candidate_id);
      const cB = candidateMap.get(b.candidate_id);
      if (!cA || !cB) continue;

      // Check unique-equipped constraints (skip if both are unique-equipped)
      const aUnique = gearData.flagged?.[cA.id]?.includes("Unique-Equipped");
      const bUnique = gearData.flagged?.[cB.id]?.includes("Unique-Equipped");
      if (aUnique && bUnique) continue;

      pairs.push({
        id: `${a.candidate_id}--${b.candidate_id}`,
        label: `${cA.label} + ${cB.label}`,
        overrides: [
          `${pairedData.slots[0]}=${cA.simc_base}`,
          `${pairedData.slots[1]}=${cB.simc_base}`,
        ],
      });
    }
  }
  return pairs;
}

// --- CLI: stat-optimize (Phase 3) ---

async function cmdStatOptimize(args) {
  const { values } = parseArgs({
    args,
    options: {
      fidelity: { type: "string", default: "standard" },
    },
    strict: false,
  });

  const fidelity = values.fidelity;
  const gearData = loadGearCandidates();
  const statAlloc = gearData.stat_allocations;

  if (!statAlloc || !statAlloc.crafted_slots || !statAlloc.pairs) {
    console.log("No stat allocation data in gear-candidates.json.");
    return;
  }

  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  for (const craftedSlot of statAlloc.crafted_slots) {
    const slotData = gearData.slots[craftedSlot];
    if (!slotData || slotData.candidates.length === 0) {
      console.log(`No candidates for crafted slot: ${craftedSlot}, skipping.`);
      continue;
    }

    // Find the first candidate with crafted_stats
    const baseCandidate = slotData.candidates.find((c) =>
      c.simc.includes("crafted_stats="),
    );
    if (!baseCandidate) {
      console.log(
        `Slot ${craftedSlot} has no crafted_stats candidate, skipping.`,
      );
      continue;
    }

    console.log(
      `\nStat optimization: ${craftedSlot} (${statAlloc.pairs.length} stat pairs, ${fidelity} fidelity)`,
    );

    const variants = statAlloc.pairs.map((pair) => {
      const modifiedSimc = baseCandidate.simc.replace(
        /crafted_stats=\d+\/\d+/,
        `crafted_stats=${pair.crafted_stats}`,
      );
      return {
        name: `${craftedSlot}_${pair.id}`,
        overrides: [modifiedSimc],
      };
    });

    const results = await runBuildScenarioSims(
      variants,
      builds,
      baseProfile,
      fidelity,
      `gear_stat_${craftedSlot}`,
    );
    const candidates = statAlloc.pairs.map((p) => ({
      id: `${craftedSlot}_${p.id}`,
      label: `${craftedSlot}: ${p.label}`,
    }));
    const ranked = aggregateGearResults(results, candidates, builds);

    printSlotResults(`${craftedSlot} stat alloc`, ranked, gearData);

    clearGearResults(3, craftedSlot);
    saveGearResults(3, craftedSlot, ranked, fidelity);

    setSessionState(`gear_phase3_${craftedSlot}`, {
      best: ranked[0]?.id,
      fidelity,
      timestamp: new Date().toISOString(),
    });
  }
}

// --- CLI: validate (Phase 4) ---

async function cmdValidate(args) {
  const { values } = parseArgs({
    args,
    options: {
      fidelity: { type: "string", default: "confirm" },
    },
    strict: false,
  });

  const fidelity = values.fidelity;
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const tierConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.confirm;
  const baseProfile = getBaseProfile(gearData);

  const bestGear = getBestGear(2);
  if (bestGear.length === 0) {
    console.log("No Phase 2 results found. Run phases 1-2 first.");
    return;
  }

  const bestCombo = bestGear[0];
  console.log(`\nValidating best gear combination: ${bestCombo.label}`);
  console.log(
    `Fidelity: ${fidelity} (target_error=${tierConfig.target_error})`,
  );

  const overrides = resolveComboOverrides(bestCombo.candidate_id, gearData);

  if (overrides.length === 0) {
    console.error(
      `Could not reconstruct overrides for: ${bestCombo.candidate_id}`,
    );
    return;
  }

  const variants = [{ name: "best_gear", overrides }];
  const scenarioCount = Object.keys(SCENARIOS).length;
  console.log(
    `\nRunning validation: ${builds.length} builds x ${scenarioCount} scenarios (${fidelity} fidelity)`,
  );

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelity,
    "gear_validate",
  );
  const ranked = aggregateGearResults(
    results,
    [{ id: "best_gear", label: bestCombo.label }],
    builds,
  );

  printSlotResults("validation", ranked, gearData);

  clearGearResults(4);
  saveGearResults(4, null, ranked, fidelity);

  // Check for build divergence
  const bestEntry = ranked.find((r) => r.id === "best_gear");
  if (bestEntry?.buildDps) {
    const buildKeys = Object.keys(bestEntry.buildDps);
    if (buildKeys.length >= 2) {
      console.log("\n--- Build Divergence Check ---");
      for (const bk of buildKeys) {
        const buildScenarios = bestEntry.buildDps[bk];
        let bWeighted = 0;
        for (const [s, w] of Object.entries(SCENARIO_WEIGHTS)) {
          bWeighted += (buildScenarios[s] || 0) * w;
        }
        const build = builds.find((b) => b.hash.startsWith(bk));
        console.log(
          `  ${build?.displayName || build?.name || bk}: ${Math.round(bWeighted).toLocaleString()} weighted`,
        );
      }
    }
  }

  setSessionState("gear_phase4", {
    validated: bestCombo.candidate_id,
    fidelity,
    timestamp: new Date().toISOString(),
  });
}

// --- CLI: run (automated pipeline) ---

async function cmdRun(args) {
  const { values } = parseArgs({
    args,
    options: {
      through: { type: "string", default: "phase4" },
    },
    strict: false,
  });

  const phases = {
    phase0: 0,
    phase1: 1,
    phase2: 2,
    phase3: 3,
    phase4: 4,
  };
  const maxPhase = phases[values.through] ?? 4;

  if (maxPhase >= 0) {
    console.log("\n========== PHASE 0: Tier Configuration ==========\n");
    await cmdTierConfig([]);
  }
  if (maxPhase >= 1) {
    console.log("\n========== PHASE 1: Per-Slot Screening ==========\n");
    await cmdScreen([]);
  }
  if (maxPhase >= 2) {
    console.log("\n========== PHASE 2: Combination Testing ==========\n");
    await cmdCombinations([]);
  }
  if (maxPhase >= 3) {
    console.log("\n========== PHASE 3: Stat Optimization ==========\n");
    await cmdStatOptimize([]);
  }
  if (maxPhase >= 4) {
    console.log("\n========== PHASE 4: Confirmation ==========\n");
    await cmdValidate([]);
  }

  console.log("\n========== Pipeline Complete ==========\n");
  cmdStatus();
}

// --- CLI: status ---

function cmdStatus() {
  const gearData = loadGearCandidates();

  console.log("\n=== Gear Pipeline Status ===\n");

  // Phase 0
  const phase0 = getSessionState("gear_phase0");
  console.log("Phase 0 (Tier Configuration):");
  if (phase0) {
    console.log(
      `  Best: ${phase0.best} (${phase0.fidelity}, ${phase0.timestamp})`,
    );
  } else {
    console.log("  not started");
  }

  // Phase 1
  console.log("\nPhase 1 (Per-Slot Screening):");
  const screenable = getScreenableSlots(gearData);
  for (const slot of Object.keys(screenable)) {
    const state = getSessionState(`gear_phase1_${slot}`);
    if (state) {
      console.log(
        `  ${slot.padEnd(20)} ${state.advancing.length} advancing, ${state.pruned.length} pruned (${state.fidelity})`,
      );
    } else {
      console.log(`  ${slot.padEnd(20)} not started`);
    }
  }

  // Phase 2
  console.log("\nPhase 2 (Combinations):");
  for (const type of getComboTypes(gearData)) {
    const state = getSessionState(`gear_phase2_${type}`);
    if (state) {
      console.log(
        `  ${type.padEnd(20)} ${state.advancing.length} advancing, ${state.pruned.length} pruned (${state.fidelity})`,
      );
    } else {
      console.log(`  ${type.padEnd(20)} not started`);
    }
  }

  // Phase 3
  console.log("\nPhase 3 (Stat Optimization):");
  const statAlloc = gearData.stat_allocations;
  if (statAlloc?.crafted_slots) {
    for (const craftedSlot of statAlloc.crafted_slots) {
      const state = getSessionState(`gear_phase3_${craftedSlot}`);
      if (state) {
        console.log(
          `  ${craftedSlot.padEnd(20)} best: ${state.best} (${state.fidelity})`,
        );
      } else {
        console.log(`  ${craftedSlot.padEnd(20)} not started`);
      }
    }
  }

  // Phase 4
  const phase4 = getSessionState("gear_phase4");
  console.log("\nPhase 4 (Validation):");
  if (phase4) {
    console.log(
      `  Validated: ${phase4.validated} (${phase4.fidelity}, ${phase4.timestamp})`,
    );
  } else {
    console.log("  not started");
  }

  // Trinket chart
  const chartState = getSessionState("gear_trinket_chart");
  console.log("\nTrinket Chart:");
  if (chartState) {
    console.log(
      `  ${chartState.trinkets} trinkets x ${chartState.ilvlTiers.join("/")} (${chartState.fidelity}, ${chartState.timestamp})`,
    );
  } else {
    console.log("  not started");
  }
}

// --- CLI: results ---

function cmdResults(args) {
  const { values } = parseArgs({
    args,
    options: {
      slot: { type: "string" },
      phase: { type: "string" },
    },
    strict: false,
  });

  const phase = values.phase ? parseInt(values.phase) : null;
  const gearData = loadGearCandidates();

  if (phase != null) {
    const results = getGearResults(phase, values.slot);
    if (results.length === 0) {
      console.log(
        `No results for phase ${phase}${values.slot ? ` slot ${values.slot}` : ""}.`,
      );
      return;
    }
    printDbResults(results, gearData);
  } else {
    for (let p = 0; p <= 4; p++) {
      const results = getGearResults(p, values.slot);
      if (results.length === 0) continue;
      console.log(`\n--- Phase ${p} ---`);
      printDbResults(results, gearData);
    }
  }
}

function printDbResults(results, gearData) {
  console.log(
    `\n${"Rank".padStart(4)}  ${"Candidate".padEnd(45)} ${"Weighted".padStart(10)}  ${"Delta".padStart(8)}  ${"Status".padStart(8)}`,
  );
  console.log("-".repeat(85));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.eliminated ? "[PRUNED]" : "";
    const delta =
      i === 0 ? "best" : `${r.delta_pct_weighted?.toFixed(2) || "?"}%`;
    const flag = gearData.flagged?.[r.candidate_id] ? " *" : "";

    console.log(
      `${String(i + 1).padStart(4)}  ${((r.label || r.candidate_id) + flag).padEnd(45)} ${Math.round(r.weighted).toLocaleString().padStart(10)}  ${delta.padStart(8)}  ${status.padStart(8)}`,
    );
  }
}

// --- CLI: export ---

function cmdExport() {
  const gearData = loadGearCandidates();

  console.log("# Gear export — SimC overrides for best gear\n");

  // Phase 0: tier config
  const phase0 = getSessionState("gear_phase0");
  if (phase0) {
    console.log(`# Tier config: ${phase0.best}`);
    if (phase0.best === "all_tier_5pc") {
      for (const simc of Object.values(gearData.tier.items)) {
        console.log(simc);
      }
    } else {
      // Parse "skip_<slot>_<alt_id>" to reconstruct
      const match = phase0.best.match(/^skip_([^_]+)_(.+)$/);
      if (match) {
        const [, skipSlot, altId] = match;
        for (const [slot, simc] of Object.entries(gearData.tier.items)) {
          if (slot === skipSlot) {
            const alt = gearData.tier.alternatives[slot]?.find(
              (a) => a.id === altId,
            );
            if (alt) console.log(alt.simc);
          } else {
            console.log(simc);
          }
        }
      }
    }
  }

  // Phase 2: combination winners (trinkets, rings, embellishments)
  const phase2 = getBestGear(2);
  if (phase2.length > 0) {
    // Group by slot/combination_type
    const seen = new Set();
    for (const entry of phase2) {
      const key = entry.combination_type || entry.slot;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`# Best ${key}: ${entry.label}`);
      for (const override of resolveComboOverrides(
        entry.candidate_id,
        gearData,
      )) {
        console.log(override);
      }
    }
  }

  // Phase 1 winners for independent slots
  for (const slot of Object.keys(gearData.slots)) {
    const results = getGearResults(1, slot).filter((r) => !r.eliminated);
    if (results.length > 0) {
      const best = results[0];
      const candidate = gearData.slots[slot].candidates.find(
        (c) => c.id === best.candidate_id,
      );
      if (candidate) {
        console.log(`# ${slot}: ${candidate.label}`);
        console.log(candidate.simc);
      }
    }
  }

  // Phase 1 winners for enchant slots
  for (const enchantSlot of Object.keys(gearData.enchants || {})) {
    const results = getGearResults(1, enchantSlot).filter((r) => !r.eliminated);
    if (results.length > 0) {
      const best = results[0];
      const enchantData = gearData.enchants[enchantSlot];
      const candidate = enchantData.candidates.find(
        (c) => c.id === best.candidate_id,
      );
      if (candidate) {
        console.log(
          `# ${enchantSlot}: ${candidate.label} (enchant_id=${candidate.enchant_id})`,
        );
        console.log(
          `${enchantData.base_item},enchant_id=${candidate.enchant_id}`,
        );
      }
    }
  }

  // Phase 3 stat winners
  const statAlloc = gearData.stat_allocations;
  if (statAlloc?.crafted_slots) {
    for (const craftedSlot of statAlloc.crafted_slots) {
      const state = getSessionState(`gear_phase3_${craftedSlot}`);
      if (state?.best) {
        console.log(`# ${craftedSlot} stat alloc: ${state.best}`);
      }
    }
  }
}

// --- CLI: trinket-chart ---

function swapIlevel(simcBase, ilvl) {
  return simcBase.replace(/ilevel=\d+/, `ilevel=${ilvl}`);
}

function aggregateIlvlResults(results, candidates) {
  // Key: candidateId_ilvlN → { scenarioDps: { scenario: [dps...] } }
  const byKey = new Map();

  for (const { scenario, result } of results) {
    for (const variant of result.variants) {
      // Strip build hash prefix: "ab12cd34_trinketid_ilvl289" → "trinketid_ilvl289"
      const underscoreIdx = variant.name.indexOf("_");
      const key =
        underscoreIdx >= 0
          ? variant.name.slice(underscoreIdx + 1)
          : variant.name;

      if (!byKey.has(key)) byKey.set(key, { scenarioDps: {} });
      const entry = byKey.get(key);
      if (!entry.scenarioDps[scenario]) entry.scenarioDps[scenario] = [];
      entry.scenarioDps[scenario].push(variant.dps);
    }
  }

  const candidateMap = new Map(candidates.map((c) => [c.id, c]));
  const rows = [];

  for (const [key, data] of byKey) {
    // Parse "trinketid_ilvlN" — split on last "_ilvl"
    const ilvlMatch = key.match(/^(.+)_ilvl(\d+)$/);
    if (!ilvlMatch) continue;

    const [, candidateId, ilvlStr] = ilvlMatch;
    const ilvl = parseInt(ilvlStr);
    const candidate = candidateMap.get(candidateId);

    const avgScenarioDps = {};
    for (const [scenario, dpsValues] of Object.entries(data.scenarioDps)) {
      avgScenarioDps[scenario] =
        dpsValues.reduce((a, b) => a + b, 0) / dpsValues.length;
    }

    let weighted = 0;
    for (const [scenario, weight] of Object.entries(SCENARIO_WEIGHTS)) {
      weighted += (avgScenarioDps[scenario] || 0) * weight;
    }

    rows.push({
      candidate_id: candidateId,
      label: candidate?.label || candidateId,
      ilvl,
      dps_st: avgScenarioDps.st || 0,
      dps_dungeon_route: avgScenarioDps.dungeon_route || 0,
      dps_small_aoe: avgScenarioDps.small_aoe || 0,
      dps_big_aoe: avgScenarioDps.big_aoe || 0,
      weighted,
    });
  }

  return rows;
}

function saveGearIlvlResults(rows, fidelity) {
  const db = getDb();
  const spec = getSpecName();
  const stmt = db.prepare(`
    INSERT INTO gear_ilvl_results (spec, candidate_id, label, ilvl, dps_st, dps_dungeon_route, dps_small_aoe, dps_big_aoe, weighted, fidelity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  withTransaction(() => {
    for (const r of rows) {
      stmt.run(
        spec,
        r.candidate_id,
        r.label,
        r.ilvl,
        r.dps_st,
        r.dps_dungeon_route,
        r.dps_small_aoe,
        r.dps_big_aoe,
        r.weighted,
        fidelity,
      );
    }
  });
}

function clearGearIlvlResults() {
  const db = getDb();
  const spec = getSpecName();
  db.prepare("DELETE FROM gear_ilvl_results WHERE spec = ?").run(spec);
}

async function cmdTrinketChart(args) {
  const { values } = parseArgs({
    args,
    options: {
      fidelity: { type: "string", default: "quick" },
    },
    strict: false,
  });

  const fidelity = values.fidelity;
  const gearData = loadGearCandidates();
  const rawTiers = gearData.ilvl_tiers || [237, 250, 263, 276, 289];
  const ilvlTiers = rawTiers.map((t) => (typeof t === "object" ? t.ilvl : t));
  const trinketCandidates = gearData.paired_slots?.trinkets?.candidates || [];

  if (trinketCandidates.length === 0) {
    console.log("No trinket candidates in gear-candidates.json.");
    return;
  }

  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  // Generate all (candidate, ilvl) variants
  const variants = [];
  for (const c of trinketCandidates) {
    for (const ilvl of ilvlTiers) {
      variants.push({
        name: `${c.id}_ilvl${ilvl}`,
        overrides: [`trinket1=${swapIlevel(c.simc_base, ilvl)}`],
      });
    }
  }

  const scenarioCount = Object.keys(SCENARIOS).length;
  console.log(
    `\nTrinket chart: ${trinketCandidates.length} trinkets x ${ilvlTiers.length} ilvl tiers = ${variants.length} variants`,
  );
  console.log(
    `Running ${variants.length * builds.length * scenarioCount} sims (${fidelity} fidelity)...\n`,
  );

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelity,
    "gear_trinket_chart",
  );

  const aggregated = aggregateIlvlResults(results, trinketCandidates);

  clearGearIlvlResults();
  saveGearIlvlResults(aggregated, fidelity);

  // Print summary sorted by highest-ilvl DPS
  const highestIlvl = ilvlTiers.at(-1);
  const byCandidate = new Map();
  for (const r of aggregated) {
    if (!byCandidate.has(r.candidate_id)) byCandidate.set(r.candidate_id, {});
    byCandidate.get(r.candidate_id)[r.ilvl] = r.weighted;
  }
  const sorted = [...byCandidate.entries()].sort(
    (a, b) => (b[1][highestIlvl] || 0) - (a[1][highestIlvl] || 0),
  );

  console.log(`\n=== Trinket Chart Results ===`);
  console.log(
    `${"Rank".padStart(4)}  ${"Trinket".padEnd(40)} ${ilvlTiers.map((t) => String(t).padStart(10)).join("")}`,
  );
  console.log("-".repeat(4 + 2 + 40 + ilvlTiers.length * 10));

  for (let i = 0; i < sorted.length; i++) {
    const [id, ilvlDps] = sorted[i];
    const label = trinketCandidates.find((c) => c.id === id)?.label || id;
    const vals = ilvlTiers
      .map((t) =>
        Math.round(ilvlDps[t] || 0)
          .toLocaleString()
          .padStart(10),
      )
      .join("");
    console.log(`${String(i + 1).padStart(4)}  ${label.padEnd(40)} ${vals}`);
  }

  setSessionState("gear_trinket_chart", {
    trinkets: trinketCandidates.length,
    ilvlTiers,
    fidelity,
    timestamp: new Date().toISOString(),
  });

  console.log(
    `\nSaved ${aggregated.length} results to DB (${trinketCandidates.length} trinkets x ${ilvlTiers.length} ilvl tiers).`,
  );
}

// --- CLI dispatch ---

await initSpec(parseSpecArg());

// Strip --spec and its value from argv before extracting the command
const argv = process.argv.slice(2);
const filteredArgv = argv.filter(
  (a, i) => a !== "--spec" && argv[i - 1] !== "--spec",
);
const [cmd, ...cleanArgs] = filteredArgv;

switch (cmd) {
  case "tier-config":
    await cmdTierConfig(cleanArgs);
    break;
  case "screen":
    await cmdScreen(cleanArgs);
    break;
  case "combinations":
    await cmdCombinations(cleanArgs);
    break;
  case "stat-optimize":
    await cmdStatOptimize(cleanArgs);
    break;
  case "validate":
    await cmdValidate(cleanArgs);
    break;
  case "run":
    await cmdRun(cleanArgs);
    break;
  case "status":
    cmdStatus();
    break;
  case "results":
    cmdResults(cleanArgs);
    break;
  case "export":
    cmdExport();
    break;
  case "trinket-chart":
    await cmdTrinketChart(cleanArgs);
    break;
  default:
    console.log(`Usage: node src/sim/gear.js <command> [options]

Commands:
  tier-config     Phase 0: Test tier set configurations (which slot to skip)
  screen          Phase 1: Screen candidates per slot (quick fidelity)
  combinations    Phase 2: Test top-K combinations (standard fidelity)
  stat-optimize   Phase 3: Optimize crafted stat allocations (standard fidelity)
  validate        Phase 4: Confirm best gear at high fidelity
  run             Run full pipeline (--through phase0|phase1|phase2|phase3|phase4)
  status          Show pipeline progress
  results         Show stored results (--slot X --phase N)
  export          Export best gear as SimC overrides
  trinket-chart   Sim all trinkets at multiple ilvl tiers for chart visualization

Options:
  --spec X        Spec name (or SPEC env var)
  --slot X        Target a specific slot
  --fidelity X    quick|standard|confirm
  --through X     Stop after phase (for 'run' command)
  --type X        Combination type (trinkets|rings|embellishments)
`);
    break;
}

closeAll();
