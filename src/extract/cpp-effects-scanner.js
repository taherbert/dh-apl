// Extracts a structured inventory of all effect applications from sc_demon_hunter.cpp.
// Four scan types:
// 1. parse_effects() calls → buff/passive effect applications
// 2. parse_target_effects() calls → debuff effect applications
// 3. composite_* overrides → manual multiplier/mitigation logic
// 4. assess_damage / target_mitigation → reactive/defensive effects

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SIMC_DH_CPP } from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../..", "data");

function extractEffectsInventory() {
  const src = readFileSync(SIMC_DH_CPP, "utf-8");
  const lines = src.split("\n");

  const parseEffects = scanParseEffects(lines);
  const parseTargetEffects = scanParseTargetEffects(lines);
  const compositeOverrides = scanCompositeOverrides(lines);
  const reactiveTriggers = scanReactiveTriggers(lines);

  const output = {
    parseEffects,
    parseTargetEffects,
    compositeOverrides,
    reactiveTriggers,
    stats: {
      parseEffects: parseEffects.length,
      parseTargetEffects: parseTargetEffects.length,
      compositeOverrides: compositeOverrides.length,
      reactiveTriggers: reactiveTriggers.length,
    },
  };

  writeFileSync(
    join(DATA_DIR, "cpp-effects-inventory.json"),
    JSON.stringify(output, null, 2),
  );

  console.log("Wrote data/cpp-effects-inventory.json");
  console.log(`  ${parseEffects.length} parse_effects calls`);
  console.log(`  ${parseTargetEffects.length} parse_target_effects calls`);
  console.log(`  ${compositeOverrides.length} composite_* overrides`);
  console.log(`  ${reactiveTriggers.length} reactive triggers`);
}

// Scan 1: parse_effects() — buff applications that modify all actions
function scanParseEffects(lines) {
  const results = [];
  // Matches: ab::parse_effects( p()->buff.X ) or parse_effects( buff.X )
  // Also captures optional additional args like mastery spell, mask
  const pattern =
    /(?:ab::)?parse_effects\(\s*(?:p\(\)->)?(?:buff|mastery|spec)\.(\w+)(?:\s*,\s*(?:p\(\)->)?(?:buff|mastery|spec|talent\.\w+)\.(\w+))?(?:\s*,\s*(\w+))?\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(line)) !== null) {
      const context = findEnclosingContext(lines, i);
      results.push({
        buff: match[1],
        secondarySource: match[2] || null,
        effectMask: match[3] || null,
        line: i + 1,
        context: context.name,
        contextType: context.type,
        raw: match[0].trim(),
      });
    }
  }
  return results;
}

// Scan 2: parse_target_effects() — debuff applications
function scanParseTargetEffects(lines) {
  const results = [];
  // These are more complex with lambda wrappers and effect masks
  const pattern =
    /(?:ab::)?parse_target_effects\(\s*(?:d_fn\(\s*&demon_hunter_td_t::(debuffs_t|dots_t)::(\w+)\s*\))\s*,\s*(?:p\(\)->)?([\w.]+(?:->effectN\(\s*\d+\s*\)\.trigger\(\))?)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(line)) !== null) {
      // Look ahead for effect_mask and additional parameters
      const fullCall = extractFullCall(lines, i, "parse_target_effects");
      const maskMatch = fullCall.match(
        /effect_mask_t\(\s*(true|false)\s*\)((?:\.(?:enable|disable)\(\s*[\d,\s]+\))*)/,
      );
      let effectMask = null;
      if (maskMatch) {
        effectMask = {
          defaultEnabled: maskMatch[1] === "true",
          modifications: maskMatch[2] || "",
        };
      }

      const context = findEnclosingContext(lines, i);
      results.push({
        targetType: match[1],
        debuff: match[2],
        spellSource: match[3],
        effectMask,
        line: i + 1,
        context: context.name,
        raw: fullCall.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return results;
}

// Scan 3: composite_* overrides with talent conditionals
function scanCompositeOverrides(lines) {
  const results = [];
  const compositePattern =
    /double\s+(composite_(?:da_multiplier|ta_multiplier|player_multiplier|target_mitigation|player_critical_damage_multiplier))\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(compositePattern);
    if (!match) continue;

    const funcName = match[1];
    const context = findEnclosingContext(lines, i);

    // Extract the function body to find talent/buff checks
    const body = extractFunctionBody(lines, i);
    const talentChecks = extractTalentChecks(body);
    const buffChecks = extractBuffChecks(body);

    if (talentChecks.length === 0 && buffChecks.length === 0) continue;

    results.push({
      function: funcName,
      line: i + 1,
      context: context.name,
      contextType: context.type,
      talentChecks,
      buffChecks,
    });
  }
  return results;
}

// Scan 4: assess_damage and target_mitigation reactive triggers
function scanReactiveTriggers(lines) {
  const results = [];

  // Find assess_damage function
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("demon_hunter_t::assess_damage")) continue;
    if (!lines[i].includes("{") && !lines[i + 1]?.includes("{")) continue;

    const body = extractFunctionBody(lines, i);
    const triggers = extractReactiveFromBody(body, "assess_damage");
    results.push(...triggers);
    break;
  }

  // Find target_mitigation function
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("demon_hunter_t::target_mitigation")) continue;
    if (!lines[i].includes("{") && !lines[i + 1]?.includes("{")) continue;

    const body = extractFunctionBody(lines, i);
    const triggers = extractReactiveFromBody(body, "target_mitigation");
    results.push(...triggers);
    break;
  }

  return results;
}

function extractReactiveFromBody(body, source) {
  const results = [];

  // Find active.X->execute patterns (reactive damage procs)
  const activePattern = /active\.(\w+)->(?:execute|set_target)/g;
  let match;
  while ((match = activePattern.exec(body)) !== null) {
    const surrounding = body.substring(
      Math.max(0, match.index - 200),
      match.index + 100,
    );
    const conditions = [];
    const buffCheck = surrounding.match(/buff\.(\w+)->check\(\)/g);
    if (buffCheck)
      conditions.push(...buffCheck.map((b) => b.replace("->check()", "")));
    const schoolCheck = surrounding.match(
      /(?:is_school|get_school_mask).*?SCHOOL_(\w+)/,
    );
    if (schoolCheck) conditions.push(`school:${schoolCheck[1]}`);

    results.push({
      source,
      trigger: match[1],
      type: "reactive_proc",
      conditions,
    });
  }

  // Find talent/spec effectN percent patterns (mitigation)
  const mitigationPattern =
    /(?:talent\.\w+\.(\w+)|spec\.(\w+)|buff\.(\w+))->(?:effectN\(\s*\d+\s*\)\.percent\(\)|check_value\(\)|value\(\))/g;
  while ((match = mitigationPattern.exec(body)) !== null) {
    const name = match[1] || match[2] || match[3];
    const surrounding = body.substring(
      Math.max(0, match.index - 300),
      match.index + 50,
    );
    const conditions = [];
    const schoolCheck = surrounding.match(
      /(?:SCHOOL_MAGIC_MASK|SCHOOL_MASK_PHYSICAL|get_school_mask|is_school)/,
    );
    if (schoolCheck) conditions.push(`school_conditional`);

    results.push({
      source,
      trigger: name,
      type: "mitigation_modifier",
      conditions,
    });
  }

  return results;
}

function findEnclosingContext(lines, lineNum) {
  const structPattern = /^struct (\w+)\s*(?:final\s*)?:\s*public/;
  const funcPattern =
    /^(?:void|double|bool)\s+(?:demon_hunter_t|demon_hunter_td_t)::(\w+)/;

  for (let i = lineNum; i >= 0; i--) {
    const structMatch = lines[i].match(structPattern);
    if (structMatch) return { name: structMatch[1], type: "struct" };
    const funcMatch = lines[i].match(funcPattern);
    if (funcMatch) return { name: funcMatch[1], type: "member_function" };
  }
  return { name: "unknown", type: "unknown" };
}

function extractFullCall(lines, startLine, funcName) {
  let depth = 0;
  let started = false;
  let result = "";
  for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
    for (const ch of lines[i]) {
      if (ch === "(") {
        if (!started && result.includes(funcName)) started = true;
        if (started) depth++;
      }
      if (started) result += ch;
      else if (lines[i].includes(funcName)) result += ch;
      if (ch === ")" && started) {
        depth--;
        if (depth === 0) return result;
      }
    }
    if (!started) result = "";
    else result += " ";
  }
  return result;
}

function extractFunctionBody(lines, startLine) {
  let depth = 0;
  let started = false;
  let body = "";
  for (let i = startLine; i < Math.min(startLine + 100, lines.length); i++) {
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

function extractTalentChecks(body) {
  const results = [];
  const pattern = /talent\.(\w+)\.(\w+)->(?:ok\(\)|effectN)/g;
  let match;
  const seen = new Set();
  while ((match = pattern.exec(body)) !== null) {
    const key = `${match[1]}.${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ tree: match[1], talent: match[2] });
  }
  return results;
}

function extractBuffChecks(body) {
  const results = [];
  const pattern = /buff\.(\w+)->(?:check|value|up|effectN)/g;
  let match;
  const seen = new Set();
  while ((match = pattern.exec(body)) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    results.push(match[1]);
  }
  return results;
}

extractEffectsInventory();
