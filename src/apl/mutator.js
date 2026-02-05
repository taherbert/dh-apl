// APL Mutator — translates hypotheses into APL changes.
// Applies structured mutations to APL ASTs and generates candidate files.
// Usage: node src/apl/mutator.js <apl-file.simc> <mutation.json>

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parse,
  serialize,
  getActionLists,
  findAction,
  replaceCondition,
  insertAction,
  removeAction,
  createAction,
  createVariable,
} from "./parser.js";
import {
  parseCondition,
  serializeCondition,
  addClause,
  removeClause,
  extractSemantics,
} from "./condition-parser.js";
// Mutation operation types — extended for sophisticated APL patterns
export const MUTATION_OPS = {
  // Basic operations (existing)
  ADD_CONDITION: "add_condition",
  REMOVE_CONDITION: "remove_condition",
  RELAX_THRESHOLD: "relax_threshold",
  TIGHTEN_THRESHOLD: "tighten_threshold",
  MOVE_UP: "move_up",
  MOVE_DOWN: "move_down",

  // Sophisticated operations (new)
  ADD_VARIABLE: "add_variable", // Create APL variable with computed expression
  ADD_ACTION_LIST: "add_action_list", // Create new action sub-list
  INSERT_ACTION: "insert_action", // Insert action at specific position
  ADD_PHASE: "add_phase", // Create phase-specific sub-list with call
  REPLACE_ACTION: "replace_action", // Replace entire action line
  DELETE_ACTION: "delete_action", // Remove action from list
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const MUTATION_HANDLERS = {
  [MUTATION_OPS.ADD_CONDITION]: applyAddCondition,
  [MUTATION_OPS.REMOVE_CONDITION]: applyRemoveCondition,
  [MUTATION_OPS.RELAX_THRESHOLD]: applyRelaxThreshold,
  [MUTATION_OPS.TIGHTEN_THRESHOLD]: applyTightenThreshold,
  [MUTATION_OPS.MOVE_UP]: (ast, m) => applyMoveAction(ast, m, -1),
  [MUTATION_OPS.MOVE_DOWN]: (ast, m) => applyMoveAction(ast, m, 1),
  // Sophisticated mutation handlers
  [MUTATION_OPS.ADD_VARIABLE]: applyAddVariable,
  [MUTATION_OPS.ADD_ACTION_LIST]: applyAddActionList,
  [MUTATION_OPS.INSERT_ACTION]: applyInsertAction,
  [MUTATION_OPS.ADD_PHASE]: applyAddPhase,
  [MUTATION_OPS.REPLACE_ACTION]: applyReplaceAction,
  [MUTATION_OPS.DELETE_ACTION]: applyDeleteAction,
};

export function applyMutation(ast, mutation) {
  const handler = MUTATION_HANDLERS[mutation.type];
  if (!handler) throw new Error(`Unknown mutation type: ${mutation.type}`);

  const astCopy = JSON.parse(JSON.stringify(ast, mapReplacer), mapReviver);
  return handler(astCopy, mutation);
}

function applyAddCondition(ast, mutation) {
  const { list, ability, condition, operator = "&" } = mutation;
  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List "${list}" not found in APL`);
  }
  const actions = findActionInList(ast, list, ability);
  if (actions.length === 0) {
    throw new Error(`Action "${ability}" not found in list "${list}"`);
  }

  for (const { action } of actions) {
    const existingAst = parseCondition(action.modifiers?.get("if") || "");
    action.modifiers.set(
      "if",
      serializeCondition(addClause(existingAst, condition, operator)),
    );
  }

  return {
    ast,
    description: `Added condition "${condition}" to ${ability} in ${list}`,
    affectedLines: actions.length,
  };
}

function applyRemoveCondition(ast, mutation) {
  const { list, ability, targetBuff, removeNegation } = mutation;
  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List "${list}" not found in APL`);
  }
  const actions = findActionInList(ast, list, ability);
  if (actions.length === 0) {
    throw new Error(`Action "${ability}" not found in list "${list}"`);
  }

  const predicate = (node) => {
    // Remove plain buff check only when not targeting negation
    if (node.type === "BuffCheck" && node.buff === targetBuff) {
      return !removeNegation;
    }
    // Remove negated buff check only when targeting negation
    if (
      node.type === "Not" &&
      node.operand?.type === "BuffCheck" &&
      node.operand.buff === targetBuff
    ) {
      return removeNegation === true;
    }
    return false;
  };

  let removed = false;
  for (const { action } of actions) {
    const existingCondition = action.modifiers?.get("if");
    if (!existingCondition) continue;

    const newAst = removeClause(parseCondition(existingCondition), predicate);
    const newCondition = newAst ? serializeCondition(newAst) : "";

    if (newCondition !== existingCondition) {
      removed = true;
      if (newCondition) {
        action.modifiers.set("if", newCondition);
      } else {
        action.modifiers.delete("if");
      }
    }
  }

  if (!removed) {
    throw new Error(
      `Could not find buff "${targetBuff}" condition in ${ability}`,
    );
  }

  return {
    ast,
    description: `Removed ${targetBuff} condition from ${ability} in ${list}`,
    affectedLines: actions.length,
  };
}

function applyRelaxThreshold(ast, mutation) {
  const { list, ability, resource, adjustment = -10 } = mutation;
  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List "${list}" not found in APL`);
  }
  const actions = findActionInList(ast, list, ability);
  if (actions.length === 0) {
    throw new Error(`Action "${ability}" not found in list "${list}"`);
  }

  let modified = false;
  for (const { action } of actions) {
    const existingCondition = action.modifiers?.get("if");
    if (!existingCondition) continue;

    const semantics = extractSemantics(parseCondition(existingCondition));

    for (const gate of semantics.resourceGates) {
      if (gate.resource !== resource || !gate.value) continue;

      const oldValue = parseInt(gate.value, 10);
      if (isNaN(oldValue)) continue;

      let newValue;
      if (gate.op === ">=" || gate.op === ">") {
        newValue = Math.max(0, oldValue + adjustment);
      } else if (gate.op === "<=" || gate.op === "<") {
        newValue = oldValue - adjustment;
      } else {
        continue;
      }

      const oldPattern = `${resource}${gate.op}${oldValue}`;
      const newPattern = `${resource}${gate.op}${newValue}`;
      const newCondition = existingCondition.replace(oldPattern, newPattern);

      if (newCondition !== existingCondition) {
        modified = true;
        action.modifiers.set("if", newCondition);
      }
    }
  }

  if (!modified) {
    throw new Error(
      `Could not find ${resource} threshold in ${ability} to relax`,
    );
  }

  return {
    ast,
    description: `Relaxed ${resource} threshold in ${ability} by ${adjustment}`,
    affectedLines: actions.length,
  };
}

function applyTightenThreshold(ast, mutation) {
  return applyRelaxThreshold(ast, {
    ...mutation,
    adjustment: -(mutation.adjustment || 10),
  });
}

function applyMoveAction(ast, mutation, direction) {
  const { list, ability, positions = 1 } = mutation;
  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List ${list} not found`);
  }

  const actionIndex = targetList.entries.findIndex(
    (e) => e.type === "Action" && e.ability === ability,
  );
  if (actionIndex === -1) {
    throw new Error(`Action ${ability} not found in list ${list}`);
  }

  const newIndex = actionIndex + direction * positions;
  if (newIndex < 0 || newIndex >= targetList.entries.length) {
    throw new Error(
      `Cannot move ${ability} ${direction < 0 ? "up" : "down"} — already at boundary`,
    );
  }

  const [removed] = targetList.entries.splice(actionIndex, 1);
  targetList.entries.splice(newIndex, 0, removed);

  return {
    ast,
    description: `Moved ${ability} ${direction < 0 ? "up" : "down"} ${positions} position(s) in ${list}`,
    affectedLines: 1,
  };
}

function findActionInList(ast, listName, abilityName) {
  const targetList = getActionLists(ast).find((l) => l.name === listName);
  if (!targetList) return [];

  return targetList.entries
    .map((entry, i) => ({ list: listName, index: i, action: entry }))
    .filter(
      (r) => r.action.type === "Action" && r.action.ability === abilityName,
    );
}

// --- Sophisticated Mutation Handlers ---

// ADD_VARIABLE: Create a new APL variable with computed expression
// Mutation: { type: "add_variable", list, name, value, op?, condition?, position? }
function applyAddVariable(ast, mutation) {
  const {
    list,
    name,
    value,
    op = "set",
    condition,
    position = "top",
  } = mutation;
  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List "${list}" not found in APL`);
  }

  // Check if variable already exists
  const existing = targetList.entries.find(
    (e) => e.type === "Variable" && e.modifiers?.get("name") === name,
  );
  if (existing && position !== "append") {
    throw new Error(`Variable "${name}" already exists in list "${list}"`);
  }

  const variable = createVariable(name, op, value, condition);

  // Find insertion point
  let insertIndex;
  if (position === "top") {
    // Insert after any leading variables but before actions
    insertIndex = 0;
    for (let i = 0; i < targetList.entries.length; i++) {
      if (targetList.entries[i].type === "Variable") {
        insertIndex = i + 1;
      } else if (targetList.entries[i].type !== "Comment") {
        break;
      }
    }
  } else if (position === "append") {
    // Add at the end of variables section
    insertIndex = targetList.entries.length;
    for (let i = 0; i < targetList.entries.length; i++) {
      if (
        targetList.entries[i].type !== "Variable" &&
        targetList.entries[i].type !== "Comment"
      ) {
        insertIndex = i;
        break;
      }
    }
  } else if (typeof position === "number") {
    insertIndex = position;
  } else {
    insertIndex = 0;
  }

  targetList.entries.splice(insertIndex, 0, variable);

  return {
    ast,
    description: `Added variable "${name}" with value "${value}" to ${list}`,
    affectedLines: 1,
  };
}

// ADD_ACTION_LIST: Create a new action sub-list with entries
// Mutation: { type: "add_action_list", name, entries: [{ability, condition?, ...}] }
function applyAddActionList(ast, mutation) {
  const { name, entries = [] } = mutation;

  // Check if list already exists
  if (getActionLists(ast).find((l) => l.name === name)) {
    throw new Error(`Action list "${name}" already exists`);
  }

  // Create new list with entries
  const newList = { type: "ActionList", name, entries: [] };

  for (const entry of entries) {
    if (entry.type === "variable") {
      newList.entries.push(
        createVariable(entry.name, entry.op, entry.value, entry.condition),
      );
    } else if (entry.type === "comment") {
      newList.entries.push({ type: "Comment", text: entry.text || "" });
    } else {
      const modifiers = { ...entry };
      delete modifiers.ability;
      delete modifiers.type;
      newList.entries.push(createAction(entry.ability, modifiers));
    }
  }

  // Insert after the last ActionList section
  let insertIndex = ast.length;
  for (let i = ast.length - 1; i >= 0; i--) {
    if (ast[i].type === "ActionList") {
      insertIndex = i + 1;
      break;
    }
  }
  ast.splice(insertIndex, 0, newList);

  return {
    ast,
    description: `Created action list "${name}" with ${entries.length} entries`,
    affectedLines: entries.length + 1,
  };
}

// INSERT_ACTION: Insert an action at a specific position in a list
// Mutation: { type: "insert_action", list, ability, condition?, position, before?, after? }
function applyInsertAction(ast, mutation) {
  const { list, ability, position, before, after, ...modifiers } = mutation;
  delete modifiers.type;

  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List "${list}" not found in APL`);
  }

  const action = createAction(ability, modifiers);

  let insertIndex;
  if (typeof position === "number") {
    insertIndex = position;
  } else if (before) {
    // Insert before a specific ability
    const idx = targetList.entries.findIndex(
      (e) => e.type === "Action" && e.ability === before,
    );
    if (idx === -1) {
      throw new Error(`Ability "${before}" not found in list "${list}"`);
    }
    insertIndex = idx;
  } else if (after) {
    // Insert after a specific ability
    const idx = targetList.entries.findIndex(
      (e) => e.type === "Action" && e.ability === after,
    );
    if (idx === -1) {
      throw new Error(`Ability "${after}" not found in list "${list}"`);
    }
    insertIndex = idx + 1;
  } else if (position === "top") {
    // After variables, before first action
    insertIndex = 0;
    for (let i = 0; i < targetList.entries.length; i++) {
      if (
        targetList.entries[i].type !== "Variable" &&
        targetList.entries[i].type !== "Comment"
      ) {
        insertIndex = i;
        break;
      }
    }
  } else {
    // Default: end of list
    insertIndex = targetList.entries.length;
  }

  targetList.entries.splice(insertIndex, 0, action);

  return {
    ast,
    description: `Inserted ${ability} at position ${insertIndex} in ${list}`,
    affectedLines: 1,
  };
}

// ADD_PHASE: Create a phase-specific sub-list and add call_action_list to parent
// Mutation: { type: "add_phase", parentList, phaseName, condition, entries: [...] }
function applyAddPhase(ast, mutation) {
  const {
    parentList,
    phaseName,
    condition,
    entries = [],
    insertPosition,
  } = mutation;

  const parentListNode = getActionLists(ast).find((l) => l.name === parentList);
  if (!parentListNode) {
    throw new Error(`Parent list "${parentList}" not found`);
  }

  // Create the sub-list
  const subListName = `${parentList}_${phaseName}`;
  if (getActionLists(ast).find((l) => l.name === subListName)) {
    throw new Error(`Phase list "${subListName}" already exists`);
  }

  const newList = { type: "ActionList", name: subListName, entries: [] };
  for (const entry of entries) {
    if (entry.type === "variable") {
      newList.entries.push(
        createVariable(entry.name, entry.op, entry.value, entry.condition),
      );
    } else if (entry.type === "comment") {
      newList.entries.push({ type: "Comment", text: entry.text || "" });
    } else {
      const modifiers = { ...entry };
      delete modifiers.ability;
      delete modifiers.type;
      newList.entries.push(createAction(entry.ability, modifiers));
    }
  }

  // Insert sub-list after parent list
  const parentIdx = ast.findIndex(
    (s) => s.type === "ActionList" && s.name === parentList,
  );
  ast.splice(parentIdx + 1, 0, newList);

  // Add call_action_list to parent list
  const callEntry = {
    type: "RunActionList",
    variant: "call",
    modifiers: new Map([
      ["name", subListName],
      ["if", condition],
    ]),
  };

  // Find insert position for call
  let callInsertIdx;
  if (insertPosition === "top") {
    callInsertIdx = 0;
    for (let i = 0; i < parentListNode.entries.length; i++) {
      if (
        parentListNode.entries[i].type !== "Variable" &&
        parentListNode.entries[i].type !== "Comment"
      ) {
        callInsertIdx = i;
        break;
      }
    }
  } else if (typeof insertPosition === "number") {
    callInsertIdx = insertPosition;
  } else {
    // Default: insert at the top after variables
    callInsertIdx = 0;
    for (let i = 0; i < parentListNode.entries.length; i++) {
      if (
        parentListNode.entries[i].type !== "Variable" &&
        parentListNode.entries[i].type !== "Comment"
      ) {
        callInsertIdx = i;
        break;
      }
    }
  }

  parentListNode.entries.splice(callInsertIdx, 0, callEntry);

  return {
    ast,
    description: `Created phase "${phaseName}" sub-list called from ${parentList} when ${condition}`,
    affectedLines: entries.length + 2,
  };
}

// REPLACE_ACTION: Replace an entire action line
// Mutation: { type: "replace_action", list, ability, newAbility?, newCondition?, newModifiers? }
function applyReplaceAction(ast, mutation) {
  const {
    list,
    ability,
    newAbility,
    newCondition,
    newModifiers = {},
  } = mutation;
  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List "${list}" not found in APL`);
  }

  const actions = findActionInList(ast, list, ability);
  if (actions.length === 0) {
    throw new Error(`Action "${ability}" not found in list "${list}"`);
  }

  for (const { action, index } of actions) {
    if (newAbility) {
      action.ability = newAbility;
    }
    if (newCondition !== undefined) {
      if (newCondition) {
        action.modifiers.set("if", newCondition);
      } else {
        action.modifiers.delete("if");
      }
    }
    for (const [key, value] of Object.entries(newModifiers)) {
      if (value === null) {
        action.modifiers.delete(key);
      } else {
        action.modifiers.set(key, value);
      }
    }
  }

  return {
    ast,
    description: `Replaced ${ability} in ${list}${newAbility ? ` with ${newAbility}` : ""}`,
    affectedLines: actions.length,
  };
}

// DELETE_ACTION: Remove an action from a list
// Mutation: { type: "delete_action", list, ability, condition? }
function applyDeleteAction(ast, mutation) {
  const { list, ability, condition } = mutation;
  const targetList = getActionLists(ast).find((l) => l.name === list);
  if (!targetList) {
    throw new Error(`List "${list}" not found in APL`);
  }

  let removed = 0;
  for (let i = targetList.entries.length - 1; i >= 0; i--) {
    const entry = targetList.entries[i];
    if (entry.type !== "Action" || entry.ability !== ability) continue;

    // If condition specified, only match entries with that exact condition
    if (condition !== undefined) {
      const entryCondition = entry.modifiers?.get("if");
      if (entryCondition !== condition) continue;
    }

    targetList.entries.splice(i, 1);
    removed++;
  }

  if (removed === 0) {
    throw new Error(`Action "${ability}" not found in list "${list}"`);
  }

  return {
    ast,
    description: `Removed ${removed} ${ability} action(s) from ${list}`,
    affectedLines: removed,
  };
}

function mapReplacer(key, value) {
  if (value instanceof Map) {
    return { __type: "Map", entries: Array.from(value.entries()) };
  }
  return value;
}

function mapReviver(key, value) {
  if (value?.__type === "Map") {
    return new Map(value.entries);
  }
  return value;
}

export function generateCandidate(baselinePath, mutation, outputPath = null) {
  const ast = parse(readFileSync(baselinePath, "utf-8"));
  const result = applyMutation(ast, mutation);
  const candidateText = serialize(result.ast);

  try {
    parse(candidateText);
  } catch (e) {
    throw new Error(`Generated APL is invalid: ${e.message}`);
  }

  const finalPath = outputPath || join(dirname(baselinePath), "candidate.simc");
  writeFileSync(finalPath, candidateText);

  return {
    outputPath: finalPath,
    description: result.description,
    affectedLines: result.affectedLines,
  };
}

const MUTATION_DESCRIPTIONS = {
  [MUTATION_OPS.ADD_CONDITION]: (m) =>
    `Add "${m.condition}" to ${m.ability} in ${m.list}`,
  [MUTATION_OPS.REMOVE_CONDITION]: (m) =>
    `Remove ${m.targetBuff} condition from ${m.ability} in ${m.list}`,
  [MUTATION_OPS.RELAX_THRESHOLD]: (m) =>
    `Relax ${m.resource} threshold in ${m.ability} by ${m.adjustment || 10}`,
  [MUTATION_OPS.TIGHTEN_THRESHOLD]: (m) =>
    `Tighten ${m.resource} threshold in ${m.ability} by ${m.adjustment || 10}`,
  [MUTATION_OPS.MOVE_UP]: (m) => `Move ${m.ability} up in ${m.list}`,
  [MUTATION_OPS.MOVE_DOWN]: (m) => `Move ${m.ability} down in ${m.list}`,
  // Sophisticated mutation descriptions
  [MUTATION_OPS.ADD_VARIABLE]: (m) =>
    `Add variable "${m.name}" = ${m.value} to ${m.list}`,
  [MUTATION_OPS.ADD_ACTION_LIST]: (m) =>
    `Create action list "${m.name}" with ${m.entries?.length || 0} entries`,
  [MUTATION_OPS.INSERT_ACTION]: (m) =>
    `Insert ${m.ability} in ${m.list}${m.before ? ` before ${m.before}` : ""}${m.after ? ` after ${m.after}` : ""}`,
  [MUTATION_OPS.ADD_PHASE]: (m) =>
    `Create phase "${m.phaseName}" for ${m.parentList} when ${m.condition}`,
  [MUTATION_OPS.REPLACE_ACTION]: (m) =>
    `Replace ${m.ability}${m.newAbility ? ` with ${m.newAbility}` : ""} in ${m.list}`,
  [MUTATION_OPS.DELETE_ACTION]: (m) => `Delete ${m.ability} from ${m.list}`,
};

export function describeMutation(mutation) {
  const fn = MUTATION_DESCRIPTIONS[mutation.type];
  return fn ? fn(mutation) : `Unknown mutation: ${mutation.type}`;
}

export function validateMutation(ast, mutation) {
  const errors = [];

  // For mutations that create new lists, don't require the list to exist
  const createsNewList = [
    MUTATION_OPS.ADD_ACTION_LIST,
    MUTATION_OPS.ADD_PHASE,
  ].includes(mutation.type);

  // For ADD_PHASE, check parentList instead of list
  const listToCheck =
    mutation.type === MUTATION_OPS.ADD_PHASE
      ? mutation.parentList
      : mutation.list;

  if (listToCheck && !createsNewList) {
    const targetList = getActionLists(ast).find((l) => l.name === listToCheck);
    if (!targetList) {
      errors.push(`List "${listToCheck}" not found in APL`);
      return { valid: false, errors };
    }

    // Only check for ability existence on mutations that modify existing abilities
    const requiresExistingAbility = [
      MUTATION_OPS.ADD_CONDITION,
      MUTATION_OPS.REMOVE_CONDITION,
      MUTATION_OPS.RELAX_THRESHOLD,
      MUTATION_OPS.TIGHTEN_THRESHOLD,
      MUTATION_OPS.MOVE_UP,
      MUTATION_OPS.MOVE_DOWN,
      MUTATION_OPS.REPLACE_ACTION,
      MUTATION_OPS.DELETE_ACTION,
    ].includes(mutation.type);

    if (
      requiresExistingAbility &&
      mutation.ability &&
      findActionInList(ast, listToCheck, mutation.ability).length === 0
    ) {
      errors.push(
        `Ability "${mutation.ability}" not found in list "${listToCheck}"`,
      );
    }
  }

  // Type-specific validation
  if (mutation.type === MUTATION_OPS.ADD_CONDITION && !mutation.condition) {
    errors.push("ADD_CONDITION requires a condition");
  }

  if (mutation.type === MUTATION_OPS.REMOVE_CONDITION && !mutation.targetBuff) {
    errors.push("REMOVE_CONDITION requires a targetBuff");
  }

  if (mutation.type === MUTATION_OPS.ADD_VARIABLE) {
    if (!mutation.name) errors.push("ADD_VARIABLE requires a name");
    if (!mutation.value) errors.push("ADD_VARIABLE requires a value");
  }

  if (mutation.type === MUTATION_OPS.ADD_ACTION_LIST) {
    if (!mutation.name) errors.push("ADD_ACTION_LIST requires a name");
    const existing = getActionLists(ast).find((l) => l.name === mutation.name);
    if (existing) errors.push(`Action list "${mutation.name}" already exists`);
  }

  if (mutation.type === MUTATION_OPS.INSERT_ACTION) {
    if (!mutation.ability) errors.push("INSERT_ACTION requires an ability");
  }

  if (mutation.type === MUTATION_OPS.ADD_PHASE) {
    if (!mutation.parentList) errors.push("ADD_PHASE requires a parentList");
    if (!mutation.phaseName) errors.push("ADD_PHASE requires a phaseName");
    if (!mutation.condition) errors.push("ADD_PHASE requires a condition");
    const parentList = getActionLists(ast).find(
      (l) => l.name === mutation.parentList,
    );
    if (!parentList) {
      errors.push(`Parent list "${mutation.parentList}" not found`);
    }
  }

  return { valid: errors.length === 0, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const aplPath = process.argv[2];
  const mutationJson = process.argv[3];

  if (!aplPath || !mutationJson) {
    console.log(
      "Usage: node src/apl/mutator.js <apl-file.simc> <mutation.json>",
    );
    console.log("");
    console.log("Mutation JSON format:");
    console.log(
      JSON.stringify(
        {
          type: "remove_condition",
          list: "ar",
          ability: "reavers_glaive",
          targetBuff: "glaive_flurry",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  let mutation;
  try {
    mutation = JSON.parse(mutationJson);
  } catch {
    mutation = JSON.parse(readFileSync(mutationJson, "utf-8"));
  }

  console.log("Applying mutation:", describeMutation(mutation));
  console.log("");

  try {
    const result = generateCandidate(aplPath, mutation);
    console.log("Generated:", result.outputPath);
    console.log("Description:", result.description);
    console.log("Lines affected:", result.affectedLines);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}
