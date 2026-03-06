// Generates a self-contained HTML dashboard for VDH APL optimization results.
// Replaces showcase.js with a public-facing report covering build rankings,
// hero tree comparison, talent costs, and optimization history.
//
// Usage: node src/visualize/report.js [options]
//   --skip-sims           Generate from cached DB DPS only (no sims)
//   --fidelity <tier>     quick|standard|confirm (default: standard)

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  config,
  SCENARIOS,
  SCENARIO_WEIGHTS,
  FIDELITY_TIERS,
  initSpec,
  toTitleCase,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import {
  resultsDir,
  aplsDir,
  dataFile,
  getSpecName,
  ROOT,
} from "../engine/paths.js";
import { spawn } from "node:child_process";
import { loadRoster } from "../sim/build-roster.js";
import {
  generateRosterProfilesetContent,
  runProfilesetAsync,
  profilesetResultsToActorMap,
} from "../sim/profilesets.js";
import {
  getDb,
  getSessionState,
  getRosterBuilds,
  updateBuildDps,
  updateBuildSimcDps,
} from "../util/db.js";
import { generateDefensiveCostBuilds } from "../model/talent-combos.js";
import {
  decode as decodeTalentHash,
  loadFullNodeList,
} from "../util/talent-string.js";

// Severity tiers for defensive talent cost strips, ordered by threshold ascending.
// Thresholds are fractions of maxCost — resolved at render time via getSeverity().
const SEVERITY_TIERS = [
  { threshold: 0.33, cls: "light", color: "var(--positive)" },
  { threshold: 0.66, cls: "moderate", color: "var(--gold)" },
  { threshold: Infinity, cls: "heavy", color: "var(--negative)" },
];

// --- CLI ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { skipSims: false, fidelity: "standard" };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--skip-sims":
        opts.skipSims = true;
        break;
      case "--fidelity":
        opts.fidelity = args[++i];
        break;
    }
  }

  return opts;
}

// --- Sim execution (profileset mode) ---

async function runRosterSim(roster, aplPath, scenario, label, fidelityOpts) {
  const content = generateRosterProfilesetContent(roster, aplPath);
  const results = await runProfilesetAsync(content, scenario, label, {
    simOverrides: { target_error: fidelityOpts.target_error },
  });
  return profilesetResultsToActorMap(results, roster);
}

// --- Load all report data ---

function formatBuildName(build) {
  const archetype = build.archetype || "";
  const match = archetype.match(/^Apex (\d+):\s*(.+)$/);
  if (!match) return build.displayName || build.id;

  const apex = Number(match[1]);
  const template = match[2].trim();

  // Extract hero variant from the original displayName parenthesized suffix
  const variantMatch = (build.displayName || "").match(/\(([^)]+)\)\s*#?\d*$/);
  const variant = variantMatch ? variantMatch[1] : "";

  let name = template;
  if (apex > 0) name += ` (Apex ${apex})`;

  // Append hero variant if present for disambiguation
  if (variant) name += ` [${variant}]`;

  return name;
}

function loadReportData(roster) {
  const rawBuilds = getRosterBuilds();
  const dbByHash = new Map(rawBuilds.map((b) => [b.hash, b]));
  const scenarioKeys = Object.keys(SCENARIOS);

  const builds = roster.builds.map((build) => {
    const db = dbByHash.get(build.hash);
    const dps = Object.fromEntries(
      scenarioKeys.map((s) => [s, build.lastDps?.[s] || db?.[`dps_${s}`] || 0]),
    );
    dps.weighted = build.lastDps?.weighted || db?.weighted || 0;

    return {
      id: build.id,
      displayName: formatBuildName(build),
      archetype: build.archetype || "",
      heroTree: build.heroTree || "",
      hash: build.hash,
      source: build.source || "",
      dps,
      simcDps: db?.simcDps || null,
      lastTestedAt: build.lastTestedAt || db?.lastTestedAt || null,
    };
  });

  const apexBuilds = deriveApexBuilds(builds);

  return { builds, apexBuilds };
}

function loadTrinketData(gearCandidates) {
  const db = getDb();
  const spec = getSpecName();

  const phase1 = db
    .prepare(
      "SELECT * FROM gear_results WHERE spec = ? AND phase = 5 AND slot = 'trinkets_screen' AND candidate_id != '__baseline__' ORDER BY weighted DESC",
    )
    .all(spec);

  const phase2 = db
    .prepare(
      "SELECT * FROM gear_results WHERE spec = ? AND phase = 5 AND combination_type = 'trinkets' AND candidate_id != '__baseline__' ORDER BY weighted DESC",
    )
    .all(spec);

  const ilvlRows = db
    .prepare(
      "SELECT * FROM gear_ilvl_results WHERE spec = ? ORDER BY candidate_id, ilvl ASC",
    )
    .all(spec);

  if (phase1.length === 0 && phase2.length === 0 && ilvlRows.length === 0)
    return null;

  const { tagMap, ilvlTierConfig } = loadTrinketTagMap(gearCandidates);
  return { phase1, phase2, ilvlRows, tagMap, ilvlTierConfig };
}

function loadGearCandidatesFile() {
  const candidatePath = dataFile("gear-candidates.json");
  if (!existsSync(candidatePath)) return null;
  try {
    return JSON.parse(readFileSync(candidatePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadTrinketTagMap(gearCandidates) {
  if (!gearCandidates) return { tagMap: {}, ilvlTierConfig: null };

  const candidates = gearCandidates.paired_slots?.trinkets?.candidates || [];
  const tagMap = Object.fromEntries(
    candidates.map((c) => [c.id, { label: c.label, tags: c.tags || [] }]),
  );
  const rawTiers = gearCandidates.ilvl_tiers;
  const ilvlTierConfig = rawTiers?.length
    ? rawTiers.map((t) =>
        typeof t === "object" ? t : { ilvl: t, track: String(t) },
      )
    : null;
  return { tagMap, ilvlTierConfig };
}

function loadEmbellishmentData() {
  const db = getDb();
  const spec = getSpecName();
  const rows = db
    .prepare(
      "SELECT * FROM gear_results WHERE spec = ? AND phase = 7 AND combination_type = 'embellishments' AND candidate_id != '__baseline__' ORDER BY weighted DESC",
    )
    .all(spec);
  if (rows.length === 0) return null;

  const nullEmb = rows.find((r) => r.candidate_id === "__null_emb__");
  const pairs = rows.filter((r) => r.candidate_id !== "__null_emb__");
  return { pairs, nullEmb };
}

// Slot display order and human-readable labels
const GEAR_SLOTS = [
  { key: "head", label: "Head" },
  { key: "neck", label: "Neck" },
  { key: "shoulder", label: "Shoulders" },
  { key: "back", label: "Back" },
  { key: "chest", label: "Chest" },
  { key: "wrist", label: "Wrists" },
  { key: "hands", label: "Hands" },
  { key: "waist", label: "Waist" },
  { key: "legs", label: "Legs" },
  { key: "feet", label: "Feet" },
  { key: "finger1", label: "Ring 1" },
  { key: "finger2", label: "Ring 2" },
  { key: "trinket1", label: "Trinket 1" },
  { key: "trinket2", label: "Trinket 2" },
  { key: "main_hand", label: "Main Hand" },
  { key: "off_hand", label: "Off Hand" },
];

// "wrists" is a SimC alias that maps to the "wrist" canonical slot key
const GEAR_SLOT_RE = new RegExp(
  `^(${GEAR_SLOTS.map((s) => s.key)
    .concat(["wrists"])
    .join("|")})=`,
);

const GEAR_SLOT_MAP = Object.fromEntries(GEAR_SLOTS.map((s) => [s.key, s]));

// Left column = armor slots, right column = accessories + weapons
const GEAR_COL_LEFT = [
  "head",
  "shoulder",
  "chest",
  "wrist",
  "hands",
  "waist",
  "legs",
  "feet",
];
const GEAR_COL_RIGHT = [
  "neck",
  "back",
  "finger1",
  "finger2",
  "trinket1",
  "trinket2",
  "main_hand",
  "off_hand",
];

function loadGearData(gearCandidates) {
  const profilePath = join(aplsDir(), "profile.simc");
  if (!existsSync(profilePath)) return null;

  const lines = readFileSync(profilePath, "utf-8").split("\n");
  const gear = new Map();
  const consumables = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (GEAR_SLOT_RE.test(trimmed)) {
      const slot = trimmed.split("=")[0];
      gear.set(slot === "wrists" ? "wrist" : slot, parseGearLine(trimmed));
    } else if (
      /^(flask|potion|food|augmentation|temporary_enchant)=/.test(trimmed)
    ) {
      const [key, ...rest] = trimmed.split("=");
      consumables[key] = rest.join("=");
    }
  }

  // Build enchant lookup from local gear-candidates.json (no runtime fetch)
  const enchantMap = new Map();
  if (gearCandidates) {
    for (const slotData of Object.values(gearCandidates.enchants || {})) {
      for (const c of slotData.candidates || []) {
        if (c.enchant_id && c.label) {
          enchantMap.set(c.enchant_id, c.label);
        }
      }
    }
  }

  // Build gem lookup: prefer item name from enchantMap (via enchant_id), fall back to label
  const gemMap = new Map();
  if (gearCandidates) {
    for (const g of gearCandidates.gems || []) {
      if (g.item_id) {
        const name =
          g.name ||
          (g.enchant_id && enchantMap.get(g.enchant_id)) ||
          g.label ||
          null;
        gemMap.set(g.item_id, name);
      }
    }
  }

  // Detect built-in embellishment items from embellishment pairs.
  // These are items that ARE embellishments (count toward the cap) but use
  // no embellishment= tag in SimC — e.g., Loa Worshiper's Band, World Tree Rootwraps.
  const builtInEmbItems = new Set();
  if (gearCandidates?.embellishments?.pairs) {
    for (const pair of gearCandidates.embellishments.pairs) {
      for (const override of pair.overrides || []) {
        if (!override.includes("embellishment=")) {
          const m = override.match(/^[^=]+=([^,]+)/);
          if (m) builtInEmbItems.add(m[1]);
        }
      }
    }
  }

  // Resolve labels for enchants and gems on each item
  for (const item of gear.values()) {
    if (item.enchantId) {
      item.enchantLabel = enchantMap.get(item.enchantId) || null;
    }
    if (item.gemIds?.length) {
      item.gemLabels = item.gemIds.map((id) => gemMap.get(id) || null);
    }
    if (!item.embellishment && builtInEmbItems.has(item.name)) {
      item.builtInEmbellishment = true;
    }
  }

  if (gear.size === 0) return null;
  return { gear, consumables };
}

function parseGearLine(line) {
  const parts = line.split(",");
  const [slot, ...nameParts] = parts[0].split("=");
  const name = nameParts.join("=");

  const item = {
    slot,
    name,
    id: null,
    ilvl: null,
    enchantId: null,
    gemIds: [],
    embellishment: null,
    crafted: false,
  };

  for (let i = 1; i < parts.length; i++) {
    const [k, v] = parts[i].split("=");
    switch (k) {
      case "id":
        item.id = Number(v);
        break;
      case "ilevel":
        item.ilvl = Number(v);
        break;
      case "enchant_id":
        item.enchantId = Number(v);
        break;
      case "gem_id":
        item.gemIds = v.split("/").map(Number);
        break;
      case "embellishment":
        item.embellishment = v;
        break;
      case "crafted_stats":
        item.crafted = true;
        break;
    }
  }

  return item;
}

async function fetchGearIcons(gearData) {
  if (!gearData?.gear?.size) return;
  const ids = new Set();
  for (const item of gearData.gear.values()) {
    if (item.id) ids.add(item.id);
  }
  const results = await Promise.allSettled(
    [...ids].map(async (id) => {
      const res = await fetch(`https://nether.wowhead.com/tooltip/item/${id}`);
      if (!res.ok) return { id, icon: null };
      const data = await res.json();
      return { id, icon: data.icon || null };
    }),
  );
  const iconMap = new Map();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.icon) {
      iconMap.set(r.value.id, r.value.icon);
    }
  }
  for (const item of gearData.gear.values()) {
    if (item.id && iconMap.has(item.id)) {
      item.icon = iconMap.get(item.id);
    }
  }
}

// --- Apex rank build analysis ---

function deriveApexBuilds(builds) {
  // Group builds by apex rank, compute avg DPS per template per tree
  const groups = {};
  for (const b of builds) {
    if (!b.archetype || b.dps.weighted <= 0) continue;
    const match = b.archetype.match(/^Apex (\d+):\s*(.+)$/);
    if (!match) continue;
    const apex = Number(match[1]);
    const templateName = match[2].trim();
    const key = `${apex}|${b.heroTree}|${templateName}`;
    const group = (groups[key] ||= {
      apex,
      heroTree: b.heroTree,
      templateName,
      builds: [],
    });
    group.builds.push(b);
  }

  const dpsKeys = allDpsKeys();
  const entries = Object.values(groups).map((g) => {
    const n = g.builds.length;
    const avg = Object.fromEntries(
      dpsKeys.map((key) => [
        key,
        g.builds.reduce((s, b) => s + (b.dps[key] || 0), 0) / n,
      ]),
    );
    return { ...g, avg };
  });

  // Group by apex rank
  const byApex = {};
  for (const e of entries) {
    (byApex[e.apex] ||= []).push(e);
  }

  // Within each apex, sort by weighted DPS descending
  for (const arr of Object.values(byApex)) {
    arr.sort((a, b) => b.avg.weighted - a.avg.weighted);
  }

  return byApex;
}

// --- Merge sim results into per-build data ---

function mergeSimResults(roster, baselineMaps, oursMaps) {
  return roster.builds.map((build) => {
    const dps = {};
    const simcDps = {};

    for (const s of Object.keys(SCENARIOS)) {
      simcDps[s] = baselineMaps[s]?.get(build.id)?.dps || 0;
      dps[s] = oursMaps[s]?.get(build.id)?.dps || 0;
    }
    simcDps.weighted = computeWeighted(simcDps);
    dps.weighted = computeWeighted(dps);

    return {
      id: build.id,
      displayName: build.displayName || build.id,
      archetype: build.archetype || "",
      heroTree: build.heroTree || "",
      hash: build.hash,
      source: build.source || "",
      dps,
      simcDps,
    };
  });
}

function persistSimResults(roster, buildData) {
  const hashById = new Map(roster.builds.map((b) => [b.id, b.hash]));
  const scenarioKeys = Object.keys(SCENARIOS);

  function roundDps(dpsRow) {
    return Object.fromEntries(
      scenarioKeys.map((s) => [s, Math.round(dpsRow[s] || 0)]),
    );
  }

  for (const row of buildData) {
    const hash = hashById.get(row.id);
    if (!hash) continue;

    if (row.dps.weighted > 0)
      updateBuildDps(hash, roundDps(row.dps), undefined, SCENARIO_WEIGHTS);

    if (row.simcDps?.weighted > 0)
      updateBuildSimcDps(
        hash,
        roundDps(row.simcDps),
        undefined,
        SCENARIO_WEIGHTS,
      );
  }
}

// --- Defensive talent cost sims ---

async function simDefensiveCosts(
  aplPath,
  fidelityOpts,
  reportData,
  specConfig,
) {
  const bestBuild = findBest(reportData.builds, "weighted");
  const archetypeMatch = bestBuild?.archetype?.match(/^Apex (\d+):\s*(.+)$/);

  let refTemplate = null;
  if (archetypeMatch && specConfig.rosterTemplates) {
    refTemplate = specConfig.rosterTemplates.find(
      (t) =>
        t.name === archetypeMatch[2].trim() &&
        t.apexRank === Number(archetypeMatch[1]),
    );
  }

  if (refTemplate) {
    console.log(
      `  Reference: ${bestBuild.displayName} (${bestBuild.archetype})`,
    );
  }

  const { references, variants } = generateDefensiveCostBuilds({ refTemplate });

  if (references.length === 0 || variants.length === 0) {
    console.log("  No defensive talent builds to sim.");
    return { costs: [], refName: "" };
  }

  console.log(
    `  Defensive costs: ${references.length} refs + ${variants.length} variants`,
  );

  const results = [];

  // Profileset names sanitize dots and spaces to underscores
  const sanitize = (s) => s.replace(/\./g, "_").replace(/\s+/g, "_");

  // Group by hero tree — one profileset per tree per scenario
  const heroTrees = [...new Set(references.map((r) => r.heroTree))];

  for (const heroTree of heroTrees) {
    const ref = references.find((r) => r.heroTree === heroTree);
    if (!ref) continue;

    const treeVariants = variants.filter(
      (v) => v.heroTree === heroTree && v.hash && v.valid,
    );
    if (treeVariants.length === 0) continue;

    const miniRoster = {
      builds: [
        { id: ref.name, hash: ref.hash },
        ...treeVariants.map((v) => ({ id: v.build.name, hash: v.hash })),
      ],
    };

    const variantByName = new Map(
      treeVariants.map((v) => [sanitize(v.build.name), v]),
    );

    for (const scenario of Object.keys(SCENARIOS)) {
      console.log(`  ${heroTree} / ${SCENARIOS[scenario].name}...`);

      const content = generateRosterProfilesetContent(miniRoster, aplPath);
      const psResults = await runProfilesetAsync(
        content,
        scenario,
        `defcost_${heroTree.replace(/\s+/g, "_")}_${scenario}`,
        { simOverrides: { target_error: fidelityOpts.target_error } },
      );

      const refDps = psResults.baseline.dps;

      for (const variant of psResults.variants) {
        const match = variantByName.get(variant.name);
        if (!match) {
          console.warn(`  Warning: no match for variant "${variant.name}"`);
          continue;
        }

        let entry = results.find(
          (r) =>
            r.defensiveName === match.defensiveName && r.heroTree === heroTree,
        );
        if (!entry) {
          entry = {
            defensiveName: match.defensiveName,
            heroTree,
            droppedTalents: match.droppedTalents,
            pointCost: match.pointCost,
            dps: {},
            refDps: {},
            deltas: {},
          };
          results.push(entry);
        }

        entry.dps[scenario] = variant.dps;
        entry.refDps[scenario] = refDps;
        entry.deltas[scenario] =
          refDps > 0 ? ((variant.dps - refDps) / refDps) * 100 : 0;
      }
    }
  }

  // Compute weighted deltas
  for (const entry of results) {
    entry.dps.weighted = computeWeighted(entry.dps);
    entry.refDps.weighted = computeWeighted(entry.refDps);
    entry.deltas.weighted =
      entry.refDps.weighted > 0
        ? ((entry.dps.weighted - entry.refDps.weighted) /
            entry.refDps.weighted) *
          100
        : 0;
  }

  // Sort by weighted delta (most costly first)
  results.sort((a, b) => a.deltas.weighted - b.deltas.weighted);

  const refName = refTemplate
    ? `${refTemplate.name} (Apex ${refTemplate.apexRank})`
    : formatBuildName(bestBuild);

  return { costs: results, refName };
}

// --- Talent heatmap computation ---

function decodeBuildSelections(builds, talentData) {
  const nodes = talentData.allNodes;
  const decoded = new Map();
  for (const b of builds) {
    if (!b.hash) continue;
    try {
      const { selections } = decodeTalentHash(b.hash, nodes);
      decoded.set(b.id, selections);
    } catch {
      // Skip builds with invalid hashes
    }
  }
  return decoded;
}

function computeNodeContributions(
  builds,
  talentData,
  decodedBuilds,
  defensiveCosts,
  heroTreeKeys,
) {
  const specNodes = talentData.specNodes.filter((n) => n.id !== 90912);
  const scenarioKeys = ["weighted"];

  // Build defensive talent lookup from cost sim data
  const defensiveMap = new Map();
  if (defensiveCosts?.costs) {
    for (const cost of defensiveCosts.costs) {
      const existing = defensiveMap.get(cost.defensiveName);
      if (existing) {
        existing.push(cost.deltas.weighted);
      } else {
        defensiveMap.set(cost.defensiveName, [cost.deltas.weighted]);
      }
    }
  }

  // Use SPEC_CONFIG hero tree keys (match build.heroTree values)
  const heroTreeNames = heroTreeKeys || Object.keys(talentData.heroSubtrees);

  // Compute contributions per hero tree filter (null = all builds)
  function computeForFilter(filterTree) {
    const filteredBuilds = filterTree
      ? builds.filter((b) => b.heroTree === filterTree)
      : builds;
    const result = {};

    for (const node of specNodes) {
      const hasNode = [];
      const noNode = [];

      for (const b of filteredBuilds) {
        if (b.dps.weighted <= 0) continue;
        const sel = decodedBuilds.get(b.id);
        if (!sel) continue;
        if (sel.has(node.id)) {
          hasNode.push(b);
        } else {
          noNode.push(b);
        }
      }

      const nodeName = node.entries?.[0]?.name || node.name || "";
      const defCosts = defensiveMap.get(nodeName);

      if (hasNode.length === 0 || noNode.length === 0) {
        result[node.id] = {
          universal: hasNode.length > 0,
          defensive: !!defCosts,
          defensiveCost: defCosts
            ? defCosts.reduce((a, b) => a + b, 0) / defCosts.length
            : null,
          deltas: null,
        };
        continue;
      }

      const deltas = {};
      for (const s of scenarioKeys) {
        const avgWith =
          hasNode.reduce((sum, b) => sum + (b.dps[s] || 0), 0) / hasNode.length;
        const avgWithout =
          noNode.reduce((sum, b) => sum + (b.dps[s] || 0), 0) / noNode.length;
        deltas[s] = avgWith - avgWithout;
      }

      result[node.id] = {
        universal: false,
        defensive: !!defCosts,
        defensiveCost: defCosts
          ? defCosts.reduce((a, b) => a + b, 0) / defCosts.length
          : null,
        deltas,
      };
    }
    return result;
  }

  // "all" plus per-hero-tree
  const perTree = { all: computeForFilter(null) };
  for (const tree of heroTreeNames) {
    perTree[tree] = computeForFilter(tree);
  }

  // Annotate "path nodes" — nodes whose delta is primarily inherited from downstream
  const nodeMap = new Map(specNodes.map((n) => [n.id, n]));
  for (const treeKey of Object.keys(perTree)) {
    const contribs = perTree[treeKey];
    for (const node of specNodes) {
      const c = contribs[node.id];
      if (!c?.deltas || c.universal || c.defensive) continue;

      const myDelta = c.deltas.weighted || 0;
      if (myDelta <= 0) continue;

      // Find max weighted delta among direct downstream nodes
      let maxDownstream = 0;
      for (const nextId of node.next || []) {
        const nc = contribs[nextId];
        if (nc?.deltas) {
          const nd = Math.abs(nc.deltas.weighted || 0);
          if (nd > maxDownstream) maxDownstream = nd;
        }
      }

      // Path node: its positive delta is less than half the downstream max
      if (maxDownstream > 0 && myDelta < maxDownstream * 0.6) {
        c.pathNode = true;
      }
    }
  }

  return perTree;
}

// --- Stat weights ---

// --- HTML generation ---

function generateHtml(data) {
  const {
    specName,
    builds,
    apexBuilds,
    defensiveTalentCosts,
    heroTrees,
    trinketData,
    embellishmentData,
    gearData,
    talentData,
    nodeContributions,
    scaleFactors,
  } = data;
  const displaySpec = toTitleCase(specName);

  const latestDate = builds
    .map((b) => b.lastTestedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const freshness = (latestDate || new Date().toISOString()).split(/[T ]/)[0];

  const sections = [
    renderHeader(displaySpec, freshness),
    renderTopBuildCards(builds, heroTrees),
    renderAnalysisRow(
      builds,
      talentData,
      heroTrees,
      nodeContributions,
      apexBuilds,
    ),
    renderBuildRankings(builds, heroTrees),
    renderGearSection(gearData, scaleFactors),
    renderTrinketRankings(trinketData),
    renderEmbellishmentRankings(embellishmentData),
    renderDefensiveCostsSection(defensiveTalentCosts, builds),
    renderFooter(),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(displaySpec)} — APL Optimization Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${CSS}
</style>
</head>
<body>
${sections.join("\n")}
<script>
${JS}
</script>
</body>
</html>
`;
}

// --- Section renderers ---

function renderHeader(displaySpec, freshness) {
  return `<header>
  <div class="header-content">
    <h1>${esc(displaySpec)}</h1>
    <p class="subtitle">Midnight — APL Optimization Report</p>
  </div>
  <div class="header-meta">
    <span class="meta-item">Updated ${freshness}</span>
  </div>
</header>`;
}

function renderTopBuildCards(builds, heroTrees) {
  const treeNames = Object.keys(heroTrees);
  if (treeNames.length < 2) return "";

  const scenarios = activeScenarios(builds);
  const cards = treeNames
    .map((t) => {
      const treeBuilds = [...builds.filter((b) => b.heroTree === t)].sort(
        (a, b) => (b.dps.weighted || 0) - (a.dps.weighted || 0),
      );
      const best = treeBuilds[0];
      if (!best) return "";

      const { cls, abbr } = treeStyle(t);
      const scenarioHtml = scenarios
        .map(
          (s) =>
            `<span class="tbc-scenario"><span class="tbc-scenario-label" style="color:${scenarioColor(s)}">${esc(SCENARIOS[s].name)}</span>${fmtDps(best.dps[s] || 0)}</span>`,
        )
        .join("");

      return `<div class="tbc-card">
      <div class="tbc-tree"><span class="tree-badge ${cls}">${abbr}</span> ${esc(heroTrees[t].displayName)}</div>
      <div class="tbc-dps">${fmtDps(best.dps.weighted || 0)}</div>
      <div class="tbc-name">${esc(best.displayName)}${copyBtn(best.hash)}</div>
      <div class="tbc-scenarios">${scenarioHtml}</div>
      <div class="tbc-count">${treeBuilds.length} builds</div>
    </div>`;
    })
    .join("\n  ");

  return `<section class="top-build-cards">
  <div class="tbc-grid">${cards}</div>
</section>`;
}

function renderAnalysisRow(
  builds,
  talentData,
  heroTrees,
  nodeContributions,
  apexBuilds,
) {
  const heatmap = renderTalentHeatmap(
    builds,
    talentData,
    heroTrees,
    nodeContributions,
  );
  const heroComp = renderHeroComparison(builds, heroTrees);
  const apexChart = renderApexScaling(apexBuilds, heroTrees);

  if (!heatmap && !heroComp && !apexChart) return "";

  const heatmapSvg = heatmap ? heatmap.svgPanel : "";

  return `<section class="analysis-row talent-heatmap" data-active-tree="all">
  <div class="analysis-grid">
    <div class="analysis-left">${heatmapSvg}</div>
    <div class="analysis-right">
      ${heroComp}
      ${apexChart}
    </div>
  </div>
</section>`;
}

function renderGearSection(gearData, scaleFactors) {
  const gearHtml = renderGearDisplay(gearData);
  const statsHtml = renderStatWeights(scaleFactors);
  if (!gearHtml && !statsHtml) return "";

  return `<section>
  <div class="gear-section-grid">
    ${gearHtml}
    ${statsHtml}
  </div>
</section>`;
}

function renderDefensiveCostsSection(defensiveTalentCosts, builds) {
  if (!defensiveTalentCosts?.costs?.length) return "";
  return `<section>
  <div class="report-card">
  <h3>Defensive Talent Costs</h3>
  <p class="section-desc">DPS cost of each defensive talent vs the reference build</p>
  ${renderDefensiveTalentCosts(defensiveTalentCosts.costs, defensiveTalentCosts.refName, builds)}
  </div>
</section>`;
}

function renderTalentHeatmap(builds, talentData, heroTrees, contributions) {
  if (!talentData || !contributions) return "";

  const scenarios = ["weighted"];
  const treeNames = Object.keys(heroTrees);

  const specSvg = renderTreeSvg(
    talentData.specNodes.filter((n) => n.id !== 90912),
    contributions,
    scenarios,
    treeNames,
  );

  // Hero tree toggle
  const heroToggles = [
    `<button class="heatmap-hero-btn active" data-hero-tree="all">All</button>`,
    ...treeNames.map(
      (t) =>
        `<button class="heatmap-hero-btn" data-hero-tree="${esc(t)}"><span class="tree-badge sm ${treeClass(t)}">${treeAbbr(t)}</span> ${esc(heroTrees[t].displayName)}</button>`,
    ),
  ].join("\n      ");

  const svgPanel = `<div class="heatmap-spec-panel report-card">
    <h3>Talent Heatmap</h3>
    <p class="section-desc">Weighted DPS impact per talent</p>
    <div class="heatmap-hero-bar">${heroToggles}</div>
    ${specSvg}
    <div class="heatmap-legend">
      <span class="heatmap-legend-swatch heatmap-legend-pos"></span><span>Positive</span>
      <span class="heatmap-legend-swatch heatmap-legend-neg"></span><span>Negative</span>
      <span class="heatmap-legend-sep"></span>
      <span class="heatmap-legend-swatch heatmap-legend-def"></span><span>Defensive</span>
      <span class="heatmap-legend-sep"></span>
      <span class="heatmap-legend-swatch heatmap-legend-uni-swatch"></span><span>Universal</span>
      <span class="heatmap-legend-sep"></span>
      <span class="heatmap-legend-swatch heatmap-legend-path"></span><span>Path</span>
    </div>
  </div>`;

  return { svgPanel };
}

function renderTreeSvg(nodes, contributions, scenarios, treeNames) {
  if (!nodes.length) return "";

  // Grid-based layout matching talent-combinator
  const NODE_SIZE = 44;
  const ICON_INSET = 3;
  const NODE_GAP_X = 72;
  const NODE_GAP_Y = 72;
  const TREE_PADDING = 24;

  const xs = nodes.map((n) => n.posX);
  const ys = nodes.map((n) => n.posY);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const uniqueXs = [...new Set(xs)].sort((a, b) => a - b);
  const uniqueYs = [...new Set(ys)].sort((a, b) => a - b);
  const cols = uniqueXs.length - 1 || 1;
  const rows = uniqueYs.length - 1 || 1;

  const svgW = cols * NODE_GAP_X + NODE_SIZE + TREE_PADDING * 2;
  const svgH = rows * NODE_GAP_Y + NODE_SIZE + TREE_PADDING * 2 + 16;

  function toSvgX(posX) {
    return (
      TREE_PADDING +
      NODE_SIZE / 2 +
      ((posX - minX) / rangeX) * cols * NODE_GAP_X
    );
  }
  function toSvgY(posY) {
    return (
      TREE_PADDING +
      NODE_SIZE / 2 +
      ((posY - minY) / rangeY) * rows * NODE_GAP_Y
    );
  }

  const half = NODE_SIZE / 2;
  const iconOffset = -half + ICON_INSET;
  const iconSize = NODE_SIZE - ICON_INSET * 2;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // All tree keys: "all" + each hero tree name
  const allTreeKeys = ["all", ...treeNames];

  // Connectors
  let lines = "";
  for (const node of nodes) {
    const x1 = toSvgX(node.posX);
    const y1 = toSvgY(node.posY);
    for (const nextId of node.next || []) {
      const next = nodeById.get(nextId);
      if (!next) continue;
      const x2 = toSvgX(next.posX);
      const y2 = toSvgY(next.posY);
      lines += `<line x1="${x1.toFixed(1)}" y1="${(y1 + half).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${(y2 - half).toFixed(1)}" class="heatmap-edge"/>`;
    }
  }

  let defs = "";
  let nodeEls = "";

  for (const node of nodes) {
    const x = toSvgX(node.posX);
    const y = toSvgY(node.posY);

    // Use "all" tree contributions for initial rendering attributes
    const c = contributions.all?.[node.id];
    const isUniversal = c?.universal;
    const isDefensive = c?.defensive;
    const name = node.entries?.[0]?.name || node.name || `Node ${node.id}`;
    const icon = node.entries?.[0]?.icon;
    const isChoice = node.type === "choice" && !node.isApex;
    const displayName = name.length > 12 ? name.slice(0, 11) + "\u2026" : name;

    // Clip path for icon
    const clipId = `clip-${node.id}`;
    defs += `<clipPath id="${clipId}"><rect x="${(x + iconOffset).toFixed(1)}" y="${(y + iconOffset).toFixed(1)}" width="${iconSize}" height="${iconSize}" rx="5"/></clipPath>`;

    // Per-tree delta data attributes (e.g. data-all-weighted="1234", data-aldrachi-reaver-weighted="567")
    let dataAttrs = "";
    if (isDefensive)
      dataAttrs += ` data-defensive="1" data-cost="${(c.defensiveCost || 0).toFixed(2)}"`;

    for (const treeKey of allTreeKeys) {
      const tc = contributions[treeKey]?.[node.id];
      const prefix = treeKey.toLowerCase().replace(/\s+/g, "-");
      if (tc?.deltas) {
        dataAttrs += ` data-${prefix}-weighted="${(tc.deltas.weighted || 0).toFixed(0)}"`;
      }
      if (tc?.universal) {
        dataAttrs += ` data-${prefix}-universal="1"`;
      }
      if (tc?.pathNode) {
        dataAttrs += ` data-${prefix}-path="1"`;
      }
    }

    const universalCls = isUniversal ? " heatmap-universal" : "";
    const noDataCls = !c?.deltas && !isUniversal ? " heatmap-nodata" : "";
    const defensiveCls = isDefensive ? " heatmap-defensive" : "";

    // Background shape: octagon for choice, rounded rect for everything else
    let bgShape;
    if (isChoice) {
      const s = half;
      const cut = s * 0.3;
      const pts = [
        `${x - s + cut},${y - s}`,
        `${x + s - cut},${y - s}`,
        `${x + s},${y - s + cut}`,
        `${x + s},${y + s - cut}`,
        `${x + s - cut},${y + s}`,
        `${x - s + cut},${y + s}`,
        `${x - s},${y + s - cut}`,
        `${x - s},${y - s + cut}`,
      ].join(" ");
      bgShape = `<polygon points="${pts}" class="heatmap-node${universalCls}${noDataCls}${defensiveCls}"${dataAttrs}/>`;
    } else {
      bgShape = `<rect x="${(x - half).toFixed(1)}" y="${(y - half).toFixed(1)}" width="${NODE_SIZE}" height="${NODE_SIZE}" rx="8" class="heatmap-node${universalCls}${noDataCls}${defensiveCls}"${dataAttrs}/>`;
    }

    // Icon image
    const iconImg = icon
      ? `<image href="https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg" x="${(x + iconOffset).toFixed(1)}" y="${(y + iconOffset).toFixed(1)}" width="${iconSize}" height="${iconSize}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`
      : "";

    // Overlay (same shape as background)
    let overlay;
    if (isChoice) {
      const s = half;
      const cut = s * 0.3;
      const pts = [
        `${x - s + cut},${y - s}`,
        `${x + s - cut},${y - s}`,
        `${x + s},${y - s + cut}`,
        `${x + s},${y + s - cut}`,
        `${x + s - cut},${y + s}`,
        `${x - s + cut},${y + s}`,
        `${x - s},${y + s - cut}`,
        `${x - s},${y - s + cut}`,
      ].join(" ");
      overlay = `<polygon points="${pts}" class="heatmap-overlay"/>`;
    } else {
      overlay = `<rect x="${(x - half).toFixed(1)}" y="${(y - half).toFixed(1)}" width="${NODE_SIZE}" height="${NODE_SIZE}" rx="8" class="heatmap-overlay"/>`;
    }

    // DPS badge text (positioned inside node, bottom-right)
    const badge = `<text x="${(x + half - 3).toFixed(1)}" y="${(y + half - 3).toFixed(1)}" class="heatmap-badge"></text>`;

    nodeEls += `<g class="heatmap-node-group" data-name="${esc(name)}">
      ${bgShape}
      ${iconImg}
      ${overlay}
      ${badge}
      <text x="${x.toFixed(1)}" y="${(y + half + 12).toFixed(1)}" class="heatmap-label">${esc(displayName)}</text>
    </g>`;
  }

  return `<svg viewBox="0 0 ${svgW} ${svgH}" class="heatmap-svg" preserveAspectRatio="xMidYMid meet">
    <defs>${defs}</defs>
    ${lines}
    ${nodeEls}
  </svg>`;
}

function renderHeroComparison(builds, heroTrees) {
  const treeNames = Object.keys(heroTrees);
  if (treeNames.length < 2) return "";

  const scenarios = [...activeScenarios(builds), "weighted"];

  // Best DPS per tree per scenario
  const treeData = {};
  let globalMax = 0;
  for (const tree of treeNames) {
    const treeBuilds = builds.filter((b) => b.heroTree === tree);
    treeData[tree] = { builds: treeBuilds, best: {} };
    for (const s of scenarios) {
      const vals = treeBuilds.map((b) => b.dps[s] || 0).filter((v) => v > 0);
      const best = vals.length > 0 ? Math.max(...vals) : 0;
      treeData[tree].best[s] = best;
      if (best > globalMax) globalMax = best;
    }
  }

  // Legend
  const legend = treeNames
    .map(
      (t) =>
        `<span class="hc-legend-item"><span class="tree-badge sm ${treeClass(t)}">${treeAbbr(t)}</span> ${esc(heroTrees[t].displayName)}</span>`,
    )
    .join("");

  // Paired bars per scenario with delta
  const rows = scenarios
    .map((s) => {
      const vals = treeNames.map((t) => treeData[t].best[s]);
      const winnerIdx = vals[0] >= vals[1] ? 0 : 1;
      const loserIdx = 1 - winnerIdx;
      const delta =
        vals[loserIdx] > 0
          ? ((vals[winnerIdx] - vals[loserIdx]) / vals[loserIdx]) * 100
          : 0;
      const winnerTree = treeNames[winnerIdx];
      const labelColor = s === "weighted" ? "var(--fg)" : scenarioColor(s);

      const bars = treeNames
        .map((t, i) => {
          const pct = globalMax > 0 ? (vals[i] / globalMax) * 100 : 0;
          return `<div class="hc-bar-row"><div class="hc-split-bar" style="width:${pct.toFixed(1)}%;background:${treeColor(t)};opacity:${i === winnerIdx ? 0.9 : 0.75}"></div><span class="hc-bar-val" style="color:${treeColor(t)}">${fmtDps(vals[i])}</span></div>`;
        })
        .join("");

      const deltaHtml =
        delta > 0.5
          ? `<span class="hc-delta" style="color:${treeColor(winnerTree)}">+${delta.toFixed(1)}%</span>`
          : `<span class="hc-delta" style="color:var(--fg-muted)">~tied</span>`;

      return `<div class="hc-row${s === "weighted" ? " hc-row--weighted" : ""}">
        <span class="hc-label" style="color:${labelColor}">${scenarioLabel(s)}</span>
        <div class="hc-split-track">${bars}</div>
        ${deltaHtml}
      </div>`;
    })
    .join("\n");

  return `<div class="hc-panel report-card">
    <h3>Hero Tree Comparison</h3>
    <p class="section-desc">Best build DPS per hero tree by scenario.</p>
    <div class="hc-rows">
      ${rows}
    </div>
    <div class="hc-legend">${legend}</div>
  </div>`;
}

function renderApexScaling(apexBuilds, heroTrees) {
  const treeNames = Object.keys(heroTrees);
  if (!apexBuilds || Object.keys(apexBuilds).length < 2) return "";

  const ranks = Object.keys(apexBuilds)
    .map(Number)
    .sort((a, b) => a - b);
  const maxRank = Math.max(...ranks);
  if (maxRank <= 0) return "";

  // Average weighted DPS per tree per rank (more representative than best-only)
  const perTree = {};
  for (const tree of treeNames) {
    perTree[tree] = {};
    for (const rank of ranks) {
      const entries = (apexBuilds[rank] || []).filter(
        (e) => e.heroTree === tree,
      );
      if (entries.length > 0) {
        const sum = entries.reduce((s, e) => s + e.avg.weighted, 0);
        perTree[tree][rank] = sum / entries.length;
      }
    }
  }

  // % gain from each tree's rank 0 baseline
  const gains = {};
  let yMaxRaw = 0;
  let yMinRaw = 0;
  for (const tree of treeNames) {
    const baseline = perTree[tree][0];
    if (!baseline) continue;
    gains[tree] = {};
    for (const rank of ranks) {
      const dps = perTree[tree][rank];
      if (dps === undefined) continue;
      const pct = ((dps - baseline) / baseline) * 100;
      gains[tree][rank] = { pct, dps };
      if (pct > yMaxRaw) yMaxRaw = pct;
      if (pct < yMinRaw) yMinRaw = pct;
    }
  }

  // SVG layout — support negative values
  const W = 400,
    H = 250;
  const LEFT = 48,
    RIGHT = 30,
    TOP = 15,
    BOT = 40;
  const cW = W - LEFT - RIGHT,
    cH = H - TOP - BOT;
  const step = 5;
  const yMax = Math.max(0, Math.ceil((yMaxRaw + 2) / step) * step);
  const yMin = yMinRaw < 0 ? Math.floor((yMinRaw - 2) / step) * step : 0;
  const yRange = yMax - yMin;
  if (yRange <= 0) return "";

  const xOf = (r) => LEFT + (r / maxRank) * cW;
  const yOf = (g) => TOP + cH - ((g - yMin) / yRange) * cH;

  // Gridlines
  let grid = "";
  const numSteps = Math.round((yMax - yMin) / step);
  for (let i = 0; i <= numSteps; i++) {
    const g = yMin + i * step;
    const y = yOf(g).toFixed(1);
    const isZero = g === 0;
    grid += `<line x1="${LEFT}" y1="${y}" x2="${W - RIGHT}" y2="${y}" stroke="${isZero ? "var(--fg-muted)" : "var(--border-subtle)"}" stroke-width="${isZero ? 1.5 : 1}" ${isZero ? 'stroke-dasharray="4,3"' : ""}/>`;
    grid += `<text x="${LEFT - 8}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end" class="apex-axis-label">${g}%</text>`;
  }

  // X-axis labels
  let xAxis = "";
  for (const r of ranks) {
    const x = xOf(r).toFixed(1);
    xAxis += `<text x="${x}" y="${(TOP + cH + 18).toFixed(1)}" text-anchor="middle" class="apex-axis-label">Rank ${r}</text>`;
  }

  // Curves + nodes
  let paths = "";
  let points = "";

  for (const tree of treeNames) {
    if (!gains[tree]) continue;
    const color = treeColor(tree);
    const fill = treeFill(tree);

    const pts = ranks
      .filter((r) => gains[tree][r] !== undefined)
      .map((r) => ({
        r,
        x: xOf(r),
        y: yOf(gains[tree][r].pct),
        ...gains[tree][r],
      }));
    if (pts.length < 2) continue;

    // Area fill + stroke
    const base = yOf(0);
    const line = pts
      .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    paths += `<path d="${line} L${pts.at(-1).x.toFixed(1)},${base.toFixed(1)} L${pts[0].x.toFixed(1)},${base.toFixed(1)}Z" fill="${fill}"/>`;
    paths += `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`;

    // Data point nodes
    const tipW = 130;
    for (const p of pts) {
      const cx = p.x.toFixed(1);
      const cy = p.y.toFixed(1);
      const tipX = Math.max(tipW / 2, Math.min(W - tipW / 2, p.x));
      const tipLabel = `${fmtDps(p.dps)} (${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(1)}%)`;

      points += `<g class="apex-point">`;
      points += `<circle cx="${cx}" cy="${cy}" r="3.5" fill="var(--bg)" stroke="${color}" stroke-width="1.5" class="apex-node"/>`;
      points += `<g class="apex-tooltip"><rect x="${(tipX - tipW / 2).toFixed(1)}" y="${(p.y - 44).toFixed(1)}" width="${tipW}" height="22" rx="4" fill="var(--surface)" stroke="var(--border)"/><text x="${tipX.toFixed(1)}" y="${(p.y - 30).toFixed(1)}" text-anchor="middle" class="apex-tip-text">${tipLabel}</text></g>`;
      points += `</g>`;
    }
  }

  // HTML legend (matches hero comparison panel)
  const legend = treeNames
    .map(
      (t) =>
        `<span class="hc-legend-item"><span class="tree-badge sm ${treeClass(t)}">${treeAbbr(t)}</span> ${esc(heroTrees[t].displayName)}</span>`,
    )
    .join("");

  return `<div class="apex-panel report-card">
    <h3>Apex Scaling</h3>
    <p class="section-desc">Average weighted DPS change by apex rank per hero tree, relative to each tree's rank 0 baseline.</p>
    <svg class="apex-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${grid}
      ${xAxis}
      ${paths}
      ${points}
    </svg>
    <div class="hc-legend">${legend}</div>
  </div>`;
}

function renderBuildRankings(builds, heroTrees) {
  const scenarios = activeScenarios(builds);

  const topWeighted = findBest(builds, "weighted");
  const topPerScenario = Object.fromEntries(
    scenarios.map((s) => [s, findBest(builds, s)]),
  );

  // Sort by weighted DPS descending
  const sorted = [...builds].sort(
    (a, b) => (b.dps.weighted || 0) - (a.dps.weighted || 0),
  );

  // Hero tree filter buttons
  const treeFilters = renderTreeFilterBtns(heroTrees);

  // Table rows
  let rows = "";
  for (const b of sorted) {
    const isTopW = b.id === topWeighted?.id;
    const wBadge = isTopW ? '<span class="badge">TOP</span>' : "";

    // Baseline tooltip
    const hasBaseline = b.simcDps && b.simcDps.weighted > 0;
    let scenarioCells = "";
    for (const s of scenarios) {
      const isTop = topPerScenario[s]?.id === b.id;
      const badge = isTop ? '<span class="badge">TOP</span>' : "";
      const topCls = isTop ? " top-build" : "";
      const tip =
        hasBaseline && b.simcDps[s]
          ? ` data-tip="SimC baseline: ${fmtDps(b.simcDps[s])}"`
          : "";
      scenarioCells += `<td class="dps-cell${topCls} has-tip"${tip}>${fmtDps(b.dps[s] || 0)}${badge}</td>`;
    }

    const wTip = hasBaseline
      ? ` data-tip="SimC baseline: ${fmtDps(b.simcDps.weighted)}"`
      : "";
    const { cls: bCls, abbr: bAbbr } = treeStyle(b.heroTree);
    rows += `<tr data-tree="${esc(b.heroTree)}">
  <td class="build-name">${esc(b.displayName)}${copyBtn(b.hash)}</td>
  <td><span class="tree-badge sm ${bCls}">${bAbbr}</span></td>
  ${scenarioCells}
  <td class="dps-cell${isTopW ? " top-build" : ""} has-tip"${wTip}>${fmtDps(b.dps.weighted || 0)}${wBadge}</td>
</tr>`;
  }

  const scenarioHeaders = scenarios
    .map(
      (s) =>
        `<th class="sortable num" data-col="${s}" style="color:${scenarioColor(s)}">${esc(SCENARIOS[s].name)}</th>`,
    )
    .join("\n      ");

  const weightLegend = Object.keys(SCENARIOS)
    .map(
      (s) =>
        `<span style="color:${scenarioColor(s)}">${esc(SCENARIOS[s].name)}</span> ${Math.round(SCENARIO_WEIGHTS[s] * 100)}%`,
    )
    .join(" · ");

  return `<section id="rankings">
  <div class="report-card">
  <h3>Build Rankings</h3>
  <p class="section-desc">Weighted = ${weightLegend}</p>
  <div class="filter-bar">
    <button class="filter-btn active" data-tree="all">All (${builds.length})</button>
    ${treeFilters}
  </div>
  <div class="table-wrap">
    <table class="roster-table" id="rankings-table">
      <thead><tr>
        <th class="sortable" data-col="name">Build</th>
        <th>Tree</th>
        ${scenarioHeaders}
        <th class="sortable num" data-col="weighted" style="color:var(--fg)">Weighted</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  </div>
</section>`;
}

const TAG_CLASSES = {
  "on-use": "trinket-tag--use",
  passive: "trinket-tag--passive",
  raid: "trinket-tag--raid",
  dungeon: "trinket-tag--dungeon",
  crafted: "trinket-tag--crafted",
};

function renderTagBadges(tags) {
  if (!tags?.length) return "";
  return tags
    .map((t) => {
      const modifier = TAG_CLASSES[t] || "";
      const cls = modifier ? `trinket-tag ${modifier}` : "trinket-tag";
      return `<span class="${cls}">${esc(t)}</span>`;
    })
    .join("");
}

function renderTrinketRankings(trinketData) {
  if (!trinketData) return "";

  const { phase1, phase2, ilvlRows, tagMap, ilvlTierConfig } = trinketData;

  function trinketLabel(r) {
    return r.label || tagMap[r.candidate_id]?.label || r.candidate_id;
  }

  function tagBadges(candidateId) {
    return renderTagBadges(tagMap[candidateId]?.tags);
  }

  function renderStrips(items, showTags, maxDps) {
    if (!items.length) return "";
    if (!maxDps) maxDps = items[0].weighted;

    let html = "";
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const isBest = i === 0 && !r.eliminated;
      const delta = isBest
        ? "best"
        : `${(r.delta_pct_weighted || 0).toFixed(1)}%`;
      const barPct = maxDps > 0 ? (r.weighted / maxDps) * 100 : 0;
      const elimCls = r.eliminated === 1 ? " trinket-strip--elim" : "";
      const tags = showTags ? tagBadges(r.candidate_id) : "";
      const label = trinketLabel(r);

      html += `<div class="trinket-strip${elimCls}">
        <div class="trinket-strip__rank">${i + 1}</div>
        <div class="trinket-strip__body">
          <div class="trinket-strip__name-row">
            <span class="trinket-strip__name">${esc(label)}</span>
            ${tags ? `<span class="trinket-strip__tags">${tags}</span>` : ""}
          </div>
          <div class="trinket-strip__bar-wrap">
            <div class="trinket-strip__bar" style="width:${barPct.toFixed(1)}%"></div>
          </div>
        </div>
        <div class="trinket-strip__dps">${fmtDps(r.weighted)}</div>
        <div class="trinket-strip__delta ${isBest ? "trinket-strip__delta--best" : ""}">${delta}</div>
      </div>`;
    }
    return html;
  }

  function renderPhase(items, title, desc, showTags) {
    if (!items.length) return "";
    const active = items.filter((r) => !r.eliminated);
    const elim = items.filter((r) => r.eliminated);
    const maxDps = items[0].weighted;
    const topActive = active.slice(0, 5);
    const moreActive = active.slice(5);
    const allMore = [...moreActive, ...elim];

    const moreHtml =
      allMore.length > 0
        ? `<details class="trinket-details">
        <summary>More trinkets <span class="detail-count">(${allMore.length})</span></summary>
        <div class="trinket-list trinket-list--elim">${renderStrips(allMore, showTags, maxDps)}</div>
      </details>`
        : "";

    return `<div class="subsection">
      <h3>${title}</h3>
      <p class="section-desc">${desc}</p>
      <div class="trinket-list">${renderStrips(topActive, showTags, maxDps)}</div>
      ${moreHtml}
    </div>`;
  }

  const sections = [];

  // ilvl chart replaces individual trinkets when available
  if (ilvlRows?.length > 0) {
    sections.push(renderTrinketIlvlChart(ilvlRows, tagMap, ilvlTierConfig));
  } else if (phase1.length > 0) {
    sections.push(
      renderPhase(
        phase1,
        "Individual Trinkets",
        "Weighted DPS per trinket slot (single-slot screen, best build). Eliminated trinkets fell below the advancement threshold.",
        true,
      ),
    );
  }

  if (sections.length === 0) return "";

  return `<section>
  <div class="report-card">
    <h3>Trinket Rankings</h3>
    ${sections.join("")}
  </div>
</section>`;
}

// Shared renderer for paired-slot ranking sections (rings, embellishments).
// deltaFn(row, best) returns the delta string for non-best rows.
// extraListHtml is appended inside the active list (e.g. nullEmb reference row).
function renderPairRankingSection({
  title,
  desc,
  pairs,
  deltaFn,
  extraListHtml = "",
}) {
  if (!pairs?.length) return "";

  const active = pairs.filter((r) => !r.eliminated);
  const elim = pairs.filter((r) => r.eliminated);
  const best = active[0];
  const maxDps = best?.weighted || elim[0]?.weighted || 1;

  function renderStrips(items, isActive) {
    return items
      .map((r, i) => {
        const isBest = isActive && i === 0;
        const delta = isBest ? "best" : deltaFn(r, best);
        const barPct = maxDps > 0 ? (r.weighted / maxDps) * 100 : 0;
        const elimCls = r.eliminated === 1 ? " trinket-strip--elim" : "";
        return `<div class="trinket-strip${elimCls}">
        <div class="trinket-strip__rank">${i + 1}</div>
        <div class="trinket-strip__body">
          <div class="trinket-strip__name-row">
            <span class="trinket-strip__name">${esc(r.label || r.candidate_id)}</span>
          </div>
          <div class="trinket-strip__bar-wrap">
            <div class="trinket-strip__bar" style="width:${barPct.toFixed(1)}%"></div>
          </div>
        </div>
        <div class="trinket-strip__dps">${fmtDps(r.weighted)}</div>
        <div class="trinket-strip__delta ${isBest ? "trinket-strip__delta--best" : ""}">${delta}</div>
      </div>`;
      })
      .join("");
  }

  const elimHtml =
    elim.length > 0
      ? `<details class="trinket-details">
      <summary>Not significant — below threshold <span class="detail-count">(${elim.length})</span></summary>
      <div class="trinket-list trinket-list--elim">${renderStrips(elim, false)}</div>
    </details>`
      : "";

  return `<section>
  <div class="report-card">
    <h3>${title}</h3>
    <p class="section-desc">${desc}</p>
    <div class="trinket-list">${renderStrips(active, true)}${extraListHtml}</div>
    ${elimHtml}
  </div>
</section>`;
}

function pctDelta(r, ref) {
  if (!ref) return "";
  const pct = ((r.weighted - ref.weighted) / ref.weighted) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function renderEmbellishmentRankings(embData) {
  if (!embData?.pairs?.length) return "";

  const { pairs, nullEmb } = embData;
  const allActive = pairs.filter((r) => !r.eliminated);
  // Show top 5; remainder goes into the "more" section
  const topActive = allActive.slice(0, 5);
  const moreActive = allActive.slice(5);
  const allElim = [...moreActive, ...pairs.filter((r) => r.eliminated)];

  function embDelta(r) {
    if (!nullEmb) return `${(r.delta_pct_weighted || 0).toFixed(1)}%`;
    return pctDelta(r, nullEmb);
  }

  // Delta-relative bar scaling: 0% = nullEmb (no embellishment), 100% = best pair
  const best = topActive[0];
  const floor = nullEmb?.weighted || 0;
  const range = best ? best.weighted - floor : 1;
  function embBarPct(r) {
    if (range <= 0) return 0;
    return Math.max(0, Math.min(100, ((r.weighted - floor) / range) * 100));
  }

  function renderEmbStrips(items, isActive) {
    return items
      .map((r, i) => {
        const isBest = isActive && i === 0;
        const delta = isBest ? "best" : embDelta(r);
        const barPct = embBarPct(r);
        const elimCls = r.eliminated === 1 ? " trinket-strip--elim" : "";
        return `<div class="trinket-strip${elimCls}">
        <div class="trinket-strip__rank">${i + 1}</div>
        <div class="trinket-strip__body">
          <div class="trinket-strip__name-row">
            <span class="trinket-strip__name">${esc(r.label || r.candidate_id)}</span>
          </div>
          <div class="trinket-strip__bar-wrap">
            <div class="trinket-strip__bar" style="width:${barPct.toFixed(1)}%"></div>
          </div>
        </div>
        <div class="trinket-strip__dps">${fmtDps(r.weighted)}</div>
        <div class="trinket-strip__delta ${isBest ? "trinket-strip__delta--best" : ""}">${delta}</div>
      </div>`;
      })
      .join("");
  }

  const nullRow = nullEmb
    ? `<div class="trinket-strip trinket-strip--ref">
    <div class="trinket-strip__rank">—</div>
    <div class="trinket-strip__body">
      <div class="trinket-strip__name-row">
        <span class="trinket-strip__name">${esc(nullEmb.label || "No Embellishment")}</span>
      </div>
      <div class="trinket-strip__bar-wrap">
        <div class="trinket-strip__bar" style="width:0%"></div>
      </div>
    </div>
    <div class="trinket-strip__dps">${fmtDps(nullEmb.weighted)}</div>
    <div class="trinket-strip__delta">baseline</div>
  </div>`
    : "";

  const moreHtml =
    allElim.length > 0
      ? `<details class="trinket-details">
      <summary>More embellishments <span class="detail-count">(${allElim.length})</span></summary>
      <div class="trinket-list trinket-list--elim">${renderEmbStrips(allElim, false)}</div>
    </details>`
      : "";

  return `<section>
  <div class="report-card">
    <h3>Embellishment Rankings</h3>
    <p class="section-desc">DPS gain from embellishment combinations (2-slot budget). Bars show gain vs no-embellishment baseline. Delta shown vs same crafted gear without embellishments.</p>
    <div class="trinket-list">${renderEmbStrips(topActive, true)}${nullRow}</div>
    ${moreHtml}
  </div>
</section>`;
}

// ilvl tier colors: muted → bright across the progression range
const ILVL_COLORS = [
  "#7c8098", // lowest — muted gray
  "#60a5fa", // blue
  "#34d399", // green
  "#f5c842", // gold
  "#fb923c", // orange — highest
];

function renderTrinketIlvlChart(ilvlRows, tagMap, ilvlTierConfig) {
  // Group rows into: Map<candidateId, { label, byIlvl: Map<ilvl, weighted> }>
  const byTrinket = new Map();
  for (const row of ilvlRows) {
    if (!byTrinket.has(row.candidate_id)) {
      const info = tagMap[row.candidate_id];
      byTrinket.set(row.candidate_id, {
        candidateId: row.candidate_id,
        label: row.label || info?.label || row.candidate_id,
        tags: info?.tags || [],
        byIlvl: new Map(),
      });
    }
    byTrinket.get(row.candidate_id).byIlvl.set(row.ilvl, row.weighted);
  }

  // Sorted ilvl tiers from the data
  const ilvlTiers = [...new Set(ilvlRows.map((r) => r.ilvl))].sort(
    (a, b) => a - b,
  );
  const highestIlvl = ilvlTiers.at(-1);

  // Track name lookup from config (e.g., 276 → "Hero")
  const trackNames = new Map(
    (ilvlTierConfig || []).map((t) => [t.ilvl, t.track]),
  );

  // Assign colors to tiers
  const tierColors = Object.fromEntries(
    ilvlTiers.map((t, i) => [
      t,
      ILVL_COLORS[
        Math.round(
          (i / Math.max(ilvlTiers.length - 1, 1)) * (ILVL_COLORS.length - 1),
        )
      ],
    ]),
  );

  // Sort trinkets by highest-ilvl DPS descending
  const sorted = [...byTrinket.values()].sort(
    (a, b) =>
      (b.byIlvl.get(highestIlvl) || 0) - (a.byIlvl.get(highestIlvl) || 0),
  );

  // Truncated axis: scale from near-min to max so differences are visible
  const allDps = ilvlRows.map((r) => r.weighted).filter((v) => v > 0);
  const globalMax = Math.max(...allDps, 1);
  const globalMin = Math.min(...allDps);
  const axisFloor = globalMin * 0.97;
  const axisRange = globalMax - axisFloor;
  const bestAtHighest = sorted[0]?.byIlvl.get(highestIlvl) || 1;

  // Legend — show track name when available (e.g., "Hero 276")
  const legend = ilvlTiers
    .map((t) => {
      const track = trackNames.get(t);
      const label = track ? `${track} ${t}` : String(t);
      return `<span class="tc-legend-item"><span class="tc-legend-swatch" style="background:${tierColors[t]}"></span>${label}</span>`;
    })
    .join("");

  // Rows
  function renderIlvlRow(trinket, i) {
    const topDps = trinket.byIlvl.get(highestIlvl) || 0;
    const delta =
      i === 0
        ? "best"
        : `${(((topDps - bestAtHighest) / bestAtHighest) * 100).toFixed(1)}%`;

    const tags = renderTagBadges(trinket.tags);

    // Overlapping bars: highest ilvl (widest) in back, lowest in front
    const barsHtml = [...ilvlTiers]
      .reverse()
      .map((ilvl) => {
        const dps = trinket.byIlvl.get(ilvl) || 0;
        const barPct =
          axisRange > 0 ? ((dps - axisFloor) / axisRange) * 100 : 0;
        const track = trackNames.get(ilvl) || "";
        return `<div class="tc-bar" data-ilvl="${ilvl}" data-track="${esc(track)}" data-dps="${Math.round(dps)}" style="width:${Math.max(barPct, 0).toFixed(1)}%;background:${tierColors[ilvl]}"></div>`;
      })
      .join("");

    return `<div class="tc-row">
      <div class="tc-rank">${i + 1}</div>
      <div class="tc-body">
        <div class="tc-name-row">
          <span class="tc-name">${esc(trinket.label)}</span>
          ${tags ? `<span class="trinket-strip__tags">${tags}</span>` : ""}
        </div>
        <div class="tc-bar-track">${barsHtml}</div>
      </div>
      <div class="tc-best-dps">${fmtDps(topDps)}</div>
      <div class="tc-delta${i === 0 ? " tc-delta--best" : ""}">${delta}</div>
    </div>`;
  }

  const topRows = sorted.slice(0, 5).map(renderIlvlRow).join("");
  const moreRows = sorted.slice(5);
  const moreHtml =
    moreRows.length > 0
      ? `<details class="trinket-details">
      <summary>More trinkets <span class="detail-count">(${moreRows.length})</span></summary>
      <div class="tc-chart-more">${moreRows.map((t, i) => renderIlvlRow(t, i + 5)).join("")}</div>
    </details>`
      : "";
  const rows = topRows;

  // Best DPS per ilvl tier (for tooltip delta display)
  const bestPerIlvl = {};
  for (const ilvl of ilvlTiers) {
    bestPerIlvl[ilvl] = Math.max(...sorted.map((t) => t.byIlvl.get(ilvl) || 0));
  }

  return `<div class="subsection">
    <h3>Trinket Scaling by Item Level</h3>
    <p class="section-desc">Weighted DPS per trinket at each upgrade track (top of track ilvl). Sorted by ${trackNames.get(highestIlvl) || "highest"} (${highestIlvl}) performance.</p>
    <div class="tc-chart" data-best-per-ilvl='${JSON.stringify(bestPerIlvl)}'>
      <div class="tc-legend"><span class="tc-legend-label">Upgrade Track</span>${legend}</div>
      ${rows}
    </div>
    ${moreHtml}
  </div>`;
}

function renderDefensiveTalentCosts(costs, refName, builds) {
  const scenarios = activeScenarios(builds);

  // Group by defensive talent name, average across hero trees
  const byTalent = {};
  for (const c of costs) {
    const group = (byTalent[c.defensiveName] ||= {
      defensiveName: c.defensiveName,
      pointCost: c.pointCost,
      entries: [],
    });
    group.entries.push(c);
  }

  const averaged = Object.values(byTalent).map((group) => {
    const n = group.entries.length;
    const avgDeltas = {};
    for (const key of [...scenarios, "weighted"]) {
      avgDeltas[key] =
        group.entries.reduce((sum, e) => sum + (e.deltas[key] || 0), 0) / n;
    }
    return { ...group, avgDeltas };
  });

  // Sort by cost: least costly first (closest to 0)
  averaged.sort((a, b) => b.avgDeltas.weighted - a.avgDeltas.weighted);

  // Compute max cost for bar scaling
  const maxCost = Math.max(
    ...averaged.map((t) => Math.abs(t.avgDeltas.weighted)),
    1,
  );

  function getSeverity(pct) {
    const abs = Math.abs(pct);
    return (
      SEVERITY_TIERS.find((t) => abs < maxCost * t.threshold) ||
      SEVERITY_TIERS[SEVERITY_TIERS.length - 1]
    );
  }

  // Extract tree names from entries for column headers
  const treeNames =
    averaged.length > 0 && averaged[0].entries.length > 1
      ? averaged[0].entries.map((e) => e.heroTree)
      : [];
  const treeHeaders = treeNames
    .map(
      (t) =>
        `<span class="def-strip__tree-header"><span class="tree-badge sm ${treeClass(t)}">${treeAbbr(t)}</span></span>`,
    )
    .join("");

  let html = `<div class="subsection">
    <p class="section-desc">DPS cost of taking each defensive talent (averaged across hero trees, vs ${esc(refName)}).</p>
    <div class="def-cost-list">
    ${treeHeaders ? `<div class="def-strip-header"><div class="def-strip-header__body"><span></span><span></span><span class="def-strip-header__label" style="color:var(--fg)">Avg</span>${treeHeaders}</div></div>` : ""}`;

  for (const t of averaged) {
    const { cls: sev, color } = getSeverity(t.avgDeltas.weighted);
    const barPct = (Math.abs(t.avgDeltas.weighted) / maxCost) * 100;

    const treeHtml =
      t.entries.length > 1
        ? (() => {
            const deltas = t.entries.map((e) => e.deltas.weighted);
            const spread = Math.abs(deltas[0] - deltas[1]);
            const avgAbs = Math.abs(t.avgDeltas.weighted);
            const divergent = avgAbs > 0 && spread / avgAbs > 0.3;
            return t.entries
              .map((e) => {
                const isOutlier =
                  divergent &&
                  Math.abs(e.deltas.weighted) >
                    Math.abs(t.avgDeltas.weighted) * 1.15;
                return `<span class="def-strip__tree${isOutlier ? " def-strip__tree--divergent" : ""}">${fmtDelta(e.deltas.weighted)}</span>`;
              })
              .join("");
          })()
        : "";

    html += `<div class="def-strip def-strip--${sev}">
      <div class="def-strip__indicator" style="background:${color}"></div>
      <div class="def-strip__body">
        <span class="def-strip__name">${esc(t.defensiveName)}</span>
        <div class="def-strip__bar-wrap">
          <div class="def-strip__bar" style="width:${barPct.toFixed(1)}%;background:${color}"></div>
        </div>
        <span class="def-strip__cost" style="color:${color}">${fmtDelta(t.avgDeltas.weighted)}</span>
        ${treeHtml}
      </div>
    </div>`;
  }

  html += `</div></div>`;
  return html;
}

function renderStatWeights(scaleFactors) {
  if (!scaleFactors) return "";

  // Secondary stat DR constants for Midnight (level 80).
  // k = rating at which you get 50% of the theoretical max percent.
  // These approximate the SimC CombatRating curves.
  const STAT_CONFIG = {
    Crit: { label: "Crit", color: "#ef4444", k: 6600 },
    Haste: { label: "Haste", color: "#3b82f6", k: 6600 },
    Mastery: { label: "Mastery", color: "#f59e0b", k: 6600 },
    Vers: { label: "Vers", color: "#10b981", k: 6600 },
  };

  const stats = Object.entries(STAT_CONFIG)
    .map(([key, cfg]) => ({
      key,
      ...cfg,
      ep: scaleFactors[key] || 0,
    }))
    .filter((s) => s.ep > 0)
    .sort((a, b) => b.ep - a.ep);

  if (stats.length === 0) return "";

  // DR curve: EP(r) = EP(r0) * (r0 + k)^2 / (r + k)^2
  // We plot relative stat levels from -30% to +30% of a reference point.
  // Since we only have EP at one point (the current gear), we use the DR
  // formula to project how EP changes as rating changes.
  const STEPS = 7;
  const RANGE = 0.3; // +/- 30%
  const REF_RATING = 5000; // approximate current secondary rating level

  // X positions: -30% to +30% relative
  const xLabels = [];
  for (let i = 0; i < STEPS; i++) {
    const pct = -RANGE + (2 * RANGE * i) / (STEPS - 1);
    xLabels.push(pct);
  }

  // Compute EP at each relative stat level for each stat
  const curves = stats.map((s) => {
    const r0 = REF_RATING;
    const points = xLabels.map((pct) => {
      const r = r0 * (1 + pct);
      const ratio = ((r0 + s.k) * (r0 + s.k)) / ((r + s.k) * (r + s.k));
      return s.ep * ratio;
    });
    return { ...s, points };
  });

  // SVG dimensions
  const W = 380;
  const H = 200;
  const PAD = { top: 12, right: 16, bottom: 28, left: 42 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Y range across all curves
  const allVals = curves.flatMap((c) => c.points);
  const yMin = Math.min(...allVals) * 0.92;
  const yMax = Math.max(...allVals) * 1.05;

  function sx(i) {
    return PAD.left + (i / (STEPS - 1)) * plotW;
  }
  function sy(v) {
    return PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  }

  // Grid lines
  const yTicks = 4;
  let gridLines = "";
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const y = sy(v).toFixed(1);
    gridLines += `<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
    gridLines += `<text x="${PAD.left - 4}" y="${y}" text-anchor="end" class="sw-axis-label" dy="0.35em">${v.toFixed(1)}</text>`;
  }

  // X-axis labels
  let xAxisLabels = "";
  for (let i = 0; i < STEPS; i++) {
    const pct = xLabels[i];
    const label =
      pct === 0 ? "Current" : `${pct > 0 ? "+" : ""}${Math.round(pct * 100)}%`;
    xAxisLabels += `<text x="${sx(i).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="sw-axis-label">${label}</text>`;
  }

  // Current position marker
  const currIdx = Math.floor(STEPS / 2);
  const currLine = `<line x1="${sx(currIdx).toFixed(1)}" y1="${PAD.top}" x2="${sx(currIdx).toFixed(1)}" y2="${PAD.top + plotH}" stroke="var(--fg-muted)" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>`;

  // Curve lines + dots
  let curvePaths = "";
  for (const c of curves) {
    const pathD = c.points
      .map(
        (v, i) =>
          `${i === 0 ? "M" : "L"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`,
      )
      .join(" ");
    curvePaths += `<path d="${pathD}" fill="none" stroke="${c.color}" stroke-width="2" opacity="0.85"/>`;
    // Dot at current position
    curvePaths += `<circle cx="${sx(currIdx).toFixed(1)}" cy="${sy(c.points[currIdx]).toFixed(1)}" r="3.5" fill="${c.color}" stroke="var(--surface)" stroke-width="1.5"/>`;
  }

  // Legend
  const legend = curves
    .map(
      (c) =>
        `<span class="sw-legend-item"><span class="sw-legend-swatch" style="background:${c.color}"></span>${c.label} <b>${c.ep.toFixed(2)}</b></span>`,
    )
    .join("");

  const ts = scaleFactors.timestamp
    ? new Date(scaleFactors.timestamp).toISOString().split("T")[0]
    : "";
  const tsNote = ts ? ` <span class="sw-timestamp">as of ${ts}</span>` : "";

  return `<div class="stat-weights report-card">
  <h3>Stat Weights</h3>
  <p class="section-desc">EP diminishing returns as stats increase${tsNote}</p>
  <svg viewBox="0 0 ${W} ${H}" class="sw-chart-svg" preserveAspectRatio="xMidYMid meet">
    ${gridLines}
    ${currLine}
    ${curvePaths}
    ${xAxisLabels}
  </svg>
  <div class="sw-legend">${legend}</div>
</div>`;
}

function renderGearDisplay(gearData) {
  if (!gearData?.gear?.size) return "";

  const { gear, consumables } = gearData;

  function renderItemRow(slotKey) {
    const slotDef = GEAR_SLOT_MAP[slotKey];
    const item = gear.get(slotKey);
    if (!slotDef || !item) return "";

    const displayName = toTitleCase(item.name);

    const tags = [];

    if (item.gemIds.length) {
      // Group identical gems by ID, preserving label from first occurrence
      const seen = new Map();
      item.gemIds.forEach((id, i) => {
        if (!seen.has(id)) {
          seen.set(id, { count: 0, name: item.gemLabels?.[i] || `Gem #${id}` });
        }
        seen.get(id).count++;
      });
      const gemLabels = [...seen.values()].map(({ count, name }) =>
        count > 1 ? `${count}x ${name}` : name,
      );
      tags.push(
        `<span class="gear-anno gear-anno--gem">${esc(gemLabels.join(", "))}</span>`,
      );
    }

    if (item.enchantId) {
      const label = item.enchantLabel || `#${item.enchantId}`;
      tags.push(
        `<span class="gear-anno gear-anno--enchant">${esc(label)}</span>`,
      );
    }

    const isEmb = item.embellishment || item.builtInEmbellishment;
    if (item.crafted && !isEmb)
      tags.push(`<span class="gear-anno gear-anno--crafted">Crafted</span>`);
    if (item.embellishment)
      tags.push(
        `<span class="gear-anno gear-anno--emb">${esc(toTitleCase(item.embellishment))}</span>`,
      );
    if (item.builtInEmbellishment)
      tags.push(`<span class="gear-anno gear-anno--emb">Embellishment</span>`);

    const iconHtml = item.icon
      ? `<img class="gear-icon" src="https://wow.zamimg.com/images/wow/icons/medium/${item.icon}.jpg" alt="" loading="lazy"/>`
      : `<span class="gear-icon gear-icon--empty"></span>`;

    const badgeHtml = tags.length
      ? `<div class="gear-badges">${tags.join("")}</div>`
      : "";

    return `<div class="gear-row">
      <span class="gear-slot">${esc(slotDef.label)}</span>
      ${iconHtml}
      <span class="gear-name">${esc(displayName)}</span>
      ${badgeHtml}
    </div>`;
  }

  const leftRows = GEAR_COL_LEFT.map(renderItemRow).filter(Boolean).join("");
  const rightRows = GEAR_COL_RIGHT.map(renderItemRow).filter(Boolean).join("");

  const cons = [];
  for (const [key, label] of [
    ["flask", "Flask"],
    ["potion", "Potion"],
    ["food", "Food"],
    ["augmentation", "Augment"],
  ]) {
    if (consumables[key])
      cons.push(
        `<span class="gear-con"><b>${label}</b> ${esc(toTitleCase(consumables[key]))}</span>`,
      );
  }
  if (consumables.temporary_enchant) {
    // temporary_enchant may be "main_hand:oil_name/off_hand:oil_name" — strip slot prefixes
    const label = consumables.temporary_enchant
      .split("/")
      .map((p) => toTitleCase(p.replace(/^(main_hand|off_hand):/, "")))
      .join(" / ");
    cons.push(`<span class="gear-con"><b>Oils</b> ${esc(label)}</span>`);
  }

  const consHtml = cons.length
    ? `<div class="gear-cons-bar">${cons.join('<span class="gear-con-sep"></span>')}</div>`
    : "";

  return `<div class="gear-display report-card">
  <h3>Gear Profile</h3>
  <p class="section-desc">Equipped gear from profile.simc</p>
  <div class="gear-columns">
    <div class="gear-col">${leftRows}</div>
    <div class="gear-col">${rightRows}</div>
  </div>
  ${consHtml}
</div>`;
}

function renderFooter() {
  return `<footer>
  <p>Generated by <a href="https://github.com/taherbert/dh-apl">dh-apl</a></p>
</footer>`;
}

// --- Utilities ---

function fmtDps(n) {
  return Math.round(n).toLocaleString("en-US");
}

function fmtDelta(n) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function esc(s) {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const COPY_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3 10.5V3a1.5 1.5 0 0 1 1.5-1.5H11"/></svg>`;

const TREE_STYLES = {
  aldrachi_reaver: {
    cls: "ar",
    abbr: "AR",
    color: "#fb923c",
    fill: "rgba(251, 146, 60, 0.15)",
  },
  annihilator: {
    cls: "anni",
    abbr: "Anni",
    color: "#a78bfa",
    fill: "rgba(167, 139, 250, 0.15)",
  },
  fel_scarred: {
    cls: "fs",
    abbr: "FS",
    color: "#a78bfa",
    fill: "rgba(167, 139, 250, 0.15)",
  },
};

function treeStyle(heroTree) {
  const key = (heroTree || "").toLowerCase().replace(/[\s-]/g, "_");
  return (
    TREE_STYLES[key] || {
      cls: "other",
      abbr: key.slice(0, 2).toUpperCase(),
      color: "#94a3b8",
      fill: "rgba(148, 163, 184, 0.15)",
    }
  );
}

function treeClass(heroTree) {
  return treeStyle(heroTree).cls;
}
function treeAbbr(heroTree) {
  return treeStyle(heroTree).abbr;
}
function treeColor(heroTree) {
  return treeStyle(heroTree).color;
}
function treeFill(heroTree) {
  return treeStyle(heroTree).fill;
}

function scenarioLabel(s) {
  return s === "weighted" ? "Weighted" : SCENARIOS[s].name;
}

function scenarioColor(s) {
  const colors = {
    st: "#60a5fa",
    dungeon_route: "#a78bfa",
    small_aoe: "#f59e0b",
    big_aoe: "#ef4444",
  };
  return colors[s] || "#7c8098";
}

function findBest(builds, field) {
  if (!builds.length) return null;
  return builds.reduce(
    (a, b) => ((b.dps[field] || 0) > (a.dps[field] || 0) ? b : a),
    builds[0],
  );
}

function activeScenarios(builds) {
  return Object.keys(SCENARIOS).filter((s) =>
    builds.some((b) => (b.dps[s] || 0) > 0),
  );
}

function copyBtn(hash) {
  if (!hash) return "";
  return ` <button class="copy-hash" data-hash="${esc(hash)}" title="Copy talent hash">${COPY_ICON}</button>`;
}

function computeWeighted(dpsRow) {
  return Object.keys(SCENARIOS).reduce(
    (sum, s) => sum + (dpsRow[s] || 0) * (SCENARIO_WEIGHTS[s] || 0),
    0,
  );
}

function allDpsKeys() {
  return [...Object.keys(SCENARIOS), "weighted"];
}

function renderTreeFilterBtns(heroTrees) {
  return Object.entries(heroTrees)
    .map(
      ([key, val]) =>
        `<button class="filter-btn" data-tree="${esc(key)}">${esc(val.displayName)}</button>`,
    )
    .join("\n      ");
}

// --- CSS ---

const CSS = `
:root {
  --bg: #0c0e14;
  --bg-elevated: #10121a;
  --surface: #161822;
  --surface-alt: #1a1d2a;
  --border: #252838;
  --border-subtle: #1e2130;
  --fg: #e4e6f0;
  --fg-dim: #c0c3d4;
  --fg-muted: #7c8098;
  --accent: #7b93ff;
  --accent-dim: #3d4f8a;
  --accent-glow: rgba(123, 147, 255, 0.12);
  --positive: #34d399;
  --positive-bg: rgba(52, 211, 153, 0.07);
  --negative: #fb7185;
  --negative-bg: rgba(251, 113, 133, 0.07);
  --gold: #f5c842;
  --gold-bg: rgba(245, 200, 66, 0.08);
  --anni: #a78bfa;
  --anni-glow: rgba(167, 139, 250, 0.10);
  --ar: #fb923c;
  --ar-glow: rgba(251, 146, 60, 0.10);
  --fs: var(--anni);
  --fs-glow: var(--anni-glow);
  --radius: 10px;
  --radius-sm: 6px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: "DM Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.6;
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 2rem;
  -webkit-font-smoothing: antialiased;
}

/* Header */
header {
  padding: 3rem 0 1.75rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2.5rem;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 1rem;
}

header h1 {
  font-family: "Outfit", sans-serif;
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  background: linear-gradient(135deg, var(--accent) 0%, var(--anni) 60%, var(--ar) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  font-family: "Outfit", sans-serif;
  color: var(--fg-muted);
  font-size: 0.85rem;
  font-weight: 400;
  margin-top: 0.15rem;
  letter-spacing: 0.01em;
}

.header-meta {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  color: var(--fg-muted);
  font-size: 0.78rem;
}

/* Section basics */
section { margin-bottom: 1.5rem; }

h2 {
  font-family: "Outfit", sans-serif;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding-bottom: 0.6rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}

h3 {
  font-family: "Outfit", sans-serif;
  font-size: 0.95rem;
  font-weight: 600;
  margin: 1.5rem 0 0.75rem;
  color: var(--fg);
}

h4 {
  font-family: "Outfit", sans-serif;
  font-size: 0.82rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.section-desc {
  color: var(--fg-muted);
  font-size: 0.8rem;
  margin-bottom: 1.25rem;
  line-height: 1.5;
}

.subsection { margin-bottom: 1.5rem; }

/* Top Build Cards */
.top-build-cards { }

.tbc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}

.tbc-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
}

.tbc-tree {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}

.tbc-dps {
  font-family: "Outfit", sans-serif;
  font-size: 1.5rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  margin-bottom: 0.25rem;
}

.tbc-name {
  font-size: 0.78rem;
  color: var(--fg-muted);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}

.tbc-name:hover .copy-hash { opacity: 1; }

.tbc-scenarios {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.35rem;
}

.tbc-scenario {
  font-variant-numeric: tabular-nums;
  font-size: 0.75rem;
  font-weight: 600;
}

.tbc-scenario-label {
  display: block;
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 500;
  margin-bottom: 0.05em;
}

.tbc-count {
  font-size: 0.72rem;
  color: var(--fg-muted);
}

/* Shared card pattern */
.report-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
}
.report-card h3 {
  font-family: "Outfit", sans-serif;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--fg);
  margin: 0 0 0.25rem;
}
.report-card .section-desc {
  color: var(--fg-muted);
  font-size: 0.78rem;
  margin: 0 0 1rem;
}

/* Analysis Row: heatmap left, comparison panels right */
.analysis-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: stretch;
}

.analysis-left, .analysis-right {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* Gear section: gear + stat weights side by side */
.gear-section-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: stretch;
}

/* Talent Heatmap */
.talent-heatmap { }

.heatmap-spec-panel {
  /* card styles inherited from .report-card */
}

.heatmap-svg {
  width: 100%;
  height: auto;
  max-height: 520px;
}

.heatmap-edge {
  stroke: var(--border);
  stroke-width: 1.5;
}

.heatmap-node-group {
  cursor: pointer;
}

.heatmap-node-group:hover .heatmap-node {
  stroke: var(--fg-muted);
}

.heatmap-node {
  fill: var(--surface-alt);
  stroke: var(--fg-muted);
  stroke-width: 2;
  transition: stroke 0.15s;
}

.heatmap-node.heatmap-universal {
  fill: var(--surface-alt);
  stroke: var(--positive);
  stroke-width: 2;
}

.heatmap-node.heatmap-nodata {
  fill: var(--surface);
  stroke: var(--border-subtle);
  opacity: 0.35;
}

.heatmap-node.heatmap-defensive {
  fill: var(--surface-alt);
  stroke: var(--fg-muted);
  stroke-width: 2;
}

.heatmap-overlay {
  pointer-events: none;
  fill: transparent;
  transition: fill 0.15s;
}

.heatmap-label {
  fill: var(--fg-muted);
  font-size: 9px;
  text-anchor: middle;
  pointer-events: none;
  font-family: "DM Sans", sans-serif;
}

.heatmap-legend {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 1rem;
  font-size: 0.72rem;
  color: var(--fg-muted);
  flex-wrap: wrap;
}

.heatmap-legend-swatch {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid var(--border);
}

.heatmap-legend-pos { background: rgba(52, 211, 153, 0.5); }
.heatmap-legend-neg { background: rgba(251, 113, 133, 0.5); }
.heatmap-legend-def { background: rgba(251, 113, 133, 0.5); border: 1.5px solid var(--negative); }
.heatmap-legend-uni-swatch {
  background: var(--surface-alt);
  border: 2px solid var(--positive);
}

.heatmap-legend-path {
  background: rgba(52, 211, 153, 0.15);
  border: 1.5px dashed var(--fg-muted);
}

.heatmap-legend-sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  margin: 0 0.3rem;
}

/* Heatmap tooltip */
.heatmap-tooltip {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.75rem;
  font-size: 0.78rem;
  pointer-events: none;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  display: none;
}

.heatmap-tooltip-name {
  font-weight: 600;
  margin-bottom: 0.2rem;
}

.heatmap-tooltip-delta {
  font-variant-numeric: tabular-nums;
}

/* Heatmap controls */
.heatmap-hero-bar {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 1rem;
}

.heatmap-hero-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.3rem 0.65rem;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.heatmap-hero-btn:hover {
  border-color: var(--fg-muted);
  color: var(--fg);
}

.heatmap-hero-btn.active {
  background: var(--surface-alt);
  border-color: var(--accent);
  color: var(--accent);
}

.heatmap-badge {
  fill: var(--fg);
  font-size: 10px;
  font-weight: 700;
  text-anchor: end;
  pointer-events: none;
  font-family: "Outfit", sans-serif;
  font-variant-numeric: tabular-nums;
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 3px;
  opacity: 0;
}

.heatmap-node-group:hover .heatmap-badge,
.heatmap-node-group .heatmap-badge.visible {
  opacity: 1;
}

/* Stat Weights DR Chart */
.sw-chart-svg {
  width: 100%;
  height: auto;
}

.sw-axis-label {
  font-family: "DM Sans", sans-serif;
  font-size: 9px;
  fill: var(--fg-muted);
}

.sw-legend {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}

.sw-legend-item {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  color: var(--fg-dim);
  font-weight: 500;
}

.sw-legend-item b {
  font-weight: 700;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.sw-legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.sw-timestamp {
  color: var(--fg-muted);
  font-size: 0.72rem;
}

/* Dual panel layout */
/* Hero comparison — paired bars with delta */
.hc-legend {
  display: flex;
  gap: 1.5rem;
  margin-top: 0.75rem;
  padding-top: 0.5rem;
}

.hc-legend-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: var(--fg-muted);
  font-weight: 500;
}


.hc-panel {
  /* card styles inherited from .report-card */
  padding: 0.75rem 1.5rem;
  display: flex;
  flex-direction: column;
}

.hc-rows {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
}

.hc-row {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--border-subtle);
}

.hc-row:last-child { border-bottom: none; }

.hc-row--weighted {
  border-top: 1px solid var(--border);
  padding-top: 0.65rem;
  margin-top: 0.15rem;
  background: rgba(228, 230, 240, 0.04);
  border-radius: var(--radius-sm);
  padding: 0.65rem 0.5rem 0.45rem;
}

.hc-label {
  font-size: 0.74rem;
  font-weight: 500;
  text-align: right;
  white-space: nowrap;
}

.hc-row--weighted .hc-label { font-weight: 700; }

.hc-split-track {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.hc-bar-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.hc-split-bar {
  height: 16px;
  border-radius: 3px;
  min-width: 2px;
  transition: opacity 0.15s;
}

.hc-bar-val {
  font-size: 0.74rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.hc-row:hover .hc-split-bar { opacity: 1 !important; }

.hc-delta {
  font-size: 0.7rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

/* Comparison grid (hero bars + apex chart side by side) */
.comparison-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  align-items: stretch;
}

.apex-panel {
  /* card styles inherited from .report-card */
  padding: 0.75rem 1.5rem 1rem;
  display: flex;
  flex-direction: column;
}

.hc-panel h3, .apex-panel h3 {
  font-size: 0.82rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  margin-bottom: 0.75rem;
}

/* Apex SVG chart */
.apex-chart {
  width: 100%;
  flex: 1;
  min-height: 0;
  display: block;
}

.apex-axis-label {
  font-family: "Outfit", sans-serif;
  font-size: 10px;
  fill: var(--fg-muted);
}

.apex-node {
  cursor: default;
  transition: r 0.15s;
}

.apex-point .apex-tooltip {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}

.apex-point:hover .apex-tooltip {
  opacity: 1;
}

.apex-tip-text {
  font-family: "DM Sans", sans-serif;
  font-size: 10px;
  fill: var(--fg);
  font-variant-numeric: tabular-nums;
}


/* Tree badges */
.tree-badge {
  display: inline-block;
  padding: 0.2em 0.6em;
  border-radius: 4px;
  font-family: "Outfit", sans-serif;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.tree-badge.anni { background: rgba(167, 139, 250, 0.13); color: var(--anni); }
.tree-badge.ar { background: rgba(251, 146, 60, 0.13); color: var(--ar); }
.tree-badge.fs { background: rgba(167, 139, 250, 0.13); color: var(--fs); }
.tree-badge.other { background: rgba(148, 163, 184, 0.13); color: #94a3b8; }
.tree-badge.sm { font-size: 0.65rem; padding: 0.15em 0.45em; }

/* Filter bar */
.filter-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.filter-btn {
  font-family: "DM Sans", sans-serif;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  padding: 0.4em 1em;
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.filter-btn:hover { border-color: var(--accent-dim); color: var(--fg); }
.filter-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--fg); }

/* Tables */
.table-wrap {
  overflow-x: auto;
  overflow-y: auto;
  max-height: 70vh;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

th, td {
  padding: 0.55rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--border-subtle);
}

th {
  background: var(--surface);
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
  white-space: nowrap;
  position: sticky;
  top: 0;
  z-index: 2;
}

th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--accent); }
th.sortable.sorted-asc::after { content: " \\25B2"; font-size: 0.6em; }
th.sortable.sorted-desc::after { content: " \\25BC"; font-size: 0.6em; }

th.num, td.num, td.dps-cell { text-align: right; }

tbody tr { background: var(--bg-elevated); }
tbody tr:nth-child(even) { background: var(--surface-alt); }
tbody tr:hover { background: rgba(123, 147, 255, 0.05); }

.dps-cell {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.dps-cell.top-build { background: var(--gold-bg); }

/* Instant styled tooltip */
[data-tip] { position: relative; cursor: default; }
[data-tip]:hover::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 4px);
  right: 0;
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 0.3em 0.55em;
  font-size: 0.7rem;
  font-weight: 500;
  border-radius: 4px;
  white-space: nowrap;
  z-index: 20;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}

.build-name {
  font-weight: 500;
  font-family: "DM Sans", sans-serif;
  font-size: 0.78rem;
  word-break: break-word;
  white-space: nowrap;
}

.archetype-cell {
  color: var(--fg-muted);
  font-size: 0.76rem;
}
/* Copy hash button */
.copy-hash {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid transparent;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0.15em;
  border-radius: 3px;
  vertical-align: middle;
  margin-left: 0.35em;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}
tr:hover .copy-hash, .build-name:hover .copy-hash,
.best-name:hover .copy-hash, .heatmap-top-name:hover .copy-hash, .tbc-name:hover .copy-hash { opacity: 1; }
.copy-hash:hover { color: var(--accent); border-color: var(--border); }
.copy-hash.copied { color: var(--positive); opacity: 1; }
.copy-hash svg { width: 13px; height: 13px; }

/* Badges */
.badge {
  display: inline-block;
  background: var(--gold);
  color: #0c0e14;
  font-family: "Outfit", sans-serif;
  font-size: 0.55rem;
  font-weight: 700;
  padding: 0.1em 0.4em;
  border-radius: 3px;
  vertical-align: middle;
  margin-left: 0.4em;
  letter-spacing: 0.06em;
}

/* Positive / negative */
.positive { color: var(--positive); font-weight: 600; }
.negative { color: var(--negative); font-weight: 600; }

/* Defensive cost strips */
.def-cost-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
}

.def-strip-header {
  padding-left: 3px;
}

.def-strip-header__body {
  display: grid;
  grid-template-columns: 160px 1fr 75px 90px 90px;
  gap: 0 0.75rem;
  padding: 0.35rem 1rem 0.25rem 0.85rem;
}

.def-strip-header__label,
.def-strip__tree-header {
  font-size: 0.68rem;
  color: var(--fg-muted);
  font-weight: 600;
  text-align: right;
}

.def-strip {
  display: flex;
  background: var(--bg-elevated);
  transition: background 0.15s;
}

.def-strip:nth-child(even) { background: var(--surface-alt); }
.def-strip:hover { background: rgba(123, 147, 255, 0.05); }

.def-strip__indicator {
  flex: 0 0 3px;
  align-self: stretch;
}

.def-strip__body {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 160px 1fr 75px 90px 90px;
  align-items: center;
  gap: 0 0.75rem;
  padding: 0.55rem 1rem 0.55rem 0.85rem;
}

.def-strip__name {
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 0.84rem;
  color: var(--fg);
  white-space: nowrap;
}

.def-strip__bar-wrap {
  min-width: 0;
  height: 6px;
  background: var(--border-subtle);
  border-radius: 3px;
  overflow: hidden;
}

.def-strip__bar {
  height: 100%;
  border-radius: 3px;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.def-strip:hover .def-strip__bar { opacity: 1; }

.def-strip__cost {
  font-family: "Outfit", sans-serif;
  font-size: 0.92rem;
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

.def-strip__tree {
  font-size: 0.72rem;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.def-strip__tree--divergent {
  color: var(--fg);
  font-weight: 600;
}

/* Details / collapsible */
details {
  margin-bottom: 1.25rem;
}

summary {
  cursor: pointer;
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.5rem 0;
  color: var(--fg);
  user-select: none;
  transition: color 0.15s;
}

summary:hover { color: var(--accent); }

.detail-count {
  font-family: "DM Sans", sans-serif;
  font-weight: 400;
  font-size: 0.78rem;
  color: var(--fg-muted);
}




/* Gear profile */
.gear-display {
  /* card styles inherited from .report-card */
  overflow: hidden;
  min-width: 0;
}

.gear-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.gear-col {
  display: flex;
  flex-direction: column;
}

.gear-col:first-child { border-right: 1px solid var(--border-subtle); }

.gear-row {
  display: grid;
  grid-template-columns: 78px 24px 1fr;
  grid-template-rows: auto auto;
  gap: 0.15rem 0.5rem;
  padding: 0.4rem 0.85rem;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.15s;
  min-height: 0;
  align-items: center;
}
.gear-slot { grid-column: 1; grid-row: 1; }
.gear-icon { grid-column: 2; grid-row: 1; align-self: center; }
.gear-name { grid-column: 3; grid-row: 1; }

.gear-icon {
  width: 22px;
  height: 22px;
  border-radius: 3px;
  border: 1px solid var(--border);
  object-fit: cover;
  flex-shrink: 0;
}
.gear-icon--empty {
  display: inline-block;
  background: var(--surface-alt);
}

.gear-row:nth-child(even) { background: rgba(255,255,255,0.015); }
.gear-col .gear-row:last-child { border-bottom: none; }
.gear-row:hover { background: rgba(123, 147, 255, 0.04); }

.gear-slot {
  font-family: "Outfit", sans-serif;
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.gear-name {
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 0.78rem;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.gear-badges {
  grid-column: 2 / -1;
  grid-row: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.gear-anno {
  font-family: "DM Sans", sans-serif;
  font-size: 0.55rem;
  font-weight: 600;
  white-space: nowrap;
  padding: 0.1em 0.4em;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
}

.gear-anno--gem { color: var(--positive); border-color: rgba(52, 211, 153, 0.25); }
.gear-anno--enchant { color: var(--accent); border-color: var(--accent-dim); }
.gear-anno--crafted { color: var(--ar); border-color: rgba(251, 146, 60, 0.25); }
.gear-anno--emb { color: var(--anni); border-color: rgba(167, 139, 250, 0.25); }

/* Consumables bar */
.gear-cons-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 0.85rem;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  flex-wrap: wrap;
}

.gear-con {
  font-family: "DM Sans", sans-serif;
  font-size: 0.68rem;
  color: var(--fg-dim);
}

.gear-con b {
  color: var(--fg-muted);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.58rem;
  letter-spacing: 0.03em;
  margin-right: 0.3em;
}

.gear-con-sep {
  width: 1px;
  height: 10px;
  background: var(--border);
  flex-shrink: 0;
}

@media (max-width: 800px) {
  .gear-columns { grid-template-columns: 1fr; }
  .gear-col:first-child { border-right: none; }
}

/* Trinket rankings */
.trinket-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
}

.trinket-list--elim { margin-top: 0.5rem; }

.trinket-strip {
  display: grid;
  grid-template-columns: 32px 1fr 90px 60px;
  align-items: center;
  gap: 0 0.75rem;
  padding: 0.55rem 1rem;
  background: var(--bg-elevated);
  transition: background 0.15s;
}

.trinket-strip:nth-child(even) { background: var(--surface-alt); }
.trinket-strip:hover { background: rgba(123, 147, 255, 0.05); }

.trinket-strip--elim { opacity: 0.5; }
.trinket-strip--ref { opacity: 0.6; border-top: 1px dashed var(--border); margin-top: 4px; }

.trinket-strip__rank {
  font-family: "Outfit", sans-serif;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--fg-muted);
  text-align: center;
}

.trinket-strip__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trinket-strip__name-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.trinket-strip__name {
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 0.84rem;
  color: var(--fg);
  white-space: nowrap;
}

.trinket-strip__tags {
  display: flex;
  gap: 0.3rem;
}

.trinket-tag {
  font-family: "DM Sans", sans-serif;
  font-size: 0.6rem;
  font-weight: 600;
  padding: 0.1em 0.4em;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--surface);
  color: var(--fg-muted);
  border: 1px solid var(--border-subtle);
}

.trinket-tag--use { color: var(--accent); border-color: var(--accent-dim); }
.trinket-tag--passive { color: var(--fg-muted); }
.trinket-tag--raid { color: var(--gold); border-color: rgba(245, 200, 66, 0.25); }
.trinket-tag--dungeon { color: var(--positive); border-color: rgba(52, 211, 153, 0.25); }
.trinket-tag--crafted { color: var(--ar); border-color: rgba(251, 146, 60, 0.25); }

.trinket-strip__bar-wrap {
  height: 5px;
  border-radius: 3px;
  overflow: hidden;
}

.trinket-strip__bar {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  opacity: 0.5;
  transition: opacity 0.15s;
}

.trinket-strip:hover .trinket-strip__bar { opacity: 0.8; }

.trinket-strip__dps {
  font-family: "Outfit", sans-serif;
  font-size: 0.84rem;
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}

.trinket-strip__delta {
  font-size: 0.72rem;
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
}

.trinket-strip__delta--best {
  color: var(--gold);
}

.trinket-details { margin-top: 0.75rem; }

/* Trinket ilvl chart */
.tc-chart {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.tc-legend {
  display: flex;
  gap: 1rem;
  align-items: center;
  padding: 0.55rem 1rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border-subtle);
}

.tc-legend-label {
  font-family: "Outfit", sans-serif;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-right: 0.25rem;
}

.tc-legend-item {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-family: "Outfit", sans-serif;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--fg-dim);
}

.tc-legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.tc-row {
  display: grid;
  grid-template-columns: 28px 1fr 90px 60px;
  align-items: start;
  gap: 0 0.75rem;
  padding: 0.65rem 1rem;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.15s;
}

.tc-row:nth-child(even) { background: var(--surface-alt); }
.tc-row:last-child { border-bottom: none; }
.tc-row:hover { background: rgba(123, 147, 255, 0.05); }

.tc-rank {
  font-family: "Outfit", sans-serif;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--fg-muted);
  text-align: center;
  padding-top: 0.2rem;
}

.tc-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tc-name-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 2px;
}

.tc-name {
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 0.84rem;
  color: var(--fg);
  white-space: nowrap;
}

.tc-bar-track {
  position: relative;
  height: 22px;
  border-radius: 4px;
  overflow: hidden;
}

.tc-bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  border-radius: 4px;
  opacity: 0.85;
  transition: opacity 0.15s;
}

.tc-row:hover .tc-bar { opacity: 1; }

.tc-tooltip {
  position: fixed;
  pointer-events: none;
  z-index: 100;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.7rem;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  font-size: 0.78rem;
  line-height: 1.5;
  opacity: 0;
  transition: opacity 0.1s;
  white-space: nowrap;
}
.tc-tooltip.visible { opacity: 1; }
.tc-tooltip__track {
  font-weight: 700;
  margin-bottom: 0.15rem;
}
.tc-tooltip__dps {
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}
.tc-tooltip__delta {
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
  font-size: 0.72rem;
}

.tc-best-dps {
  font-family: "Outfit", sans-serif;
  font-size: 0.84rem;
  font-weight: 700;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  padding-top: 0.2rem;
  white-space: nowrap;
}

.tc-delta {
  font-size: 0.72rem;
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
  padding-top: 0.2rem;
}

.tc-delta--best { color: var(--gold); }

/* Footer */
footer {
  border-top: 1px solid var(--border);
  padding: 2rem 0;
  text-align: center;
  color: var(--fg-muted);
  font-size: 0.78rem;
}

footer p { margin-bottom: 0.25rem; }
footer a { color: var(--accent); text-decoration: none; }
footer a:hover { text-decoration: underline; }

/* Load animation */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

section, header, footer {
  animation: fadeUp 0.4s ease-out both;
}

section:nth-child(2) { animation-delay: 0.05s; }
section:nth-child(3) { animation-delay: 0.1s; }
section:nth-child(4) { animation-delay: 0.15s; }
section:nth-child(5) { animation-delay: 0.2s; }
section:nth-child(6) { animation-delay: 0.25s; }
section:nth-child(7) { animation-delay: 0.3s; }
footer { animation-delay: 0.35s; }

/* Responsive */
@media (max-width: 768px) {
  body { padding: 0 1rem; }
  header { flex-direction: column; align-items: flex-start; }
  .analysis-grid { grid-template-columns: 1fr; }
  .gear-section-grid { grid-template-columns: 1fr; }
  .tbc-grid { grid-template-columns: 1fr; }
  .hc-row { grid-template-columns: 70px 1fr 60px; gap: 0.5rem; }
  .comparison-grid { grid-template-columns: 1fr; }
  .def-strip__body, .def-strip-header__body { grid-template-columns: 120px 1fr 65px 75px 75px; gap: 0 0.5rem; }
  table { font-size: 0.72rem; }
  th, td { padding: 0.35rem 0.5rem; }
  .filter-bar { gap: 0.35rem; }
  .build-name { font-size: 0.7rem; }

  .trinket-strip { grid-template-columns: 28px 1fr 75px 50px; gap: 0 0.5rem; padding: 0.45rem 0.75rem; }
  .trinket-strip__name { font-size: 0.76rem; }
  .trinket-strip__dps { font-size: 0.76rem; }
  .tc-row { grid-template-columns: 24px 1fr 75px 50px; padding: 0.5rem 0.6rem; }
  .tc-name { font-size: 0.76rem; }
  .tc-best-dps { font-size: 0.76rem; }
}
`;

// --- Interactive JS ---

const JS = `
// Talent heatmap interactivity
(() => {
  const section = document.querySelector('.talent-heatmap');
  if (!section) return;

  function getDataKey(tree) {
    const prefix = tree.toLowerCase().replace(/\\s+/g, '-');
    return (prefix + '-weighted').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  // Hero tree toggle
  section.querySelectorAll('.heatmap-hero-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      section.querySelectorAll('.heatmap-hero-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      section.dataset.activeTree = btn.dataset.heroTree;
      updateHeatmapColors();
    });
  });

  // Tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'heatmap-tooltip';
  tooltip.innerHTML = '<div class="heatmap-tooltip-name"></div><div class="heatmap-tooltip-delta"></div>';
  document.body.appendChild(tooltip);

  section.querySelectorAll('.heatmap-node-group').forEach(g => {
    const node = g.querySelector('.heatmap-node');
    g.addEventListener('mouseenter', e => {
      const name = g.dataset.name;
      const tree = section.dataset.activeTree || 'all';
      const dataKey = getDataKey(tree);
      const delta = node.dataset[dataKey];
      const uniKey = (tree.toLowerCase().replace(/\\s+/g, '-') + '-universal')
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const isUni = node.dataset[uniKey] === '1';
      tooltip.querySelector('.heatmap-tooltip-name').textContent = name;
      const deltaEl = tooltip.querySelector('.heatmap-tooltip-delta');
      if (isUni || node.classList.contains('heatmap-universal')) {
        deltaEl.textContent = 'Universal - taken by all builds';
        deltaEl.style.color = 'var(--positive)';
      } else if (node.dataset.defensive === '1') {
        const cost = Number(node.dataset.cost || 0);
        deltaEl.textContent = 'Defensive - costs ' + Math.abs(cost).toFixed(2) + '% DPS';
        deltaEl.style.color = 'var(--negative)';
      } else if (delta !== undefined) {
        const n = Number(delta);
        const sign = n >= 0 ? '+' : '';
        deltaEl.textContent = sign + Number(n).toLocaleString() + ' DPS';
        deltaEl.style.color = n >= 0 ? 'var(--positive)' : 'var(--negative)';
      } else {
        deltaEl.textContent = 'Not taken by any build';
        deltaEl.style.color = 'var(--fg-muted)';
      }
      tooltip.style.display = 'block';
    });
    g.addEventListener('mousemove', e => {
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY - tooltip.offsetHeight - 8) + 'px';
    });
    g.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  });

  function updateHeatmapColors() {
    const tree = section.dataset.activeTree || 'all';
    const dataKey = getDataKey(tree);
    const uniKey = (tree.toLowerCase().replace(/\\s+/g, '-') + '-universal')
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    // Collect all non-special deltas for this tree+scenario
    const nodeGroups = section.querySelectorAll('.heatmap-node-group');
    let maxAbs = 1;
    nodeGroups.forEach(g => {
      const node = g.querySelector('.heatmap-node');
      if (node.dataset.defensive === '1') return;
      if (node.dataset[uniKey] === '1' || node.classList.contains('heatmap-universal')) return;
      const v = Math.abs(Number(node.dataset[dataKey] || 0));
      if (v > maxAbs) maxAbs = v;
    });

    nodeGroups.forEach(g => {
      const node = g.querySelector('.heatmap-node');
      const overlay = g.querySelector('.heatmap-overlay');
      const badge = g.querySelector('.heatmap-badge');
      if (badge) badge.textContent = '';
      if (badge) badge.classList.remove('visible');

      const isTreeUni = node.dataset[uniKey] === '1';
      const isGlobalUni = node.classList.contains('heatmap-universal');

      // Update universal class dynamically per-tree
      if (isTreeUni && tree !== 'all') {
        node.style.stroke = 'var(--positive)';
      } else if (isGlobalUni) {
        node.style.stroke = '';
      } else {
        node.style.stroke = '';
      }

      if (isTreeUni || isGlobalUni) {
        if (overlay) overlay.style.fill = 'transparent';
        return;
      }
      if (node.classList.contains('heatmap-nodata')) {
        if (overlay) overlay.style.fill = 'transparent';
        return;
      }
      if (node.dataset.defensive === '1') {
        const cost = Math.abs(Number(node.dataset.cost || 0));
        const t = Math.min(cost / 3, 1);
        if (overlay) overlay.style.fill = 'rgba(251, 113, 133, ' + (0.15 + t * 0.35).toFixed(2) + ')';
        if (badge) {
          badge.textContent = '-' + cost.toFixed(1) + '%';
          badge.classList.add('visible');
          badge.style.fill = 'var(--negative)';
        }
        return;
      }

      const raw = Number(node.dataset[dataKey] || 0);
      const absVal = Math.abs(raw);
      const power = Math.min(absVal / maxAbs, 1);

      // Check if this is a "path node" (delta inherited from downstream)
      const pathPrefix = tree.toLowerCase().replace(/\\s+/g, '-');
      const pathKey = (pathPrefix + '-path').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const isPath = node.dataset[pathKey] === '1';

      // Path nodes: gray wash + dashed border to distinguish from intrinsically strong
      if (isPath) {
        if (overlay) overlay.style.fill = 'rgba(148, 163, 184, 0.4)';
        node.style.strokeDasharray = '5,3';
        node.style.stroke = 'var(--fg-muted)';
        node.style.strokeWidth = '2';
        if (badge) {
          const sign = raw >= 0 ? '+' : '';
          badge.textContent = sign + Math.round(raw).toLocaleString() + ' path';
          badge.classList.add('visible');
          badge.style.fill = 'var(--fg-muted)';
          badge.style.opacity = '0.7';
        }
      } else {
        node.style.strokeDasharray = '';
        node.style.strokeWidth = '';
        if (raw >= 0) {
          const a = power * 0.55;
          if (overlay) overlay.style.fill = a > 0.05 ? 'rgba(52, 211, 153, ' + a.toFixed(2) + ')' : 'transparent';
          node.style.stroke = power > 0.3 ? 'var(--positive)' : '';
        } else {
          const a = power * 0.45;
          if (overlay) overlay.style.fill = a > 0.05 ? 'rgba(251, 113, 133, ' + a.toFixed(2) + ')' : 'transparent';
          node.style.stroke = power > 0.3 ? 'var(--negative)' : '';
        }
        if (badge && absVal > 0) {
          const sign = raw >= 0 ? '+' : '';
          badge.textContent = sign + Math.round(raw).toLocaleString();
          badge.classList.add('visible');
          badge.style.fill = raw >= 0 ? 'var(--positive)' : 'var(--negative)';
          badge.style.opacity = '';
        }
      }
    });
  }

  updateHeatmapColors();
})();

// Table sorting
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const table = th.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const col = th.dataset.col;
    const isNum = th.classList.contains('num');

    const wasAsc = th.classList.contains('sorted-asc');
    table.querySelectorAll('th.sortable').forEach(h => {
      h.classList.remove('sorted-asc', 'sorted-desc');
    });
    const dir = wasAsc ? 'desc' : 'asc';
    th.classList.add('sorted-' + dir);

    const headers = Array.from(th.parentNode.children);
    const colIdx = headers.indexOf(th);

    rows.sort((a, b) => {
      const cellA = a.children[colIdx];
      const cellB = b.children[colIdx];
      let va, vb;

      if (isNum) {
        va = parseFloat(cellA?.textContent?.replace(/[^\\d.-]/g, '') || '0');
        vb = parseFloat(cellB?.textContent?.replace(/[^\\d.-]/g, '') || '0');
      } else {
        va = cellA?.textContent?.trim() || '';
        vb = cellB?.textContent?.trim() || '';
      }

      if (dir === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
      return va < vb ? 1 : va > vb ? -1 : 0;
    });

    for (const row of rows) tbody.appendChild(row);

    // Re-apply active hero tree filter after sort
    const activeFilter = table.closest('section')?.querySelector('.filter-btn.active');
    if (activeFilter && activeFilter.dataset.tree !== 'all') {
      const tree = activeFilter.dataset.tree;
      rows.forEach(row => {
        row.style.display = row.dataset.tree === tree ? '' : 'none';
      });
    }
  });
});

// Hero tree filter (rankings section)
document.querySelectorAll('#rankings .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tree = btn.dataset.tree;
    const table = document.getElementById('rankings-table');
    if (!table) return;

    btn.closest('.filter-bar').querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    table.querySelectorAll('tbody tr').forEach(row => {
      if (tree === 'all' || row.dataset.tree === tree) {
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    });
  });
});

// Copy talent hash to clipboard
document.querySelectorAll('.copy-hash').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const hash = btn.dataset.hash;
    if (!hash) return;

    const doCopy = text => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      }
      return fallbackCopy(text);
    };

    const fallbackCopy = text => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    };

    function flash(el) {
      el.classList.add('copied');
      el.querySelector('svg').innerHTML = '<polyline points="4 8.5 6.5 11 12 5" stroke-width="2"/>';
      setTimeout(() => {
        el.classList.remove('copied');
        el.querySelector('svg').innerHTML = '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3 10.5V3a1.5 1.5 0 0 1 1.5-1.5H11"/>';
      }, 1500);
    }

    const result = doCopy(hash);
    if (result && result.then) {
      result.then(() => flash(btn));
    } else {
      flash(btn);
    }
  });
});

// Trinket ilvl chart tooltip
(() => {
  const chart = document.querySelector('.tc-chart');
  if (!chart) return;
  const tooltip = document.createElement('div');
  tooltip.className = 'tc-tooltip';
  document.body.appendChild(tooltip);

  const bestPerIlvl = JSON.parse(chart.dataset.bestPerIlvl || '{}');
  const fmtNum = n => Number(n).toLocaleString();

  function positionTooltip(e) {
    const pad = 12;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    if (x + tw > window.innerWidth - pad) x = e.clientX - tw - pad;
    if (y + th > window.innerHeight - pad) y = e.clientY - th - pad;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  chart.addEventListener('mouseover', e => {
    const bar = e.target.closest('.tc-bar');
    if (!bar) return;
    const ilvl = bar.dataset.ilvl;
    const dps = Number(bar.dataset.dps);
    const track = bar.dataset.track;
    const best = bestPerIlvl[ilvl] || dps;
    const deltaPct = best > 0 ? ((dps - best) / best * 100).toFixed(1) : '0.0';
    const deltaStr = dps >= best ? 'best' : deltaPct + '%';
    const deltaClass = dps >= best ? 'style="color:var(--gold)"' : '';

    tooltip.innerHTML =
      '<div class="tc-tooltip__track" style="color:' + bar.style.background + '">' +
        (track || 'ilvl') + ' ' + ilvl +
      '</div>' +
      '<div class="tc-tooltip__dps">' + fmtNum(dps) + ' DPS</div>' +
      '<div class="tc-tooltip__delta" ' + deltaClass + '>' + deltaStr + ' at this tier</div>';
    tooltip.classList.add('visible');
    positionTooltip(e);
  });

  chart.addEventListener('mousemove', e => {
    if (!tooltip.classList.contains('visible')) return;
    positionTooltip(e);
  });

  chart.addEventListener('mouseout', e => {
    const bar = e.target.closest('.tc-bar');
    if (!bar) return;
    if (!e.relatedTarget || !e.relatedTarget.closest('.tc-bar')) {
      tooltip.classList.remove('visible');
    }
  });
})();

`;

// --- Auto-populate missing gear phases ---

async function autoRunMissingGearPhases() {
  const db = getDb();
  const spec = getSpecName();

  if (!getSessionState("gear_scale_factors")) {
    console.warn(
      "  Warning: No scale factors found — cannot auto-run gear phases. Run: npm run gear:run",
    );
    return;
  }

  const trinketScreens = db
    .prepare(
      "SELECT COUNT(*) as n FROM gear_results WHERE spec = ? AND phase = 5 AND slot = 'trinkets_screen'",
    )
    .get(spec).n;
  const embPairs = db
    .prepare(
      "SELECT COUNT(*) as n FROM gear_results WHERE spec = ? AND phase = 7 AND combination_type = 'embellishments'",
    )
    .get(spec).n;
  const ilvlRows = db
    .prepare("SELECT COUNT(*) as n FROM gear_ilvl_results WHERE spec = ?")
    .get(spec).n;

  const missing = [];
  if (!trinketScreens)
    missing.push({
      label: "trinket combinations",
      args: ["combinations", "--type", "trinkets"],
    });
  if (!embPairs)
    missing.push({
      label: "embellishment combinations",
      args: ["combinations", "--type", "embellishments"],
    });
  if (!ilvlRows)
    missing.push({ label: "trinket ilvl chart", args: ["trinket-chart"] });

  if (missing.length === 0) return;

  console.log(
    `\n  Auto-running ${missing.length} missing gear phase(s) at quick fidelity...`,
  );

  for (const { label, args } of missing) {
    console.log(`    ${label}...`);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["src/sim/gear.js", ...args, "--spec", spec, "--fidelity", "quick"],
          { cwd: ROOT, stdio: "inherit" },
        );
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`exit code ${code}`)),
        );
        child.on("error", reject);
      });
      console.log(`    ${label} done.`);
    } catch (err) {
      console.warn(`    Warning: ${label} failed: ${err.message}`);
    }
  }
}

// --- Validation ---

function validateReportData({
  builds,
  trinketData,
  embellishmentData,
  gearData,
  skipSims,
}) {
  const warnings = [];

  if (!skipSims) {
    const withDps = builds.filter((b) => b.dps?.weighted > 0).length;
    if (withDps === 0)
      warnings.push("No builds have DPS data. Run: npm run report:dashboard");
  }

  if (!gearData?.gear?.size)
    warnings.push(
      "No gear profile data. Check apls/{spec}/profile.simc has item names.",
    );
  if (!trinketData)
    warnings.push(
      "No trinket data. Run: npm run gear:run (phases 5 + trinket-chart)",
    );
  if (!embellishmentData)
    warnings.push("No embellishment data. Run: npm run gear:run (phase 7)");

  for (const w of warnings) console.warn(`  Warning: ${w}`);
}

// --- Main ---

async function main() {
  const specAdapter = await initSpec(parseSpecArg());
  const specName = config.spec.specName;
  const specConfig = specAdapter.getSpecConfig();
  const heroTrees = specConfig.heroTrees;
  const opts = parseArgs();

  console.log(`Generating report for ${specName}...`);

  // Load roster
  const roster = loadRoster();
  if (!roster || roster.builds.length === 0) {
    console.error("No build roster found. Run: npm run roster generate");
    process.exit(1);
  }

  console.log(`  Roster: ${roster.builds.length} builds`);

  // APL paths
  const oursPath = join(aplsDir(), `${specName}.simc`);
  const baselinePath = join(aplsDir(), "baseline.simc");
  const hasBaseline = existsSync(baselinePath);

  if (!existsSync(oursPath)) {
    console.error(`APL not found: ${oursPath}`);
    process.exit(1);
  }

  // Run sims or use cached data
  let reportData;
  let defensiveTalentCosts = { costs: [], refName: "" };
  const defCostPath = join(resultsDir(), "defensive_costs.json");

  if (!opts.skipSims) {
    const fidelityOpts =
      FIDELITY_TIERS[opts.fidelity] || FIDELITY_TIERS.standard;

    console.log(
      `\n  Running sims: ${roster.builds.length} builds x ${Object.keys(SCENARIOS).length} scenarios (${opts.fidelity} fidelity)...`,
    );

    const oursMaps = {};
    const baselineMaps = {};

    for (const scenario of Object.keys(SCENARIOS)) {
      console.log(`\n  --- ${SCENARIOS[scenario].name} ---`);

      console.log(`  Our APL...`);
      oursMaps[scenario] = await runRosterSim(
        roster,
        oursPath,
        scenario,
        "report_ours",
        fidelityOpts,
      );

      if (hasBaseline) {
        console.log(`  Baseline APL...`);
        baselineMaps[scenario] = await runRosterSim(
          roster,
          baselinePath,
          scenario,
          "report_baseline",
          fidelityOpts,
        );
      }
    }

    const buildData = mergeSimResults(
      roster,
      hasBaseline ? baselineMaps : {},
      oursMaps,
    );
    persistSimResults(roster, buildData);
    console.log(`\n  Results cached to DB.`);

    reportData = loadReportData(roster);

    if (specConfig.role === "tank") {
      console.log(`\n  Running defensive talent cost sims...`);
      defensiveTalentCosts = await simDefensiveCosts(
        oursPath,
        fidelityOpts,
        reportData,
        specConfig,
      );
      writeFileSync(defCostPath, JSON.stringify(defensiveTalentCosts, null, 2));
      console.log(
        `  ${defensiveTalentCosts.costs.length} defensive talent costs computed (vs ${defensiveTalentCosts.refName}).`,
      );
    }
  } else {
    console.log("  Loading cached DPS from DB...");
    reportData = loadReportData(roster);
    const withDps = reportData.builds.filter((b) => b.dps.weighted > 0).length;
    console.log(
      `  ${reportData.builds.length} builds loaded (${withDps} with DPS data)`,
    );

    if (specConfig.role === "tank" && existsSync(defCostPath)) {
      defensiveTalentCosts = JSON.parse(readFileSync(defCostPath, "utf-8"));
      console.log(
        `  ${defensiveTalentCosts.costs?.length || 0} cached defensive costs loaded.`,
      );
    }
  }

  // Auto-populate missing gear phases before loading data
  if (!opts.skipSims) {
    await autoRunMissingGearPhases();
  }

  // Load gear candidates once for trinket tags and gear label resolution
  const gearCandidates = loadGearCandidatesFile();

  const gearData = loadGearData(gearCandidates);
  if (gearData) {
    await fetchGearIcons(gearData);
  }

  // Load trinket data from gear pipeline
  const trinketData = loadTrinketData(gearCandidates);
  if (trinketData) {
    const p1 = trinketData.phase1.length;
    const p2 = trinketData.phase2.length;
    const ilvl = trinketData.ilvlRows?.length || 0;
    const parts = [];
    if (p1) parts.push(`${p1} individual`);
    if (p2) parts.push(`${p2} pairs`);
    if (ilvl) parts.push(`${ilvl} ilvl chart`);
    console.log(`  Trinkets: ${parts.join(", ")} loaded from DB.`);
  }

  const embellishmentData = loadEmbellishmentData();
  if (embellishmentData) {
    console.log(
      `  Embellishments: ${embellishmentData.pairs.length} pairs${embellishmentData.nullEmb ? " + null baseline" : ""} loaded from DB.`,
    );
  }

  if (gearData) {
    console.log(`  Gear: ${gearData.gear.size} slots loaded from profile.simc`);
  }

  // Talent heatmap: decode builds and compute per-node DPS contributions
  let talentData = null;
  let nodeContributions = null;
  try {
    const raidbotsTalentsPath = dataFile("raidbots-talents.json");
    if (existsSync(raidbotsTalentsPath)) {
      talentData = JSON.parse(readFileSync(raidbotsTalentsPath, "utf-8"));
      const allNodes = loadFullNodeList();
      talentData.allNodes = allNodes;
      const decodedBuilds = decodeBuildSelections(
        reportData.builds,
        talentData,
      );
      nodeContributions = computeNodeContributions(
        reportData.builds,
        talentData,
        decodedBuilds,
        defensiveTalentCosts,
        Object.keys(heroTrees),
      );
      console.log(
        `  Talent heatmap: ${Object.keys(nodeContributions.all || {}).length} nodes computed`,
      );
    }
  } catch (e) {
    console.warn(`  Talent heatmap skipped: ${e.message}`);
  }

  // Scale factors for stat weight visualization
  let scaleFactors = null;
  try {
    scaleFactors = getSessionState("gear_scale_factors");
    if (!scaleFactors) {
      // Fallback: read from JSON file (worktrees may not have session_state populated)
      const sfPath = join(resultsDir(), "gear_scale_factors.json");
      if (existsSync(sfPath)) {
        const sfData = JSON.parse(readFileSync(sfPath, "utf-8"));
        const sf = sfData?.sim?.players?.[0]?.scale_factors;
        if (sf) {
          scaleFactors = { ...sf, timestamp: sfData.timestamp || "" };
        }
      }
    }
    if (scaleFactors) {
      console.log(
        `  Scale factors: loaded (${Object.keys(scaleFactors).filter((k) => k !== "timestamp").length} stats)`,
      );
    }
  } catch {
    // Not available
  }

  // Warn about missing data (non-fatal — partial reports are still useful)
  validateReportData({
    builds: reportData.builds,
    trinketData,
    embellishmentData,
    gearData,
    skipSims: opts.skipSims,
  });

  // Generate HTML
  const reportDir = join(resultsDir(), "report");
  mkdirSync(reportDir, { recursive: true });

  const html = generateHtml({
    specName,
    builds: reportData.builds,
    apexBuilds: reportData.apexBuilds,
    defensiveTalentCosts,
    heroTrees,
    trinketData,
    embellishmentData,
    gearData,
    talentData,
    nodeContributions,
    scaleFactors,
  });

  const indexPath = join(reportDir, "index.html");
  writeFileSync(indexPath, html);

  console.log(`\nReport written to ${reportDir}/index.html`);
  console.log(`  ${reportData.builds.length} builds in report`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
