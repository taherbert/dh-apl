// Generates a markdown report of spell/talent interactions.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

function generateReport() {
  const spells = JSON.parse(
    readFileSync(join(DATA_DIR, "spells.json"), "utf-8"),
  );
  const talents = JSON.parse(
    readFileSync(join(DATA_DIR, "talents.json"), "utf-8"),
  );
  const interactions = JSON.parse(
    readFileSync(join(DATA_DIR, "interactions.json"), "utf-8"),
  );

  const spellMap = new Map(spells.map((s) => [s.id, s]));
  const lines = [];

  lines.push("# Vengeance Demon Hunter — Ability & Talent Report");
  lines.push("");
  lines.push(
    `Generated from SimC midnight branch. ${spells.length} spells, ${Object.keys(interactions.byTalent).length} modifier sources.`,
  );
  lines.push("");

  // Active abilities section
  lines.push("## Active Abilities");
  lines.push("");

  const activeSpells = spells
    .filter(
      (s) =>
        !s.passive &&
        s.gcd &&
        (s.class?.includes("Demon Hunter") || s.class?.includes("Vengeance")),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const spell of activeSpells) {
    lines.push(`### ${spell.name} (${spell.id})`);
    lines.push("");

    const props = [];
    if (spell.school) props.push(`School: ${spell.school}`);
    if (spell.resource)
      props.push(`Cost: ${spell.resource.cost} ${spell.resource.type}`);
    if (spell.gcd) props.push(`GCD: ${spell.gcd}s`);
    if (spell.cooldown) props.push(`CD: ${spell.cooldown}s`);
    if (spell.charges)
      props.push(
        `Charges: ${spell.charges.count} (${spell.charges.cooldown}s)`,
      );
    if (spell.duration) props.push(`Duration: ${spell.duration}s`);
    if (spell.range) props.push(`Range: ${spell.range}yd`);
    if (props.length) lines.push(props.join(" | "));

    if (spell.description) {
      lines.push("");
      lines.push(`> ${spell.description.replace(/\n/g, " ")}`);
    }

    // Show modifiers
    const mods = interactions.bySpell[spell.id];
    if (mods?.modifiers?.length) {
      lines.push("");
      lines.push("**Modified by:**");
      for (const m of mods.modifiers) {
        const tree = m.heroSpec ? `hero:${m.heroSpec}` : m.tree || "";
        lines.push(`- ${m.source} (${m.type})${tree ? ` [${tree}]` : ""}`);
      }
    }
    lines.push("");
  }

  // Talent trees section
  lines.push("## Talent Trees");
  lines.push("");

  for (const [treeName, treeData] of [
    ["Class", talents.class],
    ["Spec (Vengeance)", talents.spec],
    ...Object.entries(talents.hero).map(([name, data]) => [
      `Hero: ${name}`,
      data,
    ]),
  ]) {
    lines.push(`### ${treeName} (${treeData.talents.length} talents)`);
    lines.push("");

    // Group by row
    const byRow = new Map();
    for (const t of treeData.talents) {
      if (!byRow.has(t.row)) byRow.set(t.row, []);
      byRow.get(t.row).push(t);
    }

    for (const [row, rowTalents] of [...byRow.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      lines.push(`**Row ${row}:**`);
      for (const t of rowTalents.sort((a, b) => a.col - b.col)) {
        const typeTag = t.type ? ` [${t.type}]` : "";
        lines.push(`- (${t.col}) **${t.name}** (${t.spellId})${typeTag}`);

        // Show what this talent modifies
        const targets = interactions.byTalent[t.spellId];
        if (targets?.targets?.length) {
          for (const tgt of targets.targets) {
            lines.push(`  → ${tgt.spell} (${tgt.type})`);
          }
        }

        // Show description
        if (t.description) {
          const desc = t.description.replace(/\n/g, " ").substring(0, 200);
          lines.push(`  _${desc}${t.description.length > 200 ? "..." : ""}_`);
        }
      }
      lines.push("");
    }
  }

  // Resource flow section
  lines.push("## Resource Flow");
  lines.push("");

  lines.push("### Fury Generators");
  const furyGen = spells.filter(
    (s) =>
      s.description?.toLowerCase().includes("generates") &&
      s.description?.toLowerCase().includes("fury") &&
      !s.passive,
  );
  for (const s of furyGen) lines.push(`- ${s.name} (${s.id})`);

  lines.push("");
  lines.push("### Fury Spenders");
  const furySpend = spells.filter(
    (s) => s.resource?.type === "Fury" && !s.passive,
  );
  for (const s of furySpend)
    lines.push(`- ${s.name} (${s.id}): ${s.resource.cost} Fury`);

  lines.push("");
  lines.push("### Soul Fragment Generators");
  const soulGen = spells.filter(
    (s) =>
      s.description?.toLowerCase().includes("soul fragment") &&
      (s.description?.toLowerCase().includes("generat") ||
        s.description?.toLowerCase().includes("creat")),
  );
  for (const s of soulGen) lines.push(`- ${s.name} (${s.id})`);

  lines.push("");
  lines.push("### Soul Fragment Consumers");
  const soulConsume = spells.filter(
    (s) =>
      s.triggeredBy?.some((t) => t.name?.includes("Soul Fragment")) ||
      (s.description?.toLowerCase().includes("consume") &&
        s.description?.toLowerCase().includes("soul fragment")),
  );
  for (const s of soulConsume) lines.push(`- ${s.name} (${s.id})`);

  lines.push("");

  const report = lines.join("\n");
  writeFileSync(join(DATA_DIR, "ability-report.md"), report);
  console.log(`Wrote data/ability-report.md (${lines.length} lines)`);
}

generateReport();
