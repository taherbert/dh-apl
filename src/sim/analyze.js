// Extracts optimization-relevant signals from simulation results.
// Identifies cooldown waste, resource overcap, buff uptime issues.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "..", "results");

function analyze(summaryPath) {
  const results = JSON.parse(readFileSync(summaryPath, "utf-8"));

  for (const result of results) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Analysis: ${result.scenarioName}`);
    console.log(`${"=".repeat(60)}`);

    analyzeDPSContribution(result);
    analyzeBuffUptime(result);
    analyzeGCDUsage(result);
  }
}

function analyzeDPSContribution(result) {
  console.log("\n--- DPS Contribution ---");

  const damage = result.abilities.filter((a) => a.type === "damage");
  const totalDPS = damage.reduce((sum, a) => sum + a.dps, 0);

  // Flag abilities with low contribution (potential waste)
  const lowContrib = damage.filter((a) => a.fraction > 0 && a.fraction < 0.01);
  if (lowContrib.length) {
    console.log("\nLow-contribution abilities (<1% DPS):");
    for (const a of lowContrib) {
      console.log(
        `  ${a.name}: ${(a.fraction * 100).toFixed(2)}% (${a.executes.toFixed(1)} casts)`,
      );
    }
  }

  // Flag abilities that are large DPS contributors
  const highContrib = damage.filter((a) => a.fraction > 0.1);
  console.log("\nMajor contributors (>10% DPS):");
  for (const a of highContrib) {
    console.log(
      `  ${a.name}: ${(a.fraction * 100).toFixed(1)}% (${Math.round(a.dps).toLocaleString()} DPS)`,
    );
  }
}

function analyzeBuffUptime(result) {
  console.log("\n--- Buff Uptime Analysis ---");

  // Key VDH buffs to track
  const keyBuffs = [
    "demon_spikes",
    "fiery_brand",
    "metamorphosis",
    "immolation_aura",
    "frailty",
    "soul_furnace",
    "rending_strike",
    "glaive_flurry",
    "demonsurge_soul_sunder",
    "demonsurge_spirit_burst",
    "student_of_suffering",
  ];

  const found = result.buffs.filter((b) =>
    keyBuffs.some((kb) => b.name.toLowerCase().includes(kb)),
  );

  if (found.length) {
    console.log("\nKey buff uptimes:");
    for (const b of found) {
      const upPct = b.uptime.toFixed(1);
      const status = b.uptime < 30 ? " ⚠ LOW" : b.uptime > 90 ? " ✓ HIGH" : "";
      console.log(`  ${b.name.padEnd(35)} ${upPct}%${status}`);
    }
  }

  // Defensive uptime check
  const demonSpikes = result.buffs.find((b) =>
    b.name.toLowerCase().includes("demon_spikes"),
  );
  if (demonSpikes) {
    const uptime = demonSpikes.uptime;
    if (uptime < 50) {
      console.log(
        `\n⚠ Demon Spikes uptime is ${uptime.toFixed(1)}% — consider prioritizing it higher`,
      );
    }
  }
}

function analyzeGCDUsage(result) {
  console.log("\n--- GCD Analysis ---");

  // Estimate total GCDs available from fight length
  // Assume 1.5s GCD base
  const fightLength = SCENARIOS[result.scenario]?.maxTime || 300;
  const estimatedGCDs = fightLength / 1.5;

  const totalCasts = result.abilities
    .filter((a) => a.type === "damage")
    .reduce((sum, a) => sum + a.executes, 0);

  const efficiency = totalCasts / estimatedGCDs;
  console.log(`  Estimated GCDs available: ${estimatedGCDs.toFixed(0)}`);
  console.log(`  Total damage casts: ${totalCasts.toFixed(0)}`);
  console.log(`  GCD efficiency: ${(efficiency * 100).toFixed(1)}%`);

  if (efficiency < 0.85) {
    console.log(
      "  ⚠ Low GCD efficiency — may have dead GCDs from resource starvation or cooldown gaps",
    );
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.log("Usage: node src/sim/analyze.js <summary.json>");
    console.log("  Or: node src/sim/analyze.js (uses most recent baseline)");

    // Try to find most recent summary
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(RESULTS_DIR).filter((f) =>
      f.endsWith("_summary.json"),
    );
    if (files.length) {
      console.log(`\nFound: ${files.join(", ")}`);
      analyze(join(RESULTS_DIR, files[files.length - 1]));
    }
    process.exit(0);
  }
  analyze(path);
}
