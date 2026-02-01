// Parses simc spell_query text output into structured JSON objects.

const FIELD_REGEX = /^(\w[\w ]*\w)\s+: (.+)$/;
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

// Clean up internal tracking fields from output
export function cleanSpell(spell) {
  const cleaned = { ...spell };
  delete cleaned._lastMultiField;
  return cleaned;
}
