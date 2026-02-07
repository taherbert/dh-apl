// Build validation: decode talent hashes or parse override strings and check
// point budgets (34/34/13) and gate requirements (8/20).
//
// Exports:
//   validateHash(hash) — validate a talent hash string
//   validateOverrides(overrides) — validate class_talents/spec_talents/hero_talents override strings
//   validateBuild(build) — dispatch to validateHash or validateOverrides

import { readFileSync } from "node:fs";
import { decode, loadFullNodeList } from "./talent-string.js";
import { SPEC_ID } from "../engine/startup.js";
import { dataFile } from "../engine/paths.js";

const BUDGETS = { class: 34, spec: 34, hero: 13 };

function loadRaidbots() {
  return JSON.parse(readFileSync(dataFile("raidbots-talents.json"), "utf8"));
}

// Build index sets from raidbots data + full node list for validation.
function buildIndices(data, fullNodes, specId) {
  const classNodeIds = new Set(data.classNodes.map((n) => n.id));
  const specNodeIds = new Set(data.specNodes.map((n) => n.id));
  const heroNodeIds = new Map();
  for (const [treeName, treeNodes] of Object.entries(data.heroSubtrees)) {
    for (const n of treeNodes) heroNodeIds.set(n.id, treeName);
  }
  const subTreeIds = new Set((data.subTreeNodes || []).map((n) => n.id));

  const freeNodeIds = new Set();
  const allDataNodes = [
    ...data.classNodes,
    ...data.specNodes,
    ...Object.values(data.heroSubtrees).flat(),
  ];
  for (const n of allDataNodes) {
    if (n.freeNode) freeNodeIds.add(n.id);
  }
  for (const n of fullNodes) {
    if (n.grantedForSpecs?.includes(specId)) freeNodeIds.add(n.id);
  }

  return { classNodeIds, specNodeIds, heroNodeIds, subTreeIds, freeNodeIds };
}

function countPoints(selections, nodeSet, freeNodeIds, subTreeIds) {
  let spent = 0;
  for (const [id, s] of selections) {
    if (!nodeSet.has(id)) continue;
    if (freeNodeIds.has(id)) continue;
    if (subTreeIds.has(id)) continue;
    spent += s.rank;
  }
  return spent;
}

function checkGates(selections, treeNodes, freeNodeIds, label) {
  const errors = [];
  const gates = [...new Set(treeNodes.map((n) => n.reqPoints || 0))]
    .filter((g) => g > 0)
    .sort((a, b) => a - b);

  for (const gate of gates) {
    let spentBelow = 0;
    for (const n of treeNodes) {
      if ((n.reqPoints || 0) >= gate) continue;
      const s = selections.get(n.id);
      if (!s) continue;
      if (freeNodeIds.has(n.id)) continue;
      spentBelow += s.rank;
    }
    if (spentBelow < gate) {
      errors.push(
        `${label} gate requires ${gate} points, only ${spentBelow} spent in prior sections`,
      );
    }
  }
  return errors;
}

// Detect hero tree from selections.
function detectHeroTree(selections, heroNodeIds) {
  const treeCounts = {};
  for (const [id] of selections) {
    const tree = heroNodeIds.get(id);
    if (tree) treeCounts[tree] = (treeCounts[tree] || 0) + 1;
  }
  const sorted = Object.entries(treeCounts).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : null;
}

// Validate a talent hash string.
// Returns { valid, errors[], details: { classSpent, specSpent, heroSpent, heroTree } }
export function validateHash(hash) {
  const errors = [];
  const fullNodes = loadFullNodeList();
  const data = loadRaidbots();

  let specId;
  let selections;
  try {
    const result = decode(hash, fullNodes);
    specId = result.specId;
    selections = result.selections;
  } catch (e) {
    return {
      valid: false,
      errors: [`Decode failed: ${e.message}`],
      details: null,
    };
  }

  const idx = buildIndices(data, fullNodes, specId);

  const classSpent = countPoints(
    selections,
    idx.classNodeIds,
    idx.freeNodeIds,
    idx.subTreeIds,
  );
  const specSpent = countPoints(
    selections,
    idx.specNodeIds,
    idx.freeNodeIds,
    idx.subTreeIds,
  );
  const heroSpent = countPoints(
    selections,
    new Set(idx.heroNodeIds.keys()),
    idx.freeNodeIds,
    idx.subTreeIds,
  );
  const heroTree = detectHeroTree(selections, idx.heroNodeIds);

  for (const [label, spent, budget] of [
    ["Class", classSpent, BUDGETS.class],
    ["Spec", specSpent, BUDGETS.spec],
    ["Hero", heroSpent, BUDGETS.hero],
  ]) {
    if (spent !== budget) {
      errors.push(`${label} tree: ${spent} points spent, expected ${budget}`);
    }
  }

  errors.push(
    ...checkGates(selections, data.classNodes, idx.freeNodeIds, "Class"),
  );
  errors.push(
    ...checkGates(selections, data.specNodes, idx.freeNodeIds, "Spec"),
  );

  return {
    valid: errors.length === 0,
    errors,
    details: { classSpent, specSpent, heroSpent, heroTree },
  };
}

// Normalize SimC talent name: "charred_flesh" → "charred_flesh" (lowercase with underscores)
export function normalizeSimcName(simcName) {
  return simcName
    .toLowerCase()
    .replace(/[' ]/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

// Validate override-based builds (class_talents/spec_talents/hero_talents strings).
// Override format: "name:rank/name:rank/..." where names are SimC snake_case.
export function validateOverrides(overrides) {
  const errors = [];
  const data = loadRaidbots();

  // Build name→node lookup for all trees
  const nodeBySimcName = new Map();

  function addNode(n, tree, heroTree = null) {
    const name = normalizeSimcName(n.name || n.entries?.[0]?.name || "");
    if (name) {
      const entry = { node: n, tree };
      if (heroTree) entry.heroTree = heroTree;
      nodeBySimcName.set(name, entry);
    }
    // Also register individual entry names (for choice/tiered nodes)
    if (n.entries) {
      for (const e of n.entries) {
        const eName = normalizeSimcName(e.name || "");
        if (eName && !nodeBySimcName.has(eName)) {
          const entry = { node: n, tree };
          if (heroTree) entry.heroTree = heroTree;
          nodeBySimcName.set(eName, entry);
        }
      }
    }
  }

  for (const n of data.classNodes) addNode(n, "class");
  for (const n of data.specNodes) addNode(n, "spec");
  for (const [treeName, treeNodes] of Object.entries(data.heroSubtrees)) {
    for (const n of treeNodes) addNode(n, "hero", treeName);
  }

  // Parse each override string and count points
  const pointCounts = { class: 0, spec: 0, hero: 0 };
  let heroTree = overrides.hero_talents || null;

  for (const [key, treeLabel] of [
    ["class_talents", "class"],
    ["spec_talents", "spec"],
  ]) {
    const str = overrides[key];
    if (!str) continue;

    const entries = str.split("/").filter(Boolean);
    for (const entry of entries) {
      const [name, rankStr] = entry.split(":");
      const rank = rankStr ? parseInt(rankStr, 10) : 1;
      const lookup = nodeBySimcName.get(normalizeSimcName(name));

      if (!lookup) {
        errors.push(`Unknown talent in ${key}: "${name}"`);
        continue;
      }
      if (lookup.tree !== treeLabel) {
        errors.push(
          `Talent "${name}" found in ${lookup.tree} tree, expected ${treeLabel}`,
        );
      }
      if (!lookup.node.freeNode) {
        pointCounts[treeLabel] += rank;
      }
    }
  }

  // Hero tree: case-insensitive lookup (SimC uses lowercase, raidbots uses display names)
  if (heroTree) {
    const heroTreeNormalized = new Map();
    for (const key of Object.keys(data.heroSubtrees)) {
      heroTreeNormalized.set(normalizeSimcName(key), key);
    }
    if (!heroTreeNormalized.has(normalizeSimcName(heroTree))) {
      errors.push(`Unknown hero tree: "${heroTree}"`);
    }
  }

  // Budget checks (only for trees with overrides present)
  if (overrides.class_talents) {
    if (pointCounts.class !== BUDGETS.class) {
      errors.push(
        `Class tree: ${pointCounts.class} points, expected ${BUDGETS.class}`,
      );
    }
  }
  if (overrides.spec_talents) {
    if (pointCounts.spec !== BUDGETS.spec) {
      errors.push(
        `Spec tree: ${pointCounts.spec} points, expected ${BUDGETS.spec}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    details: {
      classSpent: pointCounts.class,
      specSpent: pointCounts.spec,
      heroSpent: pointCounts.hero,
      heroTree,
    },
  };
}

// Dispatch to validateHash or validateOverrides based on build shape.
export function validateBuild(build) {
  if (build.hash) {
    return validateHash(build.hash);
  }
  if (build.overrides) {
    return validateOverrides(build.overrides);
  }
  return {
    valid: false,
    errors: ["Build has neither hash nor overrides"],
    details: null,
  };
}
