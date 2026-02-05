// Generates a markdown report of spell/talent interactions.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  config,
  loadSpecAdapter,
  getSpecAdapter,
  getDisplayNames,
} from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

async function generateReport() {
  await loadSpecAdapter();
  const { BASE_SPELL_IDS, SET_BONUS_SPELL_IDS } = getSpecAdapter();

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

  const { spec: specName, class: className } = getDisplayNames();
  lines.push(`# ${specName} ${className} — Ability & Talent Report`);
  lines.push("");
  lines.push(
    `Generated from SimC midnight branch. ${spells.length} spells, ${Object.keys(interactions.byTalent).length} modifier sources.`,
  );
  lines.push("");

  // Build set of Vengeance-relevant spell IDs from talent trees
  const vengSpellIds = new Set();
  for (const tal of talents.class.talents) vengSpellIds.add(tal.spellId);
  for (const tal of talents.spec.talents) vengSpellIds.add(tal.spellId);
  for (const heroTree of Object.values(talents.hero)) {
    for (const tal of heroTree.talents || heroTree)
      vengSpellIds.add(tal.spellId);
  }
  // Include base spec abilities and Vengeance-tagged spells
  for (const id of BASE_SPELL_IDS) vengSpellIds.add(id);
  for (const id of SET_BONUS_SPELL_IDS) vengSpellIds.add(id);
  for (const s of spells) {
    if (s.talentEntry?.spec === specName) vengSpellIds.add(s.id);
  }

  // Active abilities section
  lines.push("## Active Abilities");
  lines.push("");

  // Sub-spells that are triggered by a main cast (e.g., damage components, buff applications)
  // shouldn't appear as separate active abilities. Identify them by triggeredBy or by being
  // a secondary spell ID sharing a name with a GCD-bearing primary.
  const primaryByName = new Map();
  for (const s of spells) {
    if (s.gcd > 0 && vengSpellIds.has(s.id)) {
      primaryByName.set(s.name, s.id);
    }
  }
  const activeSpells = spells
    .filter((s) => {
      if (s.passive || s.gcd == null) return false;
      if (!vengSpellIds.has(s.id)) return false;
      // Exclude triggered sub-spells (but keep real abilities with cooldowns)
      if (s.triggeredBy?.length && !s.cooldown && !s.charges) return false;
      // Exclude secondary spell IDs that share a name with a GCD-bearing primary
      if (
        s.gcd === 0 &&
        primaryByName.has(s.name) &&
        primaryByName.get(s.name) !== s.id
      )
        return false;
      // Off-GCD spells without cooldown, charges, or resource cost are not
      // player-cast abilities — they're sub-spells, buffs, or proc effects
      if (s.gcd === 0 && !s.cooldown && !s.charges && !s.resource) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const spell of activeSpells) {
    lines.push(`### ${spell.name} (${spell.id})`);
    lines.push("");

    const props = [];
    if (spell.school) props.push(`School: ${spell.school}`);
    if (spell.resource)
      props.push(`Cost: ${spell.resource.cost} ${spell.resource.type}`);
    if (spell.gcd != null)
      props.push(`GCD: ${spell.gcd === 0 ? "off-GCD" : spell.gcd + "s"}`);
    if (spell.cooldown) props.push(`CD: ${spell.cooldown}s`);
    if (spell.charges)
      props.push(
        `Charges: ${spell.charges.count} (${spell.charges.cooldown}s)`,
      );
    if (spell.duration) props.push(`Duration: ${spell.duration}s`);
    if (spell.range) props.push(`Range: ${spell.range}yd`);
    if (props.length) lines.push(props.join(" | "));

    // Resource generation
    if (spell.generates?.length) {
      const genStr = spell.generates
        .map((g) => `${g.amount} ${g.resourceType}`)
        .join(", ");
      lines.push(`Generates: ${genStr}`);
    }

    // AoE info
    if (spell.aoe) {
      const aoeParts = [];
      if (spell.aoe.radius) aoeParts.push(`${spell.aoe.radius}yd radius`);
      if (spell.aoe.maxTargets)
        aoeParts.push(`max ${spell.aoe.maxTargets} targets`);
      if (spell.aoe.reducedAoe) aoeParts.push(`reduced AoE`);
      if (aoeParts.length) lines.push(`AoE: ${aoeParts.join(", ")}`);
    }

    // Haste scaling
    if (spell.hasteScaling) {
      const parts = Object.entries(spell.hasteScaling)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (parts.length) lines.push(`Haste scales: ${parts.join(", ")}`);
    }

    // Proc info
    if (spell.procChance && spell.procChance <= 100)
      lines.push(`Proc: ${spell.procChance}% chance`);
    if (spell.realPPM) lines.push(`Proc: ${spell.realPPM} RPPM`);
    if (spell.internalCooldown) lines.push(`ICD: ${spell.internalCooldown}s`);

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
    [`Spec (${specName})`, talents.spec],
    ...Object.entries(talents.hero).map(([name, data]) => [
      `Hero: ${name}`,
      data,
    ]),
  ]) {
    lines.push(`### ${treeName} (${treeData.talents.length} talents)`);
    lines.push("");

    // Derive row/col indices from posY/posX pixel coordinates
    const uniqueYs = [...new Set(treeData.talents.map((t) => t.posY))].sort(
      (a, b) => a - b,
    );
    const yToRow = new Map(uniqueYs.map((y, i) => [y, i]));
    const uniqueXs = [...new Set(treeData.talents.map((t) => t.posX))].sort(
      (a, b) => a - b,
    );
    const xToCol = new Map(uniqueXs.map((x, i) => [x, i]));

    // Group by row
    const byRow = new Map();
    for (const t of treeData.talents) {
      const row = yToRow.get(t.posY);
      if (!byRow.has(row)) byRow.set(row, []);
      byRow.get(row).push(t);
    }

    for (const [row, rowTalents] of [...byRow.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      lines.push(`**Row ${row}:**`);
      for (const t of rowTalents.sort((a, b) => a.posX - b.posX)) {
        const col = xToCol.get(t.posX);
        const typeTag = t.type ? ` [${t.type}]` : "";
        lines.push(`- (${col}) **${t.name}** (${t.spellId})${typeTag}`);

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

  // Set Bonuses section
  if (interactions.bySetBonus && Object.keys(interactions.bySetBonus).length) {
    lines.push("## Set Bonuses");
    lines.push("");

    for (const [id, entry] of Object.entries(interactions.bySetBonus)) {
      const pc = entry.setBonus?.pieceCount
        ? `${entry.setBonus.pieceCount}pc`
        : "";
      lines.push(`### ${entry.name} (${id})`);
      lines.push("");
      if (entry.targets?.length) {
        for (const t of entry.targets) {
          const parts = [`→ ${t.spell} (${t.type})`];
          if (t.magnitude)
            parts.push(
              `${t.magnitude.value}${t.magnitude.unit === "percent" ? "%" : ""}`,
            );
          if (t.procInfo) {
            const pp = [];
            if (t.procInfo.procChance != null)
              pp.push(`${(t.procInfo.procChance * 100).toFixed(0)}% chance`);
            if (t.procInfo.internalCooldown != null)
              pp.push(`${t.procInfo.internalCooldown}s ICD`);
            if (pp.length) parts.push(`[${pp.join(", ")}]`);
          }
          if (t.triggerSpell) parts.push(`on ${t.triggerSpell.name}`);
          lines.push(`- ${parts.join(" ")}`);
        }
      }
      lines.push("");
    }
  }

  // Resource flow section
  lines.push("## Resource Flow");
  lines.push("");

  lines.push("### Fury Generators");
  const isFury = (g) => g.resourceType.toLowerCase() === "fury";
  const furyGen = spells.filter((s) => s.generates?.some(isFury) && !s.passive);
  for (const s of furyGen) {
    const amounts = s.generates.filter(isFury).map((g) => g.amount);
    lines.push(`- ${s.name} (${s.id}): ${amounts.join("+")} Fury`);
  }

  lines.push("");
  lines.push("### Fury Spenders");
  const furySpend = spells.filter(
    (s) => s.resource?.type === "Fury" && !s.passive,
  );
  for (const s of furySpend)
    lines.push(`- ${s.name} (${s.id}): ${s.resource.cost} Fury`);

  lines.push("");
  lines.push("### Soul Fragment Generators");
  const soulGen = spells.filter((s) =>
    s.generates?.some((g) => g.resourceType === "Soul Fragments"),
  );
  for (const s of soulGen) {
    const amount = s.generates.find(
      (g) => g.resourceType === "Soul Fragments",
    )?.amount;
    lines.push(`- ${s.name} (${s.id}): ${amount} fragments`);
  }

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

generateReport().catch((e) => {
  console.error(e);
  process.exit(1);
});
