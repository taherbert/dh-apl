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

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { runWorkflow } from "./workflow.js";
import { SCENARIOS, SIM_DEFAULTS } from "./runner.js";
import {
  generateProfileset,
  runProfileset,
  runProfilesetAsync,
} from "./profilesets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(ROOT, "results");
const STATE_PATH = join(RESULTS_DIR, "iteration-state.json");
const CURRENT_APL = join(ROOT, "apls", "current.simc");

const SCENARIO_KEYS = ["st", "small_aoe", "big_aoe"];
const SCENARIO_LABELS = { st: "1T", small_aoe: "5T", big_aoe: "10T" };
const SCENARIO_WEIGHTS = { st: 0.5, small_aoe: 0.3, big_aoe: 0.2 };

const FIDELITY_TIERS = {
  quick: { target_error: 1.0 },
  standard: { target_error: 0.3 },
  confirm: { target_error: 0.1 },
};

const STATE_VERSION = 2;

// --- State Management ---

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  const state = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  return migrateState(state);
}

function migrateState(state) {
  if (state.version >= STATE_VERSION) return state;

  // v1 → v2: DPS keys changed from labels ("1T") to scenario keys ("st")
  if (state.version === 1 || !state.version) {
    const labelToKey = { "1T": "st", "5T": "small_aoe", "10T": "big_aoe" };
    const migrateDps = (dps) => {
      const migrated = {};
      for (const [k, v] of Object.entries(dps)) {
        migrated[labelToKey[k] || k] = v;
      }
      return migrated;
    };
    if (state.originalBaseline?.dps) {
      state.originalBaseline.dps = migrateDps(state.originalBaseline.dps);
    }
    if (state.current?.dps) {
      state.current.dps = migrateDps(state.current.dps);
    }
    state.version = STATE_VERSION;
  }

  return state;
}

function saveState(state) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  state.version = STATE_VERSION;
  state.lastUpdated = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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
      if (uptime < 40 && name !== "metamorphosis" && name !== "fiery_brand") {
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
    if (s.gcdEfficiency < 85) {
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
    const cooldownBuffs = ["fiery_brand", "metamorphosis", "fel_devastation"];
    for (const name of cooldownBuffs) {
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
      h.description.toLowerCase().includes(frag),
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
  const iterResults = {};
  for (const [scenario, r] of Object.entries(comparison.results)) {
    iterResults[scenario] = {
      current: r.current,
      candidate: r.candidate,
      delta_pct: r.deltaPct,
    };
  }

  const hypothesis = popHypothesis(state, hypothesisHint);

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

  return { iterNum, hypothesis };
}

// --- Comparison ---

function buildProfilesetContent(candidatePath) {
  const baseContent = readFileSync(CURRENT_APL, "utf-8");
  const candidateContent = readFileSync(candidatePath, "utf-8");

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
    const sigLabel = r.significant
      ? r.deltaPct > 0
        ? "YES"
        : "YES (WORSE)"
      : "NO (noise)";

    console.log(
      `${label.padEnd(12)} ${r.current.toLocaleString().padStart(12)} ${r.candidate.toLocaleString().padStart(12)} ${(sign + r.delta.toLocaleString()).padStart(10)} ${(sign + r.deltaPct.toFixed(2) + "%").padStart(10)} ${("±" + r.stderrPct.toFixed(2) + "%").padStart(10)} ${sigLabel.padStart(14)}`,
    );
  }

  // Weighted total
  let weightedDelta = 0;
  let weightedStderr = 0;
  for (const scenario of SCENARIO_KEYS) {
    const r = results[scenario];
    if (!r) continue;
    const w = SCENARIO_WEIGHTS[scenario];
    weightedDelta += r.deltaPct * w;
    weightedStderr += (r.stderrPct * w) ** 2;
  }
  weightedStderr = Math.sqrt(weightedStderr);
  const weightedSig = Math.abs(weightedDelta) > 2 * weightedStderr;
  const ws = weightedDelta >= 0 ? "+" : "";

  console.log("-".repeat(82));
  console.log(
    `${"Weighted".padEnd(12)} ${"".padStart(12)} ${"".padStart(12)} ${"".padStart(10)} ${(ws + weightedDelta.toFixed(3) + "%").padStart(10)} ${("±" + weightedStderr.toFixed(3) + "%").padStart(10)} ${(weightedSig ? "YES" : "NO").padStart(14)}`,
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
  };

  saveState(state);

  console.log("\nBaseline DPS:");
  for (const [key, value] of Object.entries(dps)) {
    console.log(`  ${SCENARIO_LABELS[key] || key}: ${value.toLocaleString()}`);
  }

  console.log(`\nGenerated ${hypotheses.length} hypotheses.`);
  printHypotheses(hypotheses.slice(0, 5));
  console.log("\nIteration state initialized. Ready for /iterate-apl.");
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

  console.log("=== APL Iteration Progress ===");
  console.log(
    `Started: ${formatElapsed(state.startedAt)} | Iterations: ${iterCount} (${accepted} accepted, ${rejected} rejected)`,
  );

  // DPS progress with bars
  console.log("\nDPS Progress:");
  for (const key of SCENARIO_KEYS) {
    const label = SCENARIO_LABELS[key];
    const orig = state.originalBaseline.dps[key];
    const curr = state.current.dps[key];
    if (orig === undefined || curr === undefined) continue;

    const delta = ((curr - orig) / orig) * 100;
    const sign = delta >= 0 ? "+" : "";
    // Bar: fraction of a 5% improvement target
    const fraction = Math.min(1, Math.max(0, delta / 5));
    const bar = progressBar(fraction);
    console.log(
      `  ${label.padEnd(4)} ${orig.toLocaleString().padStart(12)} → ${curr.toLocaleString().padStart(12)}  ${bar}  ${sign}${delta.toFixed(2)}%`,
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
      const summary = Object.entries(iter.results || {})
        .map(([k, v]) => {
          const label = SCENARIO_LABELS[k] || k;
          return `${label}:${v.delta_pct > 0 ? "+" : ""}${v.delta_pct?.toFixed(1) || "?"}%`;
        })
        .join("  ");
      const desc =
        iter.hypothesis.length > 40
          ? iter.hypothesis.slice(0, 40) + "…"
          : iter.hypothesis;
      console.log(
        `  #${String(iter.id).padStart(2)} ${emoji} ${desc}  ${summary}`,
      );
    }
  }
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

  console.log(
    `Comparing candidate against current baseline (${tier} fidelity)...`,
  );
  const results = await runComparison(resolvedPath, tier);
  printComparison(results, tier);
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

  const { iterNum } = recordIteration(
    state,
    comparison,
    reason,
    hypothesisHint,
    "accepted",
  );

  for (const [scenario, r] of Object.entries(comparison.results)) {
    state.current.dps[scenario] = r.candidate;
  }

  console.log("Running workflow on new baseline...");
  const workflowResults = await runWorkflow(CURRENT_APL);
  const workflowPath = join(RESULTS_DIR, "workflow_current.json");
  writeFileSync(workflowPath, JSON.stringify(workflowResults, null, 2));
  state.current.workflowResults = "results/workflow_current.json";

  state.pendingHypotheses = generateHypotheses(workflowResults);

  saveState(state);
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
  saveState(state);

  console.log(`Iteration #${iterNum} rejected: ${reason}`);
  console.log(`${state.pendingHypotheses.length} hypotheses remaining.`);
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

  // Filter out exhausted ones
  const exhaustedDescs = new Set(
    state.exhaustedHypotheses.map((h) => h.description),
  );
  const fresh = hypotheses.filter((h) => !exhaustedDescs.has(h.description));

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
  lines.push("## DPS Progression\n");
  lines.push("| Scenario | Baseline | Current | Delta |");
  lines.push("|----------|----------|---------|-------|");
  for (const key of SCENARIO_KEYS) {
    const label = SCENARIO_LABELS[key];
    const orig = state.originalBaseline.dps[key];
    const curr = state.current.dps[key];
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
  lines.push("| # | Decision | Hypothesis | Mutation | 1T | 5T | 10T |");
  lines.push("|---|----------|------------|----------|----|----|-----|");
  for (const iter of state.iterations) {
    const r = iter.results || {};
    const cols = SCENARIO_KEYS.map((k) => {
      const v = r[k];
      if (!v) return "—";
      const sign = v.delta_pct >= 0 ? "+" : "";
      return `${sign}${v.delta_pct?.toFixed(2) || "?"}%`;
    });
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
    const scored = accepted.map((iter) => {
      let weighted = 0;
      for (const key of SCENARIO_KEYS) {
        const v = iter.results?.[key];
        if (v) weighted += (v.delta_pct || 0) * SCENARIO_WEIGHTS[key];
      }
      return { ...iter, weightedDelta: weighted };
    });
    scored.sort((a, b) => b.weightedDelta - a.weightedDelta);
    for (const s of scored.slice(0, 10)) {
      lines.push(
        `- **#${s.id}** (${s.weightedDelta >= 0 ? "+" : ""}${s.weightedDelta.toFixed(3)}% weighted): ${s.hypothesis}`,
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

  default:
    console.log(`APL Iteration Manager

Usage:
  node src/sim/iterate.js init <apl.simc>           Initialize with baseline
  node src/sim/iterate.js status                     Show current state
  node src/sim/iterate.js compare <candidate.simc>   Compare candidate [--quick|--confirm]
  node src/sim/iterate.js accept "reason"            Accept candidate [--hypothesis "fragment"]
  node src/sim/iterate.js reject "reason"            Reject candidate [--hypothesis "fragment"]
  node src/sim/iterate.js hypotheses                 List improvement hypotheses
  node src/sim/iterate.js summary                    Generate iteration report`);
    break;
}
