# Interaction Data Fixes

Three targeted fixes to clean up interaction data quality issues found during the audit.

## Fix 1: Resolve null target IDs in C++ scanner interactions

**File:** `src/model/interactions.js` (Phase 2 merge section)

35 interactions from `cpp_scanner` have `target.id: null` because the scanner outputs ability names (e.g., `"Soul Cleave"`) without resolving spell IDs. These interactions don't populate `bySpell`, making them invisible to spell-centric lookups.

**Fix:** After loading spells, build a name→id map from `BASE_SPELL_IDS` + `spellMap`. When merging cpp_scanner interactions, resolve `target.name` to a spell ID. Use the map for known abilities; leave null only for buff targets (`buff:*`).

**Verify:** Rebuild interactions. `Interactions with null target.id` should drop from 35 to ~9 (only `buff:*` targets). Spirit Bomb, Soul Cleave, Sigil of Flame should gain modifiers in `bySpell` from cpp_scanner sources.

## Fix 2: Spirit Bomb incoming interactions

**Problem:** Spirit Bomb (247454) has zero entries in `bySpell` — no talents modify it. But talents like Fires of Fel, Any Means Necessary, Fiery Demise definitely affect Spirit Bomb damage. The likely cause: `affectingSpells` data is on the damage component spell (247455) rather than the talent spell (247454).

**File:** `src/model/interactions.js` or `src/model/vengeance-base.js`

**Fix:** Check `data/spells.json` for spell 247455 (Spirit Bomb damage) — does it have `affectingSpells`? If yes, the interaction builder already picks those up but maps them to target 247455, not 247454. Add an alias map for ability→damage component pairs so modifiers on damage components also appear under the parent ability in `bySpell`:

```
247454 ↔ 247455  (Spirit Bomb ↔ Spirit Bomb damage)
228477 ↔ 228478  (Soul Cleave ↔ Soul Cleave damage)
```

These pairs are already in `BASE_SPELL_IDS`. Check if other damage components have the same issue.

**Verify:** Spirit Bomb should appear in `bySpell` with multiple modifiers. Key spell check in verify.js should show Spirit Bomb with >0 modifiers.

## Fix 3: Triage counts active_ability talents as uncovered

**File:** `src/model/interactions.js` (`triageTalents` function)

10 talents categorized as `active_ability` appear as gaps, but several (Fiery Brand, Chaos Nova, Soul Carver) are heavily targeted by incoming interactions. The triage only checks `talentToTargets` (source-side), not whether the talent is an interaction target.

**Fix:** In `triageTalents`, also check if the talent's `spellId` appears as a `target.id` in any interaction. If so, categorize as `has_interactions`.

**Verify:** Active ability count should drop from 10 to ~3–4 (only utility spells like Imprison, Darkness that genuinely have no interactions).

## Execution

Run fixes in order (1 → 2 → 3), rebuild after each: `npm run interactions`. Then `npm run verify` and `npm run audit-report` at the end.

All three fixes are in `src/model/interactions.js` — no new files needed.
