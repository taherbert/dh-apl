// Generates valid talent build combinations by walking the talent tree graph.
// Uses anchor-based generation: define key build-defining picks, then fill
// remaining points with BFS/greedy respecting graph constraints.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

// Point budgets for level 80
const CLASS_POINTS = 31;
const SPEC_POINTS = 30;

// reqPoints thresholds for gating (from Raidbots data)
const GATE_THRESHOLDS = [8, 20];

function loadData() {
  const raidbots = JSON.parse(
    readFileSync(join(DATA_DIR, "raidbots-talents.json"), "utf8"),
  );
  return raidbots;
}

// Build a node map from node ID → node for a given node list
function buildNodeMap(nodes) {
  const map = new Map();
  for (const node of nodes) map.set(node.id, node);
  return map;
}

// Validate a talent selection against tree constraints
export function validateSelection(nodes, nodeMap, selectedIds, budget) {
  const selected = new Set(selectedIds);
  const errors = [];

  // Count points spent
  let pointsSpent = 0;
  for (const id of selected) {
    const node = nodeMap.get(id);
    if (!node) {
      errors.push(`Unknown node ID: ${id}`);
      continue;
    }
    if (!node.freeNode) pointsSpent += node.maxRanks || 1;
  }

  if (pointsSpent > budget) {
    errors.push(`Over budget: ${pointsSpent}/${budget} points`);
  }

  // Check connectivity: non-entry nodes need at least one prev selected
  for (const id of selected) {
    const node = nodeMap.get(id);
    if (!node) continue;
    if (node.entryNode) continue;
    if (node.freeNode) continue;
    if (!node.prev || node.prev.length === 0) continue;
    const hasPrev = node.prev.some((prevId) => selected.has(prevId));
    if (!hasPrev) {
      errors.push(`Node "${node.name}" (${id}) has no selected prev node`);
    }
  }

  // Check reqPoints gates
  // Count points in nodes that precede each gate threshold
  for (const id of selected) {
    const node = nodeMap.get(id);
    if (!node || !node.reqPoints) continue;
    // Count points spent in nodes with lower or no reqPoints
    let pointsBefore = 0;
    for (const selId of selected) {
      const selNode = nodeMap.get(selId);
      if (!selNode || selNode.freeNode) continue;
      if (!selNode.reqPoints || selNode.reqPoints < node.reqPoints) {
        pointsBefore += selNode.maxRanks || 1;
      }
    }
    if (pointsBefore < node.reqPoints) {
      errors.push(
        `Node "${node.name}" requires ${node.reqPoints} points, only ${pointsBefore} spent in earlier tiers`,
      );
    }
  }

  // Check choice nodes: at most one entry per choice node selected
  const choiceNodes = nodes.filter((n) => n.type === "choice");
  for (const choice of choiceNodes) {
    if (!selected.has(choice.id)) continue;
    // Choice node is "selected" if any of its entries' spells are picked
    // But in our model, we select the node ID, and track which entry via a separate map
    // For validation, just ensure the node is in the set
  }

  return errors;
}

// BFS fill: given anchor nodes, greedily fill remaining points respecting constraints
function bfsFill(nodes, nodeMap, anchors, budget) {
  const selected = new Set();
  let pointsSpent = 0;

  // Add free nodes first
  for (const node of nodes) {
    if (node.freeNode) selected.add(node.id);
  }

  // Add entry nodes (required starting points)
  for (const node of nodes) {
    if (node.entryNode && !node.freeNode && node.name) {
      selected.add(node.id);
      pointsSpent += node.maxRanks || 1 || 1;
    }
  }

  // Add anchor nodes, building paths from entry nodes if needed
  for (const anchorId of anchors) {
    if (selected.has(anchorId)) continue;
    const path = findPath(nodeMap, selected, anchorId);
    if (!path) continue;
    for (const nodeId of path) {
      if (selected.has(nodeId)) continue;
      const node = nodeMap.get(nodeId);
      if (!node.freeNode) {
        if (pointsSpent + (node.maxRanks || 1) > budget) break;
        pointsSpent += node.maxRanks || 1;
      }
      selected.add(nodeId);
    }
  }

  // Fill remaining budget with BFS from selected nodes
  let changed = true;
  while (changed && pointsSpent < budget) {
    changed = false;
    for (const node of nodes) {
      if (selected.has(node.id)) continue;
      if (node.freeNode) {
        selected.add(node.id);
        continue;
      }

      // Must have a selected prev
      if (
        !node.entryNode &&
        (!node.prev || !node.prev.some((p) => selected.has(p)))
      )
        continue;

      // Check reqPoints gate
      if (node.reqPoints) {
        let ptsBefore = 0;
        for (const selId of selected) {
          const sn = nodeMap.get(selId);
          if (
            sn &&
            !sn.freeNode &&
            (!sn.reqPoints || sn.reqPoints < node.reqPoints)
          ) {
            ptsBefore += sn.maxRanks || 1;
          }
        }
        if (ptsBefore < node.reqPoints) continue;
      }

      // Skip choice nodes we can't afford
      if (pointsSpent + (node.maxRanks || 1) > budget) continue;

      selected.add(node.id);
      pointsSpent += node.maxRanks || 1;
      changed = true;
    }
  }

  return { selected: [...selected], pointsSpent };
}

// Find a path from any selected/entry node to a target node via prev links (BFS backwards)
function findPath(nodeMap, selected, targetId) {
  const target = nodeMap.get(targetId);
  if (!target) return null;
  if (selected.has(targetId)) return [targetId];

  // BFS backwards from target through prev links
  const visited = new Set([targetId]);
  const parentOf = new Map(); // child → parent in reverse traversal
  const queue = [targetId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const node = nodeMap.get(currentId);
    if (!node) continue;

    for (const prevId of node.prev || []) {
      if (visited.has(prevId)) continue;
      visited.add(prevId);
      parentOf.set(prevId, currentId);

      const prevNode = nodeMap.get(prevId);
      if (selected.has(prevId) || (prevNode && prevNode.entryNode)) {
        // Reconstruct path from prevId → targetId
        const path = [prevId];
        let cur = prevId;
        while (cur !== targetId) {
          cur = parentOf.get(cur);
          if (cur === undefined) return null;
          path.push(cur);
        }
        return path;
      }

      queue.push(prevId);
    }
  }

  return null;
}

// Generate hero tree choice combinations
function heroChoiceCombos(heroNodes) {
  const choiceNodes = heroNodes.filter((n) => n.type === "choice");
  if (choiceNodes.length === 0) return [{}];

  // Each choice node has 2+ entries; generate all combinations
  const combos = [{}];
  for (const choice of choiceNodes) {
    const newCombos = [];
    for (const combo of combos) {
      for (const entry of choice.entries) {
        newCombos.push({ ...combo, [choice.id]: entry });
      }
    }
    combos.length = 0;
    combos.push(...newCombos);
  }
  return combos;
}

// Define anchor talent sets (key build-defining picks)
// Each anchor set specifies talent names that define a build archetype
const ANCHOR_SETS = [
  {
    name: "SpiritBomb_FieryDemise",
    desc: "Spirit Bomb + Fiery Demise (standard damage build)",
    specAnchors: [
      "Spirit Bomb",
      "Fiery Demise",
      "Fracture",
      "Fel Devastation",
      "Soul Carver",
    ],
    classAnchors: ["Sigil of Flame", "Immolation Aura"],
  },
  {
    name: "SoulCleave_Focused",
    desc: "Soul Cleave focused (single-target / no Spirit Bomb)",
    specAnchors: ["Fracture", "Fel Devastation", "Fiery Brand", "Soul Barrier"],
    classAnchors: ["Sigil of Flame", "Immolation Aura"],
  },
  {
    name: "SpiritBomb_NoFieryDemise",
    desc: "Spirit Bomb without Fiery Demise",
    specAnchors: ["Spirit Bomb", "Fracture", "Fel Devastation", "Soul Carver"],
    classAnchors: ["Sigil of Flame", "Immolation Aura"],
  },
  {
    name: "Defensive",
    desc: "Maximum defensiveness build",
    specAnchors: [
      "Fracture",
      "Fel Devastation",
      "Soul Barrier",
      "Fiery Brand",
      "Last Resort",
    ],
    classAnchors: ["Sigil of Flame", "Darkness"],
  },
];

// Resolve talent names to node IDs
function resolveAnchors(anchorNames, nodes) {
  const ids = [];
  for (const name of anchorNames) {
    const node = nodes.find(
      (n) => n.name === name || n.entries.some((e) => e.name === name),
    );
    if (node) ids.push(node.id);
  }
  return ids;
}

// Generate all talent combinations
export function generateCombos() {
  const data = loadData();
  const classMap = buildNodeMap(data.classNodes);
  const specMap = buildNodeMap(data.specNodes);

  const builds = [];

  for (const heroTreeName of Object.keys(data.heroSubtrees)) {
    const heroNodes = data.heroSubtrees[heroTreeName];
    const heroCombos = heroChoiceCombos(heroNodes);

    for (const anchorSet of ANCHOR_SETS) {
      const classAnchors = resolveAnchors(
        anchorSet.classAnchors,
        data.classNodes,
      );
      const specAnchors = resolveAnchors(anchorSet.specAnchors, data.specNodes);

      const classFill = bfsFill(
        data.classNodes,
        classMap,
        classAnchors,
        CLASS_POINTS,
      );
      const specFill = bfsFill(
        data.specNodes,
        specMap,
        specAnchors,
        SPEC_POINTS,
      );

      for (const heroCombo of heroCombos) {
        const heroChoiceDesc = Object.values(heroCombo)
          .map((e) => e.name)
          .join("_")
          .replace(/\s+/g, "");

        const buildName = [
          heroTreeName.replace(/\s+/g, ""),
          anchorSet.name,
          heroChoiceDesc || "default",
        ].join("_");

        // Validate
        const classErrors = validateSelection(
          data.classNodes,
          classMap,
          classFill.selected,
          CLASS_POINTS,
        );
        const specErrors = validateSelection(
          data.specNodes,
          specMap,
          specFill.selected,
          SPEC_POINTS,
        );

        builds.push({
          name: buildName,
          heroTree: heroTreeName,
          archetype: anchorSet.name,
          description: anchorSet.desc,
          classNodes: classFill.selected,
          specNodes: specFill.selected,
          heroNodes: heroNodes.map((n) => n.id),
          heroChoices: heroCombo,
          classPoints: classFill.pointsSpent,
          specPoints: specFill.pointsSpent,
          valid: classErrors.length === 0 && specErrors.length === 0,
          errors: [...classErrors, ...specErrors],
        });
      }
    }
  }

  return builds;
}

// Generate SimC talent string from a build
export function toTalentString(build, data) {
  // SimC uses encoded talent strings; for profilesets we use talent overrides
  // Format: class_talents=nodeId:rank/nodeId:rank/...
  const classStr = build.classNodes
    .map((id) => {
      const node = data.classNodes.find((n) => n.id === id);
      return node ? `${id}:${node.maxRanks || 1}` : null;
    })
    .filter(Boolean)
    .join("/");

  const specStr = build.specNodes
    .map((id) => {
      const node = data.specNodes.find((n) => n.id === id);
      return node ? `${id}:${node.maxRanks || 1}` : null;
    })
    .filter(Boolean)
    .join("/");

  const heroStr = build.heroNodes
    .map((id) => {
      const heroTree = data.heroSubtrees[build.heroTree];
      const node = heroTree?.find((n) => n.id === id);
      return node ? `${id}:${node.maxRanks || 1}` : null;
    })
    .filter(Boolean)
    .join("/");

  return { classStr, specStr, heroStr };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const builds = generateCombos();

  const valid = builds.filter((b) => b.valid);
  const invalid = builds.filter((b) => !b.valid);

  console.log(
    `Generated ${builds.length} talent builds (${valid.length} valid, ${invalid.length} invalid)`,
  );

  // Group by hero tree
  const byHero = {};
  for (const build of valid) {
    (byHero[build.heroTree] ||= []).push(build);
  }

  for (const [tree, treeBuilds] of Object.entries(byHero)) {
    console.log(`\n${tree}: ${treeBuilds.length} builds`);
    for (const build of treeBuilds.slice(0, 5)) {
      console.log(
        `  ${build.name} (${build.classPoints}c/${build.specPoints}s pts)`,
      );
    }
    if (treeBuilds.length > 5)
      console.log(`  ... and ${treeBuilds.length - 5} more`);
  }

  if (invalid.length > 0) {
    console.log(`\nInvalid builds:`);
    for (const build of invalid.slice(0, 3)) {
      console.log(`  ${build.name}: ${build.errors.join("; ")}`);
    }
  }

  // Write output
  writeFileSync(
    join(DATA_DIR, "talent-combos.json"),
    JSON.stringify(valid, null, 2),
  );
  console.log(
    `\nWrote ${valid.length} valid builds to data/talent-combos.json`,
  );
}
