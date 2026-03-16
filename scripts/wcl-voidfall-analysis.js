#!/usr/bin/env node

// Voidfall proc rate analysis for VENGEANCE Demon Hunter (improved v2)
// Same methodology as Devourer analysis for apples-to-apples comparison.
//
// Trigger: Fracture (263642) - uses voidfall_building_trigger_t
// Guaranteed source excluded via attribution window:
//   - Mass Acceleration: building stacks from Metamorphosis cast
//
// Methodology: building gain within ATTRIBUTION_WINDOW_MS of Fracture = proc
// Hidden conversions: removebuff + spending applybuff at same ts without visible
//   applybuffstack = final stack gain that WCL didn't emit explicitly

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const FRACTURE_SPELL_ID = 263642;
const VOIDFALL_BUILDING_ID = 1256301;
const VOIDFALL_SPENDING_ID = 1256302;
const EXPECTED_RATE = 0.35;
const ATTRIBUTION_WINDOW_MS = 200;

// Sort priority: casts first, then building, then spending
const SRC_ORDER = { fracture: 0, building: 1, spending: 2 };

const MIDNIGHT_ZONES = [
  { id: 162526, name: "Algeth'ar Academy (Beta)" },
  { id: 62811, name: "Magister's Terrace (Beta)" },
  { id: 62874, name: "Maisara Caverns (Beta)" },
  { id: 62915, name: "Nexus-Point Xenas (Beta)" },
  { id: 60658, name: "Pit of Saron (Beta)" },
  { id: 411753, name: "Seat of the Triumvirate (Beta)" },
  { id: 111209, name: "Skyreach (Beta)" },
  { id: 62805, name: "Windrunner Spire (Beta)" },
  { id: 53176, name: "Imperator Averzian (Beta)" },
  { id: 53177, name: "Vorasius (Beta)" },
  { id: 53178, name: "Vaelgor & Ezzorak (Beta)" },
  { id: 53179, name: "Fallen-King Salhadaar (Beta)" },
  { id: 53180, name: "Lightblinded Vanguard (Beta)" },
  { id: 53181, name: "Crown of the Cosmos (Beta)" },
  { id: 53306, name: "Chimaerus the Undreamt God (Beta)" },
  { id: 53182, name: "Belo'ren, Child of Al'ar (Beta)" },
  { id: 53183, name: "Midnight Falls (Beta)" },
  { id: 112526, name: "Algeth'ar Academy (S1)" },
  { id: 12811, name: "Magister's Terrace (S1)" },
  { id: 12874, name: "Maisara Caverns (S1)" },
  { id: 12915, name: "Nexus-Point Xenas (S1)" },
  { id: 10658, name: "Pit of Saron (S1)" },
  { id: 361753, name: "Seat of the Triumvirate (S1)" },
  { id: 61209, name: "Skyreach (S1)" },
  { id: 12805, name: "Windrunner Spire (S1)" },
  { id: 3176, name: "Imperator Averzian (Live)" },
  { id: 3177, name: "Vorasius (Live)" },
  { id: 3178, name: "Vaelgor & Ezzorak (Live)" },
  { id: 3179, name: "Fallen-King Salhadaar (Live)" },
  { id: 3180, name: "Lightblinded Vanguard (Live)" },
  { id: 3181, name: "Crown of the Cosmos (Live)" },
  { id: 3306, name: "Chimaerus the Undreamt God (Live)" },
  { id: 3182, name: "Belo'ren, Child of Al'ar (Live)" },
  { id: 3183, name: "Midnight Falls (Live)" },
];

function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
loadEnv();

const CLIENT_ID = process.env.WCL_CLIENT_ID;
const CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET in .env");
  process.exit(1);
}

let accessToken = null;

async function authenticate() {
  const resp = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  accessToken = (await resp.json()).access_token;
  console.log("Authenticated with WCL API");
}

async function graphql(query, variables = {}) {
  const resp = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`GraphQL error: ${resp.status}`);
  const result = await resp.json();
  if (result.errors)
    throw new Error(`GraphQL: ${JSON.stringify(result.errors)}`);
  return result.data;
}

async function getRankingsForEncounter(encounterId, page = 1) {
  const data = await graphql(
    `
      query ($id: Int!, $page: Int!) {
        worldData {
          encounter(id: $id) {
            characterRankings(
              specName: "Vengeance"
              className: "DemonHunter"
              metric: dps
              leaderboard: Any
              page: $page
            )
          }
        }
      }
    `,
    { id: encounterId, page },
  );
  const rankings = data.worldData.encounter?.characterRankings;
  if (!rankings?.rankings?.length) return { reports: [], hasMore: false };
  return {
    reports: rankings.rankings
      .filter((r) => r.report?.code && r.report?.fightID)
      .map((r) => ({
        code: r.report.code,
        fightID: r.report.fightID,
        name: r.name || "Unknown",
        server: r.server?.name,
      })),
    hasMore: rankings.hasMorePages || false,
  };
}

function stableSort(events) {
  events.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return (SRC_ORDER[a._src] || 0) - (SRC_ORDER[b._src] || 0);
  });
}

function deduplicateEvents(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.sourceID}:${e.timestamp}:${e._src}:${e.type}:${e.stack ?? ""}:${e.abilityGameID ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getFightEvents(reportCode, fightID) {
  const fightData = await graphql(
    `
      query ($code: String!) {
        reportData {
          report(code: $code) {
            fights {
              id
              startTime
              endTime
              name
              kill
            }
          }
        }
      }
    `,
    { code: reportCode },
  );
  const fight = fightData.reportData.report.fights.find(
    (f) => f.id === fightID,
  );
  if (!fight) return null;

  const duration = (fight.endTime - fight.startTime) / 1000;
  console.log(
    `  Fight: ${fight.name} (${duration.toFixed(0)}s, kill=${fight.kill})`,
  );

  const events = [];
  let hasMore = true;
  let nextTimestamp = 0;

  while (hasMore) {
    const data = await graphql(
      `query($code: String!, $fightID: Int!, $start: Float!, $end: Float!) {
        reportData { report(code: $code) {
          fractures: events(
            fightIDs: [$fightID] startTime: $start endTime: $end
            dataType: Casts sourceClass: "DemonHunter"
            abilityID: ${FRACTURE_SPELL_ID}
          ) { data nextPageTimestamp }
          building: events(
            fightIDs: [$fightID] startTime: $start endTime: $end
            dataType: Buffs sourceClass: "DemonHunter"
            abilityID: ${VOIDFALL_BUILDING_ID}
          ) { data nextPageTimestamp }
          spending: events(
            fightIDs: [$fightID] startTime: $start endTime: $end
            dataType: Buffs sourceClass: "DemonHunter"
            abilityID: ${VOIDFALL_SPENDING_ID}
          ) { data nextPageTimestamp }
        }}
      }`,
      {
        code: reportCode,
        fightID,
        start: nextTimestamp,
        end: fight.endTime,
      },
    );

    const r = data.reportData.report;
    events.push(
      ...(r.fractures.data || []).map((e) => ({ ...e, _src: "fracture" })),
    );
    events.push(
      ...(r.building.data || []).map((e) => ({ ...e, _src: "building" })),
    );
    events.push(
      ...(r.spending.data || []).map((e) => ({ ...e, _src: "spending" })),
    );

    const nexts = [
      r.fractures.nextPageTimestamp,
      r.building.nextPageTimestamp,
      r.spending.nextPageTimestamp,
    ].filter(Boolean);
    if (nexts.length) {
      nextTimestamp = Math.min(...nexts);
    } else {
      hasMore = false;
    }
  }

  const deduped = deduplicateEvents(events);
  stableSort(deduped);
  return { fight, events: deduped };
}

function analyzeEvents(events) {
  let buildingStacks = 0;
  let spendingActive = false;

  const results = {
    byStack: {},
    totalEligible: 0,
    totalProcs: 0,
    totalSkipped: 0,
    guaranteedGains: 0,
    hiddenConversions: 0,
    visibleProcs: 0,
    delayHistogram: { 0: 0, 10: 0, 20: 0, 50: 0, 100: 0, 200: 0, far: 0 },
  };

  // Pre-compute spending start timestamps
  const spendingStartTimes = new Set();
  for (const e of events) {
    if (e._src === "spending" && e.type === "applybuff")
      spendingStartTimes.add(e.timestamp);
  }

  // Pre-compute double-count guard
  const buildingEvents = events.filter((e) => e._src === "building");
  const tsWithVisibleStackAndRemove = new Set();
  for (let i = 0; i < buildingEvents.length - 1; i++) {
    if (
      buildingEvents[i].type === "applybuffstack" &&
      buildingEvents[i + 1].type === "removebuff" &&
      buildingEvents[i].timestamp === buildingEvents[i + 1].timestamp
    ) {
      tsWithVisibleStackAndRemove.add(buildingEvents[i].timestamp);
    }
  }

  // Collect Fracture cast timestamps
  const castTimes = events
    .filter((e) => e._src === "fracture" && e.type === "cast")
    .map((e) => e.timestamp)
    .sort((a, b) => a - b);

  function nearestCastDelay(timestamp) {
    if (castTimes.length === 0) return Infinity;
    let lo = 0,
      hi = castTimes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (castTimes[mid] < timestamp) lo = mid + 1;
      else hi = mid - 1;
    }
    let best = Infinity;
    if (lo < castTimes.length)
      best = Math.min(best, Math.abs(castTimes[lo] - timestamp));
    if (lo > 0) best = Math.min(best, Math.abs(castTimes[lo - 1] - timestamp));
    return best;
  }

  function hasNearbyCast(timestamp) {
    return nearestCastDelay(timestamp) <= ATTRIBUTION_WINDOW_MS;
  }

  function recordDelay(timestamp) {
    const d = nearestCastDelay(timestamp);
    if (d <= 0) results.delayHistogram[0]++;
    else if (d <= 10) results.delayHistogram[10]++;
    else if (d <= 20) results.delayHistogram[20]++;
    else if (d <= 50) results.delayHistogram[50]++;
    else if (d <= 100) results.delayHistogram[100]++;
    else if (d <= 200) results.delayHistogram[200]++;
    else results.delayHistogram.far++;
  }

  for (const e of events) {
    if (e._src === "fracture" && e.type === "cast") {
      if (spendingActive) {
        results.totalSkipped++;
      } else {
        const key = buildingStacks;
        if (!results.byStack[key])
          results.byStack[key] = { eligible: 0, procs: 0 };
        results.byStack[key].eligible++;
        results.totalEligible++;
      }
    } else if (e._src === "building") {
      switch (e.type) {
        case "applybuff": {
          recordDelay(e.timestamp);
          const isProc = hasNearbyCast(e.timestamp);
          if (isProc) {
            if (!results.byStack[0])
              results.byStack[0] = { eligible: 0, procs: 0 };
            results.byStack[0].procs++;
            results.totalProcs++;
            results.visibleProcs++;
          } else {
            results.guaranteedGains++;
          }
          buildingStacks = 1;
          break;
        }
        case "applybuffstack": {
          recordDelay(e.timestamp);
          const prev = (e.stack || buildingStacks + 1) - 1;
          const isProc = hasNearbyCast(e.timestamp);
          if (isProc) {
            if (!results.byStack[prev])
              results.byStack[prev] = { eligible: 0, procs: 0 };
            results.byStack[prev].procs++;
            results.totalProcs++;
            results.visibleProcs++;
          } else {
            results.guaranteedGains++;
          }
          buildingStacks = e.stack || buildingStacks + 1;
          break;
        }
        case "removebuff": {
          const ts = e.timestamp;
          const isConversion = spendingStartTimes.has(ts);
          if (
            isConversion &&
            buildingStacks > 0 &&
            hasNearbyCast(ts) &&
            !tsWithVisibleStackAndRemove.has(ts)
          ) {
            recordDelay(ts);
            if (!results.byStack[buildingStacks])
              results.byStack[buildingStacks] = { eligible: 0, procs: 0 };
            results.byStack[buildingStacks].procs++;
            results.totalProcs++;
            results.hiddenConversions++;
          }
          buildingStacks = 0;
          break;
        }
        case "removebuffstack":
          buildingStacks = e.stack || Math.max(0, buildingStacks - 1);
          break;
      }
    } else if (e._src === "spending") {
      switch (e.type) {
        case "applybuff":
        case "applybuffstack":
          spendingActive = true;
          break;
        case "removebuff":
          spendingActive = false;
          break;
      }
    }
  }

  return results;
}

function wilsonCI(successes, trials, z = 1.96) {
  if (trials === 0) return { lower: 0, upper: 0 };
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denom;
  const margin =
    (z / denom) *
    Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function binomialPValue(successes, trials, p0) {
  if (trials < 30) return null;
  const pHat = successes / trials;
  const se = Math.sqrt((p0 * (1 - p0)) / trials);
  const z = (pHat - p0) / se;
  return 2 * (1 - normalCDF(Math.abs(z)));
}

function normalCDF(x) {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function fmt(n) {
  return (n * 100).toFixed(1) + "%";
}

function printResults(agg) {
  console.log("\n" + "=".repeat(80));
  console.log("VOIDFALL PROC RATE ANALYSIS -- VENGEANCE (v2 improved)");
  console.log(
    "Trigger: Fracture (263642) | Tracked: 1256301 (voidfall_building)",
  );
  console.log(
    `Attribution: building gain within ${ATTRIBUTION_WINDOW_MS}ms of Fracture cast`,
  );
  console.log("Improvements: stable sort, dedup, delay histogram");
  console.log("=".repeat(80));
  console.log(`\nPlayers analyzed: ${agg.players}`);
  console.log(
    `Eligible Fracture casts: ${agg.totalEligible} | Skipped (during spending): ${agg.totalSkipped}`,
  );
  console.log(
    `Procs: ${agg.totalProcs} (${agg.visibleProcs} visible + ${agg.hiddenConversions} hidden conversions)`,
  );
  console.log(
    `Guaranteed building gains (Mass Acceleration): ${agg.guaranteedGains}`,
  );

  if (agg.totalEligible === 0) return;

  const rate = agg.totalProcs / agg.totalEligible;
  const ci = wilsonCI(agg.totalProcs, agg.totalEligible);
  const pVal = binomialPValue(agg.totalProcs, agg.totalEligible, EXPECTED_RATE);

  console.log(
    `\nOverall proc rate: ${fmt(rate)} (expected ${fmt(EXPECTED_RATE)})`,
  );
  console.log(`95% CI: [${fmt(ci.lower)}, ${fmt(ci.upper)}]`);
  if (pVal !== null) {
    console.log(
      `p-value vs ${fmt(EXPECTED_RATE)}: ${pVal < 0.0001 ? "<0.0001" : pVal.toFixed(4)} ${pVal < 0.05 ? "*** SIGNIFICANT ***" : "(not significant)"}`,
    );
  }

  // Attribution delay histogram
  console.log("\n--- Attribution Delay Histogram (gain-to-nearest-cast) ---\n");
  const dh = agg.delayHistogram;
  const totalGains = Object.values(dh).reduce((s, v) => s + v, 0) || 1;
  console.log(
    `  0ms (exact):   ${String(dh[0]).padStart(6)} (${fmt(dh[0] / totalGains)})`,
  );
  console.log(
    `  1-10ms:        ${String(dh[10]).padStart(6)} (${fmt(dh[10] / totalGains)})`,
  );
  console.log(
    `  11-20ms:       ${String(dh[20]).padStart(6)} (${fmt(dh[20] / totalGains)})`,
  );
  console.log(
    `  21-50ms:       ${String(dh[50]).padStart(6)} (${fmt(dh[50] / totalGains)})`,
  );
  console.log(
    `  51-100ms:      ${String(dh[100]).padStart(6)} (${fmt(dh[100] / totalGains)})`,
  );
  console.log(
    `  101-200ms:     ${String(dh[200]).padStart(6)} (${fmt(dh[200] / totalGains)})`,
  );
  console.log(
    `  >200ms:        ${String(dh.far).padStart(6)} (${fmt(dh.far / totalGains)}) <-- outside window, guaranteed`,
  );
  const inWindow = dh[0] + dh[10] + dh[20] + dh[50] + dh[100] + dh[200];
  const outWindow = dh.far;
  console.log(
    `  In-window: ${inWindow} | Out-of-window: ${outWindow} (${fmt(outWindow / totalGains)})`,
  );

  console.log(
    "\n--- By Building Stack Count (does current stacks affect proc chance?) ---\n",
  );
  console.log(
    "Stacks | Eligible | Procs | Rate   | 95% CI              | p vs 35%  | SimC default | Old v1",
  );
  console.log("-".repeat(100));

  const simcDefault = { 0: "40.0%", 1: "32.0%", 2: "27.5%" };
  const oldV1 = { 0: "43.3%", 1: "31.7%", 2: "10.4%" };
  const keys = Object.keys(agg.byStack)
    .map(Number)
    .sort((a, b) => a - b);
  for (const s of keys) {
    const d = agg.byStack[s];
    if (d.eligible < 5) continue;
    const r = d.procs / d.eligible;
    const c = wilsonCI(d.procs, d.eligible);
    const p = binomialPValue(d.procs, d.eligible, EXPECTED_RATE);
    const sig = p !== null && p < 0.05 ? " ***" : "";
    const sc = simcDefault[s] || "N/A";
    const ov = oldV1[s] || "N/A";
    console.log(
      `${String(s).padStart(6)} | ${String(d.eligible).padStart(8)} | ${String(d.procs).padStart(5)} | ${fmt(r).padStart(5)}  | [${fmt(c.lower)}, ${fmt(c.upper)}]`.padEnd(
        69,
      ) +
        ` | ${p !== null ? (p < 0.0001 ? "<0.0001" : p.toFixed(4)) : "N/A"}${sig}`.padEnd(
          16,
        ) +
        `| ${sc}`.padEnd(15) +
        `| ${ov}`,
    );
  }

  const rows = keys.map((s) => agg.byStack[s]).filter((d) => d.eligible >= 10);
  if (rows.length >= 2) {
    const totalE = rows.reduce((s, r) => s + r.eligible, 0);
    const totalP = rows.reduce((s, r) => s + r.procs, 0);
    const overallRate = totalP / totalE;
    let chiSq = 0;
    for (const row of rows) {
      const expP = row.eligible * overallRate;
      const expNP = row.eligible * (1 - overallRate);
      chiSq +=
        (row.procs - expP) ** 2 / expP +
        (row.eligible - row.procs - expNP) ** 2 / expNP;
    }
    const df = rows.length - 1;
    const cv = { 1: 3.841, 2: 5.991, 3: 7.815 }[df] || 5.991;
    console.log(
      `\nChi-squared: X2=${chiSq.toFixed(3)}, df=${df}, critical=${cv}`,
    );
    console.log(
      chiSq > cv
        ? "*** PROC RATE DIFFERS BY STACK COUNT ***"
        : "No significant difference by stack count",
    );
  }

  // Per-player outlier report
  if (agg.playerStats.length > 0) {
    console.log("\n--- Per-Player Outlier Analysis ---\n");
    const rates = agg.playerStats
      .filter((p) => p.eligible >= 10)
      .map((p) => ({ ...p, rate: p.procs / p.eligible }))
      .sort((a, b) => b.rate - a.rate);

    const median = rates[Math.floor(rates.length / 2)]?.rate || 0;
    const outlierHigh = rates.filter((p) => p.rate > 0.55);
    const outlierLow = rates.filter((p) => p.rate < 0.1 && p.eligible >= 20);

    console.log(
      `Players with 10+ casts: ${rates.length} | Median rate: ${fmt(median)}`,
    );

    if (outlierHigh.length) {
      console.log(
        `\nHigh outliers (>55% rate) - may have unfiltered guaranteed sources:`,
      );
      for (const p of outlierHigh.slice(0, 10)) {
        console.log(
          `  ${p.report}#${p.fight} src=${p.sourceID}: ${p.eligible} eligible, ${p.procs} procs (${fmt(p.rate)}), ${p.guaranteed} guaranteed`,
        );
      }
    }

    if (outlierLow.length) {
      console.log(`\nLow outliers (<10% rate, 20+ casts):`);
      for (const p of outlierLow.slice(0, 10)) {
        console.log(
          `  ${p.report}#${p.fight} src=${p.sourceID}: ${p.eligible} eligible, ${p.procs} procs (${fmt(p.rate)})`,
        );
      }
    }

    if (!outlierHigh.length && !outlierLow.length) {
      console.log("No extreme outliers detected.");
    }
  }
}

function generateHTML(agg) {
  const keys = Object.keys(agg.byStack)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((s) => (agg.byStack[s]?.eligible || 0) >= 5);

  const stackData = keys.map((s) => {
    const d = agg.byStack[s];
    const r = d.procs / d.eligible;
    const c = wilsonCI(d.procs, d.eligible);
    const p = binomialPValue(d.procs, d.eligible, EXPECTED_RATE);
    return { stacks: s, ...d, rate: r, ci: c, pVal: p };
  });

  const overallRate = agg.totalProcs / agg.totalEligible;
  const overallCI = wilsonCI(agg.totalProcs, agg.totalEligible);

  const simcDefault = { 0: 0.4, 1: 0.32, 2: 0.275 };
  const oldV1 = { 0: 0.433, 1: 0.317, 2: 0.104 };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Voidfall Proc Rate Analysis -- Vengeance v2</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; background: #1a1a2e; color: #e0e0e0; }
  h1 { color: #ef4444; }
  h2 { color: #f87171; margin-top: 2rem; }
  .meta { color: #888; font-size: 0.9rem; margin-bottom: 2rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { padding: 0.5rem 1rem; text-align: right; border: 1px solid #333; }
  th { background: #2d2d44; color: #f87171; }
  td:first-child, th:first-child { text-align: left; }
  .sig { color: #f59e0b; font-weight: bold; }
  .bar-container { display: flex; align-items: end; gap: 2rem; justify-content: center; margin: 2rem 0; height: 320px; }
  .bar-group { display: flex; flex-direction: column; align-items: center; }
  .bar { width: 60px; border-radius: 4px 4px 0 0; position: relative; min-height: 2px; }
  .bar.new { background: #ef4444; }
  .bar.old { background: #6b7280; opacity: 0.4; }
  .bar.simc { background: #3b82f6; opacity: 0.5; }
  .bar-label { margin-top: 0.5rem; font-size: 0.85rem; color: #aaa; }
  .bar-value { font-size: 0.8rem; color: #fff; margin-bottom: 0.2rem; font-weight: bold; }
  .ref-line { position: absolute; left: -20px; right: -20px; border-top: 2px dashed #f59e0b; }
  .ref-label { position: absolute; right: -60px; top: -10px; font-size: 0.75rem; color: #f59e0b; }
  .legend { display: flex; gap: 1.5rem; justify-content: center; margin: 1rem 0; font-size: 0.85rem; }
  .legend-item { display: flex; align-items: center; gap: 0.4rem; }
  .legend-swatch { width: 16px; height: 16px; border-radius: 2px; }
  .summary-box { background: #2d2d44; padding: 1rem 1.5rem; border-radius: 8px; margin: 1rem 0; }
  .ci { color: #888; font-size: 0.85rem; }
  .improvement { background: #1a3a1a; border: 1px solid #2d6b2d; padding: 1rem; border-radius: 8px; margin: 1rem 0; }
</style>
</head>
<body>
<h1>Voidfall Proc Rate: Vengeance DH (v2)</h1>
<div class="meta">
  Generated ${new Date().toISOString().slice(0, 10)} |
  n=${agg.totalEligible.toLocaleString()} eligible Fracture casts |
  ${agg.players} players |
  Midnight beta + S1
</div>

<div class="improvement">
  <strong>v2 improvements over v1:</strong> Stable sort (casts before building events at same timestamp),
  event deduplication across pagination pages, attribution delay histogram validation.
  v1 had a sort-order bug that inflated stack-2 eligible counts, producing the anomalous 10.4% rate.
</div>

<div class="summary-box">
  <strong>Overall:</strong> ${fmt(overallRate)}
  <span class="ci">[${fmt(overallCI.lower)}, ${fmt(overallCI.upper)}]</span>
  vs expected 35.0% flat |
  <strong>Current SimC defaults:</strong> 40% / 32% / 27.5%
</div>

<div class="legend">
  <div class="legend-item"><div class="legend-swatch" style="background:#ef4444"></div> v2 observed (this run)</div>
  <div class="legend-item"><div class="legend-swatch" style="background:#6b7280;opacity:0.4"></div> v1 (old, buggy)</div>
  <div class="legend-item"><div class="legend-swatch" style="background:#3b82f6;opacity:0.5"></div> SimC default</div>
  <div class="legend-item"><div class="legend-swatch" style="background:none;border:2px dashed #f59e0b;width:12px;height:0"></div> 35% flat</div>
</div>

<div class="bar-container">
${stackData
  .map((d) => {
    const maxRate = 0.55;
    const h = Math.round((d.rate / maxRate) * 280);
    const simcRate = simcDefault[d.stacks] ?? 0;
    const hSimc = Math.round((simcRate / maxRate) * 280);
    const v1Rate = oldV1[d.stacks] ?? 0;
    const hV1 = Math.round((v1Rate / maxRate) * 280);
    const refH = Math.round((0.35 / maxRate) * 280);
    return `  <div class="bar-group">
    <div class="bar-value">${fmt(d.rate)}</div>
    <div style="display:flex;gap:3px;align-items:end;height:280px;">
      <div class="bar new" style="height:${h}px;position:relative;">
        ${d.stacks === 0 ? `<div class="ref-line" style="bottom:${refH}px;"><span class="ref-label">35%</span></div>` : ""}
      </div>
      <div class="bar old" style="height:${hV1}px;" title="v1: ${fmt(v1Rate)}"></div>
      <div class="bar simc" style="height:${hSimc}px;" title="SimC: ${fmt(simcRate)}"></div>
    </div>
    <div class="bar-label">${d.stacks} stacks</div>
  </div>`;
  })
  .join("\n")}
</div>

<h2>Per-Stack Data</h2>
<table>
<tr><th>Stacks</th><th>Eligible</th><th>Procs</th><th>v2 Rate</th><th>95% CI</th><th>p vs 35%</th><th>SimC Default</th><th>v1 (old)</th></tr>
${stackData
  .map(
    (d) =>
      `<tr><td>${d.stacks}</td><td>${d.eligible.toLocaleString()}</td><td>${d.procs.toLocaleString()}</td><td><strong>${fmt(d.rate)}</strong></td><td>${fmt(d.ci.lower)} - ${fmt(d.ci.upper)}</td><td class="${d.pVal !== null && d.pVal < 0.05 ? "sig" : ""}">${d.pVal !== null ? (d.pVal < 0.0001 ? "<.0001" : d.pVal.toFixed(4)) : "N/A"}</td><td>${fmt(simcDefault[d.stacks] ?? 0.35)}</td><td>${fmt(oldV1[d.stacks] ?? 0)}</td></tr>`,
  )
  .join("\n")}
<tr><td><strong>Overall</strong></td><td><strong>${agg.totalEligible.toLocaleString()}</strong></td><td><strong>${agg.totalProcs.toLocaleString()}</strong></td><td><strong>${fmt(overallRate)}</strong></td><td>${fmt(overallCI.lower)} - ${fmt(overallCI.upper)}</td><td></td><td></td><td></td></tr>
</table>

<h2>Data Quality</h2>
<table>
<tr><th>Metric</th><th>Value</th></tr>
<tr><td>Visible procs</td><td>${agg.visibleProcs.toLocaleString()}</td></tr>
<tr><td>Hidden conversions</td><td>${agg.hiddenConversions.toLocaleString()}</td></tr>
<tr><td>Guaranteed gains (excluded)</td><td>${agg.guaranteedGains.toLocaleString()}</td></tr>
<tr><td>During-spending casts (excluded)</td><td>${agg.totalSkipped.toLocaleString()}</td></tr>
</table>

<h2>Attribution Delay Histogram</h2>
<p>Distance from each building gain to its nearest Fracture cast. Gains beyond ${ATTRIBUTION_WINDOW_MS}ms are classified as guaranteed (non-proc) sources.</p>
<table>
<tr><th>Delay</th><th>Count</th><th>%</th></tr>
${Object.entries(agg.delayHistogram)
  .map(([k, v]) => {
    const total =
      Object.values(agg.delayHistogram).reduce((s, x) => s + x, 0) || 1;
    const label =
      k === "far"
        ? ">200ms"
        : k === "0"
          ? "0ms"
          : k === "10"
            ? "1-10ms"
            : k === "20"
              ? "11-20ms"
              : k === "50"
                ? "21-50ms"
                : k === "100"
                  ? "51-100ms"
                  : "101-200ms";
    return `<tr><td>${label}</td><td>${v.toLocaleString()}</td><td>${fmt(v / total)}</td></tr>`;
  })
  .join("\n")}
</table>

</body>
</html>`;
}

async function main() {
  await authenticate();

  const agg = {
    totalEligible: 0,
    totalProcs: 0,
    totalSkipped: 0,
    guaranteedGains: 0,
    hiddenConversions: 0,
    visibleProcs: 0,
    players: 0,
    byStack: {},
    delayHistogram: { 0: 0, 10: 0, 20: 0, 50: 0, 100: 0, 200: 0, far: 0 },
    playerStats: [],
  };

  const seenFights = new Set();
  const TARGET = parseInt(process.argv[2]) || 50000;

  for (const encounter of MIDNIGHT_ZONES) {
    console.log(`\n--- ${encounter.name} (${encounter.id}) ---`);

    let page = 1;
    let hasMorePages = true;

    while (hasMorePages && agg.totalEligible < TARGET) {
      let rankResult;
      try {
        rankResult = await getRankingsForEncounter(encounter.id, page);
      } catch {
        console.log("  Error fetching rankings");
        break;
      }

      const reports = rankResult.reports;
      hasMorePages = rankResult.hasMore;

      if (!reports.length) {
        if (page === 1) console.log("  No Vengeance DH rankings");
        break;
      }
      if (page === 1) console.log(`  Found rankings (page ${page})`);

      for (const report of reports) {
        const key = `${report.code}:${report.fightID}`;
        if (seenFights.has(key)) continue;
        seenFights.add(key);

        console.log(
          `  ${report.name}-${report.server || "?"} (${report.code}#${report.fightID})`,
        );

        try {
          const result = await getFightEvents(report.code, report.fightID);
          if (!result?.events.length) continue;

          const playerEvents = new Map();
          for (const e of result.events) {
            if (!playerEvents.has(e.sourceID)) playerEvents.set(e.sourceID, []);
            playerEvents.get(e.sourceID).push(e);
          }

          for (const [sourceID, pEvents] of playerEvents) {
            const hasBuilding = pEvents.some((e) => e._src === "building");
            const hasFracture = pEvents.some(
              (e) => e._src === "fracture" && e.type === "cast",
            );
            if (!hasBuilding || !hasFracture) continue;

            const analysis = analyzeEvents(pEvents);
            if (analysis.totalEligible === 0) continue;

            agg.players++;
            agg.totalEligible += analysis.totalEligible;
            agg.totalProcs += analysis.totalProcs;
            agg.totalSkipped += analysis.totalSkipped;
            agg.guaranteedGains += analysis.guaranteedGains;
            agg.hiddenConversions += analysis.hiddenConversions;
            agg.visibleProcs += analysis.visibleProcs;

            for (const [s, d] of Object.entries(analysis.byStack)) {
              if (!agg.byStack[s]) agg.byStack[s] = { eligible: 0, procs: 0 };
              agg.byStack[s].eligible += d.eligible;
              agg.byStack[s].procs += d.procs;
            }

            for (const [bucket, count] of Object.entries(
              analysis.delayHistogram,
            )) {
              agg.delayHistogram[bucket] =
                (agg.delayHistogram[bucket] || 0) + count;
            }

            agg.playerStats.push({
              report: report.code,
              fight: report.fightID,
              sourceID,
              eligible: analysis.totalEligible,
              procs: analysis.totalProcs,
              guaranteed: analysis.guaranteedGains,
            });

            const r =
              analysis.totalEligible > 0
                ? fmt(analysis.totalProcs / analysis.totalEligible)
                : "N/A";
            console.log(
              `    [${sourceID}] ${analysis.totalEligible} elig, ${analysis.totalProcs} procs (${analysis.visibleProcs}v+${analysis.hiddenConversions}h), ${analysis.guaranteedGains} guar, ${analysis.totalSkipped} skip (${r})`,
            );
          }
        } catch (err) {
          console.log(`    Error: ${err.message}`);
        }

        await new Promise((r) => setTimeout(r, 500));

        if (agg.totalEligible >= TARGET) break;
      }

      page++;
      if (agg.totalEligible >= TARGET) break;
    }

    if (agg.totalEligible >= TARGET) {
      console.log(
        `\nReached ${agg.totalEligible} eligible casts (target: ${TARGET}).`,
      );
      break;
    }
  }

  printResults(agg);

  // Generate HTML report
  const htmlPath = resolve(__dirname, "voidfall-results-v2.html");
  writeFileSync(htmlPath, generateHTML(agg));
  console.log(`\nHTML report: ${htmlPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
