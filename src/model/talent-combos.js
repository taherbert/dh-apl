// Generates talent build combinations using fractional factorial Design of
// Experiments. Classifies talent nodes as locked/factor/excluded, generates a
// resolution IV design matrix, then maps each row to a valid build with budget
// reconciliation and connectivity repair.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encode,
  buildToSelections,
  loadFullNodeList,
} from "../util/talent-string.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

const CLASS_POINTS = 34;
const SPEC_POINTS = 34;

function loadData() {
  return JSON.parse(
    readFileSync(join(DATA_DIR, "raidbots-talents.json"), "utf8"),
  );
}

function buildNodeMap(nodes) {
  const map = new Map();
  for (const node of nodes) map.set(node.id, node);
  return map;
}

// --- Validation (preserved API for external callers) ---

export function validateSelection(
  nodes,
  nodeMap,
  selectedIds,
  budget,
  rankMap,
) {
  const selected = new Set(selectedIds);
  const errors = [];

  let pointsSpent = 0;
  for (const id of selected) {
    const node = nodeMap.get(id);
    if (!node) {
      errors.push(`Unknown node ID: ${id}`);
      continue;
    }
    if (!node.freeNode) pointsSpent += rankMap?.[id] || node.maxRanks || 1;
  }

  if (pointsSpent > budget) {
    errors.push(`Over budget: ${pointsSpent}/${budget} points`);
  }

  for (const id of selected) {
    const node = nodeMap.get(id);
    if (!node || node.entryNode || node.freeNode) continue;
    if (!node.prev || node.prev.length === 0) continue;
    if (!node.prev.some((prevId) => selected.has(prevId))) {
      errors.push(`Node "${node.name}" (${id}) has no selected prev node`);
    }
  }

  for (const id of selected) {
    const node = nodeMap.get(id);
    if (!node || !node.reqPoints) continue;
    let pointsBefore = 0;
    for (const selId of selected) {
      const selNode = nodeMap.get(selId);
      if (!selNode || selNode.freeNode) continue;
      if (!selNode.reqPoints || selNode.reqPoints < node.reqPoints) {
        pointsBefore += rankMap?.[selId] || selNode.maxRanks || 1;
      }
    }
    if (pointsBefore < node.reqPoints) {
      errors.push(
        `Node "${node.name}" requires ${node.reqPoints} points, only ${pointsBefore} spent in earlier tiers`,
      );
    }
  }

  return errors;
}

// --- Node classification ---

// BFS forward from a set of node IDs through next links to find all reachable nodes
function reachableFrom(startIds, nodeMap) {
  const visited = new Set(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift();
    const node = nodeMap.get(id);
    if (!node) continue;
    for (const nextId of node.next || []) {
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push(nextId);
      }
    }
  }
  return visited;
}

// Non-DPS talents: pure defensive, utility, or healing-only.
// These are excluded from the DoE factor space and default to SKIP.
// Connectivity repair may still add them as pathing nodes to reach deeper DPS talents.
const EXCLUDED_SPEC_NAMES = new Set([
  "Calcified Spikes", // Demon Spikes armor bonus (defensive)
  "Sigil of Silence", // Silence (utility) — choice entry on Roaring Fire node
  "Revel in Pain", // Shield from Fiery Brand (defensive)
  "Feast of Souls", // Healing from Soul Cleave (healing-only)
  "Ruinous Bulwark", // Fel Dev healing increase (healing-only)
  "Soul Barrier", // Absorb shield (defensive) — choice entry on Soul Barrier/Soul Sigils node
  "Fel Flame Fortification", // Fire damage reduction (defensive)
  "Last Resort", // Cheat death (defensive)
  "Soulmonger", // Soul fragment healing (healing-only)
  "Focused Cleave", // Soul Cleave secondary damage (minor, mostly defensive context)
  "Quickened Sigils", // Sigil activation speed (utility)
  "Sigil of Chains", // AoE grip (utility)
  "Chains of Anger", // Sigil of Chains extra functionality (utility)
  "Feed the Demon", // Demon Spikes CDR from soul fragments (defensive)
  "Roaring Fire", // Fel Dev healing increase (healing-only)
]);

// For choice nodes where one entry is excluded and the other isn't,
// the node stays as a factor but the excluded entry is noted.
// Soul Barrier / Soul Sigils: Soul Barrier = defensive, Soul Sigils = DPS (resource gen)

// Hero tree choice locks: non-DPS choices are locked to the DPS option.
// Only choices where both entries have DPS relevance remain as factors.
const HERO_CHOICE_LOCKS = {
  // Annihilator: Path to Oblivion [0] = movement speed → lock to State of Matter [1] = damage
  109448: 1,
  // Aldrachi Reaver: Evasive Action [0] = dodge → lock to Unhindered Assault [1] = movement+damage
  94911: 1,
  // Aldrachi Reaver: Army Unto Oneself [0] = leech / Incorruptible Spirit [1] = healing → both non-DPS, lock to 0
  94896: 0,
};

// Classify nodes into locked (always taken) and factors (decision points).
// Locked: entry nodes, free nodes, and nodes that are the sole path to other
// locked/required nodes (connectivity prerequisites).
// Excluded: non-DPS nodes are removed from factors and default to SKIP.
export function classifyNodes(nodes, nodeMap, budget, overrides = {}) {
  const locked = new Set();
  const lockedRanks = new Map(); // nodeId → rank to take

  // Entry and free nodes are always locked
  for (const node of nodes) {
    if (node.entryNode || node.freeNode) {
      locked.add(node.id);
      if (!node.freeNode) lockedRanks.set(node.id, node.maxRanks || 1);
    }
  }

  // Build effective exclusion set from defaults + overrides
  const effectiveExclusions = new Set(EXCLUDED_SPEC_NAMES);
  for (const name of overrides.include || []) effectiveExclusions.delete(name);
  for (const name of overrides.exclude || []) effectiveExclusions.add(name);

  // Force-require nodes: move from factors to locked
  const requireNames = new Set(overrides.require || []);
  for (const node of nodes) {
    if (requireNames.has(node.name) && !locked.has(node.id)) {
      locked.add(node.id);
      if (!node.freeNode) lockedRanks.set(node.id, node.maxRanks || 1);
    }
  }

  // Everything reachable from entry nodes is potentially selectable
  const entryIds = nodes.filter((n) => n.entryNode).map((n) => n.id);
  const reachable = reachableFrom(entryIds, nodeMap);

  // Factor nodes: reachable, non-locked, non-free, and not excluded
  const factors = [];
  const excluded = [];
  for (const node of nodes) {
    if (locked.has(node.id)) continue;
    if (!reachable.has(node.id)) continue;

    // Check if the node (or all its entries for non-choice) is excluded
    if (node.type === "choice") {
      const allExcluded = node.entries.every((e) =>
        effectiveExclusions.has(e.name),
      );
      if (allExcluded) {
        excluded.push(node);
        continue;
      }
    } else if (effectiveExclusions.has(node.name)) {
      excluded.push(node);
      continue;
    }

    factors.push(node);
  }

  return { locked, lockedRanks, factors, excluded };
}

// --- Factor identification ---

// Map tree nodes to DoE factors. Each factor is a binary toggle.
// Multi-rank nodes become two factors (rank1, rank2 where rank2 implies rank1).
// Choice nodes become a single binary factor (entry A vs entry B).
export function identifyFactors(factorNodes) {
  const factors = [];

  for (const node of factorNodes) {
    if (node.type === "choice") {
      // Binary: which entry to pick (0 = first entry, 1 = second entry)
      // The node itself is always taken if reachable and affordable
      factors.push({
        nodeId: node.id,
        name: node.name,
        type: "choice",
        entries: node.entries.map((e) => e.name),
        // level 0 = first entry, level 1 = second entry
      });
    } else if ((node.maxRanks || 1) > 1) {
      // Multi-rank: factor for rank 1 (take/skip) and factor for rank 2
      factors.push({
        nodeId: node.id,
        name: `${node.name}_r1`,
        type: "multi_rank_r1",
        rankLevel: 1,
      });
      factors.push({
        nodeId: node.id,
        name: `${node.name}_r2`,
        type: "multi_rank_r2",
        rankLevel: 2,
      });
    } else {
      // Simple binary: take (1) or skip (0)
      factors.push({
        nodeId: node.id,
        name: node.name,
        type: "binary",
      });
    }
  }

  return factors;
}

// --- Fractional factorial design generation ---

// Generate a resolution IV fractional factorial design for K factors.
// Uses Hadamard-like construction: pick K-p independent columns, define
// remaining p columns as products of independent columns such that no
// main effect is aliased with any other main effect or 2-factor interaction.
export function generateFractionalFactorial(K) {
  if (K <= 0) return { matrix: [], generators: [], baseSize: 0 };

  // For resolution IV, we need 2^(K-p) >= 2K + 1 (rough heuristic)
  // Find smallest p such that 2^(K-p) rows give resolution IV
  let p = 0;
  let baseK = K;

  // Standard resolution IV designs: use generators from standard DoE tables
  // For K factors, we need at least ceil(log2(K)) + 1 independent columns
  // to achieve resolution IV. The remaining columns are products of
  // independent columns.

  // Find the minimum number of base columns for resolution IV
  // Resolution IV: no main effect aliased with main effect or 2FI
  // Minimum base columns: smallest n where C(n,1) + C(n,2) >= K
  // (each generator is a product of 2+ base columns)
  let baseCols = 1;
  while (baseCols < K) {
    // Number of factors we can define: baseCols independent + C(baseCols, 2) generators from 2-way products
    // For resolution IV we use products of 2+ base columns as generators
    const twoWay = (baseCols * (baseCols - 1)) / 2;
    if (baseCols + twoWay >= K) break;
    baseCols++;
  }

  const nRows = 1 << baseCols; // 2^baseCols
  p = K - baseCols;

  // Generate base columns (full factorial for baseCols factors)
  const baseMatrix = [];
  for (let row = 0; row < nRows; row++) {
    const levels = [];
    for (let col = 0; col < baseCols; col++) {
      levels.push((row >> col) & 1);
    }
    baseMatrix.push(levels);
  }

  // Generate additional columns as products of pairs of base columns
  // This gives resolution IV: generators are 2-factor interactions of base columns
  const generators = [];
  const fullMatrix = baseMatrix.map((row) => [...row]);

  if (p > 0) {
    let genCount = 0;
    for (let i = 0; i < baseCols && genCount < p; i++) {
      for (let j = i + 1; j < baseCols && genCount < p; j++) {
        generators.push([i, j]);
        for (let row = 0; row < nRows; row++) {
          fullMatrix[row].push(baseMatrix[row][i] ^ baseMatrix[row][j]);
        }
        genCount++;
      }
    }
  }

  return {
    matrix: fullMatrix,
    generators,
    baseSize: baseCols,
    nRows,
    K,
  };
}

// --- Build mapping ---

// Find path from any selected/entry node to target via prev links (BFS backwards)
function findPath(nodeMap, selected, targetId) {
  const target = nodeMap.get(targetId);
  if (!target) return null;
  if (selected.has(targetId)) return [targetId];

  const visited = new Set([targetId]);
  const parentOf = new Map();
  const queue = [targetId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const node = nodeMap.get(currentId);
    if (!node) continue;

    for (const prevId of node.prev || []) {
      if (visited.has(prevId)) continue;
      visited.add(prevId);
      parentOf.set(prevId, currentId);

      if (selected.has(prevId) || nodeMap.get(prevId)?.entryNode) {
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

// Check if removing a node would orphan any selected descendant
function wouldOrphan(nodeId, selected, nodeMap) {
  const node = nodeMap.get(nodeId);
  if (!node) return false;
  for (const nextId of node.next || []) {
    if (!selected.has(nextId)) continue;
    const nextNode = nodeMap.get(nextId);
    if (!nextNode || nextNode.entryNode || nextNode.freeNode) continue;
    // Check if this node is the ONLY selected prev for nextNode
    const otherPrevs = (nextNode.prev || []).filter(
      (p) => p !== nodeId && selected.has(p),
    );
    if (otherPrevs.length === 0) return true;
  }
  return false;
}

// Count points spent in selected set (excluding free nodes)
function countPoints(selected, nodeMap, rankMap) {
  let pts = 0;
  for (const id of selected) {
    const node = nodeMap.get(id);
    if (!node || node.freeNode) continue;
    pts += rankMap.get(id) || node.maxRanks || 1;
  }
  return pts;
}

// Check reqPoints gate for a node given current selection
function passesGate(node, selected, nodeMap, rankMap) {
  if (!node.reqPoints) return true;
  let ptsBefore = 0;
  for (const selId of selected) {
    const sn = nodeMap.get(selId);
    if (!sn || sn.freeNode) continue;
    if (!sn.reqPoints || sn.reqPoints < node.reqPoints) {
      ptsBefore += rankMap.get(selId) || sn.maxRanks || 1;
    }
  }
  return ptsBefore >= node.reqPoints;
}

// Map a design row (factor settings) to a valid talent build.
// Applies factor settings, then reconciles budget and connectivity.
export function designRowToBuild(
  factorSettings,
  factors,
  lockedNodes,
  lockedRanks,
  nodes,
  nodeMap,
  budget,
  excludedNodeIds = new Set(),
) {
  const selected = new Set(lockedNodes);
  const rankMap = new Map(lockedRanks);
  const choiceMap = new Map(); // nodeId → chosen entry index

  // Apply factor settings
  for (let i = 0; i < factors.length; i++) {
    const factor = factors[i];
    const level = factorSettings[i];

    if (factor.type === "binary") {
      if (level === 1) {
        selected.add(factor.nodeId);
        rankMap.set(factor.nodeId, 1);
      }
    } else if (factor.type === "choice") {
      // Choice node is always added; level picks which entry
      selected.add(factor.nodeId);
      rankMap.set(factor.nodeId, 1);
      choiceMap.set(factor.nodeId, level);
    } else if (factor.type === "multi_rank_r1") {
      if (level === 1) {
        selected.add(factor.nodeId);
        rankMap.set(
          factor.nodeId,
          Math.max(rankMap.get(factor.nodeId) || 0, 1),
        );
      }
    } else if (factor.type === "multi_rank_r2") {
      if (level === 1) {
        // rank2 implies rank1
        selected.add(factor.nodeId);
        rankMap.set(factor.nodeId, 2);
      }
    }
  }

  // Enforce rank2 implies rank1: if rank2 is set but rank1 was 0, bump to 2
  for (const factor of factors) {
    if (factor.type === "multi_rank_r2" && selected.has(factor.nodeId)) {
      const rank = rankMap.get(factor.nodeId) || 0;
      if (rank < 1) rankMap.set(factor.nodeId, 1);
    }
  }

  // Connectivity repair: iteratively ensure all selected nodes have a selected prev.
  // For each orphan, find a path from a selected/entry node to one of its prev nodes,
  // then add all nodes along that path.
  let repairChanged = true;
  while (repairChanged) {
    repairChanged = false;
    for (const id of [...selected]) {
      const node = nodeMap.get(id);
      if (!node || node.entryNode || node.freeNode) continue;
      if (!node.prev || node.prev.length === 0) continue;
      if (node.prev.some((p) => selected.has(p))) continue;

      // Try each prev node — find a path from selected/entry to it
      let fixed = false;
      for (const prevId of node.prev) {
        if (selected.has(prevId)) {
          fixed = true;
          break;
        }
        const path = findPath(nodeMap, selected, prevId);
        if (path) {
          for (const pathId of path) {
            if (!selected.has(pathId)) {
              selected.add(pathId);
              const pn = nodeMap.get(pathId);
              rankMap.set(pathId, pn?.maxRanks || 1);
              repairChanged = true;
            }
          }
          fixed = true;
          break;
        }
      }
    }
  }

  // Budget reconciliation
  let pts = countPoints(selected, nodeMap, rankMap);

  // Over budget: remove lowest-priority nodes (bottom-up by posY, then rightmost)
  if (pts > budget) {
    const removable = [...selected]
      .filter((id) => {
        const n = nodeMap.get(id);
        return n && !n.entryNode && !n.freeNode && !lockedNodes.has(id);
      })
      .map((id) => ({ id, node: nodeMap.get(id) }))
      .sort((a, b) => {
        // Remove bottom-right first (highest posY, then highest posX)
        const dy = (b.node.posY || 0) - (a.node.posY || 0);
        if (dy !== 0) return dy;
        return (b.node.posX || 0) - (a.node.posX || 0);
      });

    for (const { id, node } of removable) {
      if (pts <= budget) break;
      if (!selected.has(id)) continue;
      if (wouldOrphan(id, selected, nodeMap)) continue;

      // Don't remove pre-gate nodes if it would break gate requirements
      // for any remaining gated node
      const rank = rankMap.get(id) || node.maxRanks || 1;
      const wouldBreakGate = [...selected].some((selId) => {
        const sn = nodeMap.get(selId);
        if (!sn || !sn.reqPoints || selId === id) return false;
        if (!node.reqPoints || node.reqPoints < sn.reqPoints) {
          // This node counts toward sn's gate; check if removing it breaks it
          let ptsBefore = 0;
          for (const otherId of selected) {
            if (otherId === id) continue;
            const on = nodeMap.get(otherId);
            if (!on || on.freeNode) continue;
            if (!on.reqPoints || on.reqPoints < sn.reqPoints) {
              ptsBefore += rankMap.get(otherId) || on.maxRanks || 1;
            }
          }
          return ptsBefore < sn.reqPoints;
        }
        return false;
      });
      if (wouldBreakGate) continue;

      if (rank > 1) {
        rankMap.set(id, rank - 1);
        pts -= 1;
      } else {
        selected.delete(id);
        rankMap.delete(id);
        pts -= 1;
      }
    }
  }

  // Under budget: iteratively add highest-priority available nodes (top-down by posY).
  // Re-evaluate availability each pass since adding nodes opens up gated/connected nodes.
  let fillChanged = true;
  while (fillChanged && pts < budget) {
    fillChanged = false;
    const available = nodes
      .filter((n) => {
        if (selected.has(n.id)) return false;
        if (n.freeNode) return false;
        if (n.entryNode) return false;
        if (n.prev && n.prev.length > 0 && !n.prev.some((p) => selected.has(p)))
          return false;
        if (!passesGate(n, selected, nodeMap, rankMap)) return false;
        return true;
      })
      .sort((a, b) => {
        // Prefer non-excluded nodes over excluded ones
        const exA = excludedNodeIds.has(a.id) ? 1 : 0;
        const exB = excludedNodeIds.has(b.id) ? 1 : 0;
        if (exA !== exB) return exA - exB;
        const dy = (a.posY || 0) - (b.posY || 0);
        if (dy !== 0) return dy;
        return (a.posX || 0) - (b.posX || 0);
      });

    for (const node of available) {
      if (pts >= budget) break;
      const cost = node.maxRanks || 1;
      if (pts + cost > budget) {
        if (cost > 1 && pts + 1 <= budget) {
          selected.add(node.id);
          rankMap.set(node.id, 1);
          pts += 1;
          fillChanged = true;
        }
        continue;
      }
      selected.add(node.id);
      rankMap.set(node.id, cost);
      pts += cost;
      fillChanged = true;
    }

    // Also try bumping existing multi-rank nodes to max
    if (pts < budget) {
      for (const node of nodes) {
        if (pts >= budget) break;
        if (!selected.has(node.id)) continue;
        const maxR = node.maxRanks || 1;
        const curR = rankMap.get(node.id) || 1;
        if (curR < maxR && pts + (maxR - curR) <= budget) {
          pts += maxR - curR;
          rankMap.set(node.id, maxR);
          fillChanged = true;
        }
      }
    }
  }

  return {
    selected: [...selected],
    rankMap: Object.fromEntries(rankMap),
    choiceMap: Object.fromEntries(choiceMap),
    pointsSpent: pts,
    feasible: pts === budget,
  };
}

// --- Hero tree combinations ---

function heroChoiceCombos(heroNodes, opts = {}) {
  const choiceNodes = heroNodes.filter((n) => n.type === "choice");
  if (choiceNodes.length === 0) return [{}];

  // Merge default locks with overrides
  const effectiveLocks = {
    ...HERO_CHOICE_LOCKS,
    ...(opts.lockHeroChoices || {}),
  };
  const unlocked = new Set(opts.unlockHeroChoices || []);
  for (const id of unlocked) delete effectiveLocks[id];

  const combos = [{}];
  for (const choice of choiceNodes) {
    const lockedIdx = effectiveLocks[choice.id];
    const newCombos = [];
    for (const combo of combos) {
      if (lockedIdx !== undefined) {
        newCombos.push({ ...combo, [choice.id]: choice.entries[lockedIdx] });
      } else {
        for (const entry of choice.entries) {
          newCombos.push({ ...combo, [choice.id]: entry });
        }
      }
    }
    combos.length = 0;
    combos.push(...newCombos);
  }
  return combos;
}

// --- Cross-product ---

export function crossWithHero(specBuilds, heroSubtrees, opts = {}) {
  const allBuilds = [];

  for (const [heroTreeName, heroNodes] of Object.entries(heroSubtrees)) {
    const heroCombos = heroChoiceCombos(heroNodes, opts);

    for (const specBuild of specBuilds) {
      for (const heroCombo of heroCombos) {
        allBuilds.push({
          ...specBuild,
          heroTree: heroTreeName,
          heroNodes: heroNodes.map((n) => n.id),
          heroChoices: heroCombo,
        });
      }
    }
  }

  return allBuilds;
}

// --- Talent string generation ---

export function toTalentString(build, data) {
  const classStr = build.classNodes
    .map((id) => {
      const node = data.classNodes.find((n) => n.id === id);
      const rank = build.classRanks?.[id] || node?.maxRanks || 1;
      return node ? `${id}:${rank}` : null;
    })
    .filter(Boolean)
    .join("/");

  const specStr = build.specNodes
    .map((id) => {
      const node = data.specNodes.find((n) => n.id === id);
      const rank = build.specRanks?.[id] || node?.maxRanks || 1;
      return node ? `${id}:${rank}` : null;
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

// Encode a DoE build into a base64 talent hash string.
// Must use the full DH node list (all specs, all hero trees) for correct
// bit alignment — the game client encodes against C_Traits.GetTreeNodes().
export function buildToHash(build, data, specId = 581) {
  const selections = buildToSelections(build, data);
  const nodes = loadFullNodeList();
  return encode(specId, nodes, selections);
}

// Return a profileset variant object for a DoE build.
export function buildToVariant(build, data, specId = 581) {
  const hash = buildToHash(build, data, specId);
  return { name: build.name, overrides: [`talents=${hash}`] };
}

// --- Design quality metrics ---

function designQuality(matrix, K) {
  const nRows = matrix.length;
  if (nRows === 0) return { balanced: true, orthogonal: true, pairCoverage: 1 };

  // Balance: each factor should have equal 0s and 1s
  let balanceScore = 0;
  for (let col = 0; col < K; col++) {
    const ones = matrix.reduce((sum, row) => sum + row[col], 0);
    balanceScore += Math.abs(ones / nRows - 0.5);
  }

  // Orthogonality: correlation between factor columns should be ~0
  let maxCorr = 0;
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      const meanI = matrix.reduce((s, r) => s + r[i], 0) / nRows;
      const meanJ = matrix.reduce((s, r) => s + r[j], 0) / nRows;
      let num = 0,
        denI = 0,
        denJ = 0;
      for (const row of matrix) {
        const di = row[i] - meanI;
        const dj = row[j] - meanJ;
        num += di * dj;
        denI += di * di;
        denJ += dj * dj;
      }
      const den = Math.sqrt(denI * denJ);
      const corr = den > 0 ? Math.abs(num / den) : 0;
      if (corr > maxCorr) maxCorr = corr;
    }
  }

  // Pair coverage: for each pair of factors, all 4 level combinations appear
  let pairsComplete = 0;
  let totalPairs = 0;
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      totalPairs++;
      const seen = new Set();
      for (const row of matrix) {
        seen.add(`${row[i]},${row[j]}`);
      }
      if (seen.size === 4) pairsComplete++;
    }
  }

  return {
    balanced: balanceScore / K < 0.1,
    maxCorrelation: maxCorr,
    orthogonal: maxCorr < 0.3,
    pairCoverage: totalPairs > 0 ? pairsComplete / totalPairs : 1,
  };
}

// --- Main generation ---

// Options for overriding default node classification:
//   require: string[]  — node names forced into locked set (always taken)
//   exclude: string[]  — additional node names to exclude (default skip)
//   include: string[]  — node names to remove from default exclusion list (restore as factor)
//   unlockHeroChoices: number[] — hero choice node IDs to restore as free factors
//   lockHeroChoices: { [nodeId]: entryIndex } — additional hero choices to lock
export function generateCombos(opts = {}) {
  const data = loadData();
  const classMap = buildNodeMap(data.classNodes);
  const specMap = buildNodeMap(data.specNodes);

  // Class tree: single default fill (low build-defining variance for VDH)
  const classLocked = new Set();
  const classLockedRanks = new Map();
  for (const node of data.classNodes) {
    if (node.freeNode) classLocked.add(node.id);
  }
  for (const node of data.classNodes) {
    if (node.entryNode && !node.freeNode) {
      classLocked.add(node.id);
      classLockedRanks.set(node.id, node.maxRanks || 1);
    }
  }

  // BFS fill the class tree to budget
  const classResult = bfsFillSimple(
    data.classNodes,
    classMap,
    classLocked,
    classLockedRanks,
    CLASS_POINTS,
  );

  // Spec tree: DoE approach
  const {
    locked,
    lockedRanks,
    factors: factorNodes,
    excluded,
  } = classifyNodes(data.specNodes, specMap, SPEC_POINTS, opts);

  const factors = identifyFactors(factorNodes);
  const K = factors.length;

  console.log(
    `Spec tree: ${factorNodes.length} factor nodes → ${K} binary factors`,
  );
  console.log(
    `Locked nodes: ${locked.size}, Factor nodes: ${factorNodes.length}, Excluded (non-DPS): ${excluded.length}`,
  );

  const excludedNodeIds = new Set(excluded.map((n) => n.id));

  // Generate fractional factorial design
  const design = generateFractionalFactorial(K);
  console.log(
    `Design: ${design.nRows} rows for ${K} factors (${design.baseSize} base + ${design.generators.length} generators)`,
  );

  // Map each design row to a valid build
  const specBuilds = [];
  const usedHashes = new Set();

  for (let rowIdx = 0; rowIdx < design.matrix.length; rowIdx++) {
    const row = design.matrix[rowIdx];
    const build = designRowToBuild(
      row,
      factors,
      locked,
      lockedRanks,
      data.specNodes,
      specMap,
      SPEC_POINTS,
      excludedNodeIds,
    );

    // Deduplicate by node+rank hash
    const hash = build.selected
      .sort((a, b) => a - b)
      .map((id) => `${id}:${build.rankMap[id] || 1}`)
      .join(",");

    if (usedHashes.has(hash)) continue;
    usedHashes.add(hash);

    const errors = validateSelection(
      data.specNodes,
      specMap,
      build.selected,
      SPEC_POINTS,
      build.rankMap,
    );

    specBuilds.push({
      designRow: rowIdx,
      factorSettings: Object.fromEntries(
        factors.map((f, i) => [
          f.nodeId + (f.type.includes("r2") ? "_r2" : ""),
          row[i],
        ]),
      ),
      specNodes: build.selected,
      specRanks: build.rankMap,
      specChoices: build.choiceMap,
      specPoints: build.pointsSpent,
      classNodes: classResult.selected,
      classRanks: Object.fromEntries(classResult.rankMap),
      classPoints: classResult.pointsSpent,
      valid: errors.length === 0 && build.feasible,
      errors,
      feasible: build.feasible,
    });
  }

  // Check design quality on the actual (post-reconciliation) matrix
  const actualMatrix = specBuilds.map((b) =>
    factors.map((f) => {
      if (f.type === "choice") return b.specChoices[f.nodeId] || 0;
      if (f.type === "multi_rank_r2")
        return (b.specRanks[f.nodeId] || 0) >= 2 ? 1 : 0;
      if (f.type === "multi_rank_r1")
        return (b.specRanks[f.nodeId] || 0) >= 1 ? 1 : 0;
      return b.specNodes.includes(f.nodeId) ? 1 : 0;
    }),
  );
  const quality = designQuality(actualMatrix, K);

  // Cross with hero combos
  const allBuilds = crossWithHero(specBuilds, data.heroSubtrees, opts);

  // Add build names
  for (let i = 0; i < allBuilds.length; i++) {
    const b = allBuilds[i];
    const heroChoiceDesc = Object.values(b.heroChoices || {})
      .map((e) => e.name)
      .join("_")
      .replace(/\s+/g, "");

    b.name = [
      b.heroTree.replace(/\s+/g, ""),
      `d${b.designRow}`,
      heroChoiceDesc || "default",
    ].join("_");
  }

  return {
    excluded: excluded.map((n) => ({ nodeId: n.id, name: n.name })),
    factors: {
      spec: factors.map((f) => ({
        nodeId: f.nodeId,
        name: f.name,
        type: f.type,
        ...(f.entries ? { entries: f.entries } : {}),
      })),
      class: "default_fill",
    },
    design: {
      K,
      nRows: design.nRows,
      baseSize: design.baseSize,
      generators: design.generators,
      quality,
    },
    designMatrix: design.matrix.map((row, i) => ({
      row: i,
      factors: Object.fromEntries(factors.map((f, j) => [f.nodeId, row[j]])),
      feasible: specBuilds.find((b) => b.designRow === i)?.feasible ?? false,
    })),
    specBuilds,
    builds: allBuilds,
    pinnedBuilds: generatePinnedBuilds(data, specMap, classResult),
  };
}

// Simple BFS fill for class tree (no DoE needed)
function bfsFillSimple(nodes, nodeMap, locked, lockedRanks, budget) {
  const selected = new Set(locked);
  const rankMap = new Map(lockedRanks);
  let pts = 0;
  for (const [id, rank] of lockedRanks) pts += rank;

  let changed = true;
  while (changed && pts < budget) {
    changed = false;
    for (const node of nodes) {
      if (selected.has(node.id)) continue;
      if (node.freeNode) {
        selected.add(node.id);
        continue;
      }

      if (
        !node.entryNode &&
        node.prev &&
        node.prev.length > 0 &&
        !node.prev.some((p) => selected.has(p))
      )
        continue;

      if (!passesGate(node, selected, nodeMap, rankMap)) continue;

      const cost = node.maxRanks || 1;
      if (pts + cost > budget) continue;

      selected.add(node.id);
      rankMap.set(node.id, cost);
      pts += cost;
      changed = true;
    }
  }

  return { selected: [...selected], rankMap, pointsSpent: pts };
}

// --- Profile pinned builds ---

// Load profiles from profiles.json and generate one pinned build per profile × hero combo.
// Each profile specifies required/excluded nodes; the rest are filled by BFS.
function loadProfiles() {
  const profilesPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "profiles.json",
  );
  try {
    return JSON.parse(readFileSync(profilesPath, "utf8")).profiles || [];
  } catch {
    return [];
  }
}

function buildPinnedBuild(profile, data, specMap, classResult) {
  const nameToNode = new Map();
  for (const n of data.specNodes) {
    nameToNode.set(n.name, n);
    if (n.entries) for (const e of n.entries) nameToNode.set(e.name, n);
  }

  const locked = new Set();
  const lockedRanks = new Map();

  // Lock entry/free nodes
  for (const n of data.specNodes) {
    if (n.entryNode || n.freeNode) {
      locked.add(n.id);
      if (!n.freeNode) lockedRanks.set(n.id, n.maxRanks || 1);
    }
  }

  // Lock required nodes from profile
  for (const name of profile.require || []) {
    const node = nameToNode.get(name);
    if (node && !locked.has(node.id)) {
      locked.add(node.id);
      lockedRanks.set(node.id, node.maxRanks || 1);
    }
  }

  // Build exclusion set: default exclusions minus profile includes/requires, plus profile excludes
  const effectiveExclusions = new Set(EXCLUDED_SPEC_NAMES);
  for (const name of profile.include || []) effectiveExclusions.delete(name);
  for (const name of profile.require || []) effectiveExclusions.delete(name);
  for (const name of profile.exclude || []) effectiveExclusions.add(name);

  // Connectivity repair: ensure all locked nodes have a path from entry
  let repairChanged = true;
  while (repairChanged) {
    repairChanged = false;
    for (const id of [...locked]) {
      const node = specMap.get(id);
      if (!node || node.entryNode || node.freeNode) continue;
      if (!node.prev || node.prev.length === 0) continue;
      if (node.prev.some((p) => locked.has(p))) continue;
      // Find path from any locked/entry node
      for (const prevId of node.prev) {
        const path = findPath(specMap, locked, prevId);
        if (path) {
          for (const pathId of path) {
            if (!locked.has(pathId)) {
              locked.add(pathId);
              const pn = specMap.get(pathId);
              lockedRanks.set(pathId, pn?.maxRanks || 1);
              repairChanged = true;
            }
          }
          break;
        }
      }
    }
  }

  // BFS fill remaining budget, preferring non-excluded nodes
  const selected = new Set(locked);
  const rankMap = new Map(lockedRanks);
  let pts = 0;
  for (const [, rank] of lockedRanks) pts += rank;

  let fillChanged = true;
  while (fillChanged && pts < SPEC_POINTS) {
    fillChanged = false;
    const available = data.specNodes
      .filter((n) => {
        if (selected.has(n.id) || n.freeNode || n.entryNode) return false;
        if (n.prev?.length > 0 && !n.prev.some((p) => selected.has(p)))
          return false;
        if (!passesGate(n, selected, specMap, rankMap)) return false;
        return true;
      })
      .sort((a, b) => {
        const exA = effectiveExclusions.has(a.name) ? 1 : 0;
        const exB = effectiveExclusions.has(b.name) ? 1 : 0;
        if (exA !== exB) return exA - exB;
        const dy = (a.posY || 0) - (b.posY || 0);
        if (dy !== 0) return dy;
        return (a.posX || 0) - (b.posX || 0);
      });

    for (const node of available) {
      if (pts >= SPEC_POINTS) break;
      const cost = node.maxRanks || 1;
      if (pts + cost > SPEC_POINTS) {
        if (cost > 1 && pts + 1 <= SPEC_POINTS) {
          selected.add(node.id);
          rankMap.set(node.id, 1);
          pts += 1;
          fillChanged = true;
        }
        continue;
      }
      selected.add(node.id);
      rankMap.set(node.id, cost);
      pts += cost;
      fillChanged = true;
    }

    // Bump multi-rank nodes
    if (pts < SPEC_POINTS) {
      for (const node of data.specNodes) {
        if (pts >= SPEC_POINTS) break;
        if (!selected.has(node.id)) continue;
        const maxR = node.maxRanks || 1;
        const curR = rankMap.get(node.id) || 1;
        if (curR < maxR && pts + (maxR - curR) <= SPEC_POINTS) {
          pts += maxR - curR;
          rankMap.set(node.id, maxR);
          fillChanged = true;
        }
      }
    }
  }

  const errors = validateSelection(
    data.specNodes,
    specMap,
    [...selected],
    SPEC_POINTS,
    Object.fromEntries(rankMap),
  );

  return {
    profile: profile.name,
    specNodes: [...selected],
    specRanks: Object.fromEntries(rankMap),
    specChoices: {},
    specPoints: pts,
    classNodes: classResult.selected,
    classRanks: Object.fromEntries(classResult.rankMap),
    classPoints: classResult.pointsSpent,
    valid: errors.length === 0 && pts === SPEC_POINTS,
    errors,
    feasible: pts === SPEC_POINTS,
    pinned: true,
  };
}

function generatePinnedBuilds(data, specMap, classResult) {
  const profiles = loadProfiles();
  if (profiles.length === 0) return [];

  const pinnedBuilds = [];
  for (const profile of profiles) {
    const specBuild = buildPinnedBuild(profile, data, specMap, classResult);

    // Cross with hero combos (using profile's hero overrides if any)
    for (const [heroTreeName, heroNodes] of Object.entries(data.heroSubtrees)) {
      const heroCombos = heroChoiceCombos(heroNodes, profile);
      for (const heroCombo of heroCombos) {
        const heroChoiceDesc = Object.values(heroCombo)
          .map((e) => e.name)
          .join("_")
          .replace(/\s+/g, "");

        pinnedBuilds.push({
          ...specBuild,
          heroTree: heroTreeName,
          heroNodes: heroNodes.map((n) => n.id),
          heroChoices: heroCombo,
          name: `pin_${profile.name}_${heroTreeName.replace(/\s+/g, "")}_${heroChoiceDesc || "default"}`,
        });
      }
    }
  }

  return pinnedBuilds;
}

// --- CLI entry point ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generateCombos();

  const valid = result.builds.filter((b) => b.valid);
  const invalid = result.builds.filter((b) => !b.valid);

  console.log(
    `\nGenerated ${result.builds.length} talent builds (${valid.length} valid, ${invalid.length} invalid)`,
  );
  console.log(
    `  ${result.specBuilds.length} unique spec designs × ${Math.round(result.builds.length / result.specBuilds.length)} hero combos`,
  );

  // Design quality
  const q = result.design.quality;
  console.log(`\nDesign quality:`);
  console.log(`  Balanced: ${q.balanced}`);
  console.log(
    `  Orthogonal: ${q.orthogonal} (max correlation: ${q.maxCorrelation?.toFixed(3)})`,
  );
  console.log(`  Pair coverage: ${(q.pairCoverage * 100).toFixed(1)}%`);

  // Excluded summary
  if (result.excluded.length > 0) {
    console.log(`\nExcluded non-DPS nodes (${result.excluded.length}):`);
    for (const n of result.excluded) console.log(`  ✗ ${n.name}`);
  }

  // Factor summary
  console.log(`\nFactors (${result.factors.spec.length}):`);
  for (const f of result.factors.spec) {
    const label =
      f.type === "choice"
        ? `[choice: ${f.entries.join(" / ")}]`
        : f.type.startsWith("multi_rank")
          ? `[${f.type}]`
          : "[binary]";
    console.log(`  ${f.name} ${label}`);
  }

  // Group by hero tree
  const byHero = {};
  for (const build of valid) {
    (byHero[build.heroTree] ||= []).push(build);
  }

  for (const [tree, treeBuilds] of Object.entries(byHero)) {
    console.log(`\n${tree}: ${treeBuilds.length} builds`);
    for (const build of treeBuilds.slice(0, 3)) {
      console.log(
        `  ${build.name} (${build.classPoints}c/${build.specPoints}s pts)`,
      );
    }
    if (treeBuilds.length > 3)
      console.log(`  ... and ${treeBuilds.length - 3} more`);
  }

  if (invalid.length > 0) {
    console.log(`\nInvalid builds (${invalid.length}):`);
    for (const build of invalid.slice(0, 5)) {
      console.log(`  ${build.name}: ${build.errors.join("; ")}`);
    }
    if (invalid.length > 5) console.log(`  ... and ${invalid.length - 5} more`);
  }

  // Pinned builds from profiles.json
  const pinned = result.pinnedBuilds || [];
  const validPinned = pinned.filter((b) => b.valid);
  const invalidPinned = pinned.filter((b) => !b.valid);
  if (pinned.length > 0) {
    const profileNames = [...new Set(pinned.map((b) => b.profile))];
    console.log(
      `\nPinned builds from profiles.json (${validPinned.length} valid, ${invalidPinned.length} invalid):`,
    );
    for (const name of profileNames) {
      const pBuilds = validPinned.filter((b) => b.profile === name);
      console.log(`  ${name}: ${pBuilds.length} builds`);
      for (const b of pBuilds.slice(0, 2)) {
        console.log(`    ${b.name} (${b.specPoints}s pts)`);
      }
      if (pBuilds.length > 2)
        console.log(`    ... and ${pBuilds.length - 2} more`);
    }
    for (const b of invalidPinned) {
      console.log(`  ✗ ${b.name}: ${b.errors.join("; ")}`);
    }
  }

  // Write output
  const output = {
    factors: result.factors,
    design: result.design,
    designMatrix: result.designMatrix,
    builds: valid,
    pinnedBuilds: validPinned,
  };
  writeFileSync(
    join(DATA_DIR, "talent-combos.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(
    `\nWrote ${valid.length} DoE + ${validPinned.length} pinned builds to data/talent-combos.json`,
  );
}
