// Spec+hero talent fingerprinting for build deduplication.
// Compares only spec and hero tree talent selections, ignoring class talents.
// Two builds with identical spec+hero fingerprints are functionally equivalent
// for DPS purposes regardless of class talent choices (utility/defensive).

import { readFileSync } from "node:fs";
import {
  decode,
  loadFullNodeList,
  selectionsToNodeSets,
} from "./talent-string.js";
import { dataFile } from "../engine/paths.js";

// Module-level caches — these files don't change within a process lifetime.
let _fullNodes = null;
let _raidbots = null;

function getFullNodes() {
  return (_fullNodes ||= loadFullNodeList());
}

function getRaidbots() {
  return (_raidbots ||= JSON.parse(
    readFileSync(dataFile("raidbots-talents.json"), "utf8"),
  ));
}

// Compute a canonical fingerprint from spec+hero node selections.
// Returns a string that can be compared for equality.
export function specHeroFingerprint(hash) {
  const fullNodes = getFullNodes();
  const data = getRaidbots();

  const { selections } = decode(hash, fullNodes);
  const nodeSets = selectionsToNodeSets(selections, data);

  const specParts = [];
  for (const id of nodeSets.specNodes.sort((a, b) => a - b)) {
    const rank = nodeSets.specRanks[id] || 1;
    const choice = nodeSets.specChoices[id];
    specParts.push(
      choice !== undefined ? `${id}:${rank}:c${choice}` : `${id}:${rank}`,
    );
  }

  const heroParts = [];
  for (const id of nodeSets.heroNodes.sort((a, b) => a - b)) {
    const heroTree = data.heroSubtrees[nodeSets.heroTree];
    const node = heroTree?.find((n) => n.id === id);
    const rank = node?.maxRanks || 1;
    const choice = nodeSets.heroChoices[id];
    const choiceStr =
      choice !== undefined ? `:c${choice.entryId || choice.name || 0}` : "";
    heroParts.push(`${id}:${rank}${choiceStr}`);
  }

  return `spec[${specParts.join(",")}]hero[${heroParts.join(",")}]`;
}

// Detect which hero tree a talent hash uses.
export function detectHeroTree(hash) {
  const fullNodes = getFullNodes();
  const data = getRaidbots();
  const { selections } = decode(hash, fullNodes);
  const nodeSets = selectionsToNodeSets(selections, data);
  return nodeSets.heroTree || null;
}

// --- Talent abbreviations for display names ---

const TALENT_ABBREVS = {
  "Burning Alive": "BA",
  "Down in Flames": "DiF",
  "Cycle of Binding": "CoB",
  "Soul Carver": "SC",
  "Spirit Bomb": "SBomb",
  "Fiery Demise": "FD",
  "Charred Flesh": "CF",
  "Volatile Flameblood": "VFB",
  "Agonizing Flames": "AgF",
  "Sigil of Spite": "SoS",
  "Ascending Flame": "AscF",
  Soulmonger: "SM",
  "Perfectly Balanced Glaive": "PBG",
  "Tempered Steel": "TS",
  Retaliation: "Ret",
  Painbringer: "PB",
  "Soul Sigils": "SSig",
  // Hero choice nodes (for variant disambiguation)
  "Keen Engagement": "KE",
  "Preemptive Strike": "PS",
  Doomsayer: "Doom",
  "Harness the Cosmos": "HtC",
  // Devourer clusters
  "Singular Strikes": "SS",
  "Soulforged Blades": "SfB",
  "Devourer's Bite": "DB",
  "Demonic Instinct": "DI",
  "Voidglare Boon": "VgB",
  "Impending Apocalypse": "IA",
  "Star Fragments": "StF",
  Calamitous: "Cal",
  "The Hunt": "Hunt",
  "Rolling Torment": "RT",
  Voidrush: "VR",
  "Devourer's Edge": "DE",
  Emptiness: "Emp",
  "Soul Glutton": "SG",
  Eradicate: "Erad",
  // Devourer hero choice nodes
  "Student of Suffering": "SoS",
  Flamebound: "FB",
};

export function abbrev(name) {
  return TALENT_ABBREVS[name] || name;
}

// Detect which hero choice variant a build uses for unlocked choice nodes.
// Returns { variant: string|null, choices: { [nodeId]: entryName } }
// Only reports unlocked choice nodes (those NOT in choiceLocks).
export function detectHeroVariant(hash, heroSubtrees, choiceLocks = {}) {
  const fullNodes = getFullNodes();
  const data = getRaidbots();

  const { selections } = decode(hash, fullNodes);
  const nodeSets = selectionsToNodeSets(selections, data);

  if (!nodeSets.heroTree) return { variant: null, choices: {} };

  const treeName = nodeSets.heroTree;
  const treeNodes = heroSubtrees?.[treeName] || data.heroSubtrees?.[treeName];
  if (!treeNodes) return { variant: null, choices: {} };

  const locks = choiceLocks || {};
  const choices = {};
  let variant = null;

  for (const cNode of treeNodes) {
    if (cNode.type !== "choice" || !cNode.entries || cNode.entries.length <= 1)
      continue;
    if (cNode.id in locks) continue; // Skip locked choices

    const heroChoice = nodeSets.heroChoices[cNode.id];
    if (heroChoice?.name) {
      choices[cNode.id] = heroChoice.name;
      // First unlocked choice determines the variant name
      if (!variant) variant = heroChoice.name;
    }
  }

  return { variant, choices };
}

// Decode a talent hash into spec talent names and hero tree.
// Returns { specTalents: string[], heroTree: string|null }
export function decodeTalentNames(hash) {
  const fullNodes = getFullNodes();
  const data = getRaidbots();

  const { selections } = decode(hash, fullNodes);
  const nodeSets = selectionsToNodeSets(selections, data);

  // Build spec node ID → talent name lookup
  const specNodeById = new Map();
  for (const n of data.specNodes) {
    specNodeById.set(n.id, n);
  }

  const specTalents = [];
  for (const id of nodeSets.specNodes) {
    const node = specNodeById.get(id);
    if (!node) continue;

    // For choice nodes, use the selected entry name
    if (
      node.type === "choice" &&
      nodeSets.specChoices[id] !== undefined &&
      node.entries
    ) {
      const entry = node.entries[nodeSets.specChoices[id]];
      if (entry?.name) {
        specTalents.push(entry.name);
        continue;
      }
    }

    // Use primary name (first segment for tiered nodes like "X / Y")
    const name = node.name || node.entries?.[0]?.name;
    if (name) specTalents.push(name.split(" / ")[0]);
  }

  return { specTalents, heroTree: nodeSets.heroTree || null };
}
