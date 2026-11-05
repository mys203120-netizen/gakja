import dotenv from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { loadStagedInterviewContextAt } from '../server/data/staged-interview-context';
import { activateStagedFullStudentAnalysis, type FullAnalysisBankReadiness } from '../server/data/full-student-analysis';
import { createQuestionBankProductionProviders, loadQuestionBank, loadQuestionBankPreparationSummary, prepareQuestionBank, questionBankIdentity } from '../server/data/prepared-question-bank';
import { loadApprovedRecoveryVariants, recoveryVariantIdentity, saveApprovedRecoveryVariants, type ApprovedRecoveryVariantFile } from '../server/data/approved-recovery-variants';
import { prepareRuntimeRecoveryPoolCli, recoveryOriginal } from './prepare-runtime-recovery-pool';
import { createStagedContractRepairProviders } from './repair-staged-question-contracts';
import { preparedActivitiesModel } from '../server/data/prepared-activities';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Offline transaction: stage -> independently approved Q0/audio -> recovery -> activate.
 * Existing revisions, sessions and publication history are never rewritten. */
export async function prepareStudentInterviewRevision(args: string[], root = process.cwd()) {
  if (args.some(arg => !['--run-live', '--check', '--activate', '--precision-recovery'].includes(arg) && !arg.startsWith('--revision=') && !arg.startsWith('--reuse-from-revision=') && !arg.startsWith('--contract-repair=') && !/^--max-new-candidates=\d+$/u.test(arg)) || args.includes('--run-live') === args.includes('--check') || args.includes('--activate') && !args.includes('--run-live')) throw new Error('USE_REVISION_AND_EXACTLY_RUN_LIVE_OR_CHECK');
  const revisionPath = args.find(arg => arg.startsWith('--revision='))?.slice('--revision='.length);
  if (!revisionPath) throw new Error('STAGED_REVISION_REQUIRED');
  dotenv.config({ path: path.resolve(root, '.env.local'), quiet: true });
  const { context, staged } = await loadStagedInterviewContextAt(root, revisionPath);
  const reusePath = args.find(arg => arg.startsWith('--reuse-from-revision='))?.slice('--reuse-from-revision='.length);
  const donorContext = reusePath ? (await loadStagedInterviewContextAt(root, reusePath)).context : undefined;
  const donor = donorContext ? await loadQuestionBank(donorContext, { root }) : null;
  if (reusePath && !donor) throw new Error('VERIFIED_DONOR_BANK_REQUIRED');
  const identity = questionBankIdentity(context);
  const max = args.find(arg => arg.startsWith('--max-new-candidates='))?.split('=')[1];
  let bank = await loadQuestionBank(context, { root });
  if (!bank && args.includes('--run-live')) {
    const repairPath = args.find(arg => arg.startsWith('--contract-repair='))?.slice('--contract-repair='.length);
    const providers = repairPath ? await createStagedContractRepairProviders(repairPath, await createQuestionBankProductionProviders(), root) : undefined;
    bank = await prepareQuestionBank(context, { root, concurrency: 2, providers, reuseFromBankKey: donor?.key, maxNewCandidates: max === undefined ? undefined : Number(max), onProgress: event => console.log(JSON.stringify({ stage: 'staged-bank', ...event })) });
  }
  if (!bank) return { ready: false, activated: false, bankKey: identity.key, summary: await loadQuestionBankPreparationSummary(context, { root }) };
  if (path.resolve(root) !== path.resolve(process.cwd())) throw new Error('RECOVERY_PREPARATION_REQUIRES_WORKSPACE_CWD');
  // Rebind cached independent proofs only when the ordinary materializer accepts
  // the exact new source/intent contract. Changed premises get ordinary preparation.
  if (donor && donorContext && args.includes('--run-live')) for (const candidate of bank.slots.flatMap(slot => slot.candidates)) {
    const original = recoveryOriginal(candidate);
    if ((await loadApprovedRecoveryVariants(context, original, root)).length) continue;
    const prior = donor.slots.flatMap(slot => slot.candidates).find(row => row.draft.questionText === candidate.draft.questionText);
    if (!prior) continue;
    const priorOriginal = recoveryOriginal(prior);
    if (!(await loadApprovedRecoveryVariants(donorContext, priorOriginal, root)).length) continue;
    const variants = JSON.parse(await readFile(path.resolve(root, `data/prepared/recovery-variants/${recoveryVariantIdentity(donorContext, priorOriginal)}.json`), 'utf8')) as ApprovedRecoveryVariantFile;
    try { await saveApprovedRecoveryVariants(context, original, variants.variants, root); }
    catch { /* The new source proof differs: independent preparation remains required. */ }
  }
  const recoveryFile = `artifacts/staged-recovery-${bank.key}-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const { report } = await prepareRuntimeRecoveryPoolCli([args.includes('--run-live') ? '--run-live' : '--check', '--max-candidates=2', `--out=${recoveryFile}`, ...(args.includes('--precision-recovery') ? [`--review-model=${preparedActivitiesModel()}`] : [])], context);
  const missing = [];
  for (const candidate of bank.slots.flatMap(slot => slot.candidates)) {
    if (!(await loadApprovedRecoveryVariants(context, recoveryOriginal(candidate), root)).length) missing.push(candidate.id);
  }
  const verifiedBank = await loadQuestionBank(context, { root });
  if (!verifiedBank || verifiedBank.key !== bank.key || verifiedBank.contentSha256 !== bank.contentSha256 || missing.length || report.coverage.missing.length) return { ready: false, activated: false, bankKey: bank.key, recoveryMissing: missing };
  const manifestPath = `data/prepared/student-analysis-readiness/${staged.common.revision}-${bank.key}.json`;
  const manifest = { schemaVersion: 'student-interview-readiness-v1', bankKey: bank.key, bankContentSha256: bank.contentSha256,
    commonContentSha256: staged.common.contentSha256, targetContentSha256: staged.target.contentSha256,
    analysisQAManifestSha256: staged.manifest.contentSha256, recoveryReport: recoveryFile, recoveryReportSha256: sha(await readFile(path.resolve(root, recoveryFile))),
    coverage: report.coverage, verifiedAt: new Date().toISOString() };
  await mkdir(path.dirname(path.resolve(root, manifestPath)), { recursive: true });
  const temp = `${path.resolve(root, manifestPath)}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temp, path.resolve(root, manifestPath));
  const bankPath = `data/prepared/question-banks/${bank.key}.json`;
  const readiness: FullAnalysisBankReadiness = { bankPath, bankFileSha256: sha(await readFile(path.resolve(root, bankPath))), bankKey: bank.key, bankContentSha256: bank.contentSha256,
    commonContentSha256: staged.common.contentSha256, targetContentSha256: staged.target.contentSha256, evidenceSha256: staged.manifest.evidenceSha256,
    analysisQAManifestSha256: staged.manifest.contentSha256, recovery: { manifestPath, sha256: sha(await readFile(path.resolve(root, manifestPath))), bankKey: bank.key }, verifiedAt: manifest.verifiedAt };
  if (args.includes('--activate')) {
    const before = await loadInterviewContextAt(root);
    await activateStagedFullStudentAnalysis(before, revisionPath, readiness, root);
    const active = await loadInterviewContextAt(root), activeBank = await loadQuestionBank(active, { root });
    if (!activeBank || activeBank.key !== bank.key || activeBank.contentSha256 !== bank.contentSha256) throw new Error('ACTIVATED_CONTEXT_BANK_MISMATCH');
  }
  return { ready: true, activated: args.includes('--activate'), revisionPath: staged.revisionPath, manifestPath, bankKey: bank.key, approved: bank.slots.reduce((n, slot) => n + slot.candidates.length, 0), quarantined: bank.slots.filter(slot => slot.quarantine).length, recovery: report.coverage };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) prepareStudentInterviewRevision(process.argv.slice(2)).then(result => {
  console.log(JSON.stringify(result)); if (!result.ready) process.exitCode = 1;
}).catch(error => { console.error(JSON.stringify({ ready: false, code: error instanceof Error ? error.message : 'STAGED_PREPARATION_FAILED' })); process.exitCode = 1; });
