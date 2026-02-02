// Builds the talent → spell interaction graph.
// Uses "Affecting Spells" from spell data to map which talents modify which abilities.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEffect, classifyByName } from "./interaction-types.js";
import { CLASS_NAME } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

function buildInteractions() {
  const spells = JSON.parse(
    readFileSync(join(DATA_DIR, "spells.json"), "utf-8"),
  );
  const talents = JSON.parse(
    readFileSync(join(DATA_DIR, "talents.json"), "utf-8"),
  );

  const spellMap = new Map(spells.map((s) => [s.id, s]));

  // Build a map of talent spell IDs for quick lookup
  const allTalents = [
    ...talents.class.talents.map((t) => ({ ...t, treeName: "class" })),
    ...talents.spec.talents.map((t) => ({ ...t, treeName: "spec" })),
    ...Object.entries(talents.hero).flatMap(([name, h]) =>
      h.talents.map((t) => ({ ...t, treeName: "hero", heroSpec: name })),
    ),
  ];
  const talentBySpellId = new Map(allTalents.map((t) => [t.spellId, t]));

  // Interactions: for each spell, check its "affectingSpells" to find talents that modify it
  const interactions = [];
  const spellToModifiers = new Map(); // spellId -> [{talent, type}]
  const talentToTargets = new Map(); // talentSpellId -> [{spell, type}]

  for (const spell of spells) {
    if (!spell.affectingSpells?.length) continue;

    for (const ref of spell.affectingSpells) {
      const modifierSpell = spellMap.get(ref.id);
      const talent = talentBySpellId.get(ref.id);

      const isTalent = !!talent;

      // Skip base spec/class passives (e.g. "Vengeance Demon Hunter", "Havoc Demon Hunter")
      if (ref.name.includes(CLASS_NAME) && !isTalent) continue;

      let interactionType;
      if (modifierSpell && ref.effects?.length) {
        interactionType = classifyFromEffects(modifierSpell, ref.effects);
      } else if (modifierSpell) {
        interactionType = classifyFromSpell(modifierSpell);
      } else {
        interactionType = classifyByName(ref.name) || "unknown";
      }

      const interaction = {
        source: {
          id: ref.id,
          name: ref.name,
          isTalent,
          tree: talent?.treeName || null,
          heroSpec: talent?.heroSpec || null,
        },
        target: {
          id: spell.id,
          name: spell.name,
        },
        type: interactionType,
        effects: ref.effects || [],
      };

      interactions.push(interaction);

      if (!spellToModifiers.has(spell.id)) spellToModifiers.set(spell.id, []);
      spellToModifiers.get(spell.id).push(interaction);

      if (!talentToTargets.has(ref.id)) talentToTargets.set(ref.id, []);
      talentToTargets.get(ref.id).push(interaction);
    }
  }

  const unknowns = interactions.filter((i) => i.type === "unknown");
  if (unknowns.length) {
    console.warn(
      `\n  WARNING: ${unknowns.length} interactions classified as "unknown":`,
    );
    for (const u of unknowns) {
      console.warn(`    ${u.source.name} (${u.source.id}) → ${u.target.name}`);
    }
  }

  // Build summary structures
  const output = {
    interactions,
    bySpell: Object.fromEntries(
      [...spellToModifiers.entries()].map(([id, ints]) => [
        id,
        {
          name: spellMap.get(id)?.name || `Spell ${id}`,
          modifiers: ints.map((i) => ({
            source: i.source.name,
            sourceId: i.source.id,
            type: i.type,
            tree: i.source.tree,
            heroSpec: i.source.heroSpec,
          })),
        },
      ]),
    ),
    byTalent: Object.fromEntries(
      [...talentToTargets.entries()].map(([id, ints]) => [
        id,
        {
          name: ints[0]?.source.name || `Talent ${id}`,
          tree: ints[0]?.source.tree,
          heroSpec: ints[0]?.source.heroSpec,
          targets: ints.map((i) => ({
            spell: i.target.name,
            spellId: i.target.id,
            type: i.type,
          })),
        },
      ]),
    ),
  };

  writeFileSync(
    join(DATA_DIR, "interactions.json"),
    JSON.stringify(output, null, 2),
  );

  console.log("Wrote data/interactions.json");
  console.log(`  ${interactions.length} total interactions`);
  console.log(`  ${spellToModifiers.size} spells have modifiers`);
  console.log(`  ${talentToTargets.size} talents/passives modify spells`);

  // Type breakdown
  const typeCounts = {};
  for (const i of interactions) {
    typeCounts[i.type] = (typeCounts[i.type] || 0) + 1;
  }
  console.log("\n  Interaction types:");
  for (const [type, count] of Object.entries(typeCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${type}: ${count}`);
  }

  console.log("\n  Most-modified spells:");
  const topModified = [...spellToModifiers.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 7);
  for (const [id, mods] of topModified) {
    const name = spellMap.get(id)?.name || `Spell ${id}`;
    console.log(`    ${name}: ${mods.length} modifiers`);
  }
}

function classifyFromEffects(spell, effectIndices) {
  if (!spell?.effects) return "unknown";
  for (const idx of effectIndices) {
    const effect = spell.effects.find((e) => e.index === idx);
    if (effect) {
      const classified = classifyEffect(effect.type);
      if (classified) return classified;
    }
  }
  return classifyFromSpell(spell);
}

function classifyFromSpell(spell) {
  if (!spell) return "unknown";
  for (const e of spell.effects || []) {
    const classified = classifyEffect(e.type);
    if (classified) return classified;
  }
  if (spell.passive) return "buff_grant";
  const byName = classifyByName(spell.name);
  if (byName) return byName;
  return "unknown";
}

buildInteractions();
