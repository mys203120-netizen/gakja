/** Read-only preparation plan, not a paid migration command. This entry point
 * never creates/calls a provider or TTS client; mapping review comes first. */
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { loadStagedInterviewContextAt } from '../server/data/staged-interview-context';
import { FULL_ANALYSIS_CURRENT, loadFullRecord } from '../server/data/full-student-analysis';
import { loadQuestionBank, questionBankIdentity } from '../server/data/prepared-question-bank';
import { planDeepBankRebind } from '../server/data/deep-bank-rebind';
import { withReservedBankUpgradeReport } from './prepare-reviewed-bank-upgrade';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export interface DeepBankRebindCheckOptions { root?: string; revisionPath: string; output: string }

export async function checkDeepBankRebind(options: DeepBankRebindCheckOptions) {
  const root = path.resolve(options.root ?? process.cwd());
  return withReservedBankUpgradeReport(root, options.output, async output => {
    const protectedFiles = new Map<string, string>();
    const protect = async (relative: string) => { const bytes = await readFile(path.resolve(root, relative)); protectedFiles.set(relative, sha(bytes)); return bytes; };
    await protect(FULL_ANALYSIS_CURRENT);
    const oldContext = await loadInterviewContextAt(root, { writeManifest: false });
    if (oldContext.errors.length) throw new Error('DEEP_REBIND_CURRENT_CONTEXT_NOT_READY');
    const manifestPath = 'data/prepared/source-manifest.json';
    // Source-manifest writing is disabled; preserve an existing diagnostic file.
    await protect(manifestPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    const donor = await loadQuestionBank(oldContext, { root });
    if (!donor) throw new Error('DEEP_REBIND_APPROVED_DONOR_BANK_REQUIRED');
    const donorPath = `data/prepared/question-banks/${donor.key}.json`, donorBytes = await protect(donorPath);
    const oldAnalysis = oldContext.manifest.files.find(file => file.role === 'fullStudentAnalysis');
    if (!oldAnalysis?.sha256 || sha(await protect(oldAnalysis.path)) !== oldAnalysis.sha256) throw new Error('DEEP_REBIND_DONOR_ANALYSIS_PIN_CHANGED');
    const { context: stagedContext, staged } = await loadStagedInterviewContextAt(root, options.revisionPath, { writeManifest: false });
    const stagedBytes = await readFile(path.resolve(root, staged.revisionPath));
    const source = await loadFullRecord(root, oldContext.student.pdfSha256);
    if (!source) throw new Error('DEEP_REBIND_FULL_RECORD_REQUIRED');
    const identity = questionBankIdentity(stagedContext);
    const mapping = await planDeepBankRebind({ oldContext, stagedContext, bank: donor, stagedPlan: identity.plan, stagedVoices: identity.voices, source }, root);
    const oldIds = new Set(donor.plan.slots.map(slot => slot.objective?.id));
    const fresh = staged.target.objectives.filter(objective => !oldIds.has(objective.id));
    const report = { ...mapping, createdAt: new Date().toISOString(), donorBankPath: donorPath, donorBankFileSha256: sha(donorBytes),
      donorAnalysisPath: oldAnalysis.path, donorAnalysisFileSha256: oldAnalysis.sha256,
      stagedRevisionPath: staged.revisionPath, stagedRevisionFileSha256: sha(stagedBytes), stagedAnalysisQAManifestSha256: staged.manifest.contentSha256,
      proposedBankKey: identity.key, protectedOriginalFiles: [...protectedFiles].map(([file, sha256]) => ({ file, sha256 })),
      stagedNewObjectiveInventory: fresh.map(objective => ({ id: objective.id, semanticKey: objective.semanticKey ?? null, originKind: objective.originKind ?? null,
        questionIntent: objective.questionIntent, targetEvidence: objective.targetEvidence, primaryFunction: objective.primaryFunction, depth: objective.depth,
        unknowns: objective.unknowns ?? [], forbiddenPremises: objective.forbiddenPremises ?? [], evidenceIds: objective.evidenceIds })),
      nextNewQuestionBatch: { plannedMaximum: 6, selectedIds: [] as string[], automaticSelection: false,
        instruction: 'After exact mapping and source review, explicitly select supported academic/trajectory/record-gap objectives. Generate and independently review through the existing production preparation path; never fill six by inventing material. New questions require their own separate call cap, audio and recovery readiness.' },
      protectedOriginalFilesUnchanged: false };
    for (const [relative, expected] of protectedFiles) if (sha(await readFile(path.resolve(root, relative))) !== expected) throw new Error('DEEP_REBIND_ORIGINAL_FILE_CHANGED_DURING_CHECK');
    report.protectedOriginalFilesUnchanged = true;
    await output.write(report);
    return report;
  }, { version: 'deep-bank-rebind-check-reservation-v1', externalProviderCalls: 0, ttsCalls: 0, activated: false });
}

export async function prepareDeepBankRebindCli(args: string[], root = process.cwd()) {
  if (args.includes('--run-live')) {
    const { parseDeepRebindExecutionArgs, runDeepBankRebind } = await import('./run-deep-bank-rebind');
    const options = parseDeepRebindExecutionArgs(args);
    dotenv.config({ path: path.resolve(root, '.env.local'), quiet: true });
    return runDeepBankRebind({ ...options, root });
  }
  const arg = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (args.filter(value => value === '--check').length !== 1 || args.some(value => value !== '--check' && !value.startsWith('--revision=') && !value.startsWith('--output=')) ||
    args.filter(value => value.startsWith('--revision=')).length !== 1 || args.filter(value => value.startsWith('--output=')).length !== 1 || !arg('revision') || !arg('output')) throw new Error('DEEP_REBIND_CHECK_REVISION_AND_NEW_OUTPUT_ONLY');
  dotenv.config({ path: path.resolve(root, '.env.local'), quiet: true });
  return checkDeepBankRebind({ root, revisionPath: arg('revision')!, output: arg('output')! });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) prepareDeepBankRebindCli(process.argv.slice(2)).then(report => {
  console.log(JSON.stringify({ mode: 'mode' in report ? report.mode : report.phase, counts: report.counts, physicalCalls: 'physicalCalls' in report ? report.physicalCalls : { llm: 0, tts: 0 }, activated: false, readyForActivation: 'readyForActivation' in report ? report.readyForActivation : false }));
}).catch(error => {
  console.error(JSON.stringify({ failure: error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'DEEP_REBIND_PREPARATION_FAILED', activated: false }));
  process.exitCode = 1;
});
