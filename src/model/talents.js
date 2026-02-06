// Structures talent data into organized class/spec/hero trees.
// Reads raidbots-talents.json (primary) and spells.json, outputs talents.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  HERO_SUBTREES,
  getDisplayNames,
  loadSpecAdapter,
} from "../engine/startup.js";
import { dataDir } from "../engine/paths.js";

function buildTalentTrees() {
  const raidbots = JSON.parse(
    readFileSync(join(dataDir(), "raidbots-talents.json"), "utf-8"),
  );

  const spellMap = new Map();
  if (existsSync(join(dataDir(), "spells.json"))) {
    const spells = JSON.parse(
      readFileSync(join(dataDir(), "spells.json"), "utf-8"),
    );
    for (const s of spells) spellMap.set(s.id, s);
  }

  const displayNames = getDisplayNames();
  const trees = {
    class: { name: displayNames.class, talents: [] },
    spec: { name: displayNames.spec, talents: [] },
    hero: Object.fromEntries(
      Object.values(HERO_SUBTREES).map((name) => [name, { talents: [] }]),
    ),
  };

  function processNode(node, treeName) {
    for (const entry of node.entries) {
      if (!entry.spellId) continue;
      const spell = spellMap.get(entry.spellId);
      const talent = {
        name: entry.name,
        nodeId: node.id,
        entryId: entry.id,
        definitionId: entry.definitionId,
        maxRank: entry.maxRanks || node.maxRanks,
        spellId: entry.spellId,
        spellName: spell?.name || entry.name,
        school: spell?.school || null,
        passive: entry.type === "passive",
        description: spell?.description || null,
        entryType: entry.type,
        posX: node.posX,
        posY: node.posY,
      };

      if (node.type === "choice") {
        talent.choiceNode = true;
        talent.choiceIndex = entry.index;
      }
      if (node.freeNode) talent.freeNode = true;
      if (node.entryNode) talent.entryNode = true;
      if (node.reqPoints) talent.reqPoints = node.reqPoints;

      if (spell) {
        talent.type = categorizeTalent(spell);
        if (spell.resource) talent.resource = spell.resource;
        if (spell.cooldown) talent.cooldown = spell.cooldown;
        if (spell.charges) talent.charges = spell.charges;
        if (spell.gcd) talent.gcd = spell.gcd;
        if (spell.duration) talent.duration = spell.duration;
        if (spell.affectingSpells) talent.affectedBy = spell.affectingSpells;
      } else {
        talent.type = entry.type === "passive" ? "passive" : "active_ability";
      }

      if (treeName === "class") {
        trees.class.talents.push(talent);
      } else if (treeName === "spec") {
        trees.spec.talents.push(talent);
      } else {
        trees.hero[treeName].talents.push(talent);
      }
    }
  }

  for (const node of raidbots.classNodes) processNode(node, "class");
  for (const node of raidbots.specNodes) processNode(node, "spec");
  for (const node of raidbots.heroNodes) {
    const heroTree = HERO_SUBTREES[node.subTreeId];
    if (heroTree) processNode(node, heroTree);
  }

  // Sort by position (top-to-bottom, left-to-right)
  const sortFn = (a, b) => a.posY - b.posY || a.posX - b.posX;
  trees.class.talents.sort(sortFn);
  trees.spec.talents.sort(sortFn);
  for (const hero of Object.values(trees.hero)) hero.talents.sort(sortFn);

  writeFileSync(
    join(dataDir(), "talents.json"),
    JSON.stringify(trees, null, 2),
  );

  console.log("Wrote data/talents.json");
  console.log(`  Class tree: ${trees.class.talents.length} talents`);
  console.log(`  Spec tree: ${trees.spec.talents.length} talents`);
  for (const [name, hero] of Object.entries(trees.hero)) {
    console.log(`  Hero (${name}): ${hero.talents.length} talents`);
  }

  const allTalents = [
    ...trees.class.talents,
    ...trees.spec.talents,
    ...Object.values(trees.hero).flatMap((h) => h.talents),
  ];
  const typeCounts = {};
  for (const t of allTalents) {
    typeCounts[t.type || "unknown"] =
      (typeCounts[t.type || "unknown"] || 0) + 1;
  }
  console.log("\n  Type breakdown:");
  for (const [type, count] of Object.entries(typeCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${type}: ${count}`);
  }
}

function categorizeTalent(spell) {
  if (!spell.passive && spell.gcd) return "active_ability";
  if (!spell.passive && spell.cooldown && !spell.gcd) return "off_gcd_ability";

  const effects = spell.effects || [];
  for (const e of effects) {
    const type = e.type?.toLowerCase() || "";
    if (
      type.includes("apply aura") &&
      (type.includes("add percent modifier") ||
        type.includes("add flat modifier"))
    )
      return "spell_modifier";
    if (type.includes("proc trigger spell")) return "proc_trigger";
    if (type.includes("apply aura") && type.includes("dummy"))
      return "passive_buff";
  }

  if (spell.passive) return "passive";
  return "other";
}

loadSpecAdapter().then(() => buildTalentTrees());
