#!/usr/bin/env node

// Probe WCL to find Devourer spec name and available data

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

  // Check what specs exist for DemonHunter class
  const data = await graphql(`
    query {
      gameData {
        classes {
          id
          name
          specs {
            id
            name
          }
        }
      }
    }
  `);

  const dh = data.gameData.classes.find(
    (c) => c.name === "Demon Hunter" || c.name === "DemonHunter",
  );
  if (dh) {
    console.log("Demon Hunter specs:", JSON.stringify(dh, null, 2));
  } else {
    console.log("All classes:");
    for (const c of data.gameData.classes) {
      console.log(
        `  ${c.name} (${c.id}): ${c.specs.map((s) => s.name).join(", ")}`,
      );
    }
  }

  // Try different spec names for Devourer rankings on a beta M+ encounter
  const encounterID = 162526; // Algeth'ar Academy Beta
  for (const specName of ["Devourer", "Havoc", "DPS"]) {
    try {
      const r = await graphql(
        `
        query ($id: Int!) {
          worldData {
            encounter(id: $id) {
              characterRankings(
                specName: "${specName}"
                className: "DemonHunter"
                metric: dps
                leaderboard: Any
                page: 1
              )
            }
          }
        }
      `,
        { id: encounterID },
      );
      const rankings = r.worldData.encounter?.characterRankings?.rankings || [];
      console.log(`\n${specName}: ${rankings.length} rankings`);
      if (rankings.length > 0) {
        console.log("  First:", JSON.stringify(rankings[0], null, 2));
      }
    } catch (err) {
      console.log(`\n${specName}: Error - ${err.message}`);
    }
  }
}

main().catch(console.error);
