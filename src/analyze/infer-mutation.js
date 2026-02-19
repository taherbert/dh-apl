// Mutation inference — generates aplMutation for hypotheses that lack them.
// Uses the APL parser to locate target actions and the mutator vocabulary
// to build structured mutations that `iterate.js generate` can apply.

import { parse, getActionLists, findAction } from "../apl/parser.js";
import { validateMutation, MUTATION_OPS } from "../apl/mutator.js";

function toSimcName(name) {
  return name.toLowerCase().replace(/\s+/g, "_");
}

// Infer an aplMutation from hypothesis signals + current APL text.
// Returns a mutation object or null if inference isn't possible.
export function inferMutation(hypothesis, aplText) {
  return inferMutationWithReason(hypothesis, aplText).mutation;
}

// Like inferMutation but returns { mutation, reason } for diagnostics.
// `reason` explains why inference failed when mutation is null.
export function inferMutationWithReason(hypothesis, aplText) {
  const ast = parse(aplText);
  let meta = hypothesis.metadata || {};
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = {};
    }
  }
  const summary = (
    hypothesis.summary ||
    hypothesis.hypothesis ||
    hypothesis.title ||
    ""
  ).toLowerCase();

  // Track strategies where pattern matched but inference failed
  const failedStrategies = [];

  // Each strategy: match a pattern, try to infer a mutation, track failures
  const strategies = [
    // 1: Divergence-style "X preferred over Y" → MOVE_UP
    () => {
      const opt = meta.optAbility || meta.optimalAbility;
      const act = meta.actAbility || meta.actualAbility;
      if (!opt || !act) return null;
      return (
        inferMoveUp(ast, opt, act) ||
        (failedStrategies.push(`divergence: ${opt} over ${act}`), null)
      );
    },
    // 2: Text-based "X should be used instead of Y"
    () => {
      const m = summary.match(
        /(\w[\w_]*)\s+(?:preferred over|instead of|over|replaces?)\s+(\w[\w_]*)/,
      );
      if (!m) return null;
      return (
        inferMoveUp(ast, m[1], m[2]) ||
        (failedStrategies.push(`text_swap: ${m[1]} over ${m[2]}`), null)
      );
    },
    // 3: "X should be used during buff window W" → ADD_CONDITION
    () => {
      const m = summary.match(
        /(\w[\w_]*)\s+(?:during|within|in)\s+(\w[\w_]*)\s+(?:window|buff|phase)/,
      );
      if (!m) return null;
      return (
        inferAddBuffCondition(ast, m[1], m[2]) ||
        (failedStrategies.push(`buff_gate: ${m[1]} during ${m[2]}`), null)
      );
    },
    // 4: "Resource overflow" → RELAX_THRESHOLD
    () => {
      const m = summary.match(
        /(?:overflow|waste|cap)\s+(?:for |of |on )?(\w+)/,
      );
      if (!m) return null;
      return (
        inferRelaxThreshold(ast, m[1]) ||
        (failedStrategies.push(`overflow: ${m[1]}`), null)
      );
    },
    // 5: "CD alignment: X should sync with Y" → ADD_CONDITION
    () => {
      const m = summary.match(
        /(?:align|sync)\s+(\w[\w_]*)\s+(?:with|during)\s+(\w[\w_]*)/,
      );
      if (!m) return null;
      return (
        inferCdSync(ast, m[1], m[2]) ||
        (failedStrategies.push(`cd_sync: ${m[1]} with ${m[2]}`), null)
      );
    },
    // 6: "Prioritize X" / "X should be higher priority" → MOVE_UP
    () => {
      const m = summary.match(
        /(?:prioritize|raise priority of|move up)\s+(\w[\w_]*)/,
      );
      if (!m) return null;
      return (
        inferMoveUpGeneric(ast, m[1]) ||
        (failedStrategies.push(`prioritize: ${m[1]}`), null)
      );
    },
    // 7: "In actions.X: adjust A condition or add B priority" → B over A in list X
    () => {
      const m = summary.match(
        /in actions\.(\w+):\s*adjust\s+(\w[\w_]*)\s+condition.*?add\s+(\w[\w_]*)\s+priority/,
      );
      if (!m) return null;
      return (
        inferMoveUp(ast, m[3], m[2]) ||
        (failedStrategies.push(`list_swap: ${m[3]} over ${m[2]} in ${m[1]}`),
        null)
      );
    },
    // 8: "Adjust A priority or conditions in {phase} to allow B" → B over A
    () => {
      const m = summary.match(
        /adjust\s+(\w[\w_]*)\s+priority.*?(?:to allow|for)\s+(\w[\w_]*)/,
      );
      if (!m) return null;
      return (
        inferMoveUp(ast, m[2], m[1]) ||
        (failedStrategies.push(`adjust_priority: ${m[2]} over ${m[1]}`), null)
      );
    },
    // 9: "Hold A for B window" → sync A with B's cooldown
    () => {
      const m = summary.match(/hold\s+(\w[\w_]*)\s+for\s+(\w[\w_]*)\s+window/);
      if (!m) return null;
      return (
        inferCdSync(ast, m[1], m[2]) ||
        (failedStrategies.push(`hold_for: ${m[1]} for ${m[2]}`), null)
      );
    },
    // 10: "Lower X threshold" / "reduce X threshold" → RELAX_THRESHOLD
    () => {
      const m = summary.match(
        /(?:lower|reduce|relax)\s+(\w[\w_]*)\s+(?:spending\s+)?threshold/,
      );
      if (!m) return null;
      return (
        inferRelaxThreshold(ast, m[1]) ||
        (failedStrategies.push(`relax_threshold: ${m[1]}`), null)
      );
    },
    // 11: Hero-tree gated insert
    () => {
      const m = summary.match(
        /(\w[\w_]*)\s+(?:underused|missing|absent)\s+(?:in|for)\s+(?:hero tree\s+)?(\w[\w_]*)/,
      );
      if (!m) return null;
      return (
        inferHeroGateInsert(ast, m[1], m[2]) ||
        (failedStrategies.push(`hero_gate: ${m[1]} for ${m[2]}`), null)
      );
    },
  ];

  for (const strategy of strategies) {
    const mutation = strategy();
    if (mutation) return { mutation, reason: null };
  }

  const reason =
    failedStrategies.length > 0
      ? `pattern matched but validation failed: ${failedStrategies.join(", ")}`
      : "no text pattern matched";
  return { mutation: null, reason };
}

// MOVE_UP: place optAbility above actAbility in the same list
function inferMoveUp(ast, optAbility, actAbility) {
  const optNorm = toSimcName(optAbility);
  const actNorm = toSimcName(actAbility);

  const optHits = findAction(ast, optNorm);
  const actHits = findAction(ast, actNorm);

  if (optHits.length === 0 || actHits.length === 0) return null;

  // Find a pair in the same list where opt is below act
  for (const optHit of optHits) {
    for (const actHit of actHits) {
      if (optHit.list === actHit.list && optHit.index > actHit.index) {
        const positions = optHit.index - actHit.index;
        const mutation = {
          type: MUTATION_OPS.MOVE_UP,
          list: optHit.list,
          ability: optNorm,
          positions,
        };
        const v = validateMutation(ast, mutation);
        if (v.valid) return mutation;
      }
    }
  }

  // If opt doesn't exist in act's list, try INSERT_ACTION before act
  const actHit = actHits[0];
  const optHit = optHits[0];
  if (optHit.list !== actHit.list) {
    const condition = optHit.action.modifiers?.get("if") || "";
    const mutation = {
      type: MUTATION_OPS.INSERT_ACTION,
      list: actHit.list,
      ability: optNorm,
      before: actNorm,
      ...(condition ? { if: condition } : {}),
    };
    const v = validateMutation(ast, mutation);
    if (v.valid) return mutation;
  }

  return null;
}

// MOVE_UP generic: move ability up 1 position in its first-found list
function inferMoveUpGeneric(ast, ability) {
  const norm = toSimcName(ability);
  const hits = findAction(ast, norm);
  if (hits.length === 0) return null;

  const hit = hits[0];
  if (hit.index === 0) return null;

  const mutation = {
    type: MUTATION_OPS.MOVE_UP,
    list: hit.list,
    ability: norm,
    positions: 1,
  };
  const v = validateMutation(ast, mutation);
  return v.valid ? mutation : null;
}

// ADD_CONDITION: gate ability on a buff being active
function inferAddBuffCondition(ast, ability, buff) {
  const abilNorm = toSimcName(ability);
  const buffNorm = toSimcName(buff);

  const hits = findAction(ast, abilNorm);
  if (hits.length === 0) return null;

  const hit = hits[0];
  const existingIf = hit.action.modifiers?.get("if") || "";

  // Don't add if the buff check already exists
  if (existingIf.includes(`buff.${buffNorm}`)) return null;

  const mutation = {
    type: MUTATION_OPS.ADD_CONDITION,
    list: hit.list,
    ability: abilNorm,
    condition: `buff.${buffNorm}.up`,
  };
  const v = validateMutation(ast, mutation);
  return v.valid ? mutation : null;
}

// RELAX_THRESHOLD: reduce resource gate on the first consumer found
function inferRelaxThreshold(ast, resource) {
  const resNorm = resource.toLowerCase();
  const lists = getActionLists(ast);

  for (const list of lists) {
    for (const entry of list.entries) {
      if (entry.type !== "Action") continue;
      const cond = entry.modifiers?.get("if") || "";
      const gateMatch = cond.match(new RegExp(`${resNorm}\\s*>=\\s*(\\d+)`));
      if (gateMatch) {
        const mutation = {
          type: MUTATION_OPS.RELAX_THRESHOLD,
          list: list.name,
          ability: entry.ability,
          resource: resNorm,
          adjustment: -5,
        };
        const v = validateMutation(ast, mutation);
        if (v.valid) return mutation;
      }
    }
  }
  return null;
}

// ADD_CONDITION: sync ability with cooldown
function inferCdSync(ast, ability, syncTarget) {
  const abilNorm = toSimcName(ability);
  const syncNorm = toSimcName(syncTarget);

  const hits = findAction(ast, abilNorm);
  if (hits.length === 0) return null;

  const hit = hits[0];
  const existingIf = hit.action.modifiers?.get("if") || "";

  if (existingIf.includes(`cooldown.${syncNorm}`)) return null;

  const mutation = {
    type: MUTATION_OPS.ADD_CONDITION,
    list: hit.list,
    ability: abilNorm,
    condition: `cooldown.${syncNorm}.remains<3`,
  };
  const v = validateMutation(ast, mutation);
  return v.valid ? mutation : null;
}

// INSERT_ACTION: add ability gated on hero tree
function inferHeroGateInsert(ast, ability, heroTree) {
  const abilNorm = toSimcName(ability);
  const treeNorm = toSimcName(heroTree);

  // Check if ability already exists
  const hits = findAction(ast, abilNorm);
  if (hits.length > 0) return null;

  // Find the most appropriate list (hero-specific or default)
  const lists = getActionLists(ast);
  const heroList = lists.find(
    (l) => l.name.includes(treeNorm) || l.name.includes(treeNorm.slice(0, 4)),
  );
  const targetList = heroList || lists.find((l) => l.name === "default");
  if (!targetList) return null;

  const mutation = {
    type: MUTATION_OPS.INSERT_ACTION,
    list: targetList.name,
    ability: abilNorm,
    if: `hero_tree.${treeNorm}`,
    position: "top",
  };
  const v = validateMutation(ast, mutation);
  return v.valid ? mutation : null;
}
