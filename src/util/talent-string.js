// Encode/decode WoW talent loadout strings (the base64 strings used in-game,
// on Wowhead, Raidbots, etc.). Format defined by Blizzard in
// Blizzard_ClassTalentImportExport.lua; this is a port of the simc C++
// implementation in player.cpp (generate_traits_hash / parse_traits_hash).
//
// Node iteration order: ascending by nodeID, matching C_Traits.GetTreeNodes().
//
// IMPORTANT: The game client encodes against the full CLASS node list (all specs,
// all hero trees, selection nodes) from C_Traits.GetTreeNodes(). Use the full DH
// node list from data/dh-all-nodes.json (built by raidbots.js) for compatibility
// with external strings. Talent strings are version-specific: strings from a
// different expansion/patch may not round-trip if the DBC node list changed.

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BYTE_SIZE = 6; // bits per base64 character

const VERSION = 2;
const VERSION_BITS = 8;
const SPEC_BITS = 16;
const TREE_BITS = 128;
const RANK_BITS = 6;
const CHOICE_BITS = 2;

// --- Bit stream reader/writer ---

function createWriter() {
  let head = 0;
  let byte = 0;
  let out = "";

  return {
    write(bits, value) {
      for (let i = 0; i < bits; i++) {
        const bit = head % BYTE_SIZE;
        head++;
        byte += ((value >> Math.min(i, 31)) & 1) << bit;
        if (bit === BYTE_SIZE - 1) {
          out += BASE64[byte];
          byte = 0;
        }
      }
    },
    flush() {
      if (head % BYTE_SIZE) out += BASE64[byte];
      return out;
    },
  };
}

function createReader(str) {
  let head = 0;
  let byte = BASE64.indexOf(str[0]);

  return {
    read(bits) {
      let val = 0;
      for (let i = 0; i < bits; i++) {
        const bit = head % BYTE_SIZE;
        head++;
        val += ((byte >> bit) & 1) << Math.min(i, 31);
        if (bit === BYTE_SIZE - 1) {
          const nextIdx = Math.floor(head / BYTE_SIZE);
          byte = nextIdx < str.length ? BASE64.indexOf(str[nextIdx]) : 0;
        }
      }
      return val;
    },
    get bitsRemaining() {
      return str.length * BYTE_SIZE - head;
    },
  };
}

// --- Encode ---

// Encode a talent build into a loadout string.
//
// specId: number — WoW specialization ID (e.g., 581 for Vengeance DH)
// nodes: array of { id, maxRanks, type, entries?, freeNode?, entryNode? }
//        sorted ascending by id (all class + spec + hero nodes)
// selections: Map<nodeId, { rank, choiceIndex? }>
//        rank = 0 means not selected; choiceIndex is 0-based for choice nodes
//
// Returns: base64 loadout string
export function encode(specId, nodes, selections) {
  const w = createWriter();

  w.write(VERSION_BITS, VERSION);
  w.write(SPEC_BITS, specId);
  w.write(TREE_BITS, 0); // tree hash — 0-filled to bypass validation

  for (const node of nodes) {
    const sel = selections.get(node.id);
    const rank = sel?.rank || 0;
    const isGranted = node.freeNode || node.grantedForSpecs?.includes(specId);
    const maxRank = node.maxRanks || 1;

    if (rank === 0) {
      w.write(1, 0); // not selected
      continue;
    }

    w.write(1, 1); // selected

    // Purchased = rank exceeds the granted baseline (1 for granted nodes, 0 otherwise)
    const initRank = isGranted ? 1 : 0;
    if (rank > initRank) {
      w.write(1, 1); // purchased
    } else {
      w.write(1, 0); // not purchased (granted only)
      continue;
    }

    // Partial rank
    if (rank === maxRank) {
      w.write(1, 0); // fully ranked
    } else {
      w.write(1, 1); // partially ranked
      w.write(RANK_BITS, rank);
    }

    // Choice node
    if (node.type === "choice" || node.type === "subtree") {
      w.write(1, 1);
      w.write(CHOICE_BITS, sel.choiceIndex || 0);
    } else {
      w.write(1, 0);
    }
  }

  return w.flush();
}

// --- Decode ---

// Decode a loadout string into talent selections.
//
// str: base64 loadout string
// nodes: array of { id, maxRanks, type, entries?, freeNode?, entryNode? }
//        sorted ascending by id (all class + spec + hero nodes)
//
// Returns: { specId, selections: Map<nodeId, { rank, choiceIndex? }> }
export function decode(str, nodes) {
  // Validate characters
  for (const ch of str) {
    if (!BASE64.includes(ch)) {
      throw new Error(`Invalid character '${ch}' in talent string`);
    }
  }

  const minBits = VERSION_BITS + SPEC_BITS + TREE_BITS;
  if (str.length * BYTE_SIZE < minBits) {
    throw new Error("Talent string too short");
  }

  const r = createReader(str);

  const version = r.read(VERSION_BITS);
  if (version !== VERSION) {
    throw new Error(`Unsupported serialization version: ${version}`);
  }

  const specId = r.read(SPEC_BITS);
  r.read(TREE_BITS); // tree hash — ignored

  const selections = new Map();

  for (const node of nodes) {
    if (r.bitsRemaining < 1) break;

    const selected = r.read(1);
    if (!selected) continue;

    const isGranted = node.freeNode || node.grantedForSpecs?.includes(specId);
    const maxRank = node.maxRanks || 1;
    let rank = maxRank;
    let choiceIndex;

    const purchased = r.read(1);
    if (!purchased) {
      // Granted at rank 1, not purchased
      rank = 1;
    } else {
      const partial = r.read(1);
      if (partial) {
        rank = r.read(RANK_BITS);
      }

      const isChoice = r.read(1);
      if (isChoice) {
        choiceIndex = r.read(CHOICE_BITS);
      }
    }

    selections.set(node.id, {
      rank,
      ...(choiceIndex !== undefined ? { choiceIndex } : {}),
    });
  }

  return { specId, selections };
}

// --- Helpers for integration with our data model ---

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPEC_ID as CONFIG_SPEC_ID, HERO_SUBTREES } from "../engine/startup.js";
import { dataDir, dataFile } from "../engine/paths.js";
import { normalizeSimcName } from "./validate-build.js";

// Load the full DH node list from dh-all-nodes.json (all specs, all hero trees).
// Required for decoding external talent strings (game client, Wowhead, Raidbots).
export function loadFullNodeList(dataDirOverride) {
  return JSON.parse(
    readFileSync(
      join(dataDirOverride || dataDir(), "dh-all-nodes.json"),
      "utf8",
    ),
  );
}

// Build a spec-only sorted node list from raidbots-talents.json data.
// Sufficient for encoding builds and round-tripping our own strings,
// but NOT for decoding external strings. Use loadFullNodeList() for that.
export function buildNodeList(data) {
  const allNodes = [
    ...data.classNodes,
    ...data.specNodes,
    ...Object.values(data.heroSubtrees).flat(),
  ];
  return allNodes.sort((a, b) => a.id - b.id);
}

// Convert a build object (from talent-combos.js) to a selections Map.
export function buildToSelections(build, data) {
  const selections = new Map();

  // Class nodes
  for (const id of build.classNodes) {
    const rank =
      build.classRanks?.[id] ||
      data.classNodes.find((n) => n.id === id)?.maxRanks ||
      1;
    selections.set(id, { rank });
  }

  // Spec nodes
  for (const id of build.specNodes) {
    const rank =
      build.specRanks?.[id] ||
      data.specNodes.find((n) => n.id === id)?.maxRanks ||
      1;
    const sel = { rank };
    // Check if this is a choice node with a specific choice
    if (build.specChoices?.[id] !== undefined) {
      sel.choiceIndex = build.specChoices[id];
    }
    selections.set(id, sel);
  }

  // Hero nodes
  for (const id of build.heroNodes || []) {
    const heroTree = data.heroSubtrees[build.heroTree];
    const node = heroTree?.find((n) => n.id === id);
    if (!node) continue;

    const sel = { rank: node.maxRanks || 1 };
    if (build.heroChoices?.[id] !== undefined) {
      const chosenEntry = build.heroChoices[id];
      // Find the index of the chosen entry
      if (node.entries) {
        const idx = node.entries.findIndex(
          (e) =>
            e.name === chosenEntry.name || e.entryId === chosenEntry.entryId,
        );
        if (idx >= 0) sel.choiceIndex = idx;
      }
    }
    selections.set(id, sel);
  }

  // Hero tree selector node — "subtree" type node in the full node list that
  // activates the chosen hero tree. Without this, SimC won't enable hero abilities.
  // Multiple subtree nodes exist (one per spec: VDH=99823 AR/Anni, Havoc=99824 AR/FS,
  // Devourer=108704 Anni/VS). Disambiguate by finding the node whose entries ALL match
  // the current spec's available hero trees (from data.heroSubtrees keys).
  if (build.heroTree) {
    const fullNodes = loadFullNodeList();
    const heroTreeNames = new Set(Object.keys(data.heroSubtrees || {}));
    const selectorNode = fullNodes.find(
      (n) =>
        n.type === "subtree" &&
        n.entries?.length > 0 &&
        n.entries.every((e) => heroTreeNames.has(e.name)),
    );
    if (selectorNode?.entries) {
      const choiceIdx = selectorNode.entries.findIndex(
        (e) => e.name === build.heroTree,
      );
      if (choiceIdx >= 0) {
        selections.set(selectorNode.id, { rank: 1, choiceIndex: choiceIdx });
      }
    }
  }

  return selections;
}

// Convert a selections Map back to a partial build description.
// Returns { classNodes, classRanks, specNodes, specRanks, specChoices, heroNodes, heroChoices }
export function selectionsToNodeSets(selections, data) {
  const classNodeIds = new Set(data.classNodes.map((n) => n.id));
  const specNodeIds = new Set(data.specNodes.map((n) => n.id));
  const heroNodeIds = new Map(); // id → tree name
  for (const [treeName, nodes] of Object.entries(data.heroSubtrees)) {
    for (const n of nodes) heroNodeIds.set(n.id, treeName);
  }

  const result = {
    classNodes: [],
    classRanks: {},
    specNodes: [],
    specRanks: {},
    specChoices: {},
    heroTree: null,
    heroNodes: [],
    heroChoices: {},
  };

  for (const [id, sel] of selections) {
    if (classNodeIds.has(id)) {
      result.classNodes.push(id);
      result.classRanks[id] = sel.rank;
    } else if (specNodeIds.has(id)) {
      result.specNodes.push(id);
      result.specRanks[id] = sel.rank;
      if (sel.choiceIndex !== undefined) {
        result.specChoices[id] = sel.choiceIndex;
      }
    } else if (heroNodeIds.has(id)) {
      result.heroTree = heroNodeIds.get(id);
      result.heroNodes.push(id);
      if (sel.choiceIndex !== undefined) {
        const heroTree = data.heroSubtrees[result.heroTree];
        const node = heroTree.find((n) => n.id === id);
        if (node?.entries?.[sel.choiceIndex]) {
          result.heroChoices[id] = node.entries[sel.choiceIndex];
        }
      }
    }
  }

  return result;
}

// --- Override string → selections → hash ---

// Convert SimC override strings (class_talents/spec_talents/hero_talents) to a
// selections Map suitable for encode(). The inverse of what validateOverrides does
// for checking — here we produce encodable selections.
export function overridesToSelections(
  overrides,
  data,
  { heroChoiceLocks } = {},
) {
  const selections = new Map();

  // Build name→{node, tree, entryIndex} lookup (mirrors validateOverrides pattern)
  const nodeBySimcName = new Map();
  function addNode(n, tree) {
    const name = normalizeSimcName(n.name || n.entries?.[0]?.name || "");
    if (name) nodeBySimcName.set(name, { node: n, tree, entryIndex: 0 });
    if (n.entries) {
      for (let i = 0; i < n.entries.length; i++) {
        const eName = normalizeSimcName(n.entries[i].name || "");
        if (eName && !nodeBySimcName.has(eName)) {
          nodeBySimcName.set(eName, { node: n, tree, entryIndex: i });
        }
      }
    }
  }
  for (const n of data.classNodes) addNode(n, "class");
  for (const n of data.specNodes) addNode(n, "spec");

  // Parse class_talents and spec_talents override strings
  for (const key of ["class_talents", "spec_talents"]) {
    const str = overrides[key];
    if (!str) continue;
    for (const entry of str.split("/").filter(Boolean)) {
      const [name, rankStr] = entry.split(":");
      const rank = rankStr ? parseInt(rankStr, 10) : 1;
      const lookup = nodeBySimcName.get(normalizeSimcName(name));
      if (!lookup) {
        throw new Error(`Unknown talent "${name}" in ${key}`);
      }
      const sel = { rank };
      // Choice node: set choiceIndex from which entry name matched
      if (lookup.node.type === "choice") {
        sel.choiceIndex = lookup.entryIndex;
      }
      selections.set(lookup.node.id, sel);
    }
  }

  // Hero tree: select ALL nodes in the specified subtree
  const heroTreeName = overrides.hero_talents;
  if (heroTreeName) {
    // Case-insensitive hero tree lookup
    const heroTreeKey = Object.keys(data.heroSubtrees).find(
      (k) => normalizeSimcName(k) === normalizeSimcName(heroTreeName),
    );
    if (!heroTreeKey) {
      throw new Error(`Unknown hero tree "${heroTreeName}"`);
    }
    for (const node of data.heroSubtrees[heroTreeKey]) {
      const sel = { rank: node.maxRanks || 1 };
      if (node.type === "choice") {
        sel.choiceIndex = heroChoiceLocks?.[node.id] ?? 0;
      }
      selections.set(node.id, sel);
    }

    // Subtree selector node — disambiguate by matching spec's hero trees
    const fullNodes = loadFullNodeList();
    const heroTreeNames = new Set(Object.keys(data.heroSubtrees || {}));
    const selectorNode = fullNodes.find(
      (n) =>
        n.type === "subtree" &&
        n.entries?.length > 0 &&
        n.entries.every((e) => heroTreeNames.has(e.name)),
    );
    if (selectorNode?.entries) {
      const choiceIdx = selectorNode.entries.findIndex(
        (e) => normalizeSimcName(e.name) === normalizeSimcName(heroTreeName),
      );
      if (choiceIdx >= 0) {
        selections.set(selectorNode.id, { rank: 1, choiceIndex: choiceIdx });
      }
    }
  }

  return selections;
}

// High-level: convert override strings directly to a talent hash string.
export function overridesToHash(overrides, opts = {}) {
  const data = JSON.parse(
    readFileSync(dataFile("raidbots-talents.json"), "utf8"),
  );
  const fullNodes = loadFullNodeList();
  const selections = overridesToSelections(overrides, data, opts);
  return encode(CONFIG_SPEC_ID, fullNodes, selections);
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = JSON.parse(
    readFileSync(dataFile("raidbots-talents.json"), "utf8"),
  );
  // Use full DH node list for CLI (supports decoding external strings)
  const nodes = loadFullNodeList();

  const arg = process.argv[2];

  if (!arg) {
    console.log("Usage:");
    console.log(
      "  node src/util/talent-string.js <loadout-string>      # decode",
    );
    console.log(
      "  node src/util/talent-string.js --generate <heroTree>  # generate hash (all talents at max rank)",
    );
    console.log(
      "  node src/util/talent-string.js --test                 # round-trip test",
    );
    process.exit(0);
  }

  if (arg === "--modify") {
    // Modify an existing talent string: add or remove specific talents by name.
    // Usage: --modify <base-hash> +TalentName:rank -TalentName ...
    const baseHash = process.argv[3];
    const ops = process.argv.slice(4);
    if (!baseHash || ops.length === 0) {
      console.error(
        "Usage: --modify <base-hash> [+TalentName:rank] [-TalentName] ...",
      );
      console.error(
        "  +TalentName:rank  — add/set talent to rank (rank optional, defaults to max)",
      );
      console.error("  -TalentName       — remove talent");
      process.exit(1);
    }

    const { specId, selections: sel } = decode(baseHash, nodes);
    const nodeByName = new Map();
    for (const n of nodes) {
      if (n.name) {
        // For tiered nodes, use just the first name segment
        const shortName = n.name.split(" / ")[0].toLowerCase();
        nodeByName.set(shortName, n);
      }
      // Also index by entry names
      for (const e of n.entries || []) {
        if (e.name) nodeByName.set(e.name.toLowerCase(), n);
      }
    }

    for (const op of ops) {
      const isAdd = op.startsWith("+");
      const isRemove = op.startsWith("-");
      if (!isAdd && !isRemove) {
        console.error(`Invalid op "${op}" — must start with + or -`);
        process.exit(1);
      }
      const parts = op.slice(1).split(":");
      const name = parts[0].toLowerCase().replace(/_/g, " ");
      const node = nodeByName.get(name);
      if (!node) {
        console.error(`Unknown talent: "${parts[0]}"`);
        console.error("Available talents (spec):");
        for (const n of data.specNodes) {
          const sn = (n.name || n.entries?.[0]?.name || "").split(" / ")[0];
          console.error(`  ${sn}`);
        }
        process.exit(1);
      }
      if (isRemove) {
        sel.delete(node.id);
        console.error(`Removed: ${node.name} (node ${node.id})`);
      } else {
        const rank = parts[1] ? +parts[1] : node.maxRanks || 1;
        const entry = { rank };
        if (node.type === "choice" || node.type === "subtree") {
          entry.choiceIndex = sel.get(node.id)?.choiceIndex || 0;
        }
        sel.set(node.id, entry);
        console.error(
          `Set: ${node.name} (node ${node.id}) to rank ${rank}/${node.maxRanks || 1}`,
        );
      }
    }

    // Validate point budgets and gate requirements
    const BUDGETS = { class: 34, spec: 34, hero: 13 };
    const classNodeIds = new Set(data.classNodes.map((n) => n.id));
    const specNodeIds = new Set(data.specNodes.map((n) => n.id));
    const heroNodeIds = new Map();
    for (const treeNodes of Object.values(data.heroSubtrees)) {
      for (const n of treeNodes) heroNodeIds.set(n.id, n);
    }
    const subTreeIds = new Set((data.subTreeNodes || []).map((n) => n.id));

    // Determine which nodes are truly free (granted by the game, not purchasable).
    // DBC id_spec_starter marks granted nodes. Raidbots entryNode is unreliable
    // for tiered/pinnacle talents. freeNode is reliable.
    const freeNodeIds = new Set();
    const allDataNodes = [
      ...data.classNodes,
      ...data.specNodes,
      ...Object.values(data.heroSubtrees).flat(),
    ];
    for (const n of allDataNodes) {
      if (n.freeNode) freeNodeIds.add(n.id);
    }
    // Also check grantedForSpecs from DBC supplement in full node list
    for (const n of nodes) {
      if (n.grantedForSpecs?.includes(specId)) freeNodeIds.add(n.id);
    }

    function countPoints(nodeSet) {
      let spent = 0;
      for (const [id, s] of sel) {
        if (!nodeSet.has(id)) continue;
        if (freeNodeIds.has(id)) continue;
        if (subTreeIds.has(id)) continue;
        spent += s.rank;
      }
      return spent;
    }

    function checkGates(treeNodes, label) {
      // Group nodes by gate, count points spent below each gate threshold
      const gates = [...new Set(treeNodes.map((n) => n.reqPoints || 0))]
        .filter((g) => g > 0)
        .sort((a, b) => a - b);
      for (const gate of gates) {
        let spentBelow = 0;
        for (const n of treeNodes) {
          if ((n.reqPoints || 0) >= gate) continue;
          const s = sel.get(n.id);
          if (!s) continue;
          if (freeNodeIds.has(n.id)) continue;
          spentBelow += s.rank;
        }
        if (spentBelow < gate) {
          console.error(
            `ERROR: ${label} gate requires ${gate} points, only ${spentBelow} spent in prior sections`,
          );
          process.exit(1);
        }
      }
    }

    const classSpent = countPoints(classNodeIds, "Class");
    const specSpent = countPoints(specNodeIds, "Spec");
    const heroSpent = countPoints(new Set(heroNodeIds.keys()), "Hero");

    let errors = false;
    for (const [label, spent, budget] of [
      ["Class", classSpent, BUDGETS.class],
      ["Spec", specSpent, BUDGETS.spec],
      ["Hero", heroSpent, BUDGETS.hero],
    ]) {
      if (spent !== budget) {
        console.error(
          `ERROR: ${label} tree has ${spent} points spent, must be exactly ${budget}`,
        );
        errors = true;
      }
    }

    checkGates(data.classNodes, "Class");
    checkGates(data.specNodes, "Spec");

    if (errors) {
      console.error(
        "\nBuild is INVALID. Fix point allocation before encoding.",
      );
      process.exit(1);
    }

    console.error("\nValidation: PASS");
    const encoded = encode(specId, nodes, sel);
    console.log(encoded);
  } else if (arg === "--test") {
    // Round-trip test: build a mock selection, encode, decode, verify
    const sel = new Map();

    // Select all class entry/free nodes
    for (const n of data.classNodes) {
      if (n.entryNode || n.freeNode) sel.set(n.id, { rank: n.maxRanks || 1 });
    }
    // Select first 25 non-entry/non-free class nodes
    let count = 0;
    for (const n of data.classNodes) {
      if (sel.has(n.id)) continue;
      if (count >= 25) break;
      const entry = { rank: n.maxRanks || 1 };
      if (n.type === "choice") entry.choiceIndex = 0;
      sel.set(n.id, entry);
      count++;
    }

    // Select all spec entry/free nodes
    for (const n of data.specNodes) {
      if (n.entryNode || n.freeNode) sel.set(n.id, { rank: n.maxRanks || 1 });
    }
    // Select first 25 non-entry/non-free spec nodes, handle choices
    count = 0;
    for (const n of data.specNodes) {
      if (sel.has(n.id)) continue;
      if (count >= 25) break;
      const entry = { rank: n.maxRanks || 1 };
      if (n.type === "choice") entry.choiceIndex = 0;
      sel.set(n.id, entry);
      count++;
    }

    // Select all hero nodes from the first hero tree
    const firstHeroTree = Object.keys(data.heroSubtrees)[0];
    for (const n of data.heroSubtrees[firstHeroTree]) {
      const entry = { rank: n.maxRanks || 1 };
      if (n.type === "choice") entry.choiceIndex = 1;
      sel.set(n.id, entry);
    }

    const encoded = encode(CONFIG_SPEC_ID, nodes, sel);
    console.log(`Encoded: ${encoded}`);
    console.log(`Length: ${encoded.length} chars`);

    const decoded = decode(encoded, nodes);
    console.log(`Decoded spec ID: ${decoded.specId}`);
    console.log(`Decoded selections: ${decoded.selections.size} nodes`);

    // Verify round-trip
    let mismatches = 0;
    for (const [id, orig] of sel) {
      const dec = decoded.selections.get(id);
      if (!dec) {
        console.log(`  MISSING: node ${id}`);
        mismatches++;
      } else if (dec.rank !== orig.rank) {
        console.log(`  RANK MISMATCH: node ${id}: ${orig.rank} → ${dec.rank}`);
        mismatches++;
      } else if (
        (dec.choiceIndex ?? undefined) !== (orig.choiceIndex ?? undefined)
      ) {
        console.log(
          `  CHOICE MISMATCH: node ${id}: ${orig.choiceIndex} → ${dec.choiceIndex}`,
        );
        mismatches++;
      }
    }
    for (const [id] of decoded.selections) {
      if (!sel.has(id)) {
        console.log(`  EXTRA: node ${id}`);
        mismatches++;
      }
    }
    console.log(
      mismatches === 0
        ? "\nRound-trip: PASS"
        : `\nRound-trip: FAIL (${mismatches} mismatches)`,
    );
  } else {
    // Decode mode
    try {
      const result = decode(arg, nodes);
      console.log(`Spec ID: ${result.specId}`);
      console.log(`Selected nodes: ${result.selections.size}\n`);

      const nodeSets = selectionsToNodeSets(result.selections, data);
      console.log(`Class nodes: ${nodeSets.classNodes.length}`);
      console.log(`Spec nodes: ${nodeSets.specNodes.length}`);
      console.log(`Hero tree: ${nodeSets.heroTree || "none"}`);
      console.log(`Hero nodes: ${nodeSets.heroNodes.length}`);

      // Print selected talent names
      const nodeById = new Map();
      for (const n of nodes) nodeById.set(n.id, n);

      console.log("\nSelected talents:");
      for (const [id, sel] of result.selections) {
        const node = nodeById.get(id);
        if (!node) continue;
        let name = node.name;
        if (sel.choiceIndex !== undefined && node.entries) {
          name = node.entries[sel.choiceIndex]?.name || name;
        }
        const rankStr =
          (node.maxRanks || 1) > 1 ? ` (${sel.rank}/${node.maxRanks})` : "";
        console.log(`  ${id} ${name}${rankStr}`);
      }
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  }
}
