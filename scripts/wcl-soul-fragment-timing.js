#!/usr/bin/env node

// Analyze soul fragment spawn timing from WCL logs.
// Tracks fragment activation delay (cast -> buff stack change)
// and overflow -> AotG timing.
//
// Usage: node scripts/wcl-soul-fragment-timing.js <report-code> [fight-id] [source-id]
//   If fight-id omitted, lists fights and prompts.
//   If source-id omitted, lists Vengeance DH players and prompts.

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

// Spell IDs
const SPELL = {
  SOUL_FRAGMENTS: 203981,
  ART_OF_THE_GLAIVE: 444661,
  REAVERS_GLAIVE: 444764, // buff when RG becomes available
  FRACTURE: 263642,
  SOUL_CLEAVE: 228477,
  SPIRIT_BOMB: 247454,
  SOUL_CARVER: 207407,
  FELBLADE: 232893,
  METAMORPHOSIS: 187827,
  IMMOLATION_AURA: 258920,
  SIGIL_OF_SPITE: 390163,
};

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
  if (!data.access_token)
    throw new Error("Auth failed: " + JSON.stringify(data));
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

// Paginated event fetcher
async function fetchAllEvents(code, fightID, sourceID, dataType, abilityID) {
  let all = [];
  let nextPage = null;
  const fight = await getFight(code, fightID);
  let startTime = fight.startTime;
  const endTime = fight.endTime;

  do {
    const sourceFilter = sourceID ? `sourceID: ${sourceID}` : "";
    const abilityFilter = abilityID ? `abilityID: ${abilityID}` : "";
    const data = await graphql(
      `query($code: String!) {
        reportData { report(code: $code) {
          events(
            fightIDs: [${fightID}]
            startTime: ${startTime}
            endTime: ${endTime}
            dataType: ${dataType}
            ${sourceFilter}
            ${abilityFilter}
          ) { data nextPageTimestamp }
        }}
      }`,
      { code },
    );
    const ev = data.reportData.report.events;
    all = all.concat(ev.data);
    nextPage = ev.nextPageTimestamp;
    if (nextPage) startTime = nextPage;
  } while (nextPage);

  return all;
}

let _fightCache = {};
async function getFight(code, fightID) {
  const key = `${code}:${fightID}`;
  if (_fightCache[key]) return _fightCache[key];
  const data = await graphql(
    `
      query ($code: String!) {
        reportData {
          report(code: $code) {
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
  for (const f of data.reportData.report.fights) {
    _fightCache[`${code}:${f.id}`] = f;
  }
  return _fightCache[key];
}

async function listFights(code) {
  const data = await graphql(
    `
      query ($code: String!) {
        reportData {
          report(code: $code) {
            title
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
  const report = data.reportData.report;
  console.log(`Report: ${report.title}\n`);
  console.log("Fights:");
  for (const f of report.fights) {
    if (!f.encounterID) continue;
    const dur = ((f.endTime - f.startTime) / 1000).toFixed(0);
    console.log(`  #${f.id}: ${f.name} (${dur}s, ${f.kill ? "kill" : "wipe"})`);
  }
  return report.fights;
}

async function listPlayers(code, fightID) {
  const data = await graphql(
    `
      query ($code: String!) {
        reportData {
          report(code: $code) {
            masterData {
              actors(type: "Player") {
                id
                name
                type
                subType
              }
            }
          }
        }
      }
    `,
    { code },
  );
  const actors = data.reportData.report.masterData.actors;
  console.log("\nPlayers:");
  for (const a of actors) {
    console.log(`  #${a.id}: ${a.name} (${a.subType})`);
  }
  // Filter to DH specs
  const dhs = actors.filter(
    (a) => a.subType === "Vengeance" || a.subType === "Havoc",
  );
  if (dhs.length > 0) {
    console.log("\nDemon Hunters:");
    for (const a of dhs) {
      console.log(`  #${a.id}: ${a.name} (${a.subType})`);
    }
  }
  return actors;
}

function ts(ms, fightStart) {
  const rel = (ms - fightStart) / 1000;
  const m = Math.floor(rel / 60);
  const s = (rel % 60).toFixed(3);
  return `${m}:${s.padStart(6, "0")}`;
}

async function analyze(code, fightID, sourceID) {
  const fight = await getFight(code, fightID);
  const fightStart = fight.startTime;
  console.log(`\n=== Analyzing: ${fight.name} (fight #${fightID}) ===`);
  console.log(
    `Duration: ${((fight.endTime - fight.startTime) / 1000).toFixed(1)}s\n`,
  );

  // Fetch all event streams in parallel
  console.log("Fetching events...");
  const [fragBuffs, aotgBuffs, casts] = await Promise.all([
    fetchAllEvents(code, fightID, sourceID, "Buffs", SPELL.SOUL_FRAGMENTS),
    fetchAllEvents(code, fightID, sourceID, "Buffs", SPELL.ART_OF_THE_GLAIVE),
    fetchAllEvents(code, fightID, sourceID, "Casts", null),
  ]);

  // Filter casts to relevant abilities
  const relevantCasts = new Set(Object.values(SPELL));
  const filteredCasts = casts.filter((e) => relevantCasts.has(e.abilityGameID));

  console.log(`  Soul Fragments buff events: ${fragBuffs.length}`);
  console.log(`  Art of the Glaive buff events: ${aotgBuffs.length}`);
  console.log(`  Relevant casts: ${filteredCasts.length}`);

  // Build unified timeline
  const timeline = [];

  for (const e of fragBuffs) {
    timeline.push({
      time: e.timestamp,
      category: "frag",
      type: e.type,
      stack: e.stack,
      raw: e,
    });
  }

  for (const e of aotgBuffs) {
    timeline.push({
      time: e.timestamp,
      category: "aotg",
      type: e.type,
      stack: e.stack,
      raw: e,
    });
  }

  for (const e of filteredCasts) {
    if (e.type !== "cast") continue;
    const name = Object.entries(SPELL).find(
      ([, v]) => v === e.abilityGameID,
    )?.[0];
    timeline.push({
      time: e.timestamp,
      category: "cast",
      type: "cast",
      spell: name || `unknown_${e.abilityGameID}`,
      spellId: e.abilityGameID,
      raw: e,
    });
  }

  timeline.sort((a, b) => a.time - b.time || (a.category === "cast" ? -1 : 1));

  // ============================================================
  // Analysis 1: Fragment activation delay
  // For each Fracture cast, find the next soul_fragments stack increase
  // ============================================================
  console.log("\n=== Fragment Activation Delay ===");
  console.log("(Time from Fracture cast to soul_fragments stack increase)\n");

  const fractureCasts = timeline.filter(
    (e) => e.category === "cast" && e.spell === "FRACTURE",
  );
  const fragGains = timeline.filter(
    (e) =>
      e.category === "frag" &&
      (e.type === "applybuff" || e.type === "applybuffstack"),
  );

  const activationDelays = [];
  let fragState = 0; // current fragment count

  // Track fragment state
  for (const fc of fractureCasts) {
    // Find fragment state at cast time
    let preFrags = 0;
    for (const fg of fragBuffs) {
      if (fg.timestamp > fc.time) break;
      if (fg.type === "applybuff") preFrags = 1;
      else if (fg.type === "applybuffstack") preFrags = fg.stack;
      else if (fg.type === "removebuff") preFrags = 0;
      else if (fg.type === "removebuffstack") preFrags = fg.stack;
    }

    // Find the next fragment gain event after this cast
    const nextGains = fragGains.filter(
      (fg) => fg.time > fc.time && fg.time < fc.time + 3000,
    );

    if (nextGains.length > 0) {
      const firstGain = nextGains[0];
      const delay = firstGain.time - fc.time;
      activationDelays.push({
        castTime: fc.time,
        delay,
        preFrags,
        newStack: firstGain.stack,
        isAtCap: preFrags >= 6,
      });
    }
  }

  if (activationDelays.length > 0) {
    const nonCapDelays = activationDelays.filter((d) => !d.isAtCap);
    const capDelays = activationDelays.filter((d) => d.isAtCap);

    if (nonCapDelays.length > 0) {
      const vals = nonCapDelays.map((d) => d.delay);
      vals.sort((a, b) => a - b);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const median = vals[Math.floor(vals.length / 2)];
      const p10 = vals[Math.floor(vals.length * 0.1)];
      const p90 = vals[Math.floor(vals.length * 0.9)];

      console.log(`Non-cap Fracture casts: ${nonCapDelays.length}`);
      console.log(`  Mean delay:   ${mean.toFixed(0)}ms`);
      console.log(`  Median delay: ${median}ms`);
      console.log(`  P10-P90:      ${p10}-${p90}ms`);
      console.log(
        `  All delays:   ${vals.slice(0, 20).join(", ")}${vals.length > 20 ? "..." : ""}`,
      );
    }

    if (capDelays.length > 0) {
      console.log(`\nAt-cap Fracture casts: ${capDelays.length}`);
      console.log(
        "  (Fragments at 6 - no stack change expected from buff events)",
      );
    }
  }

  // ============================================================
  // Analysis 2: Overflow -> AotG timing
  // When fragments are at cap and Fracture is cast, track AotG gain timing
  // ============================================================
  console.log("\n=== Overflow -> AotG Timing ===");
  console.log(
    "(When Fracture is cast at 6 fragments, how quickly does AotG gain stacks?)\n",
  );

  // Build a state machine tracking both fragment count and AotG stacks
  const overflowEvents = [];

  for (const fc of fractureCasts) {
    // Get fragment count at cast time
    let fragCount = 0;
    for (const fg of fragBuffs) {
      if (fg.timestamp > fc.time) break;
      if (fg.type === "applybuff") fragCount = 1;
      else if (fg.type === "applybuffstack") fragCount = fg.stack;
      else if (fg.type === "removebuff") fragCount = 0;
      else if (fg.type === "removebuffstack") fragCount = fg.stack;
    }

    if (fragCount < 6) continue;

    // Get AotG stack at cast time
    let aotgCount = 0;
    for (const ag of aotgBuffs) {
      if (ag.timestamp > fc.time) break;
      if (ag.type === "applybuff") aotgCount = 1;
      else if (ag.type === "applybuffstack") aotgCount = ag.stack;
      else if (ag.type === "removebuff") aotgCount = 0;
      else if (ag.type === "removebuffstack") aotgCount = ag.stack;
    }

    // Check if meta was active (fracture generates 3 instead of 2)
    let metaActive = false;
    for (const ev of timeline) {
      if (ev.time > fc.time) break;
      if (ev.category === "cast" && ev.spell === "METAMORPHOSIS") {
        metaActive = true;
      }
    }
    // Rough meta tracking - look at buff events instead
    const metaBuffs = timeline.filter(
      (e) =>
        e.category === "frag" && e.raw.abilityGameID === SPELL.METAMORPHOSIS,
    );

    // Find subsequent AotG gains within 3s window
    const aotgGains = aotgBuffs.filter(
      (ag) =>
        ag.timestamp > fc.time &&
        ag.timestamp < fc.time + 3000 &&
        (ag.type === "applybuff" || ag.type === "applybuffstack"),
    );

    // Find subsequent fragment changes within 3s window
    const fragChanges = fragBuffs.filter(
      (fg) => fg.timestamp > fc.time && fg.timestamp < fc.time + 3000,
    );

    // Check for Soul Cleave / Spirit Bomb casts in the same window (these also consume and add AotG)
    const consumerCasts = timeline.filter(
      (e) =>
        e.category === "cast" &&
        (e.spell === "SOUL_CLEAVE" || e.spell === "SPIRIT_BOMB") &&
        e.time > fc.time &&
        e.time < fc.time + 3000,
    );

    overflowEvents.push({
      castTime: fc.time,
      fragCount,
      aotgAtCast: aotgCount,
      aotgGains: aotgGains.map((g) => ({
        delay: g.timestamp - fc.time,
        newStack: g.stack,
        type: g.type,
      })),
      fragChanges: fragChanges.map((f) => ({
        delay: f.timestamp - fc.time,
        stack: f.stack,
        type: f.type,
      })),
      consumerCasts: consumerCasts.map((c) => ({
        delay: c.time - fc.time,
        spell: c.spell,
      })),
    });
  }

  if (overflowEvents.length > 0) {
    console.log(`Fracture casts at fragment cap: ${overflowEvents.length}\n`);

    // Show detailed timeline for each overflow event
    const maxShow = Math.min(overflowEvents.length, 15);
    for (let i = 0; i < maxShow; i++) {
      const ov = overflowEvents[i];
      console.log(
        `[${ts(ov.castTime, fightStart)}] Fracture at ${ov.fragCount} frags, AotG=${ov.aotgAtCast}`,
      );

      // Interleave AotG gains, frag changes, and consumer casts by delay
      const events = [
        ...ov.aotgGains.map((g) => ({
          delay: g.delay,
          text: `AotG ${g.type} -> ${g.newStack}`,
        })),
        ...ov.fragChanges.map((f) => ({
          delay: f.delay,
          text: `frags ${f.type} -> ${f.stack}`,
        })),
        ...ov.consumerCasts.map((c) => ({
          delay: c.delay,
          text: `CAST ${c.spell}`,
        })),
      ].sort((a, b) => a.delay - b.delay);

      for (const ev of events) {
        console.log(`    +${ev.delay}ms: ${ev.text}`);
      }
      console.log("");
    }

    // Summary: for overflow events with NO consumer cast in the window,
    // how quickly does AotG gain stacks?
    const pureOverflows = overflowEvents.filter(
      (ov) => ov.consumerCasts.length === 0,
    );
    console.log(
      `\nPure overflow events (no Soul Cleave/Spirit Bomb within 3s): ${pureOverflows.length}`,
    );

    if (pureOverflows.length > 0) {
      // First AotG gain delay after overflow
      const firstGainDelays = pureOverflows
        .filter((ov) => ov.aotgGains.length > 0)
        .map((ov) => ov.aotgGains[0].delay);

      if (firstGainDelays.length > 0) {
        firstGainDelays.sort((a, b) => a - b);
        const mean =
          firstGainDelays.reduce((a, b) => a + b, 0) / firstGainDelays.length;
        console.log(`  Events with AotG gain: ${firstGainDelays.length}`);
        console.log(`  Mean first-gain delay: ${mean.toFixed(0)}ms`);
        console.log(
          `  Median: ${firstGainDelays[Math.floor(firstGainDelays.length / 2)]}ms`,
        );
        console.log(
          `  Range: ${firstGainDelays[0]}-${firstGainDelays[firstGainDelays.length - 1]}ms`,
        );
      }

      const noGain = pureOverflows.filter((ov) => ov.aotgGains.length === 0);
      if (noGain.length > 0) {
        console.log(
          `  Events with NO AotG gain within 3s: ${noGain.length} (!!)`,
        );
        for (const ov of noGain.slice(0, 5)) {
          console.log(
            `    at ${ts(ov.castTime, fightStart)}: frags=${ov.fragCount}, AotG=${ov.aotgAtCast}`,
          );
        }
      }
    }

    // Total AotG gains per overflow
    const gainsPerOverflow = overflowEvents.map((ov) => ov.aotgGains.length);
    const meanGains =
      gainsPerOverflow.reduce((a, b) => a + b, 0) / gainsPerOverflow.length;
    console.log(
      `\nMean AotG gains per overflow Fracture (3s window): ${meanGains.toFixed(1)}`,
    );
  } else {
    console.log("No Fracture casts found at fragment cap.");
  }

  // ============================================================
  // Analysis 3: Fragment generation rate by source
  // ============================================================
  console.log("\n=== Fragment Generation Summary ===\n");

  const generatorCasts = timeline.filter((e) => e.category === "cast");
  const castCounts = {};
  for (const e of generatorCasts) {
    castCounts[e.spell] = (castCounts[e.spell] || 0) + 1;
  }
  for (const [spell, count] of Object.entries(castCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${spell}: ${count} casts`);
  }

  const fightDur = (fight.endTime - fight.startTime) / 1000;
  const totalFragGains = fragBuffs.filter(
    (e) => e.type === "applybuff" || e.type === "applybuffstack",
  ).length;
  console.log(`\nTotal fragment buff gain events: ${totalFragGains}`);
  console.log(`Fight duration: ${fightDur.toFixed(1)}s`);
  console.log(
    `Fragment gain rate: ${(totalFragGains / fightDur).toFixed(2)}/s`,
  );

  const totalAotgGains = aotgBuffs.filter(
    (e) => e.type === "applybuff" || e.type === "applybuffstack",
  ).length;
  console.log(`\nTotal AotG buff gain events: ${totalAotgGains}`);
  console.log(`AotG gain rate: ${(totalAotgGains / fightDur).toFixed(2)}/s`);
}

async function findReport() {
  // Find a recent Vengeance DH dungeon log from Midnight dungeons
  // First discover dungeon encounter IDs
  console.log("Searching for Midnight dungeon encounters...\n");

  for (const expId of [6, 7, 8, 9, 10]) {
    try {
      const expData = await graphql(
        `query { worldData { expansion(id: ${expId}) { id name zones { id name encounters { id name } } } } }`,
      );
      const exp = expData.worldData.expansion;
      if (!exp) continue;
      console.log(`Expansion ${exp.id}: ${exp.name}`);
      for (const z of exp.zones) {
        console.log(
          `  ${z.name} (zone ${z.id}, ${z.encounters.length} encounters)`,
        );
      }
    } catch {
      /* skip */
    }
  }

  // Try Vengeance DH rankings on Midnight dungeon encounters
  const dungeonEncounters = [];

  // Zone 47 = Midnight Mythic+ Season 1
  for (const zoneId of [47, 49]) {
    try {
      const zoneData = await graphql(
        `query { worldData { zone(id: ${zoneId}) { id name encounters { id name } } } }`,
      );
      const zone = zoneData.worldData.zone;
      if (!zone) continue;
      for (const enc of zone.encounters) {
        dungeonEncounters.push({
          zoneId: zone.id,
          zoneName: zone.name,
          ...enc,
        });
      }
    } catch {
      /* skip */
    }
  }

  if (dungeonEncounters.length === 0) {
    console.log("\nNo dungeon encounters found. Trying rankings directly...");
  } else {
    console.log(`\nFound ${dungeonEncounters.length} dungeon encounters`);
  }

  // Show all encounters found
  for (const enc of dungeonEncounters) {
    console.log(`  ${enc.name} (encounter ${enc.id}, zone ${enc.zoneName})`);
  }

  // Try to get rankings for encounters - try multiple parameter combos
  for (const enc of dungeonEncounters) {
    console.log(`\nTrying: ${enc.name} (encounter ${enc.id})`);

    // Try with leaderboard parameter for M+
    for (const params of [
      "metric: dps",
      "metric: dps, leaderboard: Any",
      "metric: bossdps",
    ]) {
      try {
        const rankData = await graphql(
          `query {
            worldData {
              encounter(id: ${enc.id}) {
                characterRankings(
                  specName: "Vengeance"
                  className: "DemonHunter"
                  ${params}
                  page: 1
                )
              }
            }
          }`,
        );
        const rankings =
          rankData.worldData.encounter?.characterRankings?.rankings || [];
        if (rankings.length > 0) {
          console.log(`  Found ${rankings.length} rankings (${params})!`);
          for (const r of rankings.slice(0, 5)) {
            console.log(
              `  ${r.name}-${r.server?.name}: report=${r.report?.code} fight=${r.report?.fightID}`,
            );
          }
          return;
        }
      } catch (err) {
        console.log(`  ${params}: ${err.message.slice(0, 80)}`);
      }
    }
    console.log("  No rankings found");
  }

  // Try Midnight raid zone (46)
  console.log("\n\n=== Midnight Raid (zone 46) ===");
  try {
    const raidZoneData = await graphql(`
      query {
        worldData {
          zone(id: 46) {
            encounters {
              id
              name
            }
          }
        }
      }
    `);
    const raidEncounters = raidZoneData.worldData.zone?.encounters || [];
    for (const enc of raidEncounters.slice(0, 3)) {
      console.log(`\nTrying: ${enc.name} (encounter ${enc.id})`);
      const rankData = await graphql(
        `query {
          worldData {
            encounter(id: ${enc.id}) {
              characterRankings(
                specName: "Vengeance"
                className: "DemonHunter"
                metric: dps
                page: 1
              )
            }
          }
        }`,
      );
      const rankings =
        rankData.worldData.encounter?.characterRankings?.rankings || [];
      if (rankings.length > 0) {
        console.log(`  Found ${rankings.length} rankings!`);
        for (const r of rankings.slice(0, 10)) {
          console.log(
            `  ${r.name}-${r.server?.name}: report=${r.report?.code} fight=${r.report?.fightID}`,
          );
        }
        return;
      }
    }
  } catch (err) {
    console.log(`Raid zone error: ${err.message.slice(0, 100)}`);
  }

  // Fallback: try TWW M+ Season 3 (zone 45)
  console.log("\n\n=== Fallback: TWW M+ Season 3 (zone 45) ===");
  try {
    const zoneData = await graphql(`
      query {
        worldData {
          zone(id: 45) {
            encounters {
              id
              name
            }
          }
        }
      }
    `);
    const encounters = zoneData.worldData.zone?.encounters || [];
    for (const enc of encounters.slice(0, 3)) {
      console.log(`\nTrying: ${enc.name} (encounter ${enc.id})`);
      const rankData = await graphql(
        `query {
          worldData {
            encounter(id: ${enc.id}) {
              characterRankings(
                specName: "Vengeance"
                className: "DemonHunter"
                metric: dps
                page: 1
              )
            }
          }
        }`,
      );
      const rankings =
        rankData.worldData.encounter?.characterRankings?.rankings || [];
      if (rankings.length > 0) {
        console.log(`  Found ${rankings.length} rankings!`);
        for (const r of rankings.slice(0, 5)) {
          console.log(
            `  ${r.name}-${r.server?.name}: report=${r.report?.code} fight=${r.report?.fightID}`,
          );
        }
        return;
      }
    }
  } catch (err) {
    console.log(`Error: ${err.message.slice(0, 100)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "find") {
    await authenticate();
    await findReport();
    return;
  }

  await authenticate();

  const code = args[0];
  let fightID = args[1] ? parseInt(args[1]) : null;
  let sourceID = args[2] ? parseInt(args[2]) : null;

  if (!fightID) {
    await listFights(code);
    console.log("\nRe-run with fight ID as second argument.");
    return;
  }

  if (!sourceID) {
    await listPlayers(code, fightID);
    console.log("\nRe-run with source ID as third argument.");
    return;
  }

  await analyze(code, fightID, sourceID);
}

main().catch(console.error);
