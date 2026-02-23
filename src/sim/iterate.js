// APL iteration state management CLI.
// Manages the autonomous APL optimization loop: baseline tracking,
// candidate comparison, accept/reject workflow, hypothesis generation.
//
// Subcommands:
//   init <apl.simc>              Initialize iteration state with baseline
//   status                       Print current iteration state
//   compare <candidate.simc>     Screen→standard staged comparison (--quick|--confirm)
//   accept "reason"              Adopt candidate as new baseline
//   reject "reason"              Log rejection and move on
//   hypotheses                   Generate improvement hypotheses
//   unify                        Merge all sources, consensus detection, mutation inference
//   summary                      Generate iteration report
//   checkpoint                   Save checkpoint for session resume

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename, resolve, relative } from "node:path";
import { cpus } from "node:os";
import { runWorkflow } from "./workflow.js";
import {
  SCENARIOS,
  SCENARIO_WEIGHTS,
  SIM_DEFAULTS,
  runMultiActorAsync,
} from "./runner.js";
import {
  getSpecAdapter,
  loadSpecAdapter,
  initSpec,
  FIDELITY_TIERS,
  checkSync,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { loadRoster, updateDps, saveRosterDps } from "./build-roster.js";
import { generateMultiActorContent } from "./multi-actor.js";
import {
  generateProfileset,
  runProfileset,
  runProfilesetAsync,
  resolveInputDirectives,
  generateRosterProfilesetContent,
  profilesetResultsToActorMap,
} from "./profilesets.js";
import {
  generateStrategicHypotheses,
  loadApl,
} from "../analyze/strategic-hypotheses.js";
import { MUTATION_OPS } from "../apl/mutator.js";
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
import {
  addFinding as dbAddFinding,
  addIteration as dbAddIteration,
  addHypothesis as dbAddHypothesis,
  updateHypothesis as dbUpdateHypothesis,
  getHypotheses as dbGetHypotheses,
  popNextHypothesis as dbPopNextHypothesis,
  getIterations as dbGetIterations,
  setSessionState,
  getSessionState,
  getAllSessionState,
  clearSession,
  setBaselineDps,
  getBaselineDps,
  updateBaselineDpsCurrent,
  getSessionSummary,
  getRosterBuilds,
} from "../util/db.js";
import {
  loadAllDivergences,
  buildDivergenceHypotheses,
} from "../analyze/divergence-to-hypotheses.js";
import { analyzePatterns } from "../analysis/pattern-analysis.js";
import { crossArchetypeSynthesize } from "../analyze/cross-archetype-synthesis.js";
import {
  generateTheories,
  persistTheories,
  formatTheoryCandidates,
} from "../analyze/theory-generator.js";
import {
  unifyHypotheses,
  persistUnified,
  summarizeUnified,
} from "../analyze/unify-hypotheses.js";
import { groupIndependent } from "../analyze/hypothesis-independence.js";
import {
  ROOT,
  resultsDir,
  resultsFile,
  aplsDir,
  dataFile,
  ensureSpecDirs,
  getSpecName,
} from "../engine/paths.js";
import { randomUUID, createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

await initSpec(parseSpecArg());

const RESULTS_DIR = resultsDir();
// Iteration working copy — created by `init`, updated by `accept`.
const CURRENT_APL = join(aplsDir(), "current.simc");

const SCENARIO_KEYS = Object.keys(SCENARIOS);
const SCENARIO_LABELS = Object.fromEntries(
  Object.entries(SCENARIOS).map(([k, v]) => [k, v.name]),
);

const STATE_VERSION = 3;

// CLI override for actor batch size (null = use fidelity-based default)
let batchSizeOverride = null;

// Extract aggregate per-scenario DPS from state, handling both single-build and multi-build.
// For multi-build: averages across all builds. Returns per-scenario DPS map.
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

// --- State Management (DB-first) ---

function loadState() {
  return getSessionState("iteration_state");
}

function saveState(state) {
  state.version = STATE_VERSION;
  state.lastUpdated = new Date().toISOString();
  setSessionState("iteration_state", state);
}

// Strip numbers/percentages for hypothesis deduplication.
function normalizeHypothesisKey(description) {
  return description
    .replace(/[\d.]+%?/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

// Insert hypotheses into DB, deduplicating by normalized summary within the same source.
// Different sources may insert the same semantic hypothesis — unify handles cross-source merging.
function insertHypothesesToDb(hypotheses, source = "workflow") {
  const existing = dbGetHypotheses({ limit: 2000 });
  // Dedup within-source: key = "source:normalizedSummary"
  const existingKeys = new Set(
    existing.map(
      (h) => `${h.source || ""}:${normalizeHypothesisKey(h.summary || "")}`,
    ),
  );
  let inserted = 0;
  for (const h of hypotheses) {
    const summary = h.description || h.hypothesis || h.summary || "";
    const key = `${source}:${normalizeHypothesisKey(summary)}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    dbAddHypothesis({
      summary,
      category: h.category || null,
      priority: h.priority ?? 5.0,
      status: "pending",
      source,
      mutation: h.aplMutation || h.mutation || null,
      metadata: h.metadata || null,
    });
    inserted++;
  }
  return inserted;
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

// Static resource-flow hypothesis generation — fallback when workflow sims are unavailable.
// Parses APL text for resource thresholds and generates sweep/priority hypotheses.
function generateStaticResourceHypotheses(aplText, spellData) {
  const hypotheses = [];
  const lines = aplText.split("\n");

  // Extract resource conditions: fury>=N, soul_fragments>=N, etc.
  const thresholdPattern = /(\w+)\s*(>=|<=|>|<|=)\s*(\d+)/g;
  const resourceKeywords = new Set([
    "fury",
    "soul_fragments",
    "pain",
    "health",
    "sigil_of_flame",
  ]);
  const thresholdsByResource = new Map();

  for (const line of lines) {
    if (!line.startsWith("actions")) continue;
    // Extract the ability name
    const abilityMatch = line.match(/actions(?:\.\w+)?(?:\+)?=\/(\w+)/);
    if (!abilityMatch) continue;
    const ability = abilityMatch[1];

    const ifMatch = line.match(/,if=(.+)/);
    if (!ifMatch) continue;
    const condition = ifMatch[1];

    let match;
    thresholdPattern.lastIndex = 0;
    while ((match = thresholdPattern.exec(condition)) !== null) {
      const [, resource, op, valueStr] = match;
      if (!resourceKeywords.has(resource)) continue;
      const value = parseInt(valueStr);
      const key = `${resource}:${ability}`;
      if (!thresholdsByResource.has(key)) {
        thresholdsByResource.set(key, []);
      }
      thresholdsByResource.get(key).push({ resource, op, value, ability });
    }
  }

  // Generate threshold sweep hypotheses
  for (const [key, entries] of thresholdsByResource) {
    const { resource, value, ability } = entries[0];
    const sweepDown = Math.max(1, value - 1);
    const sweepUp = value + 1;
    hypotheses.push({
      category: "threshold_sweep",
      description: `Sweep ${resource} threshold on ${ability}: currently ${entries[0].op}${value}, try ${sweepDown} and ${sweepUp}`,
      priority: 5,
    });
  }

  // Generate spender priority hypotheses from spell data
  const spenders = spellData.filter(
    (s) => s.resource && s.resource.cost && s.resource.cost > 0,
  );
  const spenderNames = new Set(spenders.map((s) => s.name?.toLowerCase()));
  const aplAbilities = [];
  for (const line of lines) {
    if (!line.startsWith("actions")) continue;
    const m = line.match(/actions(?:\.\w+)?(?:\+)?=\/(\w+)/);
    if (m && spenderNames.has(m[1].replace(/_/g, " "))) {
      aplAbilities.push(m[1]);
    }
  }
  // Suggest reordering adjacent spenders
  for (let i = 0; i < aplAbilities.length - 1; i++) {
    hypotheses.push({
      category: "spender_priority",
      description: `Try swapping spender priority: ${aplAbilities[i]} before ${aplAbilities[i + 1]} — compare resource efficiency`,
      priority: 4,
    });
  }

  return hypotheses;
}

// --- Hypothesis Matching ---

function popHypothesis(_state, descriptionFragment) {
  if (descriptionFragment) {
    const frag = descriptionFragment.toLowerCase();
    const pending = dbGetHypotheses({ status: "pending", limit: 200 });
    const match = pending.find((h) =>
      (h.summary || "").toLowerCase().includes(frag),
    );
    if (match) {
      dbUpdateHypothesis(match.id, {
        status: "testing",
        tested_at: new Date().toISOString(),
      });
      return { ...match, description: match.summary, dbId: match.id };
    }
  }
  const next = dbPopNextHypothesis();
  if (next) return { ...next, description: next.summary, dbId: next.id };
  return { description: "manual change", category: "manual" };
}

// --- Iteration Recording ---

function recordIteration(state, comparison, reason, hypothesisHint, decision) {
  const iterNum = state.iterations.length + 1;

  const hypothesis = popHypothesis(state, hypothesisHint);

  const iterEntry = {
    id: iterNum,
    timestamp: new Date().toISOString(),
    hypothesis: hypothesis.description,
    category: hypothesis.category,
    mutation: reason,
    decision,
    reason,
  };

  if (comparison.multiBuild) {
    // Accepted: keep per-build candidate DPS (needed for rollback replay).
    // Rejected: aggregates only (per-build details not needed).
    const compactComparison = { aggregates: comparison.aggregate };
    if (decision === "accepted") {
      const compactBuilds = {};
      for (const [buildId, br] of Object.entries(comparison.buildResults)) {
        compactBuilds[buildId] = {
          scenarios: Object.fromEntries(
            Object.entries(br.scenarios || {}).map(([s, sd]) => [
              s,
              { candidate: sd.candidate },
            ]),
          ),
        };
      }
      compactComparison.buildResults = compactBuilds;
    }
    iterEntry.comparison = compactComparison;
  } else {
    // Single-build: flat per-scenario results
    iterEntry.results = Object.fromEntries(
      Object.entries(comparison.results || {}).map(([scenario, r]) => [
        scenario,
        { current: r.current, candidate: r.candidate, delta_pct: r.deltaPct },
      ]),
    );
  }

  state.iterations.push(iterEntry);

  return { iterNum, hypothesis };
}

// --- Comparison ---

function buildProfilesetContent(candidatePath) {
  const baseContent = resolveInputDirectives(
    readFileSync(CURRENT_APL, "utf-8"),
    dirname(CURRENT_APL),
  );
  const candidateContent = resolveInputDirectives(
    readFileSync(candidatePath, "utf-8"),
    dirname(resolve(candidatePath)),
  );

  const actionLines = candidateContent
    .split("\n")
    .filter((l) => l.startsWith("actions") && l.trim());

  if (actionLines.length === 0) {
    throw new Error(`No action lines found in ${candidatePath}`);
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
  const comparisonPath = resultsFile("comparison_latest.json");
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

// Batch size based on target_error. Higher fidelity = more iterations per actor = more memory.
// Confirm (0.1) needs small batches because 10T with many actors at low target_error
// generates huge sample data per actor. Quick (1.0) can handle more actors per batch.
function batchSizeForFidelity(tierConfig) {
  if (batchSizeOverride) return batchSizeOverride;
  const te = tierConfig.target_error ?? 0.3;
  if (te <= 0.1) return 4;
  if (te <= 0.3) return 8;
  return 12;
}

// Split roster into batches of at most batchSize builds.
function chunkRoster(roster, batchSize) {
  if (roster.builds.length <= batchSize) return [roster];
  const chunks = [];
  for (let i = 0; i < roster.builds.length; i += batchSize) {
    chunks.push({ builds: roster.builds.slice(i, i + batchSize) });
  }
  return chunks;
}

// Merge multiple actor Maps (disjoint build IDs) into one.
function mergeActorMaps(maps) {
  const merged = new Map();
  for (const m of maps) {
    for (const [k, v] of m) merged.set(k, v);
  }
  return merged;
}

// Check if all roster builds have talent hashes (required for profileset mode).
function canUseProfilesets(roster) {
  return roster.builds.every((b) => b.hash != null);
}

// Run async task factories with bounded concurrency.
// Each element in taskFactories is a () => Promise that starts the work when called.
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

const MIN_THREADS_PER_SIM = 4;

// Calculate optimal concurrency and thread allocation for sim batching.
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

// Assemble per-build DPS results from scenario-keyed actor Maps.
// scenarioResults: [[scenarioKey, Map<buildId, {dps}>], ...]
function assembleBuildsFromScenarios(roster, scenarioResults) {
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

// Run multi-actor sims for an APL file against the roster.
// Returns { builds: { "<buildId>": { heroTree, dps: { [scenario]: number } } } }
// Batches actors to avoid OOM at high fidelity.
async function runMultiBuildBaseline(aplPath, roster, tierConfig) {
  // Profileset path: constant memory (~2 actors) regardless of roster size
  if (canUseProfilesets(roster)) {
    console.log(
      `Using profileset mode (${roster.builds.length} builds, constant memory)`,
    );
    return runMultiBuildBaselineProfileset(aplPath, roster, tierConfig);
  }

  const totalCores = cpus().length;
  const threadsPerSim = Math.max(
    1,
    Math.floor(totalCores / SCENARIO_KEYS.length),
  );

  const batchSize = batchSizeForFidelity(tierConfig);
  const batches = chunkRoster(roster, batchSize);
  if (batches.length > 1) {
    console.log(
      `Batching ${roster.builds.length} builds into ${batches.length} groups of ≤${batchSize}`,
    );
  }

  // Run batches sequentially to limit peak memory
  const scenarioMaps = {};
  for (const scenario of SCENARIO_KEYS) scenarioMaps[scenario] = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    if (batches.length > 1) {
      console.log(
        `  Batch ${bi + 1}/${batches.length} (${batch.builds.length} builds)...`,
      );
    }
    const content = generateMultiActorContent(batch, aplPath);

    const batchResults = await Promise.all(
      SCENARIO_KEYS.map(async (scenario) => {
        const actorDps = await runMultiActorAsync(
          content,
          scenario,
          `multibuild_b${bi}`,
          {
            simOverrides: { ...tierConfig, threads: threadsPerSim },
          },
        );
        return [scenario, actorDps];
      }),
    );

    for (const [scenario, actorDps] of batchResults) {
      scenarioMaps[scenario].push(actorDps);
    }
  }

  // Merge batch results per scenario
  const scenarioResults = SCENARIO_KEYS.map((scenario) => [
    scenario,
    mergeActorMaps(scenarioMaps[scenario]),
  ]);

  return assembleBuildsFromScenarios(roster, scenarioResults);
}

// Profileset-based baseline: constant memory, uses talents= hash overrides.
async function runMultiBuildBaselineProfileset(aplPath, roster, tierConfig) {
  const { concurrency, threadsPerSim } = simConcurrency(SCENARIO_KEYS.length);

  const content = generateRosterProfilesetContent(roster, aplPath);

  const taskFactories = SCENARIO_KEYS.map(
    (scenario) => () =>
      runProfilesetAsync(content, scenario, "mb_ps", {
        simOverrides: { ...tierConfig, threads: threadsPerSim },
      }).then((psResults) => [
        scenario,
        profilesetResultsToActorMap(psResults, roster),
      ]),
  );

  const scenarioResults = await runWithConcurrency(taskFactories, concurrency);
  return assembleBuildsFromScenarios(roster, scenarioResults);
}

// Run multi-build comparison: baseline APL + candidate APL against all roster builds.
// Returns per-build deltas + aggregate metrics.
// Automatically uses profilesets (constant memory) when all builds have hashes,
// otherwise batches actors to avoid OOM at high fidelity.
async function runMultiBuildComparison(
  candidatePath,
  roster,
  tier = "standard",
) {
  const tierConfig = FIDELITY_TIERS[tier] || FIDELITY_TIERS.standard;

  // Get per-scenario actor Maps for current and candidate APLs
  let byScenario;
  if (canUseProfilesets(roster)) {
    console.log(
      `Using profileset mode (${roster.builds.length} builds, constant memory)`,
    );
    byScenario = await runComparisonProfileset(
      candidatePath,
      roster,
      tierConfig,
    );
  } else {
    byScenario = await runComparisonBatched(candidatePath, roster, tierConfig);
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
        (br.scenarios[scenario]?.deltaPct || 0) *
        (SCENARIO_WEIGHTS[scenario] || 0);
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
  const comparisonPath = resultsFile("comparison_latest.json");
  writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2));

  return comparison;
}

// Batched multi-actor comparison: splits roster into smaller groups to limit memory.
// Returns byScenario: { [scenario]: { current: Map, candidate: Map } }
async function runComparisonBatched(candidatePath, roster, tierConfig) {
  const simCount = SCENARIO_KEYS.length * 2;
  const { concurrency, threadsPerSim } = simConcurrency(simCount);

  const batchSize = batchSizeForFidelity(tierConfig);
  const batches = chunkRoster(roster, batchSize);
  if (batches.length > 1) {
    console.log(
      `Batching ${roster.builds.length} builds into ${batches.length} groups of ≤${batchSize}`,
    );
  }

  // Accumulate per-scenario Maps across batches
  const scenarioMaps = {};
  for (const scenario of SCENARIO_KEYS) {
    scenarioMaps[scenario] = { current: [], candidate: [] };
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    if (batches.length > 1) {
      console.log(
        `  Batch ${bi + 1}/${batches.length} (${batch.builds.length} builds)...`,
      );
    }

    const baseContent = generateMultiActorContent(batch, CURRENT_APL);
    const candidateContent = generateMultiActorContent(batch, candidatePath);

    // Build task factories for bounded concurrency
    const taskFactories = [];
    for (const scenario of SCENARIO_KEYS) {
      taskFactories.push(() =>
        runMultiActorAsync(baseContent, scenario, `mb_current_b${bi}`, {
          simOverrides: { ...tierConfig, threads: threadsPerSim },
        }).then((r) => ({ scenario, type: "current", results: r })),
      );
      taskFactories.push(() =>
        runMultiActorAsync(candidateContent, scenario, `mb_candidate_b${bi}`, {
          simOverrides: { ...tierConfig, threads: threadsPerSim },
        }).then((r) => ({ scenario, type: "candidate", results: r })),
      );
    }

    const batchResults = await runWithConcurrency(taskFactories, concurrency);
    for (const r of batchResults) {
      scenarioMaps[r.scenario][r.type].push(r.results);
    }
  }

  // Merge batch Maps per scenario+type
  const byScenario = {};
  for (const scenario of SCENARIO_KEYS) {
    byScenario[scenario] = {
      current: mergeActorMaps(scenarioMaps[scenario].current),
      candidate: mergeActorMaps(scenarioMaps[scenario].candidate),
    };
  }

  return byScenario;
}

// Profileset-based comparison: constant memory, uses talents= hash overrides.
// Returns byScenario: { [scenario]: { current: Map, candidate: Map } }
async function runComparisonProfileset(candidatePath, roster, tierConfig) {
  const simCount = SCENARIO_KEYS.length * 2;
  const { concurrency, threadsPerSim } = simConcurrency(simCount);

  const currentContent = generateRosterProfilesetContent(roster, CURRENT_APL);
  const candidateContent = generateRosterProfilesetContent(
    roster,
    candidatePath,
  );

  console.log(
    `  Concurrency: ${concurrency} sims × ${threadsPerSim} threads (${simCount} total sims)`,
  );

  const taskFactories = [];
  for (const scenario of SCENARIO_KEYS) {
    taskFactories.push(() =>
      runProfilesetAsync(currentContent, scenario, "mb_ps_current", {
        simOverrides: { ...tierConfig, threads: threadsPerSim },
      }).then((r) => ({
        scenario,
        type: "current",
        results: profilesetResultsToActorMap(r, roster),
      })),
    );
    taskFactories.push(() =>
      runProfilesetAsync(candidateContent, scenario, "mb_ps_candidate", {
        simOverrides: { ...tierConfig, threads: threadsPerSim },
      }).then((r) => ({
        scenario,
        type: "candidate",
        results: profilesetResultsToActorMap(r, roster),
      })),
    );
  }

  const allResults = await runWithConcurrency(taskFactories, concurrency);

  const byScenario = {};
  for (const r of allResults) {
    byScenario[r.scenario] ??= {};
    byScenario[r.scenario][r.type] = r.results;
  }

  return byScenario;
}

function shortScenarioLabel(key) {
  const name = SCENARIO_LABELS[key] || key;
  if (name.startsWith("Patchwerk ")) return name.replace("Patchwerk ", "");
  if (name === "Dungeon") return "DS";
  return name.slice(0, 4);
}

function printMultiBuildComparison(comparison) {
  const { buildResults, aggregate, tier } = comparison;
  const tierLabel = `${tier}, target_error=${FIDELITY_TIERS[tier]?.target_error ?? "?"}`;

  const scenarioHeaders = SCENARIO_KEYS.map((s) =>
    shortScenarioLabel(s).padStart(8),
  ).join(" ");
  const sepWidth = 25 + 1 + 6 + SCENARIO_KEYS.length * 9 + 10;

  console.log(`\nMulti-Build Comparison (${tierLabel}):`);
  console.log(
    `${"Build".padEnd(25)} ${"Hero".padEnd(6)} ${scenarioHeaders} ${"Weighted".padStart(9)}`,
  );
  console.log("-".repeat(sepWidth));

  for (const [buildId, br] of Object.entries(buildResults)) {
    const hero = (br.heroTree || "?").slice(0, 6);
    const scenarioCols = SCENARIO_KEYS.map((s) =>
      signedPct(br.scenarios[s]?.deltaPct || 0, 2).padStart(8),
    ).join(" ");
    console.log(
      `${buildId.padEnd(25)} ${hero.padEnd(6)} ${scenarioCols} ${signedPct(br.weightedDelta, 2).padStart(9)}`,
    );
  }

  console.log("-".repeat(sepWidth));
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

function progressBar(fraction, width = 20) {
  const filled = Math.min(Math.round(fraction * width), width);
  let bar = "█".repeat(filled);
  if (bar.length < width && fraction * width - filled > 0.5) bar += "▒";
  return bar.padEnd(width, "░");
}

function elapsedSecs(startMs) {
  return ((Date.now() - startMs) / 1000).toFixed(0);
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
  ensureSpecDirs();
  copyFileSync(resolvedPath, CURRENT_APL);

  // Require multi-build roster — single-build mode is not supported
  const roster = loadRoster();
  if (!roster || roster.builds.length === 0) {
    console.error(
      "No build roster found. The roster is required for multi-build iteration.\n" +
        "Generate the roster first:\n" +
        "  npm run roster generate                          # Build full layered roster\n" +
        "Or populate incrementally:\n" +
        "  npm run discover                                 # Run DoE build discovery\n" +
        "  npm run roster import-baseline                   # Import SimC default\n" +
        "  npm run roster import-community                  # Import community builds\n" +
        "  npm run roster import-doe                        # Import DoE builds\n",
    );
    process.exit(1);
  }

  console.log(`Multi-build mode: ${roster.builds.length} builds in roster`);

  // Baseline caching: skip sim if APL, SimC binary, and roster are unchanged
  const aplContent = readFileSync(CURRENT_APL, "utf-8");
  let simcHead = "";
  try {
    simcHead = checkSync().currentHead || "";
  } catch {
    // SimC sync check may fail if binary not available
  }
  const rosterHashes = roster.builds
    .map((b) => b.hash)
    .sort()
    .join(",");
  const baselineHash = createHash("sha256")
    .update(aplContent + simcHead + rosterHashes)
    .digest("hex");

  const storedHash = getSessionState("baseline_hash");
  const workflowPath = resultsFile("workflow_current.json");
  const forceInit = process.argv.includes("--force");

  if (!forceInit && storedHash === baselineHash && existsSync(workflowPath)) {
    // Verify baseline DPS data exists in DB using the stored session
    const storedSessionId = getSessionState("session_id");
    const existingBaseline = storedSessionId
      ? getBaselineDps(storedSessionId)
      : null;
    if (existingBaseline && Object.keys(existingBaseline).length > 0) {
      console.log(
        "Baseline unchanged (APL + SimC + roster hash match). Skipping sim.",
      );
      console.log("  Use --force to re-run anyway.");
      return;
    }
  }

  console.log("Running multi-actor baseline across all scenarios...");

  const tierConfig = FIDELITY_TIERS.standard;
  const baseline = await runMultiBuildBaseline(CURRENT_APL, roster, tierConfig);

  // Update persistent roster with baseline DPS
  for (const [buildId, b] of Object.entries(baseline.builds)) {
    const weighted = SCENARIO_KEYS.reduce(
      (sum, s) => sum + (b.dps[s] || 0) * (SCENARIO_WEIGHTS[s] || 0),
      0,
    );
    updateDps(roster, buildId, { ...b.dps, weighted });
  }
  saveRosterDps(roster);

  // Also run single-actor workflow for hypothesis generation
  console.log("Running single-actor workflow for hypothesis generation...");
  const workflowResults = await runWorkflow(CURRENT_APL);
  writeFileSync(workflowPath, JSON.stringify(workflowResults, null, 2));

  const hypotheses = generateHypotheses(workflowResults);

  // --- Write session state to DB ---
  const sessionId = randomUUID();
  clearSession(); // Clear any stale session state
  setSessionState("session_id", sessionId);
  setSessionState("phase", "iteration");
  setSessionState("started_at", new Date().toISOString());
  setSessionState("multi_build", true);
  setSessionState("roster_build_count", roster.builds.length);
  setSessionState("original_apl", basename(aplPath));
  setSessionState("current_apl_path", relative(ROOT, CURRENT_APL));
  setSessionState("consecutive_rejections", 0);
  setSessionState("baseline_hash", baselineHash);

  // Write baseline DPS per build per scenario
  for (const [buildId, b] of Object.entries(baseline.builds)) {
    for (const scenario of SCENARIO_KEYS) {
      if (b.dps[scenario] !== undefined) {
        setBaselineDps(buildId, scenario, b.dps[scenario], {
          sessionId,
          isCurrent: false,
        });
        setBaselineDps(buildId, scenario, b.dps[scenario], {
          sessionId,
          isCurrent: true,
        });
      }
    }
  }

  // Write initial hypotheses to DB
  const inserted = insertHypothesesToDb(hypotheses, "workflow");

  const state = {
    version: STATE_VERSION,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    multiBuild: true,
    sessionId,
    roster: {
      source: "db",
      buildCount: roster.builds.length,
    },
    originalBaseline: {
      apl: basename(aplPath),
      builds: baseline.builds,
    },
    current: {
      apl: relative(ROOT, CURRENT_APL),
      builds: baseline.builds,
      workflowResults: relative(ROOT, resultsFile("workflow_current.json")),
    },
    iterations: [],
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

  console.log(`\nGenerated ${inserted} hypotheses (DB).`);
  printHypotheses(hypotheses.slice(0, 5));
  console.log(
    "\nMulti-build iteration state initialized. Ready for /iterate-apl.",
  );
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

  const dbHypPending = dbGetHypotheses({
    status: "pending",
    limit: 1000,
  }).length;
  const dbHypRejected = dbGetHypotheses({
    status: "rejected",
    limit: 1000,
  }).length;
  console.log(
    `Hypotheses: ${dbHypPending} pending, ${dbHypRejected} rejected (DB)`,
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

const SCREEN_REJECT_THRESHOLD = -0.2; // weighted mean % below which quick screen rejects

async function cmdCompare(candidatePath, tier, { staged = false } = {}) {
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

    if (staged) {
      // Fidelity staging: screen at quick, escalate to standard if promising
      const screenStart = Date.now();
      console.log(
        `Multi-build screen against ${roster.builds.length} builds (quick fidelity, te=${FIDELITY_TIERS.quick.target_error})...`,
      );
      const screenComparison = await runMultiBuildComparison(
        resolvedPath,
        roster,
        "quick",
      );
      const screenSecs = elapsedSecs(screenStart);
      printMultiBuildComparison(screenComparison);

      const screenMean = screenComparison.aggregate.meanWeighted;
      if (screenMean < SCREEN_REJECT_THRESHOLD) {
        console.log(
          `\nScreened out at quick fidelity (mean ${signedPct(screenMean)} < ${SCREEN_REJECT_THRESHOLD}%)`,
        );
        console.log(`Screen: ${screenSecs}s (rejected, skipped standard)`);
        // Save with screening metadata
        const comparisonPath = resultsFile("comparison_latest.json");
        const saved = JSON.parse(readFileSync(comparisonPath, "utf-8"));
        saved.screened = true;
        saved.screenElapsed = +screenSecs;
        writeFileSync(comparisonPath, JSON.stringify(saved, null, 2));
        return;
      }

      // Escalate to standard
      const standardStart = Date.now();
      console.log(
        `\nScreen passed (mean ${signedPct(screenMean)}). Escalating to standard fidelity (te=${FIDELITY_TIERS.standard.target_error})...`,
      );
      const comparison = await runMultiBuildComparison(
        resolvedPath,
        roster,
        "standard",
      );
      const standardSecs = elapsedSecs(standardStart);
      printMultiBuildComparison(comparison);
      console.log(`\nScreen: ${screenSecs}s, Standard: ${standardSecs}s`);
    } else {
      console.log(
        `Multi-build comparison against ${roster.builds.length} builds (${tier} fidelity, te=${FIDELITY_TIERS[tier]?.target_error ?? "?"})...`,
      );
      const comparison = await runMultiBuildComparison(
        resolvedPath,
        roster,
        tier,
      );
      printMultiBuildComparison(comparison);
    }
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

  const compPath = resultsFile("comparison_latest.json");
  if (!existsSync(compPath)) {
    console.error("No comparison results found. Run compare first.");
    process.exit(1);
  }
  const comparison = JSON.parse(readFileSync(compPath, "utf-8"));

  const candidatePath =
    comparison.candidatePath || join(aplsDir(), "candidate.simc");
  if (!existsSync(candidatePath)) {
    console.error(`Candidate file not found: ${candidatePath}`);
    process.exit(1);
  }
  copyFileSync(candidatePath, CURRENT_APL);

  // For multi-build comparisons, wrap in the format recordIteration expects
  const iterComparison = comparison.multiBuild
    ? {
        results: {},
        multiBuild: true,
        aggregate: comparison.aggregate,
        buildResults: comparison.buildResults,
      }
    : comparison;

  const { iterNum, hypothesis } = recordIteration(
    state,
    iterComparison,
    reason,
    hypothesisHint,
    "accepted",
  );

  // --- Record iteration to DB ---
  const sessionId = state.sessionId || getSessionState("session_id");
  const dbIterResults = comparison.multiBuild
    ? comparison.buildResults
    : comparison.results || {};
  const dbIterAggregate = comparison.multiBuild
    ? comparison.aggregate
    : computeWeightedDelta(comparison.results || {});
  const dbIterationId = dbAddIteration({
    hypothesisId: hypothesis.dbId || null,
    sessionId,
    fidelity: comparison.tier || "standard",
    aplDiff: reason,
    results: dbIterResults,
    aggregate: dbIterAggregate,
    decision: "accepted",
    reason,
  });

  // Update hypothesis status in DB if we can match it
  if (hypothesis.dbId) {
    dbUpdateHypothesis(hypothesis.dbId, {
      status: "accepted",
      reason,
      tested_at: new Date().toISOString(),
    });
  }

  if (state.multiBuild && comparison.multiBuild) {
    // Update per-build DPS from multi-build comparison
    const rosterForDps = loadRoster();
    for (const [buildId, br] of Object.entries(comparison.buildResults)) {
      if (state.current.builds[buildId]) {
        for (const scenario of SCENARIO_KEYS) {
          if (br.scenarios[scenario]) {
            state.current.builds[buildId].dps[scenario] =
              br.scenarios[scenario].candidate;
          }
        }
      }
      // Also update persistent roster DPS
      if (rosterForDps) {
        const dps = {};
        for (const scenario of SCENARIO_KEYS) {
          dps[scenario] = br.scenarios[scenario]?.candidate || 0;
        }
        dps.weighted = SCENARIO_KEYS.reduce(
          (sum, s) => sum + (dps[s] || 0) * (SCENARIO_WEIGHTS[s] || 0),
          0,
        );
        updateDps(rosterForDps, buildId, dps);
      }

      // Update current baseline DPS in DB
      if (sessionId) {
        for (const scenario of SCENARIO_KEYS) {
          const candidateDps = br.scenarios[scenario]?.candidate;
          if (candidateDps !== undefined) {
            updateBaselineDpsCurrent(
              buildId,
              scenario,
              candidateDps,
              sessionId,
            );
          }
        }
      }
    }
    if (rosterForDps) saveRosterDps(rosterForDps);
  }

  console.log("Running workflow on new baseline...");
  const workflowResults = await runWorkflow(CURRENT_APL);
  const workflowPath = resultsFile("workflow_current.json");
  writeFileSync(workflowPath, JSON.stringify(workflowResults, null, 2));
  state.current.workflowResults = relative(
    ROOT,
    resultsFile("workflow_current.json"),
  );

  insertHypothesesToDb(generateHypotheses(workflowResults), "workflow");
  state.consecutiveRejections = 0;
  setSessionState("consecutive_rejections", 0);
  setSessionState("last_iteration", dbIterationId);

  // Track significant findings (state + DB)
  const findingThreshold = 0.5;
  if (comparison.multiBuild) {
    if (Math.abs(comparison.aggregate.meanWeighted) > findingThreshold) {
      const finding = {
        iteration: iterNum,
        timestamp: new Date().toISOString(),
        hypothesis: reason,
        weightedDelta: comparison.aggregate.meanWeighted,
        multiBuild: true,
        aggregate: comparison.aggregate,
      };
      state.findings.push(finding);
      dbAddFinding({
        insight: reason,
        evidence: `${comparison.aggregate.meanWeighted > 0 ? "+" : ""}${comparison.aggregate.meanWeighted.toFixed(2)}% weighted (multi-build)`,
        confidence:
          Math.abs(comparison.aggregate.meanWeighted) > 1 ? "high" : "medium",
        status: "validated",
        tags: ["iteration", "accepted"],
        iterationId: dbIterationId,
      });
    }
  } else {
    const weighted = computeWeightedDelta(comparison.results);
    if (Math.abs(weighted.delta) > findingThreshold) {
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
      dbAddFinding({
        insight: reason,
        evidence: `${weighted.delta > 0 ? "+" : ""}${weighted.delta.toFixed(2)}% weighted`,
        confidence: Math.abs(weighted.delta) > 1 ? "high" : "medium",
        status: "validated",
        tags: ["iteration", "accepted"],
        iterationId: dbIterationId,
      });
    }
  }

  saveState(state);
  writeDashboard(state);
  writeChangelog(state);
  writeFindings(state);
  console.log(`\nIteration #${iterNum} accepted: ${reason}`);
}

function cmdReject(reason, hypothesisHint) {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  const compPath = resultsFile("comparison_latest.json");
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

  // --- Record rejection to DB ---
  const sessionId = state.sessionId || getSessionState("session_id");
  const dbIterResults = comparison.multiBuild
    ? comparison.buildResults || {}
    : comparison.results || {};
  const dbIterAggregate = comparison.multiBuild
    ? comparison.aggregate || {}
    : computeWeightedDelta(comparison.results || {});
  dbAddIteration({
    hypothesisId: hypothesis.dbId || null,
    sessionId,
    fidelity: comparison.tier || "standard",
    aplDiff: reason,
    results: dbIterResults,
    aggregate: dbIterAggregate,
    decision: "rejected",
    reason,
  });

  // Update hypothesis status in DB
  if (hypothesis.dbId) {
    dbUpdateHypothesis(hypothesis.dbId, {
      status: "rejected",
      reason,
      tested_at: new Date().toISOString(),
    });
  }

  state.consecutiveRejections = (state.consecutiveRejections || 0) + 1;
  setSessionState("consecutive_rejections", state.consecutiveRejections);
  saveState(state);
  writeDashboard(state);

  const dbPending = dbGetHypotheses({ status: "pending", limit: 1000 }).length;
  console.log(`Iteration #${iterNum} rejected: ${reason}`);
  console.log(`Consecutive rejections: ${state.consecutiveRejections}`);
  console.log(`${dbPending} hypotheses remaining (DB).`);

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
  const pending = dbGetHypotheses({ status: "pending", limit: 50 });
  const rejected = dbGetHypotheses({ status: "rejected", limit: 1000 });

  console.log(`${pending.length} pending, ${rejected.length} rejected (DB):`);

  for (const h of pending) {
    const src = h.source ? ` [${h.source}]` : "";
    const cat = h.category ? ` (${h.category})` : "";
    const pri = h.priority != null ? ` priority:${h.priority.toFixed(1)}` : "";
    console.log(
      `  #${h.id}${src}${cat}${pri} — ${(h.summary || "").slice(0, 100)}`,
    );
  }
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
    const specConfig = getSpecAdapter().getSpecConfig();
    const treeNames = Object.keys(specConfig.heroTrees || {}).sort();
    const treeCols = treeNames.map(
      (t) => specConfig.heroTrees[t].displayName || t,
    );
    lines.push(
      `| # | Decision | Hypothesis | Mutation | Mean | Worst | ${treeCols.join(" | ")} |`,
    );
    lines.push(
      `|---|----------|------------|----------|------|-------|${treeCols.map(() => "----").join("|")}|`,
    );
  } else {
    lines.push("| # | Decision | Hypothesis | Mutation | 1T | 5T | 10T |");
    lines.push("|---|----------|------------|----------|----|----|-----|");
  }
  for (const iter of state.iterations) {
    let cols;
    if (iter.comparison?.aggregates) {
      const a = iter.comparison.aggregates;
      const treeAvgs = a.treeAvgs || {};
      const treeKeys = Object.keys(treeAvgs).sort();
      cols = [
        signedPct(a.meanWeighted, 2),
        `${(a.worstWeighted ?? 0).toFixed(2)}%`,
        ...treeKeys.map((k) => signedPct(treeAvgs[k] ?? 0, 2)),
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

  // Rejected hypotheses (from DB)
  const rejectedHyps = dbGetHypotheses({ status: "rejected", limit: 100 });
  if (rejectedHyps.length > 0) {
    lines.push("\n## Rejected Hypotheses\n");
    for (const h of rejectedHyps) {
      lines.push(`- [${h.category || "?"}] ${h.summary}`);
    }
  }

  // Remaining ideas (from DB)
  const pendingHyps = dbGetHypotheses({ status: "pending", limit: 21 });
  if (pendingHyps.length > 0) {
    lines.push("\n## Remaining Untested Ideas\n");
    for (const h of pendingHyps.slice(0, 20)) {
      lines.push(
        `- [${h.category || "?"}] ${h.summary} (priority: ${(h.priority || 0).toFixed(1)})`,
      );
    }
    if (pendingHyps.length > 20) {
      lines.push(`\n...and more in DB`);
    }
  }

  const report = lines.join("\n");
  const reportPath = resultsFile("iteration-report.md");
  ensureSpecDirs();
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

// --- Divergence Hypotheses ---

async function cmdDivergenceHypotheses() {
  const specName = getSpecName();
  if (!specName) {
    console.error("No spec configured. Run init first.");
    process.exit(1);
  }

  console.log(`Loading divergence files for spec: ${specName}`);
  const allDivergences = loadAllDivergences(specName);

  if (allDivergences.length === 0) {
    console.log("No divergence files found.");
    console.log(
      `Run: npm run divergence -- --spec ${specName} --build <archetype>`,
    );
    return;
  }

  console.log(
    `Found ${allDivergences.length} divergence records across all archetypes.`,
  );

  const hypotheses = buildDivergenceHypotheses(allDivergences, specName);

  if (hypotheses.length === 0) {
    console.log(
      `No cross-archetype divergences above threshold (dpgcd_delta >= 100, >= 2 archetypes).`,
    );
    return;
  }

  // Deduplicate against existing hypotheses in DB
  const existing = dbGetHypotheses({ spec: specName, limit: 200 });
  const existingSummaries = new Set(existing.map((h) => h.summary));

  let inserted = 0;
  for (const h of hypotheses) {
    if (existingSummaries.has(h.summary)) continue;
    dbAddHypothesis(h);
    inserted++;
  }

  console.log(
    `\nInserted ${inserted} new hypotheses (${hypotheses.length - inserted} duplicates skipped).`,
  );
  console.log("");
  console.log("Top divergence hypotheses:");
  for (let i = 0; i < Math.min(5, hypotheses.length); i++) {
    const h = hypotheses[i];
    console.log(`  [${h.priority}] ${h.summary}`);
    if (h.implementation) {
      console.log(`      → ${h.implementation.slice(0, 120)}`);
    }
  }
  console.log("");
  console.log(
    "Run `node src/sim/iterate.js hypotheses` to see all pending hypotheses.",
  );
}

// --- Pattern Analysis + Theory Generation ---

// Run pattern analysis in worker threads. Returns true if workers produced results.
async function runPatternWorkers(
  workerPath,
  poolSize,
  workUnits,
  aplPath,
  patternsByBuild,
  divergencesByBuild,
) {
  console.log(`\nUsing ${poolSize} workers for parallel processing...`);

  const fullConfig = getSpecAdapter().getSpecConfig();
  // Pass only the plain-data fields the worker needs — hypothesisPatterns
  // contains appliesWhen functions that can't survive structuredClone.
  const specConfig = {
    burstWindows: fullConfig.burstWindows,
    resourceModels: fullConfig.resourceModels,
    stateMachines: fullConfig.stateMachines,
  };
  const workers = [];
  try {
    for (let i = 0; i < poolSize; i++) {
      workers.push(
        new Worker(workerPath, {
          workerData: { spec: getSpecName(), specConfig },
        }),
      );
    }
  } catch (err) {
    console.log(
      `Worker creation failed (${err.message}), falling back to sequential`,
    );
    for (const w of workers) w.terminate();
    return false;
  }

  const results = await new Promise((resolve) => {
    const collected = new Map();
    let nextUnit = 0;
    let completed = 0;

    function dispatch(worker) {
      if (nextUnit >= workUnits.length) return;
      const unit = workUnits[nextUnit++];
      worker.postMessage({
        archetype: unit.archetype,
        duration: unit.duration,
        aplPath,
        runKey: unit.runKey,
      });
    }

    for (const worker of workers) {
      worker.on("message", (msg) => {
        if (msg.error) {
          console.log(`    ${msg.runKey}: ERROR ${msg.error}`);
        } else if (msg.skipped) {
          console.log(`    ${msg.runKey}: skipped (no APL file)`);
        } else {
          collected.set(msg.runKey, msg);
          console.log(
            `    ${msg.runKey}: ${msg.gcds} GCDs, ${msg.divergenceCount} divergences`,
          );
        }
        completed++;
        if (completed >= workUnits.length) resolve(collected);
        else dispatch(worker);
      });
      worker.on("error", (err) => {
        console.error(`Worker error: ${err.message}`);
        // Dead worker — don't dispatch more work to it.
        // Redistribute: try dispatching to any live worker still in the pool.
        completed++;
        if (completed >= workUnits.length) {
          resolve(collected);
        } else {
          const alive = workers.filter((w) => w !== worker);
          for (const w of alive) dispatch(w);
        }
      });
      dispatch(worker);
    }
  });

  for (const w of workers) w.terminate();

  for (const [runKey, result] of results) {
    patternsByBuild[runKey] = result.patterns;
    divergencesByBuild[runKey] = result.divergences;
  }
  return results.size > 0;
}

async function cmdPatternAnalyze() {
  const specConfig = getSpecAdapter().getSpecConfig();
  const spec = getSpecName();
  const scenarios = specConfig.scenarios || {
    st: { target_count: 1, durations: [120, 300] },
    small_aoe: { target_count: 5, durations: [75] },
    big_aoe: { target_count: 10, durations: [60] },
  };

  // Try roster-derived configs first, fall back to hardcoded analysisArchetypes
  let scenarioArchetypes;
  let source;
  const rosterBuilds = getRosterBuilds(spec);
  if (rosterBuilds.length > 0) {
    const specMod = await import(`../spec/${spec}.js`);
    scenarioArchetypes = specMod.buildAnalysisFromRoster(rosterBuilds);
    source = `roster (${rosterBuilds.length} builds)`;
  }
  if (!scenarioArchetypes) {
    scenarioArchetypes = specConfig.analysisArchetypes || {};
    source = "analysisArchetypes (fallback)";
  }

  // Count total work units
  let totalUnits = 0;
  for (const [scenario, builds] of Object.entries(scenarioArchetypes)) {
    if (typeof builds !== "object" || builds.heroTree !== undefined) continue;
    const durations = scenarios[scenario]?.durations || [120];
    totalUnits += Object.keys(builds).length * durations.length;
  }

  if (totalUnits === 0) {
    console.error(
      "No analysis builds available (empty roster and no analysisArchetypes).",
    );
    process.exit(1);
  }

  // Engine init — needed for sequential fallback path
  const { initEngine, reinitScoringForBuild } = await import(
    "../analysis/optimal-timeline.js"
  );
  const { simulateApl, initEngine: initInterpEngine } = await import(
    "../analysis/apl-interpreter.js"
  );
  const { computeDivergence, initEngine: initDivEngine } = await import(
    "../analysis/divergence.js"
  );

  console.log(
    `Pattern analysis: ${totalUnits} work units (source: ${source})\n`,
  );

  const patternsByBuild = {};
  const divergencesByBuild = {};
  const buildConfigs = {};

  // Collect all work units
  const workUnits = [];
  for (const [scenario, builds] of Object.entries(scenarioArchetypes)) {
    if (typeof builds !== "object" || builds.heroTree !== undefined) continue;
    const durations = scenarios[scenario]?.durations || [120];
    const buildNames = Object.keys(builds);

    console.log(
      `  [${scenario}] ${buildNames.length} builds × ${durations.join("/")}s`,
    );

    for (const buildName of buildNames) {
      const archetype = { ...builds[buildName], _name: buildName };
      for (const duration of durations) {
        const runKey =
          durations.length > 1 ? `${buildName}-${duration}s` : buildName;
        buildConfigs[runKey] = archetype;
        workUnits.push({ scenario, buildName, archetype, duration, runKey });
      }
    }
  }

  const aplPath = join(aplsDir(), `${spec}.simc`);

  // Try worker-based parallel processing (2+ work units, 2+ CPUs)
  const workerPath = new URL("../analysis/pattern-worker.js", import.meta.url)
    .pathname;
  const poolSize = Math.min(cpus().length - 1, 4, totalUnits);
  let parallelized = false;

  if (poolSize > 1 && workUnits.length > 1) {
    parallelized = await runPatternWorkers(
      workerPath,
      poolSize,
      workUnits,
      aplPath,
      patternsByBuild,
      divergencesByBuild,
    );
  }

  if (!parallelized) {
    // Sequential fallback — init engines in this thread
    await initEngine(spec);
    await initInterpEngine(spec);
    await initDivEngine(spec);

    if (workUnits.length > 1) {
      console.log("\nProcessing sequentially...");
    }

    for (const unit of workUnits) {
      reinitScoringForBuild(unit.archetype);

      const traceFile = resultsFile(`apl-trace-${unit.runKey}.json`);
      const divFile = resultsFile(`divergences-${unit.runKey}.json`);

      let aplTrace = null;
      let divergences = [];

      if (existsSync(traceFile)) {
        aplTrace = JSON.parse(readFileSync(traceFile, "utf-8"));
      }
      if (existsSync(divFile)) {
        const divData = JSON.parse(readFileSync(divFile, "utf-8"));
        divergences = divData.divergences || [];
      }

      if (!aplTrace) {
        if (!existsSync(aplPath)) {
          console.log(`    Skipping ${unit.runKey} — no APL file`);
          continue;
        }
        const aplText = readFileSync(aplPath, "utf-8");
        aplTrace = simulateApl(aplText, unit.archetype, unit.duration);
      }

      if (divergences.length === 0 && aplTrace) {
        divergences = computeDivergence(aplTrace, unit.archetype);
      }

      const patterns = analyzePatterns(aplTrace, divergences, specConfig);
      patternsByBuild[unit.runKey] = patterns;
      divergencesByBuild[unit.runKey] = divergences;

      console.log(
        `    ${unit.runKey}: ${patterns.resourceFlow?.gcds?.total || 0} GCDs, ${divergences.length} divergences`,
      );

      writeFileSync(
        resultsFile(`patterns-${unit.runKey}.json`),
        JSON.stringify(patterns, null, 2),
      );
    }
  }

  console.log("\nCross-archetype synthesis...");
  const synthesis = crossArchetypeSynthesize(
    patternsByBuild,
    divergencesByBuild,
    buildConfigs,
  );
  const synthesisFile = resultsFile("cross-archetype-synthesis.json");
  writeFileSync(synthesisFile, JSON.stringify(synthesis, null, 2));

  const universalCount = synthesis.patterns.filter(
    (p) => p.classification === "universal",
  ).length;
  const heroSpecificCount = synthesis.patterns.filter(
    (p) => p.classification === "hero_specific",
  ).length;
  console.log(
    `  ${synthesis.patterns.length} pattern groups: ${universalCount} universal, ${heroSpecificCount} hero-specific`,
  );

  console.log("\nGenerating theories...");
  const theories = generateTheories(synthesis, patternsByBuild);
  const candidates = formatTheoryCandidates(theories);
  const candidatesFile = resultsFile("theory-candidates.json");
  writeFileSync(candidatesFile, JSON.stringify(candidates, null, 2));

  const persisted = persistTheories(theories);
  const dbCount = persisted.filter((p) => !p.error).length;

  console.log(
    `  ${theories.length} theories generated (${theories.filter((t) => t.confidence >= 0.5).length} medium+ confidence)`,
  );
  console.log(`  ${dbCount} inserted to DB`);

  console.log("\n" + "=".repeat(70));
  console.log("Theory Candidates (top 10)");
  console.log("=".repeat(70));

  for (const theory of theories.slice(0, 10)) {
    const tag =
      theory.classification === "artifact"
        ? "[ARTIFACT]"
        : `[${theory.confidence.toFixed(2)}]`;
    console.log(`\n${tag} ${theory.title}`);
    console.log(`  ${theory.reasoning.slice(0, 120)}...`);
    console.log(`  Change: ${theory.proposed_change}`);
    console.log(`  Impact: ${theory.expected_impact}`);
  }

  console.log(`\nSaved: ${candidatesFile}`);
  console.log(`Synthesis: ${synthesisFile}`);
}

// --- Auto-Generate Candidate ---

async function cmdAutoGenerate() {
  const state = loadState();
  if (!state) {
    console.error("No iteration state. Run init first.");
    process.exit(1);
  }

  // Find pending hypotheses with mutations from DB
  const pendingAll = dbGetHypotheses({ status: "pending", limit: 200 });
  const withMutations = pendingAll.filter((h) => h.mutation);

  if (pendingAll.length === 0) {
    console.error(
      "No pending hypotheses in DB. Run `strategic` or `theorycraft` first.",
    );
    process.exit(1);
  }

  if (withMutations.length === 0) {
    console.error("No hypotheses with auto-mutation available.");
    console.log("Top pending hypotheses:");
    for (const h of pendingAll.slice(0, 3)) {
      console.log(`  - ${h.summary}`);
    }
    process.exit(1);
  }

  const aplText = readFileSync(CURRENT_APL, "utf-8");
  const ast = parse(aplText);

  // Try each hypothesis until one succeeds
  for (const hypothesis of withMutations) {
    const mutation = hypothesis.mutation;
    console.log(`\nTrying hypothesis:`);
    console.log(`  ${hypothesis.summary}`);
    console.log(`  Mutation: ${describeMutation(mutation)}`);

    try {
      // Validate mutation first
      const validation = validateMutation(ast, mutation);

      if (!validation.valid) {
        console.log(`  Skipping — validation failed: ${validation.errors[0]}`);
        dbUpdateHypothesis(hypothesis.id, {
          status: "rejected",
          reason: `validation: ${validation.errors[0]}`,
        });
        continue;
      }

      // Generate candidate
      const candidatePath = join(aplsDir(), "candidate.simc");
      const result = generateCandidate(CURRENT_APL, mutation, candidatePath);

      console.log(`\nGenerated: ${result.outputPath}`);
      console.log(`Description: ${result.description}`);
      console.log(
        `\nRun: node src/sim/iterate.js compare apls/candidate.simc --quick`,
      );

      return;
    } catch (e) {
      console.log(`  Skipping — generation failed: ${e.message}`);
      dbUpdateHypothesis(hypothesis.id, {
        status: "rejected",
        reason: `generation: ${e.message}`,
      });
      continue;
    }
  }

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

  // Map to DB shape and insert (dedup via insertHypothesesToDb)
  const dbReady = hypotheses.map((h) => ({
    description: h.hypothesis || h.observation,
    category: h.category,
    priority: h.priority || 5.0,
    aplMutation: h.aplMutation,
  }));
  const inserted = insertHypothesesToDb(dbReady, "strategic");

  console.log(`\n${inserted} new strategic hypotheses added to DB:\n`);

  for (const h of hypotheses.slice(0, 10)) {
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

  if (hypotheses.length > 10) {
    console.log(`...and ${hypotheses.length - 10} more\n`);
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
  const spellDataPath = dataFile("spells-summary.json");
  const spellData = existsSync(spellDataPath)
    ? JSON.parse(readFileSync(spellDataPath, "utf-8"))
    : [];

  // Run temporal analysis
  const resourceFlow = analyzeResourceFlow(spellData, aplText, workflowResults);
  const hypotheses = generateTemporalHypotheses(resourceFlow, aplText);

  const dbReady = hypotheses.map((h) => ({
    description: h.hypothesis,
    category: h.category,
    priority: h.priority || 5.0,
    aplMutation: h.aplMutation,
  }));
  const inserted = insertHypothesesToDb(dbReady, "theorycraft");

  console.log(`\n${inserted} new temporal hypotheses added to DB:\n`);

  for (const h of hypotheses.slice(0, 10)) {
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

  if (hypotheses.length > 10) {
    console.log(`...and ${hypotheses.length - 10} more\n`);
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
  let metricHypotheses = generateHypotheses(workflowResults);

  // Fallback: when all workflow scenarios have errors, generate static resource-flow hypotheses
  if (metricHypotheses.length === 0) {
    const aplPath2 = state.current.apl;
    const aplFallback = existsSync(join(ROOT, aplPath2))
      ? readFileSync(join(ROOT, aplPath2), "utf-8")
      : null;
    if (aplFallback) {
      const spellPath = dataFile("spells-summary.json");
      const spells = existsSync(spellPath)
        ? JSON.parse(readFileSync(spellPath, "utf-8"))
        : [];
      metricHypotheses = generateStaticResourceHypotheses(aplFallback, spells);
      if (metricHypotheses.length > 0) {
        console.log(
          `  Workflow sims unavailable — generated ${metricHypotheses.length} static resource hypotheses`,
        );
      }
    }
  }

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
    const spellDataPath = dataFile("spells-summary.json");
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

  // Persist each specialist's raw hypotheses before synthesis
  for (const [name, output] of Object.entries(outputs)) {
    if (!output?.hypotheses?.length) continue;
    const dbReady = output.hypotheses.map((h) => ({
      description: h.hypothesis || h.id || h.observation || h.summary,
      category: h.category || name,
      priority: h.priority || 5.0,
      aplMutation: h.aplMutation || h.proposedChanges?.[0]?.aplMutation || null,
    }));
    const specInserted = insertHypothesesToDb(dbReady, `specialist:${name}`);
    if (specInserted > 0) {
      console.log(`  ${name}: ${specInserted} hypotheses persisted`);
    }
  }

  const result = synthesizeHypotheses(outputs);

  // Insert synthesized hypotheses to DB (dedup via insertHypothesesToDb)
  const dbReady = result.hypotheses.map((h) => {
    const mutation =
      h.proposedChanges?.[0]?.aplMutation || h.aplMutation || null;
    return {
      description: h.systemicIssue || h.hypothesis || h.id || h.summary,
      category: h.category || "synthesized",
      priority: h.aggregatePriority || h.priority || 0,
      aplMutation: mutation,
    };
  });
  const inserted = insertHypothesesToDb(dbReady, "synthesized");

  console.log(
    `\n${inserted} new synthesized hypotheses added to DB (${result.metadata.totalRaw} raw, ${result.conflicts.length} conflicts resolved):`,
  );
  console.log(`  Specialists: ${result.metadata.specialists.join(", ")}`);

  for (const h of result.hypotheses.slice(0, 10)) {
    const desc =
      h.systemicIssue || h.hypothesis || h.id || h.summary || "unknown";
    const consensus =
      h.consensusCount > 1 ? ` [${h.consensusCount}x consensus]` : "";
    console.log(`\n${consensus} ${desc}`);
    console.log(`  Priority: ${(h.aggregatePriority || 0).toFixed(1)}`);
    if (h.specialists?.length > 1) {
      console.log(`  Sources: ${h.specialists.join(", ")}`);
    }
  }
}

// --- Unify Hypotheses ---

function cmdUnify() {
  const specName = getSpecName();

  // Read current APL for mutation inference
  let aplText = null;
  if (existsSync(CURRENT_APL)) {
    aplText = readFileSync(CURRENT_APL, "utf-8");
  } else {
    const specApl = join(aplsDir(), `${specName}.simc`);
    if (existsSync(specApl)) {
      aplText = readFileSync(specApl, "utf-8");
    }
  }

  console.log(`Unifying hypotheses for spec: ${specName}`);
  if (!aplText) {
    console.log("  (no APL available — mutation inference disabled)");
  }

  const unified = unifyHypotheses(aplText, specName);

  if (unified.length === 0) {
    console.log("No pending hypotheses to unify.");
    return;
  }

  const stats = summarizeUnified(unified);
  const persistResult = persistUnified(unified, specName);

  console.log(`\nUnification complete:`);
  console.log(`  Total hypotheses: ${stats.totalHypotheses}`);
  console.log(`  Unique groups: ${stats.uniqueGroups}`);
  console.log(`  With consensus (>1 source): ${stats.withConsensus}`);
  console.log(
    `  Mutation coverage: ${stats.mutationCoverage}% (${stats.withMutation}/${stats.uniqueGroups})`,
  );
  console.log(`  Mutations inferred: ${stats.inferredMutations}`);
  console.log(`  Inference fallthroughs: ${stats.inferenceFallthroughs}`);
  if (Object.keys(stats.fallthroughReasons).length > 0) {
    for (const [reason, count] of Object.entries(stats.fallthroughReasons)) {
      console.log(`    ${reason}: ${count}`);
    }
  }
  console.log(`  Rejection memory applied: ${stats.withRejectionMemory}`);
  console.log(
    `  DB updated: ${persistResult.updated}, mutations added: ${persistResult.mutationsAdded}`,
  );

  console.log(`\nTop 10 unified hypotheses:`);
  for (const h of unified.slice(0, 10)) {
    const consensus =
      h.consensusCount > 1
        ? ` [${h.consensusCount}× ${h.consensusSources.join("+")}]`
        : "";
    const mut = h.mutation ? " ✓mut" : " ✗mut";
    const rej = h.rejectionCount > 0 ? ` (${h.rejectionCount}× rejected)` : "";
    console.log(
      `  [${h.priority.toFixed(1)}]${consensus}${mut}${rej} ${(h.summary || "").slice(0, 100)}`,
    );
  }
}

// --- Checkpoint Management ---

const CHECKPOINT_PATH = resultsFile("checkpoint.md");

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
  lines.push(
    `- Pending hypotheses: ${dbGetHypotheses({ status: "pending", limit: 1000 }).length} (DB)`,
  );
  lines.push(
    `- Rejected hypotheses: ${dbGetHypotheses({ status: "rejected", limit: 1000 }).length} (DB)`,
  );
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

  // Top pending hypotheses (from DB)
  const topPending = dbGetHypotheses({ status: "pending", limit: 6 });
  if (topPending.length > 0) {
    lines.push("### Top Pending Hypotheses\n");
    for (const h of topPending.slice(0, 5)) {
      const desc = h.summary || "unknown";
      lines.push(
        `1. [${h.category || "unknown"}] ${desc.slice(0, 80)}${desc.length > 80 ? "…" : ""}`,
      );
      if (h.mutation) {
        lines.push(
          `   - Has auto-mutation: ${describeMutation(h.mutation).slice(0, 60)}`,
        );
      }
    }
    if (topPending.length > 5) {
      lines.push(`\n...and more in DB`);
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

  // Persist checkpoint to DB for compaction resilience
  setSessionState("checkpoint", state.checkpoint);

  console.log("Checkpoint saved to results/checkpoint.md");
  console.log(`\nSession summary:`);
  console.log(
    `  Iterations: ${iterCount} (${accepted} accepted, ${rejected} rejected)`,
  );
  console.log(
    `  Pending hypotheses: ${dbGetHypotheses({ status: "pending", limit: 1000 }).length} (DB)`,
  );
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
    const filepath = resultsFile(filename);
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
  const consecRej = state.consecutiveRejections || 0;
  const suggestions = [];

  if (consecRej >= 5) {
    suggestions.push(
      "Try compound mutations (combine 2-3 related changes)",
      "Try reversing a previous accepted change that may have downstream effects",
      "Focus on a different scenario (if ST is stuck, try optimizing AoE)",
      "Try radical reorder of action priority",
    );
  }

  if (consecRej >= 8) {
    suggestions.push(
      "Consider re-evaluating the archetype strategy",
      "Run full workflow analysis to find new angles",
    );
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
    const w = SCENARIO_WEIGHTS[scenario] || 0;
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
  lines.push(
    `| Hypotheses pending | ${dbGetHypotheses({ status: "pending", limit: 1000 }).length} |`,
  );
  lines.push(
    `| Hypotheses rejected | ${dbGetHypotheses({ status: "rejected", limit: 1000 }).length} |`,
  );

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

  const dashPath = resultsFile("dashboard.md");
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

  writeFileSync(resultsFile("findings.md"), lines.join("\n") + "\n");
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
        const treeAvgs = a.treeAvgs || {};
        const treeStr = Object.entries(treeAvgs)
          .map(([k, v]) => `${k}: ${signedPct(v ?? 0)}`)
          .join(" | ");
        lines.push(
          `${treeStr} | Worst: ${(a.worstWeighted ?? 0).toFixed(3)}%\n`,
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

  writeFileSync(resultsFile("changelog.md"), lines.join("\n") + "\n");
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

// Parse --batch-size N (global flag, applies to init and compare)
const bsIdx = rawArgs.indexOf("--batch-size");
if (bsIdx !== -1 && rawArgs[bsIdx + 1]) {
  batchSizeOverride = parseInt(rawArgs[bsIdx + 1], 10);
  rawArgs.splice(bsIdx, 2);
  if (!batchSizeOverride || batchSizeOverride < 1) {
    console.error("--batch-size must be a positive integer");
    process.exit(1);
  }
}

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
        "Usage: node src/sim/iterate.js compare <candidate.simc> [--quick|--confirm] [--batch-size N]",
      );
      process.exit(1);
    }
    const hasExplicitTier =
      rawArgs.includes("--quick") || rawArgs.includes("--confirm");
    let tier = "standard";
    if (rawArgs.includes("--quick")) tier = "quick";
    else if (rawArgs.includes("--confirm")) tier = "confirm";
    // Default (no flag): staged screening — quick first, then standard if promising
    await cmdCompare(rawArgs[0], tier, { staged: !hasExplicitTier });
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

  case "divergence-hypotheses":
    await cmdDivergenceHypotheses();
    break;

  case "pattern-analyze":
    await cmdPatternAnalyze();
    break;

  case "unify":
    cmdUnify();
    break;

  case "group-independent": {
    const state = loadState();
    if (!state) {
      console.error(
        "No iteration state found. Run: node src/sim/iterate.js init <apl.simc>",
      );
      process.exit(1);
    }
    const aplText = readFileSync(CURRENT_APL, "utf-8");
    const pending = dbGetHypotheses({ status: "pending", limit: 500 });
    if (pending.length === 0) {
      console.log("No pending hypotheses to group.");
      break;
    }
    const groups = groupIndependent(pending, aplText);
    console.log(
      `\nGrouped ${pending.length} pending hypotheses into ${groups.length} independent set(s):\n`,
    );
    for (let g = 0; g < groups.length; g++) {
      console.log(`  Group ${g + 1} (${groups[g].length} hypotheses):`);
      for (const h of groups[g]) {
        const summary = (h.summary || "").slice(0, 80);
        const src = h.source ? ` [${h.source}]` : "";
        console.log(`    - ${summary}${src}`);
      }
      console.log();
    }
    break;
  }

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
  node src/sim/iterate.js compare <candidate.simc>   Screen→standard staged comparison [--quick|--confirm]
  node src/sim/iterate.js accept "reason"            Accept candidate [--hypothesis "fragment"]
  node src/sim/iterate.js reject "reason"            Reject candidate [--hypothesis "fragment"]
  node src/sim/iterate.js hypotheses                 List improvement hypotheses
  node src/sim/iterate.js strategic                  Generate strategic hypotheses with auto-mutations
  node src/sim/iterate.js theorycraft                Generate temporal resource flow hypotheses
  node src/sim/iterate.js synthesize                 Synthesize hypotheses from all specialist sources
  node src/sim/iterate.js divergence-hypotheses      Import divergence JSONs as DB hypotheses
  node src/sim/iterate.js pattern-analyze            Pattern analysis + theory generation
  node src/sim/iterate.js unify                      Unify hypotheses: consensus, fingerprinting, mutation inference
  node src/sim/iterate.js generate                   Auto-generate candidate from top hypothesis
  node src/sim/iterate.js rollback <iteration-id>    Rollback an accepted iteration
  node src/sim/iterate.js summary                    Generate iteration report
  node src/sim/iterate.js group-independent           Group hypotheses into independent sets
  node src/sim/iterate.js checkpoint                 Save checkpoint for session resume`);
    break;
}
