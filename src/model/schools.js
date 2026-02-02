// WoW spell school bitmask utilities.
// Schools are bitmask-encoded: Physical=0x01, Holy=0x02, Fire=0x04, Nature=0x08,
// Frost=0x10, Shadow=0x20, Arcane=0x40. Multi-school types combine flags.

export const SCHOOL_FLAGS = {
  Physical: 0x01,
  Holy: 0x02,
  Fire: 0x04,
  Nature: 0x08,
  Frost: 0x10,
  Shadow: 0x20,
  Arcane: 0x40,
};

export const SCHOOL_MASKS = {
  Physical: 0x01,
  Holy: 0x02,
  Fire: 0x04,
  Nature: 0x08,
  Frost: 0x10,
  Shadow: 0x20,
  Arcane: 0x40,
  Holystrike: 0x03,
  Flamestrike: 0x05,
  Radiant: 0x06,
  Stormstrike: 0x09,
  Holystorm: 0x0a,
  Volcanic: 0x0c,
  Froststrike: 0x11,
  Holyfrost: 0x12,
  Frostfire: 0x14,
  Froststorm: 0x18,
  Shadowstrike: 0x21,
  Twilight: 0x22,
  Shadowflame: 0x24,
  Plague: 0x28,
  Shadowfrost: 0x30,
  Spellstrike: 0x41,
  Divine: 0x42,
  Spellfire: 0x44,
  Astral: 0x48,
  Spellfrost: 0x50,
  Spellshadow: 0x60,
  Elemental: 0x1c,
  Chromatic: 0x7c,
  Cosmic: 0x7e,
  Chaos: 0x7f,
  Magic: 0x7e,
  All: 0x7f,
};

const nameToMask = new Map(
  Object.entries(SCHOOL_MASKS).map(([k, v]) => [k.toLowerCase(), v]),
);

export function schoolNameToMask(schoolName) {
  return nameToMask.get((schoolName || "").toLowerCase()) ?? null;
}

export function schoolContains(schoolName, flagName) {
  const mask = schoolNameToMask(schoolName);
  const flag = SCHOOL_FLAGS[flagName] ?? nameToMask.get(flagName.toLowerCase());
  if (mask == null || flag == null) return false;
  return (mask & flag) === flag;
}

export function spellsWithSchool(spells, flagName) {
  return spells.filter((s) => schoolContains(s.school, flagName));
}

// Parse a miscValue hex string (e.g. "0x7f") into a numeric mask.
export function parseMiscValueMask(miscValue) {
  if (typeof miscValue === "number") return miscValue;
  if (typeof miscValue !== "string") return null;
  const hex = miscValue.match(/^(0x[0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const num = parseInt(miscValue, 10);
  return Number.isNaN(num) ? null : num;
}

// Resolve a mask number to school name(s) it contains.
export function maskToSchoolNames(mask) {
  if (mask == null) return [];
  const names = [];
  for (const [name, flag] of Object.entries(SCHOOL_FLAGS)) {
    if ((mask & flag) === flag) names.push(name);
  }
  return names;
}
