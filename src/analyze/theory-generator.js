// Theory generator — converts cross-archetype synthesis and pattern analysis
// into ranked, classified theories with DB integration. Detects artifacts
// (opener-only, fight-end-only) and calibrates confidence against prior rejections.

import { getSpecAdapter } from "../engine/startup.js";
import {
  addTheory as createTheory,
  addHypothesis,
  getHypotheses,
} from "../util/db.js";

export function generateTheories(synthesis, patternsByBuild) {
  const specConfig = getSpecAdapter().getSpecConfig();
  const theories = [];

  theories.push(...theoriesFromUniversalPatterns(synthesis, specConfig));
  theories.push(...theoriesFromHeroSpecificPatterns(synthesis, specConfig));
  theories.push(...theoriesFromResourceAnalysis(patternsByBuild, specConfig));
  theories.push(...theoriesFromCooldownAnalysis(patternsByBuild, specConfig));

  for (const theory of theories) {
    theory.classification = classifyTheory(theory, synthesis);
    theory.confidence = calibrateConfidence(theory);
  }

  theories.sort((a, b) => b.confidence - a.confidence);
  return theories;
}

function theoriesFromUniversalPatterns(synthesis, specConfig) {
  const theories = [];
  const universal = (synthesis.patterns || []).filter(
    (p) => p.classification === "universal",
  );

  for (const pattern of universal) {
    theories.push({
      title: `Replace ${pattern.actualAbility} with ${pattern.optimalAbility} during ${pattern.phase}`,
      reasoning:
        `Across ${pattern.buildCount} archetypes, the optimal timeline consistently prefers ` +
        `${pattern.optimalAbility} over ${pattern.actualAbility} during ${pattern.phase} phase ` +
        `(avg delta: ${pattern.avgDelta.toFixed(0)}). This suggests a structural APL priority issue.`,
      category: "structural",
      evidence: pattern.builds.map((b) => ({
        type: "divergence",
        archetype: b.name,
        details: {
          delta: b.delta,
          heroTree: b.heroTree,
          apexRank: b.apexRank,
        },
      })),
      proposed_change: `Adjust ${pattern.actualAbility} priority or conditions in ${pattern.phase} to allow ${pattern.optimalAbility}`,
      expected_impact: `~${((pattern.avgDelta * pattern.buildCount) / 100).toFixed(1)}% DPS across all builds`,
      risk_assessment:
        pattern.phase === "opener"
          ? "Low risk — opener-only change"
          : "Medium — affects core rotation",
      pattern,
    });
  }

  return theories;
}

function theoriesFromHeroSpecificPatterns(synthesis, specConfig) {
  const theories = [];
  const heroSpecific = (synthesis.patterns || []).filter(
    (p) => p.classification === "hero_specific",
  );

  for (const pattern of heroSpecific) {
    const heroTree = pattern.heroTrees[0];
    const branch = specConfig.heroTrees?.[heroTree]?.aplBranch || heroTree;

    theories.push({
      title: `${heroTree}: ${pattern.optimalAbility} over ${pattern.actualAbility} in ${pattern.phase}`,
      reasoning:
        `In ${heroTree} builds only (${pattern.buildCount} archetypes), ` +
        `${pattern.optimalAbility} scores higher than ${pattern.actualAbility} during ${pattern.phase} ` +
        `(avg delta: ${pattern.avgDelta.toFixed(0)}). This is a hero-tree-specific optimization ` +
        `that should be gated to the ${branch} action list.`,
      category: "tactical",
      evidence: pattern.builds.map((b) => ({
        type: "divergence",
        archetype: b.name,
        details: { delta: b.delta, heroTree: b.heroTree },
      })),
      proposed_change: `In actions.${branch}: adjust ${pattern.actualAbility} condition or add ${pattern.optimalAbility} priority`,
      expected_impact: `~${(pattern.avgDelta / 100).toFixed(2)}% DPS for ${heroTree} builds`,
      risk_assessment: "Low — scoped to hero tree branch",
      pattern,
    });
  }

  return theories;
}

function theoriesFromResourceAnalysis(patternsByBuild, specConfig) {
  const theories = [];
  const resourceModels = specConfig.resourceModels || [];

  for (const model of resourceModels) {
    const name = model.name;
    const cap = model.cap;

    const capTimes = [];
    for (const [buildName, patterns] of Object.entries(patternsByBuild)) {
      const rf = patterns?.resourceFlow?.[name];
      if (rf)
        capTimes.push({
          build: buildName,
          capTimePct: rf.capTimePercent,
          overflows: rf.overflowEvents,
        });
    }

    if (capTimes.length === 0) continue;

    const avgCapTime =
      capTimes.reduce((s, c) => s + c.capTimePct, 0) / capTimes.length;
    const avgOverflows =
      capTimes.reduce((s, c) => s + c.overflows, 0) / capTimes.length;

    if (avgCapTime > 5) {
      theories.push({
        title: `${name} cap waste: ${avgCapTime.toFixed(1)}% time at cap`,
        reasoning:
          `Across ${capTimes.length} builds, ${name} spends ${avgCapTime.toFixed(1)}% of GCDs at cap ` +
          `(${avgOverflows.toFixed(0)} overflow events avg). ` +
          `Cap is ${cap}. This indicates the APL is either generating too aggressively ` +
          `or not spending ${name} quickly enough.`,
        category: "structural",
        evidence: capTimes.map((c) => ({
          type: "resource_flow",
          archetype: c.build,
          details: { capTimePct: c.capTimePct, overflows: c.overflows },
        })),
        proposed_change: `Lower ${name} spending threshold or add emergency spend at cap`,
        expected_impact: `+0.1-0.5% DPS from reduced ${name} waste`,
        risk_assessment: "Low — reduces waste without changing priority",
      });
    }

    if (avgOverflows > 10) {
      theories.push({
        title: `${name} overflow: ${avgOverflows.toFixed(0)} overflow events per fight`,
        reasoning:
          `Generators fire at or near ${name} cap ${avgOverflows.toFixed(0)} times per fight on average. ` +
          `Each overflow wastes generated ${name}. The APL should gate generators when near cap.`,
        category: "structural",
        evidence: capTimes.map((c) => ({
          type: "resource_flow",
          archetype: c.build,
          details: { overflows: c.overflows },
        })),
        proposed_change: `Gate ${name} generators with ${name}<${cap - 1} condition`,
        expected_impact: `+0.1-0.3% DPS from reduced waste`,
        risk_assessment: "Medium — may reduce filler efficiency",
      });
    }
  }

  return theories;
}

function theoriesFromCooldownAnalysis(patternsByBuild, specConfig) {
  const theories = [];
  const burstWindows = specConfig.burstWindows || [];

  for (const window of burstWindows) {
    const syncData = [];

    for (const [buildName, patterns] of Object.entries(patternsByBuild)) {
      const windowData = patterns?.cooldowns?.windows?.find(
        (w) => w.buff === window.buff,
      );
      if (!windowData) continue;

      for (const target of window.syncTargets || []) {
        const hits = windowData.syncUtilization?.[target] ?? 0;
        const total = windowData.totalCasts?.[target] ?? 0;
        if (total > 0) {
          syncData.push({
            build: buildName,
            target,
            hits,
            total,
            rate: hits / total,
          });
        }
      }
    }

    const byTarget = {};
    for (const d of syncData) {
      if (!byTarget[d.target]) byTarget[d.target] = [];
      byTarget[d.target].push(d);
    }

    for (const [target, data] of Object.entries(byTarget)) {
      const avgRate = data.reduce((s, d) => s + d.rate, 0) / data.length;
      if (avgRate < 0.7) {
        theories.push({
          title: `${target} misses ${window.buff} windows (${(avgRate * 100).toFixed(0)}% sync rate)`,
          reasoning:
            `${target} only fires during ${window.buff} ${(avgRate * 100).toFixed(0)}% of the time ` +
            `across ${data.length} builds. ${window.buff} provides +${(window.damageAmp * 100).toFixed(0)}% ` +
            `${window.school} damage amp. Improving sync would amplify ${target} damage.`,
          category: "tactical",
          evidence: data.map((d) => ({
            type: "cooldown_sync",
            archetype: d.build,
            details: { hits: d.hits, total: d.total, rate: d.rate },
          })),
          proposed_change: `Hold ${target} for ${window.buff} window with fallback at half CD`,
          expected_impact: `+${((1 - avgRate) * window.damageAmp * 100 * 0.3).toFixed(1)}% from improved sync`,
          risk_assessment: "Medium — holding CDs delays casts",
        });
      }
    }

    for (const [buildName, patterns] of Object.entries(patternsByBuild)) {
      const alignment = patterns?.cooldowns?.cdAlignment || [];
      for (const pair of alignment) {
        if (pair.avgDesyncSeconds > 10) {
          theories.push({
            title: `${pair.cdA} and ${pair.cdB} desync by ${pair.avgDesyncSeconds.toFixed(1)}s`,
            reasoning:
              `${pair.cdA} and ${pair.cdB} cast ${pair.avgDesyncSeconds.toFixed(1)}s apart on average. ` +
              `If both provide damage amps, aligning them for multiplicative stacking would be beneficial.`,
            category: "tactical",
            evidence: [
              { type: "cd_alignment", archetype: buildName, details: pair },
            ],
            proposed_change: `Hold ${pair.cdA} or ${pair.cdB} to align windows`,
            expected_impact:
              "Varies — depends on multiplicative stacking value",
            risk_assessment: "High — may cause CD drift",
          });
        }
      }
    }
  }

  return theories;
}

function classifyTheory(theory, synthesis) {
  const evidence = theory.evidence || [];

  const openerCount = evidence.filter(() => {
    return theory.pattern?.phase === "opener";
  }).length;
  if (openerCount > evidence.length * 0.8) return "artifact";

  const fightEndCount = evidence.filter(() => {
    return theory.pattern?.phase === "fightEnd";
  }).length;
  if (fightEndCount > evidence.length * 0.8) return "artifact";

  return theory.category || "structural";
}

function calibrateConfidence(theory) {
  const evidence = theory.evidence || [];
  let confidence = 0.5;

  if (evidence.length >= 3 && (theory.pattern?.avgDelta ?? 0) > 200) {
    confidence = 0.85;
  } else if (evidence.length >= 2) {
    confidence = 0.6;
  }

  if (theory.classification === "artifact")
    confidence = Math.min(confidence, 0.15);

  try {
    const existingHyps = getHypotheses({ status: "rejected", limit: 100 });
    const similar = existingHyps.find(
      (h) =>
        h.summary?.includes(theory.pattern?.optimalAbility) &&
        h.summary?.includes(theory.pattern?.actualAbility),
    );
    if (similar) {
      confidence *= 0.5;
      theory.priorRejection = {
        id: similar.id,
        reason: similar.rejection_reason,
      };
    }
  } catch {
    // DB not available
  }

  return Math.round(confidence * 100) / 100;
}

export function persistTheories(theories) {
  const persisted = [];

  for (const theory of theories) {
    if (theory.confidence < 0.2) continue;

    try {
      const theoryId = createTheory({
        title: theory.title,
        reasoning: theory.reasoning,
        category: theory.category,
        confidence: theory.confidence,
        evidence: JSON.stringify(theory.evidence),
        proposed_change: theory.proposed_change,
        expected_impact: theory.expected_impact,
        risk_assessment: theory.risk_assessment,
        classification: theory.classification,
      });

      if (theory.confidence >= 0.4) {
        addHypothesis({
          source: "theory-generator",
          theoryId,
          summary: theory.proposed_change,
          category: theory.category,
          priority: Math.round(theory.confidence * 10),
          confidence: theory.confidence > 0.7 ? "high" : "medium",
        });
      }

      persisted.push({
        theoryId,
        title: theory.title,
        confidence: theory.confidence,
      });
    } catch (e) {
      persisted.push({
        title: theory.title,
        confidence: theory.confidence,
        error: e.message,
      });
    }
  }

  return persisted;
}

export function formatTheoryCandidates(theories) {
  return theories.map((t) => ({
    title: t.title,
    reasoning: t.reasoning,
    category: t.category,
    confidence: t.confidence,
    evidence: t.evidence,
    proposed_change: t.proposed_change,
    expected_impact: t.expected_impact,
    risk_assessment: t.risk_assessment,
    classification: t.classification,
  }));
}
