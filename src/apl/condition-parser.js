// APL condition parser — parses SimC condition expressions into semantic AST.
// Conditions like "fury>=30&buff.demon_spikes.up|cooldown.fiery_brand.ready"
// are parsed into structured nodes for analysis and manipulation.
// Usage: node src/apl/condition-parser.js "condition_string"

// --- AST Node Types ---
// BinaryOp: { type: "BinaryOp", op: "&"|"|", left: Node, right: Node }
// Not: { type: "Not", operand: Node }
// Comparison: { type: "Comparison", left: string, op: string, right: string }
// BuffCheck: { type: "BuffCheck", buff: string, property: string, negate: boolean }
// ResourceCheck: { type: "ResourceCheck", resource: string, property: string }
// CooldownCheck: { type: "CooldownCheck", spell: string, property: string }
// TalentCheck: { type: "TalentCheck", talent: string, negate: boolean }
// VariableCheck: { type: "VariableCheck", variable: string, property: string }
// SpellTargets: { type: "SpellTargets", spell: string }
// Literal: { type: "Literal", value: string }
// PrevGcd: { type: "PrevGcd", position: number, ability: string }

const SINGLE_CHAR_TOKENS = {
  "&": "op",
  "|": "op",
  "!": "not",
  "(": "lparen",
  ")": "rparen",
};

function tokenize(condition) {
  const tokens = [];
  let i = 0;

  while (i < condition.length) {
    const ch = condition[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    const singleType = SINGLE_CHAR_TOKENS[ch];
    if (singleType) {
      tokens.push({ type: singleType, value: ch });
      i++;
      continue;
    }

    if (ch === ">" || ch === "<" || ch === "=") {
      let op = ch;
      if (condition[i + 1] === "=") {
        op += "=";
        i++;
      }
      tokens.push({ type: "cmp", value: op });
      i++;
      continue;
    }

    if (/[a-zA-Z0-9._]/.test(ch)) {
      let value = "";
      while (i < condition.length && /[a-zA-Z0-9._]/.test(condition[i])) {
        value += condition[i];
        i++;
      }
      tokens.push({ type: "ident", value });
      continue;
    }

    i++;
  }

  return tokens;
}

// Parse tokens into AST using recursive descent.
export function parseCondition(condition) {
  if (!condition || condition.trim() === "") return null;

  const tokens = tokenize(condition);
  let pos = 0;

  function peek() {
    return tokens[pos];
  }

  function consume(expectedType) {
    const token = tokens[pos];
    if (expectedType && token?.type !== expectedType) {
      return null;
    }
    pos++;
    return token;
  }

  // expr = term ("|" term)*
  function parseExpr() {
    let left = parseTerm();
    while (peek()?.type === "op" && peek()?.value === "|") {
      consume("op");
      const right = parseTerm();
      left = { type: "BinaryOp", op: "|", left, right };
    }
    return left;
  }

  // term = factor ("&" factor)*
  function parseTerm() {
    let left = parseFactor();
    while (peek()?.type === "op" && peek()?.value === "&") {
      consume("op");
      const right = parseFactor();
      left = { type: "BinaryOp", op: "&", left, right };
    }
    return left;
  }

  // factor = "!" factor | atom | "(" expr ")"
  function parseFactor() {
    if (peek()?.type === "not") {
      consume("not");
      const operand = parseFactor();
      return { type: "Not", operand };
    }

    if (peek()?.type === "lparen") {
      consume("lparen");
      const expr = parseExpr();
      consume("rparen");
      return expr;
    }

    return parseAtom();
  }

  // atom = ident (cmp ident)?
  function parseAtom() {
    const left = consume("ident");
    if (!left) return { type: "Literal", value: "" };

    // Check for comparison
    if (peek()?.type === "cmp") {
      const op = consume("cmp");
      const right = consume("ident");
      return {
        type: "Comparison",
        left: left.value,
        op: op.value,
        right: right?.value || "",
      };
    }

    // Parse the identifier into a semantic node
    return parseIdentifier(left.value);
  }

  // Parse an identifier into a semantic node type.
  function parseIdentifier(ident) {
    const parts = ident.split(".");

    // buff.X.property
    if (parts[0] === "buff" && parts.length >= 2) {
      return {
        type: "BuffCheck",
        buff: parts[1],
        property: parts.slice(2).join(".") || "up",
        negate: false,
      };
    }

    // debuff.X.property (treat like buff for analysis)
    if (parts[0] === "debuff" && parts.length >= 2) {
      return {
        type: "BuffCheck",
        buff: parts[1],
        property: parts.slice(2).join(".") || "up",
        negate: false,
        isDebuff: true,
      };
    }

    // dot.X.property (DoT tracking)
    if (parts[0] === "dot" && parts.length >= 2) {
      return {
        type: "BuffCheck",
        buff: parts[1],
        property: parts.slice(2).join(".") || "ticking",
        negate: false,
        isDot: true,
      };
    }

    // cooldown.X.property
    if (parts[0] === "cooldown" && parts.length >= 2) {
      return {
        type: "CooldownCheck",
        spell: parts[1],
        property: parts.slice(2).join(".") || "ready",
      };
    }

    // talent.X
    if (parts[0] === "talent" && parts.length >= 2) {
      return {
        type: "TalentCheck",
        talent: parts.slice(1).join("."),
        negate: false,
      };
    }

    // variable.X
    if (parts[0] === "variable" && parts.length >= 2) {
      return {
        type: "VariableCheck",
        variable: parts[1],
        property: parts.slice(2).join(".") || "value",
      };
    }

    // spell_targets.X
    if (parts[0] === "spell_targets" && parts.length >= 2) {
      return {
        type: "SpellTargets",
        spell: parts[1],
      };
    }

    // prev_gcd.N.ability
    if (parts[0] === "prev_gcd" && parts.length >= 3) {
      return {
        type: "PrevGcd",
        position: parseInt(parts[1], 10) || 1,
        ability: parts[2],
      };
    }

    // hero_tree.X
    if (parts[0] === "hero_tree" && parts.length >= 2) {
      return {
        type: "HeroTreeCheck",
        tree: parts[1],
      };
    }

    // Resource checks (fury, soul_fragments, health, etc.)
    const knownResources = [
      "fury",
      "soul_fragments",
      "health",
      "soul_fragments.total",
      "souls_consumed",
      "active_enemies",
    ];
    if (knownResources.includes(ident) || knownResources.includes(parts[0])) {
      return {
        type: "ResourceCheck",
        resource: parts[0],
        property: parts.slice(1).join(".") || "current",
      };
    }

    // Default: treat as literal
    return { type: "Literal", value: ident };
  }

  return parseExpr();
}

// Extract semantic information from a parsed AST.
export function extractSemantics(ast) {
  const result = {
    resourceGates: [],
    buffRequirements: [],
    cooldownGates: [],
    talentChecks: [],
    variableChecks: [],
    spellTargets: [],
    prevGcdChecks: [],
  };

  function walk(node) {
    if (!node) return;

    switch (node.type) {
      case "BinaryOp":
        walk(node.left);
        walk(node.right);
        break;

      case "Not":
        // Mark negation on the operand if applicable
        const inner = node.operand;
        if (inner?.type === "BuffCheck") {
          result.buffRequirements.push({
            ...inner,
            negate: true,
          });
        } else if (inner?.type === "TalentCheck") {
          result.talentChecks.push({
            ...inner,
            negate: true,
          });
        } else {
          walk(inner);
        }
        break;

      case "Comparison":
        // Check if left side is a known resource or buff property
        const leftParts = node.left.split(".");
        if (
          [
            "fury",
            "soul_fragments",
            "health",
            "souls_consumed",
            "active_enemies",
          ].includes(leftParts[0])
        ) {
          result.resourceGates.push({
            resource: leftParts[0],
            property: leftParts.slice(1).join(".") || "current",
            op: node.op,
            value: node.right,
          });
        } else if (leftParts[0] === "buff" && leftParts.length >= 3) {
          result.buffRequirements.push({
            buff: leftParts[1],
            property: leftParts.slice(2).join("."),
            op: node.op,
            value: node.right,
          });
        } else if (leftParts[0] === "cooldown" && leftParts.length >= 3) {
          result.cooldownGates.push({
            spell: leftParts[1],
            property: leftParts.slice(2).join("."),
            op: node.op,
            value: node.right,
          });
        } else if (leftParts[0] === "spell_targets") {
          result.spellTargets.push({
            spell: leftParts[1] || "unknown",
            op: node.op,
            value: node.right,
          });
        }
        break;

      case "BuffCheck":
        result.buffRequirements.push(node);
        break;

      case "CooldownCheck":
        result.cooldownGates.push(node);
        break;

      case "TalentCheck":
        result.talentChecks.push(node);
        break;

      case "VariableCheck":
        result.variableChecks.push(node);
        break;

      case "SpellTargets":
        result.spellTargets.push({ spell: node.spell, op: "=", value: "?" });
        break;

      case "ResourceCheck":
        result.resourceGates.push({
          resource: node.resource,
          property: node.property,
          op: "check",
          value: null,
        });
        break;

      case "PrevGcd":
        result.prevGcdChecks.push(node);
        break;
    }
  }

  walk(ast);
  return result;
}

// Serialize an AST back to a condition string.
export function serializeCondition(ast, parentOp = null) {
  if (!ast) return "";

  switch (ast.type) {
    case "BinaryOp":
      const left = serializeCondition(ast.left, ast.op);
      const right = serializeCondition(ast.right, ast.op);
      let result = `${left}${ast.op}${right}`;
      // Add parens if lower-precedence op (|) is inside higher-precedence (&)
      if (parentOp === "&" && ast.op === "|") {
        result = `(${result})`;
      }
      return result;

    case "Not":
      const inner = serializeCondition(ast.operand, null);
      // Add parens if the operand is a BinaryOp
      if (ast.operand?.type === "BinaryOp") {
        return `!(${inner})`;
      }
      return `!${inner}`;

    case "Comparison":
      return `${ast.left}${ast.op}${ast.right}`;

    case "BuffCheck":
      const buffPrefix = ast.isDot ? "dot" : ast.isDebuff ? "debuff" : "buff";
      return `${buffPrefix}.${ast.buff}.${ast.property}`;

    case "CooldownCheck":
      return `cooldown.${ast.spell}.${ast.property}`;

    case "TalentCheck":
      return `talent.${ast.talent}`;

    case "VariableCheck":
      return `variable.${ast.variable}`;

    case "SpellTargets":
      return `spell_targets.${ast.spell}`;

    case "ResourceCheck":
      if (ast.property && ast.property !== "current") {
        return `${ast.resource}.${ast.property}`;
      }
      return ast.resource;

    case "PrevGcd":
      return `prev_gcd.${ast.position}.${ast.ability}`;

    case "HeroTreeCheck":
      return `hero_tree.${ast.tree}`;

    case "Literal":
      return ast.value;

    default:
      return "";
  }
}

export function findBuffReferences(condition) {
  return extractSemantics(parseCondition(condition)).buffRequirements.map(
    (b) => b.buff,
  );
}

export function findResourceGates(condition) {
  return extractSemantics(parseCondition(condition)).resourceGates;
}

export function referencesBuff(condition, buffName) {
  const normalizedName = buffName.toLowerCase().replace(/[_ ]/g, "_");
  return findBuffReferences(condition).some(
    (b) => b.toLowerCase() === normalizedName,
  );
}

export function addClause(ast, clause, operator = "&") {
  const clauseAst =
    typeof clause === "string" ? parseCondition(clause) : clause;
  if (!ast) return clauseAst;
  if (!clauseAst) return ast;
  return { type: "BinaryOp", op: operator, left: ast, right: clauseAst };
}

export function removeClause(ast, predicate) {
  if (!ast) return null;

  switch (ast.type) {
    case "BinaryOp":
      const left = removeClause(ast.left, predicate);
      const right = removeClause(ast.right, predicate);
      if (!left) return right;
      if (!right) return left;
      return { ...ast, left, right };

    case "Not":
      if (predicate(ast)) return null;
      const operand = removeClause(ast.operand, predicate);
      if (!operand) return null;
      return { ...ast, operand };

    default:
      if (predicate(ast)) return null;
      return ast;
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const condition = process.argv[2];

  if (!condition) {
    console.log("Usage: node src/apl/condition-parser.js <condition>");
    console.log("");
    console.log("Examples:");
    console.log('  node src/apl/condition-parser.js "fury>=30"');
    console.log('  node src/apl/condition-parser.js "buff.demon_spikes.up"');
    console.log(
      '  node src/apl/condition-parser.js "!buff.rending_strike.up&buff.glaive_flurry.up"',
    );
    process.exit(1);
  }

  console.log("Input:", condition);
  console.log("");

  const ast = parseCondition(condition);
  console.log("AST:", JSON.stringify(ast, null, 2));
  console.log("");

  const semantics = extractSemantics(ast);
  console.log("Semantics:", JSON.stringify(semantics, null, 2));
  console.log("");

  const roundTrip = serializeCondition(ast);
  console.log("Round-trip:", roundTrip);
  console.log("Match:", roundTrip === condition ? "YES" : "NO");
}
