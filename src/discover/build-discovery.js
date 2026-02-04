// Build discovery pipeline: generate DoE builds, sim via profilesets, analyze
// factor impacts, discover archetypes from talent impact analysis.
//
// Usage: node src/discover/build-discovery.js [--quick|--confirm] [--ar-only|--anni-only]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { generateCombos, buildToHash } from "../model/talent-combos.js";
import { generateProfileset, runProfilesetAsync } from "../sim/profilesets.js";
import { SCENARIOS } from "../sim/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DATA_DIR = join(ROOT, "data");
const RESULTS_DIR = join(ROOT, "results");

const WEIGHTS = { st: 0.5, small_aoe: 0.3, big_aoe: 0.2 };

const FIDELITY = {
  quick: { target_error: 1.0, label: "quick" },
  standard: { target_error: 0.5, label: "standard" },
  confirm: { target_error: 0.2, label: "confirm" },
};

// --- Step 1: Generate builds and encode hashes ---

function generateBuilds(opts = {}) {
  const data = JSON.parse(
    readFileSync(join(DATA_DIR, "raidbots-talents.json"), "utf8"),
  );
  const result = generateCombos(opts.comboOpts);
  let builds = [...result.builds.filter((b) => b.valid)];

  // Include pinned builds
  if (result.pinnedBuilds) {
    builds.push(...result.pinnedBuilds.filter((b) => b.valid));
  }

  // Filter by hero tree
  if (opts.arOnly)
    builds = builds.filter((b) => b.heroTree === "Aldrachi Reaver");
  if (opts.anniOnly)
    builds = builds.filter((b) => b.heroTree === "Annihilator");

  // Encode hashes and deduplicate
  const seen = new Set();
  const encoded = [];
  for (const build of builds) {
    try {
      const hash = buildToHash(build, data);
      if (seen.has(hash)) continue;
      seen.add(hash);
      encoded.push({ ...build, hash });
    } catch (e) {
      console.error(`  Hash encoding failed for ${build.name}: ${e.message}`);
    }
  }

  return {
    builds: encoded,
    factors: result.factors,
    design: result.design,
    data,
  };
}

// --- Step 2: Run profileset simulations ---

async function simBuilds(builds, aplPath, fidelity, data) {
  const scenarios = Object.keys(WEIGHTS);
  const variants = builds.map((b) => ({
    name: b.name,
    overrides: [`talents=${b.hash}`],
  }));

  console.log(
    `\nSimulating ${variants.length} builds across ${scenarios.length} scenarios (${fidelity.label})...`,
  );

  const results = {};
  const simOverrides = { target_error: fidelity.target_error };

  // Run scenarios in parallel
  const promises = scenarios.map(async (scenario) => {
    const content = generateProfileset(aplPath, variants);
    const result = await runProfilesetAsync(
      content,
      scenario,
      `discover_${scenario}`,
      { simOverrides },
    );
    results[scenario] = result;
  });

  await Promise.all(promises);
  return results;
}

// --- Step 3: Merge results and compute weighted DPS ---

function mergeResults(builds, simResults) {
  // Build DPS lookup: scenario → buildName → dps
  const dpsLookup = {};
  for (const [scenario, result] of Object.entries(simResults)) {
    dpsLookup[scenario] = {};
    // Baseline (the base profile) is the first build
    dpsLookup[scenario].__baseline__ = result.baseline.dps;
    for (const v of result.variants) {
      dpsLookup[scenario][v.name] = v.dps;
    }
  }

  // Merge into builds
  for (const build of builds) {
    build.dps = {};
    for (const scenario of Object.keys(WEIGHTS)) {
      build.dps[scenario] = dpsLookup[scenario]?.[build.name] || 0;
    }
    build.weighted = Object.entries(WEIGHTS).reduce(
      (sum, [s, w]) => sum + (build.dps[s] || 0) * w,
      0,
    );
  }

  // Sort by weighted DPS descending
  builds.sort((a, b) => b.weighted - a.weighted);

  // Assign ranks
  for (let i = 0; i < builds.length; i++) {
    builds[i].rank = i + 1;
  }

  return builds;
}

// --- Step 4: Factor impact analysis ---

function analyzeFactors(builds, factors) {
  const specFactors = factors.spec || [];
  if (specFactors.length === 0) return { factorImpacts: [], synergyPairs: [] };

  const meanDPS = builds.reduce((s, b) => s + b.weighted, 0) / builds.length;

  // Resolve each build's factor setting for each factor
  function getFactorValue(build, factor) {
    if (factor.type === "choice") {
      return build.specChoices?.[factor.nodeId] || 0;
    }
    if (factor.type === "multi_rank_r2") {
      return (build.specRanks?.[factor.nodeId] || 0) >= 2 ? 1 : 0;
    }
    if (factor.type === "multi_rank_r1") {
      return (build.specRanks?.[factor.nodeId] || 0) >= 1 ? 1 : 0;
    }
    return build.specNodes?.includes(factor.nodeId) ? 1 : 0;
  }

  // Main effects
  const factorImpacts = [];
  for (const factor of specFactors) {
    const on = builds.filter((b) => getFactorValue(b, factor) === 1);
    const off = builds.filter((b) => getFactorValue(b, factor) === 0);
    if (on.length === 0 || off.length === 0) continue;

    const avgOn = on.reduce((s, b) => s + b.weighted, 0) / on.length;
    const avgOff = off.reduce((s, b) => s + b.weighted, 0) / off.length;
    const mainEffect = avgOn - avgOff;
    const pct = meanDPS > 0 ? (mainEffect / meanDPS) * 100 : 0;

    factorImpacts.push({
      talent: factor.name.replace(/_r[12]$/, ""),
      nodeId: factor.nodeId,
      factorType: factor.type,
      mainEffect: Math.round(mainEffect),
      pct: +pct.toFixed(2),
    });
  }

  factorImpacts.sort((a, b) => Math.abs(b.mainEffect) - Math.abs(a.mainEffect));

  // 2-factor interactions
  const synergyPairs = [];
  for (let i = 0; i < specFactors.length; i++) {
    for (let j = i + 1; j < specFactors.length; j++) {
      const fA = specFactors[i];
      const fB = specFactors[j];

      // Group builds by (A, B) settings
      const groups = { "0,0": [], "0,1": [], "1,0": [], "1,1": [] };
      for (const build of builds) {
        const a = getFactorValue(build, fA);
        const b = getFactorValue(build, fB);
        groups[`${a},${b}`].push(build.weighted);
      }

      // Need all 4 cells populated
      if (Object.values(groups).some((g) => g.length === 0)) continue;

      const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
      const interaction =
        avg(groups["1,1"]) +
        avg(groups["0,0"]) -
        avg(groups["1,0"]) -
        avg(groups["0,1"]);
      const pct = meanDPS > 0 ? (interaction / meanDPS) * 100 : 0;

      if (Math.abs(pct) > 0.3) {
        synergyPairs.push({
          talents: [
            fA.name.replace(/_r[12]$/, ""),
            fB.name.replace(/_r[12]$/, ""),
          ],
          nodeIds: [fA.nodeId, fB.nodeId],
          interaction: Math.round(interaction),
          pct: +pct.toFixed(2),
        });
      }
    }
  }

  synergyPairs.sort(
    (a, b) => Math.abs(b.interaction) - Math.abs(a.interaction),
  );

  return { factorImpacts, synergyPairs, meanDPS: Math.round(meanDPS) };
}

// --- Step 5: Archetype discovery ---

function discoverArchetypes(
  builds,
  factorImpacts,
  synergyPairs,
  meanDPS,
  data,
) {
  // Identify archetype-forming factors: main effect > 0.5% of mean DPS,
  // or part of a synergy pair with combined effect > 0.5%
  const threshold = meanDPS * 0.005;
  const formingFactorNames = new Set();

  for (const fi of factorImpacts) {
    if (Math.abs(fi.mainEffect) > threshold) {
      formingFactorNames.add(fi.talent);
    }
  }
  for (const sp of synergyPairs) {
    const combined =
      Math.abs(sp.interaction) +
      Math.abs(
        factorImpacts.find((f) => f.talent === sp.talents[0])?.mainEffect || 0,
      ) +
      Math.abs(
        factorImpacts.find((f) => f.talent === sp.talents[1])?.mainEffect || 0,
      );
    if (combined > threshold) {
      for (const t of sp.talents) formingFactorNames.add(t);
    }
  }

  if (formingFactorNames.size === 0) {
    // No significant factors — all builds are essentially equivalent
    return groupByHeroTreeOnly(builds, data);
  }

  // Get forming factor impacts for quick lookup
  const formingFactors = factorImpacts.filter((f) =>
    formingFactorNames.has(f.talent),
  );

  // Build signature for each build: values of forming factors
  function buildSignature(build) {
    return formingFactors
      .map((f) => {
        if (f.factorType === "choice")
          return build.specChoices?.[f.nodeId] || 0;
        if (f.factorType === "multi_rank_r2")
          return (build.specRanks?.[f.nodeId] || 0) >= 2 ? 1 : 0;
        if (f.factorType === "multi_rank_r1")
          return (build.specRanks?.[f.nodeId] || 0) >= 1 ? 1 : 0;
        return build.specNodes?.includes(f.nodeId) ? 1 : 0;
      })
      .join(",");
  }

  // Group builds by hero tree + factor signature
  const groups = new Map();
  for (const build of builds) {
    const key = `${build.heroTree}|${buildSignature(build)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(build);
  }

  // Convert groups to archetypes
  let archetypes = [];
  for (const [key, groupBuilds] of groups) {
    const [heroTree] = key.split("|");
    const sig = key.split("|")[1].split(",").map(Number);

    // Sort builds within group by weighted DPS
    groupBuilds.sort((a, b) => b.weighted - a.weighted);
    const best = groupBuilds[0];

    // Determine defining talents (forming factors that are "on" for this archetype)
    const definingTalents = formingFactors
      .filter((_, i) => sig[i] === 1)
      .map((f) => f.talent);

    const avgWeighted =
      groupBuilds.reduce((s, b) => s + b.weighted, 0) / groupBuilds.length;

    archetypes.push({
      heroTree: heroTree.toLowerCase().replace(/\s+/g, "_"),
      definingTalents,
      signature: key,
      bestBuild: best,
      builds: groupBuilds,
      avgWeighted,
      count: groupBuilds.length,
    });
  }

  // Merge archetypes that differ by < 0.2% weighted DPS
  const mergeThreshold = meanDPS * 0.002;
  archetypes.sort((a, b) => b.avgWeighted - a.avgWeighted);

  const merged = [];
  const consumed = new Set();
  for (let i = 0; i < archetypes.length; i++) {
    if (consumed.has(i)) continue;
    const base = archetypes[i];
    const mergeGroup = [base];
    for (let j = i + 1; j < archetypes.length; j++) {
      if (consumed.has(j)) continue;
      const candidate = archetypes[j];
      if (
        base.heroTree === candidate.heroTree &&
        Math.abs(base.avgWeighted - candidate.avgWeighted) < mergeThreshold
      ) {
        mergeGroup.push(candidate);
        consumed.add(j);
      }
    }

    // Merge builds from all consumed archetypes
    const allBuilds = mergeGroup.flatMap((a) => a.builds);
    allBuilds.sort((a, b) => b.weighted - a.weighted);

    // Union defining talents
    const unionTalents = [
      ...new Set(mergeGroup.flatMap((a) => a.definingTalents)),
    ];

    merged.push({
      heroTree: base.heroTree,
      definingTalents: unionTalents,
      bestBuild: allBuilds[0],
      builds: allBuilds,
      avgWeighted:
        allBuilds.reduce((s, b) => s + b.weighted, 0) / allBuilds.length,
      count: allBuilds.length,
    });
  }

  // Generate labels and format output
  return merged.map((arch) => formatArchetype(arch, builds, data));
}

function groupByHeroTreeOnly(builds, data) {
  const byTree = {};
  for (const b of builds) {
    const tree = b.heroTree.toLowerCase().replace(/\s+/g, "_");
    (byTree[tree] ||= []).push(b);
  }
  return Object.entries(byTree).map(([tree, treeBuilds]) => {
    treeBuilds.sort((a, b) => b.weighted - a.weighted);
    return formatArchetype(
      {
        heroTree: tree,
        definingTalents: [],
        bestBuild: treeBuilds[0],
        builds: treeBuilds,
        avgWeighted:
          treeBuilds.reduce((s, b) => s + b.weighted, 0) / treeBuilds.length,
        count: treeBuilds.length,
      },
      builds,
      data,
    );
  });
}

function formatArchetype(arch, allBuilds, data) {
  const name =
    arch.definingTalents.length > 0
      ? arch.definingTalents.slice(0, 3).join(" + ")
      : arch.heroTree.replace(/_/g, " ");

  // Compute spec talent differences vs the global best build
  const globalBest = allBuilds[0];
  const best = arch.bestBuild;
  const specDifferences = computeSpecDifferences(best, globalBest, data);

  // Select up to 2 alternate builds
  const alternateBuilds = arch.builds
    .filter((b) => b !== best)
    .slice(0, 2)
    .map((b) => ({
      hash: b.hash,
      name: b.name,
      dps: b.dps,
      weighted: Math.round(b.weighted),
    }));

  return {
    name,
    heroTree: arch.heroTree,
    definingTalents: arch.definingTalents,
    bestBuild: {
      hash: best.hash,
      name: best.name,
      dps: best.dps,
      weighted: Math.round(best.weighted),
      talents: {
        spec: getSpecTalentNames(best, data),
        specDifferences,
      },
    },
    alternateBuilds,
    buildCount: arch.count,
  };
}

function getSpecTalentNames(build, data) {
  const specNodeMap = new Map();
  for (const n of data.specNodes) {
    specNodeMap.set(n.id, n);
  }
  return (build.specNodes || [])
    .map((id) => {
      const node = specNodeMap.get(id);
      if (!node) return null;
      if (node.type === "choice" && node.entries) {
        const choiceIdx = build.specChoices?.[id];
        if (choiceIdx !== undefined && node.entries[choiceIdx]) {
          return node.entries[choiceIdx].name;
        }
        return node.entries[0]?.name || node.name;
      }
      return node.name;
    })
    .filter(Boolean);
}

function computeSpecDifferences(build, reference, data) {
  const buildNodes = new Set(build.specNodes || []);
  const refNodes = new Set(reference.specNodes || []);
  const specNodeMap = new Map();
  for (const n of data.specNodes) specNodeMap.set(n.id, n);

  const diffs = [];
  for (const id of buildNodes) {
    if (!refNodes.has(id)) {
      const node = specNodeMap.get(id);
      if (node) diffs.push(`+${node.name}`);
    }
  }
  for (const id of refNodes) {
    if (!buildNodes.has(id)) {
      const node = specNodeMap.get(id);
      if (node) diffs.push(`-${node.name}`);
    }
  }
  return diffs;
}

// --- Step 6: Output ---

function buildOutput(
  builds,
  archetypes,
  factorImpacts,
  synergyPairs,
  aplPath,
  fidelity,
) {
  const aplContent = readFileSync(resolve(aplPath), "utf8");
  const aplHash = createHash("md5")
    .update(aplContent)
    .digest("hex")
    .slice(0, 8);

  return {
    _schema: "builds-v1",
    _generated: new Date().toISOString(),
    apl: {
      file: aplPath,
      hash: aplHash,
    },
    fidelity: fidelity.label,
    scenarios: Object.fromEntries(
      Object.entries(SCENARIOS).map(([k, v]) => [
        k,
        { targets: v.desiredTargets, duration: v.maxTime },
      ]),
    ),
    weights: WEIGHTS,
    factorImpacts: factorImpacts.slice(0, 20),
    synergyPairs: synergyPairs.slice(0, 10),
    archetypes,
    allBuilds: builds.map((b) => ({
      name: b.name,
      hash: b.hash,
      heroTree: (b.heroTree || "").toLowerCase().replace(/\s+/g, "_"),
      dps: b.dps,
      weighted: Math.round(b.weighted),
      rank: b.rank,
      pinned: b.pinned || false,
    })),
  };
}

function printSummary(output) {
  console.log("\n" + "=".repeat(60));
  console.log("BUILD DISCOVERY RESULTS");
  console.log("=".repeat(60));

  console.log(`\nFidelity: ${output.fidelity}`);
  console.log(`Builds tested: ${output.allBuilds.length}`);
  console.log(`Archetypes found: ${output.archetypes.length}`);

  // Top factor impacts
  if (output.factorImpacts.length > 0) {
    console.log("\nTop talent impacts:");
    for (const fi of output.factorImpacts.slice(0, 10)) {
      const sign = fi.mainEffect >= 0 ? "+" : "";
      console.log(
        `  ${fi.talent.padEnd(25)} ${sign}${fi.mainEffect.toLocaleString()} (${sign}${fi.pct}%)`,
      );
    }
  }

  // Synergy pairs
  if (output.synergyPairs.length > 0) {
    console.log("\nTalent synergies:");
    for (const sp of output.synergyPairs.slice(0, 5)) {
      const sign = sp.interaction >= 0 ? "+" : "";
      console.log(
        `  ${sp.talents.join(" × ").padEnd(40)} ${sign}${sp.interaction.toLocaleString()} (${sign}${sp.pct}%)`,
      );
    }
  }

  // Archetypes
  for (const arch of output.archetypes) {
    console.log(`\n--- ${arch.name} (${arch.heroTree}) ---`);
    console.log(
      `  Best: ${arch.bestBuild.name} — ${arch.bestBuild.weighted.toLocaleString()} weighted DPS`,
    );
    console.log(`  Hash: ${arch.bestBuild.hash.slice(0, 40)}...`);
    if (arch.bestBuild.talents.specDifferences.length > 0) {
      console.log(
        `  Differs: ${arch.bestBuild.talents.specDifferences.join(", ")}`,
      );
    }
    console.log(`  Builds in archetype: ${arch.buildCount}`);
  }

  // Top 5 overall
  console.log("\nTop 5 overall:");
  for (const b of output.allBuilds.slice(0, 5)) {
    console.log(
      `  #${b.rank} ${b.name.padEnd(50)} ${b.weighted.toLocaleString()} weighted`,
    );
  }
}

// --- Main pipeline ---

async function discover(opts = {}) {
  const fidelity = opts.confirm
    ? FIDELITY.confirm
    : opts.quick
      ? FIDELITY.quick
      : FIDELITY.standard;

  const aplPath = opts.aplPath || "apls/vengeance.simc";

  console.log("Step 1: Generating talent builds...");
  const { builds, factors, design, data } = generateBuilds({
    arOnly: opts.arOnly,
    anniOnly: opts.anniOnly,
    comboOpts: opts.comboOpts,
  });
  console.log(`  ${builds.length} unique builds (deduplicated by hash)`);

  console.log("\nStep 2: Running simulations...");
  const simResults = await simBuilds(builds, aplPath, fidelity, data);

  console.log("\nStep 3: Merging results...");
  mergeResults(builds, simResults);
  console.log(
    `  Top weighted: ${Math.round(builds[0]?.weighted || 0).toLocaleString()}`,
  );
  console.log(
    `  Bottom weighted: ${Math.round(builds[builds.length - 1]?.weighted || 0).toLocaleString()}`,
  );

  console.log("\nStep 4: Analyzing factor impacts...");
  const { factorImpacts, synergyPairs, meanDPS } = analyzeFactors(
    builds,
    factors,
  );
  console.log(
    `  ${factorImpacts.filter((f) => Math.abs(f.pct) > 0.5).length} significant factors (>0.5%)`,
  );
  console.log(`  ${synergyPairs.length} synergy pairs detected`);

  console.log("\nStep 5: Discovering archetypes...");
  const archetypes = discoverArchetypes(
    builds,
    factorImpacts,
    synergyPairs,
    meanDPS,
    data,
  );
  console.log(`  ${archetypes.length} archetypes discovered`);

  console.log("\nStep 6: Writing output...");
  const output = buildOutput(
    builds,
    archetypes,
    factorImpacts,
    synergyPairs,
    aplPath,
    fidelity,
  );

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, "builds.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`  Wrote ${outPath}`);

  printSummary(output);

  return output;
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opts = {
    quick: args.includes("--quick"),
    confirm: args.includes("--confirm"),
    arOnly: args.includes("--ar-only"),
    anniOnly: args.includes("--anni-only"),
  };

  // Optional APL path as positional arg
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length > 0) opts.aplPath = positional[0];

  discover(opts).catch((e) => {
    console.error(`\nDiscovery failed: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
}

export { discover, generateBuilds, analyzeFactors, discoverArchetypes };
