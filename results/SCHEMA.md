# Results Persistence Schemas

## build-registry.json

Tracks every talent build tested, its simulation results, and which APL version produced those results. When an APL changes, builds tested under the old APL become "stale" — their rankings may no longer be accurate.

### Build entry

```json
{
  "id": "ar-fiery-demise-v1",
  "name": "AR Fiery Demise",
  "talents": "CUkAAA...",
  "heroTree": "aldrachi_reaver",
  "archetype": "ar-fiery-demise",
  "notes": "Standard AR build with Fiery Demise + Down in Flames",
  "talentSwaps": ["Took Down in Flames over Burning Alive"],
  "tests": [
    {
      "date": "2026-02-03",
      "aplFile": "apls/vengeance.simc",
      "aplHash": "abc123",
      "scenario": "patchwerk",
      "results": {
        "st": { "dps": 3087582, "stderr": 12340 },
        "3t": { "dps": 8238623, "stderr": 34210 },
        "10t": { "dps": 18732678, "stderr": 56780 }
      },
      "iterationId": "iter-007",
      "stale": false
    }
  ]
}
```

### APL version entry

```json
{
  "hash": "abc123",
  "file": "apls/vengeance.simc",
  "date": "2026-02-03",
  "description": "After iteration 7: accepted Brand-first ordering",
  "iterationId": "iter-007"
}
```

### Stale build warning

When an APL is modified (new iteration accepted), add a warning:

```json
{
  "date": "2026-02-03",
  "reason": "APL changed: accepted Brand-first ordering (+0.6% ST)",
  "newAplHash": "def456",
  "oldAplHash": "abc123",
  "affectedBuilds": ["ar-fiery-demise-v1", "ar-spirit-bomb-v1"],
  "resolved": false
}
```

### Operations

**After accepting an APL change:**
1. Record new APL version
2. Mark all builds tested under old APL hash as potentially stale
3. Add stale build warning
4. Suggest re-testing top 2-3 builds if rankings are tight

**After testing a build:**
1. Add or update build entry with new test results
2. If this resolves a stale warning, mark it resolved

**On session startup:**
1. Read registry, check for unresolved stale warnings
2. Report: "N builds have stale results — APL changed since last test"

## findings.json

Accumulated analytical insights across sessions. Each finding is a discrete insight with evidence and confidence.

### Finding entry

```json
{
  "date": "2026-02-03",
  "insight": "Short description of the finding",
  "evidence": "Specific numbers, sim results, or reasoning",
  "confidence": "high|medium|low",
  "build": "build-id or archetype name",
  "aplVersion": "filename or hash",
  "status": "validated|rejected|untested|superseded",
  "tags": ["category-tags", "for-filtering"],
  "supersededBy": null
}
```

### Operations

**On session startup:**
1. Read findings, filter to `status: "validated"` for current context
2. Use as calibration: "we already know X, so hypothesis Y should account for it"

**On session completion:**
1. Append new findings for each insight discovered
2. If a finding contradicts an existing one, mark the old one `superseded`

### Tags (common)

- `fragment-economy` — fragment generation, consumption, overflow
- `fury-economy` — fury generation, spending, overcap
- `resource-gating` — guards that restrict ability usage
- `resource-competition` — consumers competing for same pool
- `cooldown-sequencing` — order of cooldown usage
- `burst-window` — damage amplification window utilization
- `fiery-demise` — Fiery Brand window optimization
- `metamorphosis` — Meta window optimization
- `state-machine` — AR cycle or Anni Voidfall cycle
- `talent-synergy` — talent interaction compound effects
- `build-apl-coupling` — changes that require both build and APL adaptation
- `target-count` — AoE scaling, breakpoints
