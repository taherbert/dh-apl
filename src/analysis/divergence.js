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

  // Single pass: accumulate total fight score AND detect divergences.
  // totalFightScore = sum of immediate scoreDpgcd for all on-GCD APL choices,
  // used as the denominator for DPS% impact estimates.
  let totalFightScore = 0;

  for (const event of aplTrace.events.filter((e) => !e.off_gcd)) {
    const state = snapshotToState(event.pre, buildConfig);
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
      // actual_occurrences and estimated_dps_impact filled in post-loop
      fix_hint: generateFixHint(opt, apl, state, buildConfig),
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

// Filler abilities: lowest priority, differences between them are noise
function isFillerAbility(ability) {
  return ["throw_glaive", "felblade", "sigil_of_flame"].includes(ability);
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

// Human-readable frequency description (kept for report context alongside actual count)
function estimateFrequency(opt, apl) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;

  if (optAbility === "metamorphosis" || aplAbility === "metamorphosis")
    return "Meta CD (~3min)";
  if (optAbility === "spirit_bomb" && aplAbility === "fracture")
    return "SpB window";
  if (optAbility === "spirit_bomb" || aplAbility === "spirit_bomb")
    return "SpB window (~8-10s)";
  if (optAbility === "fel_devastation" || aplAbility === "fel_devastation")
    return "FelDev CD (~30-40s)";
  if (optAbility === "fiery_brand" || aplAbility === "fiery_brand")
    return "FB CD (~60s)";
  if (optAbility === "reavers_glaive" || aplAbility === "reavers_glaive")
    return "RG proc";
  return "intermittent";
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

  if (Math.abs(o.soul_fragments - a.soul_fragments) >= 2)
    details.push(
      `frags: opt_path=${o.soul_fragments} APL_path=${a.soul_fragments}`,
    );
  if (Math.abs(o.fury - a.fury) >= 20)
    details.push(`fury: opt_path=${o.fury} APL_path=${a.fury}`);
  const oVfs = o.buffStacks?.voidfall_spending ?? 0;
  const aVfs = a.buffStacks?.voidfall_spending ?? 0;
  if (oVfs !== aVfs)
    details.push(`VF spending: opt_path=${oVfs} APL_path=${aVfs}`);
  if ((o.dots?.fiery_brand ?? 0) > 0 !== (a.dots?.fiery_brand ?? 0) > 0)
    details.push(
      `FB active: opt_path=${(o.dots?.fiery_brand ?? 0) > 0} APL_path=${(a.dots?.fiery_brand ?? 0) > 0}`,
    );

  return details.join("; ");
}

// Generate a fix hint based on the divergence pattern
function generateFixHint(opt, apl, preState, buildConfig) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;
  const frags = preState.soul_fragments;
  const inMeta = preState.buffs.metamorphosis > 0;
  const vfSpending = preState.buffStacks.voidfall_spending;
  const fbActive = (preState.dots?.fiery_brand || 0) > 0;

  // SpB was optimal but APL chose Fracture
  if (optAbility === "spirit_bomb" && aplAbility === "fracture") {
    const base = inMeta
      ? `spb_threshold condition during Meta may be too high (frags=${frags}, threshold likely${frags >= 4 ? " correct" : ` requires ${frags}>=threshold`})`
      : fbActive
        ? `SpB under Fiery Demise: APL spb_threshold or fiery_demise_active condition may not be triggering (frags=${frags}, fb_active=${fbActive})`
        : `SpB gating condition too strict at frags=${frags}; APL chose Fracture instead`;
    return `${base}. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
  }

  // Meta was optimal but APL delayed
  if (optAbility === "metamorphosis" && aplAbility !== "metamorphosis") {
    if (frags < 3) {
      return `APL gates Meta on soul_fragments>=3; at frags=${frags} APL delays. Consider whether pre-loading Fracture costs more than it gains. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
    }
    if (vfSpending > 0) {
      return `APL blocks Meta during VF spending phase (spending=${vfSpending}); timing interaction with VF dump. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
    }
    return `Meta timing: APL delays while optimal fires. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
  }

  // FelDev timing vs. other abilities
  if (optAbility === "fel_devastation" && aplAbility !== "fel_devastation") {
    if (fbActive) {
      return `FelDev should fire under Fiery Demise (+30% fire amp); APL chose ${aplAbility} instead — check fb_active gating in anni_cooldowns. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
    }
    if (inMeta) {
      return `FelDev in Meta: APL may be gating on !apex.3|talent.darkglare_boon; verify DGB flag. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
    }
    return `FelDev opportunity: APL chose ${aplAbility}; check anni_cooldowns priority or voidfall_spending gate. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
  }

  // Fiery Brand timing
  if (optAbility === "fiery_brand" && !fbActive) {
    return `FB should be applied to enable Fiery Demise; APL chose ${aplAbility}. Check anni_voidfall or anni_cooldowns fire brand condition. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
  }

  // APL chose SC but optimal wants SpB (fragment mismatch)
  if (optAbility === "spirit_bomb" && aplAbility === "soul_cleave") {
    const base =
      vfSpending > 0
        ? `VF spending phase: optimal wants SpB at spending=${vfSpending} but APL chose SC; check voidfall spending conditions`
        : `SpB vs SC: ${frags} frags available, optimal prefers SpB for fragment efficiency`;
    return `${base}. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
  }

  // Fragment generator vs. spender mismatch
  if (isFragmentGenerator(optAbility) && isFragmentSpender(aplAbility)) {
    return `APL spending fragments when optimal would generate; frags=${frags} may be above optimal spending threshold at this point. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
  }

  if (isFragmentSpender(optAbility) && isFragmentGenerator(aplAbility)) {
    return `APL generating fragments when optimal would spend; frags=${frags} sufficient for ${optAbility} but APL generated more first. ${compareRolloutBranches(preState, optAbility, aplAbility)}`;
  }

  // Default: show rollout branch comparison
  return compareRolloutBranches(preState, optAbility, aplAbility);
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
    "| # | GCD | t | Optimal | APL Chose | Rollout Δ | Δ Score | Count | Context |",
  );
  lines.push(
    "|---|-----|---|---------|-----------|-----------|---------|-------|---------|",
  );
  for (let i = 0; i < Math.min(divergences.length, 20); i++) {
    const d = divergences[i];
    const freq = estimateFrequency(d.optimal, d.actual);
    lines.push(
      `| ${i + 1} | ${d.gcd} | ${d.t}s | \`${d.optimal.ability}\` | \`${d.actual.ability}\` | ${d.dpgcd_delta > 0 ? "+" : ""}${d.dpgcd_delta} | ${d.estimated_dps_impact} | ${d.actual_occurrences}× | ${freq} |`,
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
    const impactStr =
      d.actual_occurrences >= 2
        ? `Δ Score: ${d.estimated_dps_impact}`
        : "single occurrence — no % estimate";
    lines.push(`**Rollout delta:** +${d.dpgcd_delta} | ${impactStr}`);
    lines.push(
      `**Occurrences:** ${d.actual_occurrences}× in ${metadata.duration}s`,
    );
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

  const candidates = divergences.filter(
    (d) =>
      d.estimated_dps_impact_pct !== null &&
      Math.abs(d.estimated_dps_impact_pct) >= 0.05,
  );

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
    "> Generated by `npm run divergence`. Delta = 25s rollout(optimal) - rollout(APL choice); always ≥ 0.",
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

  // Load or generate the APL trace — with config-hash cache invalidation
  const traceFile =
    values.trace || join(resultsDir, `apl-trace-${buildName}.json`);
  let aplTrace = null;

  if (existsSync(traceFile) && !values["force-retrace"]) {
    const cached = JSON.parse(readFileSync(traceFile, "utf-8"));
    const currentHash = hashConfig(archetype);
    if (cached.metadata?.config_hash === currentHash) {
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
    console.log("─".repeat(90));
    const header = [
      "#".padEnd(3),
      "GCD".padEnd(5),
      "t".padEnd(7),
      "Optimal".padEnd(20),
      "APL".padEnd(20),
      "Δ Rollout".padEnd(10),
      "Δ Score".padEnd(16),
      "Count",
    ].join(" ");
    console.log(header);
    console.log("─".repeat(90));

    for (let i = 0; i < Math.min(10, divergences.length); i++) {
      const d = divergences[i];
      const row = [
        String(i + 1).padEnd(3),
        String(d.gcd).padEnd(5),
        `${d.t}s`.padEnd(7),
        d.optimal.ability.padEnd(20),
        d.actual.ability.padEnd(20),
        ((d.dpgcd_delta >= 0 ? "+" : "") + d.dpgcd_delta).padEnd(10),
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
