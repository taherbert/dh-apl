import { readFileSync } from 'fs';
import { initSpec } from '../src/engine/startup.js';
import { dataFile } from '../src/engine/paths.js';
import { decode, loadFullNodeList } from '../src/util/talent-string.js';
await initSpec('vengeance');
const data = JSON.parse(readFileSync(dataFile('raidbots-talents.json'), 'utf8'));
const nodes = loadFullNodeList();
const { specId, selections } = decode(process.argv[2], nodes);
console.log('Spec ID:', specId, 'Selections:', selections.size);

const nodeById = new Map();
for (const n of [...data.classNodes, ...data.specNodes, ...Object.values(data.heroSubtrees).flat()]) {
  nodeById.set(n.id, n);
}

let heroTree = 'unknown';
const heroNodeIds = new Set();
for (const [treeName, treeNodes] of Object.entries(data.heroSubtrees)) {
  for (const n of treeNodes) {
    if (selections.has(n.id)) {
      heroTree = treeName;
      heroNodeIds.add(n.id);
    }
  }
}
console.log('Hero tree:', heroTree);

// Check apex
const specConfig = (await import('../src/spec/vengeance.js')).SPEC_CONFIG;
const apexTalents = specConfig?.apex || [];
let apexRank = 0;
for (const [id, sel] of selections) {
  const node = nodeById.get(id);
  const name = node?.name || node?.entries?.[0]?.name || '';
  if (apexTalents.some(a => a.name === name || a.talentName === name)) {
    apexRank = sel.rank;
  }
}
console.log('Apex rank:', apexRank);

for (const [id, sel] of selections) {
  const node = nodeById.get(id);
  const name = node?.name || node?.entries?.[0]?.name || 'unknown';
  const suffix = sel.rank > 1 ? ` (rank ${sel.rank})` : '';
  const section = heroNodeIds.has(id) ? ' [HERO]' : '';
  console.log(`  ${name}${suffix}${section}`);
}
