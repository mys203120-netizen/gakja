import dotenv from 'dotenv';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { preparedActivitiesModel } from '../server/data/prepared-activities';
import { analysisSourceProjection, studentAnalysisCodecV2Schema, STUDENT_ANALYSIS_CODEC_VERSION, FULL_ANALYSIS_VERSION_V2, fullAnalysisIdentity, FULL_ANALYSIS_RULES_V2, loadFullRecord, loadFullStudentAnalysis, loadStagedFullStudentAnalysis, materializeFullStudentAnalysis, saveFullStudentAnalysis } from '../server/data/full-student-analysis';

dotenv.config({ path: '.env.local', quiet: true });
export async function loadPinnedAnalysisGuidelines(context: InterviewContext, root: string) {
  const entries = await Promise.all(['studentAnalysisGuidelines', 'questionGuidelines'].map(async role => {
    const entry = context.manifest.files.find(file => file.role === role);
    if (!entry?.sha256) throw new Error('FULL_ANALYSIS_POLICY_SOURCE_MISSING');
    const bytes = await readFile(path.resolve(root, entry.path));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('FULL_ANALYSIS_POLICY_SOURCE_CHANGED');
    return { role, path: entry.path, sha256: entry.sha256, text: bytes.toString('utf8') };
  }));
  return entries;
}
export async function prepareStudentAnalysisCli(args: string[], suppliedContext?: InterviewContext, root = process.cwd()) {
  if (args.includes('--deep')) return (await import('./prepare-student-deep-analysis')).prepareStudentDeepAnalysis(args, root);
  const context = suppliedContext ?? await loadInterviewContextAt(root);
  if (context.errors.some(error => !/FULL_ANALYSIS/u.test(error))) throw new Error('학생부·지원처 원천 검증이 필요합니다.');
  const source = await loadFullRecord(root, context.student.pdfSha256);
  if (!source) throw new Error('전 페이지 원문이 없습니다. 먼저 npm run prepare:context를 실행하세요.');
  let existing = null;
  try { existing = await loadFullStudentAnalysis(context, root); } catch { /* A changed revision needs explicit live preparation. */ }
  if (existing?.common.schemaVersion === FULL_ANALYSIS_VERSION_V2 && !args.includes('--force')) return { passed: true, cacheHit: true, providerCalls: 0, analysisStatus: existing.common.coverage.needsReviewSourceCount ? 'partial' : 'source_bound_structure', coverage: existing.common.coverage, studentId: existing.common.studentId, sourcePages: source.pageCount, sourceBlocks: source.blocks.length, activities: existing.common.activities.length, academicRecords: existing.common.academicRecords.length, objectives: existing.target.objectives.length, analysisRevision: existing.common.revision, independentSemanticReview: false };
  if (!args.includes('--run-live') && !args.includes('--use-proposal')) return { passed: false, cacheHit: false, providerCalls: 0, sourcePages: source.pageCount, sourceBlocks: source.blocks.length, codecVersion: STUDENT_ANALYSIS_CODEC_VERSION, currentAnalysisPreserved: true, action: 'npx tsx scripts/prepare-student-analysis.ts --run-live' };
  if (!args.includes('--use-proposal') && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 필요합니다.');
  if (source.blocks.length > 80 || source.pages.reduce((sum, page) => sum + page.text.length, 0) > 120_000) throw new Error('FULL_ANALYSIS_BOUNDED_INPUT_EXCEEDED');
  if (source.coverage.pagesRequiringOcrReview.length) throw new Error('FULL_ANALYSIS_OCR_REVIEW_REQUIRED');
  const policies = await loadPinnedAnalysisGuidelines(context, root);
  const model = preparedActivitiesModel(), started = performance.now();
  // One offline structured call. No real interview, grade evaluation, or voice/capture is created.
  const proposalId = fullAnalysisIdentity(context, source, model), proposalDirectory = path.resolve(root, 'data/prepared/student-analysis-proposals');
  const proposalFile = path.join(proposalDirectory, `${proposalId}-${Date.now()}.json`);
  let response: { output_parsed: unknown; usage?: unknown; output_text?: string; status?: string; incomplete_details?: unknown }, providerCalls = 0, generatedAt = new Date().toISOString();
  if (args.includes('--use-proposal')) {
    const candidates = (await readdir(proposalDirectory)).filter(file => file.startsWith(proposalId + '-') && file.endsWith('.json')).sort();
    const proposal = JSON.parse(await readFile(path.join(proposalDirectory, candidates.at(-1) ?? `${proposalId}.json`), 'utf8'));
    if (proposal.schemaVersion !== 'unapproved-full-analysis-proposal-v2' || proposal.codecVersion !== STUDENT_ANALYSIS_CODEC_VERSION || proposal.identity !== proposalId || proposal.sourceContentSha256 !== source.contentSha256 || proposal.model !== model || proposal.status !== 'completed') throw new Error('FULL_ANALYSIS_PROPOSAL_STALE');
    if (!Number.isFinite(Date.parse(proposal.generatedAt))) throw new Error('FULL_ANALYSIS_PROPOSAL_STALE');
    generatedAt = proposal.generatedAt;
    let proposalOutput = proposal.output;
    if (!proposalOutput && typeof proposal.unapprovedOutputText === 'string') {
      try { proposalOutput = JSON.parse(proposal.unapprovedOutputText); } catch { throw new Error('FULL_ANALYSIS_PROPOSAL_JSON_INVALID'); }
    }
    response = { output_parsed: proposalOutput, usage: proposal.usage, status: proposal.status };
  } else {
  providerCalls++;
  const generated = await new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 300_000, maxRetries: 0 }).responses.create({
    model, store: false, service_tier: 'default', reasoning: { effort: 'low' }, max_output_tokens: 30000,
    instructions: FULL_ANALYSIS_RULES_V2 + '\n아래 고정 원본 정책 전문을 적용한다. MD5는 전체 분석 기준, MD9는 이 단계의 질문 목적·출발점·근거·미확인 전제 분리에 적용한다. 현재 단계는 분석/목적 생성이며 실제 질문/답변 문장은 만들지 않는다.\n' + policies.map(policy => `--- ${policy.role} (${policy.path}, sha256=${policy.sha256}) ---\n${policy.text}`).join('\n') + '\n모든 제공 구간의 실제 내용을 처리한다. 사실 슬롯에는 정수 태그 proof_ref만 사용하고 요약·설명은 interpretations에 저장한다. 성적 셀 literal과 행/열/학년/학기/산정체계 근거를 분리한다. 분석하지 않은 구간이나 미해결 표를 analyzed로 표시하지 않는다. 인용은 간결하되 같은 활동의 개별 행동·선택·성과를 충분히 연결하고, 약20~40개 구체 목적을 준비한다.',
    input: JSON.stringify({ operation: 'full-record-common-and-target-analysis', studentId: source.studentId, recordRevision: source.recordRevision,
      sourceCoordinateContract: 'sourceKey points to a whole source block; quote must be a continuous actual substring, whitespace-only normalization allowed. Quote IDs are positive integers used only in {kind:proof_ref,quoteId}. Academic literal spans use 0-based UTF-16 offsets relative to dictionary quote. Unknown and interpretation are not facts.',
      sourceBlocks: analysisSourceProjection(source, context.target.studentName),
      target: { supportTargetId: context.school.interview?.id, year: context.target.year, university: context.target.university, campus: context.school.department?.campus, department: context.target.department, track: context.target.track,
        officialCriteria: context.school.officialInterviewCriteria?.elements.map(element => ({ name: element.name })), departmentProfile: context.school.departmentProfile?.points ?? [], universityProfile: context.school.universityProfile?.points ?? [] },
      analysisContract: { source: '5. 학생부_분석_기준_v2.2.md', priorityIsPreparationNotAbility: true, fullRecordIsNotEveryExcerptAnActivity: true, noInventedBalance: true, gradeUnknownPreserved: true },
      outputBudget: { activitiesMax: 50, academicRecordsMax: 60, usefulObjectivesTarget: '20-40 distinct specific purposes; no generic function checklist; typed proof dictionary' },
    }), text: { format: zodTextFormat(studentAnalysisCodecV2Schema, 'full_record_student_and_target_analysis_v2') },
  });
  // Preserve provider output before strict decoding. SDK-side schema parsing can throw
  // before exposing a malformed response, losing the only paid proposal trace.
  response = { output_parsed: null, output_text: generated.output_text, usage: generated.usage, status: generated.status, incomplete_details: generated.incomplete_details };
  try { response.output_parsed = JSON.parse(generated.output_text); } catch { /* Raw text is saved below before failing closed. */ }
  await mkdir(path.dirname(proposalFile), { recursive: true });
  await writeFile(proposalFile, JSON.stringify({ schemaVersion: 'unapproved-full-analysis-proposal-v2', codecVersion: STUDENT_ANALYSIS_CODEC_VERSION, identity: proposalId, sourceContentSha256: source.contentSha256, policySources: policies.map(({ role, path, sha256 }) => ({ role, path, sha256 })), model, generatedAt, usage: response.usage, status: response.status, incompleteDetails: response.incomplete_details, unapprovedOutputText: response.output_text ?? null, output: response.output_parsed }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  if (response.status !== 'completed') throw new Error('FULL_ANALYSIS_PROVIDER_INCOMPLETE');
  if (!response.output_parsed) throw new Error('FULL_ANALYSIS_NO_STRUCTURED_OUTPUT');
  const value = materializeFullStudentAnalysis(context, source, response.output_parsed, { model, generatedAt });
  const staged = await saveFullStudentAnalysis(value, source, root);
  const reloaded = await loadStagedFullStudentAnalysis(context, staged.revisionPath, root);
  if (reloaded.common.contentSha256 !== value.common.contentSha256 || reloaded.target.contentSha256 !== value.target.contentSha256) throw new Error('FULL_ANALYSIS_STAGED_BINDING_FAILED');
  return { passed: true, cacheHit: false, actualProviders: providerCalls > 0, providerCalls, staged: true, activated: false, revisionPath: staged.revisionPath, manifestPath: staged.manifestPath, analysisQAManifestSha256: reloaded.manifest.contentSha256, codecVersion: STUDENT_ANALYSIS_CODEC_VERSION, unresolvedAcademicRecords: reloaded.manifest.unresolvedAcademicRecordIds.length, analysisStatus: value.common.coverage.needsReviewSourceCount ? 'partial' : 'source_bound_structure', elapsedScope: providerCalls ? 'provider_and_validation' : 'local_proposal_materialization_and_validation', model, sourcePages: source.pageCount, sourceBlocks: source.blocks.length, coverage: value.common.coverage, activities: value.common.activities.length, academicRecords: value.common.academicRecords.length, trajectories: value.common.trajectories.length, priorities: value.target.activityPriorities.length, objectives: value.target.objectives.length, nonActivityObjectives: value.target.objectives.filter(objective => !objective.activityIds.length).length, questionInputEvidence: reloaded.evidence.length, analysisRevision: value.common.revision, elapsedMs: Math.round(performance.now() - started), usage: response.usage ?? null, independentSemanticReview: false, userInterviewSessionCreated: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) prepareStudentAnalysisCli(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1; }).catch(error => { console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'FULL_STUDENT_ANALYSIS_FAILED' })); process.exitCode = 1; });
