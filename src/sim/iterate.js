// APL iteration state management CLI.
// Manages the autonomous APL optimization loop: baseline tracking,
// candidate comparison, accept/reject workflow, hypothesis generation.
//
// Subcommands:
//   init <apl.simc>              Initialize iteration state with baseline
//   status                       Print current iteration state
//   compare <candidate.simc>     Run profileset comparison (--quick|--confirm)
//   accept "reason"              Adopt candidate as new baseline
//   reject "reason"              Log rejection and move on
//   hypotheses                   Generate improvement hypotheses
//   summary                      Generate iteration report
//   checkpoint                   Save checkpoint for session resume

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { runWorkflow } from "./workflow.js";
import { SCENARIOS, SIM_DEFAULTS, runMultiActorAsync } from "./runner.js";
import { getSpecAdapter } from "../engine/startup.js";
import { loadRoster } from "./build-roster.js";
import { generateMultiActorContent } from "./multi-actor.js";
import {
  generateProfileset,
  runProfileset,
  runProfilesetAsync,
  resolveInputDirectives,
} from "./profilesets.js";
import {
  generateStrategicHypotheses,
  loadApl,
  MUTATION_OPS,
} from "../analyze/strategic-hypotheses.js";
import {
  analyzeResourceFlow,
  generateTemporalHypotheses,
} from "../analyze/theorycraft.js";
import {
  generateCandidate,
  describeMutation,
  validateMutation,
} from "../apl/mutator.js";
import { parse } from "../apl/parser.js";
import {
  synthesize as synthesizeHypotheses,
  saveSpecialistOutput,
} from "../analyze/synthesizer.js";
import { addFinding as dbAddFinding } from "../util/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(ROOT, "results");
const STATE_PATH = join(RESULTS_DIR, "iteration-state.json");
// Iteration working copy — created by `init`, updated by `accept`.
const CURRENT_APL = join(ROOT, "apls", "current.simc");

const SCENARIO_KEYS = ["st", "small_aoe", "big_aoe"];
const SCENARIO_LABELS = { st: "1T", small_aoe: "5T", big_aoe: "10T" };
// ST weighted highest (hardest to improve, most common), 5T moderate, 10T lowest (rarest encounter type)
const SCENARIO_WEIGHTS = { st: 0.5, small_aoe: 0.3, big_aoe: 0.2 };

const FIDELITY_TIERS = {
  quick: { target_error: 1.0 },
  standard: { target_error: 0.3 },
  confirm: { target_error: 0.1 },
};

const STATE_VERSION = 3;

// Extract aggregate per-scenario DPS from state, handling both single-build and multi-build.
// For multi-build: averages across all builds. Returns {st, small_aoe, big_aoe}.
function getAggregateDps(stateSection) {
  if (stateSection.dps) return stateSection.dps;
  if (!stateSection.builds) return {};
  const builds = Object.values(stateSection.builds);
  if (builds.length === 0) return {};
  const agg = {};
  for (const key of SCENARIO_KEYS) {
    const vals = builds.map((b) => b.dps?.[key]).filter((v) => v !== undefined);
    if (vals.length > 0)
      agg[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return agg;
}

// --- State Management ---

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return migrateState(state);
  } catch (e) {
    console.error(
      `State file corrupted: ${e.message}. Attempting backup recovery...`,
    );
    return recoverFromBackup();
  }
}

function recoverFromBackup() {
  const backups = readdirSync(RESULTS_DIR)
    .filter(
      (f) => f.startsWith("iteration-state.backup.") && f.endsWith(".json"),
    )
    .sort()
    .reverse();
  for (const f of backups) {
    try {
      const state = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf-8"));
      console.error(`Recovered from backup: ${f}`);
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      return migrateState(state);
    } catch (err) {
      console.error(`Backup ${f} corrupt: ${err.message}`);
      // corrupt backup, try next
    }
  }
  console.error("No valid backups found.");
  return null;
}

function migrateState(state) {
  if (state.version >= STATE_VERSION) return state;
  throw new Error(
    `Iteration state version ${state.version || "unknown"} is too old. ` +
      `Expected version ${STATE_VERSION}. Delete results/iteration-state.json and re-init.`,
  );
}

function saveState(state) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  state.version = STATE_VERSION;
  state.lastUpdated = new Date().toISOString();

  const content = JSON.stringify(state, null, 2);
  const tmpPath = STATE_PATH + ".tmp";

  // Atomic write: write to .tmp, rotate backups, rename
  writeFileSync(tmpPath, content);

  if (existsSync(STATE_PATH)) {
    // Rotate backups (keep 5)
    const backups = readdirSync(RESULTS_DIR)
      .filter(
        (f) => f.startsWith("iteration-state.backup.") && f.endsWith(".json"),
      )
      .sort()
      .map((f) => join(RESULTS_DIR, f));
    while (backups.length >= 5) {
      unlinkSync(backups.shift());
    }
    const backupPath = join(
      RESULTS_DIR,
      `iteration-state.backup.${Date.now()}.json`,
    );
    copyFileSync(STATE_PATH, backupPath);
  }

  renameSync(tmpPath, STATE_PATH);
}

// --- Hypothesis Helpers ---

// Strip numbers/percentages so that hypotheses differing only in reported
// metrics (e.g., "Spirit Bomb contributes 12.3%" vs "11.8%") match as equivalent.
function normalizeHypothesisKey(description) {
  return description
    .replace(/[\d.]+%?/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Hypothesis Generation ---

function generateHypotheses(workflowResults) {
  const hypotheses = [];
  const scenarios = workflowResults.scenarios.filter((s) => !s.error);

  if (scenarios.length === 0) return hypotheses;

  const st = scenarios.find((s) => s.scenario === "st");
  const aoe = scenarios.find(
    (s) => s.scenario === "small_aoe" || s.scenario === "big_aoe",
  );

  // 1. Underused abilities — high-damage abilities with few casts
  for (const s of scenarios) {
    for (const a of s.majorDamage || []) {
      if (a.fraction > 10 && a.casts < 5) {
        hypotheses.push({
          category: "underused_ability",
          description: `${a.name} contributes ${a.fraction}% damage in ${SCENARIO_LABELS[s.scenario] || s.scenario} but only ${a.casts} casts — could cast more`,
          priority: a.fraction,
          scenario: s.scenario,
        });
      }
    }
  }

  // 2. Low-contribution abilities wasting GCDs
  for (const s of scenarios) {
    for (const a of s.lowContrib || []) {
      if (a.casts > 3) {
        hypotheses.push({
          category: "wasted_gcds",
          description: `${a.name} contributes only ${a.fraction}% damage in ${SCENARIO_LABELS[s.scenario] || s.scenario} with ${a.casts} casts — remove or add conditions`,
          priority: a.casts * 0.5,
          scenario: s.scenario,
        });
      }
    }
  }

  // 3. Low buff uptimes
  for (const s of scenarios) {
    for (const [name, uptime] of Object.entries(s.buffUptimes || {})) {
      const { cooldownBuffs: cdBuffs } = getSpecAdapter().getSpecConfig();
      if (uptime < 40 && !cdBuffs.includes(name)) {
        hypotheses.push({
          category: "buff_uptime_gap",
          description: `${name} uptime only ${uptime}% in ${SCENARIO_LABELS[s.scenario] || s.scenario} — prioritize refresh higher`,
          priority: (100 - uptime) * 0.3,
          scenario: s.scenario,
        });
      }
    }
  }

  // 4. GCD efficiency
  for (const s of scenarios) {
    if (s.gcdEfficiency !== undefined && s.gcdEfficiency < 85) {
      hypotheses.push({
        category: "conditional_tightness",
        description: `GCD efficiency only ${s.gcdEfficiency}% in ${SCENARIO_LABELS[s.scenario] || s.scenario} — loosen filler conditions or add fallback actions`,
        priority: (100 - s.gcdEfficiency) * 0.5,
        scenario: s.scenario,
      });
    }
  }

  // 5. AoE scaling mismatches
  const cross = workflowResults.crossAnalysis;
  if (cross?.aoeScaling) {
    for (const a of cross.aoeScaling) {
      hypotheses.push({
        category: "aoe_mismatch",
        description: `${a.name} fraction shifts from ${a.stFraction}% (ST) to ${a.aoeFraction}% (AoE), delta ${a.delta > 0 ? "+" : ""}${a.delta}pp — adjust active_enemies conditions`,
        priority: Math.abs(a.delta) * 0.4,
      });
    }
  }

  // 6. General threshold sweep suggestions for top abilities
  if (st) {
    const topAbilities = (st.majorDamage || []).slice(0, 5);
    for (const a of topAbilities) {
      hypotheses.push({
        category: "threshold_sweep",
        description: `Sweep resource thresholds for ${a.name} (${a.fraction}% of ST damage) — try varying fury/soul_fragment conditions`,
        priority: a.fraction * 0.2,
      });
    }
  }

  // 7. Cooldown alignment
  if (st) {
    const { cooldownBuffs: specCdBuffs } = getSpecAdapter().getSpecConfig();
    for (const name of specCdBuffs) {
      const uptime = st.buffUptimes?.[name];
      if (uptime !== undefined && uptime > 0) {
        hypotheses.push({
          category: "cooldown_alignment",
          description: `Align high-damage abilities with ${name} windows (${uptime}% uptime in ST)`,
          priority: 15,
        });
      }
    }
  }

  // Sort by priority descending, deduplicate by description
  const seen = new Set();
  return hypotheses
    .sort((a, b) => b.priority - a.priority)
    .filter((h) => {
      if (seen.has(h.description)) return false;
      seen.add(h.description);
      return true;
    });
}

// --- Hypothesis Matching ---

function popHypothesis(state, descriptionFragment) {
  if (descriptionFragment) {
    const frag = descriptionFragment.toLowerCase();
    const idx = state.pendingHypotheses.findIndex((h) =>
      (h.description || h.hypothesis || "").toLowerCase().includes(frag),
    );
    if (idx !== -1) return state.pendingHypotheses.splice(idx, 1)[0];
  }
  if (state.pendingHypotheses.length > 0) {
    return state.pendingHypotheses.shift();
  }
  return { description: "manual change", category: "manual" };
}

// --- Iteration Recording ---

function recordIteration(state, comparison, reason, hypothesisHint, decision) {
  const iterNum = state.iterations.length + 1;

  const hypothesis = popHypothesis(state, hypothesisHint);

  if (comparison.multiBuild) {
    // Multi-build: store full comparison object for rollback/reporting
    state.iterations.push({
      id: iterNum,
      timestamp: new Date().toISOString(),
      hypothesis: hypothesis.description,
      category: hypothesis.category,
      mutation: reason,
      comparison: {
        aggregates: comparison.aggregate,
        buildResults: comparison.buildResults,
      },
      decision,
      reason,
    });
  } else {
    // Single-build: flat per-scenario results
    const iterResults = {};
    for (const [scenario, r] of Object.entries(comparison.results || {})) {
      iterResults[scenario] = {
        current: r.current,
        candidate: r.candidate,
        delta_pct: r.deltaPct,
      };
    }
    state.iterations.push({
      id: iterNum,
      timestamp: new Date().toISOString(),
      hypothesis: hypothesis.description,
      category: hypothesis.category,
      mutation: reason,
      results: iterResults,
      decision,
      reason,
    });
  }

  return { iterNum, hypothesis };
}

// --- Comparison ---

function buildProfilesetContent(candidatePath) {
  const rawBase = readFileSync(CURRENT_APL, "utf-8");
  const baseContent = resolveInputDirectives(rawBase, dirname(CURRENT_APL));
  const rawCandidate = readFileSync(candidatePath, "utf-8");
  const candidateContent = resolveInputDirectives(
    rawCandidate,
    dirname(resolve(candidatePath)),
  );

  // Extract action lines from candidate, filtering empty lines
  const actionLines = candidateContent
    .split("\n")
    .filter((l) => l.startsWith("actions"))
    .filter(Boolean);

  if (actionLines.length === 0) {
    throw new Error(
      `No action lines found in ${candidatePath}. Candidate must contain lines starting with "actions".`,
    );
  }

  return [
    baseContent,
    "",
    `profileset."candidate"=${actionLines[0]}`,
    ...actionLines.slice(1).map((l) => `profileset."candidate"+=${l}`),
    "",
  ].join("\n");
}

async function runComparison(candidatePath, tier = "standard") {
  const tierConfig = FIDELITY_TIERS[tier] || FIDELITY_TIERS.standard;
  const simcContent = buildProfilesetContent(candidatePath);

  // Parallel: each scenario gets cores/3 threads
  const totalCores = cpus().length;
  const threadsPerSim = Math.max(
    1,
    Math.floor(totalCores / SCENARIO_KEYS.length),
  );

  const scenarioPromises = SCENARIO_KEYS.map((scenario) =>
    runProfilesetAsync(simcContent, scenario, "comparison", {
      simOverrides: { ...tierConfig, threads: threadsPerSim },
    }).then((pResults) => {
      const baselineDPS = pResults.baseline.dps;
      const candidateVariant = pResults.variants.find(
        (v) => v.name === "candidate",
      );
      const candidateDPS = candidateVariant
        ? candidateVariant.dps
        : baselineDPS;

      // Use mean_stddev if available, fall back to stddev/sqrt(iterations)
      let stderr;
      if (candidateVariant?.dpsMeanStdDev) {
        stderr = candidateVariant.dpsMeanStdDev;
      } else {
        const stddev = candidateVariant ? candidateVariant.dpsStdDev : 0;
        const iters = candidateVariant?.iterations || 1;
        stderr = stddev / Math.sqrt(iters);
      }

      const delta = candidateDPS - baselineDPS;
      const deltaPct = (delta / baselineDPS) * 100;
      const stderrPct = (stderr / baselineDPS) * 100;
      const significant = Math.abs(deltaPct) > 2 * stderrPct;

      return [
        scenario,
        {
          current: Math.round(baselineDPS),
          candidate: Math.round(candidateDPS),
          delta: Math.round(delta),
          deltaPct: +deltaPct.toFixed(3),
          stderrPct: +stderrPct.toFixed(3),
          significant,
        },
      ];
    }),
  );

  const entries = await Promise.all(scenarioPromises);
  const results = Object.fromEntries(entries);

  // Save comparison with candidate path
  const comparisonPath = join(RESULTS_DIR, "comparison_latest.json");
  writeFileSync(
    comparisonPath,
    JSON.stringify(
      {
        tier,
        candidatePath: resolve(candidatePath),
        results,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return results;
}

function printComparison(results, tier) {
  const tierLabel = `${tier}, target_error=${FIDELITY_TIERS[tier]?.target_error ?? "?"}`;
  console.log(`\nComparison Results (${tierLabel}):`);
  console.log(
    `${"Scenario".padEnd(12)} ${"Current".padStart(12)} ${"Candidate".padStart(12)} ${"Delta".padStart(10)} ${"% Change".padStart(10)} ${"StdErr".padStart(10)} ${"Significant?".padStart(14)}`,
  );
  console.log("-".repeat(82));

  for (const scenario of SCENARIO_KEYS) {
    const r = results[scenario];
    if (!r) continue;
    const label = SCENARIO_LABELS[scenario];
    const sign = r.deltaPct >= 0 ? "+" : "";
    let sigLabel = "NO (noise)";
    if (r.significant) sigLabel = r.deltaPct > 0 ? "YES" : "YES (WORSE)";

    console.log(
      `${label.padEnd(12)} ${r.current.toLocaleString().padStart(12)} ${r.candidate.toLocaleString().padStart(12)} ${(sign + r.delta.toLocaleString()).padStart(10)} ${signedPct(r.deltaPct, 2).padStart(10)} ${("±" + r.stderrPct.toFixed(2) + "%").padStart(10)} ${sigLabel.padStart(14)}`,
    );
  }

  // Weighted total
  const { delta: weightedDelta, stderr: weightedStderr } =
    computeWeightedDelta(results);
  const weightedSig = Math.abs(weightedDelta) > 2 * weightedStderr;

  console.log("-".repeat(82));
  console.log(
    `${"Weighted".padEnd(12)} ${"".padStart(12)} ${"".padStart(12)} ${"".padStart(10)} ${signedPct(weightedDelta).padStart(10)} ${("±" + weightedStderr.toFixed(3) + "%").padStart(10)} ${(weightedSig ? "YES" : "NO").padStart(14)}`,
  );
}

// --- Multi-Build Comparison ---

// Run multi-actor sims for an APL file against the roster.
// Returns { builds: { "<buildId>": { heroTree, dps: {st, small_aoe, big_aoe} } } }
async function runMultiBuildBaseline(aplPath, roster, tierConfig) {
  const totalCores = cpus().length;
  const threadsPerSim = Math.max(
    1,
    Math.floor(totalCores / SCENARIO_KEYS.length),
  );

  const content = generateMultiActorContent(roster, aplPath);

  const scenarioResults = await Promise.all(
    SCENARIO_KEYS.map(async (scenario) => {
      const actorDps = await runMultiActorAsync(
        content,
        scenario,
        "multibuild",
        {
          simOverrides: { ...tierConfig, threads: threadsPerSim },
        },
      );
      return [scenario, actorDps];
    }),
  );

  // Combine into per-build results
  const builds = {};
  for (const build of roster.builds) {
    builds[build.id] = {
      heroTree: build.heroTree,
      archetype: build.archetype,
      dps: {},
    };
    for (const [scenario, actorDps] of scenarioResults) {
      const actorResult = actorDps.get(build.id);
      builds[build.id].dps[scenario] = actorResult ? actorResult.dps : 0;
    }
  }

  return { builds };
}

// Run multi-build comparison: baseline APL + candidate APL against all roster builds.
// Returns per-build deltas + aggregate metrics.
async function runMultiBuildComparison(
  candidatePath,
  roster,
  tier = "standard",
) {
  const tierConfig = FIDELITY_TIERS[tier] || FIDELITY_TIERS.standard;
  const totalCores = cpus().length;
  const threadsPerSim = Math.max(
    1,
    Math.floor(totalCores / (SCENARIO_KEYS.length * 2)),
  );

  const baseContent = generateMultiActorContent(roster, CURRENT_APL);
  const candidateContent = generateMultiActorContent(roster, candidatePath);

  // Run all 6 sims (3 scenarios × 2 APLs) in parallel
  const allPromises = [];
  for (const scenario of SCENARIO_KEYS) {
    allPromises.push(
      runMultiActorAsync(baseContent, scenario, "mb_current", {
        simOverrides: { ...tierConfig, threads: threadsPerSim },
      }).then((r) => ({ scenario, type: "current", results: r })),
    );
    allPromises.push(
      runMultiActorAsync(candidateContent, scenario, "mb_candidate", {
        simOverrides: { ...tierConfig, threads: threadsPerSim },
      }).then((r) => ({ scenario, type: "candidate", results: r })),
    );
  }

  const allResults = await Promise.all(allPromises);

  // Group by scenario and type
  const byScenario = {};
  for (const r of allResults) {
    if (!byScenario[r.scenario]) byScenario[r.scenario] = {};
    byScenario[r.scenario][r.type] = r.results;
  }

  // Compute per-build, per-scenario deltas
  const buildResults = {};
  for (const build of roster.builds) {
    buildResults[build.id] = {
      heroTree: build.heroTree,
      archetype: build.archetype,
      scenarios: {},
    };
    for (const scenario of SCENARIO_KEYS) {
      const current = byScenario[scenario]?.current?.get(build.id)?.dps || 0;
      const candidate =
        byScenario[scenario]?.candidate?.get(build.id)?.dps || 0;
      const delta = candidate - current;
      const deltaPct = current > 0 ? (delta / current) * 100 : 0;
      buildResults[build.id].scenarios[scenario] = {
        current: Math.round(current),
        candidate: Math.round(candidate),
        delta: Math.round(delta),
        deltaPct: +deltaPct.toFixed(3),
      };
    }
  }

  // Compute weighted delta per build
  for (const [buildId, br] of Object.entries(buildResults)) {
    let weighted = 0;
    for (const scenario of SCENARIO_KEYS) {
      weighted +=
        (br.scenarios[scenario]?.deltaPct || 0) * SCENARIO_WEIGHTS[scenario];
    }
    br.weightedDelta = +weighted.toFixed(3);
  }

  // Aggregate metrics
  const buildEntries = Object.values(buildResults);
  const meanWeighted =
    buildEntries.reduce((sum, b) => sum + b.weightedDelta, 0) /
    buildEntries.length;
  const worstWeighted = Math.min(...buildEntries.map((b) => b.weightedDelta));

  // Group by hero tree dynamically
  const treeAvgs = {};
  const treeGroups = {};
  for (const b of buildEntries) {
    const tree = b.heroTree || "unknown";
    if (!treeGroups[tree]) treeGroups[tree] = [];
    treeGroups[tree].push(b);
  }
  for (const [tree, builds] of Object.entries(treeGroups)) {
    treeAvgs[tree] = +(
      builds.reduce((s, b) => s + b.weightedDelta, 0) / builds.length
    ).toFixed(3);
  }

  const comparison = {
    multiBuild: true,
    tier,
    candidatePath: resolve(candidatePath),
    buildResults,
    aggregate: {
      meanWeighted: +meanWeighted.toFixed(3),
      worstWeighted: +worstWeighted.toFixed(3),
      treeAvgs,
    },
    timestamp: new Date().toISOString(),
  };

  // Save comparison
  const comparisonPath = join(RESULTS_DIR, "comparison_latest.json");
  writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2));

  return comparison;
}

function printMultiBuildComparison(comparison) {
  const { buildResults, aggregate, tier } = comparison;
  const tierLabel = `${tier}, target_error=${FIDELITY_TIERS[tier]?.target_error ?? "?"}`;

  console.log(`\nMulti-Build Comparison (${tierLabel}):`);
  console.log(
    `${"Build".padEnd(25)} ${"Hero".padEnd(6)} ${"1T".padStart(8)} ${"5T".padStart(8)} ${"10T".padStart(8)} ${"Weighted".padStart(9)}`,
  );
  console.log("-".repeat(67));

  for (const [buildId, br] of Object.entries(buildResults)) {
    const hero = (br.heroTree || "?").slice(0, 6);
    const cols = SCENARIO_KEYS.map((s) =>
      signedPct(br.scenarios[s]?.deltaPct || 0, 2),
    );
    console.log(
      `${buildId.padEnd(25)} ${hero.padEnd(6)} ${cols[0].padStart(8)} ${cols[1].padStart(8)} ${cols[2].padStart(8)} ${signedPct(br.weightedDelta, 2).padStart(9)}`,
    );
  }

  console.log("-".repeat(67));
  const treeAvgStr = aggregate.treeAvgs
    ? Object.entries(aggregate.treeAvgs)
        .map(([tree, avg]) => `${tree}: ${signedPct(avg)}`)
        .join("  ")
    : "";
  console.log(
    `Mean: ${signedPct(aggregate.meanWeighted)}  |  Worst: ${signedPct(aggregate.worstWeighted)}  |  ${treeAvgStr}`,
  );

  // Accept criteria check
  const passAccept = aggregate.meanWeighted > 0 && aggregate.worstWeighted > -1;
  console.log(
    `\nAccept criteria: mean>0 ${aggregate.meanWeighted > 0 ? "PASS" : "FAIL"}, worst>-1% ${aggregate.worstWeighted > -1 ? "PASS" : "FAIL"} → ${passAccept ? "RECOMMEND ACCEPT" : "RECOMMEND REJECT"}`,
  );
}

// --- Dashboard Helpers ---

function progressBar(fraction, width = 20) {
  const filled = Math.round(fraction * width);
  const partial = fraction * width - Math.floor(fraction * width);
  let bar = "█".repeat(Math.min(filled, width));
  if (bar.length < width && partial > 0.5) bar += "▒";
  bar = bar.padEnd(width, "░");
  return bar;
}

function formatElapsed(startISO) {
  const ms = Date.now() - new Date(startISO).getTime();
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m ago`;
  return `${mins}m ago`;
}

// --- Subcommands ---

async function cmdInit(aplPath) {
  const resolvedPath = resolve(aplPath);
  if (!existsSync(resolvedPath)) {
    console.error(`APL file not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`Initializing iteration state from ${basename(aplPath)}...`);
  mkdirSync(dirname(CURRENT_APL), { recursive: true });
  copyFileSync(resolvedPath, CURRENT_APL);

  // Check for multi-build roster
  const roster = loadRoster();
  const multiBuild = roster && roster.builds.length > 0;

  if (multiBuild) {
    console.log(
      `Multi-build mode: ${roster.builds.length} builds in roster (${roster.tier} tier)`,
    );
    console.log("Running multi-actor baseline across all scenarios...");

    const tierConfig = FIDELITY_TIERS.standard;
    const baseline = await runMultiBuildBaseline(
      CURRENT_APL,
      roster,
      tierConfig,
    );

    // Also run single-actor workflow for hypothesis generation
    console.log("Running single-actor workflow for hypothesis generation...");
    const workflowResults = await runWorkflow(CURRENT_APL);
    const workflowPath = join(RESULTS_DIR, "workflow_current.json");
    writeFileSync(workflowPath, JSON.stringify(workflowResults, null, 2));

    const hypotheses = generateHypotheses(workflowResults);

    const state = {
      version: STATE_VERSION,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      multiBuild: true,
      roster: {
        path: "results/build-roster.json",
        tier: roster.tier,
        buildCount: roster.builds.length,
      },
      originalBaseline: {
        apl: basename(aplPath),
        builds: baseline.builds,
      },
      current: {
        apl: "apls/current.simc",
        builds: baseline.builds,
        workflowResults: "results/workflow_current.json",
      },
      iterations: [],
      pendingHypotheses: hypotheses,
      exhaustedHypotheses: [],
      consecutiveRejections: 0,
      findings: [],
    };

    saveState(state);
    writeDashboard(state);
    writeChangelog(state);
    writeFindings(state);

    console.log("\nBaseline DPS (per build):");
    for (const [buildId, b] of Object.entries(baseline.builds)) {
      const hero = (b.heroTree || "?").slice(0, 6);
      const dpsStr = SCENARIO_KEYS.map(
        (s) =>
          `${SCENARIO_LABELS[s]}:${Math.round(b.dps[s] || 0).toLocaleString()}`,
      ).join("  ");
      console.log(`  ${buildId.padEnd(25)} [${hero}]  ${dpsStr}`);
    }

    console.log(`\nGenerated ${hypotheses.length} hypotheses.`);
    printHypotheses(hypotheses.slice(0, 5));
    console.log(
      "\nMulti-build iteration state initialized. Ready for /iterate-apl.",
    );
  } else {
    // Single-build mode (original behavior)
    console.log("Running baseline workflow across all scenarios...");
    const workflowResults = await runWorkflow(CURRENT_APL);

    const workflowPath = join(RESULTS_DIR, "workflow_current.json");
    writeFileSync(workflowPath, JSON.stringify(workflowResults, null, 2));

    const dps = {};
    for (const s of workflowResults.scenarios.filter((s) => !s.error)) {
      dps[s.scenario] = s.dps;
    }

    const hypotheses = generateHypotheses(workflowResults);

    const state = {
      version: STATE_VERSION,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      multiBuild: false,
      originalBaseline: {
        apl: basename(aplPath),
        dps,
      },
      current: {
        apl: "apls/current.simc",
        dps,
        workflowResults: "results/workflow_current.json",
      },
      iterations: [],
      pendingHypotheses: hypotheses,
      exhaustedHypotheses: [],
      consecutiveRejections: 0,
      findings: [],
    };

    saveState(state);
    writeDashboard(state);
    writeChangelog(state);
    writeFindings(state);

    console.log("\nBaseline DPS:");
    for (const [key, value] of Object.entries(dps)) {
      console.log(
        `  ${SCENARIO_LABELS[key] || key}: ${value.toLocaleString()}`,
      );
    }

    console.log(`\nGenerated ${hypotheses.length} hypotheses.`);
    printHypotheses(hypotheses.slice(0, 5));
    console.log("\nIteration state initialized. Ready for /iterate-apl.");
  }
}

function cmdStatus() {
  const state = loadState();
  if (!state) {
    console.log(
      "No iteration state found. Run: node src/sim/iterate.js init <apl.simc>",
    );
    process.exit(1);
  }

  const iterCount = state.iterations.length;
  const accepted = state.iterations.filter(
    (i) => i.decision === "accepted",
  ).length;
  const rejected = state.iterations.filter(
    (i) => i.decision !== "accepted",
  ).length;

  const consecRej = state.consecutiveRejections || 0;

  console.log("=== APL Iteration Progress ===");
  console.log(
    `Started: ${formatElapsed(state.startedAt)} | Iterations: ${iterCount} (${accepted} accepted, ${rejected} rejected)`,
  );
  if (consecRej > 0) {
    console.log(`Consecutive rejections: ${consecRej}`);
  }

  // DPS progress with bars
  const origDps = getAggregateDps(state.originalBaseline);
  const currDps = getAggregateDps(state.current);
  console.log(
    `\nDPS Progress${state.multiBuild ? " (mean across builds)" : ""}:`,
  );
  for (const key of SCENARIO_KEYS) {
    const label = SCENARIO_LABELS[key];
    const orig = origDps[key];
    const curr = currDps[key];
    if (orig === undefined || curr === undefined) continue;

    const delta = ((curr - orig) / orig) * 100;
    // Bar: fraction of a 5% improvement target
    const fraction = Math.min(1, Math.max(0, delta / 5));
    const bar = progressBar(fraction);
    console.log(
      `  ${label.padEnd(4)} ${orig.toLocaleString().padStart(12)} → ${curr.toLocaleString().padStart(12)}  ${bar}  ${signedPct(delta, 2)}`,
    );
  }

  // Acceptance rate
  if (iterCount > 0) {
    const rate = (accepted / iterCount) * 100;
    const rateBar = progressBar(accepted / iterCount, 12);
    console.log(
      `\nAcceptance: ${rateBar} ${rate.toFixed(0)}% (${accepted}/${iterCount})`,
    );
  }

  console.log(
    `Hypotheses: ${state.pendingHypotheses.length} pending, ${state.exhaustedHypotheses.length} exhausted`,
  );

  // Recent iterations
  if (iterCount > 0) {
    console.log("\nRecent:");
    for (const iter of state.iterations.slice(-5)) {
      const emoji = iter.decision === "accepted" ? "✓" : "✗";
      let summary;
      if (iter.comparison?.aggregates) {
        const a = iter.comparison.aggregates;
        summary = `mean:${signedPct(a.meanWeighted, 2)}  worst:${a.worstWeighted.toFixed(2)}%`;
      } else {
        summary = Object.entries(iter.results || {})
          .map(([k, v]) => {
            const label = SCENARIO_LABELS[k] || k;
            return `${label}:${signedPct(v.delta_pct ?? 0, 1)}`;
          })
          .join("  ");
      }
      const desc =
        iter.hypothesis.length > 40
          ? iter.hypothesis.slice(0, 40) + "…"
          : iter.hypothesis;
      console.log(
        `  #${String(iter.id).padStart(2)} ${emoji} ${desc}  ${summary}`,
      );
    }
  }

  writeDashboard(state);
}

async function cmdCompare(candidatePath, tier) {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const resolvedPath = resolve(candidatePath);
  if (!existsSync(resolvedPath)) {
    console.error(`Candidate file not found: ${resolvedPath}`);
    process.exit(1);
  }

  if (state.multiBuild) {
    const roster = loadRoster();
    if (!roster) {
      console.error(
        "Multi-build state but no roster found. Regenerate roster first.",
      );
      process.exit(1);
    }
    console.log(
      `Multi-build comparison against ${roster.builds.length} builds (${tier} fidelity)...`,
    );
    const comparison = await runMultiBuildComparison(
      resolvedPath,
      roster,
      tier,
    );
    printMultiBuildComparison(comparison);
  } else {
    console.log(
      `Comparing candidate against current baseline (${tier} fidelity)...`,
    );
    const results = await runComparison(resolvedPath, tier);
    printComparison(results, tier);
  }
}

async function cmdAccept(reason, hypothesisHint) {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const compPath = join(RESULTS_DIR, "comparison_latest.json");
  if (!existsSync(compPath)) {
    console.error("No comparison results found. Run compare first.");
    process.exit(1);
  }
  const comparison = JSON.parse(readFileSync(compPath, "utf-8"));

  const candidatePath =
    comparison.candidatePath || join(ROOT, "apls", "candidate.simc");
  if (!existsSync(candidatePath)) {
    console.error(`Candidate file not found: ${candidatePath}`);
    process.exit(1);
  }
  copyFileSync(candidatePath, CURRENT_APL);

  // For multi-build comparisons, wrap in the format recordIteration expects
  const iterComparison = comparison.multiBuild
    ? { results: {}, multiBuild: true, aggregate: comparison.aggregate }
    : comparison;

  const { iterNum } = recordIteration(
    state,
    iterComparison,
    reason,
    hypothesisHint,
    "accepted",
  );

  if (state.multiBuild && comparison.multiBuild) {
    // Update per-build DPS from multi-build comparison
    for (const [buildId, br] of Object.entries(comparison.buildResults)) {
      if (state.current.builds[buildId]) {
        for (const scenario of SCENARIO_KEYS) {
          if (br.scenarios[scenario]) {
            state.current.builds[buildId].dps[scenario] =
              br.scenarios[scenario].candidate;
          }
        }
      }
    }
  } else {
    // Single-build: update aggregate DPS
    for (const [scenario, r] of Object.entries(comparison.results || {})) {
      if (state.current.dps) state.current.dps[scenario] = r.candidate;
    }
  }

  console.log("Running workflow on new baseline...");
  const workflowResults = await runWorkflow(CURRENT_APL);
  const workflowPath = join(RESULTS_DIR, "workflow_current.json");
  writeFileSync(workflowPath, JSON.stringify(workflowResults, null, 2));
  state.current.workflowResults = "results/workflow_current.json";

  state.pendingHypotheses = generateHypotheses(workflowResults);
  state.consecutiveRejections = 0;

  // Track significant findings (state + SQLite)
  if (comparison.multiBuild) {
    if (Math.abs(comparison.aggregate.meanWeighted) > 0.5) {
      const finding = {
        iteration: iterNum,
        timestamp: new Date().toISOString(),
        hypothesis: reason,
        weightedDelta: comparison.aggregate.meanWeighted,
        multiBuild: true,
        aggregate: comparison.aggregate,
      };
      state.findings.push(finding);
      try {
        dbAddFinding({
          insight: reason,
          evidence: `${comparison.aggregate.meanWeighted > 0 ? "+" : ""}${comparison.aggregate.meanWeighted.toFixed(2)}% weighted (multi-build)`,
          confidence:
            Math.abs(comparison.aggregate.meanWeighted) > 1 ? "high" : "medium",
          status: "validated",
          tags: ["iteration", "accepted"],
        });
      } catch {
        /* SQLite optional */
      }
    }
  } else {
    const weighted = computeWeightedDelta(comparison.results);
    if (Math.abs(weighted.delta) > 0.5) {
      const finding = {
        iteration: iterNum,
        timestamp: new Date().toISOString(),
        hypothesis: reason,
        weightedDelta: weighted.delta,
        scenarios: Object.fromEntries(
          Object.entries(comparison.results).map(([k, v]) => [k, v.deltaPct]),
        ),
      };
      state.findings.push(finding);
      try {
        dbAddFinding({
          insight: reason,
          evidence: `${weighted.delta > 0 ? "+" : ""}${weighted.delta.toFixed(2)}% weighted`,
          confidence: Math.abs(weighted.delta) > 1 ? "high" : "medium",
          status: "validated",
          tags: ["iteration", "accepted"],
        });
      } catch {
        /* SQLite optional */
      }
    }
  }

  saveState(state);
  writeDashboard(state);
  writeChangelog(state);
  writeFindings(state);
  console.log(`\nIteration #${iterNum} accepted: ${reason}`);
  console.log(`${state.pendingHypotheses.length} hypotheses regenerated.`);
}

function cmdReject(reason, hypothesisHint) {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const compPath = join(RESULTS_DIR, "comparison_latest.json");
  const comparison = existsSync(compPath)
    ? JSON.parse(readFileSync(compPath, "utf-8"))
    : { results: {} };

  const { iterNum, hypothesis } = recordIteration(
    state,
    comparison,
    reason,
    hypothesisHint,
    "rejected",
  );

  state.exhaustedHypotheses.push(hypothesis);
  state.consecutiveRejections = (state.consecutiveRejections || 0) + 1;
  saveState(state);
  writeDashboard(state);

  console.log(`Iteration #${iterNum} rejected: ${reason}`);
  console.log(`Consecutive rejections: ${state.consecutiveRejections}`);
  console.log(`${state.pendingHypotheses.length} hypotheses remaining.`);

  if (state.consecutiveRejections >= 10) {
    console.log(
      "\nSTOPPING: 10+ consecutive rejections. Run `summary` to see results or `hypotheses` to regenerate ideas.",
    );
  } else if (state.consecutiveRejections >= 5) {
    console.log("\nESCAPE STRATEGIES suggested:");
    const strategies = suggestEscapeStrategies(state);
    for (const s of strategies) {
      console.log(`  - ${s}`);
    }
  } else if (state.consecutiveRejections >= 3) {
    console.log(
      "\nWARNING: 3+ consecutive rejections. Consider escape strategies (compound mutations, reversals, radical reorder).",
    );
  }
}

async function cmdHypotheses() {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  // Regenerate from latest workflow results
  const workflowPath = join(ROOT, state.current.workflowResults);
  if (!existsSync(workflowPath)) {
    console.error("No workflow results found. Run init or accept first.");
    process.exit(1);
  }

  const workflowResults = JSON.parse(readFileSync(workflowPath, "utf-8"));
  const hypotheses = generateHypotheses(workflowResults);

  // Filter out exhausted ones (normalized to ignore metric changes)
  // Handle both .description (metric hypotheses) and .hypothesis (strategic hypotheses)
  const exhaustedKeys = new Set(
    state.exhaustedHypotheses.map((h) =>
      normalizeHypothesisKey(h.hypothesis || h.description || ""),
    ),
  );
  const fresh = hypotheses.filter(
    (h) =>
      !exhaustedKeys.has(
        normalizeHypothesisKey(h.hypothesis || h.description || ""),
      ),
  );

  state.pendingHypotheses = fresh;
  saveState(state);

  console.log(
    `${fresh.length} hypotheses (${state.exhaustedHypotheses.length} exhausted):`,
  );
  printHypotheses(fresh);
}

function cmdSummary() {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const lines = [];
  lines.push("# APL Iteration Report\n");
  lines.push(`Generated: ${new Date().toISOString()}\n`);

  // DPS progression
  const origDpsSummary = getAggregateDps(state.originalBaseline);
  const currDpsSummary = getAggregateDps(state.current);
  lines.push(
    `## DPS Progression${state.multiBuild ? " (mean across builds)" : ""}\n`,
  );
  lines.push("| Scenario | Baseline | Current | Delta |");
  lines.push("|----------|----------|---------|-------|");
  for (const key of SCENARIO_KEYS) {
    const label = SCENARIO_LABELS[key];
    const orig = origDpsSummary[key];
    const curr = currDpsSummary[key];
    if (orig === undefined) continue;
    const delta =
      curr !== undefined
        ? (((curr - orig) / orig) * 100).toFixed(2) + "%"
        : "—";
    lines.push(
      `| ${label} | ${(orig || 0).toLocaleString()} | ${(curr || 0).toLocaleString()} | ${delta} |`,
    );
  }

  // Iteration history
  lines.push("\n## Iteration History\n");
  if (state.multiBuild) {
    lines.push(
      "| # | Decision | Hypothesis | Mutation | Mean | Worst | AR | Anni |",
    );
    lines.push(
      "|---|----------|------------|----------|------|-------|----|----|",
    );
  } else {
    lines.push("| # | Decision | Hypothesis | Mutation | 1T | 5T | 10T |");
    lines.push("|---|----------|------------|----------|----|----|-----|");
  }
  for (const iter of state.iterations) {
    let cols;
    if (iter.comparison?.aggregates) {
      const a = iter.comparison.aggregates;
      cols = [
        signedPct(a.meanWeighted, 2),
        `${a.worstWeighted.toFixed(2)}%`,
        signedPct(a.arAvg, 2),
        signedPct(a.anniAvg, 2),
      ];
    } else {
      const r = iter.results || {};
      cols = SCENARIO_KEYS.map((k) => {
        const v = r[k];
        if (!v) return "—";
        return signedPct(v.delta_pct ?? 0, 2);
      });
    }
    const hyp =
      iter.hypothesis.length > 50
        ? iter.hypothesis.slice(0, 50) + "…"
        : iter.hypothesis;
    const mut =
      (iter.mutation || "").length > 30
        ? iter.mutation.slice(0, 30) + "…"
        : iter.mutation || "";
    lines.push(
      `| ${iter.id} | ${iter.decision} | ${hyp} | ${mut} | ${cols.join(" | ")} |`,
    );
  }

  // Most impactful accepted changes
  const accepted = state.iterations.filter((i) => i.decision === "accepted");
  if (accepted.length > 0) {
    lines.push("\n## Most Impactful Changes\n");
    const scored = accepted
      .map((iter) => ({ ...iter, wd: iterWeightedDelta(iter) }))
      .sort((a, b) => b.wd - a.wd);
    for (const s of scored.slice(0, 10)) {
      lines.push(
        `- **#${s.id}** (${signedPct(s.wd)} weighted): ${s.hypothesis}`,
      );
    }
  }

  // Rejected hypotheses
  if (state.exhaustedHypotheses.length > 0) {
    lines.push("\n## Rejected Hypotheses\n");
    for (const h of state.exhaustedHypotheses) {
      lines.push(`- [${h.category}] ${h.description}`);
    }
  }

  // Remaining ideas
  if (state.pendingHypotheses.length > 0) {
    lines.push("\n## Remaining Untested Ideas\n");
    for (const h of state.pendingHypotheses.slice(0, 20)) {
      lines.push(
        `- [${h.category}] ${h.description} (priority: ${h.priority.toFixed(1)})`,
      );
    }
    if (state.pendingHypotheses.length > 20) {
      lines.push(`\n...and ${state.pendingHypotheses.length - 20} more`);
    }
  }

  const report = lines.join("\n");
  const reportPath = join(RESULTS_DIR, "iteration-report.md");
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(reportPath, report);
  console.log(report);
  console.log(`\nReport saved to ${reportPath}`);

  writeDashboard(state);
  writeChangelog(state);
  writeFindings(state);
}

// --- Rollback ---

async function cmdRollback(iterationId) {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const targetId = parseInt(iterationId, 10);
  const targetIdx = state.iterations.findIndex((i) => i.id === targetId);

  if (targetIdx === -1) {
    console.error(`Iteration #${targetId} not found.`);
    process.exit(1);
  }

  const target = state.iterations[targetIdx];
  if (target.decision !== "accepted") {
    console.error(
      `Iteration #${targetId} was not accepted — nothing to rollback.`,
    );
    process.exit(1);
  }

  // Mark this iteration as rolled back
  target.decision = "rolled_back";
  target.rollbackTimestamp = new Date().toISOString();

  if (state.multiBuild) {
    // Multi-build: deep clone baseline builds, then replay accepted iterations
    const restoredBuilds = JSON.parse(
      JSON.stringify(state.originalBaseline.builds),
    );
    for (let i = 0; i < targetIdx; i++) {
      const iter = state.iterations[i];
      if (iter.decision === "accepted" && iter.comparison?.buildResults) {
        for (const [buildId, br] of Object.entries(
          iter.comparison.buildResults,
        )) {
          if (restoredBuilds[buildId]) {
            for (const [scenario, sd] of Object.entries(br.scenarios || {})) {
              restoredBuilds[buildId].dps[scenario] = sd.candidate;
            }
          }
        }
      }
    }
    state.current.builds = restoredBuilds;
  } else {
    // Single-build: replay flat DPS
    let previousDps = { ...state.originalBaseline.dps };
    for (let i = 0; i < targetIdx; i++) {
      const iter = state.iterations[i];
      if (iter.decision === "accepted" && iter.results) {
        for (const [scenario, r] of Object.entries(iter.results)) {
          previousDps[scenario] = r.candidate;
        }
      }
    }
    state.current.dps = previousDps;
  }

  // Note: We can't easily restore the APL file without snapshots.
  // Log warning that manual APL restoration may be needed.
  console.log(
    `\nWARNING: DPS tracking reverted, but apls/current.simc was not restored.`,
  );
  console.log(`You may need to manually restore the APL from git or a backup.`);

  saveState(state);
  writeDashboard(state);
  writeChangelog(state);

  console.log(`\nIteration #${targetId} marked as rolled back.`);
  console.log(`DPS reverted to pre-iteration state.`);
}

// --- Auto-Generate Candidate ---

async function cmdAutoGenerate() {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  if (state.pendingHypotheses.length === 0) {
    console.error("No pending hypotheses. Run `hypotheses` to regenerate.");
    process.exit(1);
  }

  // Find hypotheses with mutations
  const withMutations = state.pendingHypotheses.filter((h) => h.aplMutation);
  if (withMutations.length === 0) {
    console.error("No hypotheses with auto-mutation available.");
    console.log("Top hypotheses without mutations:");
    for (const h of state.pendingHypotheses.slice(0, 3)) {
      console.log(`  - ${h.description || h.hypothesis}`);
    }
    process.exit(1);
  }

  const aplText = readFileSync(CURRENT_APL, "utf-8");
  const ast = parse(aplText);

  // Try each hypothesis until one succeeds
  for (const hypothesis of withMutations) {
    const mutation = hypothesis.aplMutation;
    console.log(`\nTrying hypothesis:`);
    console.log(
      `  ${hypothesis.strategicGoal || hypothesis.description || hypothesis.hypothesis}`,
    );
    console.log(`  Mutation: ${describeMutation(mutation)}`);

    try {
      // Validate mutation first
      const validation = validateMutation(ast, mutation);

      if (!validation.valid) {
        console.log(`  Skipping — validation failed: ${validation.errors[0]}`);
        // Mark as exhausted so we don't retry
        state.exhaustedHypotheses.push(hypothesis);
        const idx = state.pendingHypotheses.indexOf(hypothesis);
        if (idx !== -1) state.pendingHypotheses.splice(idx, 1);
        continue;
      }

      // Generate candidate
      const candidatePath = join(ROOT, "apls", "candidate.simc");
      const result = generateCandidate(CURRENT_APL, mutation, candidatePath);

      console.log(`\nGenerated: ${result.outputPath}`);
      console.log(`Description: ${result.description}`);
      console.log(
        `\nRun: node src/sim/iterate.js compare apls/candidate.simc --quick`,
      );

      saveState(state);
      return;
    } catch (e) {
      console.log(`  Skipping — generation failed: ${e.message}`);
      // Mark as exhausted
      state.exhaustedHypotheses.push(hypothesis);
      const idx = state.pendingHypotheses.indexOf(hypothesis);
      if (idx !== -1) state.pendingHypotheses.splice(idx, 1);
      continue;
    }
  }

  saveState(state);
  console.error(
    "\nAll hypothesis mutations failed. Run `strategic` to regenerate.",
  );
  process.exit(1);
}

// --- Strategic Hypotheses Generation ---

async function cmdStrategicHypotheses() {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const workflowPath = join(ROOT, state.current.workflowResults);
  if (!existsSync(workflowPath)) {
    console.error("No workflow results found. Run init or accept first.");
    process.exit(1);
  }

  const workflowResults = JSON.parse(readFileSync(workflowPath, "utf-8"));
  const aplText = readFileSync(CURRENT_APL, "utf-8");

  const hypotheses = generateStrategicHypotheses(workflowResults, aplText);

  // Filter out exhausted ones
  const exhaustedKeys = new Set(
    state.exhaustedHypotheses.map((h) => normalizeHypothesisKey(h.description)),
  );
  const fresh = hypotheses.filter(
    (h) =>
      !exhaustedKeys.has(
        normalizeHypothesisKey(h.hypothesis || h.description || ""),
      ),
  );

  // Update state with strategic hypotheses
  state.pendingHypotheses = fresh.map((h) => ({
    category: h.category,
    description: h.hypothesis || h.observation,
    strategicGoal: h.strategicGoal,
    priority: h.priority || 0,
    scenario: h.scenario,
    aplMutation: h.aplMutation,
  }));

  saveState(state);

  console.log(
    `\n${fresh.length} strategic hypotheses generated (${state.exhaustedHypotheses.length} exhausted):\n`,
  );

  for (const h of fresh.slice(0, 10)) {
    console.log(
      `[${h.confidence || "medium"}] ${h.strategicGoal || h.hypothesis}`,
    );
    if (h.archetypeContext) {
      console.log(`  Context: ${h.archetypeContext.slice(0, 80)}...`);
    }
    if (h.aplMutation) {
      console.log(`  Mutation: ${describeMutation(h.aplMutation)}`);
    }
    console.log(`  Priority: ${(h.priority || 0).toFixed(1)}\n`);
  }

  if (fresh.length > 10) {
    console.log(`...and ${fresh.length - 10} more\n`);
  }
}

// --- Temporal Hypothesis Generation ---

async function cmdTheorycraft() {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const workflowPath = join(ROOT, state.current.workflowResults);
  if (!existsSync(workflowPath)) {
    console.error("No workflow results found. Run init or accept first.");
    process.exit(1);
  }

  const workflowResults = JSON.parse(readFileSync(workflowPath, "utf-8"));
  const aplText = readFileSync(CURRENT_APL, "utf-8");

  // Load spell data
  const spellDataPath = join(ROOT, "data", "spells.json");
  const spellData = existsSync(spellDataPath)
    ? JSON.parse(readFileSync(spellDataPath, "utf-8"))
    : [];

  // Run temporal analysis
  const resourceFlow = analyzeResourceFlow(spellData, aplText, workflowResults);
  const hypotheses = generateTemporalHypotheses(resourceFlow, aplText);

  // Filter out exhausted ones
  const exhaustedKeys = new Set(
    state.exhaustedHypotheses.map((h) =>
      normalizeHypothesisKey(h.hypothesis || h.description || ""),
    ),
  );
  const fresh = hypotheses.filter(
    (h) =>
      !exhaustedKeys.has(
        normalizeHypothesisKey(h.hypothesis || h.description || ""),
      ),
  );

  // Update state with temporal hypotheses
  state.pendingHypotheses = fresh.map((h) => ({
    category: h.category,
    description: h.hypothesis,
    hypothesis: h.hypothesis,
    strategicGoal: h.hypothesis,
    observation: h.observation,
    priority: h.priority || 0,
    confidence: h.confidence,
    scenario: h.scenario,
    aplMutation: h.aplMutation,
    temporalAnalysis: h.temporalAnalysis,
    prediction: h.prediction,
    counterArgument: h.counterArgument,
  }));

  saveState(state);

  console.log(
    `\n${fresh.length} temporal hypotheses generated (${state.exhaustedHypotheses.length} exhausted):\n`,
  );

  for (const h of fresh.slice(0, 10)) {
    console.log(`[${h.confidence || "medium"}] ${h.hypothesis}`);
    console.log(`  Category: ${h.category}`);
    if (h.temporalAnalysis?.timingWindow) {
      console.log(`  Window: ${h.temporalAnalysis.timingWindow}`);
    }
    if (h.prediction) {
      console.log(`  Prediction: ${h.prediction}`);
    }
    if (h.aplMutation) {
      console.log(`  Mutation: ${describeMutation(h.aplMutation)}`);
    }
    console.log(`  Priority: ${(h.priority || 0).toFixed(1)}\n`);
  }

  if (fresh.length > 10) {
    console.log(`...and ${fresh.length - 10} more\n`);
  }
}

// --- Synthesis ---

async function cmdSynthesize() {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const workflowPath = join(ROOT, state.current.workflowResults);
  if (!existsSync(workflowPath)) {
    console.error("No workflow results found. Run init or accept first.");
    process.exit(1);
  }

  const workflowResults = JSON.parse(readFileSync(workflowPath, "utf-8"));

  // Generate from all specialist sources
  console.log("Generating metric hypotheses...");
  const metricHypotheses = generateHypotheses(workflowResults);
  saveSpecialistOutput("resource_flow", {
    hypotheses: metricHypotheses.map((h) => ({
      ...h,
      id: h.description,
      hypothesis: h.description,
      priority: h.priority || 5,
    })),
  });

  console.log("Generating strategic hypotheses...");
  const aplPath = state.current.apl;
  const aplText = existsSync(join(ROOT, aplPath))
    ? readFileSync(join(ROOT, aplPath), "utf-8")
    : null;
  if (aplText) {
    const strategicHyps = generateStrategicHypotheses(workflowResults, aplText);
    saveSpecialistOutput("talent", {
      hypotheses: strategicHyps.map((h) => ({
        ...h,
        id: h.hypothesis || h.observation,
        priority: h.priority || 5,
      })),
    });
  }

  console.log("Generating temporal hypotheses...");
  if (aplText) {
    const spellDataPath = join(ROOT, "data", "spells.json");
    const spellData = existsSync(spellDataPath)
      ? JSON.parse(readFileSync(spellDataPath, "utf-8"))
      : [];
    const resourceFlow = analyzeResourceFlow(
      spellData,
      aplText,
      workflowResults,
    );
    const temporalHyps = generateTemporalHypotheses(resourceFlow, aplText);
    saveSpecialistOutput("state_machine", {
      hypotheses: temporalHyps.map((h) => ({
        ...h,
        id: h.hypothesis,
        priority: h.priority || 5,
      })),
    });
  }

  // Synthesize all sources
  console.log("\nSynthesizing across all specialists...");
  const { loadSpecialistOutputs } = await import("../analyze/synthesizer.js");
  const outputs = loadSpecialistOutputs();
  const result = synthesizeHypotheses(outputs);

  // Filter exhausted
  const exhaustedKeys = new Set(
    state.exhaustedHypotheses.map((h) =>
      normalizeHypothesisKey(h.hypothesis || h.description || ""),
    ),
  );
  const fresh = result.hypotheses.filter(
    (h) =>
      !exhaustedKeys.has(
        normalizeHypothesisKey(h.hypothesis || h.systemicIssue || h.id || ""),
      ),
  );

  // Map synthesized hypotheses back to iteration format
  state.pendingHypotheses = fresh.map((h) => ({
    description: h.systemicIssue || h.hypothesis || h.id,
    hypothesis: h.systemicIssue || h.hypothesis || h.id,
    priority: h.aggregatePriority || h.priority || 0,
    consensusCount: h.consensusCount || 1,
    specialists: h.specialists || [],
    aplMutation: h.proposedChanges?.[0]?.aplMutation || h.aplMutation || null,
  }));

  saveState(state);

  console.log(
    `\n${fresh.length} synthesized hypotheses (${result.metadata.totalRaw} raw, ${result.conflicts.length} conflicts resolved):`,
  );
  console.log(`  Specialists: ${result.metadata.specialists.join(", ")}`);

  for (const h of fresh.slice(0, 10)) {
    const desc = h.systemicIssue || h.hypothesis || h.id || "unknown";
    const consensus =
      h.consensusCount > 1 ? ` [${h.consensusCount}x consensus]` : "";
    console.log(`\n${consensus} ${desc}`);
    console.log(`  Priority: ${(h.aggregatePriority || 0).toFixed(1)}`);
    if (h.specialists?.length > 1) {
      console.log(`  Sources: ${h.specialists.join(", ")}`);
    }
  }
}

// --- Checkpoint Management ---

const CHECKPOINT_PATH = join(RESULTS_DIR, "checkpoint.md");

function cmdCheckpoint(options = {}) {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const {
    currentArchetype = null,
    currentBuild = null,
    currentHypothesis = null,
    problemStatement = null,
    rootTheory = null,
    notes = "",
  } = options;

  const lines = [];
  lines.push("# Iteration Checkpoint\n");
  lines.push(`Saved: ${new Date().toISOString()}\n`);

  // Problem statement section (for context when resuming)
  if (problemStatement || rootTheory) {
    lines.push("## Problem Statement\n");
    if (problemStatement) {
      lines.push(`- **Focus:** ${problemStatement}`);
    }
    if (rootTheory) {
      lines.push(`- **Root Theory:** ${rootTheory}`);
    }
    lines.push("");
  }

  // Session summary
  const iterCount = state.iterations.length;
  const accepted = state.iterations.filter(
    (i) => i.decision === "accepted",
  ).length;
  const rejected = iterCount - accepted;

  lines.push("## Session Summary\n");
  lines.push(
    `- Iterations: ${iterCount} (${accepted} accepted, ${rejected} rejected)`,
  );
  lines.push(`- Consecutive rejections: ${state.consecutiveRejections || 0}`);
  lines.push(`- Pending hypotheses: ${state.pendingHypotheses.length}`);
  lines.push(`- Exhausted hypotheses: ${state.exhaustedHypotheses.length}`);
  lines.push("");

  // Current position in deep iteration loop
  lines.push("## Current Position\n");
  if (currentArchetype) {
    lines.push(`- **Archetype:** ${currentArchetype}`);
  }
  if (currentBuild) {
    lines.push(`- **Build:** ${currentBuild}`);
  }
  if (currentHypothesis) {
    lines.push(`- **Hypothesis:** ${currentHypothesis}`);
  }
  if (!currentArchetype && !currentBuild && !currentHypothesis) {
    lines.push(
      "- No deep iteration position recorded (use --archetype, --build, --hypothesis flags)",
    );
  }
  lines.push("");

  // DPS progress
  const origDps = getAggregateDps(state.originalBaseline);
  const currDps = getAggregateDps(state.current);
  lines.push(
    `## DPS Progress${state.multiBuild ? " (mean across builds)" : ""}\n`,
  );
  lines.push("| Scenario | Baseline | Current | Delta |");
  lines.push("|----------|----------|---------|-------|");
  for (const key of SCENARIO_KEYS) {
    const label = SCENARIO_LABELS[key];
    const orig = origDps[key];
    const curr = currDps[key];
    if (orig === undefined) continue;
    const delta =
      curr !== undefined ? signedPct(((curr - orig) / orig) * 100, 2) : "—";
    lines.push(
      `| ${label} | ${(orig || 0).toLocaleString()} | ${(curr || 0).toLocaleString()} | ${delta} |`,
    );
  }
  lines.push("");

  // Key findings this session
  const sessionFindings = (state.findings || []).slice(-10);
  if (sessionFindings.length > 0) {
    lines.push("## Key Findings This Session\n");
    for (const f of sessionFindings) {
      lines.push(
        `- **#${f.iteration}** (${signedPct(f.weightedDelta, 2)}): ${f.hypothesis}`,
      );
    }
    lines.push("");
  }

  // Remaining work
  lines.push("## Remaining Work\n");

  // Top pending hypotheses
  if (state.pendingHypotheses.length > 0) {
    lines.push("### Top Pending Hypotheses\n");
    for (const h of state.pendingHypotheses.slice(0, 5)) {
      const desc =
        h.description || h.hypothesis || h.strategicGoal || "unknown";
      lines.push(
        `1. [${h.category || "unknown"}] ${desc.slice(0, 80)}${desc.length > 80 ? "…" : ""}`,
      );
      if (h.aplMutation) {
        lines.push(
          `   - Has auto-mutation: ${describeMutation(h.aplMutation).slice(0, 60)}`,
        );
      }
    }
    if (state.pendingHypotheses.length > 5) {
      lines.push(
        `\n...and ${state.pendingHypotheses.length - 5} more hypotheses`,
      );
    }
    lines.push("");
  }

  // Recent iterations for context
  if (state.iterations.length > 0) {
    lines.push("### Recent Iterations\n");
    lines.push("| # | Decision | Hypothesis | Weighted |");
    lines.push("|---|----------|------------|----------|");
    for (const iter of state.iterations.slice(-5)) {
      const wDelta = iterWeightedDelta(iter);
      const hyp =
        (iter.hypothesis || "").slice(0, 40) +
        (iter.hypothesis?.length > 40 ? "…" : "");
      lines.push(
        `| ${iter.id} | ${iter.decision} | ${hyp} | ${signedPct(wDelta || 0, 2)} |`,
      );
    }
    lines.push("");
  }

  // User notes
  if (notes) {
    lines.push("## Session Notes\n");
    lines.push(notes);
    lines.push("");
  }

  // Resume instructions
  lines.push("## Resume Instructions\n");
  lines.push("To continue from this checkpoint:");
  lines.push("1. Run `node src/sim/iterate.js status` to verify state");
  lines.push(
    "2. If specialist outputs > 24h old, re-run `strategic` or `theorycraft`",
  );
  lines.push("3. Continue from the position recorded above");
  lines.push("");

  const checkpointContent = lines.join("\n");
  writeFileSync(CHECKPOINT_PATH, checkpointContent);

  // Also save checkpoint metadata to state for programmatic resume
  state.checkpoint = {
    timestamp: new Date().toISOString(),
    archetype: currentArchetype,
    build: currentBuild,
    hypothesis: currentHypothesis,
    notes,
  };
  saveState(state);

  console.log("Checkpoint saved to results/checkpoint.md");
  console.log(`\nSession summary:`);
  console.log(
    `  Iterations: ${iterCount} (${accepted} accepted, ${rejected} rejected)`,
  );
  console.log(`  Pending hypotheses: ${state.pendingHypotheses.length}`);
  if (currentArchetype || currentBuild) {
    console.log(
      `  Position: ${currentArchetype || "—"} / ${currentBuild || "—"}`,
    );
  }
}

function loadCheckpoint() {
  const state = loadState();
  if (!state?.checkpoint) return null;
  return state.checkpoint;
}

function hasRecentCheckpoint(maxAgeHours = 24) {
  const checkpoint = loadCheckpoint();
  if (!checkpoint) return false;

  const age = Date.now() - new Date(checkpoint.timestamp).getTime();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  return age < maxAgeMs;
}

// Check if specialist outputs are fresh enough to reuse
function areSpecialistOutputsFresh(maxAgeHours = 24) {
  const specialistFiles = [
    "analysis_spell_data.json",
    "analysis_talent.json",
    "analysis_resource_flow.json",
    "analysis_state_machine.json",
  ];

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  for (const filename of specialistFiles) {
    const filepath = join(RESULTS_DIR, filename);
    if (!existsSync(filepath)) return false;

    try {
      const content = JSON.parse(readFileSync(filepath, "utf-8"));
      if (!content.timestamp) return false;

      const age = now - new Date(content.timestamp).getTime();
      if (age > maxAgeMs) return false;
    } catch {
      return false;
    }
  }

  return true;
}

// Export checkpoint functions for use by orchestrator
export { loadCheckpoint, hasRecentCheckpoint, areSpecialistOutputsFresh };

// --- Escape Strategies ---

function suggestEscapeStrategies(state) {
  const suggestions = [];
  const consecRej = state.consecutiveRejections || 0;

  if (consecRej >= 5) {
    suggestions.push("Try compound mutations (combine 2-3 related changes)");
    suggestions.push(
      "Try reversing a previous accepted change that may have downstream effects",
    );
    suggestions.push(
      "Focus on a different scenario (if ST is stuck, try optimizing AoE)",
    );
    suggestions.push("Try radical reorder of action priority");
  }

  if (consecRej >= 8) {
    suggestions.push("Consider re-evaluating the archetype strategy");
    suggestions.push("Run full workflow analysis to find new angles");
  }

  return suggestions;
}

// --- Output Helpers ---

// Format a number with explicit sign prefix: "+1.234%" or "-0.567%"
function signedPct(value, decimals = 3) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

// Get the weighted delta for an iteration record (handles both single/multi-build).
function iterWeightedDelta(iter) {
  if (iter.comparison?.aggregates) {
    return iter.comparison.aggregates.meanWeighted;
  }
  return computeWeightedDelta(iter.results || {}).delta;
}

function computeWeightedDelta(results) {
  let delta = 0;
  let stderr = 0;
  for (const scenario of SCENARIO_KEYS) {
    const r = results[scenario];
    if (!r) continue;
    const w = SCENARIO_WEIGHTS[scenario];
    delta += (r.deltaPct || r.delta_pct || 0) * w;
    stderr += ((r.stderrPct || 0) * w) ** 2;
  }
  return { delta: +delta.toFixed(3), stderr: +Math.sqrt(stderr).toFixed(3) };
}

function writeDashboard(state) {
  const lines = [];
  lines.push("# APL Iteration Dashboard\n");
  lines.push(`Updated: ${new Date().toISOString()}\n`);

  const iterCount = state.iterations.length;
  const accepted = state.iterations.filter(
    (i) => i.decision === "accepted",
  ).length;
  const rejected = iterCount - accepted;
  const consecRej = state.consecutiveRejections || 0;

  lines.push("## Session Stats\n");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Iterations | ${iterCount} |`);
  lines.push(`| Accepted | ${accepted} |`);
  lines.push(`| Rejected | ${rejected} |`);
  lines.push(
    `| Acceptance rate | ${iterCount > 0 ? ((accepted / iterCount) * 100).toFixed(0) : 0}% |`,
  );
  lines.push(`| Consecutive rejections | ${consecRej} |`);
  lines.push(`| Hypotheses pending | ${state.pendingHypotheses.length} |`);
  lines.push(`| Hypotheses exhausted | ${state.exhaustedHypotheses.length} |`);

  const origDpsDash = getAggregateDps(state.originalBaseline);
  const currDpsDash = getAggregateDps(state.current);
  lines.push(
    `\n## DPS Progress${state.multiBuild ? " (mean across builds)" : ""}\n`,
  );
  lines.push("| Scenario | Baseline | Current | Delta |");
  lines.push("|----------|----------|---------|-------|");
  for (const key of SCENARIO_KEYS) {
    const label = SCENARIO_LABELS[key];
    const orig = origDpsDash[key];
    const curr = currDpsDash[key];
    if (orig === undefined) continue;
    const delta =
      curr !== undefined
        ? (((curr - orig) / orig) * 100).toFixed(2) + "%"
        : "—";
    lines.push(
      `| ${label} | ${(orig || 0).toLocaleString()} | ${(curr || 0).toLocaleString()} | ${delta} |`,
    );
  }

  if (iterCount > 0) {
    lines.push("\n## Recent Iterations\n");
    lines.push("| # | Decision | Hypothesis | Weighted Delta |");
    lines.push("|---|----------|------------|----------------|");
    for (const iter of state.iterations.slice(-10)) {
      const wDelta = iterWeightedDelta(iter);
      const hyp =
        iter.hypothesis.length > 50
          ? iter.hypothesis.slice(0, 50) + "…"
          : iter.hypothesis;
      lines.push(
        `| ${iter.id} | ${iter.decision} | ${hyp} | ${signedPct(wDelta || 0)} |`,
      );
    }
  }

  const dashPath = join(RESULTS_DIR, "dashboard.md");
  writeFileSync(dashPath, lines.join("\n") + "\n");
}

function writeFindings(state) {
  const findings = state.findings || [];
  const lines = [];
  lines.push("# Significant Findings\n");
  lines.push(`Updated: ${new Date().toISOString()}\n`);

  if (findings.length === 0) {
    lines.push(
      "No significant findings yet (threshold: >0.5% weighted delta).\n",
    );
  } else {
    lines.push("| Iteration | Weighted Delta | Hypothesis | ST | 5T | 10T |");
    lines.push("|-----------|----------------|------------|----|----|-----|");
    for (const f of findings) {
      const scenarios = f.scenarios || {};
      const cols = SCENARIO_KEYS.map((k) => {
        const v = scenarios[k];
        return v !== undefined ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—";
      });
      lines.push(
        `| ${f.iteration} | ${f.weightedDelta >= 0 ? "+" : ""}${f.weightedDelta.toFixed(3)}% | ${f.hypothesis} | ${cols.join(" | ")} |`,
      );
    }
  }

  writeFileSync(join(RESULTS_DIR, "findings.md"), lines.join("\n") + "\n");
}

function writeChangelog(state) {
  const accepted = state.iterations.filter((i) => i.decision === "accepted");
  const lines = [];
  lines.push("# APL Changelog\n");
  lines.push(`Updated: ${new Date().toISOString()}\n`);

  if (accepted.length === 0) {
    lines.push("No accepted changes yet.\n");
  } else {
    for (const iter of [...accepted].reverse()) {
      const wDelta = iterWeightedDelta(iter);
      lines.push(
        `## Iteration #${iter.id} (${signedPct(wDelta || 0)} weighted)\n`,
      );
      lines.push(`**${iter.timestamp}**\n`);
      lines.push(`${iter.hypothesis}\n`);
      if (iter.mutation) lines.push(`Change: ${iter.mutation}\n`);
      if (iter.comparison?.aggregates) {
        const a = iter.comparison.aggregates;
        lines.push(
          `AR avg: ${signedPct(a.arAvg)} | Anni avg: ${signedPct(a.anniAvg)} | Worst: ${a.worstWeighted.toFixed(3)}%\n`,
        );
      } else {
        const scenarioDetail = SCENARIO_KEYS.map((k) => {
          const r = iter.results?.[k];
          if (!r) return null;
          return `${SCENARIO_LABELS[k]}: ${signedPct(r.delta_pct ?? 0, 2)}`;
        })
          .filter(Boolean)
          .join(", ");
        if (scenarioDetail) lines.push(`Scenarios: ${scenarioDetail}\n`);
      }
    }
  }

  writeFileSync(join(RESULTS_DIR, "changelog.md"), lines.join("\n") + "\n");
}

function printHypotheses(hypotheses) {
  for (let i = 0; i < hypotheses.length; i++) {
    const h = hypotheses[i];
    console.log(
      `  ${i + 1}. [${h.category}] ${h.description} (priority: ${h.priority.toFixed(1)})`,
    );
  }
}

// --- CLI ---

function parseHypothesisFlag(args) {
  const idx = args.indexOf("--hypothesis");
  if (idx === -1) return { hint: null, remaining: args };
  const hint = args[idx + 1] || null;
  const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { hint, remaining };
}

const [cmd, ...rawArgs] = process.argv.slice(2);

switch (cmd) {
  case "init":
    if (!rawArgs[0]) {
      console.error("Usage: node src/sim/iterate.js init <apl.simc>");
      process.exit(1);
    }
    await cmdInit(rawArgs[0]);
    break;

  case "status":
    cmdStatus();
    break;

  case "compare": {
    if (!rawArgs[0]) {
      console.error(
        "Usage: node src/sim/iterate.js compare <candidate.simc> [--quick|--confirm]",
      );
      process.exit(1);
    }
    let tier = "standard";
    if (rawArgs.includes("--quick")) tier = "quick";
    else if (rawArgs.includes("--confirm")) tier = "confirm";
    await cmdCompare(rawArgs[0], tier);
    break;
  }

  case "accept": {
    const { hint, remaining } = parseHypothesisFlag(rawArgs);
    if (!remaining[0]) {
      console.error(
        'Usage: node src/sim/iterate.js accept "reason" [--hypothesis "fragment"]',
      );
      process.exit(1);
    }
    await cmdAccept(remaining.join(" "), hint);
    break;
  }

  case "reject": {
    const { hint, remaining } = parseHypothesisFlag(rawArgs);
    if (!remaining[0]) {
      console.error(
        'Usage: node src/sim/iterate.js reject "reason" [--hypothesis "fragment"]',
      );
      process.exit(1);
    }
    cmdReject(remaining.join(" "), hint);
    break;
  }

  case "hypotheses":
    await cmdHypotheses();
    break;

  case "summary":
    cmdSummary();
    break;

  case "rollback":
    if (!rawArgs[0]) {
      console.error("Usage: node src/sim/iterate.js rollback <iteration-id>");
      process.exit(1);
    }
    await cmdRollback(rawArgs[0]);
    break;

  case "generate":
    await cmdAutoGenerate();
    break;

  case "strategic":
    await cmdStrategicHypotheses();
    break;

  case "theorycraft":
    await cmdTheorycraft();
    break;

  case "synthesize":
    await cmdSynthesize();
    break;

  case "checkpoint": {
    // Parse checkpoint flags
    const checkpointOpts = {};
    for (let i = 0; i < rawArgs.length; i++) {
      if (rawArgs[i] === "--archetype" && rawArgs[i + 1]) {
        checkpointOpts.currentArchetype = rawArgs[++i];
      } else if (rawArgs[i] === "--build" && rawArgs[i + 1]) {
        checkpointOpts.currentBuild = rawArgs[++i];
      } else if (rawArgs[i] === "--hypothesis" && rawArgs[i + 1]) {
        checkpointOpts.currentHypothesis = rawArgs[++i];
      } else if (rawArgs[i] === "--problem" && rawArgs[i + 1]) {
        checkpointOpts.problemStatement = rawArgs[++i];
      } else if (rawArgs[i] === "--theory" && rawArgs[i + 1]) {
        checkpointOpts.rootTheory = rawArgs[++i];
      } else if (rawArgs[i] === "--notes" && rawArgs[i + 1]) {
        checkpointOpts.notes = rawArgs[++i];
      }
    }
    cmdCheckpoint(checkpointOpts);
    break;
  }

  default:
    console.log(`APL Iteration Manager

Usage:
  node src/sim/iterate.js init <apl.simc>           Initialize with baseline
  node src/sim/iterate.js status                     Show current state
  node src/sim/iterate.js compare <candidate.simc>   Compare candidate [--quick|--confirm]
  node src/sim/iterate.js accept "reason"            Accept candidate [--hypothesis "fragment"]
  node src/sim/iterate.js reject "reason"            Reject candidate [--hypothesis "fragment"]
  node src/sim/iterate.js hypotheses                 List improvement hypotheses
  node src/sim/iterate.js strategic                  Generate strategic hypotheses with auto-mutations
  node src/sim/iterate.js theorycraft                Generate temporal resource flow hypotheses
  node src/sim/iterate.js synthesize                 Synthesize hypotheses from all specialist sources
  node src/sim/iterate.js generate                   Auto-generate candidate from top hypothesis
  node src/sim/iterate.js rollback <iteration-id>    Rollback an accepted iteration
  node src/sim/iterate.js summary                    Generate iteration report
  node src/sim/iterate.js checkpoint                 Save checkpoint for session resume`);
    break;
}
