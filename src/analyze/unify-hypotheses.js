// Unified hypothesis pipeline — merges all 6 hypothesis sources into a
// consensus-ranked, mutation-enriched list ready for iterate.js generate.
//
// Pipeline:
//   1. Collect all hypotheses from DB (all sources already persisted)
//   2. Fingerprint each hypothesis (semantic identity matching)
//   3. Group by fingerprint
//   4. Per group: detect consensus, merge evidence, select best mutation
//   5. For groups without mutations: run mutation inference
//   6. Apply rejection memory (reduce priority for previously-rejected fingerprints)
//   7. Persist unified results back to DB

import {
  fingerprintHypothesis,
  fingerprintHypothesisStable,
  matchHypotheses,
} from "./hypothesis-fingerprint.js";
import { inferMutationWithReason } from "./infer-mutation.js";
import { getHypotheses, getDb, withTransaction } from "../util/db.js";
import { getSpecName } from "../engine/paths.js";

// Source priority for mutation selection (higher = preferred)
const SOURCE_MUTATION_PRIORITY = {
  strategic: 4,
  theorycraft: 3,
  synthesized: 2,
  inferred: 1,
  "divergence-analysis": 0,
  "theory-generator": 0,
};

function mutationPriority(source) {
  return SOURCE_MUTATION_PRIORITY[source] ?? 0;
}

// Merge fingerprint groups that represent the same semantic change across
// different naming conventions (swap: vs priority: namespaces).
// swap:A:over:B:phase ↔ priority:A:up:*:phase (moving A up = preferring A)
// swap:A:over:B:phase ↔ priority:B:down:*:phase (moving B down = same thing)
function mergeEquivalentGroups(groups) {
  // Build lookup from swap: groups keyed by (ability, phase)
  const swapByAbilityUp = new Map(); // "ability:phase" → swap fingerprint
  const swapByAbilityDown = new Map(); // "ability:phase" → swap fingerprint
  for (const fp of groups.keys()) {
    const m = fp.match(/^swap:([^:]+):over:([^:]+):(.+)$/);
    if (!m) continue;
    const [, opt, act, phase] = m;
    swapByAbilityUp.set(`${opt}:${phase}`, fp);
    swapByAbilityDown.set(`${act}:${phase}`, fp);
  }

  // For each priority: group, check if it matches a swap: group
  const toDelete = [];
  for (const [fp, members] of groups) {
    const m = fp.match(/^priority:([^:]+):(up|down):[^:]+:(.+)$/);
    if (!m) continue;
    const [, ability, dir, phase] = m;
    const key = `${ability}:${phase}`;
    const swapFp =
      dir === "up" ? swapByAbilityUp.get(key) : swapByAbilityDown.get(key);
    if (swapFp && groups.has(swapFp)) {
      groups.get(swapFp).push(...members);
      toDelete.push(fp);
    }
  }
  for (const fp of toDelete) {
    groups.delete(fp);
  }
  return groups;
}

// Unify all hypotheses from DB into consensus-ranked groups.
// Returns array of unified hypothesis objects, sorted by priority descending.
export function unifyHypotheses(aplText, spec) {
  const specName = spec || getSpecName();
  const db = getDb(specName);

  // Reset previously-merged hypotheses so re-runs are idempotent
  db.prepare(
    "UPDATE hypotheses SET status = 'pending' WHERE status = 'merged' AND spec = ?",
  ).run(specName);

  // 1. Load all hypotheses (pending + testing, not completed/rejected)
  const allHypotheses = getHypotheses({
    limit: 500,
    spec: specName,
  });

  const pending = allHypotheses.filter(
    (h) => h.status === "pending" || h.status === "testing",
  );

  if (pending.length === 0) return [];

  // 2. Load rejected hypotheses for rejection memory
  const rejected = allHypotheses.filter((h) => h.status === "rejected");
  const rejectedFingerprints = new Map();
  for (const h of rejected) {
    const fp = h.fingerprint || fingerprintHypothesis(h);
    rejectedFingerprints.set(fp, (rejectedFingerprints.get(fp) || 0) + 1);
  }

  // 3. Fingerprint and group pending hypotheses (stable: preserves stored fingerprints)
  const groups = matchHypotheses(pending, fingerprintHypothesisStable);

  // 3b. Merge equivalent groups across swap:/priority: namespaces
  mergeEquivalentGroups(groups);

  // 4. Build unified hypotheses from each group
  const unified = [];

  for (const [fingerprint, members] of groups) {
    const distinctSources = new Set(
      members.map((m) => m.source).filter(Boolean),
    );

    // Consensus count: distinct source count
    // Respect synthesizer's existing consensus as a starting point
    let consensusCount = distinctSources.size;
    for (const m of members) {
      if (m.consensus_count > 1) {
        consensusCount = Math.max(consensusCount, m.consensus_count);
      }
    }

    // Select best mutation: prefer sources with known-good mutations
    let bestMutation = null;
    let bestMutationSource = null;
    for (const m of members) {
      const mut = m.mutation;
      if (!mut) continue;
      const prio = mutationPriority(m.source);
      const currentPrio = mutationPriority(bestMutationSource);
      if (!bestMutation || prio > currentPrio) {
        bestMutation = mut;
        bestMutationSource = m.source;
      }
    }

    // If no mutation found, try inference on the highest-confidence member
    let inferenceReason = null;
    if (!bestMutation && aplText) {
      const sorted = [...members].sort(
        (a, b) => (b.priority || 0) - (a.priority || 0),
      );
      for (const m of sorted) {
        const { mutation: inferred, reason } = inferMutationWithReason(
          m,
          aplText,
        );
        if (inferred) {
          bestMutation = inferred;
          bestMutationSource = "inferred";
          inferenceReason = null;
          break;
        }
        // Keep the first reason encountered for diagnostics
        if (!inferenceReason) inferenceReason = reason;
      }
    }

    // Select representative hypothesis (highest priority member)
    const representative = members.reduce((best, m) =>
      (m.priority || 0) > (best.priority || 0) ? m : best,
    );

    // Priority: base × consensus boost (use base_priority to avoid compounding)
    const basePriority =
      representative.base_priority ?? representative.priority ?? 5.0;
    const consensusBoost = 1 + 0.25 * (consensusCount - 1);
    let adjustedPriority = basePriority * consensusBoost;

    // Rejection memory: reduce priority if matching fingerprints were rejected
    const rejectionCount = rejectedFingerprints.get(fingerprint) || 0;
    if (rejectionCount > 0) {
      adjustedPriority *= Math.max(0.3, 1 - 0.2 * rejectionCount);
    }

    // Confidence: max across group
    const maxConfidence = Math.max(...members.map((m) => m.confidence ?? 0.5));

    const group = {
      fingerprint,
      consensusCount,
      consensusSources: [...distinctSources],
      summary: representative.summary,
      category: representative.category,
      priority: Math.round(adjustedPriority * 100) / 100,
      confidence: maxConfidence,
      mutation: bestMutation,
      mutationSource: bestMutationSource,
      memberIds: members.map((m) => m.id),
      memberCount: members.length,
      representative,
      rejectionCount,
    };
    if (inferenceReason && !bestMutation) {
      group.fallthroughReason = inferenceReason;
    }
    unified.push(group);
  }

  // Sort by priority descending
  unified.sort((a, b) => b.priority - a.priority);

  return unified;
}

// Persist unified results back to DB: update consensus metadata on each hypothesis.
// The representative of each group gets the consensus info; other members get deduped.
export function persistUnified(unified, spec) {
  const specName = spec || getSpecName();
  const db = getDb(specName);

  let updated = 0;
  let mutationsAdded = 0;

  withTransaction(() => {
    for (const group of unified) {
      const repId = group.representative.id;

      // Update representative with consensus metadata
      // Write base_priority (pre-boost) alongside boosted priority to prevent compounding
      const repBasePriority =
        group.representative.base_priority ??
        group.representative.priority ??
        5.0;
      const updates = {
        consensus_count: group.consensusCount,
        consensus_sources: JSON.stringify(group.consensusSources),
        fingerprint: group.fingerprint,
        base_priority: repBasePriority,
        priority: group.priority,
      };

      // Add inferred mutation if representative lacked one
      if (group.mutation && !group.representative.mutation) {
        updates.mutation = JSON.stringify(group.mutation);
        mutationsAdded++;
      }

      const setClauses = Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(", ");
      const values = Object.values(updates);

      db.prepare(
        `UPDATE hypotheses SET ${setClauses} WHERE id = ? AND spec = ?`,
      ).run(...values, repId, specName);
      updated++;

      // Mark non-representative members as "merged" to avoid double-testing
      for (const memberId of group.memberIds) {
        if (memberId === repId) continue;
        db.prepare(
          `UPDATE hypotheses SET fingerprint = ?, consensus_count = 0, status = CASE WHEN status = 'pending' THEN 'merged' ELSE status END WHERE id = ? AND spec = ?`,
        ).run(group.fingerprint, memberId, specName);
      }
    }
  });

  return { updated, mutationsAdded, groups: unified.length };
}

// Summary stats for CLI output
export function summarizeUnified(unified) {
  const total = unified.reduce((sum, g) => sum + g.memberCount, 0);
  const withMutation = unified.filter((g) => g.mutation).length;
  const withConsensus = unified.filter((g) => g.consensusCount > 1).length;
  const withRejectionMemory = unified.filter(
    (g) => g.rejectionCount > 0,
  ).length;
  const inferredMutations = unified.filter(
    (g) => g.mutationSource === "inferred",
  ).length;

  // Aggregate fallthrough reasons from groups that failed mutation inference
  const fallthroughGroups = unified.filter((g) => g.fallthroughReason);
  const fallthroughByReason = new Map();
  for (const g of fallthroughGroups) {
    const key = g.fallthroughReason.startsWith("pattern matched")
      ? "pattern matched but validation failed"
      : g.fallthroughReason;
    fallthroughByReason.set(key, (fallthroughByReason.get(key) || 0) + 1);
  }

  return {
    totalHypotheses: total,
    uniqueGroups: unified.length,
    withMutation,
    mutationCoverage:
      unified.length > 0
        ? Math.round((withMutation / unified.length) * 100)
        : 0,
    withConsensus,
    withRejectionMemory,
    inferredMutations,
    inferenceFallthroughs: fallthroughGroups.length,
    fallthroughReasons: Object.fromEntries(fallthroughByReason),
  };
}
