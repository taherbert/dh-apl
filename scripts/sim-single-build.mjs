import { initSpec, SCENARIOS, SCENARIO_WEIGHTS, FIDELITY_TIERS } from '../src/engine/startup.js';
import { getDb } from '../src/util/db.js';
import { loadRoster } from '../src/sim/build-roster.js';
import { generateRosterProfilesetContent, runProfilesetAsync, profilesetResultsToActorMap } from '../src/sim/profilesets.js';
import { join } from 'path';
import { aplsDir } from '../src/engine/paths.js';
import { existsSync } from 'fs';

await initSpec('havoc');
const db = getDb();
const hash = process.argv[2] || 'CEkAAAAAAAAAAAAAAAAAAAAAAYgZmZMjZmZmhJjZGAAAAAAwsZMbzMmZmtZmx2sNzMMGzYZgtZxMGmNNNMzYYDAAAAAAAgZGMAAAAM';

const roster = loadRoster();
const build = roster.builds.find(b => b.hash === hash);
if (!build) { console.error('Build not in loaded roster'); process.exit(1); }
const miniRoster = { builds: [build] };

const oursPath = join(aplsDir(), 'havoc.simc');
const baselinePath = join(aplsDir(), 'baseline.simc');
const fidelity = FIDELITY_TIERS.standard;

// Our APL
for (const scenario of Object.keys(SCENARIOS)) {
  console.log('Our APL -', SCENARIOS[scenario].name, '...');
  const content = generateRosterProfilesetContent(miniRoster, oursPath);
  const results = await runProfilesetAsync(content, scenario, 'single_build', { simOverrides: { target_error: fidelity.target_error } });
  const actorMap = profilesetResultsToActorMap(results, miniRoster);
  const dps = actorMap.get(build.id)?.dps;
  console.log('  DPS:', dps);
  const col = 'dps_' + scenario;
  db.prepare(`UPDATE builds SET ${col} = ? WHERE hash = ? AND spec = ?`).run(dps, hash, 'havoc');
}

// Baseline APL
if (existsSync(baselinePath)) {
  for (const scenario of Object.keys(SCENARIOS)) {
    console.log('Baseline -', SCENARIOS[scenario].name, '...');
    const content = generateRosterProfilesetContent(miniRoster, baselinePath);
    const results = await runProfilesetAsync(content, scenario, 'single_baseline', { simOverrides: { target_error: fidelity.target_error } });
    const actorMap = profilesetResultsToActorMap(results, miniRoster);
    const dps = actorMap.get(build.id)?.dps;
    console.log('  DPS:', dps);
    const col = 'simc_dps_' + scenario;
    db.prepare(`UPDATE builds SET ${col} = ? WHERE hash = ? AND spec = ?`).run(dps, hash, 'havoc');
  }
}

// Compute weighted
const weights = SCENARIO_WEIGHTS;
const row = db.prepare('SELECT * FROM builds WHERE hash = ? AND spec = ?').get(hash, 'havoc');
const weighted = Object.keys(weights).reduce((sum, s) => sum + (row['dps_' + s] || 0) * weights[s], 0);
const simcWeighted = Object.keys(weights).reduce((sum, s) => sum + (row['simc_dps_' + s] || 0) * weights[s], 0);
db.prepare('UPDATE builds SET weighted = ?, simc_weighted = ? WHERE hash = ? AND spec = ?').run(weighted, simcWeighted, hash, 'havoc');

console.log(`\nFinal: ST=${row.dps_st} weighted=${weighted.toFixed(0)}`);
