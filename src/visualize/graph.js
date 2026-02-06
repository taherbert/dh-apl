// Generates a Mermaid graph of spell-talent interactions.

import { readFileSync, writeFileSync } from "node:fs";
import "../engine/startup.js";
import { dataFile } from "../engine/paths.js";

function generateGraph() {
  const interactions = JSON.parse(
    readFileSync(dataFile("interactions.json"), "utf-8"),
  );
  const spells = JSON.parse(readFileSync(dataFile("spells.json"), "utf-8"));

  const spellMap = new Map(spells.map((s) => [s.id, s]));
  const lines = [];

  lines.push("graph LR");

  // Collect unique nodes
  const nodes = new Set();
  const edges = [];

  // APL-relevant interaction types (excludes generic stat passives)
  const APL_TYPES = new Set([
    "buff_grant",
    "proc_trigger",
    "mechanic_change",
    "cooldown_modifier",
    "resource_modifier",
    "duration_modifier",
    "stacking_modifier",
    "spell_unlock",
  ]);

  for (const int of interactions.interactions) {
    // Include talent interactions always; non-talent only if APL-relevant type
    if (!int.source.isTalent) {
      if (!APL_TYPES.has(int.type)) continue;
    }
    // Skip unknowns from non-talent sources
    if (!int.source.isTalent && int.type === "unknown") continue;

    const srcId = `t${int.source.id}`;
    const tgtId = `s${int.target.id}`;

    if (!nodes.has(srcId)) {
      let style;
      if (int.source.tree === "hero") {
        style = `${srcId}[/"${sanitize(int.source.name)}"/]`;
      } else if (int.source.isTalent) {
        style = `${srcId}["${sanitize(int.source.name)}"]`;
      } else {
        // Non-talent sources: hexagon shape
        style = `${srcId}{{"${sanitize(int.source.name)}"}}`;
      }
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
  const heroNodeIds = interactions.interactions
    .filter((i) => i.source.tree === "hero")
    .map((i) => `t${i.source.id}`);

  if (heroNodeIds.length) {
    lines.push(`  classDef hero fill:#f9d,stroke:#333`);
    lines.push(`  class ${[...new Set(heroNodeIds)].join(",")} hero`);
  }

  // Style non-talent nodes
  const nonTalentIds = interactions.interactions
    .filter((i) => !i.source.isTalent && APL_TYPES.has(i.type))
    .map((i) => `t${i.source.id}`);

  if (nonTalentIds.length) {
    lines.push(`  classDef mechanic fill:#bdf,stroke:#333`);
    lines.push(`  class ${[...new Set(nonTalentIds)].join(",")} mechanic`);
  }

  const graph = lines.join("\n");
  writeFileSync(dataFile("interaction-graph.mermaid"), graph);
  console.log(
    `Wrote data/interaction-graph.mermaid (${nodes.size} nodes, ${edges.length} edges)`,
  );
}

function sanitize(str) {
  return str.replace(/"/g, "'").replace(/[<>]/g, "");
}

generateGraph();
