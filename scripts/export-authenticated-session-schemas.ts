import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { authenticatedRuntimeProjectionSchema, authenticatedSessionProjectionSchema, authenticatedSessionEnvelopeSchema } from '../server/contracts/authenticated-session-codec';
import { authenticatedSessionCommandSchema } from '../server/session-writer/session-command-codec';

const file = 'packages/contracts/session-auth-v1/generated.schemas.json';
const schemas = Object.fromEntries(Object.entries({ command: authenticatedSessionCommandSchema, envelope: authenticatedSessionEnvelopeSchema, runtimeProjection: authenticatedRuntimeProjectionSchema, sessionProjection: authenticatedSessionProjectionSchema })
  .map(([kind, schema]) => [kind, z.toJSONSchema(schema, { target: 'draft-07', io: 'input', unrepresentable: 'throw' })]));
const text = JSON.stringify({ version: 'authenticated-session-shared-projection-v1', dialect: 'draft-07',
  authority: 'New authenticated session transport/projection only; original TS domain codecs/source QA and raw bytes remain authoritative. Not the proposed five envelopes.', schemas }, null, 2) + '\n';
if (process.argv.includes('--check')) { if (await readFile(file, 'utf8') !== text) throw new Error('AUTHENTICATED_SESSION_SCHEMA_STALE'); }
else { await mkdir('packages/contracts/session-auth-v1', { recursive: true }); await writeFile(file, text); }
console.log(file);
