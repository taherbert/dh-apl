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
import { initSpec, getSpecAdapter } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import {
  getBestAbility,
  initEngine as initTimelineEngine,
} from "./optimal-timeline.js";
import {
  simulateApl,
  initEngine as initInterpreterEngine,
} from "./apl-interpreter.js";
import { ROOT } from "../engine/paths.js";

// State engine — loaded dynamically based on --spec
let engine;

async function initEngine(specName) {
  if (engine) return engine;
  engine = await import(`./${specName}/state-sim.js`);
  // Also initialize the shared engine in the sub-tools so they don't re-import
  await initTimelineEngine(specName);
  await initInterpreterEngine(specName);
  return engine;
}

// ---------------------------------------------------------------------------
// State reconstruction helper
// Converts a snapshot from the trace back into a live state for scoring
// ---------------------------------------------------------------------------

function snapshotToState(snap, buildConfig) {
  const state = engine.createInitialState(buildConfig);
  state.fury = snap.fury;
  state.soul_fragments = snap.soul_fragments;
  state.buffStacks.voidfall_building = snap.vf_building;
  state.buffStacks.voidfall_spending = snap.vf_spending;
  state.vf_building = snap.vf_building;
  state.vf_spending = snap.vf_spending;

  // Restore buff durations, dots, and cooldowns from snapshot
  for (const [dict, snapDict] of [
    [state.buffs, snap.buffs],
    [state.dots, snap.dots],
    [state.cooldowns, snap.cooldowns],
  ]) {
    if (snapDict) {
      for (const [key, val] of Object.entries(snapDict)) {
        if (key in dict) dict[key] = val;
      }
    }
  }

  state.charges.fracture = snap.fracture_charges ?? 2;
  if (snap.ia_charges !== undefined) {
    state.charges.immolation_aura = snap.ia_charges;
    state.recharge.immolation_aura = snap.ia_recharge ?? 30;
  }

  // Sync fury_cap from Meta
  if (state.buffs.metamorphosis > 0) state.fury_cap = 120;

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
  const duration = aplTrace.metadata?.duration ?? 120;

  for (const event of aplTrace.events.filter((e) => !e.off_gcd)) {
    const state = snapshotToState(event.pre, buildConfig);
    const optAbility = getBestAbility(state);

    if (!optAbility || optAbility === event.ability) continue;
    // Skip when rollout chose a filler — indicates a scoring artifact not a real APL gap
    if (isFillerAbility(optAbility)) continue;
    if (isFillerAbility(event.ability) && isFillerAbility(optAbility)) continue;

    const optScore = engine.scoreDpgcd(state, optAbility);
    const aplScore = engine.scoreDpgcd(state, event.ability);
    const dpgcdDelta = optScore - aplScore;

    if (Math.abs(dpgcdDelta) < 10) continue;

    const opt = { ability: optAbility };
    const apl = { ability: event.ability };
    const frequency = estimateFrequency(opt, apl, buildConfig);

    divergences.push({
      gcd: event.gcd,
      t: event.t,
      state: {
        fury: event.pre.fury,
        soul_fragments: event.pre.soul_fragments,
        vf_building: event.pre.vf_building,
        vf_spending: event.pre.vf_spending,
        buffs: event.pre.buffs,
        dots: event.pre.dots,
      },
      optimal: { ability: optAbility, score: optScore },
      actual: {
        ability: event.ability,
        apl_reason: event.apl_reason,
        score: aplScore,
      },
      dpgcd_delta: Math.round(dpgcdDelta),
      frequency_estimate: frequency,
      estimated_dps_impact: estimateDpsImpact(dpgcdDelta, frequency, duration),
      fix_hint: generateFixHint(opt, apl, state, buildConfig),
    });
  }

  divergences.sort((a, b) => Math.abs(b.dpgcd_delta) - Math.abs(a.dpgcd_delta));
  return divergences;
}

// Filler abilities: lowest priority, differences between them are noise
function isFillerAbility(ability) {
  return ["throw_glaive", "felblade", "sigil_of_flame"].includes(ability);
}

// Estimate how often this divergence pattern occurs per 2-minute cycle
function estimateFrequency(opt, apl, buildConfig) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;

  // Meta-related divergences: ~every 180s
  if (optAbility === "metamorphosis" || aplAbility === "metamorphosis") {
    return "~every 3min (Meta CD)";
  }

  // SpB threshold divergences: multiple times per Meta window
  if (optAbility === "spirit_bomb" && aplAbility === "fracture") {
    return "2-4× per Meta window";
  }

  if (optAbility === "spirit_bomb" || aplAbility === "spirit_bomb") {
    return "~every SpB window (~8-10s)";
  }

  // FelDev timing: ~every 30-40s
  if (optAbility === "fel_devastation" || aplAbility === "fel_devastation") {
    return "~every 30-40s (FelDev CD)";
  }

  // Fiery Brand: ~every 60s
  if (optAbility === "fiery_brand" || aplAbility === "fiery_brand") {
    return "~every 60s (FB CD)";
  }

  // VF state machine divergences: ~every 15-20s
  if (opt.state?.vf_building > 0 || opt.state?.vf_spending > 0) {
    return "~every VF cycle (~15-20s)";
  }

  return "intermittent";
}

// Estimate DPS impact as a percentage of total fight DPS
// Using rough baseline of ~25,000 raw score units per 120s fight
function estimateDpsImpact(dpgcdDelta, frequency, durationSeconds) {
  const TOTAL_SCORE_PER_SECOND = 200; // arbitrary baseline score/second
  const totalScore = TOTAL_SCORE_PER_SECOND * durationSeconds;

  // Estimate occurrences per fight
  let occurrences;
  if (frequency.includes("3min")) occurrences = durationSeconds / 180;
  else if (frequency.includes("60s")) occurrences = durationSeconds / 60;
  else if (frequency.includes("30-40s")) occurrences = durationSeconds / 35;
  else if (frequency.includes("15-20s")) occurrences = durationSeconds / 17;
  else if (frequency.includes("8-10s")) occurrences = durationSeconds / 9;
  else if (frequency.includes("Meta window"))
    occurrences = (durationSeconds / 180) * 3;
  else occurrences = durationSeconds / 20; // Generic estimate

  const totalImpact = dpgcdDelta * occurrences;
  const pct = (totalImpact / totalScore) * 100;

  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

// Generate a fix hint based on the divergence pattern
function generateFixHint(opt, apl, preState, buildConfig) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;
  const frags = preState.soul_fragments;
  const inMeta = preState.buffs.metamorphosis > 0;
  const vfSpending = preState.buffStacks.voidfall_spending;
  const vfBuilding = preState.buffStacks.voidfall_building;
  const fbActive = (preState.dots?.fiery_brand || 0) > 0;

  // SpB was optimal but APL chose Fracture
  if (optAbility === "spirit_bomb" && aplAbility === "fracture") {
    if (inMeta) {
      return `spb_threshold condition during Meta may be too high (frags=${frags}, threshold likely${frags >= 4 ? " correct" : ` requires ${frags}>=threshold`})`;
    }
    if (fbActive) {
      return `SpB under Fiery Demise: APL spb_threshold or fiery_demise_active condition may not be triggering (frags=${frags}, fb_active=${fbActive})`;
    }
    return `SpB gating condition too strict at frags=${frags}; APL chose Fracture instead`;
  }

  // Meta was optimal but APL delayed
  if (optAbility === "metamorphosis" && aplAbility !== "metamorphosis") {
    if (frags < 3) {
      return `APL gates Meta on soul_fragments>=3; at frags=${frags} APL delays. Consider whether pre-loading Fracture costs more than it gains.`;
    }
    if (vfSpending > 0) {
      return `APL blocks Meta during VF spending phase (spending=${vfSpending}); timing interaction with VF dump`;
    }
    return `Meta timing: APL delays while optimal fires; check Meta entry conditions`;
  }

  // FelDev timing vs. other abilities
  if (optAbility === "fel_devastation" && aplAbility !== "fel_devastation") {
    if (fbActive) {
      return `FelDev should fire under Fiery Demise (+30% fire amp); APL chose ${aplAbility} instead — check fb_active gating in anni_cooldowns`;
    }
    if (inMeta) {
      return `FelDev in Meta: APL may be gating on !apex.3|talent.darkglare_boon; verify DGB flag`;
    }
    return `FelDev opportunity: APL chose ${aplAbility}; check anni_cooldowns priority or voidfall_spending gate`;
  }

  // Fiery Brand timing
  if (optAbility === "fiery_brand" && !fbActive) {
    return `FB should be applied to enable Fiery Demise; APL chose ${aplAbility}. Check anni_voidfall or anni_cooldowns fire brand condition`;
  }

  // APL chose SC but optimal wants SpB (fragment mismatch)
  if (optAbility === "spirit_bomb" && aplAbility === "soul_cleave") {
    if (vfSpending > 0) {
      return `VF spending phase: optimal wants SpB at spending=${vfSpending} but APL chose SC; check voidfall spending conditions`;
    }
    return `SpB vs SC: ${frags} frags available, optimal prefers SpB for fragment efficiency`;
  }

  // Fragment generator vs. spender mismatch
  if (isFragmentGenerator(optAbility) && isFragmentSpender(aplAbility)) {
    return `APL spending fragments when optimal would generate; frags=${frags} may be above optimal spending threshold at this point`;
  }

  if (isFragmentSpender(optAbility) && isFragmentGenerator(aplAbility)) {
    return `APL generating fragments when optimal would spend; frags=${frags} sufficient for ${optAbility} but APL generated more first`;
  }

  return `${aplAbility} chosen by APL; ${optAbility} scored higher in 15s rollout due to upcoming buff windows or resource state`;
}

function isFragmentGenerator(ability) {
  return [
    "fracture",
    "soul_carver",
    "sigil_of_spite",
    "immolation_aura",
  ].includes(ability);
}

function isFragmentSpender(ability) {
  return ["spirit_bomb", "soul_cleave"].includes(ability);
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
    "| # | GCD | t | Optimal | APL Chose | DPGCD Δ | Est. Impact | Frequency |",
  );
  lines.push(
    "|---|-----|---|---------|-----------|---------|-------------|-----------|",
  );
  for (let i = 0; i < Math.min(divergences.length, 20); i++) {
    const d = divergences[i];
    lines.push(
      `| ${i + 1} | ${d.gcd} | ${d.t}s | \`${d.optimal.ability}\` | \`${d.actual.ability}\` | ${d.dpgcd_delta > 0 ? "+" : ""}${d.dpgcd_delta} | ${d.estimated_dps_impact} | ${d.frequency_estimate} |`,
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

    lines.push(
      `**State:** fury=${d.state.fury}, frags=${d.state.soul_fragments}, VF=${d.state.vf_building}/${d.state.vf_spending}`,
    );
    if (buffsStr) lines.push(`**Buffs:** ${buffsStr}`);
    if (dotsStr) lines.push(`**DoTs:** ${dotsStr}`);
    lines.push("");
    lines.push(`**Optimal choice:** \`${d.optimal.ability}\``);
    lines.push(`> DPGCD score: ${d.optimal.score?.toFixed(0) ?? "?"}`);
    lines.push("");
    lines.push(`**APL chose:** \`${d.actual.ability}\``);
    lines.push(`> Condition: \`${d.actual.apl_reason || "unconditional"}\``);
    lines.push("");
    lines.push(
      `**DPGCD delta:** ${d.dpgcd_delta > 0 ? "+" : ""}${d.dpgcd_delta} (estimated ${d.estimated_dps_impact} DPS)`,
    );
    lines.push(`**Frequency:** ${d.frequency_estimate}`);
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

  const candidates = divergences.filter((d) => {
    const pct = parseFloat(d.estimated_dps_impact);
    return Math.abs(pct) >= 0.05;
  });

  if (candidates.length === 0) {
    lines.push("No divergences above 0.05% threshold. APL is near optimal.");
  } else {
    for (const c of candidates) {
      lines.push(
        `- **${c.optimal.ability} at GCD ${c.gcd}**: ${c.estimated_dps_impact} — ${c.fix_hint}`,
      );
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "> Generated by `npm run divergence`. Scores are estimates using AP-coefficient-based DPGCD.",
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
    },
    strict: false,
  });

  const spec = values.spec || parseSpecArg();
  await initSpec(spec);
  await initEngine(spec);

  const ARCHETYPES = getSpecAdapter().getSpecConfig().analysisArchetypes ?? {};
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

  // Load or generate the APL trace
  const traceFile =
    values.trace || join(resultsDir, `apl-trace-${buildName}.json`);
  let aplTrace;
  if (existsSync(traceFile)) {
    console.log(`Loading APL trace: ${traceFile}`);
    aplTrace = JSON.parse(readFileSync(traceFile, "utf-8"));
  } else {
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
    console.log("─".repeat(80));
    const header = [
      "#".padEnd(3),
      "GCD".padEnd(5),
      "t".padEnd(7),
      "Optimal".padEnd(20),
      "APL".padEnd(20),
      "Δ DPGCD".padEnd(10),
      "Est. Impact",
    ].join(" ");
    console.log(header);
    console.log("─".repeat(80));

    for (let i = 0; i < Math.min(10, divergences.length); i++) {
      const d = divergences[i];
      const row = [
        String(i + 1).padEnd(3),
        String(d.gcd).padEnd(5),
        `${d.t}s`.padEnd(7),
        d.optimal.ability.padEnd(20),
        d.actual.ability.padEnd(20),
        (d.dpgcd_delta >= 0 ? "+" : "") + d.dpgcd_delta,
        d.estimated_dps_impact,
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
