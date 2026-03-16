// Profile assembly: generates profile.simc from scratch using
// gear-candidates.json + solver output + gem/enchant results.

const SLOT_ORDER = [
  "head",
  "neck",
  "shoulder",
  "back",
  "chest",
  "wrists",
  "hands",
  "waist",
  "legs",
  "feet",
  "finger1",
  "finger2",
  "trinket1",
  "trinket2",
  "main_hand",
  "off_hand",
];

export function countSockets(simcLine) {
  const match = simcLine.match(/gem_id=([^,\n]+)/);
  if (!match) return 0;
  return match[1].split("/").length;
}

export function assembleProfile({
  preamble,
  solverOutput,
  gemConfig,
  enchantConfig,
}) {
  const lines = [];

  // Write preamble (character setup, consumables, overrides)
  for (const line of preamble) {
    lines.push(line);
  }

  // Blank line before gear
  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }

  // Write gear lines in canonical slot order
  for (const slot of SLOT_ORDER) {
    const entry = solverOutput[slot];
    if (!entry) {
      lines.push(`# WARNING: missing slot ${slot}`);
      continue;
    }

    let line = stripAddons(entry.simc);

    // Apply crafted stats
    if (entry.craftedStats && !line.includes("crafted_stats=")) {
      line += `,crafted_stats=${entry.craftedStats}`;
    }

    // Apply embellishment
    if (entry.embellishment && !line.includes("embellishment=")) {
      line += `,embellishment=${entry.embellishment}`;
    }

    // Apply gems based on socket count from candidate simc
    const socketCount = countSockets(entry.simc);
    if (socketCount > 0) {
      line = stripField(line, "gem_id");
      const gemIds = buildGemIds(socketCount, gemConfig);
      line += `,gem_id=${gemIds}`;
    }

    // Apply enchant
    const enchantId = enchantConfig[slot];
    if (enchantId) {
      line = stripField(line, "enchant_id");
      line += `,enchant_id=${enchantId}`;
    }

    lines.push(line);
  }

  return lines.join("\n") + "\n";
}

export function verifyProfile(profileLines, gearCandidates) {
  const errors = [];

  // Count embellishments (explicit embellishment= tags + built-in items)
  let embCount = 0;
  let craftedCount = 0;

  for (const line of profileLines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    // Count explicit embellishments
    const embMatches = line.match(/embellishment=/g);
    if (embMatches) embCount += embMatches.length;

    // Count crafted items
    if (line.includes("bonus_id=8793") || line.includes("crafted_stats=")) {
      craftedCount++;
    }

    // Check gem count against candidates
    const slotMatch = line.match(/^(\w+)=/);
    if (!slotMatch) continue;
    const slot = slotMatch[1];
    const profileGemCount = countSockets(line);

    if (profileGemCount > 0 && gearCandidates.slots?.[slot]) {
      const itemName = line.split(",")[0].split("=")[1];
      const candidate = gearCandidates.slots[slot]?.candidates?.find(
        (c) => c.id === itemName || c.simc?.includes(`${slot}=${itemName}`),
      );
      if (candidate) {
        const expectedGemCount = countSockets(candidate.simc);
        if (profileGemCount !== expectedGemCount) {
          errors.push(
            `${slot}: gem count mismatch - profile has ${profileGemCount}, candidate has ${expectedGemCount}`,
          );
        }
      }
    }
  }

  if (embCount > 2) {
    errors.push(`embellishment overflow: ${embCount} found, max 2 allowed`);
  }

  if (craftedCount > 2) {
    errors.push(`crafted overflow: ${craftedCount} found, max 2 allowed`);
  }

  return { valid: errors.length === 0, errors };
}

function stripAddons(simc) {
  // Remove existing gem_id, enchant_id, crafted_stats, embellishment
  // so they can be cleanly re-applied
  let line = simc;
  line = stripField(line, "gem_id");
  line = stripField(line, "enchant_id");
  line = stripField(line, "crafted_stats");
  line = stripField(line, "embellishment");
  return line;
}

function stripField(line, field) {
  const regex = new RegExp(`,${field}=[^,\\n]*`, "g");
  return line.replace(regex, "");
}

function buildGemIds(socketCount, gemConfig) {
  const { primaryGemId, secondaryGemIds = [] } = gemConfig;
  const ids = [];
  ids.push(primaryGemId);
  for (let i = 1; i < socketCount; i++) {
    ids.push(secondaryGemIds[i - 1] || primaryGemId);
  }
  return ids.join("/");
}
