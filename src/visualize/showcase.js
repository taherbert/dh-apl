// Generates a self-contained HTML showcase report for sharing APL optimization results.
// Compares our APL against the SimC default (baseline) across multiple talent builds.
//
// Usage: node src/visualize/showcase.js [options]
//   --skip-sims           Generate from cached roster DPS only (no SimC HTML reports)
//   --community <path>    Path to community builds JSON
//   --fidelity <tier>     quick|standard|confirm (default: standard)
//   --builds <N>          Builds per hero tree for showcase sims (default: 3)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus } from "node:os";

import {
  config,
  SIMC_BIN,
  DATA_ENV,
  SCENARIOS,
  SCENARIO_WEIGHTS,
  FIDELITY_TIERS,
  initSpec,
  getSpecAdapter,
} from "../engine/startup.js";
import { parseSpecArg } from "../util/parse-spec-arg.js";
import {
  resultsDir,
  resultsFile,
  dataFile,
  aplsDir,
  ROOT,
} from "../engine/paths.js";
import { loadRoster } from "../sim/build-roster.js";
import { generateMultiActorContent } from "../sim/multi-actor.js";
import { parseMultiActorResults } from "../sim/runner.js";
import { resolveInputDirectives } from "../sim/profilesets.js";
import { parse, getActionLists } from "../apl/parser.js";
import { getIterations, getTheory } from "../util/db.js";

const execFileAsync = promisify(execFile);

// --- CLI ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    skipSims: false,
    communityPath: null,
    fidelity: "standard",
    buildsPerTree: 3,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--skip-sims":
        opts.skipSims = true;
        break;
      case "--community":
        opts.communityPath = args[++i];
        break;
      case "--fidelity":
        opts.fidelity = args[++i];
        break;
      case "--builds":
        opts.buildsPerTree = parseInt(args[++i], 10);
        break;
    }
  }

  if (!opts.communityPath) {
    opts.communityPath = dataFile("community-builds.json");
  }

  return opts;
}

// --- Build selection ---

function selectShowcaseBuilds(roster, communityBuilds, buildsPerTree) {
  const byTree = {};
  for (const build of roster.builds) {
    if (!byTree[build.heroTree]) byTree[build.heroTree] = [];
    byTree[build.heroTree].push(build);
  }

  // Sort each tree by weighted DPS descending, pick top N
  const selected = [];
  const selectedIds = new Set();

  for (const [tree, builds] of Object.entries(byTree)) {
    builds.sort(
      (a, b) => (b.lastDps?.weighted || 0) - (a.lastDps?.weighted || 0),
    );
    for (const build of builds.slice(0, buildsPerTree)) {
      selected.push(build);
      selectedIds.add(build.id);
    }
  }

  // Add community builds (skip duplicates by hash)
  const selectedHashes = new Set(selected.map((b) => b.hash).filter(Boolean));
  for (const cb of communityBuilds) {
    if (selectedHashes.has(cb.hash)) continue;
    selected.push({
      id: `Community_${cb.name.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      archetype: cb.name,
      heroTree: cb.heroTree,
      hash: cb.hash,
      source: cb.source || "community",
      lastDps: null,
    });
    selectedHashes.add(cb.hash);
  }

  // Cap at ~12 total
  return selected.slice(0, 12);
}

// --- Sim execution ---

async function runShowcaseSim(
  miniRoster,
  aplPath,
  scenario,
  label,
  outputDir,
  fidelityOpts,
) {
  const content = generateMultiActorContent({ builds: miniRoster }, aplPath);

  mkdirSync(outputDir, { recursive: true });

  const simcPath = join(outputDir, `${label}_${scenario}.simc`);
  const jsonPath = join(outputDir, `${label}_${scenario}.json`);
  const htmlPath = join(outputDir, `${label}_${scenario}.html`);

  writeFileSync(simcPath, content);

  const scenarioConfig = SCENARIOS[scenario];
  const threads = cpus().length;

  const args = [
    simcPath,
    `max_time=${scenarioConfig.maxTime}`,
    `desired_targets=${scenarioConfig.desiredTargets}`,
    `target_error=${fidelityOpts.target_error}`,
    `iterations=5000000`,
    `json2=${jsonPath}`,
    `html=${htmlPath}`,
    `threads=${threads}`,
    "buff_uptime_timeline=0",
    "buff_stack_uptime_timeline=0",
  ];

  if (DATA_ENV === "ptr" || DATA_ENV === "beta") {
    args.unshift("ptr=1");
  }

  console.log(`  Running ${label} ${scenarioConfig.name}...`);
  try {
    await execFileAsync(SIMC_BIN, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 600000,
    });
  } catch (e) {
    if (e.stdout) console.log(e.stdout.split("\n").slice(-10).join("\n"));
    throw new Error(`SimC failed for ${label}_${scenario}: ${e.message}`);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch (e) {
    throw new Error(
      `Failed to parse SimC output for ${label}_${scenario}: ${e.message}`,
    );
  }
  return parseMultiActorResults(data);
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

// --- Build rankings from roster ---

function computeRankings(roster) {
  const builds = roster.builds.filter((b) => b.lastDps?.weighted);
  builds.sort((a, b) => b.lastDps.weighted - a.lastDps.weighted);

  const topOverall = builds.slice(0, 5);

  const topByScenario = {};
  for (const scenario of Object.keys(SCENARIOS)) {
    const sorted = [...builds]
      .filter((b) => b.lastDps?.[scenario])
      .sort((a, b) => b.lastDps[scenario] - a.lastDps[scenario]);
    topByScenario[scenario] = sorted.slice(0, 3);
  }

  const topByTree = {};
  for (const build of builds) {
    if (!topByTree[build.heroTree]) {
      topByTree[build.heroTree] = build;
    }
  }

  return { topOverall, topByScenario, topByTree };
}

// --- Iteration changelog ---

function loadChangelog() {
  // Try DB first (unified theorycraft.db)
  try {
    const iterations = getIterations({ decision: "accepted", limit: 200 });
    if (iterations.length > 0) {
      return iterations.map((it) => {
        const entry = {
          id: it.id,
          date: it.createdAt,
          hypothesis: it.reason || it.aplDiff || "",
          meanWeighted: it.aggregate?.meanWeighted ?? null,
        };
        // Add theory attribution if hypothesis is linked to a theory
        if (it.hypothesisId) {
          try {
            // Look up theory via hypothesis → theory chain
            const theory = getTheory(it.hypothesisId);
            if (theory) entry.theory = theory.title;
          } catch {
            // Theory lookup is optional
          }
        }
        return entry;
      });
    }
  } catch {
    // DB not available, fall through to legacy
  }

  // Fallback: legacy iteration-state.json
  const statePath = resultsFile("iteration-state.json");
  if (!existsSync(statePath)) return null;

  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    if (!state.iterations) return null;

    return state.iterations
      .filter((it) => it.decision === "accepted")
      .map((it) => ({
        id: it.id,
        date: it.timestamp,
        hypothesis: it.hypothesis,
        meanWeighted: it.comparison?.aggregates?.meanWeighted,
      }));
  } catch {
    return null;
  }
}

// --- HTML generation ---

function generateHtml({
  specName,
  diff,
  rankings,
  communityBuilds,
  simResults,
  changelog,
  skipSims,
}) {
  const displaySpec = specName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const date = new Date().toISOString().split("T")[0];

  // Compute summary line
  let summaryLine = "";
  if (simResults && simResults.length > 0) {
    const avgDelta = computeAvgDelta(simResults);
    const buildCount = simResults[0].builds.length;
    summaryLine = `Our APL improves DPS by ${avgDelta >= 0 ? "+" : ""}${avgDelta.toFixed(2)}% (weighted) across ${buildCount} builds.`;
  } else if (rankings.topOverall.length > 0) {
    summaryLine = `Ranked ${rankings.topOverall.length} builds. Top weighted DPS: ${fmt(rankings.topOverall[0].lastDps.weighted)}.`;
  }

  const sections = [];

  // TL;DR
  if (summaryLine) {
    sections.push(`<section class="tldr"><p>${esc(summaryLine)}</p></section>`);
  }

  // DPS Comparison Table (from sims)
  if (simResults && simResults.length > 0) {
    sections.push(renderComparisonTable(simResults));
  }

  // APL Changes Summary
  if (diff) {
    sections.push(renderAplDiff(diff));
  }

  // Build Rankings (from cached roster)
  sections.push(renderRankings(rankings));

  // Community Builds
  if (communityBuilds.length > 0) {
    sections.push(renderCommunityBuilds(communityBuilds, rankings));
  }

  // SimC Reports links
  if (!skipSims && simResults) {
    sections.push(renderSimLinks());
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
  <p class="meta">Generated ${date} &middot; Midnight &middot; DPS Optimization</p>
</header>
<main>
${sections.join("\n")}
</main>
<footer>
  <p>Generated by <a href="https://github.com/dh-apl">dh-apl</a> &middot; SimulationCraft</p>
</footer>
</body>
</html>
`;
}

function computeAvgDelta(simResults) {
  // Each simResult has { scenario, builds: [{ id, baseline, ours }] }
  // Compute weighted average delta across scenarios
  let totalWeight = 0;
  let totalDelta = 0;

  for (const sr of simResults) {
    const weight = SCENARIO_WEIGHTS[sr.scenario] || 0;
    for (const b of sr.builds) {
      if (b.baseline > 0) {
        totalDelta += ((b.ours - b.baseline) / b.baseline) * 100 * weight;
        totalWeight += weight;
      }
    }
  }

  return totalWeight > 0 ? totalDelta / totalWeight : 0;
}

function renderComparisonTable(simResults) {
  const scenarios = simResults.map((sr) => sr.scenario);
  const buildIds = simResults[0].builds.map((b) => b.id);

  let html = `<section>
<h2>DPS Comparison: Our APL vs Baseline</h2>
<table>
<thead>
<tr>
  <th>Build</th>`;

  for (const s of scenarios) {
    const name = SCENARIOS[s]?.name || s;
    html += `<th colspan="3">${esc(name)}</th>`;
  }
  html += `</tr>
<tr>
  <th></th>`;
  for (const s of scenarios) {
    html += `<th>Baseline</th><th>Ours</th><th>Delta</th>`;
  }
  html += `</tr>
</thead>
<tbody>`;

  for (const buildId of buildIds) {
    html += `<tr><td class="build-id">${esc(buildId)}</td>`;
    for (const sr of simResults) {
      const b = sr.builds.find((x) => x.id === buildId);
      if (!b) {
        html += `<td>—</td><td>—</td><td>—</td>`;
        continue;
      }
      const delta =
        b.baseline > 0 ? ((b.ours - b.baseline) / b.baseline) * 100 : 0;
      const cls = delta >= 0 ? "positive" : "negative";
      html += `<td>${fmt(b.baseline)}</td><td>${fmt(b.ours)}</td><td class="${cls}">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%</td>`;
    }
    html += `</tr>`;
  }

  html += `</tbody></table></section>`;
  return html;
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

function renderRankings(rankings) {
  let html = `<section>
<h2>Build Rankings</h2>
<h3>Top 5 Overall (Weighted)</h3>
<table>
<thead><tr><th>#</th><th>Build</th><th>Hero Tree</th><th>Archetype</th>`;
  for (const s of Object.keys(SCENARIOS)) {
    html += `<th>${esc(SCENARIOS[s].name)}</th>`;
  }
  html += `<th>Weighted</th></tr></thead><tbody>`;

  for (let i = 0; i < rankings.topOverall.length; i++) {
    const b = rankings.topOverall[i];
    html += `<tr><td>${i + 1}</td><td class="build-id">${esc(b.id)}</td><td>${esc(b.heroTree)}</td><td>${esc(b.archetype || "")}</td>`;
    for (const s of Object.keys(SCENARIOS)) {
      html += `<td>${fmt(b.lastDps?.[s] || 0)}</td>`;
    }
    html += `<td><strong>${fmt(b.lastDps?.weighted || 0)}</strong></td></tr>`;
  }
  html += `</tbody></table>`;

  // Best per hero tree
  html += `<h3>Best per Hero Tree</h3><table>
<thead><tr><th>Hero Tree</th><th>Build</th><th>Archetype</th><th>Weighted</th></tr></thead><tbody>`;
  for (const [tree, build] of Object.entries(rankings.topByTree)) {
    html += `<tr><td>${esc(tree)}</td><td class="build-id">${esc(build.id)}</td><td>${esc(build.archetype || "")}</td><td>${fmt(build.lastDps?.weighted || 0)}</td></tr>`;
  }
  html += `</tbody></table></section>`;

  return html;
}

function renderCommunityBuilds(communityBuilds, rankings) {
  const allBuilds = rankings.topOverall;
  const topWeighted =
    allBuilds.length > 0 ? allBuilds[0].lastDps?.weighted || 0 : 0;

  let html = `<section>
<h2>Community Builds</h2>
<table>
<thead><tr><th>Name</th><th>Source</th><th>Hero Tree</th><th>Hash</th></tr></thead>
<tbody>`;

  for (const cb of communityBuilds) {
    const hashDisplay = cb.hash ? cb.hash.slice(0, 20) + "..." : "—";
    html += `<tr><td>${esc(cb.name)}</td><td>${esc(cb.source || "")}</td><td>${esc(cb.heroTree)}</td><td class="hash">${esc(hashDisplay)}</td></tr>`;
  }

  html += `</tbody></table></section>`;
  return html;
}

function renderSimLinks() {
  const scenarios = Object.keys(SCENARIOS);
  let html = `<section>
<h2>Detailed SimC Reports</h2>
<table>
<thead><tr><th>Scenario</th><th>Baseline</th><th>Our APL</th></tr></thead>
<tbody>`;

  for (const s of scenarios) {
    const name = SCENARIOS[s]?.name || s;
    html += `<tr><td>${esc(name)}</td><td><a href="baseline_${s}.html">baseline_${s}.html</a></td><td><a href="optimized_${s}.html">optimized_${s}.html</a></td></tr>`;
  }

  html += `</tbody></table></section>`;
  return html;
}

function renderChangelog(changelog) {
  let html = `<section>
<h2>Optimization Changelog</h2>
<table>
<thead><tr><th>#</th><th>Date</th><th>Change</th><th>Impact</th></tr></thead>
<tbody>`;

  for (const entry of changelog) {
    const date = entry.date ? entry.date.split("T")[0] : "—";
    const impact =
      entry.meanWeighted != null
        ? `${entry.meanWeighted >= 0 ? "+" : ""}${entry.meanWeighted.toFixed(3)}%`
        : "—";
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
  --bg: #fafafa;
  --fg: #1a1a1a;
  --accent: #2563eb;
  --border: #e5e7eb;
  --positive: #16a34a;
  --negative: #dc2626;
  --muted: #6b7280;
  --code-bg: #f3f4f6;
  --table-stripe: #f9fafb;
  --header-bg: #1e293b;
  --header-fg: #f8fafc;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.6;
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 1rem;
}

header {
  background: var(--header-bg);
  color: var(--header-fg);
  padding: 2rem;
  margin: 0 -1rem 2rem;
  border-radius: 0 0 8px 8px;
}

header h1 { font-size: 1.75rem; font-weight: 700; }
header .meta { color: #94a3b8; margin-top: 0.25rem; font-size: 0.9rem; }

main { padding-bottom: 3rem; }

section { margin-bottom: 2.5rem; }

h2 {
  font-size: 1.3rem;
  font-weight: 600;
  border-bottom: 2px solid var(--accent);
  padding-bottom: 0.4rem;
  margin-bottom: 1rem;
}

h3 {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 1rem 0 0.5rem;
  color: var(--muted);
}

.tldr {
  background: #eff6ff;
  border-left: 4px solid var(--accent);
  padding: 1rem 1.25rem;
  border-radius: 0 6px 6px 0;
  font-size: 1.05rem;
  font-weight: 500;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

th, td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

th {
  background: var(--code-bg);
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--muted);
  white-space: nowrap;
}

tbody tr:nth-child(even) { background: var(--table-stripe); }
tbody tr:hover { background: #eef2ff; }

td { white-space: nowrap; }
td:first-child { font-weight: 500; }

.build-id { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8rem; }
.hash { font-family: "SF Mono", "Fira Code", monospace; font-size: 0.75rem; color: var(--muted); }

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
  color: var(--muted);
  font-size: 0.85rem;
}

@media (max-width: 768px) {
  table { font-size: 0.75rem; }
  th, td { padding: 0.35rem 0.5rem; }
  header { padding: 1.25rem; }
  header h1 { font-size: 1.3rem; }
}
`;

// --- Main ---

async function main() {
  await initSpec(parseSpecArg());
  const specConfig = getSpecAdapter().getSpecConfig();
  const specName = config.spec.specName;
  const opts = parseArgs();

  console.log(`Generating showcase report for ${specName}...`);

  // Load roster
  const roster = loadRoster();
  if (!roster || roster.builds.length === 0) {
    console.error("No build roster found. Run: npm run roster migrate");
    process.exit(1);
  }

  // Load community builds
  let communityBuilds = [];
  if (existsSync(opts.communityPath)) {
    try {
      const data = JSON.parse(readFileSync(opts.communityPath, "utf-8"));
      communityBuilds = data.builds || [];
      console.log(`  Loaded ${communityBuilds.length} community builds`);
    } catch (e) {
      console.warn(`  Failed to load community builds: ${e.message}`);
    }
  }

  // APL paths
  const baselinePath = join(aplsDir(), "baseline.simc");
  const oursPath = join(aplsDir(), `${specName}.simc`);
  const hasBaseline = existsSync(baselinePath);
  const hasOurs = existsSync(oursPath);

  if (!hasOurs) {
    console.error(`Our APL not found: ${oursPath}`);
    process.exit(1);
  }

  // Compute APL diff (only if baseline exists)
  let diff = null;
  if (hasBaseline) {
    console.log("  Computing APL diff...");
    diff = computeAplDiff(baselinePath, oursPath);
    console.log(
      `  Diff: +${diff.added.length} lists, -${diff.removed.length} lists, ~${diff.modified.length} modified`,
    );
  } else {
    console.log("  No baseline APL found — skipping diff and comparison sims");
  }

  // Compute rankings from cached roster DPS
  const rankings = computeRankings(roster);

  // Run sims if not skipped (requires baseline)
  let simResults = null;
  const showcaseDir = join(resultsDir(), "showcase");

  if (!opts.skipSims && hasBaseline) {
    const miniRoster = selectShowcaseBuilds(
      roster,
      communityBuilds,
      opts.buildsPerTree,
    );

    // Filter to builds with hashes (required for multi-actor)
    const hashBuilds = miniRoster.filter((b) => b.hash);
    if (hashBuilds.length === 0) {
      console.error("No builds with talent hashes available for sims.");
      console.error("Run: npm run roster generate-hashes");
      process.exit(1);
    }

    console.log(`  Running showcase sims with ${hashBuilds.length} builds...`);
    const fidelityOpts =
      FIDELITY_TIERS[opts.fidelity] || FIDELITY_TIERS.standard;

    simResults = [];
    for (const scenario of Object.keys(SCENARIOS)) {
      // Run baseline
      const baselineResults = await runShowcaseSim(
        hashBuilds,
        baselinePath,
        scenario,
        "baseline",
        showcaseDir,
        fidelityOpts,
      );

      // Run ours
      const oursResults = await runShowcaseSim(
        hashBuilds,
        oursPath,
        scenario,
        "optimized",
        showcaseDir,
        fidelityOpts,
      );

      // Merge results
      const builds = [];
      for (const build of hashBuilds) {
        const bDps = baselineResults.get(build.id)?.dps || 0;
        const oDps = oursResults.get(build.id)?.dps || 0;
        builds.push({ id: build.id, baseline: bDps, ours: oDps });
      }

      simResults.push({ scenario, builds });
    }
  }

  // Load changelog
  const changelog = loadChangelog();

  // Generate HTML
  mkdirSync(showcaseDir, { recursive: true });
  const html = generateHtml({
    specName,
    diff,
    rankings,
    communityBuilds,
    simResults,
    changelog,
    skipSims: opts.skipSims,
  });

  const indexPath = join(showcaseDir, "index.html");
  writeFileSync(indexPath, html);

  console.log(`\nShowcase report written to ${showcaseDir}/`);
  console.log(`  index.html — summary report`);
  if (!opts.skipSims) {
    for (const s of Object.keys(SCENARIOS)) {
      console.log(`  baseline_${s}.html — SimC baseline report`);
      console.log(`  optimized_${s}.html — SimC our APL report`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
