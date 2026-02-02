# Plan: Fix Talent String Encode/Decode

## Problem

Our `src/util/talent-string.js` produces strings that Wowhead beta rejects. We reverse-engineered the format from partial sources instead of faithfully porting a known working implementation. The result doesn't match what the game client, simc, Raidbots, or Wowhead produce.

## Root Cause

Two unknowns we got wrong:

1. **Which nodes** to iterate (and in what order) when encoding/decoding
2. **How to classify nodes** (choice vs single, granted vs purchased, etc.)

Different sources (simc binary, Raidbots API, game client) use different node lists depending on the DBC version. We merged data from multiple sources and got a Frankenstein list that matches nothing.

## Approach: Pick ONE authoritative source and match it exactly

### Option A: Port simc's C++ implementation exactly

- Source: `engine/player/player.cpp` (`generate_traits_hash` / `parse_traits_hash`)
- Node list: `generate_tree_nodes()` using `trait_data_t::data(class_idx, tree)`
- Pro: We have the full source code, can verify by running simc
- Con: Requires parsing the same DBC inc files simc uses; node list depends on compiled DBC version

### Option B: Match Raidbots/Wowhead

- Raidbots and Wowhead both consume talent strings from the game client
- They must use the same node list as the game client: `C_Traits.GetTreeNodes()` → all nodes for the class, sorted by nodeID
- Pro: Strings will work in Wowhead/Raidbots by definition
- Con: Need to determine their exact node list (can extract from their API or from the game client's DBC)

### Recommended: Option A (simc) as primary, validate against Wowhead

simc is the only source where we have complete source code AND can run the binary to verify output. We can:

1. Build simc from source (midnight branch) to get a binary with matching DBC
2. Generate a talent string with simc, decode it with our code, re-encode, compare
3. Iterate until our output matches simc's byte-for-byte

## Implementation Steps

### Phase 1: Establish ground truth

1. **Build simc from the midnight branch** so the binary matches our DBC source files
2. **Generate a reference VDH talent string** by running simc with a known profile
3. **Dump simc's internal node list** — add temporary debug output to `generate_tree_nodes()` that prints every `(nodeId, nodeType, is_choice, num_entries)` in iteration order, OR extract this from the DBC files using the exact same logic simc uses
4. **Record the reference**: node count, node IDs in order, the talent string, and the decoded talent selections

### Phase 2: Build the correct node list

5. **Replicate `generate_tree_nodes()` in JS** — port the exact C++ logic:
   - Iterate `talent_tree` enum values (CLASS=1, SPECIALIZATION=2, HERO=3, SELECTION=4)
   - For each tree, get all `trait_data` entries where `class_id` matches DH (12)
   - Group entries by `node_id` into a `Map<nodeId, entries[]>`
   - The resulting map keys, sorted ascending, are the node iteration order
6. **Verify node list matches simc** — compare our JS node list against simc's debug dump from step 3. Must be identical count and order.

### Phase 3: Fix encode/decode

7. **Port `generate_traits_hash()` exactly** — match every bit write:
   - `is_choice` = `node_type == NODE_CHOICE(2) || node_type == NODE_SELECTION(3)`
   - `is_granted` = check against `trait_data_t::is_granted()` logic
   - Rank accumulation for tiered nodes (NODE_TIERED=1): sum ranks across entries
   - Choice index = position of the selected entry in the node's entry vector
8. **Port `parse_traits_hash()` exactly** — match every bit read
9. **Byte-for-byte verification**: encode a known build → compare against simc's output string. Must match exactly.

### Phase 4: Validate against Wowhead

10. **Test import on Wowhead beta** — paste our generated string into `wowhead.com/beta/talent-calc/demon-hunter/vengeance`
11. **Test export from Wowhead** — copy a string from Wowhead, decode with our tool, verify talents match
12. **If Wowhead uses a different node list than simc** (possible if Wowhead's beta DBC differs), document the discrepancy and determine which to target

### Phase 5: Integration

13. **Update `raidbots.js`** to generate the correct node list file (matching our encode/decode needs)
14. **Update `talent-combos.js`** to generate talent strings for each build using the fixed encoder
15. **Add a verification command** that round-trips a known Wowhead string and checks for exact match

## Success Criteria

- `node src/util/talent-string.js --test` produces a string that imports successfully into Wowhead beta
- A string exported from Wowhead beta decodes correctly and re-encodes to the same string
- simc can parse strings we generate without errors
- Our internal DoE builds all produce valid importable strings

## Key Files

- `src/util/talent-string.js` — encode/decode (rewrite)
- `src/extract/raidbots.js` — node list generation (update)
- `data/dh-all-nodes.json` — node list data (regenerate)
- Reference: `simc/engine/player/player.cpp` lines 2675-2845
- Reference: `simc/engine/dbc/trait_data.cpp`
- Reference: `simc/engine/dbc/generated/trait_data_ptr.inc`
