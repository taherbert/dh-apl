// Hypothesis Synthesizer — combines outputs from specialist analyses.
// Ranks hypotheses by cross-analyst consensus, identifies compound hypotheses,
// and resolves conflicts between analyst recommendations.
// Usage: node src/analyze/synthesizer.js [results-dir]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { initSpec } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { resultsDir } from "../engine/paths.js";

// Specialist output files
const SPECIALIST_FILES = {
  spell_data: "analysis_spell_data.json",
  talent: "analysis_talent.json",
  resource_flow: "analysis_resource_flow.json",
  state_machine: "analysis_state_machine.json",
};

// --- Specialist Output Loading ---

export function loadSpecialistOutputs(dir = resultsDir()) {
  const outputs = {};

  for (const [specialist, filename] of Object.entries(SPECIALIST_FILES)) {
    const filepath = join(dir, filename);
    if (existsSync(filepath)) {
      try {
        outputs[specialist] = JSON.parse(readFileSync(filepath, "utf-8"));
      } catch (e) {
        console.error(`Failed to load ${specialist} output: ${e.message}`);
        outputs[specialist] = null;
      }
    } else {
      outputs[specialist] = null;
    }
  }

  return outputs;
}

export function saveSpecialistOutput(specialist, data, dir = resultsDir()) {
  const filename = SPECIALIST_FILES[specialist];
  if (!filename) {
    throw new Error(`Unknown specialist: ${specialist}`);
  }

  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

// --- Hypothesis Synthesis ---

export function synthesizeHypotheses(specialistOutputs, options = {}) {
  const { minConsensus = 1, maxHypotheses = 50 } = options;

  const allHypotheses = [];
  const consensusMap = new Map();

  // Gather hypotheses from all specialists
  for (const [specialist, output] of Object.entries(specialistOutputs)) {
    if (!output?.hypotheses) continue;

    for (const h of output.hypotheses) {
      const normalizedId = normalizeHypothesisId(h);

      if (consensusMap.has(normalizedId)) {
        // Increment consensus count
        const existing = consensusMap.get(normalizedId);
        existing.specialists.push(specialist);
        existing.consensusCount++;
        // Average priorities
        existing.aggregatePriority =
          (existing.aggregatePriority * (existing.consensusCount - 1) +
            (h.priority || 0)) /
          existing.consensusCount;
        // Merge proposed changes
        if (h.proposedChanges) {
          existing.proposedChanges = mergeProposedChanges(
            existing.proposedChanges,
            h.proposedChanges,
          );
        }
      } else {
        consensusMap.set(normalizedId, {
          ...h,
          normalizedId,
          specialists: [specialist],
          consensusCount: 1,
          aggregatePriority: h.priority || 0,
        });
      }
    }
  }

  // Convert to array and filter by minimum consensus
  for (const h of consensusMap.values()) {
    if (h.consensusCount >= minConsensus) {
      allHypotheses.push(h);
    }
  }

  // Sort by consensus count (primary), then by aggregate priority (secondary)
  allHypotheses.sort((a, b) => {
    if (b.consensusCount !== a.consensusCount) {
      return b.consensusCount - a.consensusCount;
    }
    return b.aggregatePriority - a.aggregatePriority;
  });

  return allHypotheses.slice(0, maxHypotheses);
}

function normalizeHypothesisId(h) {
  // Create a stable ID from hypothesis properties
  const id =
    h.id ||
    `${h.category || "unknown"}_${h.target || h.ability || "general"}_${(h.systemicIssue || h.hypothesis || h.summary || "").slice(0, 50)}`;
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_");
}

function mergeProposedChanges(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = [...existing];
  const existingTypes = new Set(existing.map((c) => `${c.type}_${c.ability}`));

  for (const change of incoming) {
    const key = `${change.type}_${change.ability}`;
    if (!existingTypes.has(key)) {
      merged.push(change);
    }
  }

  return merged;
}

// --- Compound Hypothesis Detection ---

export function identifyCompoundHypotheses(hypotheses) {
  const compound = [];
  const simple = [];

  for (const h of hypotheses) {
    const isCompound =
      (h.proposedChanges?.length || 0) > 1 ||
      h.category?.includes("MULTI_PART") ||
      h.dependencies?.length > 0 ||
      h.consensusCount >= 3;

    if (isCompound) {
      compound.push({
        ...h,
        compoundReason: determineCompoundReason(h),
      });
    } else {
      simple.push(h);
    }
  }

  return { compound, simple };
}

function determineCompoundReason(h) {
  const reasons = [];

  if ((h.proposedChanges?.length || 0) > 1) {
    reasons.push(`requires ${h.proposedChanges.length} APL mutations`);
  }
  if (h.dependencies?.length > 0) {
    reasons.push(`depends on ${h.dependencies.length} other hypotheses`);
  }
  if (h.consensusCount >= 3) {
    reasons.push(`supported by ${h.consensusCount} specialists`);
  }
  if (h.category?.includes("MULTI_PART")) {
    reasons.push("explicitly marked as multi-part change");
  }

  return reasons.join("; ");
}

// --- Conflict Detection and Resolution ---

export function detectConflicts(hypotheses) {
  const conflicts = [];
  const byTarget = new Map();

  // Group hypotheses by target ability
  for (const h of hypotheses) {
    const targets = extractTargets(h);
    for (const target of targets) {
      if (!byTarget.has(target)) {
        byTarget.set(target, []);
      }
      byTarget.get(target).push(h);
    }
  }

  // Find conflicts (multiple hypotheses affecting same target with contradictory actions)
  for (const [target, targetHypotheses] of byTarget) {
    if (targetHypotheses.length < 2) continue;

    // Check for contradictions
    const moveUp = targetHypotheses.filter((h) =>
      h.proposedChanges?.some((c) => c.type === "move_up"),
    );
    const moveDown = targetHypotheses.filter((h) =>
      h.proposedChanges?.some((c) => c.type === "move_down"),
    );

    if (moveUp.length > 0 && moveDown.length > 0) {
      conflicts.push({
        type: "contradictory_movement",
        target,
        hypotheses: [moveUp[0], moveDown[0]],
        description: `Conflict: one hypothesis moves ${target} up, another moves it down`,
        resolution: "Choose based on higher consensus/priority",
      });
    }

    // Check for condition conflicts (adding and removing same condition)
    const addCond = targetHypotheses.filter((h) =>
      h.proposedChanges?.some((c) => c.type === "add_condition"),
    );
    const removeCond = targetHypotheses.filter((h) =>
      h.proposedChanges?.some((c) => c.type === "remove_condition"),
    );

    if (addCond.length > 0 && removeCond.length > 0) {
      // Check if they target the same buff/condition
      const addBuff = addCond[0].proposedChanges?.find(
        (c) => c.type === "add_condition",
      )?.condition;
      const removeBuff = removeCond[0].proposedChanges?.find(
        (c) => c.type === "remove_condition",
      )?.targetBuff;

      if (addBuff?.includes(removeBuff) || removeBuff?.includes(addBuff)) {
        conflicts.push({
          type: "contradictory_condition",
          target,
          hypotheses: [addCond[0], removeCond[0]],
          description: `Conflict: adding and removing similar condition on ${target}`,
          resolution: "Choose based on mechanism strength",
        });
      }
    }
  }

  return conflicts;
}

function extractTargets(h) {
  const targets = new Set();

  if (h.target) targets.add(h.target);

  for (const change of h.proposedChanges || []) {
    if (change.ability) targets.add(change.ability);
    if (change.before) targets.add(change.before);
    if (change.after) targets.add(change.after);
  }

  return Array.from(targets);
}

export function resolveConflicts(hypotheses, conflicts) {
  if (conflicts.length === 0) return hypotheses;

  const resolved = [...hypotheses];
  const toRemove = new Set();

  for (const conflict of conflicts) {
    // Simple resolution: keep the hypothesis with higher consensus/priority
    const [h1, h2] = conflict.hypotheses;

    const score1 = (h1.consensusCount || 1) * 10 + (h1.aggregatePriority || 0);
    const score2 = (h2.consensusCount || 1) * 10 + (h2.aggregatePriority || 0);

    if (score1 >= score2) {
      toRemove.add(h2.normalizedId || h2.id);
    } else {
      toRemove.add(h1.normalizedId || h1.id);
    }
  }

  return resolved.filter((h) => !toRemove.has(h.normalizedId || h.id));
}

// --- Archetype-Specific Grouping ---

export function groupByArchetype(hypotheses) {
  const groups = {
    universal: [],
    aldrachi_reaver: [],
    annihilator: [],
  };

  for (const h of hypotheses) {
    if (h.archetypeSpecific) {
      const tree =
        h.archetype?.heroTree ||
        (h.proposedChanges?.[0]?.list === "anni"
          ? "annihilator"
          : "aldrachi_reaver");
      groups[tree]?.push(h);
    } else {
      groups.universal.push(h);
    }
  }

  return groups;
}

// --- Synthesis Report Generation ---

export function generateSynthesisReport(synthesisResult) {
  const { hypotheses, compound, simple, conflicts, byArchetype } =
    synthesisResult;

  const lines = [];
  lines.push("# Hypothesis Synthesis Report\n");
  lines.push(`Generated: ${new Date().toISOString()}\n`);

  // Summary
  lines.push("## Summary\n");
  lines.push(`- Total hypotheses: ${hypotheses.length}`);
  lines.push(`- Compound hypotheses: ${compound.length}`);
  lines.push(`- Simple hypotheses: ${simple.length}`);
  lines.push(`- Conflicts detected: ${conflicts.length}`);
  lines.push("");

  // Consensus leaders
  const multiConsensus = hypotheses.filter((h) => h.consensusCount >= 2);
  if (multiConsensus.length > 0) {
    lines.push("## High-Consensus Hypotheses\n");
    lines.push("Hypotheses supported by multiple specialists:\n");
    for (const h of multiConsensus.slice(0, 10)) {
      lines.push(
        `- **${h.id || h.normalizedId}** (${h.consensusCount} specialists: ${h.specialists.join(", ")})`,
      );
      lines.push(`  - ${h.systemicIssue || h.hypothesis}`);
      lines.push(`  - Expected: ${h.expectedImpact}`);
    }
    lines.push("");
  }

  // Compound hypotheses
  if (compound.length > 0) {
    lines.push("## Compound Hypotheses\n");
    lines.push("These require multiple APL changes or have dependencies:\n");
    for (const h of compound.slice(0, 10)) {
      lines.push(`- **${h.id || h.normalizedId}**`);
      lines.push(`  - Reason: ${h.compoundReason}`);
      lines.push(`  - Changes: ${h.proposedChanges?.length || 0} mutations`);
    }
    lines.push("");
  }

  // Conflicts
  if (conflicts.length > 0) {
    lines.push("## Conflicts\n");
    for (const c of conflicts) {
      lines.push(`- **${c.type}** on ${c.target}`);
      lines.push(`  - ${c.description}`);
      lines.push(`  - Resolution: ${c.resolution}`);
    }
    lines.push("");
  }

  // By archetype
  lines.push("## Hypotheses by Archetype\n");
  for (const [archetype, hyps] of Object.entries(byArchetype)) {
    lines.push(`### ${archetype} (${hyps.length})\n`);
    for (const h of hyps.slice(0, 5)) {
      lines.push(`- ${h.id || h.systemicIssue?.slice(0, 60) || h.hypothesis}`);
    }
    if (hyps.length > 5) {
      lines.push(`- ... and ${hyps.length - 5} more`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Main Synthesis Function ---

export function synthesize(specialistOutputs, options = {}) {
  // Synthesize hypotheses
  const hypotheses = synthesizeHypotheses(specialistOutputs, options);

  // Identify compound vs simple
  const { compound, simple } = identifyCompoundHypotheses(hypotheses);

  // Detect and resolve conflicts
  const conflicts = detectConflicts(hypotheses);
  const resolved = resolveConflicts(hypotheses, conflicts);

  // Group by archetype
  const byArchetype = groupByArchetype(resolved);

  const result = {
    hypotheses: resolved,
    compound,
    simple,
    conflicts,
    byArchetype,
    metadata: {
      timestamp: new Date().toISOString(),
      specialists: Object.keys(specialistOutputs).filter(
        (k) => specialistOutputs[k] !== null,
      ),
      totalRaw: hypotheses.length,
      afterConflictResolution: resolved.length,
    },
  };

  // Write synthesis.json for session resume capability
  writeSynthesisJson(result, options.aplHash);

  return result;
}

// Write synthesis.json for session resume
function writeSynthesisJson(result, aplHash) {
  const synthesisPath = join(resultsDir(), "synthesis.json");
  const synthesis = {
    _schema: "synthesis-v1",
    timestamp: result.metadata.timestamp,
    aplHash: aplHash || "unknown",
    specialists: result.metadata.specialists,
    hypotheses: result.hypotheses.map((h) => ({
      normalizedId: h.normalizedId || h.id,
      priority: h.aggregatePriority || h.priority || 0,
      consensusCount: h.consensusCount || 1,
      specialists: h.specialists || [],
      tested: false,
    })),
  };
  writeFileSync(synthesisPath, JSON.stringify(synthesis, null, 2));
}

// --- CLI Entry Point ---

if (import.meta.url === `file://${process.argv[1]}`) {
  await initSpec(parseSpecArg());
  const dir = process.argv[2] || resultsDir();

  console.log("Loading specialist outputs from", dir, "...");
  const outputs = loadSpecialistOutputs(dir);

  const loadedCount = Object.values(outputs).filter((o) => o !== null).length;
  console.log(
    `Loaded ${loadedCount}/${Object.keys(SPECIALIST_FILES).length} specialist outputs`,
  );

  if (loadedCount === 0) {
    console.log("\nNo specialist outputs found. Run specialists first:");
    console.log("  - Spell data analyst");
    console.log("  - Talent interaction analyst");
    console.log("  - Resource flow analyst");
    console.log("  - State machine analyst");
    process.exit(1);
  }

  const result = synthesize(outputs);

  console.log("\n" + "=".repeat(60));
  console.log("Synthesis Results");
  console.log("=".repeat(60));
  console.log(`Total hypotheses: ${result.hypotheses.length}`);
  console.log(
    `Compound: ${result.compound.length}, Simple: ${result.simple.length}`,
  );
  console.log(`Conflicts: ${result.conflicts.length}`);

  if (result.hypotheses.length > 0) {
    console.log("\nTop 5 hypotheses:");
    for (const h of result.hypotheses.slice(0, 5)) {
      console.log(
        `\n[${h.consensusCount} specialists] ${h.id || h.normalizedId}`,
      );
      console.log(`  ${h.systemicIssue || h.hypothesis}`);
      console.log(`  Priority: ${(h.aggregatePriority || 0).toFixed(1)}`);
    }
  }

  // Write report
  const report = generateSynthesisReport(result);
  const reportPath = join(dir, "synthesis_report.md");
  writeFileSync(reportPath, report);
  console.log(`\nReport written to ${reportPath}`);

  // Write synthesized hypotheses
  const outputPath = join(dir, "synthesized_hypotheses.json");
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`Hypotheses written to ${outputPath}`);
}
