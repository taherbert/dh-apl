// Post-iteration theory revision.
// After each accept/reject, updates the underlying theory's confidence
// and generates revision hypotheses when theories are underperforming.

import {
  getTheory,
  getHypotheses,
  getIterations,
  updateTheory,
} from "../util/db.js";
import {
  updateTheoryConfidence,
  refuteTheory,
  reviseTheory,
} from "./theory.js";

// Confidence deltas per iteration outcome
const ACCEPT_BOOST = 0.15;
const REJECT_PENALTY = 0.1;
const REFUTE_THRESHOLD = 0.2;
const REVISION_TRIGGER_REJECTIONS = 3;

export function reviseFromIteration(iterationId) {
  const iterations = getIterations({ limit: 1000 });
  const iteration = iterations.find((i) => i.id === iterationId);
  if (!iteration) return null;

  const hypothesisId = iteration.hypothesisId;
  if (!hypothesisId) return null;

  const hypotheses = getHypotheses({ limit: 1000 });
  const hypothesis = hypotheses.find((h) => h.id === hypothesisId);
  if (!hypothesis?.theoryId) return null;

  const theory = getTheory(hypothesis.theoryId);
  if (!theory || theory.status !== "active") return null;

  const result = { theoryId: theory.id, action: null, newConfidence: null };

  if (iteration.decision === "accepted") {
    const newConfidence = Math.min(1.0, theory.confidence + ACCEPT_BOOST);
    updateTheoryConfidence(
      theory.id,
      newConfidence,
      `Hypothesis accepted: ${hypothesis.summary}`,
    );
    result.action = "boosted";
    result.newConfidence = newConfidence;
  } else if (iteration.decision === "rejected") {
    const newConfidence = Math.max(0.0, theory.confidence - REJECT_PENALTY);
    updateTheoryConfidence(
      theory.id,
      newConfidence,
      `Hypothesis rejected: ${hypothesis.summary}`,
    );
    result.newConfidence = newConfidence;

    // Check if theory should be auto-refuted
    if (newConfidence < REFUTE_THRESHOLD) {
      refuteTheory(
        theory.id,
        `Confidence dropped below ${REFUTE_THRESHOLD} after ${hypothesis.summary} rejected`,
      );
      result.action = "refuted";
      return result;
    }

    // Check if too many hypotheses from this theory have been rejected
    const theoryHypotheses = hypotheses.filter(
      (h) =>
        h.theoryId === theory.id &&
        (h.status === "rejected" || h.status === "accepted"),
    );
    const rejected = theoryHypotheses.filter(
      (h) => h.status === "rejected",
    ).length;

    if (rejected >= REVISION_TRIGGER_REJECTIONS) {
      const accepted = theoryHypotheses.filter(
        (h) => h.status === "accepted",
      ).length;
      if (accepted === 0) {
        // All rejected, no accepts — flag for revision
        result.action = "needs_revision";
      } else {
        result.action = "weakened";
      }
    } else {
      result.action = "penalized";
    }
  }

  return result;
}
