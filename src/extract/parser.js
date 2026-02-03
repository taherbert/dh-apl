// Parses simc spell_query text output into structured JSON objects.

import {
  schoolNameToMask,
  parseMiscValueMask,
  maskToSchoolNames,
} from "../model/schools.js";

// \s* not \s+ — fields like "Internal Cooldown" fill the 17-char column exactly
const FIELD_REGEX = /^(\w[\w ]*\w)\s*: (.+)$/;
const EFFECT_HEADER_REGEX = /^#(\d+)\s+\(id=(\d+)\)\s+: (.+)$/;
const EFFECT_DETAIL_REGEX = /^\s{19}(.+)$/;
const SPELL_HEADER_REGEX = /^Name\s{2,}: (.+)$/;

export function parseSpellQueryOutput(text) {
  const lines = text.split("\n");
  const spells = [];
  let current = null;
  let currentEffect = null;
  let inEffects = false;
  let descLines = [];
  let inDesc = false;
  let inTooltip = false;
  let tooltipLines = [];
  let inVariables = false;
  let variableLines = [];

  function finishSpell() {
    if (!current) return;
    if (descLines.length) current.description = descLines.join("\n").trim();
    if (tooltipLines.length) current.tooltip = tooltipLines.join("\n").trim();
    if (variableLines.length)
      current.variables = variableLines.join("\n").trim();
    if (currentEffect) current.effects.push(currentEffect);
    spells.push(current);
    current = null;
    currentEffect = null;
    inEffects = false;
    inDesc = false;
    inTooltip = false;
    inVariables = false;
    descLines = [];
    tooltipLines = [];
    variableLines = [];
  }

  for (const line of lines) {
    // Skip the SimulationCraft header line
    if (line.startsWith("SimulationCraft")) continue;
    if (line.trim() === "") {
      if (inDesc || inTooltip || inVariables) continue;
      continue;
    }

    // New spell starts with Name field
    const nameMatch = line.match(SPELL_HEADER_REGEX);
    if (nameMatch) {
      finishSpell();
      current = parseNameLine(nameMatch[1]);
      current.effects = [];
      inEffects = false;
      inDesc = false;
      inTooltip = false;
      inVariables = false;
      descLines = [];
      tooltipLines = [];
      variableLines = [];
      continue;
    }

    if (!current) continue;

    // Description/Tooltip/Variables are multi-line and continue until next field
    if (inVariables) {
      if (line.match(FIELD_REGEX) || line.match(SPELL_HEADER_REGEX)) {
        inVariables = false;
        // fall through to process this line
      } else {
        variableLines.push(line.trim());
        continue;
      }
    }

    if (inTooltip) {
      if (line.match(FIELD_REGEX) && !line.startsWith(" ")) {
        inTooltip = false;
      } else {
        tooltipLines.push(line.trim());
        continue;
      }
    }

    if (inDesc) {
      if (line.match(FIELD_REGEX) && !line.startsWith(" ")) {
        inDesc = false;
      } else if (line.startsWith("Tooltip")) {
        inDesc = false;
        // fall through
      } else if (line.startsWith("Variables")) {
        inDesc = false;
        // fall through
      } else {
        descLines.push(line.trim());
        continue;
      }
    }

    // Effect lines inside Effects block
    if (inEffects) {
      const effectMatch = line.match(EFFECT_HEADER_REGEX);
      if (effectMatch) {
        if (currentEffect) current.effects.push(currentEffect);
        currentEffect = parseEffectHeader(effectMatch);
        continue;
      }
      const detailMatch = line.match(EFFECT_DETAIL_REGEX);
      if (detailMatch && currentEffect) {
        parseEffectDetail(currentEffect, detailMatch[1].trim());
        continue;
      }
      // If we hit a non-effect line, we're done with effects
      if (!line.startsWith(" ") && !line.startsWith("#")) {
        if (currentEffect) {
          current.effects.push(currentEffect);
          currentEffect = null;
        }
        inEffects = false;
        // fall through to process as a field
      } else {
        continue;
      }
    }

    // Check for Effects: header
    if (line.match(/^Effects\s{2,}:/)) {
      inEffects = true;
      continue;
    }

    // Check for Description field start
    if (line.match(/^Description\s{2,}: /)) {
      inDesc = true;
      descLines.push(line.replace(/^Description\s+: /, "").trim());
      continue;
    }
    if (line.match(/^Tooltip\s{2,}: /)) {
      inTooltip = true;
      tooltipLines.push(line.replace(/^Tooltip\s+: /, "").trim());
      continue;
    }
    if (line.match(/^Variables\s{2,}: /)) {
      inVariables = true;
      variableLines.push(line.replace(/^Variables\s+: /, "").trim());
      continue;
    }

    // Standard key: value field
    const fieldMatch = line.match(FIELD_REGEX);
    if (fieldMatch) {
      parseField(current, fieldMatch[1].trim(), fieldMatch[2].trim());
      continue;
    }

    // Continuation lines (indented, for multi-value fields like Labels)
    if (line.startsWith("                 : ")) {
      const val = line.replace(/^\s+: /, "").trim();
      handleContinuation(current, val);
    }
  }

  finishSpell();
  return spells;
}

function parseNameLine(value) {
  // "Spirit Bomb (id=247454) [Spell Family (107)]"
  // "Fiery Brand (id=204021) [Spell Family (107)]"
  // "Soul Cleave (id=228477) [Spell Family (107)]"
  const match = value.match(/^(.+?)\s+\(id=(\d+)\)\s*(?:\[(.+?)\])?\s*$/);
  if (!match) return { rawName: value };
  const flags = match[3] ? match[3].split(",").map((s) => s.trim()) : [];
  return {
    name: match[1].trim(),
    id: parseInt(match[2]),
    flags,
    passive: flags.includes("Passive"),
    hidden: flags.includes("Hidden"),
  };
}

function parseEffectHeader(match) {
  // #1 (id=377039)   : Apply Aura (6) | Dummy (4)
  return {
    index: parseInt(match[1]),
    effectId: parseInt(match[2]),
    type: match[3].trim(),
  };
}

function parseEffectDetail(effect, detail) {
  // "Base Value: 25 | Scaled Value: 25 | Target: Self (1)"
  // "Base Value: 0 | Scaled Value: 0 (delta=0.05) | AP Coefficient: 2.08 | Target: Enemy (6)"
  if (!effect.details) effect.details = {};
  const parts = detail.split("|").map((s) => s.trim());
  for (const part of parts) {
    const kv = part.match(/^(.+?):\s*(.+)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (key === "Base Value") effect.details.baseValue = parseFloat(val);
      else if (key === "Scaled Value") {
        const svMatch = val.match(/^([\d.-]+)(?:\s+\(delta=([\d.]+)\))?/);
        if (svMatch) {
          effect.details.scaledValue = parseFloat(svMatch[1]);
          if (svMatch[2]) effect.details.delta = parseFloat(svMatch[2]);
        }
      } else if (key === "AP Coefficient")
        effect.details.apCoefficient = parseFloat(val);
      else if (key === "SP Coefficient")
        effect.details.spCoefficient = parseFloat(val);
      else if (key === "Target") effect.details.target = val;
      else if (key === "Trigger Spell")
        effect.details.triggerSpell = parseInt(val);
      else if (key === "Radius") effect.details.radius = val;
      else if (key === "Misc Value") effect.details.miscValue = val;
      else if (key === "Misc Value 2") effect.details.miscValue2 = val;
      else effect.details[key] = val;
    }
  }
}

function parseField(spell, key, value) {
  switch (key) {
    case "Talent Entry": {
      // "Vengeance [tree=spec, row=5, col=1, max_rank=1, req_points=8]"
      const m = value.match(
        /^(\w+)\s+\[tree=(\w+),\s*row=(\d+),\s*col=(\d+),\s*max_rank=(\d+)(?:,\s*req_points=(\d+))?\]/,
      );
      if (m) {
        spell.talentEntry = {
          spec: m[1],
          tree: m[2],
          row: parseInt(m[3]),
          col: parseInt(m[4]),
          maxRank: parseInt(m[5]),
          reqPoints: m[6] ? parseInt(m[6]) : 0,
        };
      }
      break;
    }
    case "Class":
      spell.class = value;
      break;
    case "School":
      spell.school = value;
      break;
    case "Spell Type":
      spell.spellType = value === "None" ? null : value;
      break;
    case "Resource": {
      // "40 Fury (17) (id=191871)"
      const m = value.match(/^(\d+)\s+(\w+)\s+\((\d+)\)(?:\s+\(id=(\d+)\))?/);
      if (m)
        spell.resource = {
          cost: parseInt(m[1]),
          type: m[2],
          typeId: parseInt(m[3]),
          spellId: m[4] ? parseInt(m[4]) : null,
        };
      break;
    }
    case "GCD": {
      const m = value.match(/^([\d.]+)\s+seconds/);
      if (m) spell.gcd = parseFloat(m[1]);
      break;
    }
    case "Cooldown": {
      const m = value.match(/^([\d.]+)\s+seconds/);
      if (m) spell.cooldown = parseFloat(m[1]);
      break;
    }
    case "Charges": {
      // "1 (60 seconds cooldown)"
      const m = value.match(/^(\d+)\s+\(([\d.]+)\s+seconds cooldown\)/);
      if (m)
        spell.charges = { count: parseInt(m[1]), cooldown: parseFloat(m[2]) };
      break;
    }
    case "Duration": {
      const m = value.match(/^([\d.]+)\s+seconds/);
      if (m) spell.duration = parseFloat(m[1]);
      break;
    }
    case "Spell Level": {
      spell.spellLevel = parseInt(value);
      break;
    }
    case "Range": {
      const m = value.match(/^([\d.]+)\s+yards/);
      if (m) spell.range = parseFloat(m[1]);
      break;
    }
    case "Stacks": {
      const m = value.match(/^(\d+)\s+maximum/);
      if (m) spell.maxStacks = parseInt(m[1]);
      break;
    }
    case "Proc Chance": {
      spell.procChance = parseFloat(value.replace("%", ""));
      break;
    }
    case "Real PPM": {
      const m = value.match(/^([\d.]+)/);
      if (m) spell.realPPM = parseFloat(m[1]);
      break;
    }
    case "Internal Cooldown": {
      const m = value.match(/^([\d.]+)\s+seconds/);
      if (m) spell.internalCooldown = parseFloat(m[1]);
      break;
    }
    case "Category Cooldown": {
      const m = value.match(/^([\d.]+)\s+seconds/);
      if (m) spell.categoryCooldown = parseFloat(m[1]);
      break;
    }
    case "Labels":
      if (!spell.labels) spell.labels = [];
      spell.labels.push(value);
      spell._lastMultiField = "labels";
      break;
    case "Affecting Spells":
      spell.affectingSpells = parseSpellReferences(value);
      spell._lastMultiField = "affectingSpells";
      break;
    case "Triggered By":
      spell.triggeredBy = parseSpellReferences(value);
      break;
    case "Replaces":
      spell.replaces = parseSpellReference(value);
      break;
    case "Category":
      spell.category = value;
      break;
    case "Attributes":
      spell.attributes = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      spell._lastMultiField = "attributes";
      break;
    case "Family Flags":
      spell.familyFlags = value.split(",").map((s) => s.trim());
      break;
    case "Proc Flags":
      spell.procFlags = value;
      break;
    case "Requires weapon":
      spell.requiresWeapon = value;
      break;
    case "Aura Interrupt":
      spell.auraInterrupt = value;
      break;
    case "Replace SpellID":
      spell.replaceSpellId = parseInt(value);
      break;
  }
}

function handleContinuation(spell, value) {
  if (!spell._lastMultiField) return;
  const field = spell._lastMultiField;
  if (Array.isArray(spell[field])) {
    if (field === "affectingSpells") {
      spell[field].push(...parseSpellReferences(value));
    } else {
      spell[field].push(value);
    }
  }
}

function parseSpellReferences(text) {
  // "Havoc Demon Hunter (212612 effect#3), Vengeance Demon Hunter (212613 effect#3)"
  // "Demon Soul (163073 effects: #1, #2), Fiery Brand (207744 effect#2)"
  const refs = [];
  const regex = /([^,]+?\(\d+[^)]*\))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const ref = parseSpellReference(match[1].trim());
    if (ref) refs.push(ref);
  }
  if (refs.length === 0 && text.trim()) {
    // Single reference without comma
    const ref = parseSpellReference(text.trim());
    if (ref) refs.push(ref);
  }
  return refs;
}

function parseSpellReference(text) {
  // "Spirit Bomb (247454 effect#1)"
  // "Demon Soul (163073 effects: #1, #2)"
  const m = text.match(/^(.+?)\s+\((\d+)(?:\s+(.+))?\)/);
  if (!m) return null;
  const ref = { name: m[1].trim(), id: parseInt(m[2]) };
  if (m[3]) {
    const effectMatch = m[3].match(/effects?:?\s*#?([\d,\s#]+)/i);
    if (effectMatch) {
      ref.effects = effectMatch[1].match(/\d+/g)?.map(Number) || [];
    }
  }
  return ref;
}

// Spells where simc's school field is the placement/wrapper school but
// the actual damage school differs. Override to the damage school for
// APL reasoning purposes.
const SCHOOL_OVERRIDES = {
  204596: "Fire", // Sigil of Flame — placement is Physical, damage (204598) is Fire
};

// Clean up internal tracking fields from output and enrich with school masks.
export function cleanSpell(spell) {
  const cleaned = { ...spell };
  delete cleaned._lastMultiField;

  // Apply school overrides for spells whose wrapper school differs from damage school
  if (SCHOOL_OVERRIDES[cleaned.id]) {
    cleaned.school = SCHOOL_OVERRIDES[cleaned.id];
  }

  // Add spell-level schoolMask from the school string
  if (cleaned.school) {
    const mask = schoolNameToMask(cleaned.school);
    if (mask != null) cleaned.schoolMask = mask;
  }

  // Add effect-level schoolMask where miscValue contains a school bitmask
  if (cleaned.effects) {
    for (const effect of cleaned.effects) {
      if (!effect.details?.miscValue) continue;
      const type = (effect.type || "").toLowerCase();
      // School masks appear on damage modification, school damage, and "affected school" effects
      if (
        type.includes("damage done") ||
        type.includes("damage taken") ||
        type.includes("school damage") ||
        type.includes("modifier") ||
        effect.details["Affected School(s)"]
      ) {
        const mask = parseMiscValueMask(effect.details.miscValue);
        if (mask != null && mask > 0 && mask <= 0x7f) {
          effect.details.schoolMask = mask;
          effect.details.schoolNames = maskToSchoolNames(mask);
        }
      }
    }
  }

  // 1A: Extract resource generation from energize effects and descriptions
  const generates = [];
  if (cleaned.effects) {
    for (const effect of cleaned.effects) {
      const type = (effect.type || "").toLowerCase();
      if (type.includes("energize") && effect.details?.baseValue) {
        const resourceType =
          effect.details.Resource || (type.includes("fury") ? "Fury" : null);
        generates.push({
          amount: effect.details.baseValue,
          resourceType: resourceType || "unknown",
        });
      }
    }
  }
  // Parse soul fragment generation from resolved descriptions
  if (cleaned.description) {
    // Match patterns like "shatter 2 Lesser Soul Fragments", "shatters $s1 Lesser Soul"
    // where $s1 has been resolved, or literal numbers
    const fragPatterns = [
      /shatters?\s+(\d+)\s+(?:lesser\s+)?soul\s+fragments?/i,
      /generates?\s+(\d+)\s+(?:lesser\s+)?soul\s+fragments?/i,
      /creates?\s+(\d+)\s+(?:lesser\s+)?soul\s+fragments?/i,
    ];
    for (const pat of fragPatterns) {
      const m = cleaned.description.match(pat);
      if (m) {
        generates.push({
          amount: parseInt(m[1]),
          resourceType: "Soul Fragments",
        });
        break;
      }
    }
    // Also check for unresolved $sN references in fragment context
    // and resolve from effect data
    if (
      !generates.some((g) => g.resourceType === "Soul Fragments") &&
      /soul\s+fragment/i.test(cleaned.description)
    ) {
      const unresolved = cleaned.description.match(
        /shatters?\s+\$s(\d+)\s+(?:lesser\s+)?soul/i,
      );
      if (unresolved) {
        const effectIdx = parseInt(unresolved[1]);
        const effect = cleaned.effects?.find((e) => e.index === effectIdx);
        if (effect?.details?.baseValue) {
          generates.push({
            amount: effect.details.baseValue,
            resourceType: "Soul Fragments",
          });
        }
      }
    }
  }
  // Build resourceFlow combining costs and generates
  const costs = [];
  if (cleaned.resource) {
    costs.push({
      amount: cleaned.resource.cost,
      resourceType: cleaned.resource.type,
    });
  }
  if (costs.length > 0 || generates.length > 0) {
    cleaned.resourceFlow = {
      costs: costs.length > 0 ? costs : undefined,
      generates: generates.length > 0 ? generates : undefined,
    };
  }
  if (generates.length > 0) {
    cleaned.generates = generates;
  }

  // 1D: Haste scaling flags from attributes
  if (cleaned.attributes?.length) {
    const attrs = cleaned.attributes.map((a) => a.toLowerCase());
    const hasteScaling = {};
    let hasAny = false;
    if (attrs.some((a) => a.includes("haste affects period"))) {
      hasteScaling.ticks = true;
      hasAny = true;
    }
    if (attrs.some((a) => a.includes("haste affects duration"))) {
      hasteScaling.duration = true;
      hasAny = true;
    }
    if (attrs.some((a) => a.includes("haste affects cooldown"))) {
      hasteScaling.cooldown = true;
      hasAny = true;
    }
    // GCD is haste-scaled by default for most spells unless "not affected by gcd"
    if (cleaned.gcd && cleaned.gcd > 0) {
      hasteScaling.gcd = true;
      hasAny = true;
    }
    if (hasAny) cleaned.hasteScaling = hasteScaling;
  }

  // 1E: Explicit GCD=0 for off-GCD spells
  // Active spells without a GCD field from spell_query are off-GCD
  if (cleaned.gcd == null && !cleaned.passive && !cleaned.hidden) {
    cleaned.gcd = 0;
  }

  // 1F: AoE data extraction from effect details
  if (cleaned.effects) {
    let radius = null;
    let maxTargets = null;
    for (const effect of cleaned.effects) {
      if (effect.details?.radius && !radius) {
        // Parse "0 - 8 yards" or "8 yards" → numeric
        const rMatch = effect.details.radius.match(
          /(?:\d+\s*-\s*)?(\d+(?:\.\d+)?)\s*yards?/i,
        );
        if (rMatch) radius = parseFloat(rMatch[1]);
      }
      if (effect.details?.target) {
        const tgtMatch = effect.details.target.match(
          /max[_\s]*(\d+)\s*targets?/i,
        );
        if (tgtMatch) maxTargets = parseInt(tgtMatch[1]);
      }
    }
    const reducedAoe = cleaned.attributes?.some((a) =>
      /reduced\s*aoe/i.test(a),
    );
    if (radius || maxTargets || reducedAoe) {
      cleaned.aoe = {};
      if (radius) cleaned.aoe.radius = radius;
      if (maxTargets) cleaned.aoe.maxTargets = maxTargets;
      if (reducedAoe) cleaned.aoe.reducedAoe = true;
    }
  }

  return cleaned;
}
