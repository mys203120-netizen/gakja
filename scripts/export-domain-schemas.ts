import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { domainSchemas, domainEnvelopeSchema } from '../server/contracts/domain-envelope';

// Installed Zod 4.6.7 counts Unicode code points for min/maxLength, matching
// JSON Schema. Source offsets remain UTF-16, a separate domain rule.
function portablePatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portablePatterns);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    // Python's $ permits a final newline; the current JS pattern does not.
    // Make the exact existing hex constraint portable, not a general regex conversion.
    if (key === 'pattern') {
      if (child !== '^[a-f0-9]{64}$') throw new Error('UNREVIEWED_CROSS_LANGUAGE_PATTERN:' + child);
      return [key, '^[a-f0-9]{64}$(?![\\s\\S])'];
    }
    return [key, portablePatterns(child)];
  }));
}
export function exportDomainSchemas() {
  return Object.fromEntries(Object.entries({ ...domainSchemas, envelope: domainEnvelopeSchema }).map(([kind, schema]) =>
    [kind, portablePatterns(z.toJSONSchema(schema, { target: 'draft-07', io: 'input', unrepresentable: 'throw' }))]));
}
export async function writeOrVerifyDomainSchemas(check = false) {
  const output = path.resolve('packages/contracts/domain-v1/generated.schemas.json');
  const text = JSON.stringify({ version: 'existing-domain-shared-validation-v1', dialect: 'draft-07',
    source: 'existing TS/Zod domain codecs; not the five proposed envelopes', schemas: exportDomainSchemas() }, null, 2) + '\n';
  if (check) { if (await readFile(output, 'utf8') !== text) throw new Error('GENERATED_DOMAIN_SCHEMAS_STALE'); }
  else { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, text); }
  return output;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(await writeOrVerifyDomainSchemas(process.argv.includes('--check')));
}
