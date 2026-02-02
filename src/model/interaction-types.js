// Interaction categories for talent → spell relationships.

import { parseMiscValueMask, maskToSchoolNames } from "./schools.js";

export const INTERACTION_TYPES = {
  damage_modifier: "Changes spell damage (% increase/decrease)",
  cooldown_modifier: "Changes cooldown duration or charge behavior",
  resource_modifier: "Changes resource cost or generation",
  proc_trigger: "Talent causes a proc on spell use",
  buff_grant: "Talent creates or extends a buff/debuff",
  spell_unlock: "Talent makes a new ability available",
  mechanic_change: "Talent fundamentally changes how a spell works",
  duration_modifier: "Changes buff/debuff/effect duration",
  range_modifier: "Changes spell range or area of effect",
  stacking_modifier: "Changes max stacks or stacking behavior",
};

// Map simc effect subtypes to interaction categories
export function classifyEffect(effectType) {
  const t = (effectType || "").toLowerCase();
  if (t.includes("add percent modifier") || t.includes("school damage"))
    return "damage_modifier";
  if (
    t.includes("add flat modifier") ||
    t.includes("apply flat modifier w/ label")
  ) {
    if (t.includes("cooldown")) return "cooldown_modifier";
    if (t.includes("duration")) return "duration_modifier";
    if (t.includes("range")) return "range_modifier";
    if (t.includes("resource") || t.includes("power"))
      return "resource_modifier";
    if (t.includes("period")) return "duration_modifier";
    if (t.includes("radius")) return "range_modifier";
    if (t.includes("max stacks")) return "stacking_modifier";
    if (t.includes("critical")) return "damage_modifier";
    return "damage_modifier";
  }
  if (t.includes("apply percent modifier w/ label")) return "damage_modifier";
  if (t.includes("modify recharge time")) return "cooldown_modifier";
  if (t.includes("modify cooldown charge")) return "cooldown_modifier";
  if (t.includes("modify max resource")) return "resource_modifier";
  if (t.includes("modify healing")) return "buff_grant";
  if (t.includes("modify parry") || t.includes("modify dodge"))
    return "buff_grant";
  if (t.includes("modify mastery")) return "damage_modifier";
  if (t.includes("modify damage taken")) return "damage_modifier";
  if (t.includes("modify max health")) return "buff_grant";
  if (t.includes("modify movement speed")) return "buff_grant";
  if (t.includes("proc trigger spell")) return "proc_trigger";
  if (t.includes("trigger spell")) return "proc_trigger";
  if (t.includes("apply aura") && t.includes("mod damage done"))
    return "damage_modifier";
  if (t.includes("apply aura") && t.includes("haste")) return "damage_modifier";
  if (t.includes("apply aura") && t.includes("melee slow"))
    return "mechanic_change";
  if (t.includes("apply aura") && t.includes("mod stat"))
    return "damage_modifier";
  if (t.includes("apply aura") && t.includes("periodic"))
    return "damage_modifier";
  if (t.includes("apply aura")) return "buff_grant";
  if (t.includes("energize")) return "resource_modifier";
  if (t.includes("heal")) return "buff_grant";
  if (t.includes("school damage") || t.includes("weapon damage"))
    return "damage_modifier";
  return null;
}

// Name-based heuristic classification for spells with no effect data.
// Used when the modifier spell wasn't fully fetched via spell_query.
export function classifyByName(sourceName) {
  const n = (sourceName || "").toLowerCase();

  const damageNames = [
    "empowerment",
    "any means necessary",
    "chaos blades",
    "seething chaos",
    "exergy",
    "inertia",
    "demon soul",
    "burning blades",
    "fires of fel",
    "fiery demise",
    "mastery:",
    "immolation aura",
    "soul furnace",
    "bionic stabilizer",
    "serrated glaive",
    "burning wound",
    "scarred strikes",
    "soul flame",
    "accelerated blade",
  ];
  if (damageNames.some((name) => n.includes(name))) return "damage_modifier";

  const buffNames = [
    "mark",
    "brand",
    "reaver",
    "revel in pain",
    "spirit of the darkness flame",
    "fiery resolve",
    "soul rending",
    "metamorphosis",
    "demon hide",
  ];
  if (buffNames.some((name) => n.includes(name))) return "buff_grant";

  const mechNames = ["thrill of the fight", "demonsurge", "evasive action"];
  if (mechNames.some((name) => n.includes(name))) return "mechanic_change";

  const cooldownNames = [
    "first of the illidari",
    "fel defender",
    "rush of chaos",
  ];
  if (cooldownNames.some((name) => n.includes(name)))
    return "cooldown_modifier";

  const resourceNames = [
    "unleashed power",
    "prepared",
    "shear fury",
    "tactical retreat",
  ];
  if (resourceNames.some((name) => n.includes(name)))
    return "resource_modifier";

  if (n.includes("cover of darkness")) return "duration_modifier";
  if (n.includes("extended spikes")) return "duration_modifier";
  if (n.includes("luck of the draw")) return "proc_trigger";

  return null;
}

export const APPLICATION_METHODS = {
  buff_on_player: "Buff applied to player",
  debuff_on_target: "Debuff applied to enemy target",
  passive_always: "Passive effect, always active",
  conditional: "Conditionally applied (talent gate, threshold, etc.)",
};

export const CATEGORIES = {
  defensive: "Reduces damage taken or increases survivability",
  offensive: "Increases damage dealt",
  resource: "Modifies resource generation or costs",
  utility: "Movement, crowd control, or non-combat effects",
};

// Resolve magnitude from a source spell's effect data at specific indices.
// Returns { value, unit, perRank?, maxRank? } or null if no magnitude found.
// spellsByName: optional Map<name, spell[]> for talent indirection on base=0 debuffs.
export function resolveEffectMagnitude(
  sourceSpell,
  effectIndices,
  spellsByName,
) {
  if (!sourceSpell?.effects?.length) return null;

  const targetEffects = effectIndices?.length
    ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
    : sourceSpell.effects;

  for (const effect of targetEffects) {
    const d = effect.details || {};
    const type = (effect.type || "").toLowerCase();

    // Skip DR effects — "enemy does X% less to player" (not relevant for APL)
    if (
      type.includes("damage done% to caster") ||
      type.includes("damage done% to caster's spells")
    )
      continue;
    if (d.baseValue != null && d.baseValue < 0 && type.includes("damage taken"))
      continue;

    // Skip Override Action Spell — baseValue is a spell ID reference, not a magnitude
    if (type.includes("override action spell")) continue;

    // Skip Dummy effects with negative values — typically DR tooltip values
    if (type.includes("dummy") && d.baseValue != null && d.baseValue < 0)
      continue;

    // Direct baseValue (most modifiers)
    if (d.baseValue != null && d.baseValue !== 0) {
      const unit = inferUnit(type, d.baseValue);
      const result = { value: d.baseValue, unit };
      if (sourceSpell.talentEntry?.maxRank > 1) {
        result.perRank = true;
        result.maxRank = sourceSpell.talentEntry.maxRank;
      }
      return result;
    }

    // scaledValue when baseValue is 0 but scaled isn't
    if (d.scaledValue != null && d.scaledValue !== 0) {
      return { value: d.scaledValue, unit: inferUnit(type, d.scaledValue) };
    }

    // AP/SP coefficient (damage/heal scaling)
    if (d.apCoefficient && d.apCoefficient !== 0) {
      return { value: d.apCoefficient, unit: "ap_coefficient" };
    }
    if (d.spCoefficient && d.spCoefficient !== 0) {
      return { value: d.spCoefficient, unit: "sp_coefficient" };
    }
  }

  // Talent indirection: for debuff modifier spells with all base=0 effects
  // (e.g., Fiery Demise 212818), look for a same-named talent spell that
  // carries the actual magnitude (e.g., Fiery Demise 389220 base=15).
  // Only accept talent spells with label-based modifier effects — Dummy effects
  // often hold tooltip values (like DR percentages) that don't represent damage amps.
  if (spellsByName && sourceSpell.name) {
    const sameNameSpells = spellsByName.get(sourceSpell.name);
    if (sameNameSpells) {
      for (const alt of sameNameSpells) {
        if (alt.id === sourceSpell.id) continue;
        if (!alt.talentEntry) continue;
        // Require the talent to have actual modifier effects, not just Dummy
        const hasModifierEffect = alt.effects?.some((e) => {
          const t = (e.type || "").toLowerCase();
          return t.includes("modifier") || t.includes("damage taken");
        });
        if (!hasModifierEffect) continue;
        const altResult = resolveEffectMagnitude(alt, null, null);
        if (altResult) return altResult;
      }
    }
  }

  return null;
}

function inferUnit(effectType, value) {
  const percentPatterns = [
    "percent modifier",
    "modify damage",
    "mod damage",
    "modify healing",
    "modify parry",
    "modify dodge",
    "modify mastery",
    "haste",
    "damage taken",
  ];
  if (percentPatterns.some((p) => effectType.includes(p))) return "percent";

  const absVal = Math.abs(value);
  if (absVal <= 100 && effectType.includes("modifier")) return "percent";

  // Dummy effects on talent spells are typically percentage modifiers
  // when the value is in a reasonable range (1-100)
  if (effectType.includes("dummy") && absVal > 0 && absVal <= 100)
    return "percent";

  return "flat";
}

// Resolve application method from effect target and spell properties.
export function resolveApplicationMethod(sourceSpell, effectIndices) {
  if (!sourceSpell?.effects?.length) return "passive_always";

  const targetEffects = effectIndices?.length
    ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
    : sourceSpell.effects;

  for (const effect of targetEffects) {
    const target = (effect.details?.target || "").toLowerCase();
    if (target.includes("enemy")) return "debuff_on_target";
    if (target.includes("self")) return "buff_on_player";
  }

  if (sourceSpell.passive) return "passive_always";
  if (sourceSpell.duration > 0) return "buff_on_player";
  return "conditional";
}

// Resolve school targeting from effect data (e.g., "all fire damage" modifiers).
export function resolveSchoolTarget(sourceSpell, effectIndices) {
  if (!sourceSpell?.effects?.length) return null;

  const targetEffects = effectIndices?.length
    ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
    : sourceSpell.effects;

  for (const effect of targetEffects) {
    const d = effect.details || {};
    if (d.schoolMask) return maskToSchoolNames(d.schoolMask);
    if (d["Affected School(s)"]) {
      const s = d["Affected School(s)"];
      if (s === "All") return ["All"];
      return s.split(",").map((n) => n.trim());
    }
    // Check miscValue for school bitmask on damage modifier effects
    if (d.miscValue) {
      const type = (effect.type || "").toLowerCase();
      if (type.includes("damage done") || type.includes("damage taken")) {
        const mask = parseMiscValueMask(d.miscValue);
        if (mask != null && mask > 0 && mask <= 0x7f) {
          return maskToSchoolNames(mask);
        }
      }
    }
  }

  return null;
}

// Extract detailed effect info for enriched interaction output.
// vdhSpellNames: optional Set<string> to filter affectedSpells to VDH-relevant only.
export function extractEffectDetails(
  sourceSpell,
  effectIndices,
  vdhSpellNames,
) {
  if (!sourceSpell?.effects?.length) return null;

  const targetEffects = effectIndices?.length
    ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
    : sourceSpell.effects;

  if (targetEffects.length === 0) return null;

  return targetEffects.map((e) => {
    let affectedSpells =
      e.details?.["Affected Spells"] ||
      e.details?.["Affected Spells (Label)"] ||
      null;

    if (affectedSpells && vdhSpellNames) {
      const filtered = affectedSpells
        .split(", ")
        .filter((s) => vdhSpellNames.has(s.replace(/\s*\(\d{5,6}\)$/, "")))
        .join(", ");
      affectedSpells = filtered || null;
    }

    return {
      index: e.index,
      type: e.type,
      baseValue: e.details?.baseValue ?? null,
      scaledValue: e.details?.scaledValue ?? null,
      target: e.details?.target ?? null,
      schoolMask: e.details?.schoolMask ?? null,
      affectedSpells,
      triggerSpell: e.details?.triggerSpell ?? null,
    };
  });
}

// Infer categories for an interaction (offensive, defensive, resource, utility).
export function inferCategories(interactionType, sourceSpell, effectIndices) {
  const categories = [];

  switch (interactionType) {
    case "damage_modifier":
    case "proc_trigger":
      categories.push("offensive");
      break;
    case "resource_modifier":
      categories.push("resource");
      break;
    case "range_modifier":
      categories.push("utility");
      break;
  }

  // Check for defensive signals in effects
  if (sourceSpell?.effects) {
    const targetEffects = effectIndices?.length
      ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
      : sourceSpell.effects;

    const defensivePatterns = [
      "damage taken",
      "damage done% to caster",
      "modify parry",
      "modify dodge",
      "absorb",
      "modify max health",
      "modify healing",
    ];

    for (const effect of targetEffects) {
      const type = (effect.type || "").toLowerCase();
      if (defensivePatterns.some((p) => type.includes(p))) {
        if (!categories.includes("defensive")) categories.push("defensive");
        break;
      }
    }
  }

  // Defensive type heuristics from interaction type
  if (interactionType === "buff_grant") {
    const name = (sourceSpell?.name || "").toLowerCase();
    const defensiveNames = [
      "spikes",
      "brand",
      "barrier",
      "meta",
      "painbringer",
      "frailty",
      "demonic wards",
      "demon hide",
    ];
    if (defensiveNames.some((n) => name.includes(n))) {
      if (!categories.includes("defensive")) categories.push("defensive");
    }
  }

  return categories.length > 0 ? categories : ["offensive"];
}
