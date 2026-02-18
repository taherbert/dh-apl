// Time-horizon rollout sequencer for VDH Annihilation optimal cast sequence.
//
// Determines the theoretically optimal ability at each GCD using a 15-second
// lookahead rollout rather than greedy immediate scoring. This correctly
// values setup actions (Fiery Brand → future fire amp, fragment pooling →
// higher-frag SpB, Meta investment → 15s window value).
//
// Usage:
//   node src/analysis/optimal-timeline.js --spec vengeance --build anni-apex3-dgb --duration 120
//   npm run optimal-timeline -- --build anni-apex3-dgb --duration 120

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createInitialState,
  applyAbility,
  advanceTime,
  getAvailable,
  scoreDpgcd,
  OFF_GCD_ABILITIES,
  getAbilityGcd,
} from "./state-sim.js";
import { ROOT } from "../engine/paths.js";

// ---------------------------------------------------------------------------
// Build archetypes — predefined configurations for common roster builds
// ---------------------------------------------------------------------------

const ARCHETYPES = {
  "anni-apex3-dgb": {
    heroTree: "annihilator",
    apexRank: 3,
    haste: 0.2,
    target_count: 1,
    talents: {
      fiery_demise: true,
      fiery_brand: true,
      charred_flesh: true,
      burning_alive: true,
      down_in_flames: true,
      darkglare_boon: true,
      meteoric_rise: true,
      stoke_the_flames: true,
      vengeful_beast: true,
      untethered_rage: true,
      fallout: true,
      soul_carver: false,
      soul_sigils: false,
      quickened_sigils: false,
      cycle_of_binding: false,
      vulnerability: false,
    },
  },
  "anni-apex3-nodgb": {
    heroTree: "annihilator",
    apexRank: 3,
    haste: 0.2,
    target_count: 1,
    talents: {
      fiery_demise: true,
      fiery_brand: true,
      charred_flesh: true,
      burning_alive: true,
      down_in_flames: true,
      darkglare_boon: false,
      meteoric_rise: true,
      stoke_the_flames: true,
      vengeful_beast: true,
      untethered_rage: true,
      fallout: true,
      soul_carver: false,
    },
  },
  "anni-apex0-fullstack": {
    heroTree: "annihilator",
    apexRank: 0,
    haste: 0.2,
    target_count: 1,
    talents: {
      fiery_demise: true,
      fiery_brand: true,
      charred_flesh: true,
      burning_alive: true,
      down_in_flames: true,
      darkglare_boon: true,
      meteoric_rise: true,
      stoke_the_flames: true,
      soul_carver: true,
      soul_sigils: true,
      cycle_of_binding: true,
      vulnerability: true,
      fallout: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Time-horizon rollout scorer
//
// For each candidate ability 'a' at the current GCD:
//   score(a) = immediate_dpgcd(a) + rollout_dps(applyAbility(s, a), T_horizon)
//
// rollout_dps uses a greedy continuation (immediate score only, no further
// lookahead) to estimate the total damage enabled in the next T_horizon seconds.
//
// T_horizon = 15s: covers full Fiery Brand duration (10-15s with Charred Flesh),
// Meta chain decisions, and fury pooling windows.
// ---------------------------------------------------------------------------

const T_HORIZON = 15; // seconds of lookahead

function greedyScore(state, abilityId) {
  // Quick immediate score with fire amp awareness
  return scoreDpgcd(state, abilityId);
}

// Simulate the next T_horizon seconds greedily and return total damage score.
// Uses greedy (immediate) scoring — this is the continuation after the primary decision.
function rolloutDps(state, horizon) {
  let s = state;
  let totalScore = 0;
  let elapsed = 0;

  while (elapsed < horizon) {
    // Check for off-GCD Meta trigger
    const override = getMetaTrigger(s);
    if (override) {
      // Apply override (off-GCD; no time consumed)
      const score = greedyScore(s, override);
      s = applyAbility(s, override);
      totalScore += score;
      // Off-GCD doesn't advance time — but prevent infinite loop
      continue;
    }

    // Get available on-GCD abilities
    const available = getAvailable(s).filter(
      (id) => !OFF_GCD_ABILITIES.has(id),
    );
    if (available.length === 0) {
      // Nothing available: just advance time
      s = advanceTime(s, s.gcd);
      elapsed += s.gcd;
      continue;
    }

    // Greedy: pick highest immediate score
    let bestAbility = null;
    let bestScore = -Infinity;
    for (const id of available) {
      const sc = greedyScore(s, id);
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

    totalScore += bestScore;
    s = applyAbility(s, bestAbility);
    const dt = getAbilityGcd(s, bestAbility) || s.gcd;
    s = advanceTime(s, dt);
    elapsed += dt;
  }

  return totalScore;
}

// Determine if Meta should fire as an off-GCD event before the next GCD cast.
// Returns "metamorphosis" if Meta should fire, null otherwise.
function getMetaTrigger(state) {
  const cfg = state.buildConfig;
  const metaReady = state.cooldowns.metamorphosis <= 0;
  const inMeta = state.buffs.metamorphosis > 0;
  const vfSpending = state.buffStacks.voidfall_spending;

  if (!metaReady) return null;
  if (vfSpending > 0) return null; // Never interrupt VF spending phase

  // Hard override 1: UR proc Meta — fire immediately, always
  if (state.buffs.untethered_rage > 0) return "metamorphosis";

  // Standard Meta: not in Meta, soul_fragments >= 3
  if (!inMeta && state.soul_fragments >= 3) return "metamorphosis";

  // Standard Meta: not in Meta, frags < 3 but burst SpB was just cast (prev_gcd)
  if (!inMeta && state.prev_gcd === "spirit_bomb") return "metamorphosis";

  // Meta chaining (apex.3 only): hardcast during active Meta when vf_building=0
  if (inMeta && cfg.apexRank >= 3 && state.buffStacks.voidfall_building === 0) {
    return "metamorphosis";
  }

  return null;
}

// Pick the optimal ability at the current state using T_horizon rollout.
function pickOptimal(state) {
  const available = getAvailable(state).filter(
    (id) => !OFF_GCD_ABILITIES.has(id),
  );
  if (available.length === 0) return null;

  let bestAbility = null;
  let bestTotalScore = -Infinity;
  let bestImmediate = 0;
  let bestRollout = 0;

  for (const id of available) {
    const immediate = scoreDpgcd(state, id);
    const nextState = applyAbility(state, id);
    const dt = getAbilityGcd(state, id) || state.gcd;
    const afterGcd = advanceTime(nextState, dt);
    const rollout = rolloutDps(afterGcd, T_HORIZON);
    const total = immediate + rollout;

    if (total > bestTotalScore) {
      bestTotalScore = total;
      bestAbility = id;
      bestImmediate = immediate;
      bestRollout = rollout;
    }
  }

  return {
    ability: bestAbility,
    immediate: bestImmediate,
    rollout: bestRollout,
    total: bestTotalScore,
    rationale: buildRationale(state, bestAbility),
  };
}

// ---------------------------------------------------------------------------
// Rationale builder — explains why an ability was chosen
// ---------------------------------------------------------------------------

function buildRationale(state, abilityId) {
  const inMeta =
    (state.buffs?.metamorphosis ?? state.buffs?.metamorphosis ?? 0) > 0;
  const fbActive = (state.dots?.fiery_brand ?? 0) > 0;
  const metaReady = (state.cooldowns?.metamorphosis ?? 0) <= 0;
  const vfBuilding =
    state.buffStacks?.voidfall_building ?? state.vf_building ?? 0;
  const vfSpending =
    state.buffStacks?.voidfall_spending ?? state.vf_spending ?? 0;
  const frags = state.soul_fragments;
  const fury = state.fury;
  const cfg = state.buildConfig ?? {};

  switch (abilityId) {
    case "metamorphosis":
      if ((state.buffs?.untethered_rage ?? 0) > 0)
        return "UR proc: consume free Meta immediately";
      if (inMeta) return "Meta chain: hardcast for second MA cycle (apex.3)";
      if (frags >= 3)
        return `Meta entry: frags=${frags}>=3, SpB immediately castable on entry`;
      return "Meta: burst window opens";

    case "spirit_bomb":
      if (vfSpending === 3)
        return `VF dump: spending=3, frag=${frags} — trigger fel meteors`;
      if (fbActive && cfg.talents?.fiery_demise)
        return `SpB under Fiery Demise: frags=${frags}, fire amp active`;
      if (inMeta)
        return `SpB in Meta: frags=${frags}>=${inMeta ? 4 : 5} threshold, Dark Matter window`;
      return `SpB: frags=${frags} at threshold`;

    case "soul_cleave":
      if (vfSpending > 0 && vfSpending < 3)
        return `VF spending: SC increments to stack ${vfSpending + 1}`;
      return `SC: fury=${fury}, frags=${frags} below SpB threshold`;

    case "fracture":
      if (inMeta)
        return `Fracture in Meta: generates 3 frags, rapid SpB cycling`;
      if (vfBuilding === 2 && fury >= 70)
        return "Fracture: pool fury before VF building=3 transition";
      return `Fracture: fragment generation, frags=${frags}`;

    case "fiery_brand":
      if (inMeta)
        return "FB in Meta: apply Fiery Demise amp for in-Meta fire casts";
      return "Fiery Brand: enable +30% Fiery Demise amp for FelDev/SC/IA";

    case "immolation_aura":
      if (fbActive && cfg.talents?.charred_flesh)
        return "IA under Charred Flesh: extends FB duration by 0.25s/tick";
      return "IA: fury generation + Fallout frags";

    case "fel_devastation":
      return `FelDev: fire amp=${fbActive ? "+30%" : "base"}, generates ${cfg.talents?.meteoric_rise ? "+3 frags" : "no frags"}`;

    case "soul_carver":
      return `Soul Carver: +3 frags immediately, fire amp=${fbActive ? "+30%" : "base"}`;

    case "sigil_of_spite":
      return `SoS: +${cfg.talents?.soul_sigils ? 4 : 3} frags immediately, high AP`;

    case "immolation_aura":
      return "IA: fury generation, Fallout frags";

    case "felblade":
      return `Felblade: fury=${fury}+15, CD-filler`;

    default:
      return `${abilityId}: filler`;
  }
}

// ---------------------------------------------------------------------------
// Main timeline generator
// ---------------------------------------------------------------------------

export function generateTimeline(buildConfig, durationSeconds = 120) {
  let state = createInitialState(buildConfig);
  const events = [];
  let gcdNumber = 0;

  while (state.t < durationSeconds) {
    // Check for off-GCD Meta trigger (UR proc, standard Meta, or Meta chain)
    const override = getMetaTrigger(state);
    if (override) {
      const preState = snapshotState(state);
      const overrideT = state.t;
      state = applyAbility(state, override);
      events.push({
        t: parseFloat(overrideT.toFixed(3)),
        gcd: gcdNumber,
        ability: override,
        off_gcd: true,
        pre: preState,
        post: snapshotState(state),
        score: { immediate: 0, rollout: Infinity, total: Infinity },
        rationale: buildRationale(preState, override),
      });
      // Advance by epsilon to prevent infinite loop
      continue;
    }

    const decision = pickOptimal(state);
    if (!decision) {
      // Nothing to cast — advance by one GCD
      state = advanceTime(state, state.gcd);
      continue;
    }

    gcdNumber++;
    const preState = snapshotState(state);
    const preT = state.t;
    const { ability, immediate, rollout, rationale } = decision;

    state = applyAbility(state, ability);
    const dt = getAbilityGcd(preState, ability) || preState.gcd;
    state = advanceTime(state, dt);

    // FelDev channel: extra 0.5s channel overhead (2s total channel - 1.5s GCD)
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
      rationale,
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

// Snapshot relevant state fields for the output
function snapshotState(s) {
  return {
    fury: s.fury,
    soul_fragments: s.soul_fragments,
    vf_building: s.buffStacks?.voidfall_building ?? s.vf_building ?? 0,
    vf_spending: s.buffStacks?.voidfall_spending ?? s.vf_spending ?? 0,
    gcd: s.gcd,
    buffs: Object.fromEntries(
      Object.entries(s.buffs)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, parseFloat(v.toFixed(1))]),
    ),
    dots: Object.fromEntries(
      Object.entries(s.dots)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, parseFloat(v.toFixed(1))]),
    ),
    cooldowns: Object.fromEntries(
      Object.entries(s.cooldowns)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, parseFloat(v.toFixed(1))]),
    ),
    fracture_charges: s.charges.fracture,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      spec: { type: "string", default: "vengeance" },
      build: { type: "string", default: "anni-apex3-dgb" },
      duration: { type: "string", default: "120" },
      output: { type: "string" },
      pretty: { type: "boolean", default: false },
    },
    strict: false,
  });

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

  // Print first 20 GCDs
  console.log("First 20 GCDs:");
  console.log("─".repeat(100));
  const header = [
    "GCD".padEnd(4),
    "t".padEnd(7),
    "Ability".padEnd(22),
    "Fury".padEnd(6),
    "Frags".padEnd(6),
    "VF B/S".padEnd(8),
    "Score".padEnd(8),
    "Rationale",
  ].join(" ");
  console.log(header);
  console.log("─".repeat(100));

  for (const evt of timeline.events.slice(0, 30)) {
    const score = evt.off_gcd ? "offgcd" : evt.score.total.toFixed(0);
    const vf = `${evt.pre.vf_building}/${evt.pre.vf_spending}`;
    const row = [
      String(evt.gcd).padEnd(4),
      `${evt.t}s`.padEnd(7),
      evt.ability.padEnd(22),
      String(evt.pre.fury).padEnd(6),
      String(evt.pre.soul_fragments).padEnd(6),
      vf.padEnd(8),
      score.padEnd(8),
      evt.rationale.slice(0, 50),
    ].join(" ");
    console.log(row);
  }

  console.log(`\nTotal events: ${timeline.events.length}`);

  // Save to file
  const spec = values.spec;
  const outputDir = join(ROOT, "results", spec);
  mkdirSync(outputDir, { recursive: true });
  const outputFile =
    values.output || join(outputDir, `timeline-${buildName}.json`);
  writeFileSync(
    outputFile,
    JSON.stringify(timeline, null, values.pretty ? 2 : undefined),
  );
  console.log(`\nTimeline saved to: ${outputFile}`);
}
