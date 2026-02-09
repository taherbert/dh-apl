// Theory lifecycle management.
// Theories are high-level mechanical insights with causal reasoning.
// They persist across sessions and drive hypothesis generation.

import {
  addTheory as dbAddTheory,
  updateTheory as dbUpdateTheory,
  getTheory as dbGetTheory,
  getTheories as dbGetTheories,
  getTheoryChain,
  getHypotheses,
  getIterations,
} from "../util/db.js";
import { getSpecName } from "../engine/paths.js";

export function createTheory({
  title,
  reasoning,
  category,
  evidence,
  tags,
  confidence,
}) {
  return dbAddTheory({
    spec: getSpecName(),
    title,
    reasoning,
    category: category || null,
    evidence: evidence || null,
    tags: tags || null,
    confidence: confidence ?? 0.5,
  });
}

export function updateTheoryConfidence(id, newConfidence, reason) {
  const theory = dbGetTheory(id);
  if (!theory) throw new Error(`Theory ${id} not found`);

  const existingEvidence = theory.evidence || [];
  const updatedEvidence = [
    ...existingEvidence,
    {
      type: "confidence_update",
      from: theory.confidence,
      to: newConfidence,
      reason,
      at: new Date().toISOString(),
    },
  ];

  dbUpdateTheory(id, { confidence: newConfidence, evidence: updatedEvidence });
}

export function validateTheory(id, iterationId) {
  dbUpdateTheory(id, {
    status: "validated",
    confidence: Math.min(1.0, (dbGetTheory(id)?.confidence || 0.5) + 0.2),
  });

  const theory = dbGetTheory(id);
  const existingEvidence = theory.evidence || [];
  dbUpdateTheory(id, {
    evidence: [
      ...existingEvidence,
      { type: "validated", iterationId, at: new Date().toISOString() },
    ],
  });
}

export function refuteTheory(id, reason) {
  dbUpdateTheory(id, { status: "refuted", confidence: 0.0 });

  const theory = dbGetTheory(id);
  const existingEvidence = theory.evidence || [];
  dbUpdateTheory(id, {
    evidence: [
      ...existingEvidence,
      { type: "refuted", reason, at: new Date().toISOString() },
    ],
  });
}

export function reviseTheory(id, { newReasoning, newEvidence }) {
  const parent = dbGetTheory(id);
  if (!parent) throw new Error(`Theory ${id} not found`);

  // Supersede parent
  dbUpdateTheory(id, { status: "superseded" });

  // Create child theory
  return dbAddTheory({
    spec: parent.spec,
    title: parent.title,
    reasoning: newReasoning || parent.reasoning,
    category: parent.category,
    evidence: newEvidence || parent.evidence,
    tags: parent.tags,
    confidence: parent.confidence,
    parentId: id,
  });
}

export function getActiveTheories() {
  return dbGetTheories({ status: "active" });
}

export function getTheoryWithHypotheses(id) {
  const theory = dbGetTheory(id);
  if (!theory) return null;

  const hypotheses = getHypotheses({ theoryId: id, limit: 100 });
  const chain = getTheoryChain(id);

  // Get iterations for these hypotheses
  const iterations = [];
  for (const h of hypotheses) {
    if (h.status === "accepted" || h.status === "rejected") {
      const iters = getIterations({ limit: 100 }).filter(
        (i) => i.hypothesisId === h.id,
      );
      iterations.push(...iters);
    }
  }

  return { theory, chain, hypotheses, iterations };
}

export function getTheorySummary() {
  const active = dbGetTheories({ status: "active" });
  const validated = dbGetTheories({ status: "validated" });
  const refuted = dbGetTheories({ status: "refuted" });
  const superseded = dbGetTheories({ status: "superseded" });

  return {
    active: active.length,
    validated: validated.length,
    refuted: refuted.length,
    superseded: superseded.length,
    theories: [...active, ...validated, ...refuted],
  };
}
