import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { authenticatedEvaluationCommandSchema } from '../server/evaluation-writer/service-evaluation';
import { sessionEvaluationHandoffPayloadSchema } from '../server/evaluation-writer/e-handoff-codec';
import { evaluationReviewTrustSchema } from '../server/evaluation-writer/review-trust';

const file = 'packages/contracts/evaluation-auth-v1/generated.schemas.json';
const schemas = Object.fromEntries(Object.entries({ command: authenticatedEvaluationCommandSchema,
  handoffPayload: sessionEvaluationHandoffPayloadSchema, reviewTrust: evaluationReviewTrustSchema })
  .map(([kind, schema]) => [kind, z.toJSONSchema(schema, { target: 'draft-07', io: 'input', unrepresentable: 'throw' })]));
const text = JSON.stringify({ version: 'authenticated-evaluation-shared-projection-v1', dialect: 'draft-07',
  authority: 'Structural F transport only. Original TS review/engine codecs, exact raw bytes, signatures, current authority and SQL generations remain authoritative. Not full Draft2020-12 support.', schemas }, null, 2) + '\n';
if (process.argv.includes('--check')) { if (await readFile(file, 'utf8') !== text) throw new Error('AUTHENTICATED_EVALUATION_SCHEMA_STALE'); }
else { await mkdir('packages/contracts/evaluation-auth-v1', { recursive: true }); await writeFile(file, text); }
console.log(file);
