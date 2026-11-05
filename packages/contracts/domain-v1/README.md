# Existing domain shared validation v1

`generated.schemas.json` is generated from the current authoritative TypeScript/Zod codecs. It is distinct from the received five proposed envelopes under `../reference/`; none of those files are rewritten or promoted to canonical storage.

```sh
npm run export:domain-schemas
npm run verify:domain-contracts
```

The verification command checks for stale generated schemas and compares identical anonymized positive/rejection cases through Zod, native Draft-07 Ajv 6 and Python jsonschema 4.26.0. Install the pinned `../requirements-validation.txt` before running Python parity. The report goes to ignored `artifacts/pr05/domain-contracts-validation.json`.

The transport carries `payloadJson` as exact text and an additional SHA-256. Python forwards these bytes unchanged. TS source QA, approval/draft hash validation and bank/audio verification remain authoritative. Shape validation never grants approval or authenticates owner/target. Unknown owner metadata is explicit null; the read bridge uses the existing local owner guard, not production authentication.

Legacy objects keep their versions, IDs, key order and hash algorithms. Source offsets are UTF-16 code units. General string length checks in the installed Zod and JSON Schema count Unicode code points. The parity report separately lists cases accepted structurally but rejected by the TS domain validator.

Full mapping, normalization boundaries and PR06 follow-up: [PR05 domain contracts](../../../docs/pr05-domain-contracts.md).
