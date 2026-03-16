#!/usr/bin/env node

// Spot-check: show stack-2 events for one Devourer player

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

  const code = "LdYWXHCkV98TmjRN";
  const fightID = 5;
  const sourceID = 4;

  // Get all events for this player
  const data = await graphql(
    `
    query($code: String!) {
      reportData { report(code: $code) {
        consumes: events(fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Casts sourceID: ${sourceID} abilityID: 473662) { data }
        devours: events(fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Casts sourceID: ${sourceID} abilityID: 1217610) { data }
        building: events(fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Buffs sourceID: ${sourceID} abilityID: 1256301) { data }
        spending: events(fightIDs: [${fightID}] startTime: 0 endTime: 999999999
          dataType: Buffs sourceID: ${sourceID} abilityID: 1256302) { data }
      }}
    }
  `,
    { code },
  );

  const r = data.reportData.report;
  const events = [
    ...(r.consumes.data || []).map((e) => ({ ...e, _src: "CONSUME" })),
    ...(r.devours.data || []).map((e) => ({ ...e, _src: "DEVOUR" })),
    ...(r.building.data || []).map((e) => ({ ...e, _src: "BUILDING" })),
    ...(r.spending.data || []).map((e) => ({ ...e, _src: "SPENDING" })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  console.log(
    `Events: ${r.consumes.data.length} consumes, ${r.devours.data.length} devours, ${r.building.data.length} building, ${r.spending.data.length} spending\n`,
  );

  // Walk events, show context around stack-2 situations
  let stacks = 0;
  let spendActive = false;
  let atStack2Count = 0;
  let showWindow = false;
  let windowEvents = [];

  for (const e of events) {
    const isCast =
      (e._src === "CONSUME" || e._src === "DEVOUR") && e.type === "cast";
    const isGain =
      e._src === "BUILDING" &&
      (e.type === "applybuff" || e.type === "applybuffstack");

    // Track state
    if (e._src === "BUILDING") {
      if (e.type === "applybuff") stacks = 1;
      else if (e.type === "applybuffstack") stacks = e.stack || stacks + 1;
      else if (e.type === "removebuff") stacks = 0;
      else if (e.type === "removebuffstack")
        stacks = e.stack || Math.max(0, stacks - 1);
    }
    if (e._src === "SPENDING") {
      if (e.type === "applybuff") spendActive = true;
      else if (e.type === "removebuff") spendActive = false;
    }

    // Show any event near stack-2 situations
    if (stacks >= 2 || (isCast && stacks >= 1)) {
      if (!showWindow) {
        showWindow = true;
        // Print buffered events
        for (const we of windowEvents.slice(-3)) {
          console.log(we);
        }
      }
    }

    const line = `${e.timestamp} ${e._src} ${e.type}${e.stack !== undefined ? ` stack=${e.stack}` : ""} [bldg=${stacks} spend=${spendActive}]${isGain ? " <-- GAIN" : ""}${isCast && stacks === 2 ? " *** AT STACK 2 ***" : ""}`;

    if (showWindow) {
      console.log(line);
      if (stacks === 0 && !spendActive) {
        showWindow = false;
        console.log("---");
        atStack2Count++;
        if (atStack2Count >= 15) break;
      }
    } else {
      windowEvents.push(line);
      if (windowEvents.length > 5) windowEvents.shift();
    }
  }

  // Summary: how many casts at stack 2, how many gains at stack 2
  console.log("\n\n=== Stack 2 summary ===");
  stacks = 0;
  spendActive = false;
  let castsAtStack2 = 0;
  let gainsAtStack2 = 0;
  let gainsAtStack2WithCast = 0;

  // Rebuild cast timestamps
  const castTimes = events
    .filter(
      (e) => (e._src === "CONSUME" || e._src === "DEVOUR") && e.type === "cast",
    )
    .map((e) => e.timestamp);

  for (const e of events) {
    const isCast =
      (e._src === "CONSUME" || e._src === "DEVOUR") && e.type === "cast";

    if (isCast && !spendActive && stacks === 2) {
      castsAtStack2++;
    }

    if (e._src === "BUILDING") {
      if (e.type === "applybuffstack" && (e.stack === 3 || stacks === 2)) {
        gainsAtStack2++;
        // Check if any cast within 100ms
        const hasCast = castTimes.some((t) => Math.abs(t - e.timestamp) <= 100);
        if (hasCast) gainsAtStack2WithCast++;
      }
      if (e.type === "applybuff") stacks = 1;
      else if (e.type === "applybuffstack") stacks = e.stack || stacks + 1;
      else if (e.type === "removebuff") stacks = 0;
      else if (e.type === "removebuffstack")
        stacks = e.stack || Math.max(0, stacks - 1);
    }
    if (e._src === "SPENDING") {
      if (e.type === "applybuff") spendActive = true;
      else if (e.type === "removebuff") spendActive = false;
    }
  }

  console.log(`Casts at stack 2 (not during spending): ${castsAtStack2}`);
  console.log(`Building gains from stack 2->3: ${gainsAtStack2}`);
  console.log(`  With Consume/Devour within 100ms: ${gainsAtStack2WithCast}`);
  console.log(
    `  Without (guaranteed): ${gainsAtStack2 - gainsAtStack2WithCast}`,
  );
}

main().catch(console.error);
