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
  if (t.includes("add flat modifier")) {
    if (t.includes("cooldown")) return "cooldown_modifier";
    if (t.includes("duration")) return "duration_modifier";
    if (t.includes("range")) return "range_modifier";
    return "damage_modifier";
  }
  if (t.includes("proc trigger spell")) return "proc_trigger";
  if (t.includes("apply aura")) return "buff_grant";
  if (t.includes("trigger spell")) return "proc_trigger";
  return null;
}
