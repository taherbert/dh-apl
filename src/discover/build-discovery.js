// Build discovery pipeline: generate DoE builds, sim via profilesets, analyze
// factor impacts, discover archetypes from talent impact analysis.
//
// Usage: node src/discover/build-discovery.js [--quick|--confirm] [--{branch}-only]

import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { cpus } from "node:os";

import { generateCombos, buildToHash } from "../model/talent-combos.js";
import { generateProfileset, runProfilesetAsync } from "../sim/profilesets.js";
import { SCENARIOS } from "../sim/runner.js";
import {
  HERO_SUBTREES,
  config,
  initSpec,
  getSpecAdapter,
  SCENARIO_WEIGHTS,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { dataFile, resultsDir, resultsFile, aplsDir } from "../engine/paths.js";
import {
  upsertBuild,
  upsertArchetype,
  upsertFactor,
  upsertSynergy,
  withTransaction,
} from "../util/db.js";

const WEIGHTS = SCENARIO_WEIGHTS;

const FIDELITY = {
  quick: { target_error: 1.0, label: "quick" },
  standard: { target_error: 0.5, label: "standard" },
  confirm: { target_error: 0.2, label: "confirm" },
};

// --- Helpers ---

function injectFallbackTalents(profileContent, fallbackHash) {
  if (!fallbackHash || profileContent.match(/^\s*talents\s*=/m)) {
    return profileContent;
  }
  // Midnight SimC crashes on talent-less actors. Inject first build's hash
  // before actions to prevent segfault. Profileset variants override this.
  return profileContent.replace(
    /^(actions\.precombat)/m,
    `talents=${fallbackHash}\n\n$1`,
  );
}

// --- Step 1: Generate builds and encode hashes ---

function generateBuilds(opts = {}) {
  const data = JSON.parse(
    readFileSync(dataFile("raidbots-talents.json"), "utf8"),
  );
  const result = generateCombos(opts.comboOpts);
  let builds = [...result.builds.filter((b) => b.valid)];

  // Include pinned builds
  if (result.pinnedBuilds) {
    builds.push(...result.pinnedBuilds.filter((b) => b.valid));
  }

  // Filter by hero tree — use displayName from spec config
  if (opts.heroTreeFilter) {
    const treeConfig =
      getSpecAdapter().getSpecConfig().heroTrees[opts.heroTreeFilter];
    const filterName = treeConfig?.displayName || opts.heroTreeFilter;
    builds = builds.filter((b) => b.heroTree === filterName);
  }

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
  const totalCores = cpus().length;
  const threadsPerScenario = Math.max(
    1,
    Math.floor(totalCores / scenarios.length),
  );
  const simOverrides = {
    target_error: fidelity.target_error,
    threads: threadsPerScenario,
  };

  // Run scenarios in parallel, splitting threads across them
  const promises = scenarios.map(async (scenario) => {
    const content = injectFallbackTalents(
      generateProfileset(aplPath, variants),
      builds[0]?.hash,
    );
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
// Discovers archetypes PER hero tree independently. Each tree gets its own
// forming factors based on adoption rates within that tree's builds, preventing
// one tree's dominant factors from collapsing the other tree into a single archetype.

function discoverArchetypes(
  builds,
  factorImpacts,
  synergyPairs,
  meanDPS,
  data,
) {
  const MAX_FORMING_FACTORS = 4;
  const threshold = meanDPS * 0.005;
  const mergeThreshold = meanDPS * 0.01;

  function hasFactor(build, fi) {
    if (fi.factorType === "choice") {
      return (build.specChoices?.[fi.nodeId] || 0) > 0;
    }
    if (fi.factorType === "multi_rank_r2") {
      return (build.specRanks?.[fi.nodeId] || 0) >= 2;
    }
    if (fi.factorType === "multi_rank_r1") {
      return (build.specRanks?.[fi.nodeId] || 0) >= 1;
    }
    return build.specNodes?.includes(fi.nodeId);
  }

  function computeFormingFactors(
    treeBuilds,
    factorImpacts,
    synergyPairs,
    threshold,
    hasFactor,
  ) {
    const sorted = [...treeBuilds].sort((a, b) => b.weighted - a.weighted);
    const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2));

    const candidateFactors = factorImpacts
      .filter((fi) => Math.abs(fi.mainEffect) > threshold)
      .map((fi) => ({
        ...fi,
        topAdoption:
          topHalf.filter((b) => hasFactor(b, fi)).length / topHalf.length,
      }))
      .filter((fi) => fi.topAdoption >= 0.15 && fi.topAdoption <= 0.85)
      .sort((a, b) => Math.abs(b.mainEffect) - Math.abs(a.mainEffect));

    const seenTalents = new Set();
    const dedupedFactors = candidateFactors.filter((fi) => {
      if (seenTalents.has(fi.talent)) return false;
      seenTalents.add(fi.talent);
      return true;
    });

    const formingFactorNames = new Set(
      dedupedFactors.slice(0, MAX_FORMING_FACTORS).map((f) => f.talent),
    );

    for (const sp of synergyPairs) {
      if (formingFactorNames.size >= MAX_FORMING_FACTORS) break;
      const combined =
        Math.abs(sp.interaction) +
        Math.abs(
          factorImpacts.find((f) => f.talent === sp.talents[0])?.mainEffect ||
            0,
        ) +
        Math.abs(
          factorImpacts.find((f) => f.talent === sp.talents[1])?.mainEffect ||
            0,
        );
      if (combined > threshold) {
        for (const t of sp.talents) {
          const fi = dedupedFactors.find((f) => f.talent === t);
          if (fi && formingFactorNames.size < MAX_FORMING_FACTORS) {
            formingFactorNames.add(t);
          }
        }
      }
    }

    const formingFactorSeen = new Set();
    return factorImpacts.filter((f) => {
      if (!formingFactorNames.has(f.talent) || formingFactorSeen.has(f.talent))
        return false;
      formingFactorSeen.add(f.talent);
      return true;
    });
  }

  function createFallbackArchetype(treeName, treeBuilds, allBuilds, data) {
    treeBuilds.sort((a, b) => b.weighted - a.weighted);
    return formatArchetype(
      {
        heroTree: treeName,
        definingTalents: [],
        bestBuild: treeBuilds[0],
        builds: treeBuilds,
        avgWeighted:
          treeBuilds.reduce((s, b) => s + b.weighted, 0) / treeBuilds.length,
        count: treeBuilds.length,
      },
      allBuilds,
      data,
    );
  }

  // Split builds by hero tree
  const byTree = {};
  for (const b of builds) {
    const tree = b.heroTree.toLowerCase().replace(/\s+/g, "_");
    (byTree[tree] ||= []).push(b);
  }

  // Discover archetypes within each hero tree independently
  const allArchetypes = [];
  for (const [treeName, treeBuilds] of Object.entries(byTree)) {
    const formingFactors = computeFormingFactors(
      treeBuilds,
      factorImpacts,
      synergyPairs,
      threshold,
      hasFactor,
    );

    if (formingFactors.length === 0) {
      allArchetypes.push(
        createFallbackArchetype(treeName, treeBuilds, builds, data),
      );
      console.log(`  ${treeName}: 0 forming factors → 1 archetype (fallback)`);
      continue;
    }

    console.log(
      `  ${treeName}: ${formingFactors.length} forming factors: ${formingFactors.map((f) => f.talent).join(", ")}`,
    );

    function buildSignature(build) {
      return formingFactors
        .map((f) => {
          if (f.factorType === "choice") {
            return build.specChoices?.[f.nodeId] || 0;
          }
          if (f.factorType === "multi_rank_r2") {
            return (build.specRanks?.[f.nodeId] || 0) >= 2 ? 1 : 0;
          }
          if (f.factorType === "multi_rank_r1") {
            return (build.specRanks?.[f.nodeId] || 0) >= 1 ? 1 : 0;
          }
          return build.specNodes?.includes(f.nodeId) ? 1 : 0;
        })
        .join(",");
    }

    // Group builds by signature within this tree
    const groups = new Map();
    for (const build of treeBuilds) {
      const key = `${treeName}|${buildSignature(build)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(build);
    }

    let archetypes = [];
    for (const [key, groupBuilds] of groups) {
      const sig = key.split("|")[1].split(",").map(Number);
      groupBuilds.sort((a, b) => b.weighted - a.weighted);

      const definingTalents = formingFactors
        .filter((_, i) => sig[i] === 1)
        .map((f) => f.talent);

      archetypes.push({
        heroTree: treeName,
        definingTalents,
        signature: key,
        bestBuild: groupBuilds[0],
        builds: groupBuilds,
        avgWeighted:
          groupBuilds.reduce((s, b) => s + b.weighted, 0) / groupBuilds.length,
        count: groupBuilds.length,
      });
    }

    // Merge close archetypes within this tree
    archetypes.sort((a, b) => b.avgWeighted - a.avgWeighted);

    function sigDistance(a, b) {
      const aSig = a.signature.split("|")[1].split(",");
      const bSig = b.signature.split("|")[1].split(",");
      let diff = 0;
      for (let k = 0; k < aSig.length; k++) {
        if (aSig[k] !== bSig[k]) diff++;
      }
      return diff;
    }

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
          Math.abs(base.avgWeighted - candidate.avgWeighted) < mergeThreshold &&
          sigDistance(base, candidate) <= 1
        ) {
          mergeGroup.push(candidate);
          consumed.add(j);
        }
      }

      const mergedBuilds = mergeGroup.flatMap((a) => a.builds);
      mergedBuilds.sort((a, b) => b.weighted - a.weighted);

      merged.push({
        heroTree: base.heroTree,
        definingTalents: base.definingTalents,
        bestBuild: mergedBuilds[0],
        builds: mergedBuilds,
        avgWeighted:
          mergedBuilds.reduce((s, b) => s + b.weighted, 0) /
          mergedBuilds.length,
        count: mergedBuilds.length,
      });
    }

    console.log(
      `  ${treeName}: ${groups.size} raw → ${merged.length} after merge`,
    );
    for (const arch of merged) {
      const formatted = formatArchetype(arch, builds, data);
      // Tag all builds in this archetype for DB persistence
      for (const b of arch.builds) {
        b.archetype = formatted.name;
      }
      allArchetypes.push(formatted);
    }
  }

  return allArchetypes;
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
  // Prefix with hero tree to prevent DB collisions when different trees share
  // the same forming factors (e.g., both AR and Anni have "Down in Flames")
  const treeLabel = arch.heroTree.replace(/_/g, " ");
  const talentPart =
    arch.definingTalents.length > 0 ? arch.definingTalents.join(" + ") : "base";
  const name = `${treeLabel}: ${talentPart}`;

  const globalBest = allBuilds[0];
  const best = arch.bestBuild;
  const specDifferences = computeSpecDifferences(best, globalBest, data);

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
  for (const n of data.specNodes) {
    specNodeMap.set(n.id, n);
  }

  const diffs = [];
  for (const id of buildNodes) {
    if (!refNodes.has(id)) {
      const node = specNodeMap.get(id);
      if (node) {
        diffs.push(`+${node.name}`);
      }
    }
  }
  for (const id of refNodes) {
    if (!buildNodes.has(id)) {
      const node = specNodeMap.get(id);
      if (node) {
        diffs.push(`-${node.name}`);
      }
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
    discoveredArchetypes: archetypes,
    allBuilds: builds.map((b) => ({
      name: b.name,
      hash: b.hash,
      heroTree: (b.heroTree || "").toLowerCase().replace(/\s+/g, "_"),
      dps: b.dps,
      weighted: Math.round(b.weighted),
      rank: b.rank,
      pinned: b.pinned || false,
      archetype: b.archetype || null,
    })),
  };
}

function printSummary(output) {
  console.log("\n" + "=".repeat(60));
  console.log("BUILD DISCOVERY RESULTS");
  console.log("=".repeat(60));

  console.log(`\nFidelity: ${output.fidelity}`);
  console.log(`Builds tested: ${output.allBuilds.length}`);
  console.log(`Archetypes found: ${output.discoveredArchetypes.length}`);

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
  for (const arch of output.discoveredArchetypes) {
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

  const aplPath =
    opts.aplPath || join(aplsDir(), `${config.spec.specName}.simc`);

  console.log("Step 1: Generating talent builds...");
  const { builds, factors, design, data } = generateBuilds({
    heroTreeFilter: opts.heroTreeFilter,
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

  mkdirSync(resultsDir(), { recursive: true });

  // Write discovery results to unified DB
  const runId = output._generated;
  try {
    withTransaction(() => {
      for (const b of output.allBuilds) {
        if (!b.hash) continue;
        upsertBuild({
          hash: b.hash,
          name: b.name,
          heroTree: b.heroTree,
          source: "doe",
          dps_st: b.dps?.st,
          dps_small_aoe: b.dps?.small_aoe,
          dps_big_aoe: b.dps?.big_aoe,
          weighted: b.weighted,
          rank: b.rank,
          archetype: b.archetype,
        });
      }
      for (const fi of output.factorImpacts) {
        upsertFactor(
          {
            talent: fi.talent,
            nodeId: fi.nodeId,
            factorType: fi.type,
            mainEffect: fi.mainEffect,
            pct: fi.pct,
          },
          runId,
        );
      }
      for (const arch of output.discoveredArchetypes) {
        upsertArchetype({
          name: arch.name,
          heroTree: arch.heroTree,
          definingTalents: arch.definingTalents,
          description: arch.description,
          coreLoop: arch.coreLoop,
          bestBuildHash: arch.bestBuild?.hash,
          buildCount: arch.buildCount,
        });
      }
      for (const sp of output.synergyPairs) {
        if (sp.talents?.length >= 2) {
          upsertSynergy(sp.talents[0], sp.talents[1], sp.interaction, runId);
        }
      }
    });
    console.log(`  Synced to theorycraft.db`);
  } catch (e) {
    console.warn(`  DB sync warning: ${e.message}`);
  }

  // Auto-import new discoveries into persistent build roster
  try {
    const { importFromDoe } = await import("../sim/build-roster.js");
    const rosterResult = importFromDoe();
    console.log(
      `  Roster: ${rosterResult.added} added, ${rosterResult.skipped} existing`,
    );
  } catch {
    // Roster import is optional — may fail if roster not yet initialized
  }

  printSummary(output);

  return output;
}

// --- CLI ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  // Derive hero tree CLI flags from adapter
  await initSpec(parseSpecArg());
  const heroTrees = getSpecAdapter().getSpecConfig().heroTrees;
  let heroTreeFilter = null;
  for (const [treeName, treeData] of Object.entries(heroTrees)) {
    if (args.includes(`--${treeData.aplBranch}-only`)) {
      heroTreeFilter = treeName;
      break;
    }
  }
  const opts = {
    quick: args.includes("--quick"),
    confirm: args.includes("--confirm"),
    heroTreeFilter,
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
