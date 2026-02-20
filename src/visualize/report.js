// Generates a self-contained HTML dashboard for VDH APL optimization results.
// Replaces showcase.js with a public-facing report covering build rankings,
// hero tree comparison, talent costs, and optimization history.
//
// Usage: node src/visualize/report.js [options]
//   --skip-sims           Generate from cached DB DPS only (no sims)
//   --fidelity <tier>     quick|standard|confirm (default: standard)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  config,
  SCENARIOS,
  SCENARIO_WEIGHTS,
  FIDELITY_TIERS,
  initSpec,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { ROOT, resultsDir, aplsDir } from "../engine/paths.js";
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

function loadReportData(roster, specConfig) {
  const rawBuilds = getRosterBuilds();
  const dbByHash = new Map(rawBuilds.map((b) => [b.hash, b]));

  const builds = roster.builds.map((build) => {
    const db = dbByHash.get(build.hash);
    const dps = {};
    for (const s of Object.keys(SCENARIOS)) {
      dps[s] = build.lastDps?.[s] || db?.[`dps_${s}`] || 0;
    }
    dps.weighted = build.lastDps?.weighted || db?.weighted || 0;

    return {
      id: build.id,
      displayName: build.displayName || build.id,
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
  const talentPolicy = loadTalentPolicy();
  const clusterCosts = deriveClusterCosts(builds, specConfig);

  return { builds, iterations, talentPolicy, clusterCosts };
}

function loadChangelog() {
  try {
    const iterations = getIterations({ decision: "accepted", limit: 200 });
    if (iterations.length === 0) return [];
    return iterations.map((it) => {
      const entry = {
        id: it.id,
        date: it.createdAt,
        description: it.reason || it.aplDiff || "",
        meanWeighted: it.aggregate?.meanWeighted ?? null,
        perScenario: it.aggregate || {},
      };
      if (it.hypothesisId) {
        try {
          const hyp = getDb()
            .prepare("SELECT summary, theory_id FROM hypotheses WHERE id = ?")
            .get(it.hypothesisId);
          if (hyp?.summary) entry.description = hyp.summary;
          else if (hyp?.theory_id) {
            const theory = getTheory(hyp.theory_id);
            if (theory) entry.description = theory.title;
          }
        } catch {
          // Hypothesis lookup is optional
        }
      }
      return entry;
    });
  } catch {
    return [];
  }
}

function loadTalentPolicy() {
  const empty = { locked: [], banned: [], excluded: [] };
  try {
    const specJson = JSON.parse(
      readFileSync(join(ROOT, `config.${config.spec.specName}.json`), "utf-8"),
    );
    const t = specJson.talents;
    if (!t) return empty;
    return {
      locked: t.locked || [],
      banned: t.banned || [],
      excluded: t.excluded || [],
    };
  } catch {
    return empty;
  }
}

// --- Cluster cost derivation ---

function deriveClusterCosts(builds, specConfig) {
  const templates = specConfig.rosterTemplates;
  if (!templates || templates.length === 0) return [];

  const costs = [];

  // Group builds by hero_tree + apex rank + template name, then average
  const groups = {};
  for (const b of builds) {
    if (!b.archetype || b.dps.weighted <= 0) continue;
    const match = b.archetype.match(/^Apex (\d+):\s*(.+)$/);
    if (!match) continue;
    const apex = parseInt(match[1]);
    const templateName = match[2].trim();
    const key = `${b.heroTree}|${apex}|${templateName}`;
    if (!groups[key])
      groups[key] = { heroTree: b.heroTree, apex, templateName, builds: [] };
    groups[key].builds.push(b);
  }

  function avgDps(arr) {
    const n = arr.length;
    const result = {};
    for (const key of [...Object.keys(SCENARIOS), "weighted"]) {
      result[key] = arr.reduce((s, b) => s + (b.dps[key] || 0), 0) / n;
    }
    return result;
  }

  const averaged = Object.values(groups).map((g) => ({
    ...g,
    avg: avgDps(g.builds),
  }));

  // Group averaged entries by hero_tree + apex
  const byTreeApex = {};
  for (const g of averaged) {
    const key = `${g.heroTree}|${g.apex}`;
    (byTreeApex[key] ||= []).push(g);
  }

  for (const entries of Object.values(byTreeApex)) {
    const { heroTree, apex } = entries[0];

    // Find reference (Full Stack for apex 0-1, best weighted otherwise)
    let ref;
    if (apex <= 1) {
      ref = entries.find((e) => e.templateName === "Full Stack");
    }
    if (!ref) {
      ref = entries.reduce(
        (best, e) => (e.avg.weighted > (best?.avg.weighted || 0) ? e : best),
        null,
      );
    }
    if (!ref) continue;

    for (const e of entries) {
      if (e === ref) continue;
      const pctDelta = (key) =>
        ref.avg[key] ? ((e.avg[key] - ref.avg[key]) / ref.avg[key]) * 100 : 0;
      costs.push({
        heroTree,
        apex,
        templateName: e.templateName,
        refName: ref.templateName,
        deltaWeighted: pctDelta("weighted"),
        deltaSt: pctDelta("st"),
        deltaSmall: pctDelta("small_aoe"),
        deltaBig: pctDelta("big_aoe"),
      });
    }
  }

  // Sort by apex rank, then by delta
  costs.sort((a, b) => a.apex - b.apex || a.deltaWeighted - b.deltaWeighted);
  return costs;
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

  function roundScenarios(dpsRow) {
    const result = {};
    for (const s of Object.keys(SCENARIOS)) {
      result[s] = Math.round(dpsRow[s] || 0);
    }
    return result;
  }

  for (const row of buildData) {
    const hash = hashById.get(row.id);
    if (!hash) continue;
    if (row.dps.weighted > 0) updateBuildDps(hash, roundScenarios(row.dps));
    if (row.simcDps?.weighted > 0)
      updateBuildSimcDps(hash, roundScenarios(row.simcDps));
  }
}

// --- HTML generation ---

function generateHtml(data) {
  const {
    specName,
    builds,
    iterations,
    talentPolicy,
    clusterCosts,
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
    renderKeyStats(builds, iterations, heroTrees),
    renderBestBuilds(builds),
    renderHeroComparison(builds, heroTrees),
    renderBuildRankings(builds, heroTrees),
    renderTalentImpact(clusterCosts, talentPolicy),
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
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
  const scenarioDesc = Object.keys(SCENARIOS)
    .map(
      (s) => `${SCENARIOS[s].name} ${Math.round(SCENARIO_WEIGHTS[s] * 100)}%`,
    )
    .join(" / ");

  return `<header>
  <div class="header-content">
    <h1>${esc(displaySpec)}</h1>
    <p class="subtitle">Midnight — APL Optimization Report</p>
  </div>
  <div class="header-meta">
    <span class="meta-item">Updated ${freshness}</span>
    <span class="meta-sep">&middot;</span>
    <span class="meta-item">Weights: ${esc(scenarioDesc)}</span>
  </div>
</header>`;
}

function renderKeyStats(builds, iterations, heroTrees) {
  const best = findBest(builds, "weighted");

  // APL improvement: cumulative from accepted iterations
  const totalImprovement = iterations.reduce(
    (sum, it) => sum + (it.meanWeighted || 0),
    0,
  );

  // Hero tree gap
  const treeNames = Object.keys(heroTrees);
  const treeAvgs = {};
  for (const tree of treeNames) {
    const treeBuilds = builds.filter((b) => b.heroTree === tree);
    if (treeBuilds.length === 0) continue;
    treeAvgs[tree] =
      treeBuilds.reduce((sum, b) => sum + (b.dps.weighted || 0), 0) /
      treeBuilds.length;
  }

  let treeGapHtml = "";
  if (treeNames.length === 2) {
    const [t1, t2] = treeNames;
    const avg1 = treeAvgs[t1] || 0;
    const avg2 = treeAvgs[t2] || 0;
    if (avg1 > 0 && avg2 > 0) {
      const leaderTree = avg1 >= avg2 ? t1 : t2;
      const leader = heroTrees[leaderTree].displayName;
      const gap = Math.abs(((avg1 - avg2) / Math.min(avg1, avg2)) * 100);
      treeGapHtml = `<div class="stat-card">
    <div class="stat-value"><span class="tree-badge ${treeClass(leaderTree)}">${esc(leader)}</span></div>
    <div class="stat-label">Leads by ${gap.toFixed(1)}% weighted avg</div>
  </div>`;
    }
  }

  return `<section class="key-stats">
  <div class="stat-card accent">
    <div class="stat-value">${esc(best?.displayName || "—")}${copyBtn(best?.hash)}</div>
    <div class="stat-label">Best Overall — ${fmtDps(best?.dps.weighted || 0)} weighted</div>
  </div>
  <div class="stat-card">
    <div class="stat-value positive">+${totalImprovement.toFixed(2)}%</div>
    <div class="stat-label">APL improvement (${iterations.length} iterations)</div>
  </div>
  ${treeGapHtml}
</section>`;
}

function renderBestBuilds(builds) {
  const bestW = findBest(builds, "weighted");
  const cards = [
    makeBestCard("Best Weighted", bestW, bestW?.dps.weighted || 0),
    ...Object.keys(SCENARIOS).map((s) => {
      const best = findBest(builds, s);
      return makeBestCard(`Best ${SCENARIOS[s].name}`, best, best?.dps[s] || 0);
    }),
  ];

  return `<section>
  <h2>Best Builds Per Scenario</h2>
  <div class="best-cards">${cards.join("\n")}</div>
</section>`;
}

function makeBestCard(label, build, dps) {
  if (!build) return "";
  return `    <div class="best-card">
      <div class="best-label">${esc(label)}</div>
      <div class="best-name">${esc(build.displayName)}${copyBtn(build.hash)}</div>
      <div class="best-meta"><span class="tree-badge ${treeClass(build.heroTree)}">${esc(treeDisplayName(build.heroTree))}</span> <span class="best-dps">${fmtDps(dps)}</span></div>
    </div>`;
}

function renderHeroComparison(builds, heroTrees) {
  const treeNames = Object.keys(heroTrees);
  if (treeNames.length < 2) return "";

  const scenarios = [...Object.keys(SCENARIOS), "weighted"];
  const scenarioLabels = {
    ...Object.fromEntries(
      Object.entries(SCENARIOS).map(([k, v]) => [
        k,
        `${v.desiredTargets}T (${v.maxTime}s)`,
      ]),
    ),
    weighted: "Weighted",
  };

  // Compute averages per tree per scenario
  const treeData = {};
  let globalMax = 0;
  for (const tree of treeNames) {
    const treeBuilds = builds.filter((b) => b.heroTree === tree);
    treeData[tree] = { builds: treeBuilds, avgs: {} };
    for (const s of scenarios) {
      const vals = treeBuilds.map((b) => b.dps[s] || 0).filter((v) => v > 0);
      const avg =
        vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      treeData[tree].avgs[s] = avg;
      if (avg > globalMax) globalMax = avg;
    }
  }

  // Top 3 builds per tree
  const topBuildsHtml = treeNames
    .map((tree) => {
      const top3 = [...treeData[tree].builds]
        .sort((a, b) => (b.dps.weighted || 0) - (a.dps.weighted || 0))
        .slice(0, 3);
      const rows = top3
        .map(
          (b, i) =>
            `<tr><td class="rank">${i + 1}</td><td>${esc(b.displayName)}</td><td class="num">${fmtDps(b.dps.weighted || 0)}</td></tr>`,
        )
        .join("\n");
      return `<div class="top-builds-panel">
        <h4><span class="tree-badge ${treeClass(tree)}">${esc(heroTrees[tree].displayName)}</span> Top 3</h4>
        <table class="top-builds-table"><tbody>${rows}</tbody></table>
      </div>`;
    })
    .join("\n");

  // SVG bar chart
  const barWidth = 180;
  const barHeight = 22;
  const gap = 6;
  const labelWidth = 95;
  const chartWidth = labelWidth + barWidth * 2 + 40;
  const chartHeight = scenarios.length * (barHeight * 2 + gap * 2 + 16) + 10;

  let svgBars = "";
  let y = 10;
  for (const s of scenarios) {
    // Scenario label
    svgBars += `<text x="${labelWidth - 8}" y="${y + barHeight + 4}" text-anchor="end" class="chart-label">${scenarioLabels[s]}</text>`;

    for (let ti = 0; ti < treeNames.length; ti++) {
      const tree = treeNames[ti];
      const avg = treeData[tree].avgs[s];
      const pct = globalMax > 0 ? avg / globalMax : 0;
      const w = Math.max(pct * barWidth, 2);
      const barY = y + ti * (barHeight + gap);

      svgBars += `<rect x="${labelWidth}" y="${barY}" width="${w}" height="${barHeight}" rx="3" fill="${treeColor(tree)}" opacity="0.85"/>`;
      svgBars += `<text x="${labelWidth + w + 6}" y="${barY + barHeight / 2 + 5}" class="chart-value">${fmtDps(avg)}</text>`;
    }

    y += barHeight * 2 + gap * 2 + 16;
  }

  const svg = `<svg class="hero-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" xmlns="http://www.w3.org/2000/svg">
    <style>
      .chart-label { font: 500 12px Inter, sans-serif; fill: #8b8fa3; }
      .chart-value { font: 600 11px Inter, sans-serif; fill: #e2e4ed; }
    </style>
    ${svgBars}
  </svg>`;

  // Legend
  const legend = treeNames
    .map(
      (t) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${treeColor(t)}"></span>${esc(heroTrees[t].displayName)} (${treeData[t].builds.length})</span>`,
    )
    .join("");

  return `<section>
  <h2>Hero Tree Comparison</h2>
  <div class="legend">${legend}</div>
  <div class="hero-comparison">
    <div class="hero-chart-wrap">${svg}</div>
    <div class="top-builds-row">${topBuildsHtml}</div>
  </div>
</section>`;
}

function renderBuildRankings(builds, heroTrees) {
  const scenarios = Object.keys(SCENARIOS);

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
    const wTooltip = hasBaseline
      ? ` title="SimC baseline: ${fmtDps(b.simcDps.weighted)}"`
      : "";

    let scenarioCells = "";
    for (const s of scenarios) {
      const isTop = topPerScenario[s]?.id === b.id;
      const badge = isTop ? '<span class="badge">TOP</span>' : "";
      const topCls = isTop ? " top-build" : "";
      const tooltip =
        hasBaseline && b.simcDps[s]
          ? ` title="SimC baseline: ${fmtDps(b.simcDps[s])}"`
          : "";
      scenarioCells += `<td class="dps-cell${topCls}"${tooltip}>${fmtDps(b.dps[s] || 0)}${badge}</td>`;
    }

    rows += `<tr data-tree="${esc(b.heroTree)}">
  <td class="build-name">${esc(b.displayName)}${copyBtn(b.hash)}</td>
  <td><span class="tree-badge sm ${treeClass(b.heroTree)}">${treeAbbr(b.heroTree)}</span></td>
  <td class="archetype-cell">${esc(b.archetype)}</td>
  ${scenarioCells}
  <td class="dps-cell${isTopW ? " top-build" : ""}"${wTooltip}>${fmtDps(b.dps.weighted || 0)}${wBadge}</td>
</tr>`;
  }

  const scenarioHeaders = scenarios
    .map(
      (s) =>
        `<th class="sortable num" data-col="${s}">${esc(SCENARIOS[s].name)}</th>`,
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
        <th class="sortable" data-col="archetype">Archetype</th>
        ${scenarioHeaders}
        <th class="sortable num" data-col="weighted">Weighted</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}

function renderTalentImpact(clusterCosts, talentPolicy) {
  let html = `<section>
  <h2>Talent Impact</h2>`;

  // Cluster costs
  if (clusterCosts.length > 0) {
    html += `<div class="subsection">
    <h3>Cluster Costs</h3>
    <p class="section-desc">Impact of dropping talent clusters compared to the reference build at each apex rank. Negative = DPS loss from dropping.</p>`;

    // Group by apex rank
    const byApex = {};
    for (const c of clusterCosts) {
      (byApex[c.apex] ||= []).push(c);
    }

    for (const [apex, costs] of Object.entries(byApex)) {
      const isExpanded = apex === "0";
      html += `<details${isExpanded ? " open" : ""}>
      <summary>Apex ${apex} <span class="detail-count">(${costs.length} comparisons)</span></summary>
      <div class="table-wrap">
        <table class="cost-table">
          <thead><tr>
            <th>Template</th>
            <th>Hero Tree</th>
            <th>vs Reference</th>
            <th class="num">Weighted</th>
            <th class="num">1T</th>
            <th class="num">5T</th>
            <th class="num">10T</th>
          </tr></thead>
          <tbody>`;

      for (const c of costs) {
        html += `<tr>
            <td>${esc(c.templateName)}</td>
            <td><span class="tree-badge sm ${treeClass(c.heroTree)}">${treeAbbr(c.heroTree)}</span></td>
            <td class="ref-name">vs ${esc(c.refName)}</td>
            ${deltaCell(c.deltaWeighted)}
            ${deltaCell(c.deltaSt)}
            ${deltaCell(c.deltaSmall)}
            ${deltaCell(c.deltaBig)}
          </tr>`;
      }

      html += `</tbody></table></div></details>`;
    }

    html += `</div>`;
  }

  const policyCategories = [
    { key: "locked", label: "Locked", desc: "Always taken — core DPS talents" },
    {
      key: "banned",
      label: "Banned",
      desc: "Never taken — pure defensive/healing",
    },
    {
      key: "excluded",
      label: "Excluded",
      desc: "Excluded from roster generation",
    },
  ];
  const activePolicies = policyCategories.filter(
    (p) => talentPolicy[p.key].length > 0,
  );

  if (activePolicies.length > 0) {
    html += `<div class="subsection">
    <h3>Talent Policy</h3>
    <div class="policy-grid">`;

    for (const { key, label, desc } of activePolicies) {
      const tags = talentPolicy[key]
        .map((t) => `<span class="talent-tag ${key}">${esc(t)}</span>`)
        .join("");
      html += `<div class="policy-card">
        <div class="policy-header ${key}">${label} (${talentPolicy[key].length})</div>
        <div class="policy-desc">${desc}</div>
        <div class="talent-list">${tags}</div>
      </div>`;
    }

    html += `</div></div>`;
  }

  html += `</section>`;
  return html;
}

function renderOptimizationJourney(iterations) {
  if (!iterations || iterations.length === 0) return "";

  let cumulative = 0;
  const rows = iterations.map((it) => {
    const delta = it.meanWeighted || 0;
    cumulative += delta;
    return { ...it, delta, cumulative };
  });

  const maxDelta = Math.max(...rows.map((r) => Math.abs(r.delta)), 0.01);

  let tableRows = "";
  for (const r of rows) {
    const date = r.date ? r.date.split(/[T ]/)[0] : "\u2014";
    const barPct = Math.min((Math.abs(r.delta) / maxDelta) * 100, 100);
    const barColor = r.delta >= 0 ? "var(--positive)" : "var(--negative)";

    tableRows += `<tr>
      <td>${date}</td>
      <td class="desc-cell">${esc(r.description || "")}</td>
      <td class="num">
        <div class="impact-cell">
          <span class="${r.delta >= 0 ? "positive" : "negative"}">${fmtDelta(r.delta)}</span>
          <div class="impact-bar" style="width:${barPct}%;background:${barColor}"></div>
        </div>
      </td>
      <td class="num ${r.cumulative >= 0 ? "positive" : "negative"}">${fmtDelta(r.cumulative)}</td>
    </tr>`;
  }

  return `<section>
  <h2>Optimization Journey</h2>
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
  const scenarios = Object.keys(SCENARIOS)
    .map(
      (s) =>
        `${SCENARIOS[s].name} (${SCENARIOS[s].desiredTargets}T, ${SCENARIOS[s].maxTime}s)`,
    )
    .join(", ");

  return `<footer>
  <p class="footer-method">SimulationCraft &middot; ${esc(scenarios)} &middot; Midnight</p>
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

function treeClass(heroTree) {
  return heroTree === "annihilator" ? "anni" : "ar";
}

function treeDisplayName(heroTree) {
  return heroTree === "annihilator" ? "Annihilator" : "Aldrachi Reaver";
}

function treeAbbr(heroTree) {
  return heroTree === "annihilator" ? "Anni" : "AR";
}

function treeColor(heroTree) {
  return heroTree === "annihilator" ? "#a78bfa" : "#fb923c";
}

function findBest(builds, field) {
  return builds.reduce(
    (a, b) => ((b.dps[field] || 0) > (a.dps[field] || 0) ? b : a),
    builds[0],
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
  --bg: #0f1117;
  --surface: #181a24;
  --surface-alt: #1e2030;
  --border: #2a2d3e;
  --fg: #e2e4ed;
  --fg-muted: #8b8fa3;
  --accent: #6c8aff;
  --accent-dim: #3d4f8a;
  --positive: #4ade80;
  --positive-bg: rgba(74, 222, 128, 0.08);
  --negative: #f87171;
  --negative-bg: rgba(248, 113, 113, 0.08);
  --gold: #fbbf24;
  --gold-bg: rgba(251, 191, 36, 0.1);
  --anni: #a78bfa;
  --ar: #fb923c;
  --radius: 8px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.6;
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 1.5rem;
}

/* Header */
header {
  padding: 2.5rem 0 1.5rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2rem;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 1rem;
}

header h1 {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--accent), var(--anni));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  color: var(--fg-muted);
  font-size: 0.9rem;
  margin-top: 0.2rem;
}

.header-meta {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  color: var(--fg-muted);
  font-size: 0.8rem;
}

.meta-sep { opacity: 0.4; }

/* Section basics */
section { margin-bottom: 2.5rem; }

h2 {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--fg);
  padding-bottom: 0.5rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}

h3 {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 1.25rem 0 0.75rem;
  color: var(--fg);
}

h4 {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--fg-muted);
}

.section-desc {
  color: var(--fg-muted);
  font-size: 0.82rem;
  margin-bottom: 1rem;
}

.subsection { margin-bottom: 2rem; }

/* Key stats */
.key-stats {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 2.5rem;
}

.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem 1.5rem;
  flex: 1;
  min-width: 220px;
}

.stat-card.accent {
  border-color: var(--accent-dim);
  background: linear-gradient(135deg, rgba(108, 138, 255, 0.06), transparent);
}

.stat-value {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.stat-label {
  font-size: 0.75rem;
  color: var(--fg-muted);
  margin-top: 0.35rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Best build cards */
.best-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}

.best-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem 1.25rem;
}

.best-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
  margin-bottom: 0.35rem;
}

.best-name {
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.35rem;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.best-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.best-dps {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--fg-muted);
}

/* Hero comparison */
.hero-comparison {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.hero-chart-wrap {
  overflow-x: auto;
}

.hero-chart {
  width: 100%;
  max-width: 600px;
  height: auto;
}

.legend {
  display: flex;
  gap: 1.25rem;
  margin-bottom: 1rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--fg-muted);
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}

.top-builds-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}

.top-builds-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
}

.top-builds-table {
  width: 100%;
  font-size: 0.82rem;
}

.top-builds-table td {
  padding: 0.3rem 0.5rem;
  border: none;
}

.top-builds-table .rank {
  width: 24px;
  color: var(--fg-muted);
  font-weight: 600;
}

.top-builds-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

/* Tree badges */
.tree-badge {
  display: inline-block;
  padding: 0.15em 0.6em;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.tree-badge.anni { background: rgba(167, 139, 250, 0.15); color: var(--anni); }
.tree-badge.ar { background: rgba(251, 146, 60, 0.15); color: var(--ar); }
.tree-badge.sm { font-size: 0.68rem; padding: 0.1em 0.45em; }

/* Filter bar */
.filter-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.filter-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg-muted);
  padding: 0.4em 1em;
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.filter-btn:hover { border-color: var(--accent); color: var(--fg); }
.filter-btn.active { background: var(--accent-dim); border-color: var(--accent); color: var(--fg); }

/* Tables */
.table-wrap {
  overflow-x: auto;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

th, td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

th {
  background: var(--surface);
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
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

tbody tr { background: var(--bg); }
tbody tr:nth-child(even) { background: var(--surface-alt); }
tbody tr:hover { background: rgba(108, 138, 255, 0.06); }

.dps-cell {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.dps-cell.top-build { background: var(--gold-bg); }

.build-name {
  font-weight: 500;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 0.78rem;
  word-break: break-word;
  white-space: nowrap;
}

.archetype-cell {
  color: var(--fg-muted);
  font-size: 0.78rem;
}

.ref-name {
  color: var(--fg-muted);
  font-size: 0.78rem;
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
.best-name:hover .copy-hash, .stat-value:hover .copy-hash { opacity: 1; }
.copy-hash:hover { color: var(--accent); border-color: var(--border); }
.copy-hash.copied { color: var(--positive); opacity: 1; }
.copy-hash svg { width: 13px; height: 13px; }

/* Badges */
.badge {
  display: inline-block;
  background: var(--gold);
  color: #000;
  font-size: 0.55rem;
  font-weight: 700;
  padding: 0.1em 0.35em;
  border-radius: 3px;
  vertical-align: middle;
  margin-left: 0.35em;
  letter-spacing: 0.05em;
}

/* Positive / negative */
.positive { color: var(--positive); font-weight: 600; }
.negative { color: var(--negative); font-weight: 600; }

/* Talent policy */
.policy-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}

.policy-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem 1.25rem;
}

.policy-header {
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.25rem;
}

.policy-header.locked { color: var(--positive); }
.policy-header.banned { color: var(--negative); }
.policy-header.excluded { color: var(--fg-muted); }

.policy-desc {
  color: var(--fg-muted);
  font-size: 0.75rem;
  margin-bottom: 0.75rem;
}

.talent-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.talent-tag {
  display: inline-block;
  padding: 0.15em 0.5em;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 500;
  background: var(--surface-alt);
  border: 1px solid var(--border);
}

.talent-tag.locked { border-color: rgba(74, 222, 128, 0.2); }
.talent-tag.banned { border-color: rgba(248, 113, 113, 0.2); }
.talent-tag.excluded { border-color: var(--border); }

/* Details / collapsible */
details {
  margin-bottom: 1rem;
}

summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 0.9rem;
  padding: 0.5rem 0;
  color: var(--fg);
  user-select: none;
}

summary:hover { color: var(--accent); }

.detail-count {
  font-weight: 400;
  font-size: 0.8rem;
  color: var(--fg-muted);
}

/* Optimization journey */
.journey-table .desc-cell {
  max-width: 400px;
  white-space: normal;
}

.impact-cell {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: flex-end;
}

.impact-bar {
  height: 6px;
  border-radius: 3px;
  min-width: 2px;
  flex-shrink: 0;
}

/* Footer */
footer {
  border-top: 1px solid var(--border);
  padding: 1.5rem 0;
  text-align: center;
  color: var(--fg-muted);
  font-size: 0.8rem;
}

footer p { margin-bottom: 0.25rem; }
footer a { color: var(--accent); text-decoration: none; }
footer a:hover { text-decoration: underline; }
.footer-method { font-size: 0.72rem; }

/* Responsive */
@media (max-width: 768px) {
  header { flex-direction: column; align-items: flex-start; }
  .key-stats { flex-direction: column; }
  .stat-card { min-width: 100%; }
  .best-cards { grid-template-columns: 1fr; }
  table { font-size: 0.72rem; }
  th, td { padding: 0.35rem 0.5rem; }
  .filter-bar { gap: 0.35rem; }
  .policy-grid { grid-template-columns: 1fr; }
  .top-builds-row { grid-template-columns: 1fr; }
  .build-name { font-size: 0.7rem; }
}
`;

// --- Interactive JS ---

const JS = `
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

    // Re-load from DB for consistency
    reportData = loadReportData(roster, specConfig);
  } else {
    console.log("  Loading cached DPS from DB...");
    reportData = loadReportData(roster, specConfig);
    const withDps = reportData.builds.filter((b) => b.dps.weighted > 0).length;
    console.log(
      `  ${reportData.builds.length} builds loaded (${withDps} with DPS data)`,
    );
  }

  // Generate HTML
  const reportDir = join(resultsDir(), "report");
  mkdirSync(reportDir, { recursive: true });

  const html = generateHtml({
    specName,
    builds: reportData.builds,
    iterations: reportData.iterations,
    talentPolicy: reportData.talentPolicy,
    clusterCosts: reportData.clusterCosts,
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
