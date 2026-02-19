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
  const ast = parse(aplText);
  const meta = hypothesis.metadata || {};
  const summary = (
    hypothesis.summary ||
    hypothesis.hypothesis ||
    hypothesis.title ||
    ""
  ).toLowerCase();

  // Strategy 1: Divergence-style "X preferred over Y" → MOVE_UP
  const optAbility = meta.optAbility || meta.optimalAbility;
  const actAbility = meta.actAbility || meta.actualAbility;
  if (optAbility && actAbility) {
    const mutation = inferMoveUp(ast, optAbility, actAbility);
    if (mutation) return mutation;
  }

  // Strategy 2: Text-based "X should be used instead of Y"
  const swapMatch = summary.match(
    /(\w[\w_]*)\s+(?:preferred over|instead of|over|replaces?)\s+(\w[\w_]*)/,
  );
  if (swapMatch) {
    const mutation = inferMoveUp(ast, swapMatch[1], swapMatch[2]);
    if (mutation) return mutation;
  }

  // Strategy 3: "X should be used during buff window W" → ADD_CONDITION
  const buffMatch = summary.match(
    /(\w[\w_]*)\s+(?:during|within|in)\s+(\w[\w_]*)\s+(?:window|buff|phase)/,
  );
  if (buffMatch) {
    const mutation = inferAddBuffCondition(ast, buffMatch[1], buffMatch[2]);
    if (mutation) return mutation;
  }

  // Strategy 4: "Resource overflow" → RELAX_THRESHOLD
  const overflowMatch = summary.match(
    /(?:overflow|waste|cap)\s+(?:for |of |on )?(\w+)/,
  );
  if (overflowMatch) {
    const mutation = inferRelaxThreshold(ast, overflowMatch[1]);
    if (mutation) return mutation;
  }

  // Strategy 5: "CD alignment: X should sync with Y" → ADD_CONDITION
  const syncMatch = summary.match(
    /(?:align|sync)\s+(\w[\w_]*)\s+(?:with|during)\s+(\w[\w_]*)/,
  );
  if (syncMatch) {
    const mutation = inferCdSync(ast, syncMatch[1], syncMatch[2]);
    if (mutation) return mutation;
  }

  // Strategy 6: "Prioritize X" / "X should be higher priority" → MOVE_UP
  const prioMatch = summary.match(
    /(?:prioritize|raise priority of|move up)\s+(\w[\w_]*)/,
  );
  if (prioMatch) {
    const mutation = inferMoveUpGeneric(ast, prioMatch[1]);
    if (mutation) return mutation;
  }

  // Strategy 7: Hero-tree gated insert
  const heroGateMatch = summary.match(
    /(\w[\w_]*)\s+(?:underused|missing|absent)\s+(?:in|for)\s+(?:hero tree\s+)?(\w[\w_]*)/,
  );
  if (heroGateMatch) {
    const mutation = inferHeroGateInsert(
      ast,
      heroGateMatch[1],
      heroGateMatch[2],
    );
    if (mutation) return mutation;
  }

  return null;
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
