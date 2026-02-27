// Pattern analysis — consumes cached APL trace + divergence JSONs.
// No re-simulation. Replaces resource flow analysis in theorycraft.js
// with GCD-level precision from state-sim traces.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resultsDir } from "../engine/paths.js";

export function analyzeResourceFlow(aplTrace, specConfig) {
  const resourceModels = specConfig.resourceModels || [];
  const results = {};

  for (const model of resourceModels) {
    const name = model.name;
    const cap = model.cap;
    const events = aplTrace.events.filter((e) => !e.off_gcd);

    let generated = 0;
    let consumed = 0;
    let overflowEvents = 0;
    let capTime = 0;
    let totalLevels = 0;

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      const pre = evt.pre;
      const post = evt.post;

      const preLevel = pre[name] ?? 0;
      const postLevel = post?.[name] ?? preLevel;
      totalLevels += preLevel;

      if (postLevel > preLevel) {
        generated += postLevel - preLevel;
      } else if (postLevel < preLevel) {
        consumed += preLevel - postLevel;
      }

      if (preLevel >= cap) capTime++;

      if (preLevel >= cap - 1) {
        const generators = model.generators.map((g) => g.ability);
        if (generators.includes(evt.ability)) overflowEvents++;
      }
    }

    const totalGcds = events.length;
    results[name] = {
      generated,
      consumed,
      overflowEvents,
      capTimePercent: totalGcds > 0 ? (capTime / totalGcds) * 100 : 0,
      avgLevel: totalGcds > 0 ? totalLevels / totalGcds : 0,
      totalGcds,
    };
  }

  const fillers = new Set(specConfig.fillerAbilities || []);
  const onGcdEvents = aplTrace.events.filter((e) => !e.off_gcd);
  const deadGcds = onGcdEvents.filter((e) => fillers.has(e.ability)).length;

  results.gcds = {
    total: onGcdEvents.length,
    dead: deadGcds,
    deadPercent:
      onGcdEvents.length > 0 ? (deadGcds / onGcdEvents.length) * 100 : 0,
  };

  return results;
}

export function analyzeCooldownInteractions(aplTrace, specConfig) {
  const burstWindows = specConfig.burstWindows || [];
  const stateMachines = specConfig.stateMachines || {};
  const events = aplTrace.events;
  const results = { windows: [], cdAlignment: [], stateMachines: [] };

  for (const window of burstWindows) {
    const buffName = window.buff;
    const windowPeriods = [];
    let windowStart = null;

    for (const evt of events) {
      const preHasBuff =
        (evt.pre.dots?.[buffName] ?? 0) > 0 ||
        (evt.pre.buffs?.[buffName] ?? 0) > 0;
      const postHasBuff =
        (evt.post?.dots?.[buffName] ?? 0) > 0 ||
        (evt.post?.buffs?.[buffName] ?? 0) > 0;

      if (!preHasBuff && postHasBuff) {
        windowStart = evt.t;
      } else if (preHasBuff && !postHasBuff && windowStart !== null) {
        windowPeriods.push({ start: windowStart, end: evt.t });
        windowStart = null;
      }
    }

    const windowAnalysis = windowPeriods.map((period) => {
      const windowEvents = events.filter(
        (e) => e.t >= period.start && e.t <= period.end && !e.off_gcd,
      );
      const abilityCounts = {};
      for (const e of windowEvents) {
        abilityCounts[e.ability] = (abilityCounts[e.ability] || 0) + 1;
      }

      const syncHits = {};
      for (const target of window.syncTargets || []) {
        syncHits[target] = abilityCounts[target] || 0;
      }

      return {
        start: period.start,
        end: period.end,
        duration: period.end - period.start,
        gcdCount: windowEvents.length,
        abilityCounts,
        syncHits,
      };
    });

    const totalSyncHits = {};
    const totalSyncPossible = {};
    for (const target of window.syncTargets || []) {
      totalSyncHits[target] = windowAnalysis.reduce(
        (sum, w) => sum + (w.syncHits[target] || 0),
        0,
      );
      totalSyncPossible[target] = events.filter(
        (e) => e.ability === target && !e.off_gcd,
      ).length;
    }

    results.windows.push({
      buff: buffName,
      occurrences: windowPeriods.length,
      avgDuration:
        windowPeriods.length > 0
          ? windowPeriods.reduce((s, p) => s + (p.end - p.start), 0) /
            windowPeriods.length
          : 0,
      syncUtilization: totalSyncHits,
      totalCasts: totalSyncPossible,
      details: windowAnalysis,
    });
  }

  const cooldownAbilities = burstWindows.map((w) => w.buff);
  for (let i = 0; i < cooldownAbilities.length; i++) {
    for (let j = i + 1; j < cooldownAbilities.length; j++) {
      const a = cooldownAbilities[i];
      const b = cooldownAbilities[j];
      const aCasts = events.filter((e) => e.ability === a).map((e) => e.t);
      const bCasts = events.filter((e) => e.ability === b).map((e) => e.t);

      if (aCasts.length > 0 && bCasts.length > 0) {
        const avgDesync =
          aCasts.reduce((sum, aT) => {
            const closest = bCasts.reduce(
              (best, bT) => Math.min(best, Math.abs(aT - bT)),
              Infinity,
            );
            return sum + closest;
          }, 0) / aCasts.length;

        results.cdAlignment.push({
          cdA: a,
          cdB: b,
          avgDesyncSeconds: avgDesync,
        });
      }
    }
  }

  for (const [smId, sm] of Object.entries(stateMachines)) {
    const heroTree = aplTrace.metadata?.heroTree;
    if (heroTree && heroTree !== smId) continue;

    const smAnalysis = {
      id: smId,
      name: sm.name,
      cycles: 0,
      completions: 0,
    };

    for (const state of sm.states || []) {
      if (!state.ability) continue;
      const casts = events.filter(
        (e) => e.ability === state.ability && !e.off_gcd,
      ).length;
      smAnalysis[state.name + "_casts"] = casts;
    }

    results.stateMachines.push(smAnalysis);
  }

  return results;
}

export function analyzeAplStructure(aplTrace) {
  const events = aplTrace.events.filter((e) => !e.off_gcd);

  const abilityCounts = {};
  for (const evt of events) {
    abilityCounts[evt.ability] = (abilityCounts[evt.ability] || 0) + 1;
  }

  const actionListUsage = {};
  for (const evt of events) {
    const reason = evt.apl_reason || "unknown";
    const listMatch = reason.match(/^([^:]+):/);
    const list = listMatch ? listMatch[1] : "default";
    actionListUsage[list] = (actionListUsage[list] || 0) + 1;
  }

  return {
    totalGcds: events.length,
    abilityCounts,
    actionListUsage,
    abilityFrequency: Object.fromEntries(
      Object.entries(abilityCounts).map(([k, v]) => [
        k,
        { count: v, pct: (v / events.length) * 100 },
      ]),
    ),
  };
}

export function clusterDivergences(divergences, fightDuration, specConfig) {
  const burstWindows = specConfig.burstWindows || [];
  const clustered = {
    opener: [],
    duringCd: [],
    preCd: [],
    fightEnd: [],
    midFight: [],
  };
  const periodicPatterns = {};

  for (const d of divergences) {
    const t = d.t;

    if (t < 10) {
      clustered.opener.push(d);
    } else if (t > fightDuration * 0.95) {
      clustered.fightEnd.push(d);
    } else {
      const inCdWindow = burstWindows.some((w) => {
        const cd = w.cooldown || 60;
        const dur = w.duration || 10;
        const cyclePos = t % cd;
        return cyclePos < dur;
      });

      const nearCd = burstWindows.some((w) => {
        const cd = w.cooldown || 60;
        const cyclePos = t % cd;
        return cyclePos > cd - 5;
      });

      if (inCdWindow) {
        clustered.duringCd.push(d);
      } else if (nearCd) {
        clustered.preCd.push(d);
      } else {
        clustered.midFight.push(d);
      }
    }

    const key = `${d.optimal.ability}>${d.actual.ability}`;
    if (!periodicPatterns[key]) periodicPatterns[key] = [];
    periodicPatterns[key].push(d.t);
  }

  const patterns = [];
  for (const [key, times] of Object.entries(periodicPatterns)) {
    if (times.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance =
      gaps.reduce((s, g) => s + Math.pow(g - avgGap, 2), 0) / gaps.length;
    const cv = Math.sqrt(variance) / avgGap;

    if (cv < 0.3) {
      patterns.push({
        pattern: key,
        period: avgGap,
        count: times.length,
        regularity: 1 - cv,
      });
    }
  }

  return {
    phases: {
      opener: clustered.opener.length,
      duringCd: clustered.duringCd.length,
      preCd: clustered.preCd.length,
      fightEnd: clustered.fightEnd.length,
      midFight: clustered.midFight.length,
    },
    divergencesByPhase: clustered,
    periodicPatterns: patterns,
    total: divergences.length,
  };
}

export function analyzePatterns(aplTrace, divergences, specConfig) {
  const fightDuration = aplTrace.metadata?.duration || 120;

  return {
    resourceFlow: analyzeResourceFlow(aplTrace, specConfig),
    cooldowns: analyzeCooldownInteractions(aplTrace, specConfig),
    aplStructure: analyzeAplStructure(aplTrace),
    divergenceClusters: clusterDivergences(
      divergences,
      fightDuration,
      specConfig,
    ),
    metadata: {
      build: aplTrace.metadata?.build,
      heroTree: aplTrace.metadata?.heroTree,
      apexRank: aplTrace.metadata?.apexRank,
      duration: fightDuration,
      totalGcds: aplTrace.events.filter((e) => !e.off_gcd).length,
      totalDivergences: divergences.length,
    },
  };
}
