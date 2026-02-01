// Fetches Vengeance DH talent data from Raidbots and saves filtered output.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RAIDBOTS_TALENTS, SPEC_ID, HERO_SUBTREES } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

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
