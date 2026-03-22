// Generates a self-contained HTML dashboard for VDH APL optimization results.
// Replaces showcase.js with a public-facing report covering build rankings,
// hero tree comparison, talent costs, and optimization history.
//
// Usage: node src/visualize/report.js [options]
//   --skip-sims           Generate from cached DB DPS only (no sims)
//   --fidelity <tier>     quick|standard|confirm (default: standard)

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";

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
import { loadRoster, generateDisplayNames } from "../sim/build-roster.js";
import {
  generateRosterProfilesetContent,
  resolveInputDirectives,
  runProfilesetAsync,
  profilesetResultsToActorMap,
} from "../sim/profilesets.js";
import { runSimAsync } from "../sim/runner.js";
import {
  getDb,
  getSessionState,
  getRosterBuilds,
  updateBuildDps,
  updateBuildSimcDps,
} from "../util/db.js";
import {
  decode as decodeTalentHash,
  removeNodes as removeNodesFromHash,
  addNodes as addNodesToHash,
  loadFullNodeList,
} from "../util/talent-string.js";

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

// Parse damage stats from a SimC JSON player stats array into sorted breakdown.
function parseDamageBreakdown(playerStats) {
  if (!playerStats) return null;
  const abilities = playerStats
    .filter((s) => s.type === "damage" && (s.compound_amount || 0) > 0)
    .map((s) => ({
      name: s.name.replace(/_/g, " "),
      amount: s.compound_amount,
      school: s.school || "physical",
    }))
    .sort((a, b) => b.amount - a.amount);
  if (abilities.length === 0) return null;
  const total = abilities.reduce((sum, a) => sum + a.amount, 0);
  return { abilities, total };
}

// --- Sim execution (profileset mode) ---

async function runRosterSim(roster, aplPath, scenario, label, fidelityOpts) {
  const content = generateRosterProfilesetContent(roster, aplPath);
  const results = await runProfilesetAsync(content, scenario, label, {
    simOverrides: { target_error: fidelityOpts.target_error },
  });
  return profilesetResultsToActorMap(results, roster);
}

// Run single-profile ST sims for the top build of each hero tree.
// Returns a map of heroTree -> { abilities, total, buildName }.
async function simBreakdownBuilds(roster, aplPath, heroTrees) {
  const treeNames = Object.keys(heroTrees);
  const byTree = {};

  for (const build of roster.builds) {
    const tree = build.heroTree;
    if (
      !tree ||
      !treeNames.some((k) => normalizeTree(k) === normalizeTree(tree))
    )
      continue;
    if (!byTree[tree]) byTree[tree] = [];
    byTree[tree].push(build);
  }

  // Pick the top build per tree (by weighted DPS from DB)
  const rawBuilds = getRosterBuilds();
  const dbByHash = new Map(rawBuilds.map((b) => [b.hash, b]));

  const topPerTree = {};
  for (const [tree, builds] of Object.entries(byTree)) {
    const sorted = builds
      .map((b) => ({ ...b, weighted: dbByHash.get(b.hash)?.weighted || 0 }))
      .sort((a, b) => b.weighted - a.weighted);
    if (sorted.length > 0 && sorted[0].hash) topPerTree[tree] = sorted[0];
  }

  const breakdowns = {};
  const rawApl = readFileSync(aplPath, "utf-8");
  const resolvedApl = resolveInputDirectives(rawApl, dirname(aplPath));

  for (const [tree, build] of Object.entries(topPerTree)) {
    const content = resolvedApl.replace(
      /^\s*talents\s*=.*/m,
      `talents=${build.hash}`,
    );

    const tmpPath = join(resultsDir(), `breakdown_${normalizeTree(tree)}.simc`);
    writeFileSync(tmpPath, content);

    try {
      console.log(
        `    ${heroTrees[tree]?.displayName || tree}: ${build.displayName || build.id}`,
      );
      await runSimAsync(tmpPath, "st", {
        simOverrides: { target_error: 1.0 },
      });

      // Parse stats from the JSON output
      const jsonPath = join(
        resultsDir(),
        `breakdown_${normalizeTree(tree)}_st.json`,
      );
      if (existsSync(jsonPath)) {
        const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
        const bd = parseDamageBreakdown(data?.sim?.players?.[0]?.stats);
        if (bd) {
          breakdowns[tree] = {
            ...bd,
            buildName: build.displayName || build.id,
          };
        }
      }
    } catch (e) {
      console.warn(`    Breakdown sim failed for ${tree}: ${e.message}`);
    }
  }

  return breakdowns;
}

function normalizeTree(tree) {
  if (!tree) return "";
  return tree.replace(/[\s-]+/g, "_").toLowerCase();
}

// --- Load all report data ---

function formatBuildName(build) {
  // displayName from the roster already has talent-descriptive names
  // (e.g. "Growing Inferno + Screaming Brutality (KE) #2")
  // Strip any source prefix like "WH: " or "community:raidbots: "
  let name = build.displayName || "";
  name = name.replace(/^(?:WH|IV|RB|community:\w+):\s*/i, "");
  return name || build.id;
}

function communitySourceBadge(build) {
  const raw = build.source || "";
  if (!raw.startsWith("community:")) return "";
  const src = raw.replace(/^community:/, "");
  if (!src) return "";
  return `<span class="badge badge--community">${esc(src)}</span>`;
}

function loadReportData(roster) {
  const rawBuilds = getRosterBuilds();
  const dbByHash = new Map(rawBuilds.map((b) => [b.hash, b]));
  const scenarioKeys = Object.keys(SCENARIOS);

  const builds = roster.builds.map((build) => {
    const db = dbByHash.get(build.hash);
    // Read DPS from DB (fresh after persistSimResults) with roster fallback
    const dps = Object.fromEntries(
      scenarioKeys.map((s) => [s, db?.[`dps_${s}`] || build.lastDps?.[s] || 0]),
    );
    // weighted is recomputed below via applyNormalizedWeights
    dps.weighted = 0;

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

  // Normalized weighting: prevents high-DPS scenarios from dominating
  applyNormalizedWeights(builds.map((b) => b.dps));
  const simcRows = builds.filter((b) => b.simcDps).map((b) => b.simcDps);
  if (simcRows.length > 0) applyNormalizedWeights(simcRows);

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

  const rawContent = readFileSync(profilePath, "utf-8");
  const lines = rawContent.split("\n");
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

  // Build enchant lookup from local gear-candidates.json (no runtime fetch).
  // Primary: candidate labels. Fallback: broad enchantNames map covering all
  // expansion enchants in relevant slots (handles non-candidate enchant_ids).
  const enchantMap = new Map();
  if (gearCandidates) {
    for (const slotData of Object.values(gearCandidates.enchants || {})) {
      for (const c of slotData.candidates || []) {
        if (c.enchant_id && c.label) {
          enchantMap.set(c.enchant_id, c.label);
        }
      }
    }
    for (const [id, name] of Object.entries(
      gearCandidates.enchantNames || {},
    )) {
      const numId = Number(id);
      if (!enchantMap.has(numId)) enchantMap.set(numId, name);
    }
  }

  // Build gem lookup keyed by item_id (SimC gem_id= values are item IDs).
  // Source: gear-candidates gems (name = Raidbots itemName, label = stat description).
  const gemMap = new Map();
  if (gearCandidates) {
    for (const g of gearCandidates.gems || []) {
      if (g.item_id && !gemMap.has(g.item_id)) {
        const name = g.name || g.label || null;
        if (name) gemMap.set(g.item_id, name);
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
  return { gear, consumables, rawContent };
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
  const itemResults = await Promise.allSettled(
    [...ids].map(async (id) => {
      const res = await fetch(`https://nether.wowhead.com/tooltip/item/${id}`);
      if (!res.ok) return { id, icon: null };
      const data = await res.json();
      return { id, icon: data.icon || null };
    }),
  );
  const iconMap = new Map();
  for (const r of itemResults) {
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
  const result = roster.builds.map((build) => {
    const dps = {};
    const simcDps = {};

    for (const s of Object.keys(SCENARIOS)) {
      simcDps[s] = baselineMaps[s]?.get(build.id)?.dps || 0;
      dps[s] = oursMaps[s]?.get(build.id)?.dps || 0;
    }
    // weighted is recomputed below via applyNormalizedWeights
    simcDps.weighted = 0;
    dps.weighted = 0;

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

  applyNormalizedWeights(result.map((b) => b.dps));
  applyNormalizedWeights(result.map((b) => b.simcDps));

  return result;
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

const sanitize = (s) => s.replace(/\./g, "_").replace(/\s+/g, "_");

// --- Talent ablation sims ---

// Find orphaned descendants when removing a node from a build.
// A descendant is orphaned if ALL its prev (parent) nodes are unselected.
function findOrphanedDescendants(removeId, selections, specNodeMap) {
  const orphaned = new Set();
  const removedNode = specNodeMap.get(removeId);
  if (!removedNode?.next) return orphaned;

  // BFS to collect all reachable selected descendants
  const candidates = new Set();
  const queue = [...removedNode.next.filter((id) => selections.has(id))];
  while (queue.length > 0) {
    const id = queue.shift();
    if (candidates.has(id)) continue;
    const node = specNodeMap.get(id);
    if (!node) continue;
    candidates.add(id);
    for (const nextId of node.next || []) {
      if (selections.has(nextId) && !candidates.has(nextId)) queue.push(nextId);
    }
  }

  // Fixpoint: repeatedly mark orphans until stable.
  // Avoids BFS ordering bugs when sibling parents are both being orphaned.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of candidates) {
      if (orphaned.has(id)) continue;
      const node = specNodeMap.get(id);
      const allParentsGone = (node.prev || []).every(
        (pid) => pid === removeId || orphaned.has(pid) || !selections.has(pid),
      );
      if (allParentsGone) {
        orphaned.add(id);
        changed = true;
      }
    }
  }

  return orphaned;
}

// Pick reference builds for ablation: best build + widest Apex 0 build per hero tree
function pickAblationReferences(builds, decodedBuilds, heroTreeKeys) {
  const refs = [];

  for (const tree of heroTreeKeys) {
    const treeBuilds = builds.filter(
      (b) => b.heroTree === tree && b.dps.weighted > 0,
    );
    if (treeBuilds.length === 0) continue;

    // Best build by weighted DPS
    const best = treeBuilds.reduce((a, b) =>
      (b.dps.weighted || 0) > (a.dps.weighted || 0) ? b : a,
    );
    refs.push({ build: best, heroTree: tree, role: "best" });

    // Widest Apex 0 build (most selected spec talents)
    const apex0 = treeBuilds.filter((b) => b.archetype?.startsWith("Apex 0:"));
    if (apex0.length > 0) {
      const widest = apex0.reduce((a, b) => {
        const aSize = decodedBuilds.get(a.id)?.size || 0;
        const bSize = decodedBuilds.get(b.id)?.size || 0;
        return bSize > aSize ? b : a;
      });
      // Only add if different from best
      if (widest.id !== best.id) {
        refs.push({ build: widest, heroTree: tree, role: "wide" });
      }
    }
  }

  return refs;
}

async function simTalentAblation(
  aplPath,
  fidelityOpts,
  reportData,
  talentData,
  heroTreeKeys,
) {
  const allNodes = talentData.allNodes;
  const specNodeMap = new Map(talentData.specNodes.map((n) => [n.id, n]));
  const decodedBuilds = decodeBuildSelections(reportData.builds, talentData);

  const refs = pickAblationReferences(
    reportData.builds,
    decodedBuilds,
    heroTreeKeys,
  );

  if (refs.length === 0) {
    console.log("  No reference builds for ablation.");
    return null;
  }

  // Build ablation variants: for each ref, remove each non-locked spec talent
  const ablationVariants = []; // { refId, heroTree, nodeId, nodeName, orphanedNodes, hash }

  for (const ref of refs) {
    const sel = decodedBuilds.get(ref.build.id);
    if (!sel) continue;

    // Spec talents selected in this build (excluding locked/free nodes like 90912)
    const specSelected = [];
    for (const [nodeId] of sel) {
      const node = specNodeMap.get(nodeId);
      if (!node) continue;
      if (node.id === 90912) continue; // skip filtered node
      if (node.freeNode || node.entryNode) continue;
      specSelected.push(node);
    }

    for (const node of specSelected) {
      const orphaned = findOrphanedDescendants(node.id, sel, specNodeMap);
      const toRemove = new Set([node.id, ...orphaned]);
      // Direct orphans: children of the removed node that are orphaned
      const directOrphans = (node.next || []).filter((id) => orphaned.has(id));
      try {
        const newHash = removeNodesFromHash(ref.build.hash, toRemove, allNodes);
        const nodeName =
          node.entries?.[0]?.name || node.name || `Node ${node.id}`;
        ablationVariants.push({
          refId: ref.build.id,
          heroTree: ref.heroTree,
          nodeId: node.id,
          nodeName,
          orphanedNodes: [...orphaned],
          directOrphans,
          hash: newHash,
          variantName: sanitize(`drop_${node.id}_from_${ref.build.id}`),
        });
      } catch {
        // Skip nodes that produce invalid hashes
      }
    }
  }

  if (ablationVariants.length === 0) {
    console.log("  No ablation variants generated.");
    return null;
  }

  // --- Insertion ablation for untested nodes ---
  // For spec talents not present in ANY reference build, measure the DPS cost
  // of taking them by adding them (dropping the cheapest offensive talent).
  // These ride along in the same profileset sims as removal variants.
  const testedNodeIds = new Set(ablationVariants.map((v) => v.nodeId));
  const insertionVariants = [];

  for (const ref of refs) {
    const sel = decodedBuilds.get(ref.build.id);
    if (!sel) continue;

    // Find spec talents NOT in this build
    const untestedNodes = [];
    for (const node of [...specNodeMap.values()]) {
      if (node.id === 90912) continue;
      if (node.freeNode || node.entryNode) continue;
      if (sel.has(node.id)) continue;
      if (testedNodeIds.has(node.id)) continue;
      untestedNodes.push(node);
    }

    if (untestedNodes.length === 0) continue;

    // Collect removal costs from this ref's variants to find cheapest talent to drop
    const refRemovalVariants = ablationVariants
      .filter((v) => v.refId === ref.build.id && v.orphanedNodes.length === 0)
      .map((v) => ({ nodeId: v.nodeId, nodeName: v.nodeName }));

    // We'll pick the cheapest to drop after sims run. For now, use the first
    // leaf-level talent (no orphans) as the drop candidate. The actual DPS cost
    // comparison happens in computeIntrinsicValues which averages across refs.
    // For insertion, we need ANY valid hash -- drop the last leaf in the build.
    const leafVariants = refRemovalVariants;
    if (leafVariants.length === 0) continue;

    // Pick the leaf at the bottom of the tree (highest posY = deepest)
    const dropCandidate = leafVariants.reduce((best, curr) => {
      const bestNode = specNodeMap.get(best.nodeId);
      const currNode = specNodeMap.get(curr.nodeId);
      return (currNode?.posY || 0) > (bestNode?.posY || 0) ? curr : best;
    });

    for (const node of untestedNodes) {
      // Collect prerequisites not already in the build
      const prereqsNeeded = [];
      const visited = new Set();
      const queue = [node.id];
      while (queue.length > 0) {
        const nid = queue.shift();
        if (visited.has(nid)) continue;
        visited.add(nid);
        const n = specNodeMap.get(nid);
        if (!n) continue;
        if (!sel.has(nid) && nid !== node.id) prereqsNeeded.push(nid);
        for (const prevId of n.prev || []) {
          if (!sel.has(prevId) && specNodeMap.has(prevId)) queue.push(prevId);
        }
      }

      // Total points needed = 1 (the node) + unmet prereqs
      const pointsNeeded = 1 + prereqsNeeded.length;

      // Need enough leaf talents to drop to free pointsNeeded points
      if (pointsNeeded > leafVariants.length) continue;

      // Build the modified hash: add node (+ prereqs), remove drop candidate(s)
      const toAdd = [node.id, ...prereqsNeeded];
      // Drop the N cheapest leaf talents (by tree position -- deepest first)
      const sortedLeaves = leafVariants
        .slice()
        .sort(
          (a, b) =>
            (specNodeMap.get(b.nodeId)?.posY || 0) -
            (specNodeMap.get(a.nodeId)?.posY || 0),
        );
      const toDrop = sortedLeaves.slice(0, pointsNeeded).map((v) => v.nodeId);

      try {
        let newHash = removeNodesFromHash(
          ref.build.hash,
          new Set(toDrop),
          allNodes,
        );
        newHash = addNodesToHash(newHash, toAdd, allNodes);
        const nodeName =
          node.entries?.[0]?.name || node.name || `Node ${node.id}`;
        const variant = {
          refId: ref.build.id,
          heroTree: ref.heroTree,
          nodeId: node.id,
          nodeName,
          orphanedNodes: [],
          directOrphans: toDrop, // Dropped talents whose cost gets subtracted to isolate this node's value
          hash: newHash,
          variantName: sanitize(`insert_${node.id}_into_${ref.build.id}`),
          isInsertion: true,
        };
        ablationVariants.push(variant);
        insertionVariants.push(variant);
        testedNodeIds.add(node.id);
      } catch {
        // Skip nodes that produce invalid hashes
      }
    }
  }

  if (insertionVariants.length > 0) {
    console.log(
      `  Insertion: ${insertionVariants.length} variants (defensive/utility talents)`,
    );
  }

  console.log(
    `  Ablation: ${refs.length} refs, ${ablationVariants.length} variants`,
  );

  // Group variants by heroTree + refId for profileset sims
  const groups = new Map();
  for (const v of ablationVariants) {
    const key = `${v.heroTree}|${v.refId}`;
    if (!groups.has(key)) {
      const ref = refs.find(
        (r) => r.build.id === v.refId && r.heroTree === v.heroTree,
      );
      groups.set(key, { ref, variants: [] });
    }
    groups.get(key).variants.push(v);
  }

  // Run sims: one profileset per group per scenario
  const results = []; // { nodeId, nodeName, heroTree, orphanedNodes, dps: {scenario}, refDps: {scenario} }

  for (const [, { ref, variants }] of groups) {
    const miniRoster = {
      builds: [
        { id: ref.build.id, hash: ref.build.hash },
        ...variants.map((v) => ({ id: v.variantName, hash: v.hash })),
      ],
    };

    const variantByName = new Map(variants.map((v) => [v.variantName, v]));

    for (const scenario of Object.keys(SCENARIOS)) {
      const label = `ablation_${ref.heroTree.replace(/\s+/g, "_")}_${ref.build.id}_${scenario}`;
      console.log(
        `  ${ref.heroTree} / ${ref.role} / ${SCENARIOS[scenario].name} (${variants.length} variants)...`,
      );

      let psResults;
      try {
        const content = generateRosterProfilesetContent(miniRoster, aplPath);
        psResults = await runProfilesetAsync(content, scenario, label, {
          simOverrides: { target_error: fidelityOpts.target_error },
        });
      } catch (e) {
        console.warn(
          `  Ablation sim failed (${ref.heroTree}/${ref.role}/${scenario}): ${e.message?.split("\n")[0]}`,
        );
        continue;
      }

      const refDps = psResults.baseline.dps;

      for (const variant of psResults.variants) {
        const match = variantByName.get(variant.name);
        if (!match) continue;

        let entry = results.find(
          (r) =>
            r.nodeId === match.nodeId &&
            r.heroTree === match.heroTree &&
            r.refId === match.refId,
        );
        if (!entry) {
          entry = {
            nodeId: match.nodeId,
            nodeName: match.nodeName,
            heroTree: match.heroTree,
            refId: match.refId,
            orphanedNodes: match.orphanedNodes,
            directOrphans: match.directOrphans,
            dps: {},
            refDps: {},
            removalCost: {},
          };
          results.push(entry);
        }

        entry.dps[scenario] = variant.dps;
        entry.refDps[scenario] = refDps;
        entry.removalCost[scenario] = refDps - variant.dps;
      }
    }
  }

  // Compute weighted removal costs
  for (const entry of results) {
    entry.dps.weighted = computeWeighted(entry.dps);
    entry.refDps.weighted = computeWeighted(entry.refDps);
    entry.removalCost.weighted = entry.refDps.weighted - entry.dps.weighted;
  }

  return { results, refs };
}

function computeIntrinsicValues(ablationData) {
  if (!ablationData?.results?.length) return null;

  const { results } = ablationData;
  const scenarioKeys = allDpsKeys();

  // Group results by nodeId + heroTree, averaging across refs
  const grouped = new Map(); // `${nodeId}|${heroTree}` -> [entries]
  for (const r of results) {
    const key = `${r.nodeId}|${r.heroTree}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  // Build lookup: nodeId -> averaged removalCost per scenario per heroTree
  const avgRemovalCost = new Map(); // `${nodeId}|${heroTree}` -> { scenario: avgCost }
  for (const [key, entries] of grouped) {
    const avg = {};
    for (const s of scenarioKeys) {
      const costs = entries
        .map((e) => e.removalCost[s])
        .filter((c) => c !== undefined);
      avg[s] =
        costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
    }
    avgRemovalCost.set(key, avg);
  }

  // Compute intrinsic values per hero tree + aggregated "all".
  // Returns { all: { nodeId: {...} }, "Aldrachi Reaver": { nodeId: {...} }, ... }
  const perTree = { all: {} };
  const heroTrees = [...new Set(results.map((r) => r.heroTree))];

  for (const tree of heroTrees) {
    perTree[tree] = {};
    const treeGrouped = new Map();
    for (const [key, entries] of grouped) {
      if (entries[0].heroTree !== tree) continue;
      const nodeId = entries[0].nodeId;
      if (!treeGrouped.has(nodeId)) treeGrouped.set(nodeId, []);
      treeGrouped.get(nodeId).push(...entries);
    }

    for (const [nodeId, entries] of treeGrouped) {
      const intrinsic = {};
      const removalCost = {};
      const intrinsicPct = {};
      const removalCostPct = {};
      const orphanedNodes = new Set();
      for (const e of entries) {
        for (const oid of e.orphanedNodes) orphanedNodes.add(oid);
      }

      for (const s of scenarioKeys) {
        const costs = entries
          .map((e) => e.removalCost[s])
          .filter((c) => c !== undefined);
        const avgCost =
          costs.length > 0
            ? costs.reduce((a, b) => a + b, 0) / costs.length
            : 0;
        removalCost[s] = avgCost;

        // Average refDps for percentage computation
        const refs = entries
          .map((e) => e.refDps[s])
          .filter((r) => r !== undefined && r > 0);
        const avgRef =
          refs.length > 0 ? refs.reduce((a, b) => a + b, 0) / refs.length : 0;

        // Only subtract DIRECT orphans' removal costs (not transitive).
        let directOrphanCost = 0;
        for (const entry of entries) {
          for (const orphanId of entry.directOrphans || []) {
            const orphanKey = `${orphanId}|${tree}`;
            const oc = avgRemovalCost.get(orphanKey)?.[s] || 0;
            directOrphanCost += oc / entries.length;
          }
        }
        intrinsic[s] = avgCost - directOrphanCost;

        // Express as % of reference DPS
        intrinsicPct[s] = avgRef > 0 ? (intrinsic[s] / avgRef) * 100 : 0;
        removalCostPct[s] = avgRef > 0 ? (avgCost / avgRef) * 100 : 0;
      }

      perTree[tree][nodeId] = {
        intrinsic,
        removalCost,
        intrinsicPct,
        removalCostPct,
        orphanedNodes: [...orphanedNodes],
        nodeName: entries[0].nodeName,
      };
    }
  }

  // "all" = average across hero trees
  const allNodeIds = new Set(heroTrees.flatMap((t) => Object.keys(perTree[t])));
  for (const nodeId of allNodeIds) {
    const treeEntries = heroTrees
      .map((t) => perTree[t][nodeId])
      .filter(Boolean);
    if (treeEntries.length === 0) continue;

    const intrinsic = {};
    const removalCost = {};
    const intrinsicPct = {};
    const removalCostPct = {};
    const orphanedNodes = new Set();
    for (const e of treeEntries) {
      for (const oid of e.orphanedNodes) orphanedNodes.add(oid);
    }

    for (const s of scenarioKeys) {
      intrinsic[s] =
        treeEntries.reduce((sum, e) => sum + (e.intrinsic[s] || 0), 0) /
        treeEntries.length;
      removalCost[s] =
        treeEntries.reduce((sum, e) => sum + (e.removalCost[s] || 0), 0) /
        treeEntries.length;
      intrinsicPct[s] =
        treeEntries.reduce((sum, e) => sum + (e.intrinsicPct[s] || 0), 0) /
        treeEntries.length;
      removalCostPct[s] =
        treeEntries.reduce((sum, e) => sum + (e.removalCostPct[s] || 0), 0) /
        treeEntries.length;
    }

    perTree.all[nodeId] = {
      intrinsic,
      removalCost,
      intrinsicPct,
      removalCostPct,
      orphanedNodes: [...orphanedNodes],
      nodeName: treeEntries[0].nodeName,
    };
  }

  return perTree;
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
  heroTreeKeys,
  ablationIntrinsics,
) {
  const specNodes = talentData.specNodes.filter((n) => n.id !== 90912);
  const scenarioKeys = ablationIntrinsics ? allDpsKeys() : ["weighted"];

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

      const treeKey = filterTree || "all";
      const ablation = ablationIntrinsics?.[treeKey]?.[node.id];

      if (hasNode.length === 0 || noNode.length === 0) {
        // Universal or untaken — ablation may still have intrinsic data
        // (removal ablation for universal talents, insertion ablation for untaken)
        const entry = { deltas: null };

        if (ablation) {
          entry.deltas = {};
          entry.pct = {};
          for (const s of scenarioKeys) {
            entry.deltas[s] = ablation.intrinsic[s] || 0;
            entry.pct[s] = ablation.intrinsicPct?.[s] || 0;
          }
        }

        result[node.id] = entry;
        continue;
      }

      const deltas = {};
      if (ablation) {
        // Use ablation intrinsic values instead of cohort-based means
        for (const s of scenarioKeys) {
          deltas[s] = ablation.intrinsic[s] || 0;
        }
      } else {
        // Fallback to cohort-based delta
        for (const s of scenarioKeys) {
          const avgWith =
            hasNode.reduce((sum, b) => sum + (b.dps[s] || 0), 0) /
            hasNode.length;
          const avgWithout =
            noNode.reduce((sum, b) => sum + (b.dps[s] || 0), 0) / noNode.length;
          deltas[s] = avgWith - avgWithout;
        }
      }

      const entry = { deltas };
      if (ablation) {
        entry.pct = {};
        for (const s of scenarioKeys) {
          entry.pct[s] = ablation.intrinsicPct?.[s] || 0;
        }
      } else {
        // Compute pct from cohort-based deltas using average DPS as baseline
        const allBuilds = [...hasNode, ...noNode];
        entry.pct = {};
        for (const s of scenarioKeys) {
          const avgDps =
            allBuilds.reduce((sum, b) => sum + (b.dps[s] || 0), 0) /
            allBuilds.length;
          entry.pct[s] = avgDps > 0 ? (deltas[s] / avgDps) * 100 : 0;
        }
      }
      result[node.id] = entry;
    }
    return result;
  }

  // "all" plus per-hero-tree
  const perTree = { all: computeForFilter(null) };
  for (const tree of heroTreeNames) {
    perTree[tree] = computeForFilter(tree);
  }

  return perTree;
}

// --- HTML generation ---

function generateHtml(data) {
  const {
    specName,
    builds,
    apexBuilds,
    heroTrees,
    trinketData,
    embellishmentData,
    gearData,
    talentData,
    nodeContributions,
    abilityBreakdown,
    hasAblation,
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
      hasAblation,
    ),
    renderBuildRankings(builds, heroTrees),
    renderGearSection(gearData, abilityBreakdown),
    renderTrinketRankings(trinketData),
    renderEmbellishmentRankings(embellishmentData),
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
      <div class="tbc-dps">${fmtDps(best.dps.weighted || 0)}<span class="tbc-dps-label">weighted</span></div>
      <div class="tbc-name">${esc(best.displayName)}${communitySourceBadge(best)}${copyBtn(best.hash)}</div>
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
  hasAblation,
) {
  const heatmap = renderTalentHeatmap(
    builds,
    talentData,
    heroTrees,
    nodeContributions,
    hasAblation,
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

function renderGearSection(gearData, abilityBreakdown) {
  const gearHtml = renderGearDisplay(gearData);
  const abilityHtml = renderAbilityBreakdown(abilityBreakdown);
  if (!gearHtml && !abilityHtml) return "";

  return `<section>
  <div class="gear-section-grid">
    ${gearHtml}
    ${abilityHtml}
  </div>
</section>`;
}

function renderTalentHeatmap(
  builds,
  talentData,
  heroTrees,
  contributions,
  hasAblation,
) {
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
    `<button class="report-tab report-tab--active" data-hero-tree="all">All</button>`,
    ...treeNames.map(
      (t) =>
        `<button class="report-tab" data-hero-tree="${esc(t)}"><span class="tree-badge sm ${treeClass(t)}">${treeAbbr(t)}</span> ${esc(heroTrees[t].displayName)}</button>`,
    ),
  ].join("\n      ");

  // Scenario toggle (only when ablation data provides per-scenario values)
  const scenarioNames = Object.keys(SCENARIOS);
  const scenarioToggles = hasAblation
    ? `<div class="heatmap-scenario-bar">
        <button class="heatmap-scenario-btn active" data-scenario="weighted">Weighted</button>
        ${scenarioNames.map((s) => `<button class="heatmap-scenario-btn" data-scenario="${s}">${esc(SCENARIOS[s].name)}</button>`).join("\n        ")}
      </div>`
    : "";

  const methodLabel = hasAblation
    ? "Ablation-derived intrinsic DPS impact"
    : "Weighted DPS impact per talent";

  const svgPanel = `<div class="heatmap-spec-panel report-card">
    <h3>Talent Heatmap</h3>
    <p class="section-desc">${methodLabel}</p>
    <div class="report-tabs">${heroToggles}</div>
    ${scenarioToggles}
    ${specSvg}
    <div class="heatmap-legend">
      <span class="heatmap-legend-swatch heatmap-legend-pos"></span><span>Positive</span>
      <span class="heatmap-legend-swatch heatmap-legend-neg"></span><span>Negative</span>
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
  const cut = half * 0.3;
  const iconOffset = -half + ICON_INSET;
  const iconSize = NODE_SIZE - ICON_INSET * 2;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  function octagonPoints(x, y) {
    return [
      `${x - half + cut},${y - half}`,
      `${x + half - cut},${y - half}`,
      `${x + half},${y - half + cut}`,
      `${x + half},${y + half - cut}`,
      `${x + half - cut},${y + half}`,
      `${x - half + cut},${y + half}`,
      `${x - half},${y + half - cut}`,
      `${x - half},${y - half + cut}`,
    ].join(" ");
  }

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
    const name = node.entries?.[0]?.name || node.name || `Node ${node.id}`;
    const icon = node.entries?.[0]?.icon;
    const isChoice = node.type === "choice" && !node.isApex;
    const displayName = name.length > 12 ? name.slice(0, 11) + "\u2026" : name;

    // Clip path for icon
    const clipId = `clip-${node.id}`;
    defs += `<clipPath id="${clipId}"><rect x="${(x + iconOffset).toFixed(1)}" y="${(y + iconOffset).toFixed(1)}" width="${iconSize}" height="${iconSize}" rx="5"/></clipPath>`;

    // Per-tree delta data attributes (e.g. data-all-weighted="1234", data-aldrachi-reaver-weighted="567")
    let dataAttrs = "";
    for (const treeKey of allTreeKeys) {
      const tc = contributions[treeKey]?.[node.id];
      const prefix = treeKey.toLowerCase().replace(/\s+/g, "-");
      if (tc?.deltas) {
        dataAttrs += ` data-${prefix}-weighted="${(tc.deltas.weighted || 0).toFixed(0)}"`;
        // Per-scenario deltas for scenario toggle
        for (const s of Object.keys(SCENARIOS)) {
          if (tc.deltas[s] !== undefined) {
            dataAttrs += ` data-${prefix}-${s}="${(tc.deltas[s] || 0).toFixed(0)}"`;
          }
        }
        // Percentage values for display
        if (tc.pct) {
          dataAttrs += ` data-${prefix}-pct="${(tc.pct.weighted || 0).toFixed(2)}"`;
          for (const s of Object.keys(SCENARIOS)) {
            if (tc.pct[s] !== undefined) {
              dataAttrs += ` data-${prefix}-pct-${s}="${(tc.pct[s] || 0).toFixed(2)}"`;
            }
          }
        }
      }
    }

    const noDataCls = !c?.deltas ? " heatmap-nodata" : "";

    // Background shape: octagon for choice, rounded rect for everything else
    const bgShape = isChoice
      ? `<polygon points="${octagonPoints(x, y)}" class="heatmap-node${noDataCls}"${dataAttrs}/>`
      : `<rect x="${(x - half).toFixed(1)}" y="${(y - half).toFixed(1)}" width="${NODE_SIZE}" height="${NODE_SIZE}" rx="8" class="heatmap-node${noDataCls}"${dataAttrs}/>`;

    // Icon image
    const iconImg = icon
      ? `<image href="https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg" x="${(x + iconOffset).toFixed(1)}" y="${(y + iconOffset).toFixed(1)}" width="${iconSize}" height="${iconSize}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`
      : "";

    // Overlay (same shape as background)
    const overlay = isChoice
      ? `<polygon points="${octagonPoints(x, y)}" class="heatmap-overlay"/>`
      : `<rect x="${(x - half).toFixed(1)}" y="${(y - half).toFixed(1)}" width="${NODE_SIZE}" height="${NODE_SIZE}" rx="8" class="heatmap-overlay"/>`;

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

  // Per-template scaling: track each template across its apex ranks,
  // then compute deltas vs that template's own rank 0 baseline.
  // This compares apples to apples (same talent cluster at different apex levels).
  const templateMap = {}; // key: "tree|template" -> { [rank]: avgWeighted }
  for (const rank of ranks) {
    for (const entry of apexBuilds[rank] || []) {
      const key = `${entry.heroTree}|${entry.templateName}`;
      (templateMap[key] ||= { tree: entry.heroTree, ranks: {} }).ranks[rank] =
        entry.avg.weighted;
    }
  }

  // For each template, compute % delta vs its lowest available rank
  const deltasByTreeRank = {}; // key: "tree|rank" -> [pctDelta, ...]
  for (const { tree, ranks: rDps } of Object.values(templateMap)) {
    const availableRanks = Object.keys(rDps)
      .map(Number)
      .sort((a, b) => a - b);
    if (availableRanks.length === 0) continue;
    const baseRank = availableRanks[0];
    const baseDps = rDps[baseRank];
    if (!baseDps) continue;
    for (const rank of ranks) {
      if (rDps[rank] === undefined) continue;
      const pct = ((rDps[rank] - baseDps) / baseDps) * 100;
      const key = `${tree}|${rank}`;
      (deltasByTreeRank[key] ||= []).push(pct);
    }
  }

  // Aggregate: best (max) and average delta per tree per rank
  const gains = {};
  let yMaxRaw = 0;
  let yMinRaw = 0;
  for (const tree of treeNames) {
    gains[tree] = {};
    for (const rank of ranks) {
      const deltas = deltasByTreeRank[`${tree}|${rank}`];
      if (!deltas || deltas.length === 0) continue;
      const bestPct = Math.max(...deltas);
      const avgPct = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      gains[tree][rank] = { bestPct, avgPct, n: deltas.length };
      const hi = Math.max(avgPct, bestPct);
      const lo = Math.min(avgPct, bestPct);
      if (hi > yMaxRaw) yMaxRaw = hi;
      if (lo < yMinRaw) yMinRaw = lo;
    }
  }

  // SVG layout
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

  // Curves + nodes - best (solid + area fill) and avg (dashed, no fill)
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
        yBest: yOf(gains[tree][r].bestPct),
        yAvg: yOf(gains[tree][r].avgPct),
        ...gains[tree][r],
      }));
    if (pts.length < 2) continue;

    const base = yOf(0);

    // Best line - solid stroke + area fill
    const bestLine = pts
      .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.yBest.toFixed(1)}`)
      .join(" ");
    paths += `<path d="${bestLine} L${pts.at(-1).x.toFixed(1)},${base.toFixed(1)} L${pts[0].x.toFixed(1)},${base.toFixed(1)}Z" fill="${fill}"/>`;
    paths += `<path d="${bestLine}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`;

    // Avg line - dashed stroke, no fill
    const avgLine = pts
      .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.yAvg.toFixed(1)}`)
      .join(" ");
    paths += `<path d="${avgLine}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" stroke-dasharray="4,3" opacity="0.7"/>`;

    // Data point nodes - best (solid circle) and avg (open circle)
    for (const p of pts) {
      const bx = p.x.toFixed(1);
      const by = p.yBest.toFixed(1);
      const ay = p.yAvg.toFixed(1);
      points += `<circle cx="${bx}" cy="${by}" r="3.5" fill="var(--bg)" stroke="${color}" stroke-width="1.5"/>`;
      points += `<circle cx="${bx}" cy="${ay}" r="2.5" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="2,2"/>`;
    }
  }

  // HTML legend - tree badges + line style key
  const treeLegend = treeNames
    .map(
      (t) =>
        `<span class="hc-legend-item"><span class="tree-badge sm ${treeClass(t)}">${treeAbbr(t)}</span> ${esc(heroTrees[t].displayName)}</span>`,
    )
    .join("");
  const styleLegend = `<span class="hc-legend-item" style="margin-left:0.75em;opacity:0.7"><svg width="20" height="10" style="vertical-align:middle"><line x1="0" y1="5" x2="20" y2="5" stroke="var(--fg)" stroke-width="1.5"/></svg> Best</span><span class="hc-legend-item"><svg width="20" height="10" style="vertical-align:middle"><line x1="0" y1="5" x2="20" y2="5" stroke="var(--fg)" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.7"/></svg> Avg</span>`;

  return `<div class="apex-panel report-card">
    <h3>Apex Scaling</h3>
    <p class="section-desc">How much DPS does each build gain or lose by investing in apex talents? Each build is compared to itself at its lowest available rank. Solid line shows the best-scaling build; dashed line shows the average across all builds.</p>
    <svg class="apex-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${grid}
      ${xAxis}
      ${paths}
      ${points}
    </svg>
    <div class="hc-legend">${treeLegend}${styleLegend}</div>
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

  function buildTable(subset, tableId) {
    let rows = "";
    for (const b of subset) {
      const isTopW = b.id === topWeighted?.id;
      const wBadge = isTopW ? '<span class="badge">TOP</span>' : "";
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
      const srcBadge = communitySourceBadge(b);
      rows += `<tr data-tree="${esc(b.heroTree)}">
  <td class="build-name">${esc(b.displayName)}${srcBadge}${copyBtn(b.hash)}</td>
  <td><span class="tree-badge sm ${bCls}">${bAbbr}</span></td>
  ${scenarioCells}
  <td class="dps-cell${isTopW ? " top-build" : ""} has-tip"${wTip}>${fmtDps(b.dps.weighted || 0)}${wBadge}</td>
</tr>`;
    }
    return `<div class="table-wrap">
    <table class="roster-table" id="${tableId}">
      <thead><tr>
        <th class="sortable" data-col="name">Build</th>
        <th>Tree</th>
        ${scenarioHeaders}
        <th class="sortable num" data-col="weighted" style="color:var(--fg)">Weighted</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  }

  // Tab buttons: All + per-tree
  const treeKeys = Object.keys(heroTrees);
  const tabBtns = [
    `<button class="report-tab report-tab--active" data-tab="all">All (${builds.length})</button>`,
    ...treeKeys.map(
      (key) =>
        `<button class="report-tab" data-tab="${esc(key)}">${esc(heroTrees[key].displayName)}</button>`,
    ),
  ].join("\n    ");

  // Panes: All + per-tree
  const allPane = `<div class="report-pane report-pane--active" data-pane="all">${buildTable(sorted, "rankings-table")}</div>`;
  const treePanes = treeKeys
    .map((key) => {
      const treeBuilds = sorted.filter((b) => b.heroTree === key);
      return `<div class="report-pane" data-pane="${esc(key)}">${buildTable(treeBuilds, `rankings-table-${key.replace(/\s+/g, "-")}`)}</div>`;
    })
    .join("\n  ");

  return `<section id="rankings">
  <div class="report-card" data-tab-group="rankings">
  <h3>Build Rankings</h3>
  <p class="section-desc">Weighted = ${weightLegend}</p>
  <div class="report-tabs">
    ${tabBtns}
  </div>
  ${allPane}
  ${treePanes}
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

  // Build individual trinket content (ilvl chart or phase1 strips)
  let individualHtml = "";
  if (ilvlRows?.length > 0) {
    individualHtml = renderTrinketIlvlChart(ilvlRows, tagMap, ilvlTierConfig);
  } else if (phase1.length > 0) {
    const active = phase1.filter((r) => !r.eliminated);
    const elim = phase1.filter((r) => r.eliminated);
    const maxDps = phase1[0].weighted;
    const top5 = active.slice(0, 5);
    const rest = [...active.slice(5), ...elim];
    const moreHtml =
      rest.length > 0
        ? `<details class="trinket-details">
        <summary>More trinkets <span class="detail-count">(${rest.length})</span></summary>
        <div class="trinket-list trinket-list--elim">${renderStrips(rest, true, maxDps)}</div>
      </details>`
        : "";
    individualHtml = `<p class="section-desc">Weighted DPS per trinket slot (single-slot screen, best build).</p>
      <div class="trinket-list">${renderStrips(top5, true, maxDps)}</div>
      ${moreHtml}`;
  }

  // Build pairs content — clear eliminated flag since all pairs are ranked results
  let pairsHtml = "";
  if (phase2.length > 0) {
    const pairs = phase2.map((r) => ({ ...r, eliminated: 0 }));
    const maxDps = pairs[0].weighted || 1;
    const topPairs = pairs.slice(0, 5);
    const morePairs = pairs.slice(5);
    const moreHtml =
      morePairs.length > 0
        ? `<details class="trinket-details">
        <summary>More pairs <span class="detail-count">(${morePairs.length})</span></summary>
        <div class="trinket-list">${renderStrips(morePairs, false, maxDps)}</div>
      </details>`
        : "";
    pairsHtml = `<p class="section-desc">Exhaustive pairing of top trinket candidates, ranked by weighted DPS.</p>
      <div class="trinket-list">${renderStrips(topPairs, false, maxDps)}</div>
      ${moreHtml}`;
  }

  if (!individualHtml && !pairsHtml) return "";

  // Single card with toggle between Individual and Pairs
  const hasIndividual = !!individualHtml;
  const hasPairs = !!pairsHtml;
  const hasBoth = hasIndividual && hasPairs;

  const toggleBtns = hasBoth
    ? `<div class="report-tabs">
        <button class="report-tab report-tab--active" data-tab="individual">Individual</button>
        <button class="report-tab" data-tab="pairs">Pairs</button>
      </div>`
    : "";

  const individualPane = hasIndividual
    ? `<div class="report-pane report-pane--active" data-pane="individual">${individualHtml}</div>`
    : "";
  const pairsPane = hasPairs
    ? `<div class="report-pane${hasBoth ? "" : " report-pane--active"}" data-pane="pairs">${pairsHtml}</div>`
    : "";

  return `<section>
  <div class="report-card" data-tab-group="trinkets">
    <h3>Trinket Rankings</h3>
    ${toggleBtns}
    ${individualPane}
    ${pairsPane}
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
  // Show top 10 by weighted DPS regardless of eliminated status
  const sorted = [...pairs].sort(
    (a, b) => (b.weighted || 0) - (a.weighted || 0),
  );
  const topActive = sorted.slice(0, 10);
  const remaining = sorted.slice(10);

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
        const elimCls = isActive
          ? ""
          : r.eliminated === 1
            ? " trinket-strip--elim"
            : "";
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
    <div class="trinket-strip__delta">baseline</div>
  </div>`
    : "";

  const moreHtml =
    remaining.length > 0
      ? `<details class="trinket-details">
      <summary>More embellishments <span class="detail-count">(${remaining.length})</span></summary>
      <div class="trinket-list trinket-list--elim">${renderEmbStrips(remaining, false)}</div>
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

function renderAbilityBreakdown(abilityBreakdown) {
  // Accepts either a single breakdown { abilities, total } or
  // a per-tree map { treeName: { abilities, total, buildName } }
  if (!abilityBreakdown) return "";

  const SCHOOL_COLORS = {
    physical: "#b0895f",
    fire: "#ef4444",
    shadow: "#9333ea",
    chaos: "#a855f7",
    shadowflame: "#c026d3",
    nature: "#22c55e",
    arcane: "#6366f1",
    frost: "#38bdf8",
    holy: "#fbbf24",
  };

  function renderBars(abilities, total) {
    if (!abilities?.length || !total) return "";
    return abilities
      .map((a) => {
        const pct = ((a.amount / total) * 100).toFixed(1);
        const barW = ((a.amount / abilities[0].amount) * 100).toFixed(1);
        const color = SCHOOL_COLORS[a.school] || "var(--fg-muted)";
        const label = toTitleCase(a.name);
        return `<div class="ab-row">
          <span class="ab-label">${esc(label)}</span>
          <div class="ab-track"><div class="ab-fill" style="width:${barW}%;background:${color}"></div></div>
          <span class="ab-value">${pct}%</span>
        </div>`;
      })
      .join("");
  }

  // Single breakdown (legacy: from report_ours_st.json base profile)
  if (abilityBreakdown.abilities) {
    const bars = renderBars(abilityBreakdown.abilities, abilityBreakdown.total);
    if (!bars) return "";
    return `<div class="ability-breakdown report-card">
  <h3>Damage Breakdown</h3>
  <p class="section-desc">Share of total damage by ability (reference build, single target)</p>
  <div class="ab-rows">${bars}</div>
</div>`;
  }

  // Per-tree breakdown map
  const trees = Object.entries(abilityBreakdown).filter(
    ([, v]) => v?.abilities?.length,
  );
  if (trees.length === 0) return "";

  // Single tree -- no tabs needed
  if (trees.length === 1) {
    const [, data] = trees[0];
    const bars = renderBars(data.abilities, data.total);
    if (!bars) return "";
    const desc = data.buildName
      ? `Share of total damage by ability (${esc(data.buildName)}, single target)`
      : `Share of total damage by ability (reference build, single target)`;
    return `<div class="ability-breakdown report-card">
  <h3>Damage Breakdown</h3>
  <p class="section-desc">${desc}</p>
  <div class="ab-rows">${bars}</div>
</div>`;
  }

  // Multiple trees -- tabbed
  const tabButtons = trees
    .map(
      ([tree], i) =>
        `<button class="report-tab${i === 0 ? " report-tab--active" : ""}" data-tab="${esc(tree)}">${esc(toTitleCase(tree.replace(/_/g, " ")))}</button>`,
    )
    .join("");

  const panes = trees
    .map(([tree, data], i) => {
      const bars = renderBars(data.abilities, data.total);
      const desc = data.buildName
        ? `${esc(data.buildName)}, single target`
        : `Single target`;
      return `<div class="report-pane${i === 0 ? " report-pane--active" : ""}" data-pane="${esc(tree)}">
        <p class="section-desc">${desc}</p>
        <div class="ab-rows">${bars}</div>
      </div>`;
    })
    .join("");

  return `<div class="ability-breakdown report-card" data-tab-group="breakdown">
  <h3>Damage Breakdown</h3>
  <div class="report-tabs">${tabButtons}</div>
  ${panes}
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
      for (let i = 0; i < item.gemIds.length; i++) {
        const label = item.gemLabels?.[i] || `Gem #${item.gemIds[i]}`;
        tags.push(
          `<span class="gear-anno gear-anno--gem">${esc(label)}</span>`,
        );
      }
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
      ${item.id ? `<a class="gear-name" href="https://www.wowhead.com/item=${item.id}" target="_blank" rel="noopener">${esc(displayName)}</a>` : `<span class="gear-name">${esc(displayName)}</span>`}
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
    // temporary_enchant may be "main_hand:oil_name/off_hand:oil_name" — strip slot prefixes, dedupe
    const oils = [
      ...new Set(
        consumables.temporary_enchant
          .split("/")
          .map((p) => toTitleCase(p.replace(/^(main_hand|off_hand):/, ""))),
      ),
    ];
    cons.push(
      `<span class="gear-con"><b>Oils</b> ${esc(oils.join(" / "))}</span>`,
    );
  }

  const consHtml = cons.length
    ? `<div class="gear-cons-bar">${cons.join('<span class="gear-con-sep"></span>')}</div>`
    : "";

  const profileCopyBtn = gearData.rawContent
    ? ` <button class="copy-profile" title="Copy profile.simc to clipboard">${COPY_ICON} Copy Profile</button>`
    : "";
  const profileData = gearData.rawContent
    ? ` data-profile="${esc(gearData.rawContent)}"`
    : "";

  return `<div class="gear-display report-card"${profileData}>
  <h3>Gear Profile${profileCopyBtn}</h3>
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
  <p>Generated by <a href="https://github.com/simulationcraft/dh-apl">dh-apl</a></p>
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

// Normalized weighting matching gear pipeline: divide each scenario by its
// mean across all entries, then weight. Prevents high-DPS scenarios from
// dominating. Returns a DPS-scale number via displayScale.
function applyNormalizedWeights(dpsRows) {
  const scenarios = Object.keys(SCENARIOS);
  const scenarioMeans = {};
  for (const s of scenarios) {
    const vals = dpsRows.map((r) => r[s] || 0).filter((v) => v > 0);
    scenarioMeans[s] =
      vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  }
  let displayScale = 0;
  for (const [s, w] of Object.entries(SCENARIO_WEIGHTS)) {
    displayScale += scenarioMeans[s] * w;
  }
  for (const row of dpsRows) {
    let norm = 0;
    for (const [s, w] of Object.entries(SCENARIO_WEIGHTS)) {
      const mean = scenarioMeans[s];
      norm += ((row[s] || 0) / mean) * w;
    }
    row.weighted = norm * displayScale;
  }
}

function allDpsKeys() {
  return [...Object.keys(SCENARIOS), "weighted"];
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

* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--fg-muted); }

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
  gap: 1.5rem;
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
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.tbc-dps-label {
  font-size: 0.6rem;
  font-weight: 500;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
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

.analysis-left {
  min-height: 0;
  overflow: hidden;
}

.analysis-left > .heatmap-spec-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* Gear section layout */
.gear-section-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 1.5rem;
  align-items: start;
}

/* Talent Heatmap */
.talent-heatmap { }

.heatmap-spec-panel {
  /* card styles inherited from .report-card */
}

.heatmap-svg {
  width: 100%;
  height: 0;
  flex-grow: 1;
}

.heatmap-edge {
  stroke: var(--border);
  stroke-width: 1.5;
}

.heatmap-node-group {
  cursor: pointer;
}

.heatmap-node-group:hover .heatmap-node {
  stroke: var(--fg) !important;
  stroke-width: 3 !important;
  filter: drop-shadow(0 0 4px rgba(255,255,255,0.15));
}

.heatmap-node {
  fill: var(--surface-alt);
  stroke: var(--border);
  stroke-width: 1.5;
  transition: stroke 0.15s, stroke-width 0.15s, filter 0.15s;
}

.heatmap-node.heatmap-nodata {
  fill: var(--surface);
  stroke: var(--border-subtle);
  opacity: 0.3;
  stroke-width: 1;
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

/* Unified tab/pane system */
.report-tabs {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.report-tab {
  font-family: "DM Sans", sans-serif;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-size: 0.74rem;
  font-weight: 600;
  padding: 0.3rem 0.75rem;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.report-tab:hover {
  border-color: var(--fg-muted);
  color: var(--fg);
}

.report-tab--active {
  background: var(--surface-alt);
  border-color: var(--accent);
  color: var(--accent);
}

.report-pane { display: none; }
.report-pane--active { display: block; }

/* Heatmap controls */
.heatmap-scenario-bar {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 1rem;
}

.heatmap-scenario-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.25rem 0.55rem;
  cursor: pointer;
  transition: all 0.15s;
}

.heatmap-scenario-btn:hover {
  border-color: var(--fg-muted);
  color: var(--fg);
}

.heatmap-scenario-btn.active {
  background: var(--surface-alt);
  border-color: var(--accent);
  color: var(--accent);
}

.heatmap-badge {
  fill: var(--fg);
  font-size: 9.5px;
  font-weight: 700;
  text-anchor: end;
  pointer-events: none;
  font-family: "Outfit", sans-serif;
  font-variant-numeric: tabular-nums;
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 4px;
  opacity: 0;
  transition: opacity 0.1s;
}

.heatmap-node-group .heatmap-badge.visible {
  opacity: 0.85;
}

.heatmap-node-group:hover .heatmap-badge.visible,
.heatmap-node-group:hover .heatmap-badge {
  opacity: 1;
}

/* Ability breakdown bars */
.ability-breakdown {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ability-breakdown .ab-rows {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.ab-row {
  display: grid;
  grid-template-columns: 120px 1fr 40px;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0;
}
.ab-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ab-track {
  height: 12px;
  background: var(--bg);
  border-radius: 6px;
  overflow: hidden;
}
.ab-fill {
  height: 100%;
  border-radius: 6px;
  opacity: 0.85;
}
.ab-value {
  font-size: 0.72rem;
  color: var(--fg-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
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
  margin-top: 0.15rem;
  background: rgba(228, 230, 240, 0.04);
  border-radius: var(--radius-sm);
  padding: 0.65rem 0 0.45rem;
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

.copy-profile {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0.25em 0.6em;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-left: 0.5em;
  vertical-align: middle;
  transition: color 0.15s, border-color 0.15s;
}
.copy-profile:hover { color: var(--accent); border-color: var(--accent); }
.copy-profile.copied { color: var(--positive); border-color: var(--positive); }
.copy-profile svg { width: 13px; height: 13px; }

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

.badge--community {
  background: var(--surface-alt, #2a2d3a);
  color: var(--fg-muted);
  border: 1px solid var(--border);
  font-size: 0.52rem;
  text-transform: lowercase;
}

/* Positive / negative */
.positive { color: var(--positive); font-weight: 600; }
.negative { color: var(--negative); font-weight: 600; }

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
a.gear-name { color: var(--accent); text-decoration: none; }
a.gear-name:hover { text-decoration: underline; }

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
  gap: 0.5rem;
  padding: 0.3rem 0.65rem;
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

/* Trinket card header + toggle */
.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.5rem;
}
.card-header-row h3 { margin: 0; }

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
  grid-template-columns: 32px 1fr 65px;
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

.trinket-strip__delta {
  font-size: 0.82rem;
  font-weight: 700;
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
  grid-template-columns: 28px 1fr 65px;
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
.tc-tooltip__delta {
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
  font-size: 0.72rem;
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
  table { font-size: 0.72rem; }
  th, td { padding: 0.35rem 0.5rem; }
  .build-name { font-size: 0.7rem; }

  .trinket-strip { grid-template-columns: 28px 1fr 55px; gap: 0 0.5rem; padding: 0.45rem 0.75rem; }
  .trinket-strip__name { font-size: 0.76rem; }
  .tc-row { grid-template-columns: 24px 1fr 55px; padding: 0.5rem 0.6rem; }
  .tc-name { font-size: 0.76rem; }
}
`;

// --- Interactive JS ---

const JS = `
// Talent heatmap interactivity
(() => {
  const section = document.querySelector('.talent-heatmap');
  if (!section) return;

  let activeScenario = 'weighted';

  function buildKey(tree, ...parts) {
    const segs = [tree.toLowerCase().replace(/\\s+/g, '-'), ...parts];
    return segs.join('-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  function getDpsKey(tree) { return buildKey(tree, activeScenario); }

  function getPctKey(tree) {
    return activeScenario === 'weighted' ? buildKey(tree, 'pct') : buildKey(tree, 'pct', activeScenario);
  }

  // Hero tree toggle
  section.querySelectorAll('.report-tab[data-hero-tree]').forEach(btn => {
    btn.addEventListener('click', () => {
      section.querySelectorAll('.report-tab[data-hero-tree]').forEach(b => b.classList.remove('report-tab--active'));
      btn.classList.add('report-tab--active');
      section.dataset.activeTree = btn.dataset.heroTree;
      updateHeatmapColors();
    });
  });

  // Scenario toggle
  section.querySelectorAll('.heatmap-scenario-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      section.querySelectorAll('.heatmap-scenario-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeScenario = btn.dataset.scenario;
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
      const pctKey = getPctKey(tree);
      const dpsKey = getDpsKey(tree);
      const pctVal = node.dataset[pctKey];
      const dpsVal = node.dataset[dpsKey];
      tooltip.querySelector('.heatmap-tooltip-name').textContent = name;
      const deltaEl = tooltip.querySelector('.heatmap-tooltip-delta');
      if (pctVal !== undefined) {
        const pct = Number(pctVal);
        const sign = pct >= 0 ? '+' : '';
        deltaEl.textContent = sign + pct.toFixed(1) + '% DPS';
        deltaEl.style.color = pct >= 0 ? 'var(--positive)' : 'var(--negative)';
      } else if (dpsVal !== undefined) {
        const n = Number(dpsVal);
        const sign = n >= 0 ? '+' : '';
        deltaEl.textContent = sign + Math.round(n).toLocaleString() + ' DPS';
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
    const dpsKey = getDpsKey(tree);
    const pctKey = getPctKey(tree);

    // Collect max pct for color scaling
    const nodeGroups = section.querySelectorAll('.heatmap-node-group');
    let maxPct = 0.5;
    nodeGroups.forEach(g => {
      const node = g.querySelector('.heatmap-node');
      if (node.dataset[pctKey] !== undefined) {
        const pv = Math.abs(Number(node.dataset[pctKey]));
        if (pv > maxPct) maxPct = pv;
      }
    });

    nodeGroups.forEach(g => {
      const node = g.querySelector('.heatmap-node');
      const overlay = g.querySelector('.heatmap-overlay');
      const badge = g.querySelector('.heatmap-badge');
      if (badge) { badge.textContent = ''; badge.classList.remove('visible'); }
      node.style.stroke = '';
      node.style.strokeDasharray = '';
      node.style.strokeWidth = '';

      if (node.classList.contains('heatmap-nodata')) {
        if (overlay) overlay.style.fill = 'transparent';
        return;
      }

      // Use pct for display, fall back to DPS
      const hasPct = node.dataset[pctKey] !== undefined;
      const pct = hasPct ? Number(node.dataset[pctKey]) : null;
      const raw = Number(node.dataset[dpsKey] || 0);
      const displayVal = hasPct ? pct : raw;
      const absDisplay = Math.abs(displayVal);
      const power = hasPct ? Math.min(absDisplay / maxPct, 1) : Math.min(absDisplay / 5, 1);

      if (displayVal >= 0) {
        const a = 0.08 + power * 0.52;
        if (overlay) overlay.style.fill = 'rgba(52, 211, 153, ' + a.toFixed(2) + ')';
        node.style.stroke = power > 0.15 ? 'rgba(52, 211, 153, ' + (0.5 + power * 0.5).toFixed(2) + ')' : '';
      } else {
        const a = 0.08 + power * 0.47;
        if (overlay) overlay.style.fill = 'rgba(251, 113, 133, ' + a.toFixed(2) + ')';
        node.style.stroke = power > 0.15 ? 'rgba(251, 113, 133, ' + (0.5 + power * 0.5).toFixed(2) + ')' : '';
      }
      if (badge && absDisplay > 0.05) {
        const sign = displayVal >= 0 ? '+' : '';
        badge.textContent = hasPct ? sign + displayVal.toFixed(1) + '%' : sign + Math.round(displayVal).toLocaleString();
        badge.classList.add('visible');
        badge.style.fill = displayVal >= 0 ? 'var(--positive)' : 'var(--negative)';
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

// Copy profile.simc to clipboard
document.querySelectorAll('.copy-profile').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const card = btn.closest('.gear-display');
    const profile = card?.dataset?.profile;
    if (!profile) return;

    const doCopy = text => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    };

    const origText = btn.textContent;
    const result = doCopy(profile);
    const flash = () => {
      btn.classList.add('copied');
      btn.querySelector('svg').innerHTML = '<polyline points="4 8.5 6.5 11 12 5" stroke-width="2"/>';
      const span = btn.childNodes[btn.childNodes.length - 1];
      if (span) span.textContent = ' Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.querySelector('svg').innerHTML = '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3 10.5V3a1.5 1.5 0 0 1 1.5-1.5H11"/>';
        if (span) span.textContent = ' Copy Profile';
      }, 1500);
    };
    if (result && result.then) result.then(flash);
    else flash();
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

// Constrain damage breakdown height to gear card height
(() => {
  const grid = document.querySelector('.gear-section-grid');
  if (!grid) return;
  const gear = grid.querySelector('.gear-display');
  const breakdown = grid.querySelector('.ability-breakdown');
  if (!gear || !breakdown) return;
  const sync = () => breakdown.style.maxHeight = gear.offsetHeight + 'px';
  sync();
  window.addEventListener('resize', sync);
})();

// Unified tab/pane toggle
for (const tab of document.querySelectorAll('[data-tab-group] .report-tab[data-tab]')) {
  tab.addEventListener('click', () => {
    const group = tab.closest('[data-tab-group]');
    const view = tab.dataset.tab;
    for (const t of group.querySelectorAll('.report-tab[data-tab]'))
      t.classList.remove('report-tab--active');
    tab.classList.add('report-tab--active');
    for (const p of group.querySelectorAll('.report-pane[data-pane]')) {
      p.classList.toggle('report-pane--active', p.dataset.pane === view);
    }
  });
}

`;

// --- Auto-populate missing gear phases ---

async function autoRunMissingGearPhases() {
  const db = getDb();
  const spec = getSpecName();

  if (!getSessionState("gear_scale_factors")) {
    console.warn(
      `  Warning: Scale factors required. Run: SPEC=${spec} npm run gear:run --through phase1`,
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

  // Auto-classify builds that lack archetypes
  const unclassified = roster.builds.filter(
    (b) => !b.archetype || b.archetype === "Unknown",
  );
  if (unclassified.length > 0) {
    console.log(
      `  ${unclassified.length} builds without archetypes (skipping auto-classify).`,
    );
  }

  // Auto-generate display names for builds that lack them
  const unnamed = roster.builds.filter((b) => !b.displayName);
  if (unnamed.length > 0) {
    console.log(
      `  Auto-generating display names for ${unnamed.length} builds...`,
    );
    const rawBuilds = getRosterBuilds();
    generateDisplayNames(rawBuilds);
    const refreshed = loadRoster();
    if (refreshed) {
      roster.builds = refreshed.builds;
    }
  }

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
  } else {
    console.log("  Loading cached DPS from DB...");
    reportData = loadReportData(roster);
    const withDps = reportData.builds.filter((b) => b.dps.weighted > 0).length;
    console.log(
      `  ${reportData.builds.length} builds loaded (${withDps} with DPS data)`,
    );

    if (withDps < reportData.builds.length * 0.5) {
      console.error(
        `\n  WARNING: Only ${withDps}/${reportData.builds.length} builds have DPS data.` +
          `\n  Report will be incomplete. Run without --skip-sims to get full data.\n`,
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
  let hasAblation = false;
  const ablationCachePath = join(resultsDir(), "ablation_intrinsics.json");
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

      // Ablation sims for intrinsic talent values
      let ablationIntrinsics = null;
      if (!opts.skipSims) {
        console.log(`\n  Running talent ablation sims...`);
        const ablationData = await simTalentAblation(
          oursPath,
          { target_error: 1.0 }, // quick fidelity for ablation
          reportData,
          talentData,
          Object.keys(heroTrees),
        );
        if (ablationData) {
          ablationIntrinsics = computeIntrinsicValues(ablationData);
          if (ablationIntrinsics) {
            hasAblation = true;
            writeFileSync(
              ablationCachePath,
              JSON.stringify(ablationIntrinsics, null, 2),
            );
            const tested = Object.keys(ablationIntrinsics.all || {}).length;
            console.log(`  Ablation: ${tested} talents tested`);
          } else {
            try {
              unlinkSync(ablationCachePath);
            } catch {}
          }
        }
      } else if (existsSync(ablationCachePath)) {
        ablationIntrinsics = JSON.parse(
          readFileSync(ablationCachePath, "utf-8"),
        );
        if (ablationIntrinsics) {
          hasAblation = true;
          const allData = ablationIntrinsics.all || {};
          console.log(
            `  Ablation: ${Object.keys(allData).length} cached intrinsic values loaded`,
          );
        }
      }

      nodeContributions = computeNodeContributions(
        reportData.builds,
        talentData,
        decodedBuilds,
        Object.keys(heroTrees),
        ablationIntrinsics,
      );
      console.log(
        `  Talent heatmap: ${Object.keys(nodeContributions.all || {}).length} nodes computed${hasAblation ? " (ablation)" : ""}`,
      );
    }
  } catch (e) {
    console.warn(`  Talent heatmap skipped: ${e.message}`);
  }

  // Ability damage breakdown: per-hero-tree when sims run, else fallback to cached
  let abilityBreakdown = null;
  if (!opts.skipSims) {
    try {
      console.log(`\n  Running per-tree damage breakdown sims...`);
      abilityBreakdown = await simBreakdownBuilds(roster, oursPath, heroTrees);
      const treeCount = Object.keys(abilityBreakdown).length;
      if (treeCount > 0) {
        console.log(`  Breakdown: ${treeCount} hero tree(s) simmed`);
      } else {
        abilityBreakdown = null;
      }
    } catch (e) {
      console.warn(`  Breakdown sims failed: ${e.message}`);
    }
  }

  // Fallback: load cached per-tree breakdowns or single-profile base
  if (!abilityBreakdown) {
    const cachedTrees = {};
    for (const tree of Object.keys(heroTrees)) {
      const jsonPath = join(
        resultsDir(),
        `breakdown_${normalizeTree(tree)}_st.json`,
      );
      try {
        const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
        const bd = parseDamageBreakdown(data?.sim?.players?.[0]?.stats);
        if (bd) cachedTrees[tree] = bd;
      } catch {
        // Not available for this tree
      }
    }
    if (Object.keys(cachedTrees).length > 0) {
      abilityBreakdown = cachedTrees;
      console.log(
        `  Ability breakdown: ${Object.keys(cachedTrees).length} cached tree(s) loaded`,
      );
    } else {
      // Final fallback: report_ours_st.json base profile
      try {
        const stData = JSON.parse(
          readFileSync(join(resultsDir(), "report_ours_st.json"), "utf-8"),
        );
        abilityBreakdown = parseDamageBreakdown(
          stData?.sim?.players?.[0]?.stats,
        );
        if (abilityBreakdown) {
          console.log(
            `  Ability breakdown: ${abilityBreakdown.abilities.length} abilities from cached ST sim`,
          );
        }
      } catch {
        // Not available
      }
    }
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
    heroTrees,
    trinketData,
    embellishmentData,
    gearData,
    talentData,
    nodeContributions,
    abilityBreakdown,
    hasAblation,
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
