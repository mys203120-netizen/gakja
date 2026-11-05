/** Read-only canonical/bank audit. The context loader is explicitly read-only;
 * no extraction, providers, TTS, or activation. Only the CLI report writes. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compactStudentAnalysisWireSchema, expandCompactStudentAnalysis, type FullRecordSource, type FullStudentAnalysis, type TargetStudentAnalysis } from '../server/data/full-student-analysis';
import { loadInterviewContextAt, type InterviewContext, type StudentEvidence } from '../server/data/load-interview-context';
import { createSessionQuestionPlan, loadQuestionBank, selectNextPreparedMainQuestion, type PreparedQuestionBank } from '../server/data/prepared-question-bank';
import { questionHistoryEligibility, rankQuestionSlots, selectionEligibility, slotSemanticKey, type QuestionSelectionScope } from '../server/question-selection';
import type { InterviewSession, RecordedTurn } from '../server/protocol';
import { findVerifiedSourceQuote } from '../server/providers/question-grounding';

/** Explicit historical fixtures only. Active audits never default to these. */
export const HISTORICAL_AUDIT_BANK_PATH = 'data/prepared/question-banks/a2f39d1ff69d7151e4f8ba885f92a68cc034e7e342c39b956d3a0cfff48d4d79.json';
export const HISTORICAL_AUDIT_PROPOSAL_PATH = 'data/prepared/student-analysis-proposals/9fd0dbeb708bf8061149d31be76e147f8df22bfe49f8030e0ab3edd7ae04b7ce-1793688437463.json';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const groups = (values: string[]) => values.reduce<Record<string, number>>((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {});
const factFields = ['recordedContext', 'studentActions', 'teamActions', 'choiceReasons', 'outcomes', 'teacherObservations'] as const;
type AnalysisEnvelope = { common: FullStudentAnalysis; target: TargetStudentAnalysis; evidence: StudentEvidence[] };

/** Diagnose the current transport honestly; accepting a partial decoder result
 * never means the structured action/academic analysis is complete. */
export function inspectCompactTransport(input: unknown) {
  const wire = compactStudentAnalysisWireSchema.parse(input), ids = new Set(wire.quoteDictionary.map(proof => proof.id));
  const expanded = expandCompactStudentAnalysis(wire);
  const fields = Object.fromEntries(factFields.map(field => {
    const supplied = wire.activities.flatMap(activity => activity[field]);
    return [field, { supplied: supplied.length, boundReferences: supplied.filter(id => ids.has(id)).length, unboundValues: supplied.filter(id => !ids.has(id)).length }];
  }));
  const unboundFactValues = wire.activities.reduce((count, activity) => count + factFields.reduce((n, field) => n + activity[field].filter(id => !ids.has(id)).length, 0), 0);
  const idValuedAcademicRows = wire.academicRecords.filter(row => row.recordedValues.some(value => ids.has(value))).length;
  return { status: unboundFactValues || idValuedAcademicRows ? 'PARTIAL_TRANSPORT_CONTRACT' as const : 'SOURCE_BOUND_TRANSPORT_ONLY' as const,
    fields, unboundFactValues, idValuedAcademicRows, rawUnknownCount: wire.activities.reduce((count, activity) => count + activity.unknowns.length, 0),
    expandedUnknownCount: expanded.activities.reduce((count, activity) => count + activity.unknowns.length, 0), expanded,
    semanticCompletenessProven: false as const };
}

/** v2 facts and table values have already been reconstructed by the verified
 * active-analysis loader. Audit those typed values, not an older parent proposal
 * that predates the explicit source-review revision. */
export function inspectTypedCanonicalTransport(common: FullStudentAnalysis) {
  if (common.codecVersion !== 'student-analysis-codec-v2' || common.schemaVersion !== 'full-student-analysis-v2') throw new Error('AUDIT_TYPED_CANONICAL_CODEC_REQUIRED');
  const invalidRows = common.academicRecords.filter(row => !Array.isArray(row.literalValues) || JSON.stringify(row.recordedValues) !== JSON.stringify(row.literalValues.map(cell => cell.value)));
  const fields = Object.fromEntries(factFields.map(field => { const supplied = common.activities.flatMap(activity => activity.facts[field]); return [field, { supplied: supplied.length, boundReferences: supplied.length, unboundValues: 0 }]; }));
  return { status: invalidRows.length ? 'PARTIAL_TRANSPORT_CONTRACT' as const : 'SOURCE_BOUND_TYPED_TRANSPORT_ONLY' as const,
    codecVersion: common.codecVersion, inputBasis: 'activated_typed_canonical_after_verified_source_review' as const, fields,
    unboundFactValues: 0, idValuedAcademicRows: invalidRows.length, rawUnknownCount: common.activities.reduce((count, activity) => count + activity.unknowns.length, 0),
    expandedUnknownCount: common.activities.reduce((count, activity) => count + activity.unknowns.length, 0), semanticCompletenessProven: false as const };
}

/** These histories are in-memory fixtures of legacy/unmarked records, never
 * real interviews. Explicit synthetic flags are tested separately and ignored
 * by the production history selector, as intended. */
export function simulateStoredBankSelection(bank: PreparedQuestionBank, studentId: string, supportTargetId: string, options: { rounds?: number; questionsPerRound?: number } = {}) {
  const context = { target: bank.target, student: { studentId }, school: { interview: { id: supportTargetId } } } as InterviewContext;
  const scope: QuestionSelectionScope = { ownerId: 'phase3-read-only-fixture-owner', studentId, supportTargetId };
  const history: InterviewSession[] = [], uses = new Map<string, number>();
  const rounds = options.rounds ?? 5, questionsPerRound = options.questionsPerRound ?? 3;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 12 || !Number.isInteger(questionsPerRound) || questionsPerRound < 1) throw new Error('AUDIT_SELECTION_SIMULATION_BUDGET_INVALID');
  const approvedSlots = bank.plan.slots.filter(slot => bank.slots.some(row => row.slotId === slot.id && !row.quarantine && row.candidates.length));
  const approvedKeys = new Set(approvedSlots.map(slotSemanticKey));
  const sessions: Array<{ seed: string; selected: string[]; selectedCandidateIds: string[]; selectedActivityIds: string[][]; minimumUseOrderRespected: boolean; currentSessionDuplicates: number; reusedWhileUnseenAvailable: number }> = [];
  const before = JSON.stringify(bank);
  for (let round = 0; round < rounds; round++) {
    const seed = `phase3-fixed-${round + 1}`;
    const plan = createSessionQuestionPlan(context, bank, { sessionSeed: seed, history, scope });
    const repeated = createSessionQuestionPlan(context, bank, { sessionSeed: seed, history, scope });
    if (JSON.stringify(plan) !== JSON.stringify(repeated)) throw new Error('AUDIT_FIXED_SEED_NOT_DETERMINISTIC');
    const rankedUseCounts = plan.slots.map(slot => uses.get(slotSemanticKey(slot)) ?? 0);
    const minimumUseOrderRespected = rankedUseCounts.every((count, index) => index === 0 || rankedUseCounts[index - 1] <= count);
    const session = { id: `phase3-memory-${round + 1}`, createdAt: new Date(Date.UTC(2026, 0, round + 1)).toISOString(), target: bank.target, plan, turns: [], questionPresentations: [], followUpCountByMainQuestion: {}, elapsedMs: 0, metrics: {} } as unknown as InterviewSession;
    const selected: string[] = [], selectedCandidateIds: string[] = [], selectedActivityIds: string[][] = [];
    let reusedWhileUnseenAvailable = 0;
    for (let position = 0; position < Math.min(questionsPerRound, approvedKeys.size); position++) {
      const selection = selectNextPreparedMainQuestion(bank, session);
      if (!selection) throw new Error('AUDIT_APPROVED_POOL_SHORTAGE');
      const key = selection.selectionTrace.semanticKey, id = `${session.id}-q${position + 1}`;
      if ((uses.get(key) ?? 0) > 0 && [...approvedKeys].some(other => !uses.has(other) && !selected.includes(other))) reusedWhileUnseenAvailable++;
      selected.push(key);
      selectedCandidateIds.push(selection.selectionTrace.bankCandidateId); selectedActivityIds.push([...selection.slot.activityIds]);
      const turn = { id, questionText: selection.draft.questionText, questionKind: 'main', parentMainQuestionId: id, mainIndex: position + 1, mainCount: plan.slots.length,
        followUpIndex: 0, evidenceIds: selection.draft.evidenceIds, questionAudioUrl: selection.audioUrl, acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: selection.slot.interviewerId,
        metadata: { ...selection.draft, activityIds: selection.slot.activityIds, selectionTrace: selection.selectionTrace } } as unknown as RecordedTurn;
      session.turns.push(turn);
      session.questionPresentations!.push({ turnId: id, rootTurnId: id, questionKind: 'main', clockId: 'phase3-simulated-clock', startedAtMs: position * 1000 + 100, completedAtMs: position * 1000 + 900 });
      if (selectionEligibility(selection.slot, turn.questionText, { scope }, session.turns).allowed) throw new Error('AUDIT_WITHIN_SESSION_REPEAT_ALLOWED');
    }
    for (const key of selected) uses.set(key, (uses.get(key) ?? 0) + 1);
    sessions.push({ seed, selected, selectedCandidateIds, selectedActivityIds, minimumUseOrderRespected, currentSessionDuplicates: selected.length - new Set(selected).size, reusedWhileUnseenAvailable });
    history.push(session);
  }
  const explicitlySynthetic = structuredClone(history[0]); explicitlySynthetic.metrics = { verification: { syntheticTest: true } };
  const wrongScope = structuredClone(history[0]); wrongScope.plan!.selectionContext!.scope = { ...scope, studentId: 'another-student' };
  const baselineOrder = rankQuestionSlots(approvedSlots, bank.target, { sessionSeed: 'excluded-history', scope });
  const syntheticOrder = rankQuestionSlots(approvedSlots, bank.target, { sessionSeed: 'excluded-history', scope, history: [explicitlySynthetic] });
  if (JSON.stringify(baselineOrder) !== JSON.stringify(syntheticOrder)) throw new Error('AUDIT_SYNTHETIC_HISTORY_WAS_COUNTED');
  if (JSON.stringify(bank) !== before) throw new Error('AUDIT_BANK_MUTATED');
  return { provenance: 'explicitly synthetic local simulation of eligible legacy/unmarked history; never persisted', fixedSeeds: sessions.map(item => item.seed), sessions,
    selections: sessions.reduce((n, item) => n + item.selected.length, 0), uniqueSemanticKeys: uses.size, usageCounts: Object.fromEntries(uses),
    withinSessionDuplicateCount: sessions.reduce((n, item) => n + item.currentSessionDuplicates, 0), crossSessionReuse: sessions.reduce((n, item) => n + item.selected.length, 0) - uses.size,
    reusedWhileUnseenAvailable: sessions.reduce((n, item) => n + item.reusedWhileUnseenAvailable, 0),
    allMinimumUseOrdersRespected: sessions.every(item => item.minimumUseOrderRespected),
    explicitSyntheticEligibility: questionHistoryEligibility(explicitlySynthetic, bank.target, { scope }).reason,
    wrongStudentEligibility: questionHistoryEligibility(wrongScope, bank.target, { scope }).reason,
    crossSessionHardExclusion: false, realHumanSessionsObserved: 0 };
}

export interface BankQualityAuditOptions {
  /** Both paths are required to request a preserved historical comparison. */
  historical?: { bankPath: string; proposalPath: string };
  environment?: NodeJS.ProcessEnv;
}
export async function auditStoredBankQuality(root = process.cwd(), options: BankQualityAuditOptions = {}) {
  const inputHashes: Array<{ path: string; sha256: string }> = [];
  const read = async <T>(file: string): Promise<T> => {
    const full = path.resolve(root, file), relative = path.relative(root, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('AUDIT_INPUT_PATH_ESCAPE');
    const bytes = await readFile(full); inputHashes.push({ path: relative.replaceAll('\\', '/'), sha256: sha(bytes) }); return JSON.parse(bytes.toString('utf8')) as T;
  };
  const analysisPointer = await read<{ path: string }>('data/prepared/student-analysis-current.json');
  const recordPointer = await read<{ path: string }>('data/prepared/full-record-current.json');
  const analysis = await read<AnalysisEnvelope>(analysisPointer.path), record = await read<FullRecordSource>(recordPointer.path);
  const activeContext = options.historical ? null : await loadInterviewContextAt(root, { writeManifest: false });
  if (activeContext && (activeContext.errors.length || activeContext.studentAnalysis?.contentSha256 !== analysis.common.contentSha256 || activeContext.targetAnalysis?.contentSha256 !== analysis.target.contentSha256)) throw new Error('AUDIT_ACTIVE_ANALYSIS_NOT_VERIFIED');
  const activeBank = activeContext ? await loadQuestionBank(activeContext, { root, environment: options.environment }) : null;
  if (!options.historical && !activeBank) throw new Error('AUDIT_ACTIVE_BANK_NOT_READY');
  const bankPath = options.historical?.bankPath ?? `data/prepared/question-banks/${activeBank!.key}.json`;
  const bank = await read<PreparedQuestionBank>(bankPath);
  const proposal = options.historical ? await read<{ output: unknown; identity: string; sourceContentSha256: string }>(options.historical.proposalPath) : null;
  const legacy = await read<{ evidence: StudentEvidence[] }>('data/prepared/student.json');
  const pageTexts = new Map(record.pages.map(page => [page.page, page.text]));
  const bodyHashValid = (value: { contentSha256: string }) => { const { contentSha256, ...body } = value; return sha(JSON.stringify(body)) === contentSha256; };
  const proofs = [...analysis.common.activities.flatMap(activity => Object.values(activity.facts).flat()), ...analysis.common.academicRecords.flatMap(row => row.proofs), ...analysis.common.trajectories.flatMap(row => row.proofs)];
  const proofMismatches = proofs.filter(proof => pageTexts.get(proof.page)?.slice(proof.pageStart, proof.pageEnd) !== proof.quote).length;
  const canonicalEvidenceMismatches = analysis.evidence.filter(source => pageTexts.get(source.page)?.slice(source.sourceRef.startOffset, source.sourceRef.endOffset) !== source.text).length;
  const supplement = legacy.evidence.filter(source => {
    const activity = analysis.common.activities.find(row => row.id === source.activityId && row.mergedFromLegacyIds.includes(source.activityId));
    const declared = activity ? Object.values(activity.facts).flat() : [];
    return declared.length > 0 && source.sourceRef.pdfSha256 === record.pdfSha256 && source.text.length <= 2200
      && pageTexts.get(source.page)?.slice(source.sourceRef.startOffset, source.sourceRef.endOffset) === source.text
      && declared.every(proof => proof.page === source.page && proof.pageStart >= source.sourceRef.startOffset && proof.pageEnd <= source.sourceRef.endOffset && source.text.slice(proof.pageStart - source.sourceRef.startOffset, proof.pageEnd - source.sourceRef.startOffset) === proof.quote);
  });
  const evidence = new Map([...supplement, ...analysis.evidence].map(source => [source.id, source]));
  const candidates = bank.slots.flatMap(slot => slot.candidates), quarantines = bank.slots.flatMap(slot => slot.quarantine ?? []);
  const bankQuoteMismatches = candidates.reduce((count, candidate) => count + candidate.draft.evidenceQuotes.filter(quote => !evidence.has(quote.evidenceId) || !findVerifiedSourceQuote(evidence.get(quote.evidenceId)!.text, quote.quote)).length, 0);
  const questionHashMismatches = candidates.filter(candidate => sha(candidate.draft.questionText) !== candidate.questionSha256).length;
  const legacyTransport = proposal ? inspectCompactTransport(proposal.output) : null;
  const transport = legacyTransport ?? inspectTypedCanonicalTransport(analysis.common);
  const decoderMatchesCanon = legacyTransport ? legacyTransport.expanded.activities.every(row => JSON.stringify(row.unknowns) === JSON.stringify(analysis.common.activities.find(activity => activity.localId === row.localId)?.unknowns))
    && legacyTransport.expanded.academicRecords.every(row => { const canonical = analysis.common.academicRecords.find(record => record.localId === row.localId); return canonical && JSON.stringify([row.recordedValues, row.gradingSystem, row.interpretationLimit]) === JSON.stringify([canonical.recordedValues, canonical.gradingSystem, canonical.interpretationLimit]); }) : Boolean(activeContext?.studentAnalysis?.codecVersion === 'student-analysis-codec-v2');
  const approvedObjectiveCount = bank.slots.filter(row => !row.quarantine && row.candidates.length).length;
  const simulation = simulateStoredBankSelection(bank, analysis.common.studentId, analysis.target.supportTargetId,
    options.historical ? {} : { rounds: 3, questionsPerRound: Math.min(13, approvedObjectiveCount) });
  const unchangedInputs = (await Promise.all(inputHashes.map(async item => sha(await readFile(path.resolve(root, item.path))) === item.sha256))).every(Boolean);
  const technicalChecks = { commonHash: bodyHashValid(analysis.common), targetHash: bodyHashValid(analysis.target), recordHash: bodyHashValid(record), proposalSourceMatches: proposal ? proposal.sourceContentSha256 === record.contentSha256 : analysis.common.sourceContentSha256 === record.contentSha256,
    canonicalSourceMatches: analysis.common.sourceContentSha256 === record.contentSha256, noProofMismatch: proofMismatches === 0, noEvidenceMismatch: canonicalEvidenceMismatches === 0, noBankQuoteMismatch: bankQuoteMismatches === 0,
    noQuestionHashMismatch: questionHashMismatches === 0, decoderMatchesCanon, unchangedInputs, noCurrentSessionDuplicate: simulation.withinSessionDuplicateCount === 0,
    noRepeatBeforeUnseenPurposesExhausted: simulation.reusedWhileUnseenAvailable === 0, minimumUseRanking: simulation.allMinimumUseOrdersRespected };
  const qualityReasons = [
    ...(transport.unboundFactValues ? ['ACTION_FACT_REFERENCE_CONTRACT_INCOMPLETE'] : []),
    ...(transport.idValuedAcademicRows ? ['ACADEMIC_LITERAL_VALUE_CONTRACT_INCOMPLETE'] : []),
    ...(analysis.common.academicRecords.every(row => !row.comparisonEligible) ? ['REAL_ACADEMIC_COMPARISON_NOT_READY'] : []),
    ...(analysis.common.coverage.needsReviewSourceCount ? ['REAL_FULL_RECORD_SEMANTIC_ANALYSIS_PARTIAL'] : []),
    ...(!bank.plan.slots.some(slot => slot.objective?.originKind === 'academic_record' && bank.slots.some(row => row.slotId === slot.id && row.candidates.length)) ? ['NO_APPROVED_ACADEMIC_QUESTION'] : []),
  ];
  const transportSummary = legacyTransport ? (({ expanded: _expanded, ...summary }) => { void _expanded; return summary; })(legacyTransport) : transport;
  return { schemaVersion: 'read-only-bank-quality-audit-v2', observedAt: new Date().toISOString(), inputHashes,
    scope: options.historical ? 'explicit_preserved_historical_bank_and_proposal' : 'active_verified_analysis_and_active_bank_identity', bankPath,
    technicalGate: { status: Object.values(technicalChecks).every(Boolean) ? 'PASS' : 'FAIL', checks: technicalChecks, proofMismatches, canonicalEvidenceMismatches, bankQuoteMismatches, questionHashMismatches },
    realDataQualityGate: { status: qualityReasons.length ? 'FAIL' : 'SOURCE_BOUND_ONLY', reasons: qualityReasons, semanticCompletenessProven: false },
    actualBank: { key: bank.key, contentSha256: bank.contentSha256, slots: bank.slots.length, approved: candidates.length, quarantined: quarantines.length,
      quarantineCodes: groups(quarantines.map(row => row.failureCode)), approvedOrigins: groups(bank.plan.slots.filter(slot => bank.slots.some(row => row.slotId === slot.id && row.candidates.length)).map(slot => slot.objective?.originKind ?? 'unknown')) },
    actualCanon: { activities: analysis.common.activities.length, academicRows: analysis.common.academicRecords.length, trajectories: analysis.common.trajectories.length,
      comparableAcademicRows: analysis.common.academicRecords.filter(row => row.comparisonEligible).length, coverage: analysis.common.coverage, verifiedLegacySupplementCount: supplement.length },
    transport: transportSummary, selectionSimulation: simulation,
    syntheticCapabilityEvidence: 'Not evidence about this real student. Separate tests provide explicit synthetic verified grade/career/gap proposals; they do not prove LLM generation quality.',
    operations: { externalProviderCalls: 0, pdfExtractions: 0, productionWrites: 0, canonicalWrites: 0, bankWrites: 0, pointerWrites: 0 },
    futureFixNotes: ['Use explicit tagged/integer quote references and independently source-bound literal academic values; do not reinterpret narratives as facts with TS heuristics.',
      'A codec/schema change requires an explicit new analysis version/revision; preserve old immutable canonical artifacts and stage activation separately.',
      'Read the current typed canonical and its explicit source-review lineage. Historical parent proposals are diagnostic history, not the active quality verdict.',
      'Generate only source-verified, independently reviewed objectives; preserve old bank artifacts and exclude quarantined candidates.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputArg = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
  const output = path.resolve(process.cwd(), outputArg ?? `artifacts/active-bank-quality-audit-${Date.now()}.json`);
  const relative = path.relative(process.cwd(), output);
  if (!relative.startsWith(`artifacts${path.sep}`) || relative.startsWith('..')) throw new Error('AUDIT_OUTPUT_OUTSIDE_ARTIFACTS');
  import('dotenv').then(dotenv => dotenv.default.config({ path: '.env.local', quiet: true })).then(() => auditStoredBankQuality()).then(async result => {
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ artifact: output, technicalGate: result.technicalGate.status, realDataQualityGate: result.realDataQualityGate.status, ...result.actualBank }));
    if (result.technicalGate.status !== 'PASS' || result.realDataQualityGate.status === 'FAIL') process.exitCode = 1;
  }).catch(error => { console.error(error instanceof Error ? error.message : 'BANK_QUALITY_AUDIT_FAILED'); process.exitCode = 1; });
}
