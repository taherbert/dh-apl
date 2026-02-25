// EP-based gear optimization pipeline. Derives stat weights from scale factors,
// EP-ranks stat-stick items (no per-item sims), and sim-evaluates proc items,
// trinkets, rings, and embellishments. Assembles and validates final profile.
//
// Phases:
//   0  tier-config    Tier set selection (sim-based)
//   1  scale-factors  Single sim -> EP weights saved to session_state
//   2  stat-optimize  Optimize crafted item stat budgets
//   3  ep-rank        Pure EP scoring for stat-stick items only (proc/on-use/set items excluded)
//   4  proc-eval      Sim proc/on-use items vs stat-stick baseline; significance gated
//   4b set-eval       Set bonus evaluation: A-alone, B-alone, full-set; significance gated
//   5  trinkets       Screen + pair sims; significance gated
//   6  (removed — rings are EP-ranked in Phase 3)
//   7  embellishments Screen + pair sims; significance gated
//   8  stat-re-opt    Re-run Phase 2 if embellishments changed crafted slots
//   9  gems           EP-rank gems, apply to all sockets
//  10  enchants       EP-rank cloak/wrist/foot; sim weapon/ring
//  11  validate       Assembled gear vs current profile at high fidelity
//
// Usage:
//   SPEC=vengeance node src/sim/gear.js run [--through phase0..phase11] [--fidelity X]
//   SPEC=vengeance node src/sim/gear.js scale-factors
//   SPEC=vengeance node src/sim/gear.js ep-rank
//   SPEC=vengeance node src/sim/gear.js proc-eval
//   SPEC=vengeance node src/sim/gear.js stat-optimize
//   SPEC=vengeance node src/sim/gear.js combinations [--type trinkets|rings|embellishments]
//   SPEC=vengeance node src/sim/gear.js gems
//   SPEC=vengeance node src/sim/gear.js enchants
//   SPEC=vengeance node src/sim/gear.js validate [--fidelity confirm]
//   SPEC=vengeance node src/sim/gear.js write-profile
//   SPEC=vengeance node src/sim/gear.js status
//   SPEC=vengeance node src/sim/gear.js results [--slot X] [--phase N]
//   SPEC=vengeance node src/sim/gear.js export
//   SPEC=vengeance node src/sim/gear.js screen [--slot X]  (diagnostic only)

import { getSimCores, stopRemote } from "./remote.js";
import { parseArgs } from "node:util";
import { execFileAsync } from "../util/exec.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  initSpec,
  SCENARIOS,
  SCENARIO_WEIGHTS,
  FIDELITY_TIERS,
  SIM_DEFAULTS,
  SIMC_BIN,
  DATA_ENV,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import {
  dataFile,
  aplsDir,
  ROOT,
  getSpecName,
  resultsFile,
  resultsDir,
} from "../engine/paths.js";
import { generateProfileset, runProfilesetAsync } from "./profilesets.js";
import {
  getDb,
  closeAll,
  getRosterBuilds,
  getSessionState,
  setSessionState,
  withTransaction,
} from "../util/db.js";

// --- Fidelity parsing ---
// Accepts --quick / --confirm shorthands in addition to --fidelity <tier>.
// Pass defaultTier=null to detect "no flag given" (returns null).
function parseFidelity(args, defaultTier = "standard") {
  if (args.includes("--quick")) return "quick";
  if (args.includes("--confirm")) return "confirm";
  const idx = args.indexOf("--fidelity");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return defaultTier;
}

// --- Concurrency helpers ---

const MIN_THREADS_PER_SIM = 4;

function simConcurrency(simCount) {
  const totalCores = getSimCores();
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

// Where optimized gear lines are written back to. Separate from baseline (which may
// be the full APL+profile composite used for sims). Falls back to baseline when not set.
function getGearTarget(gearData) {
  const target = gearData.gearTarget ?? gearData.baseline;
  return resolve(ROOT, target);
}

// Reconstruct SimC override lines for a combination candidate ID.
function resolveComboOverrides(candidateId, gearData) {
  // Null embellishment baseline
  if (candidateId === "__null_emb__") {
    return gearData.embellishments?.null_overrides || [];
  }

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

// --- EP scoring helpers ---

function scoreEp(stats, sf) {
  if (!stats) return 0;
  return (
    (stats.agi || 0) * (sf.Agi || 0) +
    (stats.haste || 0) * (sf.Haste || 0) +
    (stats.crit || 0) * (sf.Crit || 0) +
    (stats.mastery || 0) * (sf.Mastery || 0) +
    (stats.vers || 0) * (sf.Vers || 0)
  );
}

function isCraftedSimc(simcStr) {
  return (simcStr || "").includes("crafted_stats=");
}

// Slots where ALL candidates are sim-evaluated in Phase 4, not just EP-ranked.
// Weapons have procs, cross-slot synergies, and other non-stat effects that EP can't model.
const ALWAYS_SIM_SLOTS = new Set(["main_hand", "off_hand"]);

// All valid secondary stat combinations for crafted items.
// SimC crafted_stats IDs: Crit=32, Haste=36, Vers=40, Mastery=49.
// Note: these differ from Raidbots item stat IDs used in extractStats().
// Order within crafted_stats is irrelevant — SimC applies both stats unconditionally.
const CRAFTED_STAT_PAIRS = [
  { id: "crit_haste", label: "Crit/Haste", crafted_stats: "32/36" },
  { id: "crit_vers", label: "Crit/Vers", crafted_stats: "32/40" },
  { id: "crit_mastery", label: "Crit/Mastery", crafted_stats: "32/49" },
  { id: "haste_vers", label: "Haste/Vers", crafted_stats: "36/40" },
  { id: "haste_mastery", label: "Haste/Mastery", crafted_stats: "36/49" },
];

// Detect crafted item slots from profile.simc (lines containing crafted_stats=).
function detectCraftedSlots(profilePath) {
  if (!existsSync(profilePath)) return [];
  const content = readFileSync(profilePath, "utf-8");
  const slots = new Set();
  for (const line of content.split("\n")) {
    if (!line.includes("crafted_stats=")) continue;
    const m = line.match(/^(\w+)=/);
    if (!m) continue;
    // Normalize wrist -> wrists (gear-candidates uses "wrists" as slot key)
    slots.add(m[1] === "wrist" ? "wrists" : m[1]);
  }
  return [...slots];
}

// Gate on statistical significance: winner must beat control by more than target_error%.
function isSignificant(winnerDps, controlDps, targetError) {
  if (!controlDps) return true;
  const pct = ((winnerDps - controlDps) / controlDps) * 100;
  return Math.abs(pct) > targetError;
}

// --- CLI: scale-factors (Phase 1) ---

async function cmdScaleFactors(args) {
  const fidelity = parseFidelity(args, "standard");
  const gearData = loadGearCandidates();
  const profilePath = getBaseProfile(gearData);
  const stConfig = SCENARIOS["st"];
  if (!stConfig) throw new Error("No 'st' scenario configured");

  const fidelityConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.standard;
  mkdirSync(resultsDir(), { recursive: true });
  const outputPath = resultsFile("gear_scale_factors.json");

  const { threadsPerSim } = simConcurrency(1);

  const simArgs = [
    profilePath,
    "calculate_scale_factors=1",
    "scale_only=Agi/Haste/Crit/Mastery/Vers",
    `json2=${outputPath}`,
    `threads=${threadsPerSim}`,
    `max_time=${stConfig.maxTime}`,
    `desired_targets=${stConfig.desiredTargets}`,
    ...(stConfig.fightStyle ? [`fight_style=${stConfig.fightStyle}`] : []),
    `target_error=${fidelityConfig.target_error}`,
    `iterations=${fidelityConfig.iterations || SIM_DEFAULTS.iterations}`,
  ];
  if (DATA_ENV === "ptr" || DATA_ENV === "beta") simArgs.unshift("ptr=1");

  console.log(
    `\nPhase 1: Scale Factors (${fidelity} fidelity, ${threadsPerSim} threads)`,
  );
  console.log("Running scale factors sim...");

  try {
    await execFileAsync(SIMC_BIN, simArgs, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 1800000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
    throw new Error(`SimC scale factors failed: ${e.message}`);
  }

  const data = JSON.parse(readFileSync(outputPath, "utf-8"));
  const sf = data.sim.players[0].scale_factors;

  setSessionState("gear_scale_factors", {
    ...sf,
    timestamp: new Date().toISOString(),
  });

  console.log("Scale factors:");
  for (const [stat, value] of Object.entries(sf)) {
    if (typeof value === "number")
      console.log(`  ${stat}: ${value.toFixed(4)}`);
  }
}

// --- CLI: ep-rank (Phase 3) ---

function cmdEpRank(gearData) {
  const sf = getSessionState("gear_scale_factors");
  if (!sf) throw new Error("Run gear:scale-factors (Phase 1) first");

  const hasEmbellishments = gearData.embellishments?.pairs?.length > 0;
  let totalRanked = 0;
  let finger1WinnerId = null;

  for (const [slot, slotData] of Object.entries(gearData.slots || {})) {
    // ALWAYS_SIM_SLOTS (weapons) are evaluated via sim in Phase 4 — skip EP ranking.
    if (ALWAYS_SIM_SLOTS.has(slot)) continue;

    let candidates = (slotData.candidates || []).filter(
      (c) => !hasEmbellishments || !isCraftedSimc(c.simc),
    );

    // Prevent the same ring from occupying both finger slots
    if (slot === "finger2" && finger1WinnerId) {
      candidates = candidates.filter((c) => c.id !== finger1WinnerId);
    }

    if (candidates.length === 0) continue;

    const ranked = candidates
      .map((c) => ({ ...c, ep: scoreEp(c.stats, sf) }))
      .sort((a, b) => b.ep - a.ep);

    const best = ranked[0];
    if (slot === "finger1") finger1WinnerId = best?.id ?? null;
    clearGearResults(3, slot);
    saveGearResults(
      3,
      slot,
      ranked.map((c, i) => ({
        id: c.id,
        label: c.label,
        dps_st: null,
        dps_dungeon_route: null,
        dps_small_aoe: null,
        dps_big_aoe: null,
        weighted: c.ep,
        delta_pct_weighted:
          i === 0 || best.ep === 0 ? 0 : ((c.ep - best.ep) / best.ep) * 100,
        eliminated: 0,
      })),
      "ep",
    );
    totalRanked++;
  }

  console.log(`EP-ranked ${totalRanked} slots.`);
  setSessionState("gear_phase3", {
    timestamp: new Date().toISOString(),
    sf: {
      Agi: sf.Agi,
      Haste: sf.Haste,
      Crit: sf.Crit,
      Mastery: sf.Mastery,
      Vers: sf.Vers,
    },
  });
}

// --- CLI: proc-eval (Phase 4) ---

async function cmdProcEval(args) {
  const fidelity = parseFidelity(args, "quick");
  const fidelityConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.quick;
  const targetError = fidelityConfig.target_error;
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  // Phase 4 sims ALL candidates in ALWAYS_SIM_SLOTS.
  // No proc tagging needed — every weapon is evaluated empirically.
  for (const slot of ALWAYS_SIM_SLOTS) {
    const slotData = gearData.slots?.[slot];
    const candidates = slotData?.candidates || [];
    if (candidates.length === 0) continue;

    const variants = candidates.map((c) => ({
      name: c.id,
      overrides: [c.simc],
    }));

    const scenarioCount = Object.keys(SCENARIOS).length;
    console.log(
      `\nWeapon eval: ${slot} (${candidates.length} candidates x ${builds.length} builds x ${scenarioCount} scenarios)`,
    );

    const results = await runBuildScenarioSims(
      variants,
      builds,
      baseProfile,
      fidelity,
      `gear_weapon_${slot}`,
    );
    const candidateMeta = candidates.map((c) => ({ id: c.id, label: c.label }));
    const ranked = aggregateGearResults(results, candidateMeta, builds);

    // Significance gate: winner must beat the current profile baseline by more than target_error%.
    const baselineEntry = ranked.find((r) => r.id === "__baseline__");
    const baselineDps = baselineEntry?.weighted ?? 0;
    for (const r of ranked) {
      if (r.id === "__baseline__") continue;
      r.delta_pct_weighted = baselineDps
        ? ((r.weighted - baselineDps) / baselineDps) * 100
        : 0;
      if (!isSignificant(r.weighted, baselineDps, targetError)) {
        r.eliminated = true;
        console.log(
          `  ${r.label}: not significant vs profile baseline (${r.delta_pct_weighted.toFixed(2)}%, threshold ${targetError}%)`,
        );
      }
    }

    printSlotResults(`weapon-eval: ${slot}`, ranked, gearData);

    clearGearResults(4, slot);
    saveGearResults(
      4,
      slot,
      ranked.filter((r) => r.id !== "__baseline__"),
      fidelity,
    );
  }
}

// Phase number for set evaluation results (between Phase 4 and Phase 5).
const SET_EVAL_PHASE = 45;

// --- CLI: set-eval (Phase 4b) ---

// Paired slot combos to check for cross-slot synergy after Phase 4.
// For each pair, if both slots have significant Phase 4 winners, run A-alone/B-alone/full.
const WEAPON_SLOT_PAIRS = [["main_hand", "off_hand"]];

async function cmdEvalSets(args) {
  const fidelity = parseFidelity(args, "quick");
  const fidelityConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.quick;
  const targetError = fidelityConfig.target_error;
  const gearData = loadGearCandidates();
  const evaluatedPairIds = [];
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  // Auto-generate cross-slot pairs from Phase 4 winners in weapon slot pairs.
  for (const [slotA, slotB] of WEAPON_SLOT_PAIRS) {
    const winnersA = getBestGear(4, slotA).filter(
      (r) => !r.eliminated && r.candidate_id !== "__baseline__",
    );
    const winnersB = getBestGear(4, slotB).filter(
      (r) => !r.eliminated && r.candidate_id !== "__baseline__",
    );

    if (winnersA.length === 0 || winnersB.length === 0) {
      console.log(
        `No significant Phase 4 winners for ${slotA}/${slotB} pair, skipping set eval.`,
      );
      continue;
    }

    const wA = winnersA[0];
    const wB = winnersB[0];
    const memberA = gearData.slots[slotA]?.candidates.find(
      (c) => c.id === wA.candidate_id,
    );
    const memberB = gearData.slots[slotB]?.candidates.find(
      (c) => c.id === wB.candidate_id,
    );
    if (!memberA || !memberB) continue;

    const pairId = `${wA.candidate_id}__${wB.candidate_id}`;
    evaluatedPairIds.push(pairId);

    const variants = [
      { name: `${pairId}_A_alone`, overrides: [memberA.simc] },
      { name: `${pairId}_B_alone`, overrides: [memberB.simc] },
      { name: `${pairId}_full`, overrides: [memberA.simc, memberB.simc] },
    ];

    const scenarioCount = Object.keys(SCENARIOS).length;
    console.log(
      `\nSet eval: ${memberA.label} + ${memberB.label} (A-alone, B-alone, full-set x ${builds.length} builds x ${scenarioCount} scenarios, ${fidelity} fidelity)`,
    );

    const results = await runBuildScenarioSims(
      variants,
      builds,
      baseProfile,
      fidelity,
      `gear_set_${pairId}`,
    );
    const candidateMeta = [
      { id: `${pairId}_A_alone`, label: `${memberA.label} alone` },
      { id: `${pairId}_B_alone`, label: `${memberB.label} alone` },
      { id: `${pairId}_full`, label: `${memberA.label} + ${memberB.label}` },
    ];
    const ranked = aggregateGearResults(results, candidateMeta, builds);

    // Significance gate: best config must beat current profile baseline.
    const baselineEntry = ranked.find((r) => r.id === "__baseline__");
    const baselineDps = baselineEntry?.weighted ?? 0;
    const configs = ranked.filter((r) => r.id !== "__baseline__");
    const bestConfig = configs[0];

    const significant =
      bestConfig &&
      isSignificant(bestConfig.weighted, baselineDps, targetError);

    if (!significant && bestConfig) {
      const deltaPct = baselineDps
        ? (((bestConfig.weighted - baselineDps) / baselineDps) * 100).toFixed(2)
        : "?";
      console.log(
        `  No significant improvement (best ${deltaPct}%, threshold ${targetError}%)`,
      );
    }

    for (const r of configs) {
      r.eliminated = !significant || r.id !== bestConfig.id;
    }

    printSlotResults(`set-eval: ${pairId}`, ranked, gearData);

    clearGearResults(SET_EVAL_PHASE, pairId);
    saveGearResults(SET_EVAL_PHASE, pairId, ranked, fidelity, "set_eval");

    if (significant) {
      setSessionState(`gear_set_eval_${pairId}`, {
        winner: bestConfig.id,
        member0: wA.candidate_id,
        member1: wB.candidate_id,
        slot0: slotA,
        slot1: slotB,
        fidelity,
        timestamp: new Date().toISOString(),
      });
      console.log(`  Set winner: ${bestConfig.label}`);
    } else {
      setSessionState(`gear_set_eval_${pairId}`, null);
    }
  }

  // Explicit ring set-bonus pairs from gear-config (e.g., Voidlight Bindings)
  for (const pair of gearData.ring_pairs ?? []) {
    const memberA = gearData.slots.finger1?.candidates.find(
      (c) => c.id === pair.finger1,
    );
    const memberB = gearData.slots.finger2?.candidates.find(
      (c) => c.id === pair.finger2,
    );
    if (!memberA || !memberB) {
      console.log(`Ring pair ${pair.id}: candidates not found, skipping`);
      continue;
    }

    const pairId = `ring_${pair.id}`;
    evaluatedPairIds.push(pairId);

    const variants = [
      { name: `${pairId}_A_alone`, overrides: [memberA.simc] },
      { name: `${pairId}_B_alone`, overrides: [memberB.simc] },
      { name: `${pairId}_full`, overrides: [memberA.simc, memberB.simc] },
    ];

    const scenarioCount = Object.keys(SCENARIOS).length;
    console.log(
      `\nRing pair eval: ${pair.label} (A-alone, B-alone, full-set x ${builds.length} builds x ${scenarioCount} scenarios, ${fidelity} fidelity)`,
    );

    const results = await runBuildScenarioSims(
      variants,
      builds,
      baseProfile,
      fidelity,
      `gear_set_${pairId}`,
    );
    const candidateMeta = [
      { id: `${pairId}_A_alone`, label: `${memberA.label} alone` },
      { id: `${pairId}_B_alone`, label: `${memberB.label} alone` },
      { id: `${pairId}_full`, label: `${pair.label}` },
    ];
    const ranked = aggregateGearResults(results, candidateMeta, builds);

    const baselineEntry = ranked.find((r) => r.id === "__baseline__");
    const baselineDps = baselineEntry?.weighted ?? 0;
    const configs = ranked.filter((r) => r.id !== "__baseline__");
    const bestConfig = configs[0];

    const significant =
      bestConfig &&
      isSignificant(bestConfig.weighted, baselineDps, targetError);

    if (!significant && bestConfig) {
      const deltaPct = baselineDps
        ? (((bestConfig.weighted - baselineDps) / baselineDps) * 100).toFixed(2)
        : "?";
      console.log(
        `  No significant improvement (best ${deltaPct}%, threshold ${targetError}%)`,
      );
    }

    for (const r of configs) {
      r.eliminated = !significant || r.id !== bestConfig.id;
    }

    printSlotResults(`set-eval: ${pairId}`, ranked, gearData);

    clearGearResults(SET_EVAL_PHASE, pairId);
    saveGearResults(SET_EVAL_PHASE, pairId, ranked, fidelity, "set_eval");

    if (significant) {
      setSessionState(`gear_set_eval_${pairId}`, {
        winner: bestConfig.id,
        member0: pair.finger1,
        member1: pair.finger2,
        slot0: "finger1",
        slot1: "finger2",
        fidelity,
        timestamp: new Date().toISOString(),
      });
      console.log(`  Ring pair winner: ${bestConfig.label}`);
    } else {
      setSessionState(`gear_set_eval_${pairId}`, null);
    }
  }

  setSessionState("gear_set_eval_pairs", evaluatedPairIds);
}

// --- CLI: gems (Phase 9) ---

function cmdGems(gearData) {
  const sf = getSessionState("gear_scale_factors");
  const gems = gearData.gems || [];

  if (gems.length === 0) {
    console.log("No gems in gear-candidates.json. Add a 'gems' section.");
    return;
  }
  if (!sf) {
    console.log("No scale factors. Run scale-factors (Phase 1) first.");
    return;
  }

  const ranked = gems
    .filter((g) => g.stats)
    .map((g) => ({ ...g, ep: scoreEp(g.stats, sf) }))
    .sort((a, b) => b.ep - a.ep);

  const best = ranked.length > 0 ? ranked[0] : gems[0];
  if (!best) {
    console.log("No gems configured.");
    return;
  }
  if (ranked.length === 0) {
    console.log(
      `Phase 9: Gems — no stat data, defaulting to first gem: ${best.label}`,
    );
    setSessionState("gear_gems", {
      best_id: best.id,
      best_enchant_id: best.enchant_id,
      best_item_id: best.item_id || best.enchant_id,
      best_label: best.label,
      ep: 0,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  setSessionState("gear_gems", {
    best_id: best.id,
    best_enchant_id: best.enchant_id,
    best_item_id: best.item_id || best.enchant_id,
    best_label: best.label,
    ep: best.ep,
    timestamp: new Date().toISOString(),
  });

  console.log(
    `\nPhase 9: Gems — best: ${best.label} (EP: ${best.ep.toFixed(1)})`,
  );
  for (const [i, g] of ranked.entries()) {
    const delta =
      i === 0 ? "" : ` (${(((g.ep - best.ep) / best.ep) * 100).toFixed(2)}%)`;
    console.log(`  ${i + 1}. ${g.label}: ${g.ep.toFixed(1)}${delta}`);
  }
}

// --- CLI: enchants (Phase 10) ---

async function cmdEnchants(args) {
  const { values } = parseArgs({
    args,
    options: { slot: { type: "string" } },
    strict: false,
  });
  const fidelity = parseFidelity(args, "quick");
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const sf = getSessionState("gear_scale_factors");

  // Stat-only enchant slots that can be EP-ranked (no sims needed)
  const EP_ENCHANT_SLOTS = new Set(["cloak", "wrist", "foot"]);

  const enchantSlots = values.slot
    ? [values.slot]
    : Object.keys(gearData.enchants || {});

  for (const enchantSlot of enchantSlots) {
    const enchantData = gearData.enchants[enchantSlot];
    if (!enchantData) {
      console.error(`Unknown enchant slot: ${enchantSlot}`);
      continue;
    }

    const isStatEnchant = EP_ENCHANT_SLOTS.has(enchantSlot);
    const hasStats = enchantData.candidates.some((c) => c.stats);

    if (isStatEnchant && hasStats && sf) {
      // EP-rank stat enchants — no sim needed
      const ranked = enchantData.candidates
        .filter((c) => c.stats)
        .map((c) => ({ id: c.id, label: c.label, ep: scoreEp(c.stats, sf) }))
        .sort((a, b) => b.ep - a.ep)
        .map((r, i, arr) => ({
          ...r,
          weighted: r.ep,
          delta_pct_weighted:
            i === 0 || arr[0].ep === 0
              ? 0
              : ((r.ep - arr[0].ep) / arr[0].ep) * 100,
          eliminated: 0,
          dps_st: null,
          dps_dungeon_route: null,
          dps_small_aoe: null,
          dps_big_aoe: null,
        }));

      const best = ranked[0];

      clearGearResults(10, enchantSlot);
      saveGearResults(10, enchantSlot, ranked, "ep");
      console.log(
        `EP-ranked ${enchantSlot} enchants: best is ${best.label} (EP: ${best.ep.toFixed(1)})`,
      );
      continue;
    }

    // Sim-based: weapon, ring, and any stat enchant without stats
    const candidates = enchantSlotScreenCandidates(enchantData);
    if (candidates.length <= 1) {
      console.log(
        `Slot ${enchantSlot}: only ${candidates.length} candidate, skipping.`,
      );
      continue;
    }

    console.log(
      `\nPhase 10: Screening ${enchantSlot} (${candidates.length} enchants, ${fidelity} fidelity)`,
    );

    const ranked = await screenSlot(
      enchantSlot,
      candidates,
      gearData,
      fidelity,
      builds,
    );

    printSlotResults(enchantSlot, ranked, gearData);

    clearGearResults(10, enchantSlot);
    saveGearResults(10, enchantSlot, ranked, fidelity);
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

// Strip the build hash prefix from variant names: "ab12cd34_candidateId" → "candidateId"
function stripBuildPrefix(name) {
  const idx = name.indexOf("_");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

// Average per-scenario DPS arrays and compute scenario-weighted total.
function computeWeightedDps(scenarioDps) {
  const avg = {};
  for (const [scenario, dpsValues] of Object.entries(scenarioDps)) {
    avg[scenario] = dpsValues.reduce((a, b) => a + b, 0) / dpsValues.length;
  }
  let weighted = 0;
  for (const [scenario, weight] of Object.entries(SCENARIO_WEIGHTS)) {
    weighted += (avg[scenario] || 0) * weight;
  }
  return { avg, weighted };
}

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
      const candidateId = stripBuildPrefix(variant.name);
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
    const { avg, weighted } = computeWeightedDps(data.scenarioDps);
    const candidate = candidateMap.get(candidateId);
    ranked.push({
      id: candidateId,
      label:
        candidateId === "__baseline__"
          ? "Baseline (current profile)"
          : candidate?.label || candidateId,
      dps_st: avg.st || 0,
      dps_dungeon_route: avg.dungeon_route || 0,
      dps_small_aoe: avg.small_aoe || 0,
      dps_big_aoe: avg.big_aoe || 0,
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

function queryGearResults(phase, slot, { bestOnly = false } = {}) {
  const db = getDb();
  const spec = getSpecName();
  const clauses = ["spec = ?", "phase = ?"];
  const params = [spec, phase];
  if (bestOnly) clauses.push("eliminated = 0");
  if (slot) {
    clauses.push("slot = ?");
    params.push(slot);
  }
  const sql = `SELECT * FROM gear_results WHERE ${clauses.join(" AND ")} ORDER BY weighted DESC`;
  return db.prepare(sql).all(...params);
}

function getGearResults(phase, slot) {
  return queryGearResults(phase, slot);
}

function getBestGear(phase, slot) {
  return queryGearResults(phase, slot, { bestOnly: true });
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
  const fidelity = parseFidelity(args, "quick");
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
    options: { slot: { type: "string" } },
    strict: false,
  });
  const fidelity = parseFidelity(args, "quick");
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
  }
}

// Phase assignments for combination types
const COMBO_PHASES = { trinkets: 5, embellishments: 7 };

// --- CLI: combinations (Phases 5/7) ---
// trinkets=Phase 5, embellishments=Phase 7
// For trinkets: screens first then generates pairs. Embellishments: pairs only.

async function cmdCombinations(args) {
  const { values } = parseArgs({
    args,
    options: { type: { type: "string" } },
    strict: false,
  });
  const fidelity = parseFidelity(args, "standard");
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  // Build list of types to process
  const requestedTypes = values.type ? [values.type] : getComboTypes(gearData);
  const types = requestedTypes.filter((t) => t in COMBO_PHASES);

  for (const type of types) {
    const phase = COMBO_PHASES[type];
    let pairs;

    if (gearData.paired_slots?.[type]) {
      // Step 1: Screen to get top-K candidates
      const pairedData = gearData.paired_slots[type];
      const screenCandidates = pairedSlotScreenCandidates(pairedData);
      const screenSlotKey = `${type}_screen`;

      console.log(
        `\nPhase ${phase}: Screening ${type} (${screenCandidates.length} candidates, ${fidelity} fidelity)`,
      );

      checkAplWarnings(screenCandidates, type);

      const screenRanked = await screenSlot(
        screenSlotKey,
        screenCandidates,
        gearData,
        fidelity,
        builds,
      );

      const minAdvancing = pairedData.topK || 4;
      const { advancing, pruned } = pruneResults(
        screenRanked,
        0.5,
        minAdvancing,
      );

      printSlotResults(type, screenRanked, gearData);

      clearGearResults(phase, screenSlotKey);
      saveGearResults(phase, screenSlotKey, screenRanked, fidelity);

      console.log(
        `\nAdvancing ${advancing.filter((r) => r.id !== "__baseline__").length} candidates to pair sim (within 0.5%, min ${minAdvancing})`,
      );
      if (pruned.length > 0) {
        console.log(`Eliminated ${pruned.length} candidates.`);
      }

      setSessionState(`gear_phase${phase}_${type}`, {
        advancing: advancing.map((r) => r.id),
        pruned: pruned.map((r) => r.id),
        fidelity,
        timestamp: new Date().toISOString(),
      });

      // Step 2: Generate C(K,2) pairs from screen top-K
      pairs = generatePairedSlotCombinations(type, gearData, phase);
      if (pairs.length === 0) {
        console.log(`No valid pairs for ${type} after screening.`);
        continue;
      }
      console.log(`Generated ${pairs.length} ${type} pairs from screen top-K`);
    } else if (type === "embellishments") {
      pairs = [...gearData.embellishments.pairs];
      if (gearData.embellishments.null_overrides?.length) {
        pairs.push({
          id: "__null_emb__",
          label: "No Embellishment (Crafted Base)",
          overrides: gearData.embellishments.null_overrides,
        });
      }
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
      `\nPhase ${phase}: ${type} pair sims — ${pairs.length} pairs x ${builds.length} builds x ${scenarioCount} scenarios (${fidelity} fidelity)`,
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

    // Null baseline is a reference point, never a candidate to eliminate
    const nullEntry = ranked.find((r) => r.id === "__null_emb__");
    if (nullEntry?.eliminated) {
      nullEntry.eliminated = false;
      const idx = pruned.indexOf(nullEntry);
      if (idx !== -1) {
        pruned.splice(idx, 1);
        advancing.push(nullEntry);
      }
    }

    // Significance gate: only apply the winner if it beats the current profile
    // baseline by more than target_error%. Otherwise mark all combos as eliminated.
    const fidelityConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.standard;
    const targetError = fidelityConfig.target_error;
    const baselineDps =
      ranked.find((r) => r.id === "__baseline__")?.weighted ?? 0;
    const bestCombo = ranked.find(
      (r) =>
        r.id !== "__baseline__" && r.id !== "__null_emb__" && !r.eliminated,
    );
    if (
      bestCombo &&
      !isSignificant(bestCombo.weighted, baselineDps, targetError)
    ) {
      const deltaPct = baselineDps
        ? (((bestCombo.weighted - baselineDps) / baselineDps) * 100).toFixed(2)
        : "?";
      console.log(
        `  No significant improvement from ${type} swap (best delta ${deltaPct}%, threshold ${targetError}%) — keeping current.`,
      );
      for (const r of ranked) {
        if (r.id !== "__baseline__" && r.id !== "__null_emb__")
          r.eliminated = true;
      }
    }

    printSlotResults(type, ranked, gearData);

    clearGearResults(phase, type);
    saveGearResults(phase, type, ranked, fidelity, type);

    setSessionState(`gear_phase${phase}_${type}_pairs`, {
      advancing: advancing.map((r) => r.id),
      pruned: pruned.map((r) => r.id),
      fidelity,
      timestamp: new Date().toISOString(),
    });
  }
}

// Generate C(K,2) pairs from a single paired slot pool using screen phase results
function generatePairedSlotCombinations(poolName, gearData, screenPhase) {
  const pairedData = gearData.paired_slots[poolName];
  if (!pairedData) return [];

  const topK = pairedData.topK || 5;

  // Screen results are stored under "<poolName>_screen" slot key in the screen phase
  const screenSlotKey = `${poolName}_screen`;
  const screenResults = getGearResults(screenPhase, screenSlotKey).filter(
    (r) => !r.eliminated && r.candidate_id !== "__baseline__",
  );

  const topCandidates = screenResults.slice(0, topK);
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

      // Skip pairs where both items are unique-equipped — they cannot be worn simultaneously.
      if (cA.uniqueEquipped && cB.uniqueEquipped) continue;

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

// --- CLI: stat-optimize (Phase 2) ---

async function cmdStatOptimize(args) {
  const fidelity = parseFidelity(args, "standard");
  const gearData = loadGearCandidates();
  const baseProfile = getBaseProfile(gearData);

  // Auto-detect crafted slots from the gear target (profile.simc), not the sim baseline.
  const craftedSlots = detectCraftedSlots(getGearTarget(gearData));
  if (craftedSlots.length === 0) {
    console.log(
      "No crafted items found in profile.simc, skipping stat optimization.",
    );
    return;
  }

  const builds = getRepresentativeBuilds();

  for (const craftedSlot of craftedSlots) {
    const slotData = gearData.slots[craftedSlot];
    if (!slotData || slotData.candidates.length === 0) {
      console.log(`No candidates for crafted slot: ${craftedSlot}, skipping.`);
      continue;
    }

    // Find the first candidate with crafted_stats in this slot
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
      `\nStat optimization: ${craftedSlot} (${CRAFTED_STAT_PAIRS.length} stat pairs, ${fidelity} fidelity)`,
    );

    const variants = CRAFTED_STAT_PAIRS.map((pair) => {
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
    const candidates = CRAFTED_STAT_PAIRS.map((p) => ({
      id: `${craftedSlot}_${p.id}`,
      label: `${craftedSlot}: ${p.label}`,
    }));
    const ranked = aggregateGearResults(results, candidates, builds);

    printSlotResults(`${craftedSlot} stat alloc`, ranked, gearData);

    clearGearResults(2, craftedSlot);
    saveGearResults(2, craftedSlot, ranked, fidelity);

    setSessionState(`gear_phase2_${craftedSlot}`, {
      best: ranked.find((r) => r.id !== "__baseline__")?.id,
      fidelity,
      timestamp: new Date().toISOString(),
    });
  }
}

// --- CLI: validate (Phase 11) ---

async function cmdValidate(args) {
  const fidelity = parseFidelity(args, "confirm");
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const tierConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.confirm;
  const baseProfile = getBaseProfile(gearData);

  const gearLines = buildGearLines(gearData);
  if (gearLines.length === 0) {
    console.log("No gear pipeline results. Run phases 0-10 first.");
    return;
  }

  console.log(
    `\nPhase 11: Validation — assembled gear at ${fidelity} fidelity`,
  );
  console.log(
    `Fidelity: ${fidelity} (target_error=${tierConfig.target_error})`,
  );
  console.log(`Gear overrides: ${gearLines.length} slots`);

  const variants = [{ name: "assembled_gear", overrides: gearLines }];
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
    [{ id: "assembled_gear", label: "Assembled Gear" }],
    builds,
  );

  printSlotResults("validation", ranked, gearData);

  clearGearResults(11);
  saveGearResults(11, null, ranked, fidelity);

  // Compare assembled gear vs baseline (original profile).
  // SAFETY GATE: If assembled gear is worse than the original profile, block write-profile.
  const assembledEntry = ranked.find((r) => r.id === "assembled_gear");
  const baselineEntry = ranked.find((r) => r.id === "__baseline__");
  const assembledDps = assembledEntry?.weighted ?? 0;
  const baselineDps = baselineEntry?.weighted ?? 0;
  let validationPassed = true;

  if (baselineDps > 0 && assembledDps > 0) {
    const deltaPct = ((assembledDps - baselineDps) / baselineDps) * 100;
    console.log(`\n--- Profile Comparison ---`);
    console.log(
      `  Original profile: ${Math.round(baselineDps).toLocaleString()} weighted`,
    );
    console.log(
      `  Assembled gear:   ${Math.round(assembledDps).toLocaleString()} weighted`,
    );
    console.log(`  Delta: ${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(2)}%`);
    if (deltaPct < -tierConfig.target_error) {
      console.log(
        `\n  WARNING: Assembled gear is WORSE than original profile by ${Math.abs(deltaPct).toFixed(2)}%.`,
      );
      console.log(
        `  write-profile will NOT run automatically. Fix gear candidates and re-run.`,
      );
      validationPassed = false;
    } else {
      console.log(`  Assembled gear meets quality gate.`);
    }
  }

  // Check for build divergence
  if (assembledEntry?.buildDps) {
    const buildKeys = Object.keys(assembledEntry.buildDps);
    if (buildKeys.length >= 2) {
      console.log("\n--- Build Divergence Check ---");
      for (const bk of buildKeys) {
        const buildScenarios = assembledEntry.buildDps[bk];
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

  setSessionState("gear_phase11", {
    validationPassed,
    assembledDps,
    baselineDps,
    fidelity,
    timestamp: new Date().toISOString(),
  });
}

// Returns true if Phase 11 validation passed (assembled gear >= original profile).
export function isGearValidationPassed() {
  const state = getSessionState("gear_phase11");
  return state?.validationPassed !== false;
}

// --- Profile write ---

function applyEnchant(line, enchantId) {
  if (!enchantId || line.includes("enchant_id=")) return line;
  return `${line},enchant_id=${enchantId}`;
}

// Apply the correct enchant for a given individual slot based on Phase 10 results.
function applySlotEnchant(line, slot, enchantMap) {
  const SLOT_ENCHANT = {
    main_hand: "weapon_mh",
    off_hand: "weapon_oh",
    back: "cloak",
    wrists: "wrist",
    wrist: "wrist",
    feet: "foot",
    finger1: "ring",
    finger2: "ring",
  };
  const enchantKey = SLOT_ENCHANT[slot];
  return enchantKey ? applyEnchant(line, enchantMap[enchantKey]) : line;
}

// Apply Phase 2 stat alloc to a crafted_stats simc line.
function applyStatAlloc(line, slot) {
  if (!line.includes("crafted_stats=")) return line;
  const statState = getSessionState(`gear_phase2_${slot}`);
  if (!statState?.best) return line;
  const pairId = statState.best.replace(new RegExp(`^${slot}_`), "");
  const pair = CRAFTED_STAT_PAIRS.find((p) => p.id === pairId);
  return pair
    ? line.replace(
        /crafted_stats=\d+\/\d+/,
        `crafted_stats=${pair.crafted_stats}`,
      )
    : line;
}

// Build enchant map from Phase 10 results: enchant_slot_key → enchant_id
function buildEnchantMap(gearData) {
  const enchantMap = {};
  for (const [enchantSlot, enchantData] of Object.entries(
    gearData.enchants || {},
  )) {
    const results = getBestGear(10, enchantSlot);
    if (results.length > 0) {
      const candidate = enchantData.candidates.find(
        (c) => c.id === results[0].candidate_id,
      );
      if (candidate) enchantMap[enchantSlot] = candidate.enchant_id;
    }
  }
  return enchantMap;
}

// Reconstruct SimC lines for the selected tier configuration.
// Returns an array of { slot, simc } objects.
function getTierLines(gearData) {
  const phase0 = getSessionState("gear_phase0");
  if (!phase0 || !gearData.tier) return [];

  if (phase0.best === "all_tier_5pc") {
    return Object.entries(gearData.tier.items).map(([slot, simc]) => ({
      slot,
      simc,
    }));
  }

  const match = phase0.best.match(/^skip_([^_]+)_(.+)$/);
  if (!match) return [];

  const [, skipSlot, altId] = match;
  return Object.entries(gearData.tier.items).map(([slot, simc]) => {
    if (slot === skipSlot) {
      const alt = gearData.tier.alternatives[slot]?.find((a) => a.id === altId);
      return alt ? { slot, simc: alt.simc } : { slot, simc };
    }
    return { slot, simc };
  });
}

// Collect best gear lines from all pipeline phases.
// Priority (highest wins, each covers its slots):
//   Phase 7:  embellishments
//   set_eval: set bonus winners for their slots
//   Phase 5:  trinkets
//   Phase 4:  proc eval winners for individual slots
//   Phase 3:  EP ranking winners for remaining individual slots
//   Phase 0:  tier config (tier slots)
// Phase 2 stat alloc applied to crafted_stats lines.
// Phase 9 gems applied to all socketed items.
// Phase 10 enchants applied to all relevant slots.
function buildGearLines(gearData) {
  const lines = [];
  const coveredSlots = new Set();
  const enchantMap = buildEnchantMap(gearData);

  function addLine(line, slot) {
    lines.push(line);
    coveredSlots.add(slot);
    if (slot === "wrist") coveredSlots.add("wrists");
    if (slot === "wrists") coveredSlots.add("wrist");
  }

  // Phase 0: tier config
  for (const { slot, simc } of getTierLines(gearData)) {
    addLine(simc, slot);
  }

  // Phase 7: embellishments (highest priority for those slots)
  const emb = getBestGear(7, "embellishments").find(
    (r) => r.candidate_id !== "__baseline__",
  );
  if (emb) {
    const overrides = resolveComboOverrides(emb.candidate_id, gearData);
    for (const line of overrides) {
      const slot = line.split("=")[0];
      if (!coveredSlots.has(slot)) {
        addLine(applyStatAlloc(line, slot), slot);
      }
    }
  }

  // Set eval: auto-generated pair winners cover their specific slots
  const setEvalPairs = getSessionState("gear_set_eval_pairs") || [];
  for (const pairId of setEvalPairs) {
    const state = getSessionState(`gear_set_eval_${pairId}`);
    if (!state?.winner) continue;

    const { member0, member1, slot0, slot1 } = state;
    const winnerId = state.winner;

    const includeA = !winnerId.endsWith("_B_alone");
    const includeB = !winnerId.endsWith("_A_alone");

    if (includeA) {
      const c0 = gearData.slots[slot0]?.candidates.find(
        (c) => c.id === member0,
      );
      if (c0 && !coveredSlots.has(slot0)) {
        addLine(
          applySlotEnchant(applyStatAlloc(c0.simc, slot0), slot0, enchantMap),
          slot0,
        );
      }
    }
    if (includeB) {
      const c1 = gearData.slots[slot1]?.candidates.find(
        (c) => c.id === member1,
      );
      if (c1 && !coveredSlots.has(slot1)) {
        addLine(
          applySlotEnchant(applyStatAlloc(c1.simc, slot1), slot1, enchantMap),
          slot1,
        );
      }
    }
  }

  // Phase 5: trinkets
  const trinketWinner = getBestGear(5, "trinkets").find(
    (r) => r.candidate_id !== "__baseline__",
  );
  if (trinketWinner) {
    const overrides = resolveComboOverrides(
      trinketWinner.candidate_id,
      gearData,
    );
    for (const line of overrides) {
      const slot = line.split("=")[0];
      if (!coveredSlots.has(slot)) addLine(line, slot);
    }
  }

  // Phase 4: proc eval winners for individual slots
  for (const slot of Object.keys(gearData.slots || {})) {
    if (coveredSlots.has(slot)) continue;
    const procResult = getBestGear(4, slot)[0];
    if (!procResult || procResult.candidate_id === "__baseline__") continue;
    const candidate = gearData.slots[slot].candidates.find(
      (c) => c.id === procResult.candidate_id,
    );
    if (!candidate) continue;
    const line = applyStatAlloc(candidate.simc, slot);
    addLine(applySlotEnchant(line, slot, enchantMap), slot);
  }

  // Phase 3: EP ranking winners for remaining individual slots
  for (const slot of Object.keys(gearData.slots || {})) {
    if (coveredSlots.has(slot)) continue;
    const epResult = getBestGear(3, slot)[0];
    if (!epResult || epResult.candidate_id === "__baseline__") continue;
    const candidate = gearData.slots[slot].candidates.find(
      (c) => c.id === epResult.candidate_id,
    );
    if (!candidate) continue;
    const line = applyStatAlloc(candidate.simc, slot);
    addLine(applySlotEnchant(line, slot, enchantMap), slot);
  }

  // Phase 9: apply best gem to all socketed items.
  // Uses item_id (SimC gem_id= expects item IDs, not enchant IDs).
  const gemState = getSessionState("gear_gems");
  const gemItemId = gemState?.best_item_id || gemState?.best_enchant_id;
  if (gemItemId) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("gem_id=")) continue;
      const match = lines[i].match(/gem_id=([\d/]+)/);
      if (match) {
        const socketCount = match[1].split("/").length;
        const newGems = Array(socketCount).fill(gemItemId).join("/");
        lines[i] = lines[i].replace(/gem_id=[\d/]+/, `gem_id=${newGems}`);
      }
    }
  }

  return lines;
}

// Write best gear from all pipeline phases back to profile.simc.
// For slots where the item hasn't changed, the current line is preserved
// (keeping existing gem and enchant suffixes). Changed slots use the pipeline result.
function cmdWriteProfile() {
  const gearData = loadGearCandidates();
  const newLines = buildGearLines(gearData);

  if (newLines.length === 0) {
    console.log("No gear pipeline results. Run the gear pipeline first.");
    return;
  }

  const profilePath = getGearTarget(gearData);

  const GEAR_SLOT_RE =
    /^(head|shoulder|chest|hands|legs|neck|back|wrist|wrists|waist|feet|finger\d|trinket\d|main_hand|off_hand)=/;

  const currentLines = existsSync(profilePath)
    ? readFileSync(profilePath, "utf-8").split("\n")
    : [];

  // Split current profile into preamble and gear slot map
  const currentGear = new Map();
  const preamble = [];
  for (const line of currentLines) {
    if (GEAR_SLOT_RE.test(line)) {
      currentGear.set(line.split("=")[0], line);
    } else if (currentGear.size === 0) {
      preamble.push(line);
    }
  }
  while (preamble.length > 0 && preamble.at(-1).trim() === "") preamble.pop();

  const itemId = (line) => line.match(/,id=(\d+)/)?.[1] ?? null;

  // Preserve current line when item is unchanged (keeps gems/enchants not tracked by pipeline).
  // Exception: if the pipeline line specifies embellishment= or crafted_stats=, those are
  // pipeline-controlled and must NOT be overridden by the current line.
  const finalLines = newLines.map((line) => {
    const slot = line.split("=")[0];
    const cur = currentGear.get(slot);
    if (!cur || itemId(cur) !== itemId(line)) return line;
    // Pipeline controls embellishment and crafted_stats — use pipeline line but copy gem_id
    if (line.includes("embellishment=") || line.includes("crafted_stats=")) {
      if (!line.includes("gem_id=")) {
        const curGem = cur.match(/gem_id=([\d/]+)/);
        if (curGem) return `${line},gem_id=${curGem[1]}`;
      }
      return line;
    }
    return cur;
  });

  // Any slot in the current profile not covered by the pipeline is preserved as-is.
  // This prevents tier slots (managed by phase 0) from being dropped when session
  // state is missing (e.g., write-profile called standalone).
  const coveredSlots = new Set(finalLines.map((l) => l.split("=")[0]));
  for (const [slot, line] of currentGear) {
    if (!coveredSlots.has(slot)) finalLines.push(line);
  }

  // Sort into canonical SimC slot order for readability
  const SLOT_ORDER = [
    "head",
    "neck",
    "shoulder",
    "back",
    "chest",
    "wrist",
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
  finalLines.sort((a, b) => {
    const ai = SLOT_ORDER.indexOf(a.split("=")[0]);
    const bi = SLOT_ORDER.indexOf(b.split("=")[0]);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  writeFileSync(
    profilePath,
    [...preamble, "", ...finalLines, ""].join("\n"),
    "utf-8",
  );

  const numChanged = finalLines.filter(
    (l) => currentGear.get(l.split("=")[0]) !== l,
  ).length;
  console.log(`Profile updated: ${profilePath}`);
  console.log(`  ${finalLines.length} slots written (${numChanged} changed).`);
}

// --- CLI: run (automated pipeline) ---

async function cmdRun(args) {
  const { values } = parseArgs({
    args,
    options: {
      through: { type: "string", default: "phase11" },
    },
    strict: false,
  });

  const phaseMatch = values.through.match(/^phase(\d+)$/);
  const maxPhase = phaseMatch ? parseInt(phaseMatch[1]) : 11;

  // If an explicit fidelity flag was given, forward it to all phases.
  // Otherwise each phase uses its own default.
  const explicit = parseFidelity(args, null);
  const fidelityArgs = explicit ? ["--fidelity", explicit] : [];

  if (maxPhase >= 0) {
    console.log("\n========== PHASE 0: Tier Configuration ==========\n");
    await cmdTierConfig(fidelityArgs);
  }
  if (maxPhase >= 1) {
    console.log("\n========== PHASE 1: Scale Factors ==========\n");
    await cmdScaleFactors(fidelityArgs);
  }
  if (maxPhase >= 2) {
    console.log("\n========== PHASE 2: Stat Optimization ==========\n");
    await cmdStatOptimize(fidelityArgs);
  }

  const gearData = loadGearCandidates();

  if (maxPhase >= 3) {
    console.log("\n========== PHASE 3: EP Ranking ==========\n");
    cmdEpRank(gearData);
  }
  if (maxPhase >= 4) {
    console.log("\n========== PHASE 4: Weapon Evaluation ==========\n");
    await cmdProcEval(fidelityArgs);
    console.log("\n========== PHASE 4b: Set Evaluation ==========\n");
    await cmdEvalSets(fidelityArgs);
  }
  if (maxPhase >= 5) {
    console.log("\n========== PHASE 5: Trinkets ==========\n");
    await cmdCombinations(["--type", "trinkets", ...fidelityArgs]);
  }
  if (maxPhase >= 7) {
    console.log("\n========== PHASE 7: Embellishments ==========\n");
    if (gearData.embellishments?.pairs?.length > 0) {
      await cmdCombinations(["--type", "embellishments", ...fidelityArgs]);
    } else {
      console.log("No embellishment pairs configured, skipping.");
    }
  }
  if (maxPhase >= 8) {
    console.log("\n========== PHASE 8: Stat Re-optimization ==========\n");
    await cmdStatOptimize(fidelityArgs);
  }
  if (maxPhase >= 9) {
    console.log("\n========== PHASE 9: Gems ==========\n");
    cmdGems(gearData);
  }
  if (maxPhase >= 10) {
    console.log("\n========== PHASE 10: Enchants ==========\n");
    await cmdEnchants(fidelityArgs);
  }
  if (maxPhase >= 11) {
    console.log("\n========== PHASE 11: Validation ==========\n");
    await cmdValidate(fidelityArgs);
  }

  const phase11State = getSessionState("gear_phase11");
  if (phase11State?.validationPassed === false) {
    console.log(
      "\n========== PIPELINE BLOCKED: Gear regression detected ==========\n",
    );
    console.log(
      "  Assembled gear is worse than the original profile. profile.simc NOT updated.",
    );
    console.log("  Fix gear candidates and re-run the pipeline to proceed.");
  } else {
    console.log("\n========== Writing profile.simc ==========\n");
    cmdWriteProfile();
  }

  console.log("\n========== Pipeline Complete ==========\n");
  cmdStatus();

  await stopRemote();
}

// --- CLI: status ---

function cmdStatus() {
  const gearData = loadGearCandidates();

  console.log("\n=== Gear Pipeline Status ===\n");

  // Phase 0: tier config
  const phase0 = getSessionState("gear_phase0");
  console.log("Phase 0 (Tier Configuration):");
  if (phase0) {
    console.log(
      `  Best: ${phase0.best} (${phase0.fidelity}, ${phase0.timestamp})`,
    );
  } else {
    console.log("  not started");
  }

  // Phase 1: scale factors
  const sf = getSessionState("gear_scale_factors");
  console.log("\nPhase 1 (Scale Factors):");
  if (sf?.timestamp) {
    const vals = ["Agi", "Haste", "Crit", "Mastery", "Vers"]
      .filter((k) => sf[k] != null)
      .map((k) => `${k}=${sf[k].toFixed(3)}`)
      .join(" ");
    console.log(`  ${vals} (${sf.timestamp})`);
  } else {
    console.log("  not started");
  }

  // Phase 2: stat optimization (crafted slots auto-detected from profile.simc)
  console.log("\nPhase 2 (Stat Optimization):");
  const craftedSlotsStatus = detectCraftedSlots(getGearTarget(gearData));
  if (craftedSlotsStatus.length > 0) {
    for (const craftedSlot of craftedSlotsStatus) {
      const state = getSessionState(`gear_phase2_${craftedSlot}`);
      if (state) {
        console.log(
          `  ${craftedSlot.padEnd(20)} best: ${state.best} (${state.fidelity})`,
        );
      } else {
        console.log(`  ${craftedSlot.padEnd(20)} not started`);
      }
    }
  } else {
    console.log("  no crafted items in profile.simc");
  }

  // Phase 3: EP ranking
  const phase3 = getSessionState("gear_phase3");
  console.log("\nPhase 3 (EP Ranking):");
  if (phase3?.timestamp) {
    const epSlotCount = Object.keys(gearData.slots || {}).filter(
      (s) => !ALWAYS_SIM_SLOTS.has(s),
    ).length;
    console.log(`  ${epSlotCount} slots ranked (${phase3.timestamp})`);
  } else {
    console.log("  not started");
  }

  // Phase 4: weapon eval (all candidates in ALWAYS_SIM_SLOTS)
  console.log("\nPhase 4 (Weapon Evaluation):");
  for (const slot of ALWAYS_SIM_SLOTS) {
    if (!gearData.slots?.[slot]) continue;
    const results = getGearResults(4, slot);
    if (results.length > 0) {
      const significant = results.filter(
        (r) => !r.eliminated && r.candidate_id !== "__baseline__",
      ).length;
      console.log(
        `  ${slot.padEnd(20)} ${results.length} evaluated, ${significant} significant`,
      );
    } else {
      console.log(`  ${slot.padEnd(20)} not started`);
    }
  }

  // Set evaluation (Phase 4b) — auto-generated from Phase 4 winners
  const setEvalPairsStatus = getSessionState("gear_set_eval_pairs");
  if (setEvalPairsStatus?.length > 0) {
    console.log("\nSet Evaluation (Phase 4b):");
    for (const pairId of setEvalPairsStatus) {
      const state = getSessionState(`gear_set_eval_${pairId}`);
      if (state?.winner) {
        console.log(
          `  ${pairId.slice(0, 20).padEnd(20)} winner: ${state.winner} (${state.fidelity})`,
        );
      } else if (state === null) {
        console.log(
          `  ${pairId.slice(0, 20).padEnd(20)} completed — no significant improvement`,
        );
      } else {
        console.log(`  ${pairId.slice(0, 20).padEnd(20)} not started`);
      }
    }
  }

  // Phase 5: trinkets
  const trinketScreen = getSessionState("gear_phase5_trinkets");
  const trinketPairs = getSessionState("gear_phase5_trinkets_pairs");
  console.log("\nPhase 5 (Trinkets):");
  if (trinketScreen) {
    console.log(
      `  Screen: ${trinketScreen.advancing.length} advancing (${trinketScreen.fidelity})`,
    );
  } else {
    console.log("  screen: not started");
  }
  if (trinketPairs) {
    console.log(
      `  Pairs:  ${trinketPairs.advancing.length} advancing, ${trinketPairs.pruned.length} pruned`,
    );
  } else {
    console.log("  pairs:  not started");
  }

  // Phase 7: embellishments
  const embResults = getBestGear(7, "embellishments");
  console.log("\nPhase 7 (Embellishments):");
  if (embResults.length > 0) {
    console.log(`  Best: ${embResults[0].label}`);
  } else if (!gearData.embellishments?.pairs?.length) {
    console.log("  no embellishment pairs configured");
  } else {
    console.log("  not started");
  }

  // Phase 9: gems
  const gemState = getSessionState("gear_gems");
  console.log("\nPhase 9 (Gems):");
  if (gemState?.best_label) {
    console.log(
      `  Best: ${gemState.best_label} (EP: ${gemState.ep?.toFixed(1)}, ${gemState.timestamp})`,
    );
  } else {
    console.log("  not started");
  }

  // Phase 10: enchants
  console.log("\nPhase 10 (Enchants):");
  for (const enchantSlot of Object.keys(gearData.enchants || {})) {
    const results = getBestGear(10, enchantSlot);
    if (results.length > 0) {
      console.log(`  ${enchantSlot.padEnd(20)} best: ${results[0].label}`);
    } else {
      console.log(`  ${enchantSlot.padEnd(20)} not started`);
    }
  }

  // Phase 11: validation
  const phase11 = getSessionState("gear_phase11");
  console.log("\nPhase 11 (Validation):");
  if (phase11) {
    console.log(`  Validated: ${phase11.fidelity} (${phase11.timestamp})`);
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
    for (const p of [0, 2, 3, 4, SET_EVAL_PHASE, 5, 6, 7, 10, 11]) {
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
  const tierLines = getTierLines(gearData);
  if (tierLines.length > 0) {
    const phase0 = getSessionState("gear_phase0");
    console.log(`# Tier config: ${phase0.best}`);
    for (const { simc } of tierLines) {
      console.log(simc);
    }
  }

  // Phase 5/6/7: combination winners (trinkets, rings, embellishments)
  for (const [type, phase] of Object.entries(COMBO_PHASES)) {
    const winner = getBestGear(phase, type).find(
      (r) => r.candidate_id !== "__baseline__",
    );
    if (!winner) continue;
    console.log(`# Best ${type}: ${winner.label}`);
    for (const override of resolveComboOverrides(
      winner.candidate_id,
      gearData,
    )) {
      console.log(override);
    }
  }

  // Phase 3/4 winners for individual slots
  for (const slot of Object.keys(gearData.slots)) {
    // Phase 4 proc eval takes priority
    const procResult = getBestGear(4, slot)[0];
    const epResult = getBestGear(3, slot)[0];
    const result = procResult ?? epResult;
    if (!result || result.candidate_id === "__baseline__") continue;
    const candidate = gearData.slots[slot].candidates.find(
      (c) => c.id === result.candidate_id,
    );
    if (candidate) {
      const phaseLabel = procResult ? "Phase 4 proc" : "Phase 3 EP";
      console.log(`# ${slot}: ${candidate.label} (${phaseLabel})`);
      console.log(candidate.simc);
    }
  }

  // Phase 10 winners for enchant slots
  for (const enchantSlot of Object.keys(gearData.enchants || {})) {
    const result = getBestGear(10, enchantSlot)[0];
    if (!result) continue;
    const enchantData = gearData.enchants[enchantSlot];
    const candidate = enchantData.candidates.find(
      (c) => c.id === result.candidate_id,
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

  // Phase 2 stat winners
  for (const craftedSlot of detectCraftedSlots(getGearTarget(gearData))) {
    const state = getSessionState(`gear_phase2_${craftedSlot}`);
    if (state?.best) {
      console.log(`# ${craftedSlot} stat alloc: ${state.best}`);
    }
  }

  // Phase 9: best gem
  const gemState = getSessionState("gear_gems");
  if (gemState?.best_label) {
    console.log(
      `# Gem: ${gemState.best_label} (enchant_id=${gemState.best_enchant_id})`,
    );
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
      const key = stripBuildPrefix(variant.name);
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

    const { avg, weighted } = computeWeightedDps(data.scenarioDps);

    rows.push({
      candidate_id: candidateId,
      label: candidate?.label || candidateId,
      ilvl,
      dps_st: avg.st || 0,
      dps_dungeon_route: avg.dungeon_route || 0,
      dps_small_aoe: avg.small_aoe || 0,
      dps_big_aoe: avg.big_aoe || 0,
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
  const fidelity = parseFidelity(args, "quick");
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
  case "scale-factors":
    await cmdScaleFactors(cleanArgs);
    break;
  case "screen":
    await cmdScreen(cleanArgs);
    break;
  case "ep-rank": {
    const gd = loadGearCandidates();
    cmdEpRank(gd);
    break;
  }
  case "proc-eval":
    await cmdProcEval(cleanArgs);
    break;
  case "set-eval":
    await cmdEvalSets(cleanArgs);
    break;
  case "combinations":
    await cmdCombinations(cleanArgs);
    break;
  case "stat-optimize":
    await cmdStatOptimize(cleanArgs);
    break;
  case "gems": {
    const gd = loadGearCandidates();
    cmdGems(gd);
    break;
  }
  case "enchants":
    await cmdEnchants(cleanArgs);
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
  case "write-profile":
    cmdWriteProfile();
    break;
  case "trinket-chart":
    await cmdTrinketChart(cleanArgs);
    break;
  default:
    console.log(`Usage: node src/sim/gear.js <command> [options]

Commands:
  tier-config     Phase 0:  Test tier set configurations (which slot to skip)
  scale-factors   Phase 1:  Compute EP stat weights via scale factors sim
  stat-optimize   Phase 2:  Optimize crafted stat allocations
  ep-rank         Phase 3:  EP-rank stat-stick items (proc/on-use excluded)
  proc-eval       Phase 4:  Sim proc/on-use items vs stat-stick baseline
  set-eval        Phase 4b: Evaluate set bonuses (A-alone, B-alone, full-set)
  combinations    Phase 5-7: Screen + pair sims for trinkets/rings/embellishments
  gems            Phase 9:  EP-rank gems
  enchants        Phase 10: EP-rank stat enchants; sim weapon/ring enchants
  validate        Phase 11: Confirm assembled gear at high fidelity
  run             Run full pipeline (--through phase0|...|phase11)
  status          Show pipeline progress
  results         Show stored results (--slot X --phase N)
  export          Export best gear as SimC overrides
  write-profile   Write best gear from pipeline back to profile.simc
  screen          Screen individual slot candidates (diagnostic)
  trinket-chart   Sim all trinkets at multiple ilvl tiers for chart visualization

Options:
  --spec X        Spec name (or SPEC env var)
  --slot X        Target a specific slot or enchant slot
  --fidelity X    quick|standard|confirm
  --through X     Stop after phase (for 'run' command)
  --type X        Combination type (trinkets|rings|embellishments)
`);
    break;
}

closeAll();
