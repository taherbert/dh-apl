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
} from "./parser.js";
import {
  parseCondition,
  serializeCondition,
  addClause,
  removeClause,
  extractSemantics,
} from "./condition-parser.js";
import { MUTATION_OPS } from "../analyze/strategic-hypotheses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const MUTATION_HANDLERS = {
  [MUTATION_OPS.ADD_CONDITION]: applyAddCondition,
  [MUTATION_OPS.REMOVE_CONDITION]: applyRemoveCondition,
  [MUTATION_OPS.RELAX_THRESHOLD]: applyRelaxThreshold,
  [MUTATION_OPS.TIGHTEN_THRESHOLD]: applyTightenThreshold,
  [MUTATION_OPS.MOVE_UP]: (ast, m) => applyMoveAction(ast, m, -1),
  [MUTATION_OPS.MOVE_DOWN]: (ast, m) => applyMoveAction(ast, m, 1),
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
};

export function describeMutation(mutation) {
  const fn = MUTATION_DESCRIPTIONS[mutation.type];
  return fn ? fn(mutation) : `Unknown mutation: ${mutation.type}`;
}

export function validateMutation(ast, mutation) {
  const errors = [];
  const targetList = getActionLists(ast).find((l) => l.name === mutation.list);

  if (!targetList) {
    errors.push(`List "${mutation.list}" not found in APL`);
    return { valid: false, errors };
  }

  if (
    mutation.ability &&
    findActionInList(ast, mutation.list, mutation.ability).length === 0
  ) {
    errors.push(
      `Ability "${mutation.ability}" not found in list "${mutation.list}"`,
    );
  }

  if (mutation.type === MUTATION_OPS.ADD_CONDITION && !mutation.condition) {
    errors.push("ADD_CONDITION requires a condition");
  }

  if (mutation.type === MUTATION_OPS.REMOVE_CONDITION && !mutation.targetBuff) {
    errors.push("REMOVE_CONDITION requires a targetBuff");
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
