// Cross-archetype synthesis — groups divergence patterns across builds,
// classifies them (universal, hero-specific, apex-correlated, talent-correlated),
// and compares resource flow metrics to flag outliers.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resultsDir } from "../engine/paths.js";
import { getSpecAdapter } from "../engine/startup.js";

export function synthesizePatterns(patternsByBuild, divergencesByBuild) {
  const specConfig = getSpecAdapter().getSpecConfig();
  // Flatten scenario-grouped archetypes to a single name→config map
  const rawArchetypes = specConfig.analysisArchetypes || {};
  const archetypes = {};
  for (const [key, val] of Object.entries(rawArchetypes)) {
    if (val?.heroTree !== undefined) {
      archetypes[key] = val;
    } else if (typeof val === "object") {
      Object.assign(archetypes, val);
    }
  }
  const groups = {};

  for (const [buildName, divergences] of Object.entries(divergencesByBuild)) {
    const buildConfig = archetypes[buildName];
    if (!buildConfig) continue;

    const patterns = patternsByBuild[buildName];
    const clustered = patterns?.divergenceClusters?.divergencesByPhase || {};

    for (const [phase, divs] of Object.entries(clustered)) {
      for (const d of divs) {
        const key = `${d.optimal.ability}|${d.actual.ability}|${phase}`;
        if (!groups[key]) {
          groups[key] = {
            optimalAbility: d.optimal.ability,
            actualAbility: d.actual.ability,
            phase,
            builds: [],
            totalDelta: 0,
          };
        }
        groups[key].builds.push({
          name: buildName,
          heroTree: buildConfig.heroTree,
          apexRank: buildConfig.apexRank,
          delta: d.dpgcd_delta,
          talents: buildConfig.talents,
        });
        groups[key].totalDelta += d.dpgcd_delta;
      }
    }
  }

  const totalArchetypes = Object.keys(archetypes).length;
  const classified = [];

  for (const [key, group] of Object.entries(groups)) {
    const buildCount = group.builds.length;
    const heroTrees = [...new Set(group.builds.map((b) => b.heroTree))];
    const apexRanks = [...new Set(group.builds.map((b) => b.apexRank))];

    let classification;
    if (buildCount >= Math.min(4, totalArchetypes)) {
      classification = "universal";
    } else if (heroTrees.length === 1) {
      classification = "hero_specific";
    } else if (apexRanks.length === 1) {
      classification = "apex_correlated";
    } else {
      const talentDiscriminator = findTalentDiscriminator(
        group.builds,
        archetypes,
      );
      if (talentDiscriminator) {
        classification = "talent_correlated";
        group.discriminator = talentDiscriminator;
      } else {
        classification = "partial";
      }
    }

    classified.push({
      ...group,
      key,
      classification,
      buildCount,
      heroTrees,
      apexRanks,
      avgDelta: group.totalDelta / buildCount,
    });
  }

  classified.sort((a, b) => b.avgDelta - a.avgDelta);
  return classified;
}

function findTalentDiscriminator(builds, archetypes) {
  const allTalentKeys = new Set();
  for (const b of builds) {
    if (b.talents) {
      for (const key of Object.keys(b.talents)) allTalentKeys.add(key);
    }
  }

  for (const talent of allTalentKeys) {
    const withTalent = builds.filter((b) => b.talents?.[talent]);
    const withoutTalent = builds.filter((b) => !b.talents?.[talent]);

    if (withTalent.length > 0 && withoutTalent.length > 0) {
      const withAvgDelta =
        withTalent.reduce((s, b) => s + b.delta, 0) / withTalent.length;
      const withoutAvgDelta =
        withoutTalent.reduce((s, b) => s + b.delta, 0) / withoutTalent.length;

      if (Math.abs(withAvgDelta - withoutAvgDelta) > 50) {
        return {
          talent,
          expression: `talent.${talent}.enabled`,
          withDelta: withAvgDelta,
          withoutDelta: withoutAvgDelta,
        };
      }
    }
  }

  const heroGroups = {};
  for (const b of builds) {
    heroGroups[b.heroTree] = heroGroups[b.heroTree] || [];
    heroGroups[b.heroTree].push(b);
  }

  const heroKeys = Object.keys(heroGroups);
  if (heroKeys.length === 2) {
    const [a, b] = heroKeys;
    const avgA =
      heroGroups[a].reduce((s, x) => s + x.delta, 0) / heroGroups[a].length;
    const avgB =
      heroGroups[b].reduce((s, x) => s + x.delta, 0) / heroGroups[b].length;
    if (Math.abs(avgA - avgB) > 50) {
      const better = avgA > avgB ? a : b;
      return {
        talent: null,
        expression: `hero_tree.${better}`,
        heroTree: better,
        withDelta: Math.max(avgA, avgB),
        withoutDelta: Math.min(avgA, avgB),
      };
    }
  }

  const apexGroups = {};
  for (const b of builds) {
    const rank = b.apexRank ?? 0;
    apexGroups[rank] = apexGroups[rank] || [];
    apexGroups[rank].push(b);
  }

  const apexKeys = Object.keys(apexGroups).map(Number).sort();
  if (apexKeys.length >= 2) {
    const threshold = Math.floor(
      (Math.max(...apexKeys) + Math.min(...apexKeys)) / 2,
    );
    const highApex = builds.filter((b) => (b.apexRank ?? 0) > threshold);
    const lowApex = builds.filter((b) => (b.apexRank ?? 0) <= threshold);
    if (highApex.length > 0 && lowApex.length > 0) {
      const highAvg =
        highApex.reduce((s, b) => s + b.delta, 0) / highApex.length;
      const lowAvg = lowApex.reduce((s, b) => s + b.delta, 0) / lowApex.length;
      if (Math.abs(highAvg - lowAvg) > 50) {
        return {
          talent: null,
          expression: `apex.${threshold + 1}`,
          apexThreshold: threshold + 1,
          withDelta: highAvg,
          withoutDelta: lowAvg,
        };
      }
    }
  }

  return null;
}

export function compareResourceFlows(patternsByBuild) {
  const metrics = {};
  const buildNames = Object.keys(patternsByBuild);

  for (const buildName of buildNames) {
    const rf = patternsByBuild[buildName]?.resourceFlow;
    if (!rf) continue;

    for (const [resource, data] of Object.entries(rf)) {
      if (resource === "gcds") continue;
      if (!metrics[resource]) metrics[resource] = {};
      for (const [metric, value] of Object.entries(data)) {
        if (typeof value !== "number") continue;
        if (!metrics[resource][metric]) metrics[resource][metric] = [];
        metrics[resource][metric].push({ build: buildName, value });
      }
    }
  }

  const outliers = [];
  for (const [resource, resourceMetrics] of Object.entries(metrics)) {
    for (const [metric, values] of Object.entries(resourceMetrics)) {
      if (values.length < 3) continue;
      const mean = values.reduce((s, v) => s + v.value, 0) / values.length;
      const std = Math.sqrt(
        values.reduce((s, v) => s + Math.pow(v.value - mean, 2), 0) /
          values.length,
      );
      if (std === 0) continue;

      for (const v of values) {
        const z = Math.abs(v.value - mean) / std;
        if (z > 1.5) {
          outliers.push({
            build: v.build,
            resource,
            metric,
            value: v.value,
            mean,
            zScore: z,
          });
        }
      }
    }
  }

  return { metrics, outliers };
}

export function crossArchetypeSynthesize(patternsByBuild, divergencesByBuild) {
  return {
    patterns: synthesizePatterns(patternsByBuild, divergencesByBuild),
    resourceComparison: compareResourceFlows(patternsByBuild),
    metadata: {
      buildCount: Object.keys(patternsByBuild).length,
      timestamp: new Date().toISOString(),
    },
  };
}
