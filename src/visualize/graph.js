// Generates a Mermaid graph of spell-talent interactions.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

function generateGraph() {
  const interactions = JSON.parse(
    readFileSync(join(DATA_DIR, "interactions.json"), "utf-8"),
  );
  const spells = JSON.parse(
    readFileSync(join(DATA_DIR, "spells.json"), "utf-8"),
  );

  const spellMap = new Map(spells.map((s) => [s.id, s]));
  const lines = [];

  lines.push("graph LR");

  // Collect unique nodes
  const nodes = new Set();
  const edges = [];

  // Focus on talent interactions (skip unknown external refs)
  for (const int of interactions.interactions) {
    if (!int.source.isTalent) continue;

    const srcId = `t${int.source.id}`;
    const tgtId = `s${int.target.id}`;

    if (!nodes.has(srcId)) {
      const style =
        int.source.tree === "hero"
          ? `${srcId}[/"${sanitize(int.source.name)}"/]`
          : `${srcId}["${sanitize(int.source.name)}"]`;
      lines.push(`  ${style}`);
      nodes.add(srcId);
    }
    if (!nodes.has(tgtId)) {
      lines.push(`  ${tgtId}(("${sanitize(int.target.name)}"))`);
      nodes.add(tgtId);
    }

    const label = int.type !== "unknown" ? int.type.replace("_", " ") : "";
    edges.push(`  ${srcId} -->|${label}| ${tgtId}`);
  }

  lines.push(...edges);

  // Style hero tree nodes differently
  const heroNodes = interactions.interactions
    .filter((i) => i.source.tree === "hero" && i.source.isTalent)
    .map((i) => `t${i.source.id}`);

  if (heroNodes.length) {
    lines.push(`  classDef hero fill:#f9d,stroke:#333`);
    lines.push(`  class ${[...new Set(heroNodes)].join(",")} hero`);
  }

  const graph = lines.join("\n");
  writeFileSync(join(DATA_DIR, "interaction-graph.mermaid"), graph);
  console.log(
    `Wrote data/interaction-graph.mermaid (${nodes.size} nodes, ${edges.length} edges)`,
  );
}

function sanitize(str) {
  return str.replace(/"/g, "'").replace(/[<>]/g, "");
}

generateGraph();
