// Extracts proc mechanics from sc_demon_hunter.cpp that are NOT in spell data.
// Targets: rng().roll() proc rates, ICD declarations and durations,
// accumulator thresholds, and RPPM declarations.
// Output: data/cpp-proc-mechanics.json (replaces manually maintained proc-mechanics.json)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SIMC_DH_CPP } from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../..", "data");

function extractProcMechanics() {
  const src = readFileSync(SIMC_DH_CPP, "utf-8");
  const lines = src.split("\n");

  const icdDeclarations = scanICDDeclarations(lines);
  const icdUsages = scanICDUsages(lines, icdDeclarations);
  const procRolls = scanProcRolls(lines);
  const rppmDeclarations = scanRPPMDeclarations(lines);
  const accumulators = scanAccumulators(lines);
  const optionDefaults = scanOptionDefaults(lines);
  const constants = scanConstants(lines);

  const output = {
    source: "sc_demon_hunter.cpp (auto-extracted)",
    extractedAt: new Date().toISOString(),
    icds: icdUsages,
    procs: procRolls,
    rppm: rppmDeclarations,
    accumulators,
    optionDefaults,
    constants,
    stats: {
      icdDeclarations: icdDeclarations.length,
      icdUsages: icdUsages.length,
      procRolls: procRolls.length,
      rppmDeclarations: rppmDeclarations.length,
      accumulators: accumulators.length,
      optionDefaults: optionDefaults.length,
      constants: constants.length,
    },
  };

  writeFileSync(
    join(DATA_DIR, "cpp-proc-mechanics.json"),
    JSON.stringify(output, null, 2),
  );

  console.log("Wrote data/cpp-proc-mechanics.json");
  console.log(`  ${icdUsages.length} ICD usages`);
  console.log(`  ${procRolls.length} proc roll patterns`);
  console.log(`  ${rppmDeclarations.length} RPPM declarations`);
  console.log(`  ${accumulators.length} accumulator patterns`);
  console.log(`  ${optionDefaults.length} option defaults`);
  console.log(`  ${constants.length} constants`);
}

// Find all cooldown_t* ICD declarations in the cooldowns struct
function scanICDDeclarations(lines) {
  const results = [];
  const pattern = /cooldown_t\*\s+(\w+_icd)\b/;
  let inCooldowns = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("struct cooldowns_t")) inCooldowns = true;
    if (inCooldowns && lines[i].match(/^\s*}\s*cooldown/)) inCooldowns = false;

    const match = lines[i].match(pattern);
    if (match) {
      results.push({
        name: match[1],
        line: i + 1,
        inCooldownStruct: inCooldowns,
      });
    }
  }
  return results;
}

// Find ICD ->start() calls and extract durations
function scanICDUsages(lines, declarations) {
  const results = [];
  const declNames = new Set(declarations.map((d) => d.name));

  // Pattern: cooldown.X->start( duration ) or cooldown.X_icd->start( ... )
  const startPattern = /cooldown\.(\w+)->start\(\s*([^)]*)\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    let match;
    startPattern.lastIndex = 0;
    while ((match = startPattern.exec(lines[i])) !== null) {
      const cdName = match[1];
      const durationExpr = match[2].trim();

      // Only track ICDs (named with _icd suffix or in our declarations)
      if (!cdName.endsWith("_icd") && !declNames.has(cdName)) continue;

      const duration = parseDuration(durationExpr);
      const context = findEnclosingContext(lines, i);

      results.push({
        icdName: cdName,
        durationExpression: durationExpr,
        durationSeconds: duration.seconds,
        durationSource: duration.source,
        line: i + 1,
        context: context.name,
        contextType: context.type,
      });
    }
  }

  return deduplicateICDs(results);
}

// Parse a C++ duration expression into seconds
function parseDuration(expr) {
  // Hardcoded timespan literals: 100_ms, 1_s, 1.5_s, etc.
  const msLiteral = expr.match(/^(\d+(?:\.\d+)?)_ms$/);
  if (msLiteral) {
    return { seconds: parseFloat(msLiteral[1]) / 1000, source: "hardcoded" };
  }

  const sLiteral = expr.match(/^(\d+(?:\.\d+)?)_s$/);
  if (sLiteral) {
    return { seconds: parseFloat(sLiteral[1]), source: "hardcoded" };
  }

  // timespan_t::from_seconds( N )
  const fromSeconds = expr.match(
    /timespan_t::from_seconds\(\s*(\d+(?:\.\d+)?)\s*\)/,
  );
  if (fromSeconds) {
    return { seconds: parseFloat(fromSeconds[1]), source: "hardcoded" };
  }

  // timespan_t::from_millis( N )
  const fromMillis = expr.match(
    /timespan_t::from_millis\(\s*(\d+(?:\.\d+)?)\s*\)/,
  );
  if (fromMillis) {
    return { seconds: parseFloat(fromMillis[1]) / 1000, source: "hardcoded" };
  }

  // Spell data reference: X->internal_cooldown()
  if (expr.includes("internal_cooldown()")) {
    return { seconds: null, source: "spell_data" };
  }

  // effectN(N).time_value()
  const effectTime = expr.match(/effectN\(\s*\d+\s*\)\.time_value\(\)/);
  if (effectTime) {
    return { seconds: null, source: "spell_data_effect" };
  }

  return { seconds: null, source: "unknown" };
}

// Deduplicate ICDs — keep the one with the most info
function deduplicateICDs(icds) {
  const byName = new Map();
  for (const icd of icds) {
    const existing = byName.get(icd.icdName);
    if (
      !existing ||
      (icd.durationSeconds !== null && existing.durationSeconds === null)
    ) {
      byName.set(icd.icdName, icd);
    }
  }
  return [...byName.values()];
}

// Scan for rng().roll() proc patterns
function scanProcRolls(lines) {
  const results = [];
  const rollPattern = /(?:p\(\)->)?rng\(\)\.roll\(\s*([^)]+)\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    let match;
    rollPattern.lastIndex = 0;
    while ((match = rollPattern.exec(lines[i])) !== null) {
      const chanceExpr = match[1].trim();
      const context = findEnclosingContext(lines, i);

      // Try to resolve the chance expression
      const chance = resolveChance(chanceExpr, lines, i);

      // Get surrounding lines for additional context
      const surroundingContext = extractSurroundingContext(lines, i, 5);

      results.push({
        chanceExpression: chanceExpr,
        resolvedChance: chance.value,
        chanceSource: chance.source,
        line: i + 1,
        context: context.name,
        contextType: context.type,
        surroundingHint: surroundingContext,
      });
    }
  }
  return results;
}

// Resolve a proc chance expression to a numeric value where possible
function resolveChance(expr, lines, lineNum) {
  // Direct numeric literal
  const numMatch = expr.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) {
    return { value: parseFloat(numMatch[1]), source: "hardcoded" };
  }

  // effectN(N).percent()
  if (expr.includes("effectN") && expr.includes("percent()")) {
    return { value: null, source: "spell_data_percent" };
  }

  // Variable reference — look backward for assignment
  const varMatch = expr.match(/^(\w+)$/);
  if (varMatch) {
    const varName = varMatch[1];
    for (let j = lineNum - 1; j >= Math.max(0, lineNum - 30); j--) {
      const assignMatch = lines[j].match(
        new RegExp(`\\b${varName}\\s*=\\s*([^;]+);`),
      );
      if (assignMatch) {
        const innerChance = resolveChance(assignMatch[1].trim(), lines, j);
        if (innerChance.value !== null) return innerChance;
        return { value: null, source: `variable:${assignMatch[1].trim()}` };
      }
    }
    return { value: null, source: `unresolved_variable:${varName}` };
  }

  return { value: null, source: `expression:${expr}` };
}

// Scan for RPPM declarations
function scanRPPMDeclarations(lines) {
  const results = [];
  const pattern = /real_ppm_t\*\s+(\w+)\b/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (match) {
      results.push({
        name: match[1],
        line: i + 1,
      });
    }
  }
  return results;
}

// Scan for accumulator patterns (Feed the Demon style)
function scanAccumulators(lines) {
  const results = [];

  // Look for functions with "accumulate" in the name
  const funcPattern = /(?:void|double)\s+(\w*accumulate\w*)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(funcPattern);
    if (!match) continue;

    const funcName = match[1];
    const body = extractFunctionBody(lines, i);
    if (!body) continue;

    // Find threshold comparison
    const thresholdMatch = body.match(/(\w+)\s*>=\s*([^;{]+)/);

    // Find the effect/action when threshold is met
    const effectMatch = body.match(
      /(?:cooldown|buff|action)\.(\w+)->(?:adjust|trigger|execute|start)\(/,
    );

    results.push({
      functionName: funcName,
      line: i + 1,
      threshold: thresholdMatch
        ? { variable: thresholdMatch[1], expression: thresholdMatch[2].trim() }
        : null,
      effect: effectMatch ? effectMatch[1] : null,
      bodySnippet: body.substring(0, 300),
    });
  }

  return results;
}

// Scan for option defaults that control proc behavior
function scanOptionDefaults(lines) {
  const results = [];

  // Pattern: add_option( opt_float( "name", var, default ) )
  const optPattern =
    /opt_(?:float|int|bool)\(\s*"([^"]+)"\s*,\s*(\w+(?:\.\w+)*)\s*(?:,\s*([^)]+))?\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    let match;
    optPattern.lastIndex = 0;
    while ((match = optPattern.exec(lines[i])) !== null) {
      // Only include proc-related options
      const name = match[1];
      if (
        !name.includes("proc") &&
        !name.includes("chance") &&
        !name.includes("icd") &&
        !name.includes("soul_fragment") &&
        !name.includes("trigger") &&
        !name.includes("wounded_quarry")
      )
        continue;

      results.push({
        optionName: name,
        variable: match[2],
        defaultValue: match[3]?.trim() || null,
        line: i + 1,
      });
    }
  }
  return results;
}

// Scan for named constants related to proc mechanics
// Only captures file/struct-scope constants (requires static/constexpr/const qualifier)
// and option defaults (struct member initializers like `double name = value;`)
function scanConstants(lines) {
  const results = [];

  // File-scope or struct-member constants: only ALL_CAPS names (MAX_SOUL_FRAGMENTS)
  const qualifiedPattern =
    /(?:static|constexpr)\s+(?:unsigned\s+)?(?:int\s+|double\s+|size_t\s+)?([A-Z][A-Z0-9_]*(?:MAX|SOUL|FRAGMENT|PROC|CHANCE)[A-Z0-9_]*)\s*=\s*([^;]+)/;

  // Option struct member defaults with numeric initializers only
  // e.g. `double soul_fragment_movement_consume_chance = 0.85;`
  // Requires name to contain "chance" to avoid local variable noise
  const optionMemberPattern =
    /^\s+(?:double|int|unsigned|bool)\s+(\w*(?:soul_fragment|wounded_quarry)\w*chance\w*)\s*=\s*(\d[^;]*)/;

  for (let i = 0; i < lines.length; i++) {
    const match =
      lines[i].match(qualifiedPattern) || lines[i].match(optionMemberPattern);
    if (match) {
      const value = match[2].trim();
      const numValue = parseFloat(value);
      results.push({
        name: match[1],
        expression: value,
        numericValue: isNaN(numValue) ? null : numValue,
        line: i + 1,
      });
    }
  }
  return results;
}

// Extract a short context hint from surrounding lines
function extractSurroundingContext(lines, lineNum, radius) {
  const hints = [];
  for (
    let i = Math.max(0, lineNum - radius);
    i <= Math.min(lines.length - 1, lineNum + radius);
    i++
  ) {
    const line = lines[i].trim();
    // Look for ability names, talent refs, buff checks
    if (
      line.includes("talent.") ||
      line.includes("buff.") ||
      line.includes("soul_fragment") ||
      line.includes("immolation_aura") ||
      line.includes("fracture") ||
      line.includes("spirit_bomb")
    ) {
      hints.push(line.substring(0, 120));
    }
  }
  return hints.length > 0 ? hints.slice(0, 3).join(" | ") : null;
}

function findEnclosingContext(lines, lineNum) {
  const structPattern = /^struct (\w+)\s*(?:final\s*)?:\s*public/;
  const funcPattern = /^(?:void|double|bool|action_t\*)\s+(?:[\w:]+)::(\w+)/;
  const memberFuncPattern =
    /(?:void|double|bool)\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?{?\s*$/;

  for (let i = lineNum; i >= Math.max(0, lineNum - 200); i--) {
    const structMatch = lines[i].match(structPattern);
    if (structMatch) return { name: structMatch[1], type: "struct" };
    const funcMatch = lines[i].match(funcPattern);
    if (funcMatch) return { name: funcMatch[1], type: "member_function" };
  }
  return { name: "unknown", type: "unknown" };
}

function extractFunctionBody(lines, startLine) {
  let depth = 0;
  let started = false;
  let body = "";
  for (let i = startLine; i < Math.min(startLine + 150, lines.length); i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        started = true;
        depth++;
      }
      if (started) body += ch;
      if (ch === "}" && started) {
        depth--;
        if (depth === 0) return body;
      }
    }
    if (started) body += "\n";
  }
  return body;
}

extractProcMechanics();
