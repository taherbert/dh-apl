// Gap reporter — diffs optimal-timeline.json against apl-trace.json.
//
// Produces divergence-report.md: ranked list of GCDs where the APL chose
// differently from the theoretically optimal sequence, with estimated DPS
// impact and fix hints.
//
// Usage:
//   node src/analysis/divergence.js --spec vengeance --build anni-apex3-dgb
//   npm run divergence -- --build anni-apex3-dgb

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { initSpec, getSpecAdapter } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import {
  getBestAbility,
  getAbilityRolloutScore,
  initEngine as initTimelineEngine,
} from "./optimal-timeline.js";
import {
  simulateApl,
  initEngine as initInterpreterEngine,
} from "./apl-interpreter.js";
import { ROOT } from "../engine/paths.js";

// State engine and spec hint module — loaded dynamically based on --spec
let engine;
let hintMod;
let _fillers;

export async function initEngine(specName) {
  if (engine) return engine;
  engine = await import(`./${specName}/state-sim.js`);
  _fillers = null; // reset so isFillerAbility re-reads from the new spec
  try {
    hintMod = await import(`./${specName}/divergence-hints.js`);
  } catch {
    hintMod = {
      estimateFrequency: () => "intermittent",
      generateFixHint: (...args) => args[4],
    };
  }
  await initTimelineEngine(specName);
  await initInterpreterEngine(specName);
  return engine;
}

// ---------------------------------------------------------------------------
// Config hash — deterministic hash of archetype config for cache invalidation
// ---------------------------------------------------------------------------

function hashConfig(archetype) {
  // Exclude _name (set dynamically by CLI, not part of the config)
  const { _name, ...configData } = archetype;
  const str = JSON.stringify(configData, (_, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  });
  return createHash("md5").update(str).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// State reconstruction helper
// Converts a snapshot from the trace back into a live state for scoring
// ---------------------------------------------------------------------------

function snapshotToState(snap, buildConfig, fightDuration) {
  const state = engine.createInitialState(buildConfig);
  const specConfig = getSpecAdapter().getSpecConfig();

  // Restore resources by name
  state[specConfig.resources.primary.name] =
    snap[specConfig.resources.primary.name];
  if (specConfig.resources.secondary) {
    state[specConfig.resources.secondary.name] =
      snap[specConfig.resources.secondary.name];
  }

  // Restore buff durations, dots, and cooldowns from snapshot
  for (const [dict, snapDict] of [
    [state.buffs, snap.buffs],
    [state.dots, snap.dots],
    [state.debuffs, snap.debuffs],
    [state.cooldowns, snap.cooldowns],
  ]) {
    if (snapDict) {
      for (const [key, val] of Object.entries(snapDict)) {
        if (key in dict) dict[key] = val;
      }
    }
  }

  // Restore charges generically
  if (snap.charges) {
    for (const [ability, count] of Object.entries(snap.charges)) {
      if (ability in state.charges) state.charges[ability] = count;
    }
  }
  if (snap.recharge) {
    for (const [ability, remaining] of Object.entries(snap.recharge)) {
      if (ability in state.recharge) state.recharge[ability] = remaining;
    }
  }

  // Sync fury_cap from Meta
  if (state.buffs.metamorphosis > 0 && state.fury_cap !== undefined)
    state.fury_cap = specConfig.resources.primary.cap + 20;

  // Spec-specific extra state (voidfall stacks, etc.)
  if (engine.restoreExtra) engine.restoreExtra(state, snap);

  state.fight_end = fightDuration ?? Infinity;
  return state;
}

// ---------------------------------------------------------------------------
// Divergence detection
// ---------------------------------------------------------------------------

// State-held comparison: for each APL decision, reconstruct the exact APL state
// and ask what the optimal rollout would choose at that state. Eliminates the
// state-drift problem of index-based comparison (where diverging decisions cause
// all subsequent GCDs to compare different game states).
export function computeDivergence(aplTrace, buildConfig) {
  const divergences = [];
  const specConfig = getSpecAdapter().getSpecConfig();

  // Single pass: accumulate total fight score AND detect divergences.
  // totalFightScore = sum of immediate scoreDpgcd for all on-GCD APL choices,
  // used as the denominator for DPS% impact estimates.
  let totalFightScore = 0;

  for (const event of aplTrace.events.filter((e) => !e.off_gcd)) {
    const state = snapshotToState(
      event.pre,
      buildConfig,
      aplTrace.metadata?.duration,
    );
    totalFightScore += engine.scoreDpgcd(state, event.ability);

    const optAbility = getBestAbility(state);

    if (!optAbility || optAbility === event.ability) continue;
    // Skip when rollout chose a filler — indicates a scoring artifact not a real APL gap
    if (isFillerAbility(optAbility)) continue;
    if (isFillerAbility(event.ability) && isFillerAbility(optAbility)) continue;

    // Rollout-based delta: always >= 0 since pickOptimal chose optAbility as highest.
    // Immediate-score delta alone misleads for strategic setups (e.g. FB before VF dump).
    const optScore = getAbilityRolloutScore(state, optAbility);
    const aplScore = getAbilityRolloutScore(state, event.ability);
    const dpgcdDelta = optScore - aplScore;

    if (dpgcdDelta < 10) continue; // rollout delta is always >= 0; only skip near-ties

    const opt = { ability: optAbility };
    const apl = { ability: event.ability };

    // 3-GCD branch comparison: short-horizon score that isn't subject to
    // resource-hoarding bias. When its direction disagrees with the rollout
    // (i.e. 3-GCD favors the APL choice or is within noise), the divergence
    // is likely a rollout artifact rather than a real APL gap.
    const branch = compareRolloutBranches(state, optAbility, event.ability);
    const threeGcdDelta = branch.delta;
    // Rollout says optimal > APL (dpgcdDelta > 0). If 3-GCD agrees (delta > 0
    // and meaningfully so), confidence is high. Otherwise low.
    const threeGcdAgreesWithRollout = threeGcdDelta > 10;

    const { primary, secondary } = specConfig.resources;
    const divState = {
      [primary.name]: event.pre[primary.name],
      buffs: event.pre.buffs,
      dots: event.pre.dots,
    };
    if (secondary) divState[secondary.name] = event.pre[secondary.name];

    divergences.push({
      gcd: event.gcd,
      t: event.t,
      state: divState,
      optimal: { ability: optAbility, score: optScore },
      actual: {
        ability: event.ability,
        apl_reason: event.apl_reason,
        score: aplScore,
      },
      dpgcd_delta: Math.round(dpgcdDelta),
      confidence: threeGcdAgreesWithRollout ? "high" : "low",
      three_gcd_delta: Math.round(threeGcdDelta),
      // actual_occurrences and estimated_dps_impact filled in post-loop
      fix_hint: hintMod.generateFixHint(
        opt,
        apl,
        state,
        buildConfig,
        branch.description,
      ),
    });
  }

  // Count actual occurrences per (optimal, actual) ability pair
  const pairCounts = new Map();
  for (const d of divergences) {
    const key = `${d.optimal.ability}|${d.actual.ability}`;
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  // Annotate each divergence with occurrence count and DPS impact
  for (const d of divergences) {
    const key = `${d.optimal.ability}|${d.actual.ability}`;
    d.actual_occurrences = pairCounts.get(key) || 1;
    const impact = computeImpact(
      d.dpgcd_delta,
      d.actual_occurrences,
      totalFightScore,
    );
    d.estimated_dps_impact = impact.display;
    d.estimated_dps_impact_pct = impact.pct;
  }

  divergences.sort((a, b) => Math.abs(b.dpgcd_delta) - Math.abs(a.dpgcd_delta));
  return divergences;
}

function isFillerAbility(ability) {
  if (!_fillers)
    _fillers = new Set(getSpecAdapter().getSpecConfig().fillerAbilities || []);
  return _fillers.has(ability);
}

// Count-based DPS impact estimate
// Returns { display: string, pct: number|null }
function computeImpact(dpgcdDelta, occurrences, totalFightScore) {
  if (occurrences < 2 || totalFightScore <= 0) {
    return { display: `n/a (1×)`, pct: null };
  }
  const pct = ((dpgcdDelta * occurrences) / totalFightScore) * 100;
  return {
    display: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% (${occurrences}×)`,
    pct,
  };
}

function estimateFrequency(opt, apl) {
  return hintMod.estimateFrequency(opt, apl);
}

// ---------------------------------------------------------------------------
// Rollout branch comparison — simulates 3 GCDs from each branch and reports
// the key state differences. Used by generateFixHint for actionable context.
// ---------------------------------------------------------------------------

function compareRolloutBranches(state, optAbility, aplAbility, steps = 3) {
  const {
    applyAbility,
    advanceTime,
    getAvailable,
    scoreDpgcd,
    getAbilityGcd,
    OFF_GCD_ABILITIES,
  } = engine;

  function simulateBranch(firstAbility) {
    let s = applyAbility(state, firstAbility);
    const dt0 = getAbilityGcd(state, firstAbility) || state.gcd;
    s = advanceTime(s, dt0);
    let score = scoreDpgcd(state, firstAbility);

    for (let i = 1; i < steps; i++) {
      const available = getAvailable(s).filter(
        (id) => !OFF_GCD_ABILITIES.has(id),
      );
      if (!available.length) break;

      let bestId = null;
      let bestSc = -Infinity;
      for (const id of available) {
        const sc = scoreDpgcd(s, id);
        if (sc > bestSc) {
          bestSc = sc;
          bestId = id;
        }
      }
      if (!bestId) break;

      score += bestSc;
      const next = applyAbility(s, bestId);
      const dt = getAbilityGcd(s, bestId) || s.gcd;
      s = advanceTime(next, dt);
    }
    return { score, endState: s };
  }

  const optBranch = simulateBranch(optAbility);
  const aplBranch = simulateBranch(aplAbility);
  const diff = optBranch.score - aplBranch.score;
  const o = optBranch.endState;
  const a = aplBranch.endState;

  const details = [
    `${steps}-GCD score: ${optAbility}=${optBranch.score.toFixed(0)} vs ${aplAbility}=${aplBranch.score.toFixed(0)} (Δ${diff >= 0 ? "+" : ""}${diff.toFixed(0)})`,
  ];

  // Resource comparison — generic from spec config
  const specConfig = getSpecAdapter().getSpecConfig();
  const pri = specConfig.resources.primary.name;
  if (Math.abs((o[pri] ?? 0) - (a[pri] ?? 0)) >= 20)
    details.push(`${pri}: opt_path=${o[pri]} APL_path=${a[pri]}`);
  if (specConfig.resources.secondary) {
    const sec = specConfig.resources.secondary.name;
    if (Math.abs((o[sec] ?? 0) - (a[sec] ?? 0)) >= 2)
      details.push(`${sec}: opt_path=${o[sec]} APL_path=${a[sec]}`);
  }

  return { description: details.join("; "), delta: diff };
}

// ---------------------------------------------------------------------------
// Markdown report generator
// ---------------------------------------------------------------------------

export function generateReport(divergences, buildName, metadata) {
  const lines = [];

  lines.push(`# APL Gap Analysis — ${buildName}`);
  lines.push("");
  lines.push(
    `Build: ${metadata.heroTree} / Apex ${metadata.apexRank} / Duration: ${metadata.duration}s`,
  );
  lines.push(`Analysis timestamp: ${new Date().toISOString()}`);
  lines.push("");

  if (divergences.length === 0) {
    lines.push(
      "**No significant divergences found.** APL matches optimal sequence.",
    );
    return lines.join("\n");
  }

  lines.push(`## Summary`);
  lines.push("");
  lines.push(
    `Found **${divergences.length} divergences** above noise threshold.`,
  );
  lines.push("");

  // Impact table
  lines.push(
    "| # | GCD | t | Optimal | APL Chose | Rollout Δ | 3-GCD Δ | Conf | Δ Score | Count | Context |",
  );
  lines.push(
    "|---|-----|---|---------|-----------|-----------|---------|------|---------|-------|---------|",
  );
  for (let i = 0; i < Math.min(divergences.length, 20); i++) {
    const d = divergences[i];
    const freq = estimateFrequency(d.optimal, d.actual);
    const conf = d.confidence === "high" ? "H" : "L";
    const threeGcd =
      d.three_gcd_delta != null
        ? `${d.three_gcd_delta >= 0 ? "+" : ""}${d.three_gcd_delta}`
        : "—";
    lines.push(
      `| ${i + 1} | ${d.gcd} | ${d.t}s | \`${d.optimal.ability}\` | \`${d.actual.ability}\` | ${d.dpgcd_delta > 0 ? "+" : ""}${d.dpgcd_delta} | ${threeGcd} | ${conf} | ${d.estimated_dps_impact} | ${d.actual_occurrences}× | ${freq} |`,
    );
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Divergence Details");
  lines.push("");

  for (let i = 0; i < divergences.length; i++) {
    const d = divergences[i];
    lines.push(
      `### ${i + 1}. GCD ${d.gcd} at t=${d.t}s — \`${d.optimal.ability}\` vs. \`${d.actual.ability}\``,
    );
    lines.push("");

    // State context
    const buffsStr = Object.entries(d.state.buffs || {})
      .map(([k, v]) => `${k}:${v}s`)
      .join(", ");
    const dotsStr = Object.entries(d.state.dots || {})
      .map(([k, v]) => `${k}:${v}s`)
      .join(", ");

    const stateFields = Object.entries(d.state)
      .filter(([k, v]) => typeof v === "number")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`**State:** ${stateFields}`);
    if (buffsStr) lines.push(`**Buffs:** ${buffsStr}`);
    if (dotsStr) lines.push(`**DoTs:** ${dotsStr}`);
    lines.push("");
    lines.push(`**Optimal choice:** \`${d.optimal.ability}\``);
    lines.push(`> DPGCD score: ${d.optimal.score?.toFixed(0) ?? "?"}`);
    lines.push("");
    lines.push(`**APL chose:** \`${d.actual.ability}\``);
    lines.push(`> Condition: \`${d.actual.apl_reason || "unconditional"}\``);
    lines.push("");
    const impactStr =
      d.actual_occurrences >= 2
        ? `Δ Score: ${d.estimated_dps_impact}`
        : "single occurrence — no % estimate";
    lines.push(`**Rollout delta:** +${d.dpgcd_delta} | ${impactStr}`);
    if (d.three_gcd_delta != null) {
      lines.push(
        `**3-GCD delta:** ${d.three_gcd_delta >= 0 ? "+" : ""}${d.three_gcd_delta}`,
      );
    }
    lines.push(
      `**Occurrences:** ${d.actual_occurrences}× in ${metadata.duration}s`,
    );
    if (d.confidence === "low") {
      lines.push("");
      lines.push(
        `**Confidence:** Low — 3-GCD score disagrees with rollout (likely resource-hoarding bias artifact)`,
      );
    }
    lines.push("");
    lines.push(`**Fix hint:** ${d.fix_hint}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Iteration candidates
  lines.push("## Top Iteration Candidates");
  lines.push("");
  lines.push(
    "The following divergences are above the ~0.1% DPS threshold and should be tested as `iterate.js` candidates:",
  );
  lines.push("");

  const highConf = divergences.filter(
    (d) =>
      d.estimated_dps_impact_pct !== null &&
      Math.abs(d.estimated_dps_impact_pct) >= 0.05 &&
      d.confidence === "high",
  );
  const lowConf = divergences.filter(
    (d) =>
      d.estimated_dps_impact_pct !== null &&
      Math.abs(d.estimated_dps_impact_pct) >= 0.05 &&
      d.confidence !== "high",
  );

  if (highConf.length === 0 && lowConf.length === 0) {
    lines.push("No divergences above 0.05% threshold. APL is near optimal.");
  } else {
    for (const c of highConf) {
      lines.push(
        `- **${c.optimal.ability} at GCD ${c.gcd}**: ${c.estimated_dps_impact} — ${c.fix_hint}`,
      );
    }
    if (lowConf.length > 0) {
      lines.push("");
      lines.push(
        `*${lowConf.length} additional divergence(s) demoted (low confidence — likely resource-hoarding bias):*`,
      );
      for (const c of lowConf) {
        lines.push(
          `- ~${c.optimal.ability} at GCD ${c.gcd}~: ${c.estimated_dps_impact} (3-GCD Δ${c.three_gcd_delta >= 0 ? "+" : ""}${c.three_gcd_delta})`,
        );
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "> Generated by `npm run divergence`. Delta = 20s rollout(optimal) - rollout(APL choice); always ≥ 0. Conf=L when 3-GCD score disagrees.",
  );
  lines.push(
    "> All candidates must be validated with `iterate.js compare` before accepting.",
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      build: { type: "string", default: "anni-apex3-dgb" },
      duration: { type: "string", default: "120" },
      trace: { type: "string" },
      apl: { type: "string" },
      output: { type: "string" },
      "force-retrace": { type: "boolean", default: false },
    },
    strict: false,
  });

  const spec = values.spec || parseSpecArg();
  await initSpec(spec);
  await initEngine(spec);

  const specMod = await import(`../spec/${spec}.js`);
  const ARCHETYPES = specMod.flattenArchetypes();
  const buildName = values.build;
  const duration = parseInt(values.duration, 10);

  const archetype = ARCHETYPES[buildName];
  if (!archetype) {
    console.error(`Unknown build: ${buildName}`);
    console.error(`Available builds: ${Object.keys(ARCHETYPES).join(", ")}`);
    process.exit(1);
  }
  archetype._name = buildName;

  const resultsDir = join(ROOT, "results", spec);
  mkdirSync(resultsDir, { recursive: true });

  // Load or generate the APL trace — with config-hash cache invalidation
  const traceFile =
    values.trace || join(resultsDir, `apl-trace-${buildName}.json`);
  let aplTrace = null;

  if (existsSync(traceFile) && !values["force-retrace"]) {
    const cached = JSON.parse(readFileSync(traceFile, "utf-8"));
    const currentHash = hashConfig(archetype);
    const TRACE_FORMAT = 2; // bumped when snapshot schema changes (e.g. generic charges)
    if (
      cached.metadata?.config_hash === currentHash &&
      (cached.metadata?.trace_format ?? 1) >= TRACE_FORMAT
    ) {
      console.log(`Loading APL trace from cache: ${traceFile}`);
      aplTrace = cached;
    } else {
      console.log(
        `Cache invalidated (config changed, hash ${cached.metadata?.config_hash?.slice(0, 8) ?? "none"} → ${currentHash.slice(0, 8)}) — regenerating`,
      );
    }
  }

  if (!aplTrace) {
    const aplPath = values.apl || join(ROOT, "apls", spec, `${spec}.simc`);
    console.log(`Running APL trace from: ${aplPath}`);
    let aplText;
    try {
      aplText = readFileSync(aplPath, "utf-8");
    } catch {
      console.error(`Cannot read APL: ${aplPath}`);
      process.exit(1);
    }
    aplTrace = simulateApl(aplText, archetype, duration);
    aplTrace.metadata = aplTrace.metadata || {};
    aplTrace.metadata.config_hash = hashConfig(archetype);
    aplTrace.metadata.trace_format = 2;
    writeFileSync(traceFile, JSON.stringify(aplTrace));
    console.log(`  Saved to ${traceFile}`);
  }

  console.log(
    `\nRunning state-held comparison on ${aplTrace.events.filter((e) => !e.off_gcd).length} APL decisions...`,
  );
  const divergences = computeDivergence(aplTrace, archetype);

  console.log(`Found ${divergences.length} divergences above noise threshold.`);
  console.log("");

  if (divergences.length > 0) {
    console.log("Top 10 divergences:");
    console.log("─".repeat(100));
    const header = [
      "#".padEnd(3),
      "GCD".padEnd(5),
      "t".padEnd(7),
      "Optimal".padEnd(20),
      "APL".padEnd(20),
      "Δ Rollout".padEnd(10),
      "3-GCD".padEnd(7),
      "Conf".padEnd(5),
      "Δ Score".padEnd(16),
      "Count",
    ].join(" ");
    console.log(header);
    console.log("─".repeat(100));

    for (let i = 0; i < Math.min(10, divergences.length); i++) {
      const d = divergences[i];
      const threeGcdStr =
        d.three_gcd_delta != null
          ? `${d.three_gcd_delta >= 0 ? "+" : ""}${d.three_gcd_delta}`
          : "—";
      const row = [
        String(i + 1).padEnd(3),
        String(d.gcd).padEnd(5),
        `${d.t}s`.padEnd(7),
        d.optimal.ability.padEnd(20),
        d.actual.ability.padEnd(20),
        ((d.dpgcd_delta >= 0 ? "+" : "") + d.dpgcd_delta).padEnd(10),
        threeGcdStr.padEnd(7),
        (d.confidence === "high" ? "H" : "L").padEnd(5),
        d.estimated_dps_impact.padEnd(16),
        `${d.actual_occurrences}×`,
      ].join(" ");
      console.log(row);
    }
  }

  // Generate and save markdown report
  const report = generateReport(divergences, buildName, {
    ...aplTrace.metadata,
    duration,
  });

  const outputFile =
    values.output || join(resultsDir, `divergence-report-${buildName}.md`);
  writeFileSync(outputFile, report);
  console.log(`\nDivergence report saved to: ${outputFile}`);

  // Save raw divergences as JSON too
  const jsonFile = join(resultsDir, `divergences-${buildName}.json`);
  writeFileSync(
    jsonFile,
    JSON.stringify({ divergences, metadata: aplTrace.metadata }, null, 2),
  );
  console.log(`Raw divergences saved to: ${jsonFile}`);
}
