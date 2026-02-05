// Extracts talent cross-references from simc C++ source.
// Three scan types:
// 1. Talent↔talent: multiple talent references in same struct/function
// 2. Talent→ability: talent reference inside an ability's action struct
// 3. Effect scan: talent->ok() gating buff triggers or action procs

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIMC_DH_CPP,
  loadSpecAdapter,
  getSpecAdapter,
} from "../engine/startup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const DATA_DIR = join(ROOT, "data");
const REF_DIR = join(ROOT, "reference");

let _structToAbility = null;

export function extractCppInteractions(preloadedSource) {
  const adapter = getSpecAdapter();
  _structToAbility = adapter.getStructToAbilityMap();

  const src = preloadedSource || readFileSync(SIMC_DH_CPP, "utf-8");
  const lines = src.split("\n");

  const talentVars = JSON.parse(
    readFileSync(join(REF_DIR, "simc-talent-variables.json"), "utf-8"),
  );

  const varToName = new Map();
  for (const [tree, entries] of Object.entries(talentVars)) {
    for (const e of entries) {
      varToName.set(`${tree}.${e.variable}`, e.spellName);
    }
  }

  const contexts = findContexts(lines);
  const talentRefPattern = adapter.getTalentTreePattern();

  const talentTalent = [];
  const talentAbility = [];
  const seenTT = new Set();
  const seenTA = new Set();

  for (const ctx of contexts) {
    const contextTalentRefs = new Set();

    for (let i = ctx.start; i <= ctx.end && i < lines.length; i++) {
      let match;
      talentRefPattern.lastIndex = 0;
      while ((match = talentRefPattern.exec(lines[i])) !== null) {
        contextTalentRefs.add(`${match[1]}.${match[2]}`);
      }
    }

    const refs = [...contextTalentRefs];

    // Scan 1: Talent↔talent cross-references
    if (refs.length >= 2) {
      const contextAbility = parseContextAbility(ctx.name);
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) {
          const key = [refs[i], refs[j]].sort().join("|");
          if (seenTT.has(key)) continue;
          seenTT.add(key);

          talentTalent.push({
            source: varToName.get(refs[i]) || refs[i],
            sourceVar: refs[i],
            target: varToName.get(refs[j]) || refs[j],
            targetVar: refs[j],
            context: ctx.name,
            contextAbility,
            type: inferType(ctx, lines),
            mechanism: inferMechanism(ctx, lines),
            discoveryMethod: "cpp_scanner",
            confidence: "medium",
          });
        }
      }
    }

    // Scan 2: Talent→ability (talent referenced inside an ability struct)
    if (refs.length >= 1 && ctx.type === "struct") {
      const abilityName = resolveAbility(ctx.name);
      if (abilityName) {
        for (const ref of refs) {
          const talentName = varToName.get(ref) || ref;
          if (talentName === abilityName) continue; // talent referencing itself
          const key = `${talentName}|${abilityName}`;
          if (seenTA.has(key)) continue;
          seenTA.add(key);

          talentAbility.push({
            source: talentName,
            sourceVar: ref,
            target: abilityName,
            context: ctx.name,
            type: inferType(ctx, lines),
            mechanism: inferMechanism(ctx, lines),
            discoveryMethod: "cpp_scanner",
            confidence: "medium",
          });
        }
      }
    }
  }

  // Scan 3: Effect scan (talent->ok() gating buffs/actions)
  const effectScans = scanTalentEffects(lines, varToName);

  const output = {
    talentTalent,
    talentAbility,
    effectScans,
    scanStats: {
      contextsScanned: contexts.length,
      talentCrossRefs: talentTalent.length,
      talentAbilityRefs: talentAbility.length,
      effectScans: effectScans.length,
    },
  };

  writeFileSync(
    join(DATA_DIR, "cpp-interactions.json"),
    JSON.stringify(output, null, 2),
  );

  console.log("Wrote data/cpp-interactions.json");
  console.log(`  ${contexts.length} C++ contexts scanned`);
  console.log(`  ${talentTalent.length} talent↔talent cross-references`);
  console.log(`  ${talentAbility.length} talent→ability references`);
  console.log(`  ${effectScans.length} effect scans`);

  validateAgainstSeedList(talentAbility);
}

function findContexts(lines) {
  const contexts = [];
  const structPattern = /^struct (\w+)\s*(?:final\s*)?:\s*public/;
  let currentStruct = null;
  let braceDepth = 0;
  let trackingBraces = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const structMatch = line.match(structPattern);
    if (structMatch) {
      currentStruct = {
        name: structMatch[1],
        start: i,
        end: i,
        type: "struct",
      };
      contexts.push(currentStruct);
      braceDepth = 0;
      trackingBraces = true;
    }

    if (trackingBraces) {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") {
          braceDepth--;
          if (braceDepth <= 0 && currentStruct) {
            currentStruct.end = i;
            currentStruct = null;
            trackingBraces = false;
            break;
          }
        }
      }
    }
  }

  return contexts;
}

function resolveAbility(structName) {
  // Strip _t suffix and known suffixes
  const base = structName
    .replace(/_t$/, "")
    .replace(/_damage$/, "")
    .replace(/_initial$/, "");

  if (_structToAbility[base]) return _structToAbility[base];

  // Try without trigger suffixes for talent-named structs
  const noTrigger = base.replace(/_trigger$/, "");
  if (_structToAbility[noTrigger]) return _structToAbility[noTrigger];

  return null;
}

function parseContextAbility(name) {
  return name
    .replace(/_t$/, "")
    .replace(/_trigger$/, "")
    .replace(/_heal$/, "")
    .replace(/_damage$/, "");
}

function inferType(ctx, lines) {
  const block = lines
    .slice(ctx.start, Math.min(ctx.start + 50, ctx.end + 1))
    .join("\n")
    .toLowerCase();

  if (block.includes("cooldown") || block.includes("recharge"))
    return "cooldown_modifier";
  if (block.includes("extend_duration") || block.includes("duration"))
    return "duration_modifier";
  if (
    block.includes("multiplier") ||
    block.includes("composite_target_multiplier") ||
    block.includes("action_multiplier")
  )
    return "damage_modifier";
  if (block.includes("cost") || block.includes("energize"))
    return "resource_modifier";
  if (block.includes("trigger") || block.includes("proc"))
    return "proc_trigger";
  if (block.includes("buff") || block.includes("absorb")) return "buff_grant";
  return "mechanic_change";
}

function inferMechanism(ctx, lines) {
  const name = ctx.name.toLowerCase();
  if (name.includes("impact")) return "on_impact";
  if (name.includes("tick")) return "on_tick";
  if (name.includes("execute")) return "on_execute";
  if (name.includes("composite")) return "passive_modifier";

  const block = lines
    .slice(ctx.start, Math.min(ctx.start + 20, ctx.end + 1))
    .join(" ");
  if (block.includes("consume_soul")) return "on_soul_consume";
  if (block.includes("impact")) return "on_impact";
  if (block.includes("tick")) return "on_tick";
  return "conditional";
}

function scanTalentEffects(lines, varToName) {
  const results = [];
  const seen = new Set();

  // Build ok() pattern from the same talent tree pattern
  const adapter = getSpecAdapter();
  const basePattern = adapter.getTalentTreePattern();
  const patternSource = basePattern.source.replace(/\)$/, ")->ok\\(\\)");
  const pattern = new RegExp(patternSource, "g");
  const buffPattern =
    /buff\.(\w+)->trigger|buff\.(\w+)->extend_duration|buff\.(\w+)->increment/;

  for (let i = 0; i < lines.length; i++) {
    let match;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(lines[i])) !== null) {
      const talentVar = `${match[1]}.${match[2]}`;
      const talentName = varToName.get(talentVar) || match[2];

      const window = lines
        .slice(Math.max(0, i), Math.min(lines.length, i + 8))
        .join("\n");

      const buffMatch = window.match(buffPattern);
      if (buffMatch) {
        const buff = buffMatch[1] || buffMatch[2] || buffMatch[3];
        const key = `${talentName}|buff:${buff}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            talent: talentName,
            talentVar,
            target: `buff:${buff}`,
            type: "buff_grant",
            mechanism: "talent_gates_buff",
            discoveryMethod: "effect_scan",
            confidence: "medium",
          });
        }
      }
    }
  }

  return results;
}

function validateAgainstSeedList(talentAbilityRefs) {
  const adapter = getSpecAdapter();
  const seedList = adapter.getCppScannerSeedList?.() || [];
  if (seedList.length === 0) return;

  const foundPairs = new Set(
    talentAbilityRefs.map((f) => `${f.source}|${f.target}`),
  );

  let matched = 0;
  const missing = [];
  for (const [a, b] of seedList) {
    if (foundPairs.has(`${a}|${b}`)) {
      matched++;
    } else {
      missing.push(`${a} → ${b}`);
    }
  }

  console.log(`\n  Seed list validation: ${matched}/${seedList.length} found`);
  if (missing.length > 0) {
    console.log(`  Missing: ${missing.join(", ")}`);
  }
}

loadSpecAdapter().then(() => extractCppInteractions());
