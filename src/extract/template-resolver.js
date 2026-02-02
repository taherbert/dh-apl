// Resolves template variables in simc spell descriptions.
// Substitutes $s1, $d, $t1, $a1, $SpellIds1, $?sSpellId[yes][no], ${expr}, etc.
// Leaves unresolvable variables as raw template text.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

// Build a lookup map from spell ID → spell object
function buildSpellMap(spells) {
  const map = new Map();
  for (const spell of spells) map.set(spell.id, spell);
  return map;
}

// Build a set of known spell IDs (for $?sSpellId conditionals)
function buildKnownSpellIds(spells) {
  return new Set(spells.map((s) => s.id));
}

// Get effect value for $sN, $SN references
function getEffectValue(spell, effectIndex) {
  const effect = spell.effects?.find((e) => e.index === effectIndex);
  if (!effect?.details) return null;
  const val = effect.details.scaledValue ?? effect.details.baseValue;
  if (val === undefined || val === null) return null;
  return val;
}

// Get effect misc value for $mN
function getEffectMiscValue(spell, effectIndex) {
  const effect = spell.effects?.find((e) => e.index === effectIndex);
  return effect?.details?.miscValue ?? null;
}

// Get effect radius for $aN/$AN
function getEffectRadius(spell, effectIndex) {
  const effect = spell.effects?.find((e) => e.index === effectIndex);
  if (!effect?.details?.radius) return null;
  const m = effect.details.radius.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

// Get tick period for $tN
function getEffectTickPeriod(spell, effectIndex) {
  const effect = spell.effects?.find((e) => e.index === effectIndex);
  if (!effect?.details) return null;
  // Tick period is sometimes in Amplitude or Period field
  const period = effect.details.Amplitude || effect.details.Period;
  if (period) {
    const m = String(period).match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

// Get max targets for $i
function getMaxTargets(spell) {
  return spell.maxTargets ?? null;
}

// Get effect trigger count for $xN
function getEffectChainTargets(spell, effectIndex) {
  const effect = spell.effects?.find((e) => e.index === effectIndex);
  return effect?.details?.["Chain Targets"] ?? null;
}

// Format a number for display — strip trailing zeros, show as integer when possible
function formatValue(val) {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  if (Number.isNaN(num)) return String(val);
  if (Number.isInteger(num)) return String(num);
  // Show up to 2 decimal places, strip trailing zeros
  return num.toFixed(2).replace(/\.?0+$/, "");
}

// Evaluate simple arithmetic: val*2, val/1000, val/-1000, etc.
function evalArithmetic(baseVal, expr) {
  if (baseVal === null) return null;
  const num = Number(baseVal);
  if (Number.isNaN(num)) return null;

  // Match patterns like *2, /1000, /-1000, +1, -1
  const m = expr.match(/^([*/%+-])\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const op = m[1];
  const operand = Number(m[2]);
  switch (op) {
    case "*":
      return num * operand;
    case "/":
      return num / operand;
    case "%":
      return num % operand;
    case "+":
      return num + operand;
    case "-":
      return num - operand;
    default:
      return null;
  }
}

// Resolve a single template token within a description.
// Returns the resolved string, or null if unresolvable.
function resolveToken(token, spell, spellMap, knownIds) {
  // $d → spell duration
  if (token === "$d") {
    if (spell.duration != null) return `${formatValue(spell.duration)} sec`;
    return null;
  }

  // $i → max targets
  if (token === "$i") {
    const val = getMaxTargets(spell);
    return val != null ? formatValue(val) : null;
  }

  // $sN → effect N scaledValue/baseValue (same spell)
  let m = token.match(/^\$s(\d+)$/);
  if (m) {
    const val = getEffectValue(spell, parseInt(m[1]));
    return val != null ? formatValue(val) : null;
  }

  // $mN → effect N misc value
  m = token.match(/^\$m(\d+)$/);
  if (m) {
    const val = getEffectMiscValue(spell, parseInt(m[1]));
    return val != null ? String(val) : null;
  }

  // $tN → effect N tick period
  m = token.match(/^\$t(\d+)$/);
  if (m) {
    const val = getEffectTickPeriod(spell, parseInt(m[1]));
    return val != null ? `${formatValue(val)} sec` : null;
  }

  // $aN/$AN → effect N radius
  m = token.match(/^\$[aA](\d+)$/);
  if (m) {
    const val = getEffectRadius(spell, parseInt(m[1]));
    return val != null ? formatValue(val) : null;
  }

  // $xN → effect N chain targets
  m = token.match(/^\$x(\d+)$/);
  if (m) {
    const val = getEffectChainTargets(spell, parseInt(m[1]));
    return val != null ? formatValue(val) : null;
  }

  // $oN → total periodic value (scaledValue * duration / tickPeriod)
  m = token.match(/^\$o(\d+)$/);
  if (m) {
    const effectIdx = parseInt(m[1]);
    const val = getEffectValue(spell, effectIdx);
    const tick = getEffectTickPeriod(spell, effectIdx);
    if (val != null && tick && spell.duration) {
      return formatValue(val * (spell.duration / tick));
    }
    return val != null ? formatValue(val) : null;
  }

  // $SpellIdsN → cross-reference another spell's effect value
  // e.g., $258921s1 → spell 258921, effect #1 scaledValue
  m = token.match(/^\$(\d+)s(\d+)$/);
  if (m) {
    const refSpell = spellMap.get(parseInt(m[1]));
    if (!refSpell) return null;
    const val = getEffectValue(refSpell, parseInt(m[2]));
    return val != null ? formatValue(val) : null;
  }

  // $SpellIdA1 → cross-reference another spell's effect radius
  m = token.match(/^\$(\d+)[aA](\d+)$/);
  if (m) {
    const refSpell = spellMap.get(parseInt(m[1]));
    if (!refSpell) return null;
    const val = getEffectRadius(refSpell, parseInt(m[2]));
    return val != null ? formatValue(val) : null;
  }

  // $SpellIdd → cross-reference another spell's duration
  m = token.match(/^\$(\d+)d$/);
  if (m) {
    const refSpell = spellMap.get(parseInt(m[1]));
    if (!refSpell) return null;
    if (refSpell.duration != null)
      return `${formatValue(refSpell.duration)} sec`;
    return null;
  }

  // $SpellIdx1 → cross-reference chain targets
  m = token.match(/^\$(\d+)x(\d+)$/);
  if (m) {
    const refSpell = spellMap.get(parseInt(m[1]));
    if (!refSpell) return null;
    const val = getEffectChainTargets(refSpell, parseInt(m[2]));
    return val != null ? formatValue(val) : null;
  }

  // $SpellIdtN → cross-reference tick period
  m = token.match(/^\$(\d+)t(\d+)$/);
  if (m) {
    const refSpell = spellMap.get(parseInt(m[1]));
    if (!refSpell) return null;
    const val = getEffectTickPeriod(refSpell, parseInt(m[2]));
    return val != null ? `${formatValue(val)} sec` : null;
  }

  // $SpellIdoN → cross-reference total periodic value
  m = token.match(/^\$(\d+)o(\d+)$/);
  if (m) {
    const refSpell = spellMap.get(parseInt(m[1]));
    if (!refSpell) return null;
    const effectIdx = parseInt(m[2]);
    const val = getEffectValue(refSpell, effectIdx);
    const tick = getEffectTickPeriod(refSpell, effectIdx);
    if (val != null && tick && refSpell.duration) {
      return formatValue(val * (refSpell.duration / tick));
    }
    return val != null ? formatValue(val) : null;
  }

  // $SpellIdmN → cross-reference misc value
  m = token.match(/^\$(\d+)m(\d+)$/);
  if (m) {
    const refSpell = spellMap.get(parseInt(m[1]));
    if (!refSpell) return null;
    const val = getEffectMiscValue(refSpell, parseInt(m[2]));
    return val != null ? String(val) : null;
  }

  return null;
}

// Resolve ${expr} blocks — e.g., ${$s1*2}, ${$s1/1000}, ${$320654s1}
function resolveExprBlock(content, spell, spellMap, knownIds) {
  // Try to resolve all $-tokens in the expression, then evaluate
  const resolved = content.replace(/\$(\d*[sdatxmoAx]\d*)/g, (match, ref) => {
    const val = resolveToken("$" + ref, spell, spellMap, knownIds);
    return val != null ? String(parseFloat(val) || val) : match;
  });

  // If any $ remain, we can't fully resolve
  if (resolved.includes("$")) return null;

  // Try safe arithmetic evaluation
  try {
    // Only allow digits, operators, parentheses, dots, spaces
    if (!/^[\d\s+\-*/%().]+$/.test(resolved)) return null;
    // Replace % with / for simc's division operator
    const jsExpr = resolved.replace(/%/g, "/");
    const result = Function(`"use strict"; return (${jsExpr})`)();
    if (typeof result === "number" && Number.isFinite(result)) {
      return formatValue(result);
    }
  } catch {
    // Expression too complex or invalid
  }
  return null;
}

// Resolve $?sSpellId[yes text][no text] and $?aSpellId[yes][no] conditionals
// These check whether a spell/aura exists. We resolve based on known spell IDs.
function resolveConditional(desc, startIdx, spellMap, knownIds) {
  // Match $?s<id> or $?a<id> or $?$s<id>
  const prefix = desc.slice(startIdx);
  const m = prefix.match(/^\$\?[\($]?[sa](\d+)\)?/);
  if (!m) return null;

  const spellId = parseInt(m[1]);
  let afterCondition = startIdx + m[0].length;

  // Skip optional whitespace before opening bracket
  while (afterCondition < desc.length && desc[afterCondition] === " ")
    afterCondition++;

  // Find [yes text][no text] — brackets can be nested
  const yesResult = extractBracketContent(desc, afterCondition);
  if (!yesResult) return null;
  const noResult = extractBracketContent(desc, yesResult.end);
  if (!noResult) return null;

  const exists = knownIds.has(spellId);
  const chosen = exists ? yesResult.content : noResult.content;

  return {
    replacement: chosen,
    end: noResult.end,
  };
}

// Extract content between matching [ ] brackets, handling nesting
function extractBracketContent(text, startIdx) {
  if (startIdx >= text.length || text[startIdx] !== "[") return null;
  let depth = 0;
  let i = startIdx;
  while (i < text.length) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) {
        return {
          content: text.slice(startIdx + 1, i),
          end: i + 1,
        };
      }
    }
    i++;
  }
  return null;
}

// Resolve @spelldesc references — these inline another spell's description
function resolveSpelldesc(spellId, spellMap) {
  const refSpell = spellMap.get(spellId);
  if (!refSpell?.description) return null;
  return refSpell.description;
}

// Main resolver: process a full description string
export function resolveDescription(desc, spell, spellMap, knownIds) {
  if (!desc) return desc;

  let result = "";
  let i = 0;

  while (i < desc.length) {
    if (desc[i] !== "$") {
      result += desc[i];
      i++;
      continue;
    }

    // Try @spelldesc references: $@spelldescNNNNNN
    let m = desc.slice(i).match(/^\$@spelldesc(\d+)/);
    if (m) {
      const refDesc = resolveSpelldesc(parseInt(m[1]), spellMap);
      if (refDesc) {
        // Recursively resolve the inlined description
        result += resolveDescription(refDesc, spell, spellMap, knownIds);
      } else {
        result += m[0];
      }
      i += m[0].length;
      continue;
    }

    // Try conditionals: $?sSpellId[yes][no] or $?aSpellId[yes][no]
    if (desc.slice(i).match(/^\$\?[\($]?[sa]\d+/)) {
      const condResult = resolveConditional(desc, i, spellMap, knownIds);
      if (condResult) {
        // Recursively resolve the chosen branch
        result += resolveDescription(
          condResult.replacement,
          spell,
          spellMap,
          knownIds,
        );
        i = condResult.end;
        continue;
      }
    }

    // Try ${expr} blocks
    if (desc[i + 1] === "{") {
      const closeIdx = desc.indexOf("}", i + 2);
      if (closeIdx !== -1) {
        const content = desc.slice(i + 2, closeIdx);
        const resolved = resolveExprBlock(content, spell, spellMap, knownIds);
        if (resolved != null) {
          result += resolved;
          i = closeIdx + 1;
          continue;
        }
        // Unresolvable expression block — keep raw
        result += desc.slice(i, closeIdx + 1);
        i = closeIdx + 1;
        continue;
      }
    }

    // Try simple tokens: $s1, $d, $t1, $a1, $m1, $x1, $o1, $i, $12345s1, $12345d, $12345o1, etc.
    m = desc.slice(i).match(/^\$(\d+[sdatxmoAx]\d*|\d*[sdatxmoiAx]\d*)/);
    if (m && m[1]) {
      const token = "$" + m[1];
      const resolved = resolveToken(token, spell, spellMap, knownIds);
      if (resolved != null) {
        result += resolved;
        i += m[0].length;
        continue;
      }
      // Unresolvable — keep raw
      result += m[0];
      i += m[0].length;
      continue;
    }

    // Try $abs (absolute value marker) — just pass through
    if (desc.slice(i).match(/^\$abs/)) {
      result += "$abs";
      i += 4;
      continue;
    }

    // Unrecognized $ — keep as-is
    result += "$";
    i++;
  }

  return result;
}

// Resolve all spells in the array, adding resolvedDescription field
export function resolveAllDescriptions(spells) {
  const spellMap = buildSpellMap(spells);
  const knownIds = buildKnownSpellIds(spells);

  let resolved = 0;
  let total = 0;
  let partial = 0;

  for (const spell of spells) {
    if (!spell.description) continue;
    total++;

    const resolvedDesc = resolveDescription(
      spell.description,
      spell,
      spellMap,
      knownIds,
    );
    spell.resolvedDescription = resolvedDesc;

    // Count resolution quality
    const origTemplates = (spell.description.match(/\$/g) || []).length;
    const remainingTemplates = (resolvedDesc.match(/\$/g) || []).length;
    if (remainingTemplates === 0) {
      resolved++;
    } else if (remainingTemplates < origTemplates) {
      partial++;
    }
  }

  return { total, resolved, partial, unresolved: total - resolved - partial };
}

// CLI entry point — resolve and report
if (import.meta.url === `file://${process.argv[1]}`) {
  const spells = JSON.parse(
    readFileSync(join(DATA_DIR, "spells.json"), "utf8"),
  );
  const stats = resolveAllDescriptions(spells);

  console.log(
    `Template resolution: ${stats.resolved} fully resolved, ${stats.partial} partial, ${stats.unresolved} unresolved out of ${stats.total}`,
  );
  const pct = (((stats.resolved + stats.partial) / stats.total) * 100).toFixed(
    1,
  );
  console.log(`Resolution rate: ${pct}%`);

  // Spot-check some key spells
  const checks = [
    247454, 228477, 204021, 263642, 212084, 258920, 204596, 187827, 179057,
    185123,
  ];
  console.log("\nSpot-check:");
  for (const id of checks) {
    const spell = spells.find((s) => s.id === id);
    if (!spell) continue;
    const hasTemplates = spell.resolvedDescription?.includes("$");
    const status = hasTemplates ? "partial" : "resolved";
    console.log(`  [${status}] ${spell.name} (${id})`);
    if (spell.resolvedDescription) {
      console.log(`    ${spell.resolvedDescription.slice(0, 150)}`);
    }
  }
}
