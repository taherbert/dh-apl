#!/usr/bin/env node

// Check outlier players: do they have building gains WITHOUT nearby Fracture casts?
// If yes, they have a non-Fracture building trigger.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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

let accessToken = null;
async function authenticate() {
  const resp = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.WCL_CLIENT_ID,
      client_secret: process.env.WCL_CLIENT_SECRET,
    }),
  });
  accessToken = (await resp.json()).access_token;
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
  const result = await resp.json();
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
}

async function main() {
  await authenticate();

  // Pick a known outlier: Character 121211722 from dfvFr1Gx64bJV9kP fight 1
  // and a known normal: Character 122264315 from yd3fN8mjbAJTgF2a fight 4
  const cases = [
    {
      code: "dfvFr1Gx64bJV9kP",
      fightID: 1,
      sourceID: 4,
      label: "OUTLIER (56.5%)",
    },
    {
      code: "yd3fN8mjbAJTgF2a",
      fightID: 4,
      sourceID: 4,
      label: "NORMAL (31.3%)",
    },
  ];

  for (const c of cases) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${c.label}: ${c.code}#${c.fightID}, sourceID=${c.sourceID}`);

    const fightData = await graphql(
      `
        query ($code: String!) {
          reportData {
            report(code: $code) {
              fights {
                id
                startTime
                endTime
              }
            }
          }
        }
      `,
      { code: c.code },
    );

    const fight = fightData.reportData.report.fights.find(
      (f) => f.id === c.fightID,
    );
    if (!fight) {
      console.log("Fight not found");
      continue;
    }

    // Get ALL events for this player - not just Fracture, ALL casts + buffs
    const data = await graphql(
      `
      query($code: String!) {
        reportData { report(code: $code) {
          allCasts: events(
            fightIDs: [${c.fightID}] startTime: ${fight.startTime} endTime: ${fight.endTime}
            dataType: Casts sourceID: ${c.sourceID}
          ) { data }
          building: events(
            fightIDs: [${c.fightID}] startTime: ${fight.startTime} endTime: ${fight.endTime}
            dataType: Buffs sourceID: ${c.sourceID} abilityID: 1256301
          ) { data }
          spending: events(
            fightIDs: [${c.fightID}] startTime: ${fight.startTime} endTime: ${fight.endTime}
            dataType: Buffs sourceID: ${c.sourceID} abilityID: 1256302
          ) { data }
        }}
      }
    `,
      { code: c.code },
    );

    const r = data.reportData.report;
    const casts = r.allCasts.data || [];
    const building = r.building.data || [];
    const spending = r.spending.data || [];

    // Count Fracture casts
    const fractureCasts = casts.filter(
      (e) => e.abilityGameID === 263642 && e.type === "cast",
    );
    console.log(`Fracture casts: ${fractureCasts.length}`);

    // Count building events by type
    const buildTypes = {};
    for (const e of building) {
      buildTypes[e.type] = (buildTypes[e.type] || 0) + 1;
    }
    console.log(`Building events: ${JSON.stringify(buildTypes)}`);
    console.log(`Spending events: ${spending.length}`);

    // Key check: for each building applybuff/applybuffstack, is there a Fracture within ±200ms?
    const fractureTimes = fractureCasts
      .map((e) => e.timestamp)
      .sort((a, b) => a - b);

    function nearestFractureDist(ts) {
      let lo = 0,
        hi = fractureTimes.length - 1;
      let best = Infinity;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const diff = fractureTimes[mid] - ts;
        if (Math.abs(diff) < best) best = Math.abs(diff);
        if (diff < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      if (lo < fractureTimes.length)
        best = Math.min(best, Math.abs(fractureTimes[lo] - ts));
      if (lo > 0) best = Math.min(best, Math.abs(fractureTimes[lo - 1] - ts));
      return best;
    }

    const gains = building.filter(
      (e) => e.type === "applybuff" || e.type === "applybuffstack",
    );
    let withFracture = 0;
    let withoutFracture = 0;
    const distHistogram = {};

    for (const g of gains) {
      const dist = nearestFractureDist(g.timestamp);
      const bucket =
        dist <= 50
          ? "0-50ms"
          : dist <= 100
            ? "51-100ms"
            : dist <= 200
              ? "101-200ms"
              : dist <= 500
                ? "201-500ms"
                : dist <= 1000
                  ? "501-1000ms"
                  : ">1000ms";
      distHistogram[bucket] = (distHistogram[bucket] || 0) + 1;

      if (dist <= 200) withFracture++;
      else withoutFracture++;
    }

    console.log(`\nBuilding gains: ${gains.length} total`);
    console.log(`  With Fracture within 200ms: ${withFracture}`);
    console.log(`  WITHOUT Fracture within 200ms: ${withoutFracture}`);
    console.log(`\n  Distance to nearest Fracture:`);
    for (const [bucket, count] of Object.entries(distHistogram).sort()) {
      console.log(`    ${bucket}: ${count}`);
    }

    // Check hidden conversions: building removebuff + spending start
    const conversions = building.filter((e) => {
      if (e.type !== "removebuff") return false;
      return spending.some(
        (s) => s.type === "applybuff" && s.timestamp === e.timestamp,
      );
    });
    console.log(
      `\nHidden conversions (removebuff + spending): ${conversions.length}`,
    );
    if (conversions.length > 0) {
      const convDists = conversions.map((e) =>
        nearestFractureDist(e.timestamp),
      );
      const convBuckets = {};
      for (const d of convDists) {
        const bucket =
          d <= 50
            ? "0-50ms"
            : d <= 100
              ? "51-100ms"
              : d <= 200
                ? "101-200ms"
                : d <= 500
                  ? "201-500ms"
                  : d <= 1000
                    ? "501-1000ms"
                    : ">1000ms";
        convBuckets[bucket] = (convBuckets[bucket] || 0) + 1;
      }
      console.log("  Distance from conversion to nearest Fracture:");
      for (const [b, c] of Object.entries(convBuckets).sort()) {
        console.log(`    ${b}: ${c}`);
      }
    }

    // If there are gains without fracture, show what abilities are being cast near them
    if (withoutFracture > 0) {
      console.log(`\n  Sample non-Fracture gains (first 10):`);
      let shown = 0;
      for (const g of gains) {
        const dist = nearestFractureDist(g.timestamp);
        if (dist > 200 && shown < 10) {
          const nearby = casts.filter(
            (e) =>
              Math.abs(e.timestamp - g.timestamp) <= 100 && e.type === "cast",
          );
          const abilities = nearby.map((e) => e.abilityGameID);
          console.log(
            `    ts=${g.timestamp - fight.startTime}ms, type=${g.type}, nearest_fracture=${dist}ms, nearby_casts=[${abilities.join(",")}]`,
          );
          shown++;
        }
      }
    }
  }
}

main().catch(console.error);
