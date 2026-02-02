// Interaction categories for talent → spell relationships.

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
