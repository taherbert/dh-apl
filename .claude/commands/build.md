Run `npm run build-data` to regenerate all data files. After the build:

1. Check output counts against expected values (from Raidbots):
   - Raidbots: 42 class nodes, 42 spec nodes, 14+14 hero nodes, 10 choice nodes
   - talents.json: 45 class entries, 44 spec entries, 17 Aldrachi Reaver, 16 Annihilator (higher than node counts due to choice node expansion)
   - spells.json: ~104 spells
2. Run `npm run verify` to validate — expect 0 failures
3. Report any changes from previous build (new spells, removed talents, count shifts)
