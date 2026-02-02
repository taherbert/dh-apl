// Builds the talent → spell interaction graph.
// Merges three discovery methods:
// 1. affectingSpells from spell data (primary)
// 2. C++ scanner talent→ability and talent↔talent references
// 3. Effect scan (self-buff talents with proc/modifier effects)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEffect, classifyByName } from "./interaction-types.js";

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

  const allTalents = [
    ...talents.class.talents.map((t) => ({ ...t, treeName: "class" })),
    ...talents.spec.talents.map((t) => ({ ...t, treeName: "spec" })),
    ...Object.entries(talents.hero).flatMap(([name, h]) =>
      h.talents.map((t) => ({ ...t, treeName: "hero", heroSpec: name })),
    ),
  ];
  const talentBySpellId = new Map(allTalents.map((t) => [t.spellId, t]));
  const talentByName = new Map(allTalents.map((t) => [t.name, t]));

  // Name→spellId lookup for resolving C++ scanner targets
  const nameToSpellId = new Map();
  for (const [id, sp] of spellMap) {
    if (!nameToSpellId.has(sp.name)) nameToSpellId.set(sp.name, id);
  }

  // Build alias groups: spells sharing the same name (e.g. Soul Cleave 228477/228478)
  const spellAliases = new Map();
  const nameToIds = new Map();
  for (const [id, sp] of spellMap) {
    if (!nameToIds.has(sp.name)) nameToIds.set(sp.name, []);
    nameToIds.get(sp.name).push(id);
  }
  for (const ids of nameToIds.values()) {
    if (ids.length > 1) {
      const group = new Set(ids);
      for (const id of ids) spellAliases.set(id, group);
    }
  }

  const interactions = [];
  const spellToModifiers = new Map();
  const talentToTargets = new Map();

  // === Phase 1: affectingSpells from spell data ===
  for (const spell of spells) {
    if (!spell.affectingSpells?.length) continue;

    for (const ref of spell.affectingSpells) {
      const modifierSpell = spellMap.get(ref.id);
      const talent = talentBySpellId.get(ref.id);
      const isTalent = !!talent;

      if (ref.name.includes("Demon Hunter") && !isTalent) continue;

      // Skip non-talent modifiers that aren't current DH spells — these are
      // legacy references (old runecarving powers, covenant abilities, etc.)
      // retained in simc's spell data but not part of any current talent tree.
      if (!isTalent && !modifierSpell) continue;

      const interactionType =
        modifierSpell && ref.effects?.length
          ? classifyFromEffects(modifierSpell, ref.effects)
          : modifierSpell
            ? classifyFromSpell(modifierSpell)
            : classifyByName(ref.name) || "unknown";

      addInteraction({
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
        discoveryMethod: "spell_data",
        confidence: "high",
      });
    }
  }

  // === Phase 2: Merge C++ scanner interactions ===
  const cppPath = join(DATA_DIR, "cpp-interactions.json");
  if (existsSync(cppPath)) {
    const cppData = JSON.parse(readFileSync(cppPath, "utf-8"));

    // Talent→ability references
    for (const ref of cppData.talentAbility || []) {
      const sourceTalent = talentByName.get(ref.source);
      if (!sourceTalent) continue;

      // Check if this interaction already exists from spell_data
      const existing = interactions.find(
        (i) =>
          i.source.name === ref.source &&
          i.target.name === ref.target &&
          i.discoveryMethod === "spell_data",
      );
      if (existing) continue;

      addInteraction({
        source: {
          id: sourceTalent.spellId,
          name: ref.source,
          isTalent: true,
          tree: sourceTalent.treeName,
          heroSpec: sourceTalent.heroSpec || null,
        },
        target: {
          id: ref.target.startsWith("buff:")
            ? null
            : nameToSpellId.get(ref.target) || null,
          name: ref.target,
        },
        type: ref.type,
        mechanism: ref.mechanism,
        discoveryMethod: "cpp_scanner",
        confidence: "medium",
      });
    }

    // Talent↔talent cross-references
    for (const ref of cppData.talentTalent || []) {
      const sourceTalent = talentByName.get(ref.source);
      const targetTalent = talentByName.get(ref.target);
      if (!sourceTalent || !targetTalent) continue;

      addInteraction({
        source: {
          id: sourceTalent.spellId,
          name: ref.source,
          isTalent: true,
          tree: sourceTalent.treeName,
          heroSpec: sourceTalent.heroSpec || null,
        },
        target: {
          id: targetTalent.spellId,
          name: ref.target,
        },
        type: ref.type,
        mechanism: ref.mechanism,
        discoveryMethod: "cpp_scanner",
        confidence: "medium",
      });
    }

    // Effect scans (buff grants)
    for (const ref of cppData.effectScans || []) {
      const talent = talentByName.get(ref.talent);
      if (!talent) continue;

      addInteraction({
        source: {
          id: talent.spellId,
          name: ref.talent,
          isTalent: true,
          tree: talent.treeName,
          heroSpec: talent.heroSpec || null,
        },
        target: {
          id: null,
          name: ref.target,
        },
        type: ref.type,
        mechanism: ref.mechanism,
        discoveryMethod: "effect_scan",
        confidence: "medium",
      });
    }
  }

  // === Phase 3: Self-buff talents (proc trigger / labeled modifier effects) ===
  for (const talent of allTalents) {
    const sp = spellMap.get(talent.spellId);
    if (!sp?.effects) continue;
    if (talentToTargets.has(talent.spellId)) continue; // already has interactions

    const effects = sp.effects.map((e) => (e.type || "").toLowerCase());
    const hasProcTrigger = effects.some((e) =>
      e.includes("proc trigger spell"),
    );
    const hasLabeledMod = effects.some(
      (e) =>
        e.includes("flat modifier w/ label") ||
        e.includes("percent modifier w/ label"),
    );

    if (hasProcTrigger || hasLabeledMod) {
      addInteraction({
        source: {
          id: talent.spellId,
          name: talent.name,
          isTalent: true,
          tree: talent.treeName,
          heroSpec: talent.heroSpec || null,
        },
        target: {
          id: talent.spellId,
          name: talent.name,
        },
        type: hasProcTrigger ? "proc_trigger" : "damage_modifier",
        discoveryMethod: "effect_scan",
        confidence: "medium",
      });
    }
  }

  // === Talent triage categories ===
  const talentCategories = triageTalents(
    allTalents,
    spellMap,
    talentToTargets,
    spellToModifiers,
  );

  // === Build output ===
  const output = {
    interactions,
    talentCategories,
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
            discoveryMethod: i.discoveryMethod,
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
            discoveryMethod: i.discoveryMethod,
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

  // Discovery method breakdown
  const methodCounts = {};
  for (const i of interactions) {
    methodCounts[i.discoveryMethod] =
      (methodCounts[i.discoveryMethod] || 0) + 1;
  }
  console.log("\n  Discovery methods:");
  for (const [method, count] of Object.entries(methodCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${method}: ${count}`);
  }

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

  // Talent triage summary
  console.log("\n  Talent triage:");
  const triageCounts = {};
  for (const cat of Object.values(talentCategories)) {
    triageCounts[cat] = (triageCounts[cat] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(triageCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`    ${cat}: ${count}`);
  }

  // Key spell modifiers
  const keySpells = [
    [204021, "Fiery Brand"],
    [247454, "Spirit Bomb"],
    [228477, "Soul Cleave"],
    [212084, "Fel Devastation"],
    [258920, "Immolation Aura"],
  ];
  console.log("\n  Key spell modifiers:");
  for (const [id, name] of keySpells) {
    const mods = spellToModifiers.get(id);
    if (mods) {
      console.log(`    ${name}: ${mods.length} modifiers`);
      for (const m of mods.slice(0, 5)) {
        console.log(
          `      - ${m.source.name} (${m.type}, ${m.discoveryMethod})`,
        );
      }
      if (mods.length > 5) console.log(`      ... and ${mods.length - 5} more`);
    } else {
      console.log(`    ${name}: no modifiers found`);
    }
  }

  function addInteraction(interaction) {
    interactions.push(interaction);

    const targetId = interaction.target.id;
    if (targetId) {
      if (!spellToModifiers.has(targetId)) spellToModifiers.set(targetId, []);
      spellToModifiers.get(targetId).push(interaction);

      if (spellAliases.has(targetId)) {
        for (const aliasId of spellAliases.get(targetId)) {
          if (aliasId === targetId) continue;
          if (!spellToModifiers.has(aliasId)) spellToModifiers.set(aliasId, []);
          spellToModifiers.get(aliasId).push(interaction);
        }
      }
    }

    const sourceId = interaction.source.id;
    if (!talentToTargets.has(sourceId)) talentToTargets.set(sourceId, []);
    talentToTargets.get(sourceId).push(interaction);
  }
}

function triageTalents(
  allTalents,
  spellMap,
  talentToTargets,
  spellToModifiers,
) {
  const categories = {};

  const STAT_EFFECTS = [
    "mod stat",
    "modify parry",
    "modify dodge",
    "modify max health",
    "modify damage taken",
    "modify mastery",
    "modify max resource",
    "modify movement speed",
    "modify healing",
    "modify recharge time",
    "modify cooldown charge",
  ];

  for (const t of allTalents) {
    if (talentToTargets.has(t.spellId) || spellToModifiers.has(t.spellId)) {
      categories[t.name] = "has_interactions";
      continue;
    }

    const sp = spellMap.get(t.spellId);
    if (!sp) {
      categories[t.name] = "cpp_only";
      continue;
    }

    const effects = (sp.effects || []).map((e) => (e.type || "").toLowerCase());
    const nonDummy = effects.filter((e) => !e.includes("dummy"));

    if (
      sp.passive &&
      nonDummy.length > 0 &&
      nonDummy.every((e) => STAT_EFFECTS.some((p) => e.includes(p)))
    ) {
      categories[t.name] = "stat_passive";
      continue;
    }

    if (effects.some((e) => e.includes("proc trigger spell"))) {
      categories[t.name] = "self_buff";
      continue;
    }

    if (
      effects.some(
        (e) =>
          e.includes("flat modifier w/ label") ||
          e.includes("percent modifier w/ label"),
      )
    ) {
      categories[t.name] = "self_buff";
      continue;
    }

    if (!sp.passive) {
      categories[t.name] = "active_ability";
      continue;
    }

    if (effects.every((e) => e.includes("dummy") || e.includes("apply aura"))) {
      categories[t.name] = "cpp_only";
      continue;
    }

    categories[t.name] = "cpp_only";
  }

  return categories;
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
