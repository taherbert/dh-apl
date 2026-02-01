# Data Sources, Project Setup, and Audit Refinement

## Part 1: Integrate Raidbots as Authoritative Talent Source

Raidbots provides **authoritative, current talent tree data** via static JSON endpoints. This is our new source of truth for what talents exist — replacing the unreliable DBC talent dump.

### Endpoints

```
https://www.raidbots.com/static/data/{env}/talents.json
```

Where `{env}` is `live` or `ptr`.

### What It Provides

For Vengeance DH (className: "Demon Hunter", specName: "Vengeance", specId: 581):

- **classNodes** (42): Shared DH talents with node IDs, spell IDs, positions, connections (prev/next), choice node variants
- **specNodes** (42 for Vengeance): Spec-specific talents — NO stale entries like Bulk Extraction
- **heroNodes** (28): Hero tree talents for BOTH available hero trees
  - Subtree 35: Aldrachi Reaver (14 nodes) — includes Broken Spirit, Keen Edge, Bladecraft
  - Subtree 124: Annihilator (14 nodes) — Voidfall, Catastrophe, Dark Matter, World Killer, etc.
- **subTreeNodes** (1): The hero tree selection node showing available hero trees
- **Choice nodes**: type="choice" with multiple entries (index 100, 200, or 300)

### Node Structure

```json
{
  "id": 94915,
  "name": "Art of the Glaive",
  "type": "single", // or "choice"
  "posX": 8100,
  "posY": 1200,
  "maxRanks": 1,
  "entryNode": true,
  "subTreeId": 35, // for hero nodes
  "freeNode": true, // no point cost
  "reqPoints": 0, // points required to unlock
  "next": [94898, 94911], // downstream node IDs
  "prev": [], // upstream node IDs
  "entries": [
    {
      "id": 117512,
      "definitionId": 122524,
      "maxRanks": 1,
      "type": "passive", // or "active"
      "name": "Art of the Glaive",
      "spellId": 442290,
      "icon": "inv_ability_...",
      "index": 100 // 100/200/300 for choice nodes
    }
  ]
}
```

### Implementation Tasks

1. **Create `src/extract/raidbots.js`** — Fetches Raidbots talent data for the configured environment (live/ptr). Saves to `data/raidbots-talents.json`.

2. **Create `src/config.js`** — Central config module (see Part 3 below) that controls which environment to use.

3. **Refactor `src/model/talents.js`** — Use Raidbots data as the primary talent tree source instead of the simc talent dump:
   - Class nodes → class tree
   - Spec nodes → spec tree
   - Hero nodes grouped by subTreeId → hero trees (Aldrachi Reaver, Annihilator)
   - Choice nodes properly represented with all options
   - Spell IDs from Raidbots used to fetch spell data from simc

4. **Update `src/extract/spells.js`** — Collect spell IDs from Raidbots talent data (not the simc talent dump). Then query simc `spell_query=spell.id={id}` for each to get effect data. This ensures we only fetch spells that are actually in the current talent tree.

5. **Add Raidbots data to `src/verify.js`** — Compare our talent tree against Raidbots as ground truth. Any talent in our data but NOT in Raidbots is stale. Any talent in Raidbots but NOT in our data is missing.

### Raidbots Also Provides (for future use)

Other endpoints at `https://www.raidbots.com/static/data/{env}/`:

- `enchantments.json` — Weapon enchants, gems
- `item-names.json` — Multilingual item database
- `bonuses.json` — Item set bonuses
- `instances.json` — Dungeon/raid metadata

---

## Part 2: Refine .claude Project Setup

### Skills to Create

Create `.claude/commands/` with these reusable skills:

#### `verify.md` — Run data verification

```
Run `npm run verify` and analyze the results. If there are failures or warnings, investigate each one:
- For missing talents: check if they exist in Raidbots data and SpellDataDump
- For stale talents: confirm they're absent from Raidbots
- For unknown interactions: look up the source spell in SpellDataDump
- For contamination: trace the leak path and fix the filter

Fix any issues found, rebuild data, and re-verify until clean.
```

#### `build.md` — Rebuild all data

```
Run `npm run build-data` to regenerate all data files. After the build:
1. Check output counts against expected values
2. Run `npm run verify` to validate
3. Report any changes from previous build (new spells, removed talents, etc.)
```

#### `sim.md` — Run simulations

```
Run simulations using `npm run sim`. Arguments: APL file path and optional scenario.
After sim completes, run `npm run analyze` and report key metrics:
- DPS/HPS numbers for each scenario
- Top damage sources
- Key buff uptimes
- Resource efficiency
Compare against baseline if available in PLAN.md.
```

#### `audit.md` — Full data audit

```
Read prompts/verify-data.md and execute the full verification procedure. This is a comprehensive audit — cross-reference Raidbots, simc C++, SpellDataDump, and our data files. Report all findings and fix what can be fixed.
```

### Update CLAUDE.md

Add to CLAUDE.md:

- Raidbots data source documentation
- Environment toggle documentation (see Part 3)
- Choice node handling notes
- Updated hero tree info (Aldrachi Reaver + Annihilator, not Fel-Scarred)

### Update .claude/settings.local.json

Add permissions for Raidbots data fetching:

```json
{
  "permissions": {
    "allow": [
      "Bash(node:*)",
      "Bash(npm run *)",
      "WebFetch(domain:github.com)",
      "WebFetch(domain:www.raidbots.com)",
      "WebFetch(domain:mimiron.raidbots.com)",
      "WebFetch(domain:nether.wowhead.com)"
    ]
  }
}
```

---

## Part 3: Environment Toggle (Live / PTR / Beta)

Create a single config file that controls which data environment is used everywhere.

### `src/config.js`

```javascript
// Central configuration. Change DATA_ENV to switch all data sources.
export const DATA_ENV = "live"; // "live" | "ptr"

export const RAIDBOTS_BASE = `https://www.raidbots.com/static/data/${DATA_ENV}`;
export const SIMC_DIR = "/Users/tom/Documents/GitHub/simc";
export const SIMC_BIN = `${SIMC_DIR}/engine/simc`;
export const SIMC_DH_CPP = `${SIMC_DIR}/engine/class_modules/sc_demon_hunter.cpp`;

// Raidbots endpoints
export const RAIDBOTS_TALENTS = `${RAIDBOTS_BASE}/talents.json`;

// VDH identifiers
export const CLASS_NAME = "Demon Hunter";
export const SPEC_NAME = "Vengeance";
export const SPEC_ID = 581;
export const HERO_SUBTREES = { 35: "Aldrachi Reaver", 124: "Annihilator" };
```

### Integration Points

Every module that touches external data should import from `src/config.js`:

- `src/extract/raidbots.js` — Uses `RAIDBOTS_TALENTS`
- `src/extract/spells.js` — Uses `SIMC_BIN`
- `src/model/talents.js` — Uses `SIMC_DH_CPP`, `HERO_SUBTREES`
- `src/sim/runner.js` — Uses `SIMC_BIN`
- `src/verify.js` — Uses all paths

### Switching Environments

To switch from live to PTR:

1. Change `DATA_ENV` in `src/config.js` from `"live"` to `"ptr"`
2. Run `npm run build-data` to regenerate everything from PTR sources

To also switch simc branch (if testing a different game version):

1. `git -C /Users/tom/Documents/GitHub/simc checkout {branch}`
2. Rebuild simc if needed
3. Run `npm run build-data`

### Package.json Scripts

Add convenience scripts:

```json
{
  "fetch-raidbots": "node src/extract/raidbots.js",
  "build-data": "npm run fetch-raidbots && npm run extract && npm run talents && npm run interactions && npm run report && npm run graph"
}
```

---

## Part 4: Update Audit Prompt

Rewrite `prompts/verify-data.md` incorporating these findings:

### Key Changes from Previous Version

1. **Raidbots is the primary talent tree authority** — replaces the unreliable DBC talent dump and Wowhead scraping
2. **Environment-aware** — verification checks the configured environment (live/ptr) and uses matching Raidbots data
3. **Choice nodes** — 10 choice nodes in VDH (3 class, 2 spec, 3 Aldrachi Reaver, 2 Annihilator). Each must have all options represented.
4. **Exact expected counts** from Raidbots: 42 class nodes, 42 spec nodes, 14+14 hero nodes
5. **SpellDataDump as spell effect authority** — for spell effects/coefficients not available via spell_query, parse from `SpellDataDump/demonhunter.txt`
6. **No more "unknown" tolerance** — every interaction must have a classified type
7. **Three-way verification**: Raidbots (tree structure) × simc C++ (implementation) × SpellDataDump (spell effects)

### Updated Verification Hierarchy

```
WHAT EXISTS IN THE GAME:     Raidbots talents.json (ground truth)
HOW SIMC IMPLEMENTS IT:      sc_demon_hunter.cpp (C++ assignments)
SPELL MECHANICAL DATA:       SpellDataDump/demonhunter.txt (effects, coefficients)
SPELL QUERY DATA:            simc spell_query (runtime, limited by binary age)
```

If something is in Raidbots but not in simc C++, it's a real talent that simc hasn't implemented yet.
If something is in simc C++ but not in Raidbots, it's dead code — exclude it.
If something is in our data but not in Raidbots, it's stale — remove it.

### Updated Audit Prompt Content

The new `prompts/verify-data.md` should contain:

1. **Fetch Raidbots data** for configured environment
2. **Compare talent counts**: our data vs Raidbots (must match exactly)
3. **Verify every talent name and spell ID** from Raidbots exists in our data
4. **Flag stale talents** in our data that aren't in Raidbots
5. **Verify choice nodes** have all options represented
6. **Verify hero tree completeness**: Aldrachi Reaver (14) + Annihilator (14)
7. **Check interaction coverage**: 0% unknown target
8. **Cross-reference spell effects** against SpellDataDump for top abilities
9. **Verify environment consistency**: all data from same env (live or ptr)
10. **Report simc binary freshness** vs SpellDataDump update date

---

## Execution Order

1. Create `src/config.js` first (all other changes depend on it)
2. Create `src/extract/raidbots.js` to fetch talent data
3. Refactor `src/model/talents.js` to use Raidbots as primary source
4. Refactor `src/extract/spells.js` to get spell IDs from Raidbots
5. Update `src/verify.js` with Raidbots-based verification
6. Create `.claude/commands/` skills
7. Update `.claude/settings.local.json`
8. Update `CLAUDE.md` with new architecture
9. Rewrite `prompts/verify-data.md`
10. Run full `npm run build-data && npm run verify` to validate
11. Update `PLAN.md` with results
