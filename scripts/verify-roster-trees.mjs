import { initSpec } from "../src/engine/startup.js";
import { getDb } from "../src/util/db.js";
import { detectHeroTree } from "../src/util/talent-fingerprint.js";
await initSpec("vengeance");
const db = getDb();
const builds = db.prepare("SELECT hash, hero_tree, name FROM builds WHERE in_roster=1").all();
let mismatches = 0;
for (const b of builds) {
  try {
    const detected = detectHeroTree(b.hash);
    const norm = detected.replace(/[- ]/g, "_").toLowerCase();
    if (norm !== b.hero_tree) {
      console.log("MISMATCH:", b.name, "db=" + b.hero_tree, "detected=" + norm);
      mismatches++;
    }
  } catch (e) {
    console.log("ERROR:", b.name, e.message);
    mismatches++;
  }
}
console.log(mismatches === 0 ? "All " + builds.length + " builds: hero tree choice nodes correct" : mismatches + " mismatches out of " + builds.length);
