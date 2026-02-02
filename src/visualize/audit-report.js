// Generates a comprehensive interaction audit report in Markdown.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const DATA_DIR = join(ROOT, "data");

function generateAuditReport() {
  const talents = JSON.parse(
    readFileSync(join(DATA_DIR, "talents.json"), "utf-8"),
  );
  const interactions = JSON.parse(
    readFileSync(join(DATA_DIR, "interactions.json"), "utf-8"),
  );

  const allTalents = [
    ...talents.class.talents.map((t) => ({ ...t, treeName: "class" })),
    ...talents.spec.talents.map((t) => ({ ...t, treeName: "spec" })),
    ...Object.entries(talents.hero).flatMap(([name, h]) =>
      h.talents.map((t) => ({ ...t, treeName: "hero", heroSpec: name })),
    ),
  ];

  const talentCategories = interactions.talentCategories || {};
  const byTalent = interactions.byTalent || {};

  const lines = [];
  const w = (s = "") => lines.push(s);

  // === Summary ===
  w("# Interaction Audit Report");
  w();
  w(`Generated: ${new Date().toISOString()}`);
  w();

  // Totals by type
  const typeCounts = {};
  const methodCounts = {};
  const confidenceCounts = {};
  const treeCounts = {};
  for (const i of interactions.interactions) {
    typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
    methodCounts[i.discoveryMethod] =
      (methodCounts[i.discoveryMethod] || 0) + 1;
    confidenceCounts[i.confidence] = (confidenceCounts[i.confidence] || 0) + 1;
    const tree = i.source.tree || "non-talent";
    treeCounts[tree] = (treeCounts[tree] || 0) + 1;
  }

  w("## Summary");
  w();
  w(`- **Total interactions:** ${interactions.interactions.length}`);
  w(`- **Talents with interactions:** ${Object.keys(byTalent).length}`);
  w(`- **Total talents:** ${allTalents.length}`);
  w();

  w("### By Type");
  w();
  w("| Type | Count |");
  w("|------|-------|");
  for (const [type, count] of Object.entries(typeCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    w(`| ${type} | ${count} |`);
  }
  w();

  w("### By Discovery Method");
  w();
  w("| Method | Count |");
  w("|--------|-------|");
  for (const [m, c] of Object.entries(methodCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    w(`| ${m} | ${c} |`);
  }
  w();

  w("### By Confidence");
  w();
  w("| Confidence | Count |");
  w("|------------|-------|");
  for (const [c, n] of Object.entries(confidenceCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    w(`| ${c} | ${n} |`);
  }
  w();

  w("### By Source Tree");
  w();
  w("| Tree | Count |");
  w("|------|-------|");
  for (const [t, c] of Object.entries(treeCounts).sort((a, b) => b[1] - a[1])) {
    w(`| ${t} | ${c} |`);
  }
  w();

  // === Talent Triage ===
  w("## Talent Triage");
  w();
  const triageCounts = {};
  for (const cat of Object.values(talentCategories)) {
    triageCounts[cat] = (triageCounts[cat] || 0) + 1;
  }
  w("| Category | Count |");
  w("|----------|-------|");
  for (const [cat, count] of Object.entries(triageCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    w(`| ${cat} | ${count} |`);
  }
  w();

  // === Per-Talent Detail ===
  w("## Per-Talent Detail");
  w();

  for (const tree of ["class", "spec"]) {
    const treeTalents =
      tree === "class" ? talents.class.talents : talents.spec.talents;
    w(`### ${tree.charAt(0).toUpperCase() + tree.slice(1)} Talents`);
    w();
    for (const t of treeTalents) {
      writeTalentSection(t, t.name);
    }
  }

  for (const [heroName, hero] of Object.entries(talents.hero)) {
    w(`### Hero: ${heroName}`);
    w();
    for (const t of hero.talents) {
      writeTalentSection(t, t.name);
    }
  }

  // === Cross-Tree Map ===
  w("## Cross-Tree Interactions");
  w();
  w("Hero talents that interact with spec/class abilities:");
  w();

  for (const i of interactions.interactions) {
    if (i.source.tree === "hero" && i.source.heroSpec) {
      const targetTalent = allTalents.find((t) => t.spellId === i.target.id);
      if (!targetTalent || targetTalent.treeName !== "hero") {
        w(
          `- **${i.source.name}** (${i.source.heroSpec}) → ${i.target.name} [${i.type}]`,
        );
      }
    }
  }
  w();

  // === Resource Economy ===
  w("## Resource Economy");
  w();
  w("Interactions involving resource generation/spending:");
  w();
  const resourceInteractions = interactions.interactions.filter(
    (i) =>
      i.type === "resource_modifier" ||
      i.mechanism?.includes("fury") ||
      i.mechanism?.includes("soul"),
  );
  for (const i of resourceInteractions) {
    w(
      `- ${i.source.name} → ${i.target.name} [${i.type}]${i.mechanism ? ` (${i.mechanism})` : ""}`,
    );
  }
  w();

  // === Gap List ===
  w("## Gaps");
  w();
  w("Talents with zero interactions (excluding stat passives):");
  w();

  const interactionSourceIds = new Set(Object.keys(byTalent).map(Number));
  for (const t of allTalents) {
    const cat = talentCategories[t.name];
    if (cat === "stat_passive" || cat === "has_interactions") continue;
    if (interactionSourceIds.has(t.spellId)) continue;

    w(
      `- **${t.name}** (${t.spellId}) — ${cat || "uncategorized"} [${t.treeName}${t.heroSpec ? "/" + t.heroSpec : ""}]`,
    );
  }
  w();

  // === Stat Passives ===
  w("## Stat Passives (Excluded from Coverage)");
  w();
  for (const t of allTalents) {
    if (talentCategories[t.name] === "stat_passive") {
      w(`- ${t.name} (${t.spellId})`);
    }
  }
  w();

  const report = lines.join("\n");
  const outPath = join(DATA_DIR, "audit-report.md");
  writeFileSync(outPath, report);
  console.log(`Wrote ${outPath}`);
  console.log(`  ${interactions.interactions.length} interactions audited`);
  console.log(`  ${allTalents.length} talents reviewed`);

  function writeTalentSection(t, name) {
    const cat = talentCategories[name] || "unknown";
    const talentData = byTalent[t.spellId];

    w(`#### ${name} (${t.spellId}) — ${cat}`);
    w();

    if (talentData) {
      w("| Target | Type | Method |");
      w("|--------|------|--------|");
      for (const tgt of talentData.targets) {
        w(`| ${tgt.spell} | ${tgt.type} | ${tgt.discoveryMethod} |`);
      }
    } else {
      w("_No outgoing interactions_");
    }

    // Incoming interactions
    const incoming = interactions.interactions.filter(
      (i) => i.target.id === t.spellId && i.source.id !== t.spellId,
    );
    if (incoming.length > 0) {
      w();
      w("**Incoming:**");
      for (const i of incoming) {
        w(`- ${i.source.name} [${i.type}, ${i.discoveryMethod}]`);
      }
    }
    w();
  }
}

generateAuditReport();
