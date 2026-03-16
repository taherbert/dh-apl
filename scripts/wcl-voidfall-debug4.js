#!/usr/bin/env node

// Check spell 1256301 - the actual Fracture -> Voidfall proc buff

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

  const code = "RBZFhgNGtT6CknPx";
  const fightID = 6;
  const sourceID = 329;

  // Get 1256301 buff events AND fracture casts for this player
  const data = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        voidfallProc: events(
          fightIDs: [${fightID}]
          startTime: 0
          endTime: 999999999
          dataType: Buffs
          sourceID: ${sourceID}
          abilityID: 1256301
        ) { data nextPageTimestamp }
        fractures: events(
          fightIDs: [${fightID}]
          startTime: 0
          endTime: 999999999
          dataType: Casts
          sourceID: ${sourceID}
          abilityID: 263642
        ) { data nextPageTimestamp }
      }}
    }
  `,
    { code },
  );

  const procs = data.reportData.report.voidfallProc.data;
  const casts = data.reportData.report.fractures.data;

  console.log(`Fracture casts (263642): ${casts.length}`);
  console.log(`Voidfall proc events (1256301): ${procs.length}`);

  // Count by type
  const typeCounts = {};
  for (const p of procs) {
    typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
  }
  console.log(`Event types:`, typeCounts);

  const gains = procs.filter(
    (p) => p.type === "applybuff" || p.type === "applybuffstack",
  );
  console.log(`Gain events: ${gains.length}`);
  console.log(
    `Gains/casts ratio: ${((gains.length / casts.length) * 100).toFixed(1)}%`,
  );

  // Show timeline of fracture + 1256301 events
  const allEvents = [
    ...casts.map((e) => ({ ...e, _t: "FRAC" })),
    ...procs.map((e) => ({ ...e, _t: "PROC" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\nFirst 80 events:\n`);
  let stacks = 0;
  for (const e of allEvents.slice(0, 80)) {
    if (e._t === "FRAC") {
      console.log(`${e.timestamp} FRACTURE cast [stacks=${stacks}]`);
    } else {
      const stackInfo = e.stack !== undefined ? ` stack=${e.stack}` : "";
      const prevStacks = stacks;
      if (e.type === "applybuff") stacks = 1;
      else if (e.type === "applybuffstack") stacks = e.stack || stacks + 1;
      else if (e.type === "removebuff") stacks = 0;
      else if (e.type === "removebuffstack") stacks = e.stack || stacks - 1;
      const isGain = e.type === "applybuff" || e.type === "applybuffstack";
      console.log(
        `${e.timestamp} VOIDFALL_1256301 ${e.type}${stackInfo} [${prevStacks}->${stacks}]${isGain ? " <-- GAIN" : ""}`,
      );
    }
  }
}

main().catch(console.error);
