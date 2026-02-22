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
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { resultsDir, aplsDir } from "../engine/paths.js";
import { loadRoster } from "../sim/build-roster.js";
import {
  generateRosterProfilesetContent,
  runProfilesetAsync,
  profilesetResultsToActorMap,
} from "../sim/profilesets.js";
import {
  getDb,
  getIterations,
  getTheory,
  getRosterBuilds,
  updateBuildDps,
  updateBuildSimcDps,
} from "../util/db.js";
import { generateDefensiveCostBuilds } from "../model/talent-combos.js";

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

  const iterations = loadChangelog();
  const apexBuilds = deriveApexBuilds(builds);

  return { builds, iterations, apexBuilds };
}

function loadChangelog() {
  try {
    const iterations = getIterations({ decision: "accepted", limit: 200 });
    return iterations.map((it) => ({
      id: it.id,
      date: it.createdAt,
      description: resolveIterationDescription(it),
      meanWeighted: it.aggregate?.meanWeighted ?? null,
      perScenario: it.aggregate || {},
    }));
  } catch {
    return [];
  }
}

function resolveIterationDescription(it) {
  if (it.reason) return it.reason;

  if (it.hypothesisId) {
    try {
      const hyp = getDb()
        .prepare("SELECT summary, theory_id FROM hypotheses WHERE id = ?")
        .get(it.hypothesisId);
      if (hyp?.summary) return hyp.summary;
      if (hyp?.theory_id) {
        const theory = getTheory(hyp.theory_id);
        if (theory) return theory.title;
      }
    } catch {
      // Hypothesis lookup is optional
    }
  }

  return it.aplDiff || "APL change";
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

  const dpsKeys = [...Object.keys(SCENARIOS), "weighted"];
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

// --- HTML generation ---

function generateHtml(data) {
  const {
    specName,
    builds,
    iterations,
    apexBuilds,
    defensiveTalentCosts,
    heroTrees,
  } = data;
  const displaySpec = specName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const latestDate = builds
    .map((b) => b.lastTestedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const freshness = (latestDate || new Date().toISOString()).split(/[T ]/)[0];

  const sections = [
    renderHeader(displaySpec, freshness),
    renderHeroShowcase(builds, heroTrees),
    renderComparisonSection(builds, heroTrees, apexBuilds),
    renderBuildRankings(builds, heroTrees),
    renderTalentImpact(apexBuilds, defensiveTalentCosts, builds),
    renderOptimizationJourney(iterations),
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

function renderHeroShowcase(builds, heroTrees) {
  const treeNames = Object.keys(heroTrees);

  const panels = treeNames.map((tree) => {
    const treeBuilds = builds.filter((b) => b.heroTree === tree);
    const best = findBest(treeBuilds, "weighted");
    if (!best) return "";

    const scenarioDps = activeScenarios(builds)
      .map(
        (s) =>
          `<span class="showcase-scenario"><span class="showcase-scenario-label" style="color:${scenarioColor(s)}">${esc(SCENARIOS[s].name)}</span> ${fmtDps(best.dps[s] || 0)}</span>`,
      )
      .join("");

    const treeUrl = `https://mimiron.raidbots.com/simbot/render/talents/${esc(best.hash)}?bgcolor=0f1117&width=1100&hideHeader=true`;

    return `<div class="showcase-panel">
      <div class="showcase-header">
        <span class="tree-badge ${treeClass(tree)}">${esc(heroTrees[tree].displayName)}</span>
      </div>
      <div class="showcase-build-name">${esc(best.displayName)}${copyBtn(best.hash)}</div>
      <div class="showcase-weighted">${fmtDps(best.dps.weighted || 0)} <span class="showcase-weighted-label">weighted</span></div>
      <div class="showcase-scenarios">${scenarioDps}</div>
      <div class="showcase-tree-wrap">
        <iframe src="${treeUrl}" title="${esc(heroTrees[tree].displayName)} spec tree" scrolling="no"></iframe>
      </div>
    </div>`;
  });

  return `<section class="hero-showcase">
  <h2>Top Builds</h2>
  <div class="showcase-grid">${panels.join("\n")}</div>
</section>`;
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

  return `<div class="hc-panel">
    <h3>By Scenario</h3>
    <p class="section-desc">Best build DPS per hero tree at each target count.</p>
    <div class="hc-rows">
      ${rows}
    </div>
    <div class="hc-legend">${legend}</div>
  </div>`;
}

function renderComparisonSection(builds, heroTrees, apexBuilds) {
  const treeNames = Object.keys(heroTrees);
  if (treeNames.length < 2) return "";

  const heroPanel = renderHeroComparison(builds, heroTrees);
  const apexPanel = renderApexScaling(apexBuilds, heroTrees);
  const gridCls = apexPanel ? "comparison-grid" : "";

  return `<section>
  <h2>Hero Tree Comparison</h2>
  <div class="${gridCls}">
    ${heroPanel}
    ${apexPanel}
  </div>
</section>`;
}

function renderApexScaling(apexBuilds, heroTrees) {
  const treeNames = Object.keys(heroTrees);
  if (!apexBuilds || Object.keys(apexBuilds).length < 2) return "";

  const ranks = Object.keys(apexBuilds)
    .map(Number)
    .sort((a, b) => a - b);
  const maxRank = Math.max(...ranks);
  if (maxRank <= 0) return "";

  // Best weighted DPS per tree per rank
  const perTree = {};
  for (const tree of treeNames) {
    perTree[tree] = {};
    for (const rank of ranks) {
      const entries = (apexBuilds[rank] || []).filter(
        (e) => e.heroTree === tree,
      );
      if (entries.length > 0) {
        perTree[tree][rank] = Math.max(...entries.map((e) => e.avg.weighted));
      }
    }
  }

  // % gain from each tree's rank 0 baseline
  const gains = {};
  let yMaxRaw = 0;
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
  const yMax = Math.ceil((yMaxRaw + 5) / 10) * 10;
  if (yMax <= 0) return "";

  const xOf = (r) => LEFT + (r / maxRank) * cW;
  const yOf = (g) => TOP + cH - (g / yMax) * cH;

  // Gridlines
  let grid = "";
  const step = yMax <= 20 ? 5 : 10;
  for (let g = 0; g <= yMax; g += step) {
    const y = yOf(g).toFixed(1);
    grid += `<line x1="${LEFT}" y1="${y}" x2="${W - RIGHT}" y2="${y}" stroke="var(--border-subtle)" stroke-width="1"/>`;
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
    const fill = isAnni(tree)
      ? "rgba(167, 139, 250, 0.15)"
      : "rgba(251, 146, 60, 0.15)";

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

  return `<div class="apex-panel">
    <h3>Apex Scaling</h3>
    <p class="section-desc">Weighted DPS gain by apex rank (best build per hero tree), relative to each tree's rank 0 baseline.</p>
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
  const treeFilters = Object.entries(heroTrees)
    .map(
      ([key, val]) =>
        `<button class="filter-btn" data-tree="${esc(key)}">${esc(val.displayName)}</button>`,
    )
    .join("\n      ");

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
    rows += `<tr data-tree="${esc(b.heroTree)}">
  <td class="build-name">${esc(b.displayName)}${copyBtn(b.hash)}</td>
  <td><span class="tree-badge sm ${treeClass(b.heroTree)}">${treeAbbr(b.heroTree)}</span></td>
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

  return `<section id="rankings">
  <h2>Build Rankings</h2>
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
        <th class="sortable num weighted-header" data-col="weighted" style="color:var(--fg)">Weighted <span class="info-icon">${INFO_ICON}<span class="info-popup">Weighted DPS combines all scenarios into a single score.<br><br>${Object.keys(
          SCENARIOS,
        )
          .map(
            (s) =>
              `<span style="color:${scenarioColor(s)}">${esc(SCENARIOS[s].name)}</span> ${Math.round(SCENARIO_WEIGHTS[s] * 100)}%`,
          )
          .join(" · ")}</span></span></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}

function renderTalentImpact(apexBuilds, defensiveTalentCosts, builds) {
  if (!defensiveTalentCosts?.costs?.length) return "";

  return `<section>
  <h2>Talent Impact</h2>
  ${renderDefensiveTalentCosts(defensiveTalentCosts.costs, defensiveTalentCosts.refName, builds)}
</section>`;
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
    <h3>Defensive Talent Costs</h3>
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

function renderOptimizationJourney(iterations) {
  if (!iterations || iterations.length === 0) return "";

  let cumulative = 0;
  let tableRows = "";
  for (const it of iterations) {
    const delta = it.meanWeighted || 0;
    cumulative += delta;
    const date = it.date ? it.date.split(/[T ]/)[0] : "\u2014";

    tableRows += `<tr>
      <td>${date}</td>
      <td class="desc-cell">${esc(it.description || "")}</td>
      <td class="num ${delta >= 0 ? "positive" : "negative"}">${fmtDelta(delta)}</td>
      <td class="num ${cumulative >= 0 ? "positive" : "negative"}">${fmtDelta(cumulative)}</td>
    </tr>`;
  }

  return `<section>
  <h2>Changelog</h2>
  <div class="table-wrap">
    <table class="journey-table">
      <thead><tr>
        <th>Date</th>
        <th>Description</th>
        <th class="num">Impact</th>
        <th class="num">Cumulative</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>
</section>`;
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

const INFO_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:13px;height:13px;vertical-align:middle"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7" x2="8" y2="11.5"/><circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none"/></svg>`;

function isAnni(heroTree) {
  return heroTree?.toLowerCase().startsWith("anni");
}

function treeClass(heroTree) {
  return isAnni(heroTree) ? "anni" : "ar";
}

function treeDisplayName(heroTree) {
  return isAnni(heroTree) ? "Annihilator" : "Aldrachi Reaver";
}

function treeAbbr(heroTree) {
  return isAnni(heroTree) ? "Anni" : "AR";
}

function treeColor(heroTree) {
  return isAnni(heroTree) ? "#a78bfa" : "#fb923c";
}

function scenarioLabel(s) {
  return s === "weighted" ? "Weighted" : SCENARIOS[s].name;
}

function scenarioColor(s) {
  const colors = {
    st: "#60a5fa",
    dungeon_slice: "#a78bfa",
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

function deltaCell(value) {
  const cls = value >= 0 ? "positive" : "negative";
  return `<td class="num ${cls}">${fmtDelta(value)}</td>`;
}

function computeWeighted(dpsRow) {
  return Object.keys(SCENARIOS).reduce(
    (sum, s) => sum + (dpsRow[s] || 0) * (SCENARIO_WEIGHTS[s] || 0),
    0,
  );
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
section { margin-bottom: 3rem; }

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

.subsection { margin-bottom: 2.5rem; }

/* Hero Showcase */
.hero-showcase { margin-bottom: 3rem; }

.showcase-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 1.5rem;
}

.showcase-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.75rem;
  position: relative;
  overflow: hidden;
}

.showcase-panel::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  border-radius: var(--radius) var(--radius) 0 0;
}

.showcase-panel:nth-child(1)::before { background: linear-gradient(90deg, var(--ar), transparent); }
.showcase-panel:nth-child(2)::before { background: linear-gradient(90deg, var(--anni), transparent); }
.showcase-panel:nth-child(1) { background: linear-gradient(180deg, var(--surface) 0%, var(--bg-elevated) 100%); box-shadow: 0 0 40px var(--ar-glow); }
.showcase-panel:nth-child(2) { background: linear-gradient(180deg, var(--surface) 0%, var(--bg-elevated) 100%); box-shadow: 0 0 40px var(--anni-glow); }

.showcase-header {
  margin-bottom: 1rem;
}

.showcase-build-name {
  font-family: "Outfit", sans-serif;
  font-weight: 600;
  font-size: 1.05rem;
  margin-bottom: 0.35rem;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.showcase-weighted {
  font-family: "Outfit", sans-serif;
  font-size: 1.75rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  margin-bottom: 0.6rem;
  letter-spacing: -0.02em;
}

.showcase-weighted-label {
  font-family: "DM Sans", sans-serif;
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.showcase-scenarios {
  display: flex;
  gap: 1.25rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}

.showcase-scenario {
  font-variant-numeric: tabular-nums;
  font-size: 0.82rem;
  font-weight: 600;
}

.showcase-scenario-label {
  display: block;
  color: var(--fg-muted);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
  margin-bottom: 0.1em;
}

.showcase-tree-wrap {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  margin-top: 1rem;
  position: relative;
  aspect-ratio: 4 / 5;
}

.showcase-tree-wrap iframe {
  position: absolute;
  width: 1100px;
  height: 700px;
  border: none;
  background: var(--bg);
  pointer-events: none;
  clip-path: inset(0% 0% 15% 57%);
  left: 50%;
  top: 50%;
  transform-origin: 78.5% 42.5%;
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
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
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
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 1.5rem 1rem;
  display: flex;
  flex-direction: column;
}

.hc-panel h3, .apex-panel h3 {
  font-family: "Outfit", sans-serif;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--fg-dim);
  margin: 0 0 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
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
  z-index: 1;
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
.best-name:hover .copy-hash, .showcase-build-name:hover .copy-hash { opacity: 1; }
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

/* Optimization journey */
.journey-table .desc-cell {
  max-width: 420px;
  white-space: normal;
  line-height: 1.45;
}



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

/* Weighted tooltip */
.info-icon {
  cursor: help;
  font-size: 0.75rem;
  color: var(--fg-muted);
  position: relative;
  vertical-align: middle;
}

.weighted-header {
  position: relative;
}

.info-popup {
  display: none;
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.65em 0.85em;
  font-family: "DM Sans", sans-serif;
  font-size: 0.72rem;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--fg-dim);
  line-height: 1.5;
  width: 260px;
  white-space: normal;
  z-index: 100;
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

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
  .showcase-grid { grid-template-columns: 1fr; }
  .hc-row { grid-template-columns: 70px 1fr 60px; gap: 0.5rem; }
  .comparison-grid { grid-template-columns: 1fr; }
  .def-strip__body, .def-strip-header__body { grid-template-columns: 120px 1fr 65px 75px 75px; gap: 0 0.5rem; }
  table { font-size: 0.72rem; }
  th, td { padding: 0.35rem 0.5rem; }
  .filter-bar { gap: 0.35rem; }
  .build-name { font-size: 0.7rem; }
  .showcase-weighted { font-size: 1.4rem; }
}
`;

// --- Interactive JS ---

const JS = `
// Responsive spec tree scaling
document.querySelectorAll('.showcase-tree-wrap').forEach(wrap => {
  const iframe = wrap.querySelector('iframe');
  if (!iframe) return;
  const TREE_W = 473, TREE_H = 595;
  const fit = () => {
    const s = Math.min(wrap.clientWidth / TREE_W, wrap.clientHeight / TREE_H);
    iframe.style.transform = 'translate(-78.5%, -42.5%) scale(' + s + ')';
  };
  fit();
  new ResizeObserver(fit).observe(wrap);
});

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

// Hero tree filter
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tree = btn.dataset.tree;
    const table = document.getElementById('rankings-table');
    if (!table) return;

    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
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
// Info popup positioning
document.querySelectorAll('.info-icon').forEach(icon => {
  const popup = icon.querySelector('.info-popup');
  if (!popup) return;
  icon.addEventListener('mouseenter', () => {
    const r = icon.getBoundingClientRect();
    popup.style.display = 'block';
    popup.style.right = (document.documentElement.clientWidth - r.right) + 'px';
    popup.style.left = 'auto';
    popup.style.top = (r.top - popup.offsetHeight - 8) + 'px';
  });
  icon.addEventListener('mouseleave', () => {
    popup.style.display = 'none';
  });
});

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


`;

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
  } else {
    console.log("  Loading cached DPS from DB...");
    reportData = loadReportData(roster);
    const withDps = reportData.builds.filter((b) => b.dps.weighted > 0).length;
    console.log(
      `  ${reportData.builds.length} builds loaded (${withDps} with DPS data)`,
    );

    if (existsSync(defCostPath)) {
      defensiveTalentCosts = JSON.parse(readFileSync(defCostPath, "utf-8"));
      console.log(
        `  ${defensiveTalentCosts.costs?.length || 0} cached defensive costs loaded.`,
      );
    }
  }

  // Generate HTML
  const reportDir = join(resultsDir(), "report");
  mkdirSync(reportDir, { recursive: true });

  const html = generateHtml({
    specName,
    builds: reportData.builds,
    iterations: reportData.iterations,
    apexBuilds: reportData.apexBuilds,
    defensiveTalentCosts,
    heroTrees,
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
