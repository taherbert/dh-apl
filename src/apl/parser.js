// APL parser/generator for SimulationCraft .simc action priority lists.
// Parses APL text into an AST and serializes back, enabling programmatic manipulation.
// Non-APL lines (profile, gear) are preserved as raw text sections for round-trip fidelity.

// --- AST Node Types ---
// ActionList: { type: "ActionList", name: string, entries: Entry[] }
// RawSection: { type: "RawSection", lines: string[] }
// Action: { type: "Action", ability: string, modifiers: Map<string, string> }
// Variable: { type: "Variable", modifiers: Map<string, string> }
// RunActionList: { type: "RunActionList", variant: "run"|"call", modifiers: Map<string, string> }
// Comment: { type: "Comment", text: string }

// Parse a .simc APL text into an ordered array of sections (ActionLists and RawSections).
export function parse(text) {
  const lines = text.split("\n");
  const sections = [];
  const lists = new Map();
  let currentRaw = null;

  function ensureRaw() {
    if (!currentRaw) {
      currentRaw = { type: "RawSection", lines: [] };
      sections.push(currentRaw);
    }
    return currentRaw;
  }

  function getOrCreateList(name) {
    if (lists.has(name)) return lists.get(name);
    currentRaw = null; // break raw accumulation
    const list = { type: "ActionList", name, entries: [] };
    lists.set(name, list);
    sections.push(list);
    return list;
  }

  // Track which list was most recently referenced for comment attribution
  let lastList = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // APL lines: actions=..., actions+=/..., actions.listname=..., actions.listname+=/...
    const aplMatch = line.match(/^actions(?:\.(\w+))?\+?=\/?(.*)$/);
    if (aplMatch) {
      const listName = aplMatch[1] || "default";
      const content = aplMatch[2];
      const list = getOrCreateList(listName);
      const entry = parseEntry(content);
      if (entry) list.entries.push(entry);
      lastList = list;
      continue;
    }

    // Comment lines — attach to the most recently active action list if one exists,
    // otherwise treat as raw
    if (line.startsWith("#")) {
      if (lastList) {
        lastList.entries.push({
          type: "Comment",
          text: line.slice(1).trimStart(),
        });
      } else {
        ensureRaw().lines.push(line);
      }
      continue;
    }

    // Blank lines
    if (line.trim() === "") {
      if (lastList) {
        // Check if the next non-blank line is an APL line for the same list
        // For simplicity, attach blank lines to current list as empty comments
        lastList.entries.push({ type: "Comment", text: "" });
      } else {
        ensureRaw().lines.push(line);
      }
      continue;
    }

    // Non-APL line (profile data, gear, etc.) — breaks any active list context
    lastList = null;
    currentRaw = null; // force a new raw section after any list
    ensureRaw().lines.push(line);
  }

  return sections;
}

// Parse a single APL entry content string into an AST node.
function parseEntry(content) {
  if (!content || content.trim() === "") return null;

  const parts = splitModifiers(content);
  const ability = parts[0];
  const modifiers = new Map();

  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf("=");
    if (eqIdx === -1) {
      modifiers.set(parts[i], "");
    } else {
      modifiers.set(parts[i].slice(0, eqIdx), parts[i].slice(eqIdx + 1));
    }
  }

  if (ability === "variable") return { type: "Variable", modifiers };
  if (ability === "run_action_list")
    return { type: "RunActionList", variant: "run", modifiers };
  if (ability === "call_action_list")
    return { type: "RunActionList", variant: "call", modifiers };
  return { type: "Action", ability, modifiers };
}

// Split by commas, respecting parentheses nesting.
function splitModifiers(content) {
  const parts = [];
  let current = "";
  let depth = 0;

  for (const ch of content) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Serialize sections back to .simc text.
export function serialize(sections) {
  const lines = [];

  for (const section of sections) {
    if (section.type === "RawSection") {
      for (const line of section.lines) lines.push(line);
      continue;
    }

    if (section.type !== "ActionList") continue;

    const prefix =
      section.name === "default" ? "actions" : `actions.${section.name}`;
    let isFirst = true;

    for (const entry of section.entries) {
      if (entry.type === "Comment") {
        if (entry.text === "") {
          lines.push("");
        } else {
          lines.push(`# ${entry.text}`);
        }
        continue;
      }

      const entryStr = serializeEntry(entry);
      if (isFirst) {
        lines.push(`${prefix}=${entryStr}`);
        isFirst = false;
      } else {
        lines.push(`${prefix}+=/` + entryStr);
      }
    }
  }

  return lines.join("\n") + "\n";
}

function serializeEntry(entry) {
  const parts = [];

  if (entry.type === "Variable") {
    parts.push("variable");
  } else if (entry.type === "RunActionList") {
    parts.push(
      entry.variant === "call" ? "call_action_list" : "run_action_list",
    );
  } else {
    parts.push(entry.ability);
  }

  for (const [key, value] of entry.modifiers) {
    if (value === "") {
      parts.push(key);
    } else {
      parts.push(`${key}=${value}`);
    }
  }

  return parts.join(",");
}

// Get all ActionList sections (excluding RawSections).
export function getActionLists(sections) {
  return sections.filter((s) => s.type === "ActionList");
}

// Find all actions matching an ability name across all lists.
export function findAction(sections, abilityName) {
  const results = [];
  for (const section of sections) {
    if (section.type !== "ActionList") continue;
    for (let i = 0; i < section.entries.length; i++) {
      const entry = section.entries[i];
      if (entry.type === "Action" && entry.ability === abilityName) {
        results.push({ list: section.name, index: i, action: entry });
      }
    }
  }
  return results;
}

// Insert an action entry at a specific index in a named list.
export function insertAction(sections, listName, index, entry) {
  const list = sections.find(
    (s) => s.type === "ActionList" && s.name === listName,
  );
  if (!list) throw new Error(`Action list "${listName}" not found`);
  if (index < 0 || index > list.entries.length) {
    throw new Error(`Index ${index} out of range for list "${listName}"`);
  }
  list.entries.splice(index, 0, entry);
}

// Remove an action entry at a specific index from a named list.
export function removeAction(sections, listName, index) {
  const list = sections.find(
    (s) => s.type === "ActionList" && s.name === listName,
  );
  if (!list) throw new Error(`Action list "${listName}" not found`);
  if (index < 0 || index >= list.entries.length) {
    throw new Error(`Index ${index} out of range for list "${listName}"`);
  }
  return list.entries.splice(index, 1)[0];
}

// Replace the `if=` condition on an action entry.
export function replaceCondition(entry, newCondition) {
  if (!entry.modifiers) throw new Error("Entry has no modifiers");
  if (newCondition) {
    entry.modifiers.set("if", newCondition);
  } else {
    entry.modifiers.delete("if");
  }
}

// Create a new Action entry.
export function createAction(ability, modifiers = {}) {
  return {
    type: "Action",
    ability,
    modifiers: new Map(Object.entries(modifiers)),
  };
}

// Create a new Variable entry.
export function createVariable(name, op, value, condition) {
  const mods = new Map();
  mods.set("name", name);
  if (op) mods.set("op", op);
  if (value) mods.set("value", value);
  if (condition) mods.set("if", condition);
  return { type: "Variable", modifiers: mods };
}

// CLI: round-trip test
if (import.meta.url === `file://${process.argv[1]}`) {
  import("node:fs").then(({ readFileSync }) => {
    const file = process.argv[2];
    if (!file) {
      console.log("Usage: node src/apl/parser.js <file.simc>");
      console.log("Round-trips a .simc file through parse → serialize.");
      process.exit(1);
    }

    const text = readFileSync(file, "utf-8");
    const ast = parse(text);
    const output = serialize(ast);

    const lists = getActionLists(ast);
    let totalEntries = 0;
    let actionEntries = 0;
    for (const list of lists) {
      for (const entry of list.entries) {
        totalEntries++;
        if (entry.type !== "Comment") actionEntries++;
      }
    }

    console.log(
      `Parsed ${lists.length} action lists: ${lists.map((l) => l.name).join(", ")}`,
    );
    console.log(`Total entries: ${totalEntries} (${actionEntries} actions)`);

    const normInput = text.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n");
    const normOutput = output.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n");

    if (normInput === normOutput) {
      console.log("Round-trip: PERFECT");
    } else {
      const iLines = normInput.split("\n");
      const oLines = normOutput.split("\n");
      let diffs = 0;
      const maxLine = Math.max(iLines.length, oLines.length);
      for (let i = 0; i < maxLine; i++) {
        if (iLines[i] !== oLines[i]) {
          diffs++;
          if (diffs <= 5) {
            console.log(`Line ${i + 1} differs:`);
            console.log(`  IN:  ${(iLines[i] || "(missing)").slice(0, 120)}`);
            console.log(`  OUT: ${(oLines[i] || "(missing)").slice(0, 120)}`);
          }
        }
      }
      console.log(
        `Round-trip: ${diffs} line differences (of ${maxLine} lines)`,
      );
    }

    const spiritBombs = findAction(ast, "spirit_bomb");
    console.log(
      `\nfindAction("spirit_bomb"): ${spiritBombs.length} occurrences`,
    );
    for (const hit of spiritBombs.slice(0, 3)) {
      const cond = hit.action.modifiers.get("if") || "(unconditional)";
      console.log(`  ${hit.list}[${hit.index}]: if=${cond.slice(0, 80)}`);
    }
  });
}
