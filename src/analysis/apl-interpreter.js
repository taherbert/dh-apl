// APL Decision Simulator — replays {spec}.simc decisions against the state simulator.
//
// Given the same initial state as optimal-timeline.js, evaluates what action the
// current APL would choose at each GCD. Produces apl-trace.json in the same format
// as timeline.json for direct comparison by divergence.js.
//
// The state engine and build archetypes are loaded from the spec module at runtime
// (--spec flag); this file contains no spec-specific hardcoding.
//
// Usage:
//   node src/analysis/apl-interpreter.js --spec vengeance --build anni-apex3-dgb --duration 120
//   npm run apl-trace -- --build anni-apex3-dgb --duration 120

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse, getActionLists } from "../apl/parser.js";
import { parseCondition } from "../apl/condition-parser.js";
import { initSpec, getSpecAdapter } from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { ROOT } from "../engine/paths.js";

// State engine — loaded dynamically from src/analysis/{spec}/state-sim.js
let engine;

export async function initEngine(specName) {
  if (engine) return engine;
  engine = await import(`./${specName}/state-sim.js`);
  return engine;
}

// ---------------------------------------------------------------------------
// SimC expression evaluator
// Resolves SimC dotted expressions (fury, buff.X.remains, etc.) against state
// ---------------------------------------------------------------------------

function evalSimcExpr(expr, state, vars, cfg) {
  if (!expr) return 0;
  const parts = expr.split(".");

  // Numeric literal
  const num = Number(expr);
  if (!isNaN(num) && expr !== "") return num;

  // Generic numeric state property (fury, soul_fragments, etc.)
  if (parts[0] in state && typeof state[parts[0]] === "number") {
    return state[parts[0]];
  }

  switch (parts[0]) {
    case "health":
      return 100; // Always full in simulation

    case "active_enemies":
    case "spell_targets":
      return state.target_count;

    case "gcd":
      return state.gcd;

    case "buff": {
      const buffName = parts[1];
      const prop = parts[2] || "up";
      // Handle voidfall_building and voidfall_spending via buffStacks
      if (
        buffName === "voidfall_building" ||
        buffName === "voidfall_spending"
      ) {
        const stacks = state.buffStacks[buffName] || 0;
        if (prop === "down") return stacks === 0 ? 1 : 0;
        if (prop === "stack") return stacks;
        if (prop === "remains") return stacks > 0 ? 9999 : 0; // VF stacks aren't time-based
        return stacks > 0 ? 1 : 0;
      }
      const remains = state.buffs[buffName] || 0;
      switch (prop) {
        case "up":
        case "react":
          return remains > 0 ? 1 : 0;
        case "down":
          return remains <= 0 ? 1 : 0;
        case "remains":
          return remains;
        case "stack":
          return state.buffStacks[buffName] || 0;
        default:
          return remains;
      }
    }

    case "debuff": {
      const buffName = parts[1];
      const prop = parts[2] || "up";
      const remains = state.debuffs[buffName] || 0;
      if (prop === "remains") return remains;
      return remains > 0 ? 1 : 0;
    }

    case "dot": {
      const dotName = parts[1];
      const prop = parts[2] || "ticking";
      const remains = state.dots[dotName] || 0;
      if (prop === "remains") return remains;
      return remains > 0 ? 1 : 0;
    }

    case "cooldown": {
      const spellName = parts[1];
      const prop = parts[2] || "remains";

      const chargeAbilities =
        getSpecAdapter().getSpecConfig().chargeAbilities || {};
      if (spellName in chargeAbilities) {
        const charges = state.charges?.[spellName] ?? 0;
        const recharge = state.recharge?.[spellName] ?? 0;
        const { maxCharges, rechargeCd } = chargeAbilities[spellName];
        switch (prop) {
          case "ready":
            return charges > 0 ? 1 : 0;
          case "remains":
            return charges > 0 ? 0 : recharge;
          case "charges":
            return charges;
          case "charges_fractional":
            return (
              charges +
              (charges < maxCharges
                ? Math.max(0, 1 - recharge / rechargeCd)
                : 0)
            );
          case "full_recharge_time": {
            if (charges >= maxCharges) return 0;
            const missing = maxCharges - charges;
            return recharge + (missing - 1) * rechargeCd;
          }
          default:
            return charges > 0 ? 0 : recharge;
        }
      }

      // Standard cooldown
      const cd = state.cooldowns[spellName] || 0;
      switch (prop) {
        case "ready":
          return cd <= 0 ? 1 : 0;
        case "remains":
          return cd;
        case "duration":
          return getCdDuration(spellName, cfg);
        default:
          return cd;
      }
    }

    case "talent":
      return cfg.talents?.[parts[1]] ? 1 : 0;

    case "apex":
      return cfg.apexRank >= parseInt(parts[1], 10) ? 1 : 0;

    case "variable":
      return vars[parts[1]] !== undefined ? vars[parts[1]] : 0;

    case "prev_gcd": {
      const pos = parseInt(parts[1], 10);
      const ability = parts[2];
      if (pos === 1) return state.prev_gcd === ability ? 1 : 0;
      if (pos === 2) return state.prev_gcd_2 === ability ? 1 : 0;
      return 0;
    }

    case "hero_tree":
      return cfg.heroTree === parts[1] ? 1 : 0;

    case "trinket":
    case "target":
      // Trinkets and target properties — not modeled, return safe defaults
      return 0;
  }

  return 0;
}

function getCdDuration(spell, cfg) {
  const durations = getSpecAdapter().getSpecConfig().cooldownDurations || {};
  const val = durations[spell];
  if (typeof val === "function") return val(cfg);
  return val ?? 30;
}

// ---------------------------------------------------------------------------
// Condition evaluator — evaluates a parsed condition AST against state
// ---------------------------------------------------------------------------

function evalConditionAst(ast, state, vars, cfg) {
  if (!ast) return true;

  switch (ast.type) {
    case "BinaryOp":
      if (ast.op === "&") {
        return (
          evalConditionAst(ast.left, state, vars, cfg) &&
          evalConditionAst(ast.right, state, vars, cfg)
        );
      }
      return (
        evalConditionAst(ast.left, state, vars, cfg) ||
        evalConditionAst(ast.right, state, vars, cfg)
      );

    case "Not":
      return !evalConditionAst(ast.operand, state, vars, cfg);

    case "Comparison": {
      const leftVal = evalSimcExpr(ast.left, state, vars, cfg);
      const rightVal = evalSimcExpr(ast.right, state, vars, cfg);
      switch (ast.op) {
        case ">=":
          return leftVal >= rightVal;
        case "<=":
          return leftVal <= rightVal;
        case ">":
          return leftVal > rightVal;
        case "<":
          return leftVal < rightVal;
        case "=":
          return leftVal === rightVal;
        case "!=":
          return leftVal !== rightVal;
        default:
          return false;
      }
    }

    case "BuffCheck": {
      const prefix = ast.isDot ? "dots" : ast.isDebuff ? "debuffs" : "buffs";
      const buffName = ast.buff;
      let val;
      if (
        prefix === "buffs" &&
        (buffName === "voidfall_building" || buffName === "voidfall_spending")
      ) {
        val = state.buffStacks[buffName] || 0;
      } else {
        const container = state[prefix] || {};
        val = container[buffName] || 0;
      }
      const result = ast.property === "down" ? val <= 0 : val > 0;
      return ast.negate ? !result : result;
    }

    case "CooldownCheck": {
      const spellName = ast.spell;
      const cd = state.cooldowns[spellName] || 0;
      const charges = state.charges[spellName] || 0;
      switch (ast.property) {
        case "ready": {
          const chargeAbils =
            getSpecAdapter().getSpecConfig().chargeAbilities || {};
          return spellName in chargeAbils ? charges > 0 : cd <= 0;
        }
        default:
          return cd <= 0;
      }
    }

    case "TalentCheck": {
      const hasTalent = cfg.talents?.[ast.talent] ? true : false;
      return ast.negate ? !hasTalent : hasTalent;
    }

    case "ResourceCheck": {
      const val = evalSimcExpr(ast.resource, state, vars, cfg);
      return val > 0;
    }

    case "VariableCheck": {
      return (vars[ast.variable] || 0) > 0;
    }

    case "SpellTargets": {
      return state.target_count;
    }

    case "PrevGcd": {
      if (ast.position === 1) return state.prev_gcd === ast.ability;
      if (ast.position === 2) return state.prev_gcd_2 === ast.ability;
      return false;
    }

    case "HeroTreeCheck": {
      return cfg.heroTree === ast.tree;
    }

    case "Literal": {
      const n = parseFloat(ast.value);
      if (!isNaN(n)) return n !== 0;
      // apex.N: condition-parser doesn't recognize this prefix, falls through to Literal.
      // Route through evalSimcExpr which handles it correctly.
      if (ast.value.startsWith("apex.")) {
        return evalSimcExpr(ast.value, state, vars, cfg) > 0;
      }
      return ast.value !== "" && ast.value !== "0";
    }

    default:
      return true;
  }
}

// Evaluate a condition string
// Preprocess condition string: resolve arithmetic sub-expressions (e.g., (2-apex.3))
// into their numeric values before passing to the condition-parser.
// The condition-parser's tokenizer drops '-' and leaves mismatched parens,
// causing incorrect evaluation of arithmetic expressions.
function preprocessCondition(str, state, vars, cfg) {
  // Replace parenthesized arithmetic: (N-expr) → computed value
  // e.g., (2-apex.3) with apex.3=1 → 1
  let result = str.replace(/\((\d+)-([\w.]+)\)/g, (_, n, expr) =>
    String(parseInt(n, 10) - evalSimcExpr(expr, state, vars, cfg)),
  );
  // Replace bare addition in comparison RHS: <=N+expr → <=computed
  // e.g., soul_fragments<=2+talent.soul_sigils → soul_fragments<=3 when soul_sigils=1
  result = result.replace(
    /(<=|>=|<|>|=)(\d+)\+([\w.]+)/g,
    (_, op, n, expr) =>
      `${op}${parseInt(n, 10) + evalSimcExpr(expr, state, vars, cfg)}`,
  );
  // Handle SimC min operator >? (e.g., A>?B>?C<8 → min(A,B,C)<8)
  // >? returns the minimum of its operands, used for "earliest cooldown" patterns
  result = result.replace(
    /([\w.]+(?:>\?[\w.]+)+)(<=|>=|!=|<|>|=)(\d+)/g,
    (_, chain, op, n) => {
      const parts = chain.split(">?");
      const minVal = Math.min(
        ...parts.map((p) => evalSimcExpr(p.trim(), state, vars, cfg)),
      );
      return `${minVal}${op}${n}`;
    },
  );
  return result;
}

function evalCondition(conditionStr, state, vars, cfg) {
  if (!conditionStr) return true;
  try {
    const processed = preprocessCondition(conditionStr, state, vars, cfg);
    const ast = parseCondition(processed);
    return evalConditionAst(ast, state, vars, cfg);
  } catch {
    return false; // Parse failure: don't fire on unknown conditions
  }
}

// ---------------------------------------------------------------------------
// Variable computation — evaluates all APL variables fresh each GCD
// Variables are defined as actions in the "default" action list
// ---------------------------------------------------------------------------

function computeVariables(actionLists, state, cfg) {
  const vars = {};
  const defaultList = actionLists.find((l) => l.name === "default");
  if (!defaultList) return vars;

  for (const entry of defaultList.entries) {
    if (entry.type !== "Variable") continue;
    const name = entry.modifiers.get("name");
    if (!name) continue;

    const valueExpr = entry.modifiers.get("value");
    const condition = entry.modifiers.get("if");

    // Check condition first (some variables are conditional)
    if (condition && !evalCondition(condition, state, vars, cfg)) continue;

    if (!valueExpr) {
      vars[name] = 0;
      continue;
    }

    // Evaluate the value expression against current state
    vars[name] = evalVariableExpr(valueExpr, state, vars, cfg);
  }

  return vars;
}

// Evaluate a variable value expression (may contain arithmetic/comparisons)
function evalVariableExpr(expr, state, vars, cfg) {
  if (!expr) return 0;

  // Handle arithmetic: try to parse as a computed expression
  // Supported patterns: "A-B", "A+B", etc. where A/B are SimC exprs
  const minusIdx = findBinaryOp(expr, "-");
  if (minusIdx > 0) {
    const left = expr.slice(0, minusIdx).trim();
    const right = expr.slice(minusIdx + 1).trim();
    return (
      evalSimcExpr(left, state, vars, cfg) -
      evalSimcExpr(right, state, vars, cfg)
    );
  }

  const plusIdx = findBinaryOp(expr, "+");
  if (plusIdx > 0) {
    const left = expr.slice(0, plusIdx).trim();
    const right = expr.slice(plusIdx + 1).trim();
    return (
      evalSimcExpr(left, state, vars, cfg) +
      evalSimcExpr(right, state, vars, cfg)
    );
  }

  // Boolean/comparison: evaluates to 0 or 1
  // Check if it contains a comparison operator
  if (
    expr.includes(">=") ||
    expr.includes("<=") ||
    expr.includes(">") ||
    expr.includes("<") ||
    expr.includes("=") ||
    expr.includes("&") ||
    expr.includes("|") ||
    expr.includes("!")
  ) {
    try {
      const ast = parseCondition(expr);
      return evalConditionAst(ast, state, vars, cfg) ? 1 : 0;
    } catch {
      return 0;
    }
  }

  // Simple expression
  return evalSimcExpr(expr, state, vars, cfg);
}

// Find the position of a binary operator not inside parentheses
function findBinaryOp(expr, op) {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") depth--;
    else if (depth === 0 && expr[i] === op) {
      // Skip comparisons like >= or <=
      if (op === ">" && expr[i + 1] === "=") continue;
      if (op === "<" && expr[i + 1] === "=") continue;
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// APL evaluator — walks action lists to find the first matching action
// ---------------------------------------------------------------------------

function evalActionList(listName, actionLists, state, vars, cfg, depth = 0) {
  if (depth > 10) return null; // Prevent infinite recursion

  const listMap = new Map(actionLists.map((l) => [l.name, l]));
  const list = listMap.get(listName);
  if (!list) return null;

  for (const entry of list.entries) {
    if (entry.type === "Comment" || !entry.type) continue;

    const condition = entry.modifiers?.get("if");

    if (entry.type === "Variable") continue; // Already computed

    if (entry.type === "RunActionList") {
      const targetList = entry.modifiers.get("name");
      const variant = entry.variant; // "run" or "call"
      if (!condition || evalCondition(condition, state, vars, cfg)) {
        const result = evalActionList(
          targetList,
          actionLists,
          state,
          vars,
          cfg,
          depth + 1,
        );
        if (variant === "run") {
          // run_action_list: swap to target list unconditionally (no fallthrough)
          return result;
        }
        // call_action_list: fall through if sub-list returned nothing
        if (result) return result;
      }
      continue;
    }

    if (entry.type === "Action") {
      const ability = entry.ability;

      // Skip non-game abilities
      if (
        ability === "snapshot_stats" ||
        ability === "use_item" ||
        ability === "potion" ||
        ability === "invoke_external_buff"
      ) {
        continue;
      }

      // Check if ability is castable
      const available = engine.getAvailable(state);
      // For off-GCD abilities, check differently
      const useOffGcd = entry.modifiers.get("use_off_gcd") === "1";

      if (!condition || evalCondition(condition, state, vars, cfg)) {
        // Check availability
        if (ability === "auto_attack" || ability === "disrupt") continue;
        if (ability === "metamorphosis" && !available.includes("metamorphosis"))
          continue;
        if (available.includes(ability)) {
          return {
            ability,
            off_gcd: useOffGcd || engine.OFF_GCD_ABILITIES.has(ability),
            condition: condition || null,
            listName,
          };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main trace generator
// ---------------------------------------------------------------------------

export function simulateApl(aplText, buildConfig, durationSeconds = 120) {
  const {
    createInitialState,
    applyAbility,
    advanceTime,
    OFF_GCD_ABILITIES,
    getAbilityGcd,
  } = engine;

  const sections = parse(aplText);
  const actionLists = getActionLists(sections);

  let state = createInitialState(buildConfig);
  const events = [];
  let gcdNumber = 0;
  let offGcdGuard = 0;

  while (state.t < durationSeconds) {
    // Compute variables fresh for this GCD
    const vars = computeVariables(actionLists, state, buildConfig);

    // Hero-tree-appropriate entry point from spec adapter
    const heroList =
      getSpecAdapter().getHeroTrees()[buildConfig.heroTree]?.aplBranch ||
      "default";

    // First evaluate default list to handle variables and routing
    const decision = evalDefaultList(
      actionLists,
      state,
      vars,
      buildConfig,
      heroList,
    );

    if (!decision) {
      // No action found — advance time
      state = advanceTime(state, state.gcd);
      continue;
    }

    const { ability, off_gcd, condition, apl_reason, listName } = decision;

    if (off_gcd && OFF_GCD_ABILITIES.has(ability) && offGcdGuard < 5) {
      // Off-GCD ability: apply without consuming GCD
      offGcdGuard++;
      const offGcdT = state.t;
      const preState = snapshotState(state);
      state = applyAbility(state, ability);
      gcdNumber++;
      events.push({
        t: parseFloat(offGcdT.toFixed(3)),
        gcd: gcdNumber,
        ability,
        off_gcd: true,
        pre: preState,
        post: snapshotState(state),
        apl_reason: apl_reason || condition || "off-GCD action",
        list_name: listName || null,
      });
      // Re-evaluate same GCD slot (off-GCD doesn't consume GCD)
      continue;
    }
    offGcdGuard = 0;

    // On-GCD ability
    gcdNumber++;
    const preT = state.t;
    const preState = snapshotState(state);
    state = applyAbility(state, ability);

    const dt = getAbilityGcd(preState, ability) || preState.gcd;
    state = advanceTime(state, dt);

    // FelDev channel extra time
    if (ability === "fel_devastation" && state._feldev_channel) {
      const extra = Math.max(0, state._feldev_channel - dt);
      if (extra > 0) state = advanceTime(state, extra);
    }

    events.push({
      t: parseFloat(preT.toFixed(3)),
      gcd: gcdNumber,
      ability,
      off_gcd: false,
      pre: preState,
      post: snapshotState(state),
      apl_reason: apl_reason || condition || "unconditional",
      list_name: listName || null,
    });
  }

  return {
    metadata: {
      build: buildConfig._name || "custom",
      heroTree: buildConfig.heroTree,
      apexRank: buildConfig.apexRank,
      duration: durationSeconds,
      type: "apl-trace",
    },
    events,
  };
}

// Evaluate the default action list with hero tree routing
function evalDefaultList(actionLists, state, vars, cfg, heroList) {
  const listMap = new Map(actionLists.map((l) => [l.name, l]));
  const defaultList = listMap.get("default");
  if (!defaultList) return null;

  for (const entry of defaultList.entries) {
    if (entry.type === "Comment" || entry.type === "Variable") continue;

    const condition = entry.modifiers?.get("if");

    if (entry.type === "RunActionList") {
      const variant = entry.variant;
      const targetList = entry.modifiers.get("name");

      if (variant === "run") {
        if (!condition || evalCondition(condition, state, vars, cfg)) {
          return evalActionList(targetList, actionLists, state, vars, cfg, 0);
        }
      } else {
        // call_action_list
        if (!condition || evalCondition(condition, state, vars, cfg)) {
          const result = evalActionList(
            targetList,
            actionLists,
            state,
            vars,
            cfg,
            0,
          );
          if (result) return result;
        }
      }
      continue;
    }

    if (entry.type === "Action") {
      const ability = entry.ability;
      if (ability === "auto_attack" || ability === "snapshot_stats") continue;

      if (!condition || evalCondition(condition, state, vars, cfg)) {
        const available = engine.getAvailable(state);
        if (available.includes(ability)) {
          return {
            ability,
            off_gcd: entry.modifiers.get("use_off_gcd") === "1",
            condition: condition || null,
          };
        }
      }
    }
  }

  return null;
}

function snapshotState(s) {
  const specConfig = getSpecAdapter().getSpecConfig();
  const snap = { gcd: s.gcd };

  // Resources — generic from spec config
  snap[specConfig.resources.primary.name] =
    s[specConfig.resources.primary.name];
  if (specConfig.resources.secondary) {
    snap[specConfig.resources.secondary.name] =
      s[specConfig.resources.secondary.name];
  }

  // Buffs, dots, cooldowns — filter to active
  for (const dict of ["buffs", "dots", "cooldowns"]) {
    snap[dict] = Object.fromEntries(
      Object.entries(s[dict] || {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => [k, +v.toFixed(1)]),
    );
  }

  // Charges — generic over all tracked abilities
  if (s.charges) {
    snap.charges = { ...s.charges };
    snap.recharge = { ...s.recharge };
  }

  // Spec-specific extra state (e.g. voidfall stacks for VDH)
  if (engine?.snapshotExtra) Object.assign(snap, engine.snapshotExtra(s));
  return snap;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      build: { type: "string", default: "anni-apex3-dgb" },
      duration: { type: "string", default: "120" },
      apl: { type: "string" },
      output: { type: "string" },
    },
    strict: false,
  });

  const spec = values.spec || parseSpecArg();
  await initSpec(spec);
  await initEngine(spec);

  const specMod = await import(`../spec/${spec}.js`);
  const ARCHETYPES = specMod.flattenArchetypes();
  const buildName = values.build;
  const archetype = ARCHETYPES[buildName];

  if (!archetype) {
    console.error(`Unknown build: ${buildName}`);
    console.error(`Available builds: ${Object.keys(ARCHETYPES).join(", ")}`);
    process.exit(1);
  }

  archetype._name = buildName;

  const aplPath = values.apl || join(ROOT, "apls", spec, `${spec}.simc`);

  let aplText;
  try {
    aplText = readFileSync(aplPath, "utf-8");
  } catch {
    console.error(`Cannot read APL file: ${aplPath}`);
    process.exit(1);
  }

  const duration = parseInt(values.duration, 10);
  console.log(`APL trace: ${buildName} against ${aplPath} (${duration}s)`);

  const trace = simulateApl(aplText, archetype, duration);

  // Print first 30 GCDs
  const specConfig = getSpecAdapter().getSpecConfig();
  const priName = specConfig.resources.primary.name;
  const secName = specConfig.resources.secondary?.name;
  console.log("\nFirst 30 GCDs (APL decisions):");
  console.log("─".repeat(90));
  const cols = [
    "GCD".padEnd(4),
    "t".padEnd(7),
    "Ability".padEnd(22),
    priName.slice(0, 6).padEnd(6),
  ];
  if (secName) cols.push(secName.slice(0, 6).padEnd(6));
  cols.push("APL Reason");
  console.log(cols.join(" "));
  console.log("─".repeat(90));

  for (const evt of trace.events.slice(0, 30)) {
    const row = [
      String(evt.gcd).padEnd(4),
      `${evt.t}s`.padEnd(7),
      evt.ability.padEnd(22),
      String(evt.pre[priName] ?? "").padEnd(6),
    ];
    if (secName) row.push(String(evt.pre[secName] ?? "").padEnd(6));
    row.push((evt.apl_reason || "").slice(0, 55));
    console.log(row.join(" "));
  }

  console.log(`\nTotal APL decisions: ${trace.events.length}`);

  // Save
  const outputDir = join(ROOT, "results", spec);
  mkdirSync(outputDir, { recursive: true });
  const outputFile =
    values.output || join(outputDir, `apl-trace-${buildName}.json`);
  writeFileSync(outputFile, JSON.stringify(trace));
  console.log(`\nAPL trace saved to: ${outputFile}`);
}
