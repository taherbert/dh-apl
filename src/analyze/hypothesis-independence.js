import { parse, getActionLists } from "../apl/parser.js";
import { getSpecAdapter } from "../engine/startup.js";

const MOVE_TYPES = new Set(["move", "reorder"]);

const NULL_DESCRIPTOR = {
  list: null,
  ability: null,
  type: null,
  variableName: null,
  affinity: "shared",
};

// Group hypotheses into independent sets safe for parallel testing.
// Each inner array contains mutually independent hypotheses.
export function groupIndependent(hypotheses, aplText) {
  const sections = parse(aplText);
  const actionLists = getActionLists(sections);
  const heroTrees = getSpecAdapter().getSpecConfig().heroTrees;

  const variableDeps = buildVariableDependencyMap(actionLists);
  const affinityMap = buildAffinityMap(actionLists, heroTrees);

  const descriptors = hypotheses.map(function (h) {
    return extractMutationDescriptor(h, affinityMap);
  });
  const conflicts = buildConflictGraph(descriptors, variableDeps);

  return greedyPartition(hypotheses, conflicts);
}

// Build a map of which variables each action list defines vs reads,
// used to detect cross-list dependency conflicts.
function buildVariableDependencyMap(actionLists) {
  const defined = new Map();
  const read = new Map();

  for (const list of actionLists) {
    const defSet = new Set();
    const readSet = new Set();

    for (const entry of list.entries) {
      if (entry.type === "Variable") {
        const name = entry.modifiers.get("name");
        if (name) defSet.add(name);
        const value = entry.modifiers.get("value") || "";
        for (const ref of extractVariableReferences(value)) {
          readSet.add(ref);
        }
      }

      const condition = entry.modifiers?.get("if") || "";
      for (const ref of extractVariableReferences(condition)) {
        readSet.add(ref);
      }
    }

    defined.set(list.name, defSet);
    read.set(list.name, readSet);
  }

  return { defined, read };
}

function extractVariableReferences(expr) {
  const refs = new Set();
  for (const m of expr.matchAll(/variable\.(\w+)/g)) {
    refs.add(m[1]);
  }
  return refs;
}

// Classify an action list's hero tree affinity based on its name.
function classifyListAffinity(listName, heroTrees) {
  for (const [treeKey, tree] of Object.entries(heroTrees)) {
    const branch = tree.aplBranch;
    if (!branch) continue;
    if (listName === branch || listName.startsWith(`${branch}_`)) {
      return treeKey;
    }
  }
  return "shared";
}

function buildAffinityMap(actionLists, heroTrees) {
  const map = new Map();
  for (const list of actionLists) {
    map.set(list.name, classifyListAffinity(list.name, heroTrees));
  }
  return map;
}

// Extract a mutation descriptor from a hypothesis.
// Falls back to conservative "shared" affinity when no mutation metadata exists.
function extractMutationDescriptor(hypothesis, affinityMap) {
  const mutation =
    hypothesis.mutation ||
    hypothesis.aplMutation ||
    hypothesis.metadata?.mutation ||
    null;

  if (!mutation) return NULL_DESCRIPTOR;

  const list = mutation.list || mutation.targetList || null;
  const ability = mutation.ability || mutation.targetAbility || null;
  const type = mutation.op || mutation.type || null;
  const variableName = mutation.variableName || mutation.variable || null;
  const affinity = list ? affinityMap.get(list) || "shared" : "shared";

  return { list, ability, type, variableName, affinity };
}

function buildConflictGraph(descriptors, variableDeps) {
  const conflicts = new Map();
  for (let i = 0; i < descriptors.length; i++) {
    conflicts.set(i, new Set());
  }

  for (let i = 0; i < descriptors.length; i++) {
    for (let j = i + 1; j < descriptors.length; j++) {
      if (hasConflict(descriptors[i], descriptors[j], variableDeps)) {
        conflicts.get(i).add(j);
        conflicts.get(j).add(i);
      }
    }
  }

  return conflicts;
}

// Two descriptors conflict when they could interfere if applied simultaneously.
function hasConflict(a, b, variableDeps) {
  // Shared-affinity mutations conflict with everything
  if (a.affinity === "shared" || b.affinity === "shared") return true;

  // Different hero trees are mutually exclusive branches — never conflict
  if (a.affinity !== b.affinity) return false;

  // Same tree, same list — check for overlapping targets
  if (a.list && a.list === b.list) {
    if (a.ability && a.ability === b.ability) return true;
    if (MOVE_TYPES.has(a.type) || MOVE_TYPES.has(b.type)) return true;
  }

  // Cross-list variable dependency: one defines a variable the other reads
  if (a.variableName && b.list) {
    const reads = variableDeps.read.get(b.list);
    if (reads?.has(a.variableName)) return true;
  }
  if (b.variableName && a.list) {
    const reads = variableDeps.read.get(a.list);
    if (reads?.has(b.variableName)) return true;
  }

  return false;
}

// Greedy graph-coloring partition: assign each hypothesis (priority-first)
// to the first group with no conflicting members.
function greedyPartition(hypotheses, conflicts) {
  const indices = hypotheses.map(function (_, i) {
    return i;
  });
  indices.sort(function (a, b) {
    return (hypotheses[b].priority ?? 5) - (hypotheses[a].priority ?? 5);
  });

  const groups = [];

  for (const idx of indices) {
    const myConflicts = conflicts.get(idx);
    const target = groups.find(function (g) {
      for (const member of g) {
        if (myConflicts.has(member)) return false;
      }
      return true;
    });

    if (target) {
      target.add(idx);
    } else {
      groups.push(new Set([idx]));
    }
  }

  return groups.map(function (indexSet) {
    return [...indexSet]
      .sort(function (a, b) {
        return a - b;
      })
      .map(function (i) {
        return hypotheses[i];
      });
  });
}
