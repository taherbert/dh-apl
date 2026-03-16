#!/usr/bin/env node

// Debug: dump raw event counts for one fight to understand Voidfall event flow

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

  // Use the report from the probe that we know has data
  const code = "RBZFhgNGtT6CknPx";
  const fightID = 6;

  // Get ALL buff events for Voidfall (not just Buffs dataType)
  const data = await graphql(
    `
    query($code: String!) {
      reportData {
        report(code: $code) {
          buffs: events(
            fightIDs: [${fightID}]
            startTime: 0
            endTime: 999999999
            dataType: Buffs
            abilityID: 1256322
          ) { data nextPageTimestamp }
          casts: events(
            fightIDs: [${fightID}]
            startTime: 0
            endTime: 999999999
            dataType: Casts
            abilityID: 263642
          ) { data nextPageTimestamp }
        }
      }
    }
  `,
    { code },
  );

  const buffs = data.reportData.report.buffs.data;
  const casts = data.reportData.report.casts.data;

  // Group by sourceID
  const players = new Map();
  for (const e of [...buffs, ...casts]) {
    const sid = e.sourceID;
    if (!players.has(sid)) players.set(sid, { buffs: [], casts: [] });
    if (e.abilityGameID === 1256322) players.get(sid).buffs.push(e);
    else players.get(sid).casts.push(e);
  }

  for (const [sourceID, p] of players) {
    if (p.casts.length === 0 && p.buffs.length === 0) continue;

    console.log(`\n=== Player sourceID=${sourceID} ===`);
    console.log(`Fracture casts: ${p.casts.length}`);

    // Count buff event types
    const typeCounts = {};
    for (const b of p.buffs) {
      typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
    }
    console.log(`Voidfall buff events:`, typeCounts);

    const gains = p.buffs.filter(
      (b) => b.type === "applybuff" || b.type === "applybuffstack",
    ).length;
    console.log(`Total gain events (applybuff + applybuffstack): ${gains}`);
    console.log(
      `Ratio gains/casts: ${((gains / p.casts.length) * 100).toFixed(1)}%`,
    );

    // Show first 30 events in chronological order to see the pattern
    const allEvents = [
      ...p.casts.map((e) => ({ ...e, _t: "FRAC" })),
      ...p.buffs.map((e) => ({ ...e, _t: "BUFF" })),
    ].sort((a, b) => a.timestamp - b.timestamp);

    console.log(`\nFirst 50 events:`);
    let stacks = 0;
    for (const e of allEvents.slice(0, 50)) {
      if (e._t === "BUFF") {
        const stackInfo = e.stack !== undefined ? ` stack=${e.stack}` : "";
        if (e.type === "applybuff") stacks = 1;
        else if (e.type === "applybuffstack") stacks = e.stack || stacks + 1;
        else if (e.type === "removebuff") stacks = 0;
        else if (e.type === "removebuffstack") stacks = e.stack || stacks - 1;
        console.log(
          `  ${e.timestamp} VOIDFALL ${e.type}${stackInfo} -> stacks=${stacks}`,
        );
      } else {
        console.log(`  ${e.timestamp} FRACTURE cast (stacks=${stacks})`);
      }
    }
  }
}

main().catch(console.error);
