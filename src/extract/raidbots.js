// Fetches Vengeance DH talent data from Raidbots and saves filtered output.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_ENV,
  RAIDBOTS_TALENTS,
  SPEC_ID,
  HERO_SUBTREES,
  SIMC_DIR,
} from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

function simplifyNode(n) {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    maxRanks: n.maxRanks || n.entries?.[0]?.maxRanks || 1,
    entryNode: n.entryNode || false,
    freeNode: n.freeNode || false,
    ...(n.entries
      ? { entries: n.entries.map((e) => ({ name: e.name, index: e.index })) }
      : {}),
  };
}

// Parse simc DBC trait data to find DH nodes missing from Raidbots.
// DH is class_id 12 in simc's trait_data.
function supplementFromDbc(nodeById) {
  const traitFile =
    DATA_ENV === "ptr" ? "trait_data_ptr.inc" : "trait_data.inc";
  const traitPath = join(SIMC_DIR, "engine", "dbc", "generated", traitFile);
  let traitData;
  try {
    traitData = readFileSync(traitPath, "utf8");
  } catch {
    return 0;
  }

  // Format: { tree_idx, class_id, entry_id, node_id, max_ranks, req_points, def_id,
  //   spell_id, replace_spell, override_spell, row, col, sel_index, "name",
  //   { spec1, spec2, spec3, spec4 }, { starter1, starter2, starter3, starter4 },
  //   sub_tree_id, node_type }
  const DH_CLASS_ID = 12;
  const dbcNodes = new Map(); // nodeId → { entries, name, maxRanks, nodeType }
  const re =
    /\{\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*\d+,\s*\d+,\s*\d+,\s*\d+,\s*\d+,\s*[-\d]+,\s*[-\d]+,\s*(\d+),\s*"([^"]*)",\s*\{[^}]*\},\s*\{[^}]*\},\s*\d+,\s*(\d+)\s*\}/g;
  let m;
  while ((m = re.exec(traitData)) !== null) {
    const [, , classId, , nodeId, maxRanks, selIndex, name, nodeType] = m;
    if (+classId !== DH_CLASS_ID) continue;
    if (!dbcNodes.has(+nodeId)) {
      dbcNodes.set(+nodeId, {
        entries: [],
        maxRanks: +maxRanks,
        nodeType: +nodeType,
      });
    }
    dbcNodes.get(+nodeId).entries.push({ name, index: +selIndex });
  }

  let added = 0;
  for (const [nodeId, info] of dbcNodes) {
    if (nodeById.has(nodeId)) continue;
    // Node types: 0=normal, 1=tiered, 2=choice, 3=selection
    const isChoice = info.nodeType === 2 || info.nodeType === 3;
    nodeById.set(nodeId, {
      id: nodeId,
      name: info.entries.map((e) => e.name).join(" / "),
      type: isChoice ? "choice" : "single",
      maxRanks: info.maxRanks,
      entryNode: false,
      freeNode: false,
      ...(isChoice
        ? { entries: info.entries.sort((a, b) => a.index - b.index) }
        : {}),
    });
    added++;
  }

  return added;
}

async function fetchRaidbotsTalents() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log(`Fetching ${RAIDBOTS_TALENTS}...`);
  const res = await fetch(RAIDBOTS_TALENTS, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const allTrees = await res.json();
  const vdh = allTrees.find((t) => t.specId === SPEC_ID);
  if (!vdh) {
    const available = allTrees.map((t) => `${t.specName} (${t.specId})`);
    throw new Error(
      `specId ${SPEC_ID} not found. Available: ${available.join(", ")}`,
    );
  }

  const output = {
    className: vdh.className,
    specName: vdh.specName,
    specId: vdh.specId,
    classNodes: vdh.classNodes,
    specNodes: vdh.specNodes,
    heroNodes: vdh.heroNodes,
    subTreeNodes: vdh.subTreeNodes,
    heroSubtrees: {},
  };

  // Group hero nodes by subtree
  for (const node of vdh.heroNodes) {
    const treeName = HERO_SUBTREES[node.subTreeId];
    if (!treeName) {
      throw new Error(
        `Unknown hero subtree ID: ${node.subTreeId} for node "${node.name}". Update HERO_SUBTREES in config.js.`,
      );
    }
    (output.heroSubtrees[treeName] ||= []).push(node);
  }

  writeFileSync(
    join(DATA_DIR, "raidbots-talents.json"),
    JSON.stringify(output, null, 2),
  );

  // Build full DH node list for talent string encode/decode.
  // The game client serializes talent strings against ALL class nodes (all specs,
  // all hero trees, selection nodes), sorted ascending by nodeID. We need the
  // full list to decode external strings (from game client, Wowhead, Raidbots).
  const dhSpecs = allTrees.filter((t) => t.className === vdh.className);
  const nodeById = new Map();
  for (const spec of dhSpecs) {
    for (const n of spec.classNodes) nodeById.set(n.id, simplifyNode(n));
    for (const n of spec.specNodes) nodeById.set(n.id, simplifyNode(n));
    for (const n of spec.heroNodes || []) nodeById.set(n.id, simplifyNode(n));
    for (const n of spec.subTreeNodes || [])
      nodeById.set(n.id, simplifyNode(n));
  }
  // Supplement with nodes from simc DBC that Raidbots doesn't have (e.g., new
  // expansion nodes not yet in PTR data). These are needed for bit-alignment
  // when decoding external talent strings.
  const dbcSupplemented = supplementFromDbc(nodeById);

  const fullNodeList = [...nodeById.values()].sort((a, b) => a.id - b.id);

  writeFileSync(
    join(DATA_DIR, "dh-all-nodes.json"),
    JSON.stringify(fullNodeList, null, 2),
  );

  console.log(
    `Wrote data/dh-all-nodes.json (${fullNodeList.length} nodes` +
      (dbcSupplemented > 0 ? `, +${dbcSupplemented} from simc DBC` : "") +
      `)`,
  );
  console.log(`Wrote data/raidbots-talents.json`);
  console.log(`  Class nodes: ${output.classNodes.length}`);
  console.log(`  Spec nodes: ${output.specNodes.length}`);
  console.log(`  Hero nodes: ${output.heroNodes.length}`);
  for (const [name, nodes] of Object.entries(output.heroSubtrees)) {
    console.log(`    ${name}: ${nodes.length}`);
  }

  const allNodes = [
    ...output.classNodes,
    ...output.specNodes,
    ...output.heroNodes,
  ];
  const choiceNodes = allNodes.filter((n) => n.type === "choice");
  console.log(`  Choice nodes: ${choiceNodes.length}`);

  const totalEntries = allNodes.reduce((sum, n) => sum + n.entries.length, 0);
  console.log(`  Total talent entries: ${totalEntries}`);
}

fetchRaidbotsTalents();
