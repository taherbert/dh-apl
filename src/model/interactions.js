// Builds the talent → spell interaction graph for the configured spec.
// Merges three discovery methods:
// 1. affectingSpells from spell data (primary)
// 2. C++ scanner talent→ability and talent↔talent references
// 3. Effect scan (self-buff talents with proc/modifier effects)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  classifyEffect,
  classifyByName,
  resolveEffectMagnitude,
  resolveApplicationMethod,
  resolveSchoolTarget,
  extractEffectDetails,
  inferCategories,
} from "./interaction-types.js";
import {
  initSpec,
  loadSpecAdapter,
  getSpecAdapter,
  getDisplayNames,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { dataDir } from "../engine/paths.js";

function buildInteractions() {
  const SET_BONUS_SPELLS = getSpecAdapter().getSetBonusSpells();

  const spells = JSON.parse(
    readFileSync(join(dataDir(), "spells.json"), "utf-8"),
  );
  const talents = JSON.parse(
    readFileSync(join(dataDir(), "talents.json"), "utf-8"),
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
  // Internal simc action names that map to known spells
  nameToSpellId.set("Consume Soul", 203981); // Soul Fragments

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

  // Name→spell[] lookup for talent indirection in magnitude resolution
  const spellsByName = new Map();
  for (const sp of spells) {
    if (!spellsByName.has(sp.name)) spellsByName.set(sp.name, []);
    spellsByName.get(sp.name).push(sp);
  }

  const specSpellNames = new Set(spells.map((s) => s.name));

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
      const setBonus = SET_BONUS_SPELLS.get(ref.id);

      const { class: displayClass, spec: displaySpec } = getDisplayNames();
      if (ref.name.includes(displayClass) && !isTalent && !setBonus) continue;

      // Skip non-talent modifiers that aren't current DH spells — these are
      // legacy references (old runecarving powers, covenant abilities, etc.)
      // retained in simc's spell data but not part of any current talent tree.
      if (!isTalent && !setBonus && !modifierSpell) continue;

      // Skip talents from sibling specs that leak into our spell data.
      const currentSpec = displaySpec;
      if (
        modifierSpell?.talentEntry?.spec &&
        modifierSpell.talentEntry.spec !== currentSpec
      )
        continue;
      const refNameSpells = spellsByName.get(ref.name);
      if (
        refNameSpells?.some(
          (s) => s.talentEntry?.spec && s.talentEntry.spec !== currentSpec,
        ) &&
        !refNameSpells?.some((s) => s.talentEntry?.spec === currentSpec)
      )
        continue;

      let interactionType;
      if (modifierSpell && ref.effects?.length) {
        interactionType = classifyFromEffects(modifierSpell, ref.effects);
      } else if (modifierSpell) {
        interactionType = classifyFromSpell(modifierSpell);
      } else {
        interactionType = classifyByName(ref.name) || "unknown";
      }

      const source = setBonus
        ? {
            id: ref.id,
            name: setBonus.displayName,
            isTalent: false,
            isSetBonus: true,
            setBonus: {
              name: setBonus.name,
              pieceCount: setBonus.pieceCount,
            },
            tree: null,
            heroSpec: null,
          }
        : {
            id: ref.id,
            name: ref.name,
            isTalent,
            tree: talent?.treeName || null,
            heroSpec: talent?.heroSpec || null,
          };

      addInteraction({
        source,
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
  const cppPath = join(dataDir(), "cpp-interactions.json");
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
            : nameToSpellId.get(ref.target) ||
              talentByName.get(ref.target)?.spellId ||
              null,
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

  // === Phase 2b: C++ effects inventory (parse_effects/composite overrides) ===
  const effectsPath = join(dataDir(), "cpp-effects-inventory.json");
  if (existsSync(effectsPath)) {
    const effectsData = JSON.parse(readFileSync(effectsPath, "utf-8"));

    // Convert snake_case C++ names to Title Case talent names
    const toTitleCase = (s) =>
      s?.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    // parse_effects: buff automatically modifies ability damage
    for (const entry of effectsData.parseEffects || []) {
      const buffName = toTitleCase(entry.buff);
      const talent = buffName && talentByName.get(buffName);
      if (!talent) continue;

      // Skip if already discovered
      if (
        interactions.some(
          (i) =>
            i.source.name === talent.name &&
            i.discoveryMethod !== "cpp_effects",
        )
      )
        continue;

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
        type: "damage_modifier",
        mechanism: "parse_effects",
        discoveryMethod: "cpp_effects",
        confidence: "high",
      });
    }

    // composite overrides: manual multiplier gated by talent check
    for (const entry of effectsData.compositeOverrides || []) {
      for (const check of entry.talentChecks || []) {
        const talentName = toTitleCase(check.talent);
        const talent = talentName && talentByName.get(talentName);
        if (!talent) continue;

        const fnType = entry.function?.includes("da_multiplier")
          ? "direct_damage_modifier"
          : entry.function?.includes("ta_multiplier")
            ? "periodic_damage_modifier"
            : "damage_modifier";

        addInteraction({
          source: {
            id: talent.spellId,
            name: talent.name,
            isTalent: true,
            tree: talent.treeName,
            heroSpec: talent.heroSpec || null,
          },
          target: {
            id: null,
            name: entry.context || "ability",
          },
          type: fnType,
          mechanism: "composite_override",
          discoveryMethod: "cpp_effects",
          confidence: "high",
        });
      }
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

  // === Phase 4: Manual set bonus interactions (spec-specific, from adapter) ===
  const adapter = getSpecAdapter();
  if (adapter.getManualSetBonusInteractions) {
    for (const interaction of adapter.getManualSetBonusInteractions(spellMap)) {
      addInteraction(interaction);
    }
  }

  // === 1G: Compute modified uptimes accounting for CD/duration modifiers ===
  for (const interaction of interactions) {
    if (interaction.theoreticalUptime == null) continue;
    const targetId = interaction.target.id || interaction.source.id;
    const targetMods = spellToModifiers.get(targetId) || [];
    let cdMod = 0;
    let durMod = 0;
    for (const mod of targetMods) {
      if (mod.type === "cooldown_modifier" && mod.magnitude?.value) {
        cdMod += mod.magnitude.value;
      }
      if (mod.type === "duration_modifier" && mod.magnitude?.value) {
        durMod += mod.magnitude.value;
      }
    }
    if (cdMod !== 0 || durMod !== 0) {
      const sourceSpell = spellMap.get(interaction.source.id);
      if (sourceSpell) {
        const baseDur = sourceSpell.duration || 0;
        const baseCd =
          sourceSpell.cooldown || sourceSpell.charges?.cooldown || 0;
        if (baseDur > 0 && baseCd > 0) {
          const modDur = baseDur * (1 + durMod / 100);
          const modCd = baseCd * (1 + cdMod / 100);
          if (modCd > 0) {
            interaction.modifiedUptime = Math.min(1, modDur / modCd);
          }
        }
      }
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
            ...enrichedFields(i),
          })),
        },
      ]),
    ),
    bySetBonus: Object.fromEntries(
      [...talentToTargets.entries()]
        .filter(([, ints]) => ints[0]?.source.isSetBonus)
        .map(([id, ints]) => [
          id,
          {
            name: ints[0]?.source.name,
            setBonus: ints[0]?.source.setBonus,
            targets: ints.map((i) => ({
              spell: i.target.name,
              spellId: i.target.id,
              type: i.type,
              discoveryMethod: i.discoveryMethod,
              ...enrichedFields(i),
              ...(i.triggerSpell && { triggerSpell: i.triggerSpell }),
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
            ...enrichedFields(i),
            ...(i.mechanism && { mechanism: i.mechanism }),
          })),
        },
      ]),
    ),
  };

  writeFileSync(
    join(dataDir(), "interactions.json"),
    JSON.stringify(output, null, 2),
  );

  console.log("Wrote data/interactions.json");
  console.log(`  ${interactions.length} total interactions`);
  console.log(`  ${spellToModifiers.size} spells have modifiers`);
  console.log(`  ${talentToTargets.size} talents/passives modify spells`);

  // Discovery method breakdown
  const methodCounts = countBy(interactions, (i) => i.discoveryMethod);
  console.log("\n  Discovery methods:");
  for (const [method, count] of sortCounts(methodCounts)) {
    console.log(`    ${method}: ${count}`);
  }

  // Type breakdown
  const typeCounts = countBy(interactions, (i) => i.type);
  console.log("\n  Interaction types:");
  for (const [type, count] of sortCounts(typeCounts)) {
    console.log(`    ${type}: ${count}`);
  }

  // Talent triage summary
  console.log("\n  Talent triage:");
  const triageCounts = countBy(Object.values(talentCategories), (v) => v);
  for (const [cat, count] of sortCounts(triageCounts)) {
    console.log(`    ${cat}: ${count}`);
  }

  // Key spell modifiers (from spec adapter)
  const keySpells = (adapter.getKeySpellIds?.() || []).slice(0, 5);
  console.log("\n  Key spell modifiers:");
  for (const [id, name] of keySpells) {
    const mods = spellToModifiers.get(id);
    if (!mods) {
      console.log(`    ${name}: no modifiers found`);
      continue;
    }
    console.log(`    ${name}: ${mods.length} modifiers`);
    const displayed = mods.slice(0, 5);
    for (const m of displayed) {
      console.log(`      - ${m.source.name} (${m.type}, ${m.discoveryMethod})`);
    }
    if (mods.length > 5) console.log(`      ... and ${mods.length - 5} more`);
  }

  function enrichedFields(i) {
    const result = {};
    if (i.magnitude) result.magnitude = i.magnitude;
    if (i.application) result.application = i.application;
    if (i.categories) result.categories = i.categories;
    if (i.schoolTarget) result.schoolTarget = i.schoolTarget;
    if (i.procInfo) result.procInfo = i.procInfo;
    if (i.theoreticalUptime != null)
      result.theoreticalUptime = i.theoreticalUptime;
    if (i.modifiedUptime != null) result.modifiedUptime = i.modifiedUptime;
    return result;
  }

  function addInteraction(interaction) {
    // Enrich with magnitude, application, school target, effect details, categories
    const sourceSpell = spellMap.get(interaction.source.id);
    const effectIndices = interaction.effects || [];

    const magnitude = resolveEffectMagnitude(
      sourceSpell,
      effectIndices,
      spellsByName,
    );
    if (magnitude) interaction.magnitude = magnitude;

    const application = resolveApplicationMethod(sourceSpell, effectIndices);
    if (application) interaction.application = application;

    const schoolTarget = resolveSchoolTarget(sourceSpell, effectIndices);
    if (schoolTarget) interaction.schoolTarget = schoolTarget;

    // 1B: Propagate proc rates for proc_trigger interactions
    if (interaction.type === "proc_trigger" && sourceSpell) {
      const procInfo = {};
      if (sourceSpell.procChance != null)
        procInfo.procChance = sourceSpell.procChance;
      if (sourceSpell.realPPM != null) procInfo.realPPM = sourceSpell.realPPM;
      if (sourceSpell.internalCooldown != null)
        procInfo.internalCooldown = sourceSpell.internalCooldown;
      if (Object.keys(procInfo).length > 0) interaction.procInfo = procInfo;
    }

    // 1G: Theoretical uptime for buff_grant interactions
    if (interaction.type === "buff_grant" && sourceSpell) {
      const dur = sourceSpell.duration;
      const cd = sourceSpell.cooldown || sourceSpell.charges?.cooldown;
      if (dur > 0 && cd > 0) {
        interaction.theoreticalUptime = Math.min(1, dur / cd);
      }
    }

    const effectDetails = extractEffectDetails(
      sourceSpell,
      effectIndices,
      specSpellNames,
    );
    if (effectDetails) interaction.effectDetails = effectDetails;

    interaction.categories = inferCategories(
      interaction.type,
      sourceSpell,
      effectIndices,
    );

    // Drop DR interactions — negative percent on damage_modifier is always damage
    // reduction, not relevant for APL damage reasoning
    if (
      interaction.type === "damage_modifier" &&
      interaction.magnitude?.unit === "percent" &&
      interaction.magnitude?.value < 0
    )
      return;

    const isDuplicate = interactions.some(
      (existing) =>
        existing.source.id === interaction.source.id &&
        existing.target.id === interaction.target.id &&
        existing.type === interaction.type,
    );
    if (isDuplicate) return;

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
  return classifyByName(spell.name) || "unknown";
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sortCounts(countsObj) {
  return Object.entries(countsObj).sort((a, b) => b[1] - a[1]);
}

(async () => {
  await initSpec(parseSpecArg());
  buildInteractions();
})();
