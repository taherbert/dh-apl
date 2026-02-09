// Generates a self-contained HTML showcase report for sharing APL optimization results.
// Compares our APL against the SimC default (baseline) across the FULL roster.
// Uses profileset mode for efficient batch simulation of all builds.
//
// Usage: node src/visualize/showcase.js [options]
//   --skip-sims           Generate from cached DB DPS only (no sims)
//   --fidelity <tier>     quick|standard|confirm (default: standard)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import {
  config,
  SCENARIOS,
  SCENARIO_WEIGHTS,
  FIDELITY_TIERS,
  initSpec,
  getSpecAdapter,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import { resultsDir, aplsDir } from "../engine/paths.js";
import { loadRoster } from "../sim/build-roster.js";
import {
  generateRosterProfilesetContent,
  runProfilesetAsync,
  profilesetResultsToActorMap,
  resolveInputDirectives,
} from "../sim/profilesets.js";
import { parse, getActionLists } from "../apl/parser.js";
import {
  getIterations,
  getTheory,
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

// --- APL diff ---

function computeAplDiff(baselinePath, oursPath) {
  const baselineText = readResolvedApl(baselinePath);
  const oursText = readResolvedApl(oursPath);

  const baselineLists = getActionLists(parse(baselineText));
  const oursLists = getActionLists(parse(oursText));

  const baselineNames = new Set(baselineLists.map((l) => l.name));
  const oursNames = new Set(oursLists.map((l) => l.name));

  const added = [...oursNames].filter((n) => !baselineNames.has(n));
  const removed = [...baselineNames].filter((n) => !oursNames.has(n));
  const shared = [...oursNames].filter((n) => baselineNames.has(n));

  const modified = [];
  for (const name of shared) {
    const bList = baselineLists.find((l) => l.name === name);
    const oList = oursLists.find((l) => l.name === name);
    const bActions = bList.entries.filter((e) => e.type !== "Comment");
    const oActions = oList.entries.filter((e) => e.type !== "Comment");

    if (
      bActions.length !== oActions.length ||
      !actionsEqual(bActions, oActions)
    ) {
      modified.push({
        name,
        baselineActions: bActions.length,
        oursActions: oActions.length,
      });
    }
  }

  return {
    added,
    removed,
    modified,
    baselineListCount: baselineLists.length,
    oursListCount: oursLists.length,
  };
}

function actionsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (actionString(a[i]) !== actionString(b[i])) return false;
  }
  return true;
}

function actionString(entry) {
  const parts = [entry.ability || entry.type];
  const mods = [...(entry.modifiers || [])].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [k, v] of mods) {
    parts.push(`${k}=${v}`);
  }
  return parts.join(",");
}

function readResolvedApl(aplPath) {
  const resolved = resolve(aplPath);
  const raw = readFileSync(resolved, "utf-8");
  return resolveInputDirectives(raw, dirname(resolved));
}

// --- Iteration changelog ---

function loadChangelog() {
  try {
    const iterations = getIterations({ decision: "accepted", limit: 200 });
    if (iterations.length === 0) return null;
    return iterations.map((it) => {
      const entry = {
        id: it.id,
        date: it.createdAt,
        hypothesis: it.reason || it.aplDiff || "",
        meanWeighted: it.aggregate?.meanWeighted ?? null,
      };
      if (it.hypothesisId) {
        try {
          const theory = getTheory(it.hypothesisId);
          if (theory) entry.theory = theory.title;
        } catch {
          // Theory lookup is optional
        }
      }
      return entry;
    });
  } catch {
    return null;
  }
}

// --- Merge sim results into per-build data ---

function mergeSimResults(roster, baselineMaps, oursMaps) {
  const builds = [];

  for (const build of roster.builds) {
    const row = {
      id: build.id,
      displayName: build.displayName || build.id,
      archetype: build.archetype || "",
      heroTree: build.heroTree || "",
      hash: build.hash,
      source: build.source || "",
      ours: {},
      baseline: {},
    };

    for (const scenario of Object.keys(SCENARIOS)) {
      const bMap = baselineMaps[scenario];
      const oMap = oursMaps[scenario];
      row.baseline[scenario] = bMap?.get(build.id)?.dps || 0;
      row.ours[scenario] = oMap?.get(build.id)?.dps || 0;
    }

    // Compute weighted
    row.baseline.weighted = Object.keys(SCENARIOS).reduce(
      (sum, s) => sum + (row.baseline[s] || 0) * (SCENARIO_WEIGHTS[s] || 0),
      0,
    );
    row.ours.weighted = Object.keys(SCENARIOS).reduce(
      (sum, s) => sum + (row.ours[s] || 0) * (SCENARIO_WEIGHTS[s] || 0),
      0,
    );

    builds.push(row);
  }

  return builds;
}

// Store sim results back to DB
function persistSimResults(roster, buildData) {
  for (const row of buildData) {
    const build = roster.builds.find((b) => b.id === row.id);
    if (!build?.hash) continue;

    // Our APL DPS
    if (row.ours.weighted > 0) {
      updateBuildDps(build.hash, {
        st: Math.round(row.ours.st || 0),
        small_aoe: Math.round(row.ours.small_aoe || 0),
        big_aoe: Math.round(row.ours.big_aoe || 0),
      });
    }

    // SimC baseline DPS
    if (row.baseline.weighted > 0) {
      updateBuildSimcDps(build.hash, {
        st: Math.round(row.baseline.st || 0),
        small_aoe: Math.round(row.baseline.small_aoe || 0),
        big_aoe: Math.round(row.baseline.big_aoe || 0),
      });
    }
  }
}

// Load cached results from DB (for --skip-sims)
function loadCachedResults(roster) {
  const builds = [];
  for (const build of roster.builds) {
    const row = {
      id: build.id,
      displayName: build.displayName || build.id,
      archetype: build.archetype || "",
      heroTree: build.heroTree || "",
      hash: build.hash,
      source: build.source || "",
      ours: {
        st: build.lastDps?.st || 0,
        small_aoe: build.lastDps?.small_aoe || 0,
        big_aoe: build.lastDps?.big_aoe || 0,
        weighted: build.lastDps?.weighted || 0,
      },
      baseline: { st: 0, small_aoe: 0, big_aoe: 0, weighted: 0 },
    };

    // simcDps comes from the DB rowToBuild
    const rawBuilds = roster._rawBuilds;
    const dbBuild = rawBuilds?.find((b) => b.hash === build.hash);
    if (dbBuild?.simcDps) {
      row.baseline = { ...dbBuild.simcDps };
    }

    builds.push(row);
  }
  return builds;
}

// --- HTML generation ---

function generateHtml({ specName, diff, buildData, changelog }) {
  const displaySpec = specName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const date = new Date().toISOString().split("T")[0];

  // Summary stats
  const hasBaseline = buildData.some((b) => b.baseline.weighted > 0);
  const stats = computeStats(buildData, hasBaseline);

  const sections = [];

  // Summary cards
  sections.push(renderSummaryCards(stats, hasBaseline, buildData.length));

  // Full roster table grouped by hero tree
  sections.push(renderRosterTable(buildData, hasBaseline));

  // APL diff
  if (diff) {
    sections.push(renderAplDiff(diff));
  }

  // Changelog
  if (changelog && changelog.length > 0) {
    sections.push(renderChangelog(changelog));
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(displaySpec)} APL Showcase</title>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <h1>${esc(displaySpec)} APL Showcase</h1>
  <p class="meta">Generated ${date} &middot; Midnight &middot; DPS Optimization &middot; ${buildData.length} builds</p>
</header>
<main>
${sections.join("\n")}
</main>
<footer>
  <p>Generated by dh-apl &middot; SimulationCraft</p>
</footer>
<script>
${JS}
</script>
</body>
</html>
`;
}

function computeStats(buildData, hasBaseline) {
  const scenarios = Object.keys(SCENARIOS);
  const stats = {
    avgDelta: 0,
    bestBuild: null,
    worstBuild: null,
    perScenario: {},
    scenarioWinners: {},
  };

  if (!hasBaseline) return stats;

  let totalWeightedDelta = 0;
  let count = 0;

  for (const b of buildData) {
    if (b.baseline.weighted <= 0) continue;
    const delta =
      ((b.ours.weighted - b.baseline.weighted) / b.baseline.weighted) * 100;
    totalWeightedDelta += delta;
    count++;

    if (!stats.bestBuild || delta > stats.bestBuild.delta) {
      stats.bestBuild = { name: b.displayName, delta };
    }
    if (!stats.worstBuild || delta < stats.worstBuild.delta) {
      stats.worstBuild = { name: b.displayName, delta };
    }
  }

  stats.avgDelta = count > 0 ? totalWeightedDelta / count : 0;

  for (const s of scenarios) {
    let total = 0;
    let n = 0;
    let best = null;

    for (const b of buildData) {
      if (b.baseline[s] <= 0) continue;
      const delta = ((b.ours[s] - b.baseline[s]) / b.baseline[s]) * 100;
      total += delta;
      n++;

      if (!best || b.ours[s] > best.dps) {
        best = { name: b.displayName, dps: b.ours[s], delta };
      }
    }

    stats.perScenario[s] = { avgDelta: n > 0 ? total / n : 0 };
    stats.scenarioWinners[s] = best;
  }

  return stats;
}

function renderSummaryCards(stats, hasBaseline, buildCount) {
  if (!hasBaseline) {
    return `<section class="cards">
  <div class="card"><div class="card-value">${buildCount}</div><div class="card-label">Roster builds</div></div>
  <div class="card"><div class="card-value">No baseline</div><div class="card-label">Run sims to compare</div></div>
</section>`;
  }

  const scenarios = Object.keys(SCENARIOS);
  let html = `<section class="cards">
  <div class="card accent"><div class="card-value ${stats.avgDelta >= 0 ? "positive" : "negative"}">${fmtDelta(stats.avgDelta)}</div><div class="card-label">Avg weighted improvement</div></div>
  <div class="card"><div class="card-value">${buildCount}</div><div class="card-label">Roster builds</div></div>`;

  for (const s of scenarios) {
    const sd = stats.perScenario[s];
    const name = SCENARIOS[s].name;
    html += `\n  <div class="card"><div class="card-value ${sd.avgDelta >= 0 ? "positive" : "negative"}">${fmtDelta(sd.avgDelta)}</div><div class="card-label">${esc(name)} avg</div></div>`;
  }

  if (stats.bestBuild) {
    html += `\n  <div class="card"><div class="card-value positive">${fmtDelta(stats.bestBuild.delta)}</div><div class="card-label">Best: ${esc(stats.bestBuild.name)}</div></div>`;
  }
  if (stats.worstBuild) {
    html += `\n  <div class="card"><div class="card-value ${stats.worstBuild.delta >= 0 ? "positive" : "negative"}">${fmtDelta(stats.worstBuild.delta)}</div><div class="card-label">Worst: ${esc(stats.worstBuild.name)}</div></div>`;
  }

  html += `\n</section>`;
  return html;
}

function renderRosterTable(buildData, hasBaseline) {
  // Group by hero tree
  const byTree = {};
  for (const b of buildData) {
    const tree = b.heroTree || "Unknown";
    (byTree[tree] ||= []).push(b);
  }

  const scenarios = Object.keys(SCENARIOS);
  let html = `<section>\n<h2>Full Roster Comparison</h2>`;

  for (const [tree, builds] of Object.entries(byTree)) {
    const displayTree = tree
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    // Sort by weighted DPS descending (ours)
    builds.sort((a, b) => (b.ours.weighted || 0) - (a.ours.weighted || 0));

    // Find per-scenario top builds within this tree
    const topPerScenario = {};
    for (const s of scenarios) {
      let best = null;
      for (const b of builds) {
        if (!best || (b.ours[s] || 0) > (best.ours[s] || 0)) best = b;
      }
      if (best) topPerScenario[s] = best.id;
    }
    // Top weighted
    const topWeighted = builds[0]?.id;

    html += `\n<h3>${esc(displayTree)} <span class="build-count">(${builds.length} builds)</span></h3>`;
    html += `\n<div class="table-wrap"><table class="roster-table" data-tree="${esc(tree)}">`;
    html += `\n<thead><tr>
  <th class="sortable" data-col="name">Build</th>
  <th class="sortable" data-col="archetype">Template</th>`;

    for (const s of scenarios) {
      const name = SCENARIOS[s].name;
      html += `\n  <th class="sortable num" data-col="${s}">${esc(name)}</th>`;
    }

    html += `\n  <th class="sortable num" data-col="weighted">Weighted</th>`;
    html += `\n</tr></thead>\n<tbody>`;

    for (const b of builds) {
      html += `\n<tr>`;
      html += `<td class="build-name">${esc(b.displayName)}</td>`;
      html += `<td class="archetype-cell">${esc(b.archetype)}</td>`;

      for (const s of scenarios) {
        const isTop = topPerScenario[s] === b.id;
        html += renderDpsCell(b.ours[s], b.baseline[s], hasBaseline, isTop);
      }

      const isTopW = topWeighted === b.id;
      html += renderDpsCell(
        b.ours.weighted,
        b.baseline.weighted,
        hasBaseline,
        isTopW,
      );

      html += `</tr>`;
    }

    html += `\n</tbody></table></div>`;
  }

  html += `\n</section>`;
  return html;
}

function renderDpsCell(ourDps, baselineDps, hasBaseline, isTop) {
  const topClass = isTop ? " top-build" : "";
  const badge = isTop ? '<span class="badge">TOP</span>' : "";

  if (!hasBaseline || baselineDps <= 0) {
    return `<td class="dps-cell${topClass}">${fmt(ourDps)}${badge}</td>`;
  }

  const delta = ((ourDps - baselineDps) / baselineDps) * 100;
  const cls = delta >= 0 ? "positive" : "negative";

  return `<td class="dps-cell${topClass}" title="Baseline: ${fmt(baselineDps)}" data-dps="${Math.round(ourDps)}" data-delta="${delta.toFixed(2)}">${fmt(ourDps)} <span class="${cls}">(${fmtDelta(delta)})</span>${badge}</td>`;
}

function renderAplDiff(diff) {
  let html = `<section>
<h2>APL Structure Changes</h2>
<p>Baseline: ${diff.baselineListCount} action lists &rarr; Ours: ${diff.oursListCount} action lists</p>`;

  if (diff.added.length > 0) {
    html += `<h3>Added Lists</h3><ul>`;
    for (const name of diff.added) {
      html += `<li><code>${esc(name)}</code></li>`;
    }
    html += `</ul>`;
  }

  if (diff.removed.length > 0) {
    html += `<h3>Removed Lists</h3><ul>`;
    for (const name of diff.removed) {
      html += `<li><code>${esc(name)}</code></li>`;
    }
    html += `</ul>`;
  }

  if (diff.modified.length > 0) {
    html += `<h3>Modified Lists</h3><table>
<thead><tr><th>List</th><th>Baseline Actions</th><th>Our Actions</th></tr></thead>
<tbody>`;
    for (const m of diff.modified) {
      html += `<tr><td><code>${esc(m.name)}</code></td><td>${m.baselineActions}</td><td>${m.oursActions}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.modified.length === 0
  ) {
    html += `<p>No structural differences detected.</p>`;
  }

  html += `</section>`;
  return html;
}

function renderChangelog(changelog) {
  let html = `<section>
<h2>Optimization Changelog</h2>
<table>
<thead><tr><th>#</th><th>Date</th><th>Change</th><th>Impact</th></tr></thead>
<tbody>`;

  for (const entry of changelog) {
    const date = entry.date ? entry.date.split("T")[0] : "\u2014";
    const impact =
      entry.meanWeighted != null
        ? `${entry.meanWeighted >= 0 ? "+" : ""}${entry.meanWeighted.toFixed(3)}%`
        : "\u2014";
    const cls = (entry.meanWeighted || 0) >= 0 ? "positive" : "negative";
    html += `<tr><td>${entry.id}</td><td>${date}</td><td>${esc(entry.hypothesis || "")}</td><td class="${cls}">${impact}</td></tr>`;
  }

  html += `</tbody></table></section>`;
  return html;
}

// --- Utilities ---

function fmt(n) {
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
  --code-bg: #1e2030;
  --radius: 8px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.6;
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 1.5rem;
}

header {
  padding: 2.5rem 0 1.5rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2rem;
}

header h1 {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--accent), #a78bfa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

header .meta {
  color: var(--fg-muted);
  margin-top: 0.35rem;
  font-size: 0.85rem;
}

main { padding-bottom: 3rem; }

section { margin-bottom: 2.5rem; }

h2 {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--fg);
  padding-bottom: 0.5rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}

h3 {
  font-size: 1rem;
  font-weight: 600;
  margin: 1.25rem 0 0.5rem;
  color: var(--fg-muted);
}

.build-count {
  font-weight: 400;
  color: var(--fg-muted);
  font-size: 0.85rem;
}

/* Summary cards */
.cards {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 2rem;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem 1.25rem;
  min-width: 140px;
  flex: 1;
}

.card.accent {
  border-color: var(--accent-dim);
  background: linear-gradient(135deg, rgba(108, 138, 255, 0.06), transparent);
}

.card-value {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.card-label {
  font-size: 0.75rem;
  color: var(--fg-muted);
  margin-top: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

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

th.num, td.dps-cell { text-align: right; }

tbody tr { background: var(--bg); }
tbody tr:nth-child(even) { background: var(--surface-alt); }
tbody tr:hover { background: rgba(108, 138, 255, 0.06); }

td { white-space: nowrap; }

.build-name {
  font-weight: 500;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 0.78rem;
}

.archetype-cell {
  color: var(--fg-muted);
  font-size: 0.78rem;
}

.dps-cell { font-variant-numeric: tabular-nums; }

.dps-cell.top-build {
  background: var(--gold-bg);
}

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

.positive { color: var(--positive); font-weight: 600; }
.negative { color: var(--negative); font-weight: 600; }

code {
  font-family: "SF Mono", "Fira Code", monospace;
  background: var(--code-bg);
  padding: 0.15em 0.4em;
  border-radius: 3px;
  font-size: 0.85em;
}

ul { margin-left: 1.5rem; margin-bottom: 0.75rem; }
li { margin-bottom: 0.25rem; }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

footer {
  border-top: 1px solid var(--border);
  padding: 1.5rem 0;
  text-align: center;
  color: var(--fg-muted);
  font-size: 0.8rem;
}

@media (max-width: 768px) {
  table { font-size: 0.72rem; }
  th, td { padding: 0.35rem 0.5rem; }
  .cards { gap: 0.5rem; }
  .card { min-width: 120px; padding: 0.75rem; }
  .card-value { font-size: 1.1rem; }
}
`;

// --- Interactive JS ---

const JS = `
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const table = th.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const col = th.dataset.col;
    const isNum = th.classList.contains('num');

    // Determine sort direction
    const wasAsc = th.classList.contains('sorted-asc');
    table.querySelectorAll('th.sortable').forEach(h => {
      h.classList.remove('sorted-asc', 'sorted-desc');
    });
    const dir = wasAsc ? 'desc' : 'asc';
    th.classList.add('sorted-' + dir);

    // Column index
    const headers = Array.from(th.parentNode.children);
    const colIdx = headers.indexOf(th);

    rows.sort((a, b) => {
      const cellA = a.children[colIdx];
      const cellB = b.children[colIdx];
      let va, vb;

      if (isNum) {
        va = parseFloat(cellA?.dataset?.dps || cellA?.textContent?.replace(/[^\\d.-]/g, '') || '0');
        vb = parseFloat(cellB?.dataset?.dps || cellB?.textContent?.replace(/[^\\d.-]/g, '') || '0');
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
`;

// --- Main ---

async function main() {
  await initSpec(parseSpecArg());
  const specName = config.spec.specName;
  const opts = parseArgs();

  console.log(`Generating showcase report for ${specName}...`);

  // Load roster
  const roster = loadRoster();
  if (!roster || roster.builds.length === 0) {
    console.error("No build roster found. Run: npm run roster generate");
    process.exit(1);
  }

  // Keep raw DB builds for simcDps access in skip-sims mode
  const { getRosterBuilds } = await import("../util/db.js");
  roster._rawBuilds = getRosterBuilds();

  console.log(`  Roster: ${roster.builds.length} builds`);

  // APL paths
  const baselinePath = join(aplsDir(), "baseline.simc");
  const oursPath = join(aplsDir(), `${specName}.simc`);
  const hasBaseline = existsSync(baselinePath);
  const hasOurs = existsSync(oursPath);

  if (!hasOurs) {
    console.error(`Our APL not found: ${oursPath}`);
    process.exit(1);
  }

  // Compute APL diff
  let diff = null;
  if (hasBaseline) {
    console.log("  Computing APL diff...");
    diff = computeAplDiff(baselinePath, oursPath);
    console.log(
      `  Diff: +${diff.added.length} lists, -${diff.removed.length} lists, ~${diff.modified.length} modified`,
    );
  }

  // Run sims or load cached
  let buildData;
  const showcaseDir = join(resultsDir(), "showcase");

  if (!opts.skipSims && hasBaseline) {
    const fidelityOpts =
      FIDELITY_TIERS[opts.fidelity] || FIDELITY_TIERS.standard;

    console.log(
      `\n  Running sims: ${roster.builds.length} builds x 3 scenarios x 2 APLs (${opts.fidelity} fidelity)...`,
    );

    const baselineMaps = {};
    const oursMaps = {};

    for (const scenario of Object.keys(SCENARIOS)) {
      console.log(`\n  --- ${SCENARIOS[scenario].name} ---`);

      console.log(`  Baseline APL...`);
      baselineMaps[scenario] = await runRosterSim(
        roster,
        baselinePath,
        scenario,
        "showcase_baseline",
        fidelityOpts,
      );

      console.log(`  Our APL...`);
      oursMaps[scenario] = await runRosterSim(
        roster,
        oursPath,
        scenario,
        "showcase_ours",
        fidelityOpts,
      );
    }

    buildData = mergeSimResults(roster, baselineMaps, oursMaps);
    persistSimResults(roster, buildData);
    console.log(`\n  Results cached to DB.`);
  } else if (opts.skipSims) {
    console.log("  Loading cached DPS from DB...");
    buildData = loadCachedResults(roster);
    const withBaseline = buildData.filter(
      (b) => b.baseline.weighted > 0,
    ).length;
    console.log(
      `  ${buildData.length} builds loaded (${withBaseline} with baseline data)`,
    );
  } else {
    console.log("  No baseline APL — running with roster DPS only");
    buildData = loadCachedResults(roster);
  }

  // Load changelog
  const changelog = loadChangelog();

  // Generate HTML
  mkdirSync(showcaseDir, { recursive: true });
  const html = generateHtml({ specName, diff, buildData, changelog });

  const indexPath = join(showcaseDir, "index.html");
  writeFileSync(indexPath, html);

  console.log(`\nShowcase report written to ${showcaseDir}/index.html`);
  console.log(`  ${buildData.length} builds in report`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
