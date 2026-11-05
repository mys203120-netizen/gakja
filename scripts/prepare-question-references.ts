import dotenv from 'dotenv';
import { loadBookQuestionReferences, prepareBookQuestionReferences } from '../server/data/book-question-reference';

dotenv.config({ path: '.env.local', quiet: true });
if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('사용법: tsx scripts/prepare-question-references.ts [--check]');
const check = process.argv.includes('--check');
const corpus = check ? await loadBookQuestionReferences() : await prepareBookQuestionReferences();
console.log(JSON.stringify({ passed: Boolean(corpus), operation: check ? 'verify-question-only-reference-cache' : 'prepare-question-only-reference-cache', providerCalls: 0, schemaVersion: corpus?.schemaVersion ?? null, digest: corpus?.digest ?? null, sourceHashes: corpus?.sourceHashes ?? [], figuresDirectory: corpus?.figuresDirectory ?? null, counts: corpus?.counts ?? null, interpretation: corpus?.interpretation ?? null }, null, 2));
if (!corpus) process.exitCode = 1;
