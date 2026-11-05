import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSemanticIdentityWorkspace, canonicalJson, collectSemanticCandidate, createSemanticIdentity, semanticHash,
  semanticReportSource, semanticRubricSchema, verifySemanticRelease, type SemanticCandidate,
} from './lib/semantic-release-gate';

export const SEMANTIC_RELEASE_HELP = `Offline follow-up semantic release gate (no API calls).
  identity --gold FILE --rubric FILE --model-config FILE --policy FILE [--policy FILE] --out FILE [--fixture]
  collect --identity FILE --report FILE [--report FILE] --out FILE
  review-template --candidate FILE --out FILE
  verify --candidate FILE --reviews FILE --out FILE [--latency FILE] [--require-latency]

All paths must stay inside --root (default current directory). Outputs are new files;
existing files are never overwritten. --fixture marks a dry synthetic identity that
cannot approve a production release. The verifier never runs replay/live scripts.

Model config: {policyMode:'compiled'|'full',core,factReview,surfaceRepair}; each stage
has requestedModel,responseModel,reasoningEffort,maxOutputTokens (no API keys).
Rubric: {schemaVersion:1,version,requiredCoverage,acceptedReviewProvenance:['human'],
cases:[{caseId,repeats:1,required:true,coverage,expectedActions,expectedCoverage?,expectedResponse?,followUpScope?}]}.
Question/repaired scope requires an explicit review of the final outcome hash.
Templates stay unresolved/unreviewed and cannot grant approval.

Existing replay runners accept --semantic-identity=FILE to bind newly requested
offline runs. Old unbound or candidate-only reports are collectable diagnostics,
not evidence of final speech approval. Full-runtime cases, repair cases and NDJSON
turn_ready reports are adapted; semantic-release-report-v1 supports dry fixtures.
Exit: 0 semantic pass (or full pass with --require-latency), 1 fail/error, 2 incomplete.
Missing latency always leaves releaseStatus=incomplete even when semanticStatus=pass.`;

function localPath(root: string, file: string) {
  const absolute = path.resolve(root, file), relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SEMANTIC_CLI_PATH_OUTSIDE_ROOT');
  return { absolute, relative: relative.replace(/\\/gu, '/') };
}
async function jsonFile(root: string, file: string) { const resolved = localPath(root, file), bytes = await readFile(resolved.absolute); return { ...resolved, sha256: semanticHash(bytes), value: JSON.parse(bytes.toString('utf8')), bytes }; }
async function newJson(root: string, file: string, value: unknown) {
  const resolved = localPath(root, file); await mkdir(path.dirname(resolved.absolute), { recursive: true });
  await writeFile(resolved.absolute, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return resolved.relative;
}
function parseOptions(args: string[]) {
  const options = new Map<string, string[]>(), flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const current = args[index]; if (!current.startsWith('--')) throw new Error('SEMANTIC_CLI_OPTION_INVALID');
    const equal = current.indexOf('='), key = equal < 0 ? current.slice(2) : current.slice(2, equal);
    if (['fixture', 'require-latency', 'help'].includes(key)) { if (equal >= 0) throw new Error('SEMANTIC_CLI_FLAG_VALUE'); flags.add(key); continue; }
    const value = equal < 0 ? args[++index] : current.slice(equal + 1);
    if (!value || value.startsWith('--')) throw new Error('SEMANTIC_CLI_OPTION_VALUE_MISSING');
    options.set(key, [...(options.get(key) ?? []), value]);
  }
  return { options, flags };
}
export async function verifySemanticReleaseCli(args: string[], defaultRoot = process.cwd()): Promise<{ exitCode: number; output: string }> {
  if (!args.length || args[0] === '--help' || args[0] === 'help') return { exitCode: 0, output: SEMANTIC_RELEASE_HELP };
  const command = args[0], { options, flags } = parseOptions(args.slice(1));
  if (flags.has('help')) return { exitCode: 0, output: SEMANTIC_RELEASE_HELP };
  const allowed: Record<string, string[]> = {
    identity: ['root', 'gold', 'rubric', 'model-config', 'policy', 'out'], collect: ['root', 'identity', 'report', 'out'],
    'review-template': ['root', 'candidate', 'out'], verify: ['root', 'candidate', 'reviews', 'latency', 'out'],
  };
  if (!allowed[command]) throw new Error('SEMANTIC_CLI_COMMAND_UNKNOWN');
  for (const key of options.keys()) if (!allowed[command].includes(key)) throw new Error('SEMANTIC_CLI_OPTION_UNKNOWN:' + key);
  for (const flag of flags) if (flag === 'fixture' && command !== 'identity' || flag === 'require-latency' && command !== 'verify') throw new Error('SEMANTIC_CLI_FLAG_NOT_APPLICABLE');
  const one = (key: string, required = true) => {
    const values = options.get(key) ?? []; if (values.length > 1 || required && values.length !== 1) throw new Error('SEMANTIC_CLI_SINGLE_VALUE_REQUIRED:' + key); return values[0];
  };
  const root = path.resolve(defaultRoot, one('root', false) ?? '.'), output = one('out');
  if (command === 'identity') {
    const policies = options.get('policy') ?? []; if (!policies.length) throw new Error('SEMANTIC_POLICY_ARTIFACT_REQUIRED');
    const identity = await createSemanticIdentity(root, { gold: one('gold'), rubric: one('rubric'), modelConfig: one('model-config'), policies, purpose: flags.has('fixture') ? 'fixture' : 'release' });
    return { exitCode: 0, output: JSON.stringify({ path: await newJson(root, output, identity), releaseKey: identity.releaseKey, purpose: identity.purpose }) };
  }
  if (command === 'collect') {
    const identity = await assertSemanticIdentityWorkspace(root, (await jsonFile(root, one('identity'))).value), inputs = options.get('report') ?? [];
    if (!inputs.length) throw new Error('SEMANTIC_REPORT_REQUIRED');
    const reports = await Promise.all(inputs.map(async file => { const parsed = await jsonFile(root, file); return semanticReportSource(parsed.relative, parsed.bytes); }));
    const rubric = semanticRubricSchema.parse((await jsonFile(root, identity.rubric.path)).value), candidate = collectSemanticCandidate(identity, rubric, reports);
    return { exitCode: 0, output: JSON.stringify({ path: await newJson(root, output, candidate), releaseKey: identity.releaseKey, outcomes: candidate.outcomes.length, diagnostics: candidate.diagnostics }) };
  }
  const candidate = (await jsonFile(root, one('candidate'))).value as SemanticCandidate;
  await assertSemanticIdentityWorkspace(root, candidate.identity);
  if (command === 'review-template') {
    const reviewedAt = new Date().toISOString();
    const template = { schemaVersion: 1, reviews: candidate.outcomes.map(outcome => ({
      releaseKey: candidate.identity.releaseKey, outcomeSha256: outcome.outcomeSha256, rubricSha256: candidate.identity.rubric.sha256,
      provenance: 'unreviewed', reviewer: 'UNREVIEWED_TEMPLATE', reviewedAt,
      checks: { demandRelation: 'unresolved', answeredScopePreserved: 'unresolved', usefulSingleSubpoint: 'unresolved', refusalNegationCorrectionPreserved: 'unresolved', repairedMeaningPreserved: 'unresolved', historyConsistency: 'unresolved' },
      note: 'Unreviewed scaffold. Read the exact final question and bound history in the original report before reviewing. Do not infer meaning from labels alone.',
    })) };
    return { exitCode: 0, output: JSON.stringify({ path: await newJson(root, output, template), status: 'unreviewed', outcomes: template.reviews.length }) };
  }
  const reviewFile = await jsonFile(root, one('reviews')), latencyFile = one('latency', false), latency = latencyFile ? (await jsonFile(root, latencyFile)).value : undefined;
  // Recheck every report's bytes, not only the hashes copied into the candidate.
  const sourceReports = await Promise.all(candidate.reports.map(async report => {
    const actual = await jsonFile(root, report.path); if (actual.sha256 !== report.sha256) throw new Error('SEMANTIC_COLLECTED_REPORT_CHANGED');
    return semanticReportSource(actual.relative, actual.bytes);
  }));
  let latencyEvidence: { before: unknown; after: unknown } | undefined;
  const evidence = latency && typeof latency === 'object' ? (latency as Record<string, any>).evidence : null;
  if (evidence?.before?.path && evidence?.after?.path) {
    const before = await jsonFile(root, evidence.before.path), after = await jsonFile(root, evidence.after.path);
    if (before.sha256 !== evidence.before.sha256 || after.sha256 !== evidence.after.sha256) throw new Error('SEMANTIC_LATENCY_REPORT_BYTES_CHANGED');
    latencyEvidence = { before: before.value, after: after.value };
  }
  const receipt = verifySemanticRelease(candidate, reviewFile.value, { sourceReports, latencyReceipt: latency, latencyEvidence });
  const status = flags.has('require-latency') ? receipt.releaseStatus : receipt.semanticStatus;
  const file = await newJson(root, output, receipt);
  return { exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : 2, output: canonicalJson({ path: file, semanticStatus: receipt.semanticStatus, latencyStatus: receipt.latencyStatus, releaseStatus: receipt.releaseStatus, receiptSha256: receipt.receiptSha256, diagnostics: receipt.diagnostics }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  verifySemanticReleaseCli(process.argv.slice(2)).then(result => { process.stdout.write(result.output + '\n'); process.exitCode = result.exitCode; }).catch(error => { process.stderr.write((error instanceof Error ? error.message : 'SEMANTIC_GATE_FAILED') + '\n'); process.exitCode = 1; });
