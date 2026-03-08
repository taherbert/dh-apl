// EP-based gear optimization pipeline. Derives stat weights from scale factors,
// EP-ranks stat-stick items (no per-item sims), and sim-evaluates proc items,
// trinkets, rings, and embellishments. Assembles and validates final profile.
//
// Phases:
//   0  tier-config    Tier set selection (sim-based)
//   1  scale-factors  Per-scenario scale factors weighted by SCENARIO_WEIGHTS
//  1b  ep-reweight    Iterative EP reweighting using DPS plot curves
//   2  stat-optimize  Optimize crafted item stat budgets
//   3  ep-rank        Pure EP scoring for stat-stick items only (proc/on-use/set items excluded)
//  3b  combo-validate Combinatorial validation of top-2 per EP-ranked slot
//   4  proc-eval      Sim proc/on-use items vs stat-stick baseline; significance gated
//   4b set-eval       Set bonus evaluation: A-alone, B-alone, full-set; significance gated
//   5  trinkets       Screen + pair sims; significance gated
//   6  (removed — rings are EP-ranked in Phase 3)
//   7  embellishments Screen + pair sims; significance gated
//  7.5 resolve-conflicts Ring set vs embellishment conflict resolution
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
//   SPEC=vengeance node src/sim/gear.js resolve-conflicts
//   SPEC=vengeance node src/sim/gear.js gems
//   SPEC=vengeance node src/sim/gear.js enchants
//   SPEC=vengeance node src/sim/gear.js validate [--fidelity confirm]
//   SPEC=vengeance node src/sim/gear.js write-profile
//   SPEC=vengeance node src/sim/gear.js status
//   SPEC=vengeance node src/sim/gear.js results [--slot X] [--phase N]
//   SPEC=vengeance node src/sim/gear.js export
//   SPEC=vengeance node src/sim/gear.js screen [--slot X]  (diagnostic only)

import { getSimCores } from "./remote.js";
import { readRouteFile, execSimcWithFallback } from "./runner.js";
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
const DPS_PLOT_STEP = 300;

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
  { extraBaseOverrides } = {},
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

    const baseOverrides = [
      `talents=${build.hash}`,
      ...(extraBaseOverrides || []),
    ];
    const content = generateProfileset(
      baseProfile,
      buildVariants,
      baseOverrides,
    );
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

  // Pick top 3 builds, prioritizing hero tree diversity.
  // Roster is sorted by weighted DESC.
  const seen = new Set();
  const picks = [];
  for (const build of roster) {
    if (picks.length >= 3) break;
    const tree = build.hero_tree || build.heroTree;
    if (picks.length === 0) {
      picks.push(build);
      seen.add(tree);
      continue;
    }
    // Prioritize unseen hero trees
    if (!seen.has(tree)) {
      picks.push(build);
      seen.add(tree);
    } else if (picks.length < 3) {
      picks.push(build);
    }
  }
  return picks;
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

function countSockets(simcStr) {
  const match = (simcStr || "").match(/gem_id=([\d/]+)/);
  return match ? match[1].split("/").length : 0;
}

function isCraftedSimc(simcStr) {
  const s = simcStr || "";
  return (
    s.includes("crafted_stats=") ||
    s.includes("embellishment=") ||
    /bonus_id=[^,]*\b8793\b/.test(s)
  );
}

const MAX_CRAFTED = 2;

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
  { id: "vers_mastery", label: "Vers/Mastery", crafted_stats: "40/49" },
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

  // Use the top roster build's talents so scale factors reflect real gameplay.
  // Without talents, stat scaling is completely different (no procs, no multipliers).
  const builds = getRepresentativeBuilds();
  const topBuild = builds[0];

  const fidelityConfig = FIDELITY_TIERS[fidelity] || FIDELITY_TIERS.standard;
  mkdirSync(resultsDir(), { recursive: true });

  const { threadsPerSim } = simConcurrency(1);
  const statKeys = ["Agi", "Haste", "Crit", "Mastery", "Vers"];

  console.log(
    `\nPhase 1: Scale Factors (${fidelity} fidelity, ${threadsPerSim} threads)`,
  );
  console.log(`  Build: ${topBuild.label || topBuild.hash.slice(0, 16)}`);

  const perScenario = {};
  let baselineStats = null;

  for (const scenario of Object.keys(SCENARIOS)) {
    const scConfig = SCENARIOS[scenario];
    const outputPath = resultsFile(`gear_scale_factors_${scenario}.json`);

    const simArgs = [
      profilePath,
      `talents=${topBuild.hash}`,
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

    // DPS plot only on ST (used by Phase 1b reweighting)
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

    console.log(
      `    ${statKeys.map((s) => `${s}=${(perScenario[scenario][s] || 0).toFixed(3)}`).join(" ")}`,
    );

    // Extract baseline stats and DPS plot from ST scenario
    if (scenario === "st") {
      baselineStats = { crit: 0, haste: 0, mastery: 0, versatility: 0 };
      const gear = data.sim.players[0].gear;
      if (gear) {
        for (const item of Object.values(gear)) {
          for (const [key, val] of Object.entries(item)) {
            if (key.endsWith("_rating")) {
              const stat = key.replace("_rating", "");
              if (stat in baselineStats) baselineStats[stat] += val;
            }
          }
        }
        console.log(
          `    Baseline stats: ${Object.entries(baselineStats)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        );
      }

      const dpsPlot = data.sim.dps_plot;
      if (dpsPlot?.length) {
        const playerPlot = dpsPlot[0]?.data;
        if (playerPlot) {
          setSessionState("gear_stat_curves", {
            curves: playerPlot,
            baselineStats,
            step: DPS_PLOT_STEP,
            timestamp: new Date().toISOString(),
          });
          const statCount = playerPlot.reduce(
            (n, d) => n + Object.keys(d).length,
            0,
          );
          console.log(`    Stat curves: ${statCount} stats plotted`);
        }
      }
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

// --- Phase 1b: Iterative EP Reweighting ---
// Uses DPS plot curves from Phase 1 to recompute scale factors at the
// stat point implied by EP-ranked gear, iterating until stable.
// Breaks the self-reinforcing bias where scale factors computed at the
// current gear point lock the pipeline into a local stat optimum.

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
  return Object.keys(map).length > 0 ? map : null;
}

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

  if (hi.rating === lo.rating) return null;
  return (hi.dps - lo.dps) / (hi.rating - lo.rating);
}

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

// Map scale factor key names to SimC dps_plot stat names (used as curve map keys)
// and to the lowercase keys used in baselineStats.
const SF_TO_CURVE_STAT = {
  Crit: "crit",
  Haste: "haste",
  Mastery: "mastery",
  Vers: "versatility",
};

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

  // Compute scale factor to convert Raidbots candidate stats to SimC rating scale.
  // Raidbots stats are from live data (~70x larger than SimC Midnight branch).
  // We estimate the ratio using baseline SimC stats and the number of EP-ranked slots.
  const baselineTotalSimC = Object.values(curves.baselineStats).reduce(
    (s, v) => s + v,
    0,
  );
  const epSlotCount = Object.keys(gearData.slots || {}).filter(
    (s) => !ALWAYS_SIM_SLOTS.has(s),
  ).length;
  const totalSlots = 16;

  console.log(
    `\nPhase 1b: Iterative EP Reweighting (max ${MAX_ITERS} iterations)`,
  );

  for (let iter = 1; iter <= MAX_ITERS; iter++) {
    const winners = epRankAll(gearData, currentSf);
    const winnerKey = JSON.stringify(winners);
    if (winnerKey === prevWinners) {
      console.log(`  Iteration ${iter}: converged (no item changes).`);
      break;
    }
    prevWinners = winnerKey;

    const rawStats = computeGearStats(winners, gearData);
    const rawTotal = Object.values(rawStats).reduce((s, v) => s + v, 0);

    // Scale Raidbots stats to SimC rating: allocate baseline's EP-slot share proportionally
    const simcEpBudget = baselineTotalSimC * (epSlotCount / totalSlots);
    const scaleFactor = rawTotal > 0 ? simcEpBudget / rawTotal : 1;
    const scaledStats = {};
    for (const k of Object.keys(rawStats)) {
      scaledStats[k] = Math.round(rawStats[k] * scaleFactor);
    }

    console.log(
      `  Iteration ${iter}: ${statKeys.map((s) => `${s}=${scaledStats[s.toLowerCase()] || 0}`).join(" ")} (scale=${scaleFactor.toFixed(4)})`,
    );

    const newSf = { ...currentSf };
    for (const stat of statKeys) {
      const curveStat = SF_TO_CURVE_STAT[stat];
      const baselineStat =
        curveStat === "versatility" ? "versatility" : curveStat;
      const rating = scaledStats[stat.toLowerCase()] || 0;
      const derivative = interpolateDerivative(
        curveMap,
        curveStat,
        rating,
        curves.baselineStats[baselineStat] || 0,
        curves.step,
      );
      if (derivative != null) {
        newSf[stat] = derivative;
      }
    }

    currentSf = newSf;
  }

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

// --- Phase 3b: Combinatorial Validation ---
// Sims the cross-product of top-N candidates per EP-ranked slot.
// Catches stat synergies that per-slot EP ranking misses.

const COMBO_MAX = 512;

async function cmdCombinatorialValidation(args) {
  const fidelity = parseFidelity(args, "quick");
  const gearData = loadGearCandidates();
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  // Collect top-2 per EP-ranked slot (excluding sim-handled slots)
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

  // Generate cross-product combinations (with safety cap)
  let combos = [{}];
  for (const slot of slots) {
    const newCombos = [];
    for (const combo of combos) {
      for (const candidateId of slotOptions[slot]) {
        newCombos.push({ ...combo, [slot]: candidateId });
      }
    }
    combos = newCombos;
    if (combos.length > COMBO_MAX) {
      console.log(
        `  Warning: ${combos.length} combos exceeds cap (${COMBO_MAX}), truncating slots`,
      );
      break;
    }
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
    return { name: `combo_${i}`, overrides };
  });

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelity,
    "gear_combo_validation",
  );

  const aggregated = aggregateGearResults(
    results,
    variants.map((v) => ({ id: v.name })),
    builds,
  );

  const best = aggregated[0];
  const baseline = aggregated.find((r) => r.id === "__baseline__");
  console.log(
    `  Best combination: ${best.id} (weighted: ${best.weighted?.toFixed(0)})`,
  );
  if (baseline) {
    const delta =
      ((best.weighted - baseline.weighted) / baseline.weighted) * 100;
    console.log(`  vs baseline: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`);
  }

  clearGearResults(3.5, "combinations");
  saveGearResults(3.5, "combinations", aggregated, fidelity);

  // Store winning slot selections for assembly (or clear stale state if baseline wins)
  if (best.id !== "__baseline__") {
    const comboIdx = parseInt(best.id.replace("combo_", ""));
    const winningCombo = combos[comboIdx];
    setSessionState("gear_phase3b_winners", {
      combo: winningCombo,
      weighted: best.weighted,
      timestamp: new Date().toISOString(),
    });
    console.log("  Winning slots:", JSON.stringify(winningCombo));
  } else {
    setSessionState("gear_phase3b_winners", null);
    console.log("  Baseline wins — no combo overrides needed.");
  }
}

// --- CLI: ep-rank (Phase 3) ---

function cmdEpRank(gearData) {
  const sf = getSessionState("gear_scale_factors");
  if (!sf) throw new Error("Run gear:scale-factors (Phase 1) first");

  const hasEmbellishments = gearData.embellishments?.pairs?.length > 0;
  let totalRanked = 0;
  let finger1WinnerId = null;

  // Pre-compute best gem EP so socketed items get socket value in rankings.
  // Gems in simc strings are invisible to scoreEp() which only reads base stats.
  const bestGemEp = (gearData.gems || [])
    .filter((g) => g.stats)
    .reduce((max, g) => Math.max(max, scoreEp(g.stats, sf)), 0);

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
      .map((c) => ({
        ...c,
        ep: scoreEp(c.stats, sf) + countSockets(c.simc) * bestGemEp,
      }))
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
    saveGearResults(4, slot, ranked, fidelity);
  }
}

// Phase number for set evaluation results (between Phase 4 and Phase 5).
const SET_EVAL_PHASE = 45;

// Phase number for ring/embellishment conflict resolution (between Phase 7 and Phase 8).
const CONFLICT_RESOLUTION_PHASE = 75;

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

  // Shared logic: sim a set pair (A-alone, B-alone, full), significance-gate, save results.
  // extraBaseOverrides: optional overrides for the base profile (e.g., EP-best items for slots).
  async function evalSetPair({
    pairId,
    memberA,
    memberB,
    fullLabel,
    slot0,
    slot1,
    member0Id,
    member1Id,
    logPrefix,
    extraBaseOverrides,
  }) {
    evaluatedPairIds.push(pairId);

    const variants = [
      { name: `${pairId}_A_alone`, overrides: [memberA.simc] },
      { name: `${pairId}_B_alone`, overrides: [memberB.simc] },
      { name: `${pairId}_full`, overrides: [memberA.simc, memberB.simc] },
    ];

    const scenarioCount = Object.keys(SCENARIOS).length;
    console.log(
      `\n${logPrefix}: ${fullLabel} (A-alone, B-alone, full-set x ${builds.length} builds x ${scenarioCount} scenarios, ${fidelity} fidelity)`,
    );

    const results = await runBuildScenarioSims(
      variants,
      builds,
      baseProfile,
      fidelity,
      `gear_set_${pairId}`,
      { extraBaseOverrides },
    );
    const candidateMeta = [
      { id: `${pairId}_A_alone`, label: `${memberA.label} alone` },
      { id: `${pairId}_B_alone`, label: `${memberB.label} alone` },
      { id: `${pairId}_full`, label: fullLabel },
    ];
    const ranked = aggregateGearResults(results, candidateMeta, builds);

    const baselineEntry = ranked.find((r) => r.id === "__baseline__");
    const baselineDps = baselineEntry?.weighted ?? 0;
    const configs = ranked.filter((r) => r.id !== "__baseline__");
    const bestConfig = configs[0];

    const significant =
      bestConfig &&
      bestConfig.weighted > baselineDps &&
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
        member0: member0Id,
        member1: member1Id,
        slot0,
        slot1,
        fidelity,
        timestamp: new Date().toISOString(),
      });
      console.log(`  ${logPrefix} winner: ${bestConfig.label}`);
    } else {
      setSessionState(`gear_set_eval_${pairId}`, null);
    }
  }

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

    await evalSetPair({
      pairId: `${wA.candidate_id}__${wB.candidate_id}`,
      memberA,
      memberB,
      fullLabel: `${memberA.label} + ${memberB.label}`,
      slot0: slotA,
      slot1: slotB,
      member0Id: wA.candidate_id,
      member1Id: wB.candidate_id,
      logPrefix: "Set eval",
    });
  }

  // Explicit ring set-bonus pairs from gear-config (e.g., Voidlight Bindings)
  // Inject EP-best rings into the base profile so the set eval compares against
  // optimal individual rings, not whatever the old profile happens to have.
  const epBestRingOverrides = [];
  for (const ringSlot of ["finger1", "finger2"]) {
    const epResults = getBestGear(3, ringSlot);
    const best = epResults.find((r) => r.candidate_id !== "__baseline__");
    if (best) {
      const c = gearData.slots[ringSlot]?.candidates.find(
        (x) => x.id === best.candidate_id,
      );
      if (c) epBestRingOverrides.push(c.simc);
    }
  }

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

    await evalSetPair({
      pairId: `ring_${pair.id}`,
      memberA,
      memberB,
      fullLabel: pair.label,
      slot0: "finger1",
      slot1: "finger2",
      member0Id: pair.finger1,
      member1Id: pair.finger2,
      logPrefix: "Ring pair",
      extraBaseOverrides: epBestRingOverrides,
    });
  }

  setSessionState("gear_set_eval_pairs", evaluatedPairIds);
}

// --- CLI: gems (Phase 9) ---

// Classify gem color from its stat composition.
// Midnight gems: Lapis (vers), Garnet (haste), Amethyst (mastery), Peridot (crit).
function gemColor(gem) {
  const s = gem.stats;
  if (!s) return "unknown";
  const keys = Object.keys(s);
  if (keys.length === 1) {
    if (s.vers) return "lapis";
    if (s.haste) return "garnet";
    if (s.mastery) return "amethyst";
    if (s.crit) return "peridot";
    if (s.agi) return "diamond";
  }
  // Hybrid gems: classify by primary stat (higher value)
  if (s.vers) return "lapis";
  if (s.haste) return "garnet";
  if (s.mastery) return "amethyst";
  if (s.crit) return "peridot";
  return "unknown";
}

// Build a gem queue (array of item_ids) for a given configuration.
// If diverse=true, picks one gem of each color (best EP per color) plus
// the Eversong Diamond in the first slot.
function buildGemQueue(config, allGems, sf, totalSockets) {
  const queue = [];

  if (config.diverse && config.eversong) {
    // Eversong Diamond first
    const eversongId = config.eversong.item_id || config.eversong.enchant_id;
    queue.push(eversongId);

    // One of each non-diamond color (best EP within that color)
    const colorBest = new Map();
    for (const g of allGems) {
      if (g.uniqueLimit > 0) continue;
      const c = gemColor(g);
      if (c === "diamond" || c === "unknown") continue;
      const ep = scoreEp(g.stats, sf);
      const itemId = g.item_id || g.enchant_id;
      if (!colorBest.has(c) || ep > colorBest.get(c).ep) {
        colorBest.set(c, { itemId, ep });
      }
    }
    const usedColors = new Set();
    for (const [color, { itemId }] of colorBest) {
      if (queue.length >= totalSockets) break;
      queue.push(itemId);
      usedColors.add(color);
    }

    // Fill remaining with the best unlimited gem
    const bestUnlimited = allGems
      .filter((g) => g.stats && (!g.uniqueLimit || g.uniqueLimit === 0))
      .map((g) => ({
        ...g,
        ep: scoreEp(g.stats, sf),
        itemId: g.item_id || g.enchant_id,
      }))
      .sort((a, b) => b.ep - a.ep)[0];
    while (queue.length < totalSockets && bestUnlimited) {
      queue.push(bestUnlimited.itemId);
    }
  } else if (config.gem) {
    // All-same: fill every socket with the specified gem
    const itemId = config.gem.item_id || config.gem.enchant_id;
    while (queue.length < totalSockets) queue.push(itemId);
  }

  return queue;
}

// Apply a gem queue to gear lines, producing overrides for socketed slots only.
function applyGemQueueToLines(gearLines, gemQueue) {
  const overrides = [];
  let gemIdx = 0;
  for (const line of gearLines) {
    if (!line.includes("gem_id=")) continue;
    const match = line.match(/gem_id=([\d/]+)/);
    if (!match) continue;
    const socketCount = match[1].split("/").length;
    const assigned = gemQueue.slice(gemIdx, gemIdx + socketCount);
    gemIdx += socketCount;
    if (assigned.length === socketCount) {
      const newLine = line.replace(
        /gem_id=[\d/]+/,
        `gem_id=${assigned.join("/")}`,
      );
      if (newLine !== line) overrides.push(newLine);
    }
  }
  return overrides;
}

async function cmdGems(args, gearData) {
  const fidelity = parseFidelity(args, "quick");
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

  // EP-rank all unlimited gems by color for configuration building
  const ranked = gems
    .filter((g) => g.stats && (!g.uniqueLimit || g.uniqueLimit === 0))
    .map((g) => ({ ...g, ep: scoreEp(g.stats, sf) }))
    .sort((a, b) => b.ep - a.ep);

  // Build pre-gem gear lines to determine socket count and create overrides
  const preGemLines = buildGearLines(gearData);
  let totalSockets = 0;
  for (const line of preGemLines) {
    const match = line.match(/gem_id=([\d/]+)/);
    if (match) totalSockets += match[1].split("/").length;
  }

  if (totalSockets === 0) {
    console.log("Phase 9: No socketed items in assembled gear. Skipping.");
    return;
  }

  // Build gem configurations to test
  const configs = [];

  // Best EP gem (all sockets same)
  if (ranked.length > 0) {
    configs.push({
      id: "ep_best",
      label: `All: ${ranked[0].label}`,
      gem: ranked[0],
      diverse: false,
    });
  }

  // Second-best EP gem (for comparison)
  if (ranked.length > 1 && gemColor(ranked[1]) !== gemColor(ranked[0])) {
    configs.push({
      id: "ep_second",
      label: `All: ${ranked[1].label}`,
      gem: ranked[1],
      diverse: false,
    });
  }

  // Diverse colors + Eversong Diamond
  const eversong = gems.find((g) =>
    g.label?.toLowerCase().includes("critical strike effectiveness"),
  );
  if (eversong) {
    configs.push({
      id: "diverse_eversong",
      label: `Diverse + Eversong Diamond`,
      eversong,
      diverse: true,
    });
  }

  if (configs.length <= 1) {
    // Only one config — fall back to EP-only
    const best = ranked[0] || gems[0];
    setSessionState("gear_gems", {
      best_id: best.id,
      best_enchant_id: best.enchant_id,
      best_item_id: best.item_id || best.enchant_id,
      best_label: best.label,
      ep: best.ep ?? 0,
      timestamp: new Date().toISOString(),
    });
    console.log(`Phase 9: Gems (EP-only) — best: ${best.label}`);
    return;
  }

  console.log(
    `\nPhase 9: Gems — simming ${configs.length} configs (${totalSockets} sockets, ${fidelity} fidelity)`,
  );

  // Generate profileset variants
  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);
  const variants = configs.map((cfg) => {
    const queue = buildGemQueue(cfg, gems, sf, totalSockets);
    const overrides = applyGemQueueToLines(preGemLines, queue);
    return { name: cfg.id, overrides };
  });

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
  const baseline = aggregated.find((r) => r.id === "__baseline__");
  console.log(`  Best gem config: ${best.id} — ${best.label || best.id}`);
  if (baseline) {
    const delta =
      ((best.weighted - baseline.weighted) / baseline.weighted) * 100;
    console.log(`  vs baseline: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`);
  }

  for (const r of aggregated) {
    if (r.id === "__baseline__") continue;
    const cfg = configs.find((c) => c.id === r.id);
    const delta = baseline
      ? ((r.weighted - baseline.weighted) / baseline.weighted) * 100
      : 0;
    console.log(
      `  ${cfg?.label || r.id}: ${r.weighted?.toFixed(0)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%)`,
    );
  }

  // Store winner in session state for assembly
  const winningConfig = configs.find((c) => c.id === best.id);
  setSessionState("gear_gems", {
    config: best.id,
    label: winningConfig?.label,
    diverse: winningConfig?.diverse || false,
    best_id: winningConfig?.gem?.id || winningConfig?.eversong?.id,
    best_item_id:
      winningConfig?.gem?.item_id || winningConfig?.eversong?.item_id,
    timestamp: new Date().toISOString(),
  });
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
  const EP_ENCHANT_SLOTS = new Set([
    "cloak",
    "wrist",
    "foot",
    "chest",
    "legs",
    "shoulder",
  ]);

  // Override enchant base_items with actual assembled gear lines when placeholders exist.
  // Manual enchants produce placeholder base_items (id=0) when no Raidbots data exists.
  const ENCHANT_SLOT_MAP = {
    weapon_mh: "main_hand",
    weapon_oh: "off_hand",
    ring: "finger1",
    chest: "chest",
    foot: "feet",
    legs: "legs",
  };
  let cachedGearLines;
  let cachedProfileLines;
  for (const [enchantKey, gearSlot] of Object.entries(ENCHANT_SLOT_MAP)) {
    const enchantData = gearData.enchants?.[enchantKey];
    if (!enchantData || !enchantData.base_item.includes("id=0")) continue;
    cachedGearLines ??= buildGearLines(gearData);
    let itemLine = cachedGearLines.find((l) => l.startsWith(`${gearSlot}=`));
    // When baseline wins (e.g., Phase 4 weapons), assembly doesn't emit the slot.
    // Fall back to reading the line from the gear target (profile.simc).
    if (!itemLine) {
      cachedProfileLines ??= readFileSync(getGearTarget(gearData), "utf-8")
        .split("\n")
        .map((l) => l.trim());
      itemLine = cachedProfileLines.find((l) => l.startsWith(`${gearSlot}=`));
    }
    if (itemLine) {
      enchantData.base_item = itemLine.replace(/,enchant_id=\d+/, "");
    }
  }

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

  // First pass: compute raw per-scenario averages for all candidates
  const entries = [];
  for (const [candidateId, data] of byCandidate) {
    const { avg } = computeWeightedDps(data.scenarioDps);
    entries.push({ candidateId, avg, data });
  }

  // Compute per-scenario means across all candidates for normalization.
  // Without this, high-DPS scenarios (e.g., 10T at 580k) dominate the weighted
  // score despite low scenario weight, because raw DPS scale bleeds through.
  const scenarioMeans = {};
  for (const scenario of Object.keys(SCENARIO_WEIGHTS)) {
    const vals = entries.map((e) => e.avg[scenario] || 0).filter((v) => v > 0);
    scenarioMeans[scenario] =
      vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  }

  // Display scale: raw weighted mean DPS, so output stays in DPS-like units
  let displayScale = 0;
  for (const [scenario, weight] of Object.entries(SCENARIO_WEIGHTS)) {
    displayScale += scenarioMeans[scenario] * weight;
  }

  // Second pass: compute normalized weighted scores
  const ranked = [];
  for (const { candidateId, avg, data } of entries) {
    let normalizedSum = 0;
    for (const [scenario, weight] of Object.entries(SCENARIO_WEIGHTS)) {
      const dps = avg[scenario] || 0;
      const mean = scenarioMeans[scenario];
      normalizedSum += (dps / mean) * weight;
    }
    const weighted = normalizedSum * displayScale;

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

  // Determine the best config — baseline means keep original profile gear
  const best = ranked[0];
  const bestConfig =
    best?.id === "__baseline__" ? "__baseline__" : best?.id || "all_tier_5pc";

  setSessionState("gear_phase0", {
    best: bestConfig,
    fidelity,
    timestamp: new Date().toISOString(),
  });

  console.log(`\nBest tier config: ${bestConfig}`);
  if (bestConfig === "__baseline__") {
    console.log(
      "Recommendation: Keep original profile (no tier overrides needed).",
    );
  } else if (bestConfig === "all_tier_5pc") {
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

// --- CLI: resolve-conflicts (Phase 7.5) ---
// Detects when the embellishment winner claims a ring slot that a ring set also needs.
// Sims both configurations head-to-head and stores the winner for buildGearLines().

async function cmdResolveConflicts(args) {
  const fidelity = parseFidelity(args, "standard");
  const gearData = loadGearCandidates();

  function noConflict(reason) {
    console.log(reason);
    setSessionState("gear_conflict_resolution", { winner: "none" });
  }

  function embPairLabel(candidateId) {
    return (
      gearData.embellishments?.pairs?.find((p) => p.id === candidateId)
        ?.label || candidateId
    );
  }

  // Find the embellishment winner (non-baseline, non-eliminated)
  const embWinner = getBestGear(7, "embellishments").find(
    (r) =>
      r.candidate_id !== "__baseline__" &&
      r.candidate_id !== "__null_emb__" &&
      !r.eliminated,
  );
  if (!embWinner) {
    return noConflict("No embellishment winner, no conflict to resolve.");
  }

  // Check which ring slots the embellishment winner occupies
  const embOverrides = resolveComboOverrides(embWinner.candidate_id, gearData);
  const embFingerSlots = embOverrides
    .map((line) => line.split("=")[0])
    .filter((s) => s.startsWith("finger"));
  if (embFingerSlots.length === 0) {
    return noConflict(
      "Embellishment winner does not use ring slots, no conflict.",
    );
  }

  // Find the first ring set whose slots overlap with the embellishment
  const setEvalPairs = getSessionState("gear_set_eval_pairs") || [];
  let conflictingRingSet = null;
  for (const pairId of setEvalPairs) {
    if (!pairId.startsWith("ring_")) continue;
    const state = getSessionState(`gear_set_eval_${pairId}`);
    if (!state?.winner) continue;
    if (embFingerSlots.some((s) => s === state.slot0 || s === state.slot1)) {
      conflictingRingSet = { pairId, state };
      break;
    }
  }
  if (!conflictingRingSet) {
    return noConflict("No ring set conflicts with embellishment winner.");
  }

  console.log(
    `Conflict: embellishment "${embWinner.candidate_id}" uses ${embFingerSlots.join(", ")}`,
  );
  console.log(
    `  Ring set "${conflictingRingSet.pairId}" also needs those slots`,
  );

  // Find the best non-ring-conflicting embellishment pair.
  // Search ALL results, including pruned ones — the best non-ring pair may have been
  // pruned relative to the ring-using winner but is still relevant for conflict comparison.
  const nonConflicting = getGearResults(7, "embellishments").find((r) => {
    if (r.candidate_id === "__baseline__" || r.candidate_id === "__null_emb__")
      return false;
    const slots = resolveComboOverrides(r.candidate_id, gearData).map(
      (line) => line.split("=")[0],
    );
    return !slots.some((s) => s.startsWith("finger"));
  });

  if (!nonConflicting) {
    console.log(
      "  No non-ring embellishment pairs available. Embellishment config wins by default.",
    );
    setSessionState("gear_conflict_resolution", {
      winner: "embellishment",
      ringSetPairId: conflictingRingSet.pairId,
      embWinnerId: embWinner.candidate_id,
      fidelity,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Config A: ring set + best non-ring embellishment
  const { state } = conflictingRingSet;
  const ringA = gearData.slots[state.slot0]?.candidates.find(
    (c) => c.id === state.member0,
  );
  const ringB = gearData.slots[state.slot1]?.candidates.find(
    (c) => c.id === state.member1,
  );

  const configAOverrides = [];
  if (!state.winner.endsWith("_B_alone") && ringA)
    configAOverrides.push(ringA.simc);
  if (!state.winner.endsWith("_A_alone") && ringB)
    configAOverrides.push(ringB.simc);
  configAOverrides.push(
    ...resolveComboOverrides(nonConflicting.candidate_id, gearData),
  );

  const ncLabel = embPairLabel(nonConflicting.candidate_id);
  const embLabel = embPairLabel(embWinner.candidate_id);
  const ringLabel =
    gearData.ring_pairs?.find(
      (p) => `ring_${p.id}` === conflictingRingSet.pairId,
    )?.label || conflictingRingSet.pairId;

  console.log(`  Config A: ${ringLabel} + ${ncLabel}`);
  console.log(`  Config B: ${embLabel} (no ring set)`);

  const builds = getRepresentativeBuilds();
  const baseProfile = getBaseProfile(gearData);

  const variants = [
    { name: "ring_set_config", overrides: configAOverrides },
    { name: "emb_config", overrides: embOverrides },
  ];

  const scenarioCount = Object.keys(SCENARIOS).length;
  console.log(
    `\n  Head-to-head: 2 configs x ${builds.length} builds x ${scenarioCount} scenarios (${fidelity} fidelity)`,
  );

  const results = await runBuildScenarioSims(
    variants,
    builds,
    baseProfile,
    fidelity,
    "gear_conflict_resolution",
  );
  const ranked = aggregateGearResults(
    results,
    [
      { id: "ring_set_config", label: `${ringLabel} + ${ncLabel}` },
      { id: "emb_config", label: embLabel },
    ],
    builds,
  );

  printSlotResults("conflict-resolution", ranked, gearData);

  const configs = ranked.filter((r) => r.id !== "__baseline__");
  const winner = configs[0];
  const loser = configs[1];

  if (winner && loser) {
    const delta = (
      ((winner.weighted - loser.weighted) / winner.weighted) *
      100
    ).toFixed(2);
    console.log(`\n  Winner: ${winner.label} (+${delta}% over ${loser.label})`);
  }

  setSessionState("gear_conflict_resolution", {
    winner: winner?.id === "ring_set_config" ? "ring_set" : "embellishment",
    ringSetPairId: conflictingRingSet.pairId,
    embWinnerId: embWinner.candidate_id,
    nonConflictingEmbId: nonConflicting.candidate_id,
    fidelity,
    timestamp: new Date().toISOString(),
  });

  clearGearResults(CONFLICT_RESOLUTION_PHASE, "conflict_resolution");
  saveGearResults(
    CONFLICT_RESOLUTION_PHASE,
    "conflict_resolution",
    ranked,
    fidelity,
    "conflict_resolution",
  );
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

      // Skip pairs where both items share the same base item ID — unique-equipped items
      // cannot be worn in two slots simultaneously. Extract item ID from simc_base string.
      const idA = cA.simc_base?.match(/,id=(\d+)/)?.[1];
      const idB = cB.simc_base?.match(/,id=(\d+)/)?.[1];
      if (idA && idB && idA === idB && cA.uniqueEquipped) continue;

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
  if (!enchantId) return line;
  if (line.includes("enchant_id=")) {
    return line.replace(/enchant_id=\d+/, `enchant_id=${enchantId}`);
  }
  return `${line},enchant_id=${enchantId}`;
}

// Apply the correct enchant for a given individual slot based on Phase 10 results.
function applySlotEnchant(line, slot, enchantMap) {
  const SLOT_ENCHANT = {
    main_hand: "weapon_mh",
    off_hand: "weapon_oh",
    shoulder: "shoulder",
    back: "cloak",
    chest: "chest",
    wrists: "wrist",
    wrist: "wrist",
    legs: "legs",
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
  // Normalize wrist/wrists — gear-candidates uses "wrists" as slot key
  const stateSlot = slot === "wrist" ? "wrists" : slot;
  const statState = getSessionState(`gear_phase2_${stateSlot}`);
  if (!statState?.best) return line;
  const pairId = statState.best.replace(new RegExp(`^${stateSlot}_`), "");
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
  // Extract baseline enchants from the profile for fallback when "Baseline" wins
  const profilePath = resolve(ROOT, gearData.gearTarget ?? gearData.baseline);
  let profileEnchants = {};
  if (existsSync(profilePath)) {
    const profileContent = readFileSync(profilePath, "utf-8");
    const ENCHANT_SLOT_REVERSE = {
      main_hand: "weapon_mh",
      off_hand: "weapon_oh",
      chest: "chest",
      legs: "legs",
      finger1: "ring",
      finger2: "ring",
    };
    for (const line of profileContent.split("\n")) {
      const slotMatch = line.match(/^(\w+)=/);
      const enchantMatch = line.match(/enchant_id=(\d+)/);
      if (slotMatch && enchantMatch) {
        const key = ENCHANT_SLOT_REVERSE[slotMatch[1]];
        if (key && !profileEnchants[key])
          profileEnchants[key] = parseInt(enchantMatch[1]);
      }
    }
  }
  for (const [enchantSlot, enchantData] of Object.entries(
    gearData.enchants || {},
  )) {
    const results = getBestGear(10, enchantSlot);
    if (results.length > 0) {
      const winnerId = results[0].candidate_id;
      if (winnerId === "__baseline__") {
        if (profileEnchants[enchantSlot])
          enchantMap[enchantSlot] = profileEnchants[enchantSlot];
      } else {
        const candidate = enchantData.candidates.find((c) => c.id === winnerId);
        if (candidate) enchantMap[enchantSlot] = candidate.enchant_id;
      }
    }
  }
  return enchantMap;
}

// Reconstruct SimC lines for the selected tier configuration.
// Returns an array of { slot, simc } objects.
function getTierLines(gearData) {
  const phase0 = getSessionState("gear_phase0");
  if (!phase0 || !gearData.tier) return [];

  // Baseline won — keep original profile gear, no tier overrides
  if (phase0.best === "__baseline__") return [];

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
//   Phase 7:  embellishments (conflict-resolved against ring sets)
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
  // Track equipped unique-equip item IDs to prevent conflicts across slots
  // (e.g., Lightless Lament in both MH and OH)
  const equippedUniqueItemIds = new Set();
  let craftedCount = 0;

  // Extract item ID from a SimC line like "main_hand=lightless_lament,id=260408,..."
  function extractItemId(simcLine) {
    return simcLine?.match(/,id=(\d+)/)?.[1] ?? null;
  }

  function canEquip(candidate) {
    if (candidate?.uniqueEquipped) {
      const itemId = extractItemId(candidate.simc || candidate.simc_base);
      if (itemId && equippedUniqueItemIds.has(itemId)) return false;
    }
    if (isCraftedSimc(candidate?.simc) && craftedCount >= MAX_CRAFTED) {
      return false;
    }
    return true;
  }

  function addLine(line, slot, candidate) {
    lines.push(line);
    coveredSlots.add(slot);
    if (slot === "wrist") coveredSlots.add("wrists");
    if (slot === "wrists") coveredSlots.add("wrist");
    // Track unique-equipped items
    if (candidate?.uniqueEquipped) {
      const itemId = extractItemId(line);
      if (itemId) equippedUniqueItemIds.add(itemId);
    }
    if (isCraftedSimc(line)) craftedCount++;
  }

  // Phase 0: tier config
  for (const { slot, simc } of getTierLines(gearData)) {
    addLine(applySlotEnchant(simc, slot, enchantMap), slot);
  }

  // Check for ring/embellishment conflict resolution
  const resolution = getSessionState("gear_conflict_resolution");

  // Phase 7: embellishments (highest priority for those slots)
  // When ring set won the conflict, use the non-conflicting embellishment instead.
  // When ring set won but no non-conflicting emb exists, skip embellishments entirely
  // to avoid re-introducing the slot conflict.
  let embCandidateId;
  if (resolution?.winner === "ring_set") {
    embCandidateId = resolution.nonConflictingEmbId;
  } else {
    const emb = getBestGear(7, "embellishments").find(
      (r) =>
        r.candidate_id !== "__baseline__" && r.candidate_id !== "__null_emb__",
    );
    embCandidateId = emb?.candidate_id;
  }
  if (embCandidateId) {
    const overrides = resolveComboOverrides(embCandidateId, gearData);
    for (const line of overrides) {
      const slot = line.split("=")[0];
      if (!coveredSlots.has(slot)) {
        addLine(
          applySlotEnchant(applyStatAlloc(line, slot), slot, enchantMap),
          slot,
        );
      }
    }
  }

  // Set eval: auto-generated pair winners cover their specific slots.
  // Skip ring sets that lost the conflict resolution — applying half a set
  // with no set bonus is worse than letting individual ring phases fill those slots.
  const setEvalPairs = getSessionState("gear_set_eval_pairs") || [];
  for (const pairId of setEvalPairs) {
    if (
      resolution?.winner === "embellishment" &&
      pairId === resolution.ringSetPairId
    ) {
      continue;
    }

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
      if (c0 && !coveredSlots.has(slot0) && canEquip(c0)) {
        addLine(
          applySlotEnchant(applyStatAlloc(c0.simc, slot0), slot0, enchantMap),
          slot0,
          c0,
        );
      }
    }
    if (includeB) {
      const c1 = gearData.slots[slot1]?.candidates.find(
        (c) => c.id === member1,
      );
      if (c1 && !coveredSlots.has(slot1) && canEquip(c1)) {
        addLine(
          applySlotEnchant(applyStatAlloc(c1.simc, slot1), slot1, enchantMap),
          slot1,
          c1,
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
    const procResults = getBestGear(4, slot);
    // Walk the ranking to find the best candidate that passes unique-equip constraints
    // If baseline is the top result, skip this slot (keep original gear)
    if (procResults[0]?.candidate_id === "__baseline__") continue;
    let placed = false;
    for (const procResult of procResults) {
      if (procResult.candidate_id === "__baseline__") continue;
      const candidate = gearData.slots[slot].candidates.find(
        (c) => c.id === procResult.candidate_id,
      );
      if (!candidate || !canEquip(candidate)) continue;
      const line = applyStatAlloc(candidate.simc, slot);
      addLine(applySlotEnchant(line, slot, enchantMap), slot, candidate);
      placed = true;
      break;
    }
    if (!placed) continue;
  }

  // Phase 3b: combinatorial validation winners override EP per-slot picks
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

  // Phase 3: EP ranking winners for remaining individual slots.
  // When Phase 3b showed baseline winning, EP picks collectively are worse — skip them.
  if (comboWinners?.combo) {
    for (const slot of Object.keys(gearData.slots || {})) {
      if (coveredSlots.has(slot)) continue;
      const epResults = getBestGear(3, slot);
      for (const epResult of epResults) {
        if (epResult.candidate_id === "__baseline__") continue;
        const candidate = gearData.slots[slot].candidates.find(
          (c) => c.id === epResult.candidate_id,
        );
        if (!candidate || !canEquip(candidate)) continue;
        const line = applyStatAlloc(candidate.simc, slot);
        addLine(applySlotEnchant(line, slot, enchantMap), slot, candidate);
        break;
      }
    }
  }

  // Phase 9: apply gems to all socketed items.
  // Uses the sim-winning gem configuration from cmdGems (diverse or all-same).
  // Falls back to EP-ranked queue when no sim data exists.
  const gemState = getSessionState("gear_gems");
  if (gemState) {
    const allGems = gearData.gems || [];
    const sf = getSessionState("gear_scale_factors");

    let totalSockets = 0;
    for (const line of lines) {
      const match = line.match(/gem_id=([\d/]+)/);
      if (match) totalSockets += match[1].split("/").length;
    }

    let gemQueue;
    if (gemState.diverse) {
      // Sim-based diverse winner: rebuild the same queue that won
      const eversong = allGems.find((g) =>
        g.label?.toLowerCase().includes("critical strike effectiveness"),
      );
      gemQueue = buildGemQueue(
        { diverse: true, eversong },
        allGems,
        sf,
        totalSockets,
      );
    } else {
      // EP-based queue with unique-limit handling
      const rankedGems = sf
        ? allGems
            .filter((g) => g.stats && (g.item_id || g.enchant_id))
            .map((g) => ({
              ...g,
              ep: scoreEp(g.stats, sf),
              itemId: g.item_id || g.enchant_id,
            }))
            .sort((a, b) => b.ep - a.ep)
        : [];

      const uniqueGems = rankedGems.filter(
        (g) => g.uniqueLimit != null && g.uniqueLimit > 0,
      );
      const unlimitedGems = rankedGems.filter(
        (g) => g.uniqueLimit == null || g.uniqueLimit === 0,
      );
      const fallbackGemId =
        unlimitedGems[0]?.itemId ||
        gemState.best_item_id ||
        gemState.best_enchant_id;

      gemQueue = [];
      const categoryBudget = new Map();
      for (const ug of uniqueGems) {
        const cat = ug.uniqueCategory ?? ug.itemId;
        if (!categoryBudget.has(cat)) categoryBudget.set(cat, ug.uniqueLimit);
        const remaining = categoryBudget.get(cat);
        if (remaining <= 0) continue;
        const count = Math.min(remaining, totalSockets - gemQueue.length);
        for (let n = 0; n < count; n++) gemQueue.push(ug.itemId);
        categoryBudget.set(cat, remaining - count);
      }
      while (gemQueue.length < totalSockets && fallbackGemId) {
        gemQueue.push(fallbackGemId);
      }
    }

    // Apply gems to lines in order
    let gemIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("gem_id=")) continue;
      const match = lines[i].match(/gem_id=([\d/]+)/);
      if (!match) continue;
      const socketCount = match[1].split("/").length;
      const assignedGems = gemQueue.slice(gemIdx, gemIdx + socketCount);
      gemIdx += socketCount;
      if (assignedGems.length === socketCount) {
        lines[i] = lines[i].replace(
          /gem_id=[\d/]+/,
          `gem_id=${assignedGems.join("/")}`,
        );
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
  // Exception: pipeline-controlled attributes (embellishment, crafted_stats, enchant_id,
  // gem_id) must come from the pipeline line, not the current profile.
  const PIPELINE_ATTRS = [
    "embellishment=",
    "crafted_stats=",
    "enchant_id=",
    "gem_id=",
  ];
  const finalLines = newLines.map((line) => {
    const slot = line.split("=")[0];
    const cur = currentGear.get(slot);
    if (!cur || itemId(cur) !== itemId(line)) return line;
    const pipelineControlled = PIPELINE_ATTRS.some((attr) =>
      line.includes(attr),
    );
    if (!pipelineControlled) return cur;
    // Pipeline line wins, but carry over gem_id from current if pipeline didn't set one
    if (!line.includes("gem_id=")) {
      const curGem = cur.match(/gem_id=([\d/]+)/);
      if (curGem) return `${line},gem_id=${curGem[1]}`;
    }
    return line;
  });

  // Any slot in the current profile not covered by the pipeline is preserved as-is.
  // This prevents tier slots (managed by phase 0) from being dropped when session
  // state is missing (e.g., write-profile called standalone).
  // Apply Phase 10 enchant winners to preserved lines.
  // Also enforce MAX_CRAFTED constraint on preserved lines.
  const preservedEnchantMap = buildEnchantMap(gearData);
  const finalSlotsCovered = new Set(finalLines.map((l) => l.split("=")[0]));

  // Build set of known crafted item IDs from gear-candidates to detect crafted
  // items even when SimC markers (crafted_stats, bonus_id=8793) have been stripped
  const craftedItemIds = new Set();
  for (const slotData of Object.values(gearData?.slots || {})) {
    for (const c of slotData.candidates || []) {
      if (isCraftedSimc(c.simc)) {
        const m = c.simc?.match(/,id=(\d+)/);
        if (m) craftedItemIds.add(m[1]);
      }
    }
  }

  function isCraftedLine(line) {
    if (isCraftedSimc(line)) return true;
    const m = line.match(/,id=(\d+)/);
    return m ? craftedItemIds.has(m[1]) : false;
  }

  let preservedCraftedCount = finalLines.filter((l) => isCraftedLine(l)).length;
  for (const [slot, line] of currentGear) {
    if (!finalSlotsCovered.has(slot)) {
      if (isCraftedLine(line) && preservedCraftedCount >= MAX_CRAFTED) {
        // Over crafted limit — substitute best non-crafted candidate for this slot
        const slotKey = slot === "wrist" ? "wrists" : slot;
        const slotCandidates = gearData?.slots?.[slotKey]?.candidates || [];
        const nonCrafted = slotCandidates.find((c) => !isCraftedSimc(c.simc));
        if (nonCrafted) {
          finalLines.push(
            applySlotEnchant(nonCrafted.simc, slot, preservedEnchantMap),
          );
        } else {
          finalLines.push(applySlotEnchant(line, slot, preservedEnchantMap));
        }
      } else {
        if (isCraftedLine(line)) preservedCraftedCount++;
        finalLines.push(applySlotEnchant(line, slot, preservedEnchantMap));
      }
    }
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
    console.log("\n========== PHASE 1b: EP Reweighting ==========\n");
    cmdEpReweight(gearData);
    console.log("\n========== PHASE 3 (reweighted): EP Ranking ==========\n");
    cmdEpRank(gearData);
    console.log("\n========== PHASE 3b: Combinatorial Validation ==========\n");
    await cmdCombinatorialValidation(fidelityArgs);
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
    console.log(
      "\n========== PHASE 7.5: Ring/Embellishment Conflict Resolution ==========\n",
    );
    await cmdResolveConflicts(fidelityArgs);
  }
  if (maxPhase >= 8) {
    console.log("\n========== PHASE 8: Stat Re-optimization ==========\n");
    await cmdStatOptimize(fidelityArgs);
  }
  if (maxPhase >= 9) {
    console.log("\n========== PHASE 9: Gems ==========\n");
    await cmdGems(fidelityArgs, gearData);
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
  if (phase11State?.validationPassed === true) {
    console.log("\n========== Writing profile.simc ==========\n");
    cmdWriteProfile();
  } else if (phase11State?.validationPassed === false) {
    console.log(
      "\n========== PIPELINE BLOCKED: Gear regression detected ==========\n",
    );
    console.log(
      "  Assembled gear is worse than the original profile. profile.simc NOT updated.",
    );
    console.log("  Fix gear candidates and re-run the pipeline to proceed.");
  } else {
    console.log("\n  Profile not written — run through Phase 11 to validate.");
  }

  console.log("\n========== Pipeline Complete ==========\n");
  cmdStatus();
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

  // Phase 3b: combinatorial validation
  const phase3b = getSessionState("gear_phase3b_winners");
  console.log("\nPhase 3b (Combinatorial Validation):");
  if (phase3b?.timestamp) {
    const comboSlots = Object.keys(phase3b.combo || {});
    console.log(
      `  ${comboSlots.length} slots overridden (${phase3b.timestamp})`,
    );
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

  // Phase 7.5: conflict resolution
  const conflictRes = getSessionState("gear_conflict_resolution");
  console.log("\nPhase 7.5 (Conflict Resolution):");
  if (conflictRes?.winner === "ring_set") {
    console.log(
      `  Winner: ring set (${conflictRes.ringSetPairId}) + ${conflictRes.nonConflictingEmbId} (${conflictRes.fidelity})`,
    );
  } else if (conflictRes?.winner === "embellishment") {
    console.log(
      `  Winner: embellishment (${conflictRes.embWinnerId}) (${conflictRes.fidelity})`,
    );
  } else {
    console.log("  no conflict detected");
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
    for (const p of [
      0,
      2,
      3,
      4,
      SET_EVAL_PHASE,
      5,
      6,
      7,
      CONFLICT_RESOLUTION_PHASE,
      10,
      11,
    ]) {
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
  const [slot0, slot1] = gearData.paired_slots.trinkets.slots;

  // Generate all (candidate, ilvl) variants
  // Blank the other slot so each trinket is measured in isolation
  const variants = [];
  for (const c of trinketCandidates) {
    for (const ilvl of ilvlTiers) {
      variants.push({
        name: `${c.id}_ilvl${ilvl}`,
        overrides: [`${slot0}=${swapIlevel(c.simc_base, ilvl)}`, `${slot1}=`],
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
  case "resolve-conflicts":
    await cmdResolveConflicts(cleanArgs);
    break;
  case "stat-optimize":
    await cmdStatOptimize(cleanArgs);
    break;
  case "combo-validate":
    await cmdCombinatorialValidation(cleanArgs);
    break;
  case "gems": {
    const gd = loadGearCandidates();
    await cmdGems(cleanArgs, gd);
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
  resolve-conflicts Phase 7.5: Ring set vs embellishment conflict resolution
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
