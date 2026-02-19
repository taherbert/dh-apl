// Time-horizon rollout sequencer for optimal cast sequence analysis.
//
// Determines the theoretically optimal ability at each GCD using a 15-second
// lookahead rollout rather than greedy immediate scoring. This correctly
// values setup actions (Fiery Brand → future fire amp, fragment pooling →
// higher-frag SpB, Meta investment → 15s window value).
//
// The state engine and build archetypes are loaded from the spec module at
// runtime (--spec flag), so this file contains no spec-specific hardcoding.
//
// Usage:
//   node src/analysis/optimal-timeline.js --spec vengeance --build anni-apex3-dgb --duration 120
//   npm run optimal-timeline -- --build anni-apex3-dgb --duration 120

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { initSpec, getSpecAdapter } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { ROOT } from "../engine/paths.js";

// State engine loaded dynamically based on --spec
let engine;

export async function initEngine(specName) {
  if (engine) return engine;
  engine = await import(`./${specName}/state-sim.js`);
  if (engine.buildScoreTable) {
    const specConfig = getSpecAdapter().getSpecConfig();
    const table = engine.buildScoreTable({
      domainOverrides: specConfig.domainOverrides,
      burstWindows: specConfig.burstWindows,
      setBonus: specConfig.setBonus,
      tuning: specConfig.tuning,
    });
    engine.initScoring(table);
  }
  return engine;
}

// ---------------------------------------------------------------------------
// Time-horizon rollout scorer
//
// For each candidate ability 'a' at the current GCD:
//   score(a) = immediate_dpgcd(a) + rollout_dps(applyAbility(s, a), T_horizon)
//
// rollout_dps uses greedy (immediate-only) continuation to estimate future
// value. T_horizon = 25s covers a full Fiery Brand duration (10s) plus
// follow-on burst windows, reducing false positives for CD setup abilities.
// ---------------------------------------------------------------------------

const T_HORIZON = 25;
const DISCOUNT_RATE = 0.97;

// 6 deep steps covers setup payoffs (FB fire amp, IA Charred Flesh extension)
// that realize over 5-8 GCDs. Each step uses depth-2 lookahead (immediate + best next).
const DEEP_STEPS = 6;

function rolloutDps(state, horizon) {
  const {
    applyAbility,
    advanceTime,
    getAvailable,
    scoreDpgcd,
    OFF_GCD_ABILITIES,
    getAbilityGcd,
    getOffGcdTrigger,
  } = engine;
  let s = state;
  let totalScore = 0;
  let elapsed = 0;
  let offGcdGuard = 0; // prevent infinite loop if trigger fails to clear itself
  let step = 0;

  // Clip rollout to fight end so we don't credit phantom play beyond the fight
  const effectiveHorizon = Math.min(
    horizon,
    Math.max(0, (s.fight_end ?? Infinity) - s.t),
  );
  if (effectiveHorizon <= 0) return 0;

  while (elapsed < effectiveHorizon) {
    const override = getOffGcdTrigger(s);
    if (override && offGcdGuard < 5) {
      offGcdGuard++;
      totalScore += scoreDpgcd(s, override);
      s = applyAbility(s, override);
      continue; // Off-GCD: no time consumed; trigger clears itself after apply
    }
    offGcdGuard = 0;

    const available = getAvailable(s).filter(
      (id) => !OFF_GCD_ABILITIES.has(id),
    );
    if (available.length === 0) {
      s = advanceTime(s, s.gcd);
      elapsed += s.gcd;
      continue;
    }

    let bestAbility = null;
    let bestScore = -Infinity;

    for (const id of available) {
      let sc;
      if (step < DEEP_STEPS) {
        // 1-step lookahead: immediate + best next GCD score (depth-2 continuation)
        const nextS = applyAbility(s, id);
        const dt2 = getAbilityGcd(s, id) || s.gcd;
        const nextS2 = advanceTime(nextS, dt2);
        const nextAvail = getAvailable(nextS2).filter(
          (id2) => !OFF_GCD_ABILITIES.has(id2),
        );
        const bestNextScore =
          nextAvail.length > 0
            ? Math.max(...nextAvail.map((id2) => scoreDpgcd(nextS2, id2)))
            : 0;
        sc = scoreDpgcd(s, id) + bestNextScore;
      } else {
        sc = scoreDpgcd(s, id); // pure greedy
      }
      if (sc > bestScore) {
        bestScore = sc;
        bestAbility = id;
      }
    }

    if (!bestAbility) {
      s = advanceTime(s, s.gcd);
      elapsed += s.gcd;
      continue;
    }

    step++;
    const discount = Math.pow(DISCOUNT_RATE, step);
    totalScore += scoreDpgcd(s, bestAbility) * discount;
    s = applyAbility(s, bestAbility);
    const dt = getAbilityGcd(s, bestAbility) || s.gcd;
    s = advanceTime(s, dt);
    elapsed += dt;
  }

  return totalScore;
}

function pickOptimal(state) {
  const {
    applyAbility,
    advanceTime,
    getAvailable,
    scoreDpgcd,
    OFF_GCD_ABILITIES,
    getAbilityGcd,
  } = engine;

  const available = getAvailable(state).filter(
    (id) => !OFF_GCD_ABILITIES.has(id),
  );
  if (available.length === 0) return null;

  let bestAbility = null;
  let bestTotal = -Infinity;
  let bestImmediate = 0;
  let bestRollout = 0;

  for (const id of available) {
    const immediate = scoreDpgcd(state, id);
    const next = applyAbility(state, id);
    const dt = getAbilityGcd(state, id) || state.gcd;
    const rollout = rolloutDps(advanceTime(next, dt), T_HORIZON);
    const total = immediate + rollout;

    if (total > bestTotal) {
      bestTotal = total;
      bestAbility = id;
      bestImmediate = immediate;
      bestRollout = rollout;
    }
  }

  return {
    ability: bestAbility,
    immediate: bestImmediate,
    rollout: bestRollout,
    total: bestTotal,
  };
}

// ---------------------------------------------------------------------------
// Main timeline generator
// ---------------------------------------------------------------------------

export function generateTimeline(buildConfig, durationSeconds = 120) {
  const {
    createInitialState,
    applyAbility,
    advanceTime,
    getAbilityGcd,
    getOffGcdTrigger,
  } = engine;

  let state = createInitialState(buildConfig);
  state.fight_end = durationSeconds;
  const events = [];
  let gcdNumber = 0;
  let offGcdGuard = 0;

  while (state.t < durationSeconds) {
    const override = getOffGcdTrigger(state);
    if (override && offGcdGuard < 5) {
      offGcdGuard++;
      const preState = snapshotState(state);
      const t = state.t;
      state = applyAbility(state, override);
      events.push({
        t: parseFloat(t.toFixed(3)),
        gcd: gcdNumber,
        ability: override,
        off_gcd: true,
        pre: preState,
        post: snapshotState(state),
        score: { immediate: 0, rollout: null, total: null },
        rationale: "off-gcd trigger",
      });
      continue;
    }
    offGcdGuard = 0;

    const decision = pickOptimal(state);
    if (!decision) {
      state = advanceTime(state, state.gcd);
      continue;
    }

    gcdNumber++;
    const preState = snapshotState(state);
    const preT = state.t;
    const { ability, immediate, rollout } = decision;

    state = applyAbility(state, ability);
    const dt = getAbilityGcd(preState, ability) || preState.gcd;
    state = advanceTime(state, dt);

    if (ability === "fel_devastation" && state._feldev_channel) {
      const extra = Math.max(0, state._feldev_channel - dt);
      if (extra > 0) state = advanceTime(state, extra);
    }

    events.push({
      t: parseFloat(preT.toFixed(3)),
      gcd: gcdNumber,
      ability,
      off_gcd: false,
      pre: preState,
      post: snapshotState(state),
      score: { immediate, rollout, total: immediate + rollout },
    });
  }

  return {
    metadata: {
      build: buildConfig._name || "custom",
      heroTree: buildConfig.heroTree,
      apexRank: buildConfig.apexRank,
      duration: durationSeconds,
      haste: buildConfig.haste,
      talents: buildConfig.talents,
    },
    events,
  };
}

function snapshotState(s) {
  return {
    fury: s.fury,
    soul_fragments: s.soul_fragments,
    vf_building: s.buffStacks?.voidfall_building ?? s.vf_building ?? 0,
    vf_spending: s.buffStacks?.voidfall_spending ?? s.vf_spending ?? 0,
    gcd: s.gcd,
    buffs: Object.fromEntries(
      Object.entries(s.buffs ?? {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, parseFloat(v.toFixed(1))]),
    ),
    dots: Object.fromEntries(
      Object.entries(s.dots ?? {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, parseFloat(v.toFixed(1))]),
    ),
    debuffs: Object.fromEntries(
      Object.entries(s.debuffs ?? {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, parseFloat(v.toFixed(1))]),
    ),
    cooldowns: Object.fromEntries(
      Object.entries(s.cooldowns ?? {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, parseFloat(v.toFixed(1))]),
    ),
    fracture_charges: s.charges?.fracture,
    ia_charges: s.charges?.immolation_aura,
    ia_recharge: s.recharge?.immolation_aura,
  };
}

// Returns the optimal ability for a given state — used by divergence.js
// for state-held comparison (avoids the state drift of index-based comparison).
export function getBestAbility(state) {
  return pickOptimal(state)?.ability ?? null;
}

// Full rollout score for a specific ability — used by divergence.js to compute
// the delta as rollout(optimal) - rollout(apl_choice), which is always >= 0
// and directly meaningful (immediate scores alone mislead for strategic setups).
export function getAbilityRolloutScore(state, abilityId) {
  const { applyAbility, advanceTime, scoreDpgcd, getAbilityGcd } = engine;
  const immediate = scoreDpgcd(state, abilityId);
  const next = applyAbility(state, abilityId);
  const dt = getAbilityGcd(state, abilityId) || state.gcd;
  return immediate + rolloutDps(advanceTime(next, dt), T_HORIZON);
}

export { snapshotState };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      build: { type: "string", default: "anni-apex3-dgb" },
      duration: { type: "string", default: "120" },
      output: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    strict: false,
  });

  const specName = values.spec || parseSpecArg();
  await initSpec(specName);
  await initEngine(specName);

  const ARCHETYPES = getSpecAdapter().getSpecConfig().analysisArchetypes ?? {};
  const buildName = values.build;
  const archetype = ARCHETYPES[buildName];

  if (!archetype) {
    console.error(`Unknown build: ${buildName}`);
    console.error(`Available builds: ${Object.keys(ARCHETYPES).join(", ")}`);
    process.exit(1);
  }

  archetype._name = buildName;
  const duration = parseInt(values.duration, 10);

  console.log(`Generating optimal timeline: ${buildName} (${duration}s)`);
  console.log(
    `  Hero tree: ${archetype.heroTree}, Apex: ${archetype.apexRank}`,
  );
  console.log(
    `  Haste: ${(archetype.haste * 100).toFixed(0)}%, GCD: ${(1.5 / (1 + archetype.haste)).toFixed(3)}s`,
  );
  console.log();

  const timeline = generateTimeline(archetype, duration);

  console.log("First 30 GCDs:");
  console.log("─".repeat(100));
  const header = [
    "GCD".padEnd(4),
    "t".padEnd(7),
    "Ability".padEnd(22),
    "Fury".padEnd(6),
    "Frags".padEnd(6),
    "VF B/S".padEnd(8),
    "Score",
  ].join(" ");
  console.log(header);
  console.log("─".repeat(100));

  for (const evt of timeline.events.slice(0, 30)) {
    const score = evt.off_gcd ? "offgcd" : (evt.score.total?.toFixed(0) ?? "?");
    const vf = `${evt.pre.vf_building}/${evt.pre.vf_spending}`;
    console.log(
      [
        String(evt.gcd).padEnd(4),
        `${evt.t}s`.padEnd(7),
        evt.ability.padEnd(22),
        String(evt.pre.fury).padEnd(6),
        String(evt.pre.soul_fragments).padEnd(6),
        vf.padEnd(8),
        score,
      ].join(" "),
    );
  }

  console.log(`\nTotal events: ${timeline.events.length}`);

  const outputDir = join(ROOT, "results", specName);
  mkdirSync(outputDir, { recursive: true });
  const outputFile =
    values.output || join(outputDir, `timeline-${buildName}.json`);
  writeFileSync(
    outputFile,
    JSON.stringify(timeline, null, values.pretty ? 2 : undefined),
  );
  console.log(`\nTimeline saved to: ${outputFile}`);
}
