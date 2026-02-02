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

  // Known damage modifiers
  if (
    n.includes("empowerment") ||
    n.includes("any means necessary") ||
    n.includes("chaos blades") ||
    n.includes("seething chaos") ||
    n.includes("exergy") ||
    n.includes("inertia") ||
    n.includes("demon soul") ||
    n.includes("burning blades") ||
    n.includes("fires of fel") ||
    n.includes("fiery demise") ||
    n.includes("mastery:")
  )
    return "damage_modifier";

  // Known buff/debuff grants
  if (
    n.includes("mark") ||
    n.includes("brand") ||
    n.includes("reaver") ||
    n.includes("revel in pain") ||
    n.includes("spirit of the darkness flame") ||
    n.includes("fiery resolve")
  )
    return "buff_grant";

  // Known mechanic changes
  if (n.includes("thrill of the fight") || n.includes("demonsurge"))
    return "mechanic_change";

  // Lucky procs
  if (n.includes("luck of the draw")) return "proc_trigger";

  // Modifier/rank spells that modify the parent ability
  if (n.includes("immolation aura")) return "damage_modifier";
  if (n.includes("soul furnace")) return "damage_modifier";
  if (n.includes("soul rending")) return "buff_grant";
  if (n.includes("evasive action")) return "mechanic_change";
  if (n.includes("unleashed power")) return "resource_modifier";
  if (n.includes("prepared")) return "resource_modifier";
  if (n.includes("cover of darkness")) return "duration_modifier";
  if (n.includes("bionic stabilizer")) return "damage_modifier";
  if (n.includes("serrated glaive")) return "damage_modifier";
  if (n.includes("first of the illidari")) return "cooldown_modifier";
  if (n.includes("metamorphosis")) return "buff_grant";
  if (n.includes("fel defender")) return "cooldown_modifier";
  if (n.includes("burning wound")) return "damage_modifier";
  if (n.includes("scarred strikes")) return "damage_modifier";
  if (n.includes("soul flame")) return "damage_modifier";
  if (n.includes("demon hide")) return "buff_grant";
  if (n.includes("extended spikes")) return "duration_modifier";
  if (n.includes("shear fury")) return "resource_modifier";
  if (n.includes("rush of chaos")) return "cooldown_modifier";
  if (n.includes("tactical retreat")) return "resource_modifier";
  if (n.includes("accelerated blade")) return "damage_modifier";

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
export function resolveEffectMagnitude(sourceSpell, effectIndices) {
  if (!sourceSpell?.effects?.length) return null;

  const targetEffects = effectIndices?.length
    ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
    : sourceSpell.effects;

  for (const effect of targetEffects) {
    const d = effect.details || {};
    const type = (effect.type || "").toLowerCase();

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

  return null;
}

function inferUnit(effectType, value) {
  if (
    effectType.includes("percent modifier") ||
    effectType.includes("modify damage") ||
    effectType.includes("mod damage") ||
    effectType.includes("modify healing") ||
    effectType.includes("modify parry") ||
    effectType.includes("modify dodge") ||
    effectType.includes("modify mastery") ||
    effectType.includes("haste")
  ) {
    return "percent";
  }
  if (Math.abs(value) <= 100 && effectType.includes("modifier"))
    return "percent";
  if (effectType.includes("flat modifier")) return "flat";
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
export function extractEffectDetails(sourceSpell, effectIndices) {
  if (!sourceSpell?.effects?.length) return null;

  const targetEffects = effectIndices?.length
    ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
    : sourceSpell.effects;

  if (targetEffects.length === 0) return null;

  return targetEffects.map((e) => ({
    index: e.index,
    type: e.type,
    baseValue: e.details?.baseValue ?? null,
    scaledValue: e.details?.scaledValue ?? null,
    target: e.details?.target ?? null,
    schoolMask: e.details?.schoolMask ?? null,
    affectedSpells:
      e.details?.["Affected Spells"] ||
      e.details?.["Affected Spells (Label)"] ||
      null,
    triggerSpell: e.details?.triggerSpell ?? null,
  }));
}

// Infer categories for an interaction (offensive, defensive, resource, utility).
export function inferCategories(interactionType, sourceSpell, effectIndices) {
  const categories = [];

  if (
    interactionType === "damage_modifier" ||
    interactionType === "proc_trigger"
  ) {
    categories.push("offensive");
  }
  if (interactionType === "resource_modifier") {
    categories.push("resource");
  }
  if (interactionType === "range_modifier") {
    categories.push("utility");
  }

  // Check for defensive signals in effects
  if (sourceSpell?.effects) {
    const targetEffects = effectIndices?.length
      ? sourceSpell.effects.filter((e) => effectIndices.includes(e.index))
      : sourceSpell.effects;

    for (const effect of targetEffects) {
      const type = (effect.type || "").toLowerCase();
      if (
        type.includes("damage taken") ||
        type.includes("damage done% to caster") ||
        type.includes("modify parry") ||
        type.includes("modify dodge") ||
        type.includes("absorb") ||
        type.includes("modify max health")
      ) {
        if (!categories.includes("defensive")) categories.push("defensive");
      }
      if (type.includes("modify healing")) {
        if (!categories.includes("defensive")) categories.push("defensive");
      }
    }
  }

  // Defensive type heuristics from interaction type
  if (interactionType === "buff_grant") {
    const name = (sourceSpell?.name || "").toLowerCase();
    if (
      name.includes("spikes") ||
      name.includes("brand") ||
      name.includes("barrier") ||
      name.includes("meta") ||
      name.includes("painbringer") ||
      name.includes("frailty") ||
      name.includes("demonic wards") ||
      name.includes("demon hide")
    ) {
      if (!categories.includes("defensive")) categories.push("defensive");
    }
  }

  return categories.length > 0 ? categories : ["offensive"];
}
