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

// Load the full DH node list from dh-all-nodes.json (all specs, all hero trees).
// Required for decoding external talent strings (game client, Wowhead, Raidbots).
import { readFileSync as _readFileSync } from "node:fs";
import { join as _join, dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";

const _defaultDataDir = _join(
  _dirname(_fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
);

export function loadFullNodeList(dataDir) {
  return JSON.parse(
    _readFileSync(
      _join(dataDir || _defaultDataDir, "dh-all-nodes.json"),
      "utf8",
    ),
  );
}

// Build a VDH-only sorted node list from raidbots-talents.json data.
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

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const DATA_DIR = join(__dirname, "..", "..", "data");
  const data = JSON.parse(
    readFileSync(join(DATA_DIR, "raidbots-talents.json"), "utf8"),
  );
  // Use full DH node list for CLI (supports decoding external strings)
  const nodes = loadFullNodeList(DATA_DIR);

  const arg = process.argv[2];

  if (!arg) {
    console.log("Usage:");
    console.log("  node src/util/talent-string.js <loadout-string>   # decode");
    console.log(
      "  node src/util/talent-string.js --test              # round-trip test",
    );
    process.exit(0);
  }

  if (arg === "--test") {
    // Round-trip test: build a mock selection, encode, decode, verify
    const SPEC_ID = 581;
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

    // Select all Aldrachi Reaver hero nodes
    for (const n of data.heroSubtrees["Aldrachi Reaver"]) {
      const entry = { rank: n.maxRanks || 1 };
      if (n.type === "choice") entry.choiceIndex = 1;
      sel.set(n.id, entry);
    }

    const encoded = encode(SPEC_ID, nodes, sel);
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
