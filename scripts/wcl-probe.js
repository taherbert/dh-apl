#!/usr/bin/env node

// Probe a WCL report to understand zone/encounter structure for Midnight beta

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
  const data = await resp.json();
  accessToken = data.access_token;
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
  if (result.errors) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.data;
}

async function main() {
  await authenticate();

  // 1. Inspect the provided report
  const code = "RBZFhgNGtT6CknPx";
  console.log("=== Report Info ===");
  const reportInfo = await graphql(
    `
      query ($code: String!) {
        reportData {
          report(code: $code) {
            title
            zone {
              id
              name
            }
            fights {
              id
              name
              startTime
              endTime
              kill
              encounterID
            }
          }
        }
      }
    `,
    { code },
  );

  const report = reportInfo.reportData.report;
  console.log(`Title: ${report.title}`);
  console.log(`Zone: ${report.zone?.name} (${report.zone?.id})`);
  console.log("\nFights:");
  for (const f of report.fights) {
    console.log(
      `  #${f.id}: ${f.name} (encounter=${f.encounterID}, kill=${f.kill}, ${((f.endTime - f.startTime) / 1000).toFixed(0)}s)`,
    );
  }

  // 2. Check fight 6 events for Voidfall
  const fight = report.fights.find((f) => f.id === 6);
  if (fight) {
    console.log(
      `\n=== Fight 6: ${fight.name} - Checking for Voidfall events ===`,
    );

    const events = await graphql(
      `
        query ($code: String!) {
          reportData {
            report(code: $code) {
              voidfall: events(
                fightIDs: [6]
                startTime: 0
                endTime: 999999999
                dataType: Buffs
                abilityID: 1256322
              ) {
                data
                nextPageTimestamp
              }
              fractures: events(
                fightIDs: [6]
                startTime: 0
                endTime: 999999999
                dataType: Casts
                abilityID: 263642
              ) {
                data
                nextPageTimestamp
              }
            }
          }
        }
      `,
      { code },
    );

    console.log(
      `Voidfall buff events: ${events.reportData.report.voidfall.data.length}`,
    );
    console.log(
      `Fracture cast events: ${events.reportData.report.fractures.data.length}`,
    );

    if (events.reportData.report.voidfall.data.length > 0) {
      console.log("\nSample Voidfall events:");
      for (const e of events.reportData.report.voidfall.data.slice(0, 10)) {
        console.log(`  ${JSON.stringify(e)}`);
      }
    }
    if (events.reportData.report.fractures.data.length > 0) {
      console.log("\nSample Fracture events:");
      for (const e of events.reportData.report.fractures.data.slice(0, 5)) {
        console.log(`  ${JSON.stringify(e)}`);
      }
    }
  }

  // 3. Find Midnight expansion zones
  console.log("\n=== Looking for Midnight expansion zones ===");
  // Try expansion IDs 7, 8, etc.
  for (const expId of [6, 7, 8, 9, 10]) {
    try {
      const exp = await graphql(
        `
          query ($id: Int!) {
            worldData {
              expansion(id: $id) {
                id
                name
                zones {
                  id
                  name
                  encounters {
                    id
                    name
                  }
                }
              }
            }
          }
        `,
        { id: expId },
      );
      if (exp.worldData.expansion) {
        const e = exp.worldData.expansion;
        console.log(`\nExpansion ${e.id}: ${e.name}`);
        for (const z of e.zones) {
          console.log(`  Zone: ${z.name} (${z.id})`);
          for (const enc of z.encounters) {
            console.log(`    ${enc.name} (${enc.id})`);
          }
        }
      }
    } catch {
      // no expansion at this ID
    }
  }

  // 4. Try to find rankings for the encounter in fight 6
  if (fight?.encounterID) {
    console.log(
      `\n=== Rankings for encounter ${fight.encounterID} (${fight.name}) ===`,
    );
    try {
      const rankings = await graphql(
        `
          query ($encId: Int!) {
            worldData {
              encounter(id: $encId) {
                name
                zone {
                  name
                  id
                }
                characterRankings(
                  specName: "Vengeance"
                  className: "DemonHunter"
                  metric: dps
                  page: 1
                )
              }
            }
          }
        `,
        { encId: fight.encounterID },
      );
      const enc = rankings.worldData.encounter;
      console.log(`Encounter: ${enc.name}`);
      console.log(`Zone: ${enc.zone?.name} (${enc.zone?.id})`);
      const r = enc.characterRankings;
      console.log(`Rankings count: ${r?.rankings?.length || 0}`);
      if (r?.rankings?.length > 0) {
        console.log("First 3:");
        for (const rank of r.rankings.slice(0, 3)) {
          console.log(
            `  ${rank.name}-${rank.server?.name}: ${rank.report?.code}#${rank.report?.fightID}`,
          );
        }
      }
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }
  }
}

main().catch(console.error);
