// Hypothesis independence detection for parallel testing.
// Two hypotheses are independent if their mutations target different
// APL regions and don't share variable dependencies.

import { readFileSync } from "node:fs";
import { parse } from "../apl/parser.js";

export function areIndependent(hypA, hypB) {
  const mutA = hypA.mutation || hypA.aplMutation;
  const mutB = hypB.mutation || hypB.aplMutation;

  if (!mutA || !mutB) return false;

  // Different action lists = independent
  if (mutA.list && mutB.list && mutA.list !== mutB.list) {
    // Check variable dependencies across lists
    const varsA = extractVariableRefs(mutA);
    const varsB = extractVariableRefs(mutB);
    const overlap = varsA.filter((v) => varsB.includes(v));
    return overlap.length === 0;
  }

  // Different target abilities within same list = independent
  if (mutA.target && mutB.target && mutA.target !== mutB.target) {
    // Still check variable dependencies
    const varsA = extractVariableRefs(mutA);
    const varsB = extractVariableRefs(mutB);
    const overlap = varsA.filter((v) => varsB.includes(v));
    return overlap.length === 0;
  }

  return false;
}

function extractVariableRefs(mutation) {
  const vars = new Set();
  const text = JSON.stringify(mutation);

  // Match variable.X references in conditions
  const varRefs = text.match(/variable\.(\w+)/g) || [];
  for (const ref of varRefs) {
    vars.add(ref.replace("variable.", ""));
  }

  // If mutation sets a variable, include it
  if (mutation.op === "set_variable" && mutation.name) {
    vars.add(mutation.name);
  }

  return [...vars];
}

export function groupIndependent(hypotheses) {
  const groups = [];
  const used = new Set();

  for (let i = 0; i < hypotheses.length; i++) {
    if (used.has(i)) continue;

    const group = [hypotheses[i]];
    used.add(i);

    for (let j = i + 1; j < hypotheses.length; j++) {
      if (used.has(j)) continue;

      // Check independence against ALL members of the group
      const independentOfAll = group.every((member) =>
        areIndependent(member, hypotheses[j]),
      );

      if (independentOfAll && group.length < 3) {
        group.push(hypotheses[j]);
        used.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}
