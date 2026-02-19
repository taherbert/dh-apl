// Converts divergence JSON output into DB hypotheses for the iteration pipeline.
//
// Reads all results/{spec}/divergences-*.json files, filters for dpgcd_delta > 100,
// groups by (optimal.ability, actual.ability) pair, and creates DB hypotheses
// for pairs that appear in ≥2 archetypes (cross-archetype validation).
//
// Usage: imported by iterate.js divergence-hypotheses subcommand

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../engine/paths.js";

// Load all divergence JSONs for a spec
export function loadAllDivergences(spec) {
  const dir = join(ROOT, "results", spec);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(
    (f) => f.startsWith("divergences-") && f.endsWith(".json"),
  );

  const allDivergences = [];
  for (const file of files) {
    const buildName = file.replace("divergences-", "").replace(".json", "");
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      for (const d of data.divergences || []) {
        allDivergences.push({ ...d, archetype: buildName });
      }
    } catch {
      // Skip malformed files
    }
  }
  return allDivergences;
}

const DELTA_THRESHOLD = 100;
const MIN_ARCHETYPES = 2;

// Convert divergence records into ranked hypothesis objects ready for DB insertion
export function buildDivergenceHypotheses(divergences, spec) {
  // Filter to high-delta divergences
  const significant = divergences.filter(
    (d) => d.dpgcd_delta >= DELTA_THRESHOLD,
  );

  // Group by (optimal, actual) ability pair
  const groups = new Map();
  for (const d of significant) {
    const key = `${d.optimal.ability}|${d.actual.ability}`;
    if (!groups.has(key)) {
      groups.set(key, {
        optAbility: d.optimal.ability,
        actAbility: d.actual.ability,
        archetypes: new Set(),
        maxDelta: 0,
        totalOccurrences: 0,
        bestFixHint: null,
        bestListName: null,
        allLowConfidence: true,
      });
    }
    const g = groups.get(key);
    g.archetypes.add(d.archetype);
    g.totalOccurrences += d.actual_occurrences || 1;
    if (d.confidence === "high") g.allLowConfidence = false;
    if (d.dpgcd_delta > g.maxDelta) {
      g.maxDelta = d.dpgcd_delta;
      g.bestFixHint = d.fix_hint || null;
      g.bestListName = d.actual?.apl_reason || null;
    }
  }

  // Filter to cross-archetype pairs and build hypothesis objects
  const hypotheses = [];
  for (const [, g] of groups) {
    if (g.archetypes.size < MIN_ARCHETYPES) continue;

    const archetypeList = [...g.archetypes].join(", ");
    const summary = `${g.optAbility} preferred over ${g.actAbility} (rollout Δ${g.maxDelta}, ${g.archetypes.size} archetypes)`;
    const implementation =
      g.bestFixHint ||
      `APL chose ${g.actAbility} when rollout prefers ${g.optAbility}`;

    // Priority scales with delta magnitude (normalized to 0-10 range, capped at 9)
    let priority = Math.min(9, Math.round((g.maxDelta / 200) * 5 + 4));

    // Demote priority when all divergences in the group are low-confidence
    // (3-GCD score disagrees with rollout — likely resource-hoarding bias)
    const allLowConfidence = g.allLowConfidence;
    if (allLowConfidence) {
      priority = Math.max(1, priority - 3);
    }

    hypotheses.push({
      spec,
      summary,
      implementation,
      category: "divergence",
      source: "divergence-analysis",
      archetype: archetypeList,
      priority,
      status: "pending",
      metadata: {
        optAbility: g.optAbility,
        actAbility: g.actAbility,
        archetypes: [...g.archetypes],
        maxDelta: g.maxDelta,
        totalOccurrences: g.totalOccurrences,
        confidence: allLowConfidence ? "low" : "high",
      },
    });
  }

  // Sort by priority desc, then delta desc
  hypotheses.sort(
    (a, b) =>
      b.priority - a.priority || b.metadata.maxDelta - a.metadata.maxDelta,
  );

  return hypotheses;
}
