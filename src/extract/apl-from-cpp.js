// Extracts spec APL from simc C++ source to .simc format.
// Reverse of reference/apl-conversion/ConvertAPL.py

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SIMC_DIR, config } from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const APL_CPP = join(
  SIMC_DIR,
  config.simc.aplModule || "engine/class_modules/apl/apl_demon_hunter.cpp",
);
const specName = config.spec.specName;
const OUTPUT = join(ROOT, `reference/${specName}-apl.simc`);

// Extract content between markers
function extractBetweenMarkers(content, startMarker, endMarker) {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Markers not found: ${startMarker} / ${endMarker}`);
  }
  return content.slice(startIdx + startMarker.length, endIdx);
}

// Parse C++ add_action calls into APL lines
function parseAddAction(line) {
  // Match: list->add_action( "action" ); or list->add_action( "action", "comment" );
  const match = line.match(
    /(\w+)->add_action\(\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?\s*\)/,
  );
  if (!match) return null;

  const [, listName, action, comment] = match;

  // Convert list name: default_ -> default, others stay same
  const list = listName === "default_" ? "default" : listName;

  return { list, action, comment };
}

// Convert parsed actions to .simc format
function toSimcFormat(actions) {
  const lines = [];
  let currentList = null;
  let isFirstInList = true;

  for (const { list, action, comment } of actions) {
    if (currentList !== null && currentList !== list) {
      lines.push("");
      isFirstInList = true;
    }
    currentList = list;

    if (comment) {
      lines.push(`# ${comment}`);
    }

    const prefix = list === "default" ? "actions" : `actions.${list}`;
    const operator = isFirstInList ? "=" : "+=";
    lines.push(`${prefix}${operator}/${action}`);

    isFirstInList = false;
  }

  return lines.join("\n");
}

// Add header comments based on list type
function addListHeaders(simc) {
  // Add standard simc APL headers
  const header = `# Executed before combat begins. Accepts non-harmful actions only.`;
  const defaultHeader = `# Executed every time the actor is available.`;

  let output = simc;

  // Insert precombat header
  if (output.includes("actions.precombat=")) {
    output = output.replace(
      "actions.precombat=",
      `${header}\nactions.precombat=`,
    );
  }

  // Insert default header before first actions= line (not actions.*)
  output = output.replace(/^(actions=)/m, `\n${defaultHeader}\n$1`);

  return output.trim();
}

function main() {
  console.log(`Reading APL from: ${APL_CPP}`);

  const cpp = readFileSync(APL_CPP, "utf-8");

  // Extract spec APL section
  const markers = config.simc.aplMarkers?.[specName];
  if (!markers || markers.length !== 2) {
    throw new Error(
      `No APL markers configured for spec "${specName}" in config.simc.aplMarkers`,
    );
  }
  const vengeanceSection = extractBetweenMarkers(cpp, markers[0], markers[1]);

  // Parse all add_action calls
  const actions = [];
  for (const line of vengeanceSection.split("\n")) {
    const parsed = parseAddAction(line);
    if (parsed) {
      actions.push(parsed);
    }
  }

  console.log(`Parsed ${actions.length} actions`);

  // Convert to .simc format
  let simc = toSimcFormat(actions);
  simc = addListHeaders(simc);

  writeFileSync(OUTPUT, simc + "\n");
  console.log(`Written to: ${OUTPUT}`);

  // Show stats
  const lists = new Set(actions.map((a) => a.list));
  console.log(`Action lists: ${[...lists].join(", ")}`);
}

main();
