// Cross-references cpp-effects-inventory.json against interactions.json to find
// gaps in coverage: effects declared in C++ but missing from the interaction model.

import { readFileSync, existsSync } from "node:fs";
import "../engine/startup.js";
import { dataFile } from "../engine/paths.js";

function runGapReport() {
  const inventoryPath = dataFile("cpp-effects-inventory.json");
  if (!existsSync(inventoryPath)) {
    console.log(
      "No cpp-effects-inventory.json found. Run: npm run cpp-effects",
    );
    process.exit(1);
  }

  const inventory = JSON.parse(readFileSync(inventoryPath, "utf-8"));
  const interactions = JSON.parse(
    readFileSync(dataFile("interactions.json"), "utf-8"),
  );

  // Build lookup sets from interactions
  const interactionBuffNames = new Set();
  const interactionSourceNames = new Set();
  for (const i of interactions.interactions) {
    interactionSourceNames.add(i.source.name.toLowerCase());
    if (i.target?.name) interactionSourceNames.add(i.target.name.toLowerCase());
  }

  // Also index by C++ buff name patterns
  const normalizedInteractions = new Set();
  for (const i of interactions.interactions) {
    normalizedInteractions.add(normalizeName(i.source.name));
    if (i.target?.name)
      normalizedInteractions.add(normalizeName(i.target.name));
  }

  console.log("=== Effects Gap Report ===\n");

  // 1. parse_effects coverage
  const peResults = checkParseEffects(
    inventory.parseEffects,
    normalizedInteractions,
  );

  // 2. parse_target_effects coverage
  const pteResults = checkParseTargetEffects(
    inventory.parseTargetEffects,
    normalizedInteractions,
  );

  // 3. composite_* override coverage
  const coResults = checkCompositeOverrides(
    inventory.compositeOverrides,
    normalizedInteractions,
  );

  // 4. reactive triggers coverage
  const rtResults = checkReactiveTriggers(
    inventory.reactiveTriggers,
    normalizedInteractions,
  );

  // Summary
  const allResults = [...peResults, ...pteResults, ...coResults, ...rtResults];
  const covered = allResults.filter((r) => r.status === "covered").length;
  const partial = allResults.filter((r) => r.status === "partial").length;
  const missing = allResults.filter((r) => r.status === "missing").length;
  const total = allResults.length;

  console.log("\n=== Summary ===\n");
  console.log(`  Total C++ effects: ${total}`);
  console.log(
    `  Covered: ${covered} (${total ? ((covered / total) * 100).toFixed(1) : 0}%)`,
  );
  console.log(
    `  Partial: ${partial} (${total ? ((partial / total) * 100).toFixed(1) : 0}%)`,
  );
  console.log(
    `  Missing: ${missing} (${total ? ((missing / total) * 100).toFixed(1) : 0}%)`,
  );

  if (missing > 0) {
    console.log("\n  Missing effects:");
    for (const r of allResults.filter((r) => r.status === "missing")) {
      console.log(`    ${r.source}: ${r.name} (${r.type})`);
    }
  }

  // Enrichment coverage
  const withMagnitude = interactions.interactions.filter(
    (i) => i.magnitude,
  ).length;
  const withApplication = interactions.interactions.filter(
    (i) => i.application,
  ).length;
  const withEffectDetails = interactions.interactions.filter(
    (i) => i.effectDetails,
  ).length;
  const withCategories = interactions.interactions.filter(
    (i) => i.categories,
  ).length;
  const iTotal = interactions.interactions.length;

  console.log("\n=== Enrichment Coverage ===\n");
  console.log(
    `  magnitude: ${withMagnitude}/${iTotal} (${((withMagnitude / iTotal) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  application: ${withApplication}/${iTotal} (${((withApplication / iTotal) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  effectDetails: ${withEffectDetails}/${iTotal} (${((withEffectDetails / iTotal) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  categories: ${withCategories}/${iTotal} (${((withCategories / iTotal) * 100).toFixed(1)}%)`,
  );

  return { covered, partial, missing, total };
}

function checkParseEffects(parseEffects, normalizedInteractions) {
  console.log(`parse_effects: ${parseEffects.length} calls\n`);
  const results = [];
  for (const pe of parseEffects) {
    const name = pe.buff;
    const normalized = normalizeName(name);
    const status = normalizedInteractions.has(normalized)
      ? "covered"
      : "missing";
    const label = status === "covered" ? "✓" : "✗";
    console.log(`  ${label} ${name} (${pe.context})`);
    results.push({ name, type: "parse_effects", source: pe.context, status });
  }
  return results;
}

function checkParseTargetEffects(parseTargetEffects, normalizedInteractions) {
  console.log(`\nparse_target_effects: ${parseTargetEffects.length} calls\n`);
  const results = [];
  for (const pte of parseTargetEffects) {
    const name = pte.debuff;
    const normalized = normalizeName(name);
    const status = normalizedInteractions.has(normalized)
      ? "covered"
      : "missing";
    const label = status === "covered" ? "✓" : "✗";
    console.log(`  ${label} ${name} (${pte.targetType})`);
    results.push({
      name,
      type: "parse_target_effects",
      source: pte.targetType,
      status,
    });
  }
  return results;
}

function checkCompositeOverrides(compositeOverrides, normalizedInteractions) {
  console.log(`\ncomposite_* overrides: ${compositeOverrides.length}\n`);
  const results = [];
  for (const co of compositeOverrides) {
    const talents = co.talentChecks.map((t) => t.talent);
    const buffs = co.buffChecks;
    const allRefs = [...talents, ...buffs];
    const coveredRefs = allRefs.filter((r) =>
      normalizedInteractions.has(normalizeName(r)),
    );
    const status =
      coveredRefs.length === allRefs.length
        ? "covered"
        : coveredRefs.length > 0
          ? "partial"
          : "missing";
    const label = status === "covered" ? "✓" : status === "partial" ? "~" : "✗";
    console.log(
      `  ${label} ${co.function} in ${co.context} [${allRefs.join(", ")}]`,
    );
    results.push({
      name: `${co.function}:${co.context}`,
      type: "composite_override",
      source: co.context,
      status,
      refs: allRefs,
      coveredRefs,
    });
  }
  return results;
}

function checkReactiveTriggers(reactiveTriggers, normalizedInteractions) {
  console.log(`\nreactive triggers: ${reactiveTriggers.length}\n`);
  const results = [];
  const seen = new Set();
  for (const rt of reactiveTriggers) {
    const key = `${rt.source}:${rt.trigger}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const normalized = normalizeName(rt.trigger);
    const status = normalizedInteractions.has(normalized)
      ? "covered"
      : "missing";
    const label = status === "covered" ? "✓" : "✗";
    console.log(
      `  ${label} ${rt.trigger} (${rt.source}, ${rt.type}) [${rt.conditions.join(", ")}]`,
    );
    results.push({
      name: rt.trigger,
      type: "reactive_trigger",
      source: rt.source,
      status,
    });
  }
  return results;
}

// Normalize C++ variable names to match spell names.
// E.g., "demon_soul" -> "demonsoul", "fiery_brand" -> "fierybrand"
function normalizeName(name) {
  return (name || "").toLowerCase().replace(/_/g, "").replace(/\s+/g, "");
}

const result = runGapReport();
if (result.missing > 0) {
  console.log(`\n${result.missing} gaps found.`);
}
