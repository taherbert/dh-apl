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

// Pre-compiled regexes for stripping pipeline-controlled SimC fields.
// crafted_stats is NOT stripped -- it's an intrinsic item property from gear-candidates.json.
const STRIP_REGEXES = {
  gem_id: /,gem_id=[^,\n]*/g,
  enchant_id: /,enchant_id=[^,\n]*/g,
  embellishment: /,embellishment=[^,\n]*/g,
};

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

  for (const line of preamble) {
    lines.push(line);
  }

  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }

  for (const slot of SLOT_ORDER) {
    const entry = solverOutput[slot];
    if (!entry) {
      lines.push(`# WARNING: missing slot ${slot}`);
      continue;
    }

    // Count sockets from the original simc before stripping
    const socketCount = countSockets(entry.simc);

    // Strip all pipeline-controlled fields, then re-apply from solver output
    let line = stripAllFields(entry.simc);

    if (entry.embellishment) {
      line += `,embellishment=${entry.embellishment}`;
    }

    if (socketCount > 0) {
      line += `,gem_id=${buildGemIds(socketCount, gemConfig)}`;
    }

    const enchantId = enchantConfig[slot];
    if (enchantId) {
      line += `,enchant_id=${enchantId}`;
    }

    lines.push(line);
  }

  return lines.join("\n") + "\n";
}

export function verifyProfile(profileLines, gearCandidates) {
  const errors = [];
  let embCount = 0;
  let craftedCount = 0;

  for (const line of profileLines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    const embMatches = line.match(/embellishment=/g);
    if (embMatches) embCount += embMatches.length;

    if (line.includes("bonus_id=8793") || line.includes("crafted_stats=")) {
      craftedCount++;
    }

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

function stripAllFields(simc) {
  let line = simc;
  for (const re of Object.values(STRIP_REGEXES)) {
    re.lastIndex = 0;
    line = line.replace(re, "");
  }
  return line;
}

function buildGemIds(socketCount, gemConfig) {
  const { primaryGemId, secondaryGemIds = [] } = gemConfig;
  const ids = [primaryGemId];
  for (let i = 1; i < socketCount; i++) {
    ids.push(secondaryGemIds[i - 1] || primaryGemId);
  }
  return ids.join("/");
}
