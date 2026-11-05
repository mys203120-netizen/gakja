/** Bounded, resumable offline full-record extraction. It never activates data. */
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { analysisSourceProjection, loadFullRecord, loadFullStudentAnalysis, loadStagedFullStudentAnalysis, materializeFullStudentAnalysis, saveFullStudentAnalysis } from '../server/data/full-student-analysis';
import { encodePreservedAnalysis, studentDeepBatchSchema, studentDeepSynthesisSchema, verifyDeepBatchQuotes, combineDeepBatches, materializeDeepWire, preservedAcademicRowSignature, deepSynthesisProjection, applyReviewedDeepQuoteCorrections, mergeSourceReviewedAcademicCatalog, type StudentDeepBatch } from '../server/data/student-analysis-batches';
import { normalizeProviderUsage, estimateProviderCost, aggregateProviderCosts } from '../server/observability/provider-cost';

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const EXTRACT_RULES = `학생부 전체 원문을 읽는 오프라인 분석 단계다. 모든 원문 문단·성적 행·학업/진로/공동체/독서/행특 소재를 처리하되 개인정보·행정 정보는 이유를 기록하고 제외한다. 특정 전공과 덜 관련됐다는 이유로 세특·예체능·봉사 내용을 버리지 않는다. 학생 능력·답변 점수·질문 문장·예시 답안은 생성하지 않는다.
활동은 목적·맥락·행동·산출물로 묶는다. 키워드만 같으면 합치지 않는다. seed에 같은 활동/성적 행이 있으면 localId를 그대로 쓰고 새 활동/행만 제공 namespace 접두어를 쓴다. 기존 성적 행의 값·학기·과목·산정체계를 바꾸지 않는다. 학년/학기는 원문의 실제 표 표제·구조로 확인하며 학점·석차등급·원점수·성취도를 혼동하지 않는다. 다른 학년의 과목이나 산정체계를 임의로 같은 척도로 비교하지 않는다. 과목 선택권·진로 변화 원인·과학 명제의 진실을 기록만으로 확정하지 않는다.
quoteDictionary는 실제 연속 원문 인용이다. 공백·줄바꿈 외 글자·기호·수치를 고치지 않는다. 중복되는 짧은 숫자만 인용하지 말고 유일하게 바인딩 가능한 원문 행/표제까지 포함한다. id는 정수이며 facts에는 {kind:proof_ref,quoteId}만 쓴다. 본인 행동·팀 행동·관찰 결과·교사 평가·해석은 구분한다. 개인 귀속 불명이면 teamActions 또는 unknowns이고 임의로 studentActions에 넣지 않는다. 계획·기획·자료 조사와 실제 제작·실험·검증을 구분한다. 요약/해석은 interpretations에만 쓴다.
academicRecords는 행 단위 압축 전송 계약이다. metadataProofRefs는 실제 행/표제 근거이고 각 cells[].value는 실제 문자값, valueSpan.literal과 같아야 한다. valueSpan은 unique_literal+start/end=null을 우선 사용하며 그 인용 안에서 정확히 한번만 나타나야 한다. rowLabel은 과목명, columnLabel은 실제 열 표제다. 인용 ID(Q30 등)를 literal로 쓰지 않는다. 표 구조가 확정되지 않으면 unresolved와 사유를 남기고 해당 source를 needs_review로 둔다. 성적 행은 빠짐없이 구조화하되 해석 원인·선택 동기는 unknown이다.
sourceReviews는 맡은 sourceKey를 정확히 한번씩 모두 나열한다. units에서 각 문단/표/연속 기록의 처리 목록, 근거, 연결 entityLocalIds, 제외/보류 사유를 남긴다. 행정 헤더와 본문이 섞인 블록 전체를 행정 제외하지 않는다. 경계 문맥은 이해에만 사용하며 다른 batch 소유 sourceKey 인용을 생성하지 않는다. 사후 독립 검수 완료라고 주장하지 않는다. 불완전·해석 불가를 analyzed로 덮지 않는다.`;
const SYNTHESIS_RULES = `학생부 원문에서 추출한 typed 사실을 종합하는 오프라인 단계다. 사실을 새로 쓰거나 원문 값을 고치지 않는다. activityGroups는 같은 경험만 묶고 독립된 경험은 분리한다. 모든 추출 activityLocalId를 정확히 한 그룹에 포함한다. seed 기존 활동 ID는 각각 canonicalLocalId로 보존하고 두 seed 활동을 임의로 합치지 않는다. academicGroups는 동일한 실제 표 행의 중복만 묶으며 모든 행을 정확히 한번 포함하고 seed 확정 행은 canonicalLocalId로 보존한다.
wholeRecordAxes 11개를 모두 분석한다: 관심 시작/반복주제/심화확장/교과연결/학년변화/진로변화/탐구방식/공동체행동/강점근거/기록공백/사실확인. 근거가 없으면 없다고 쓰고 unknowns로 남긴다. 진로희망의 약학→에너지→공학 기록 변화와 실제 원인은 구분한다. 성적은 학년·학기·과목·산정체계가 확인된 행만 쓰며 서로 다른 과목/체계를 단순 상승하락으로 확정하지 않는다. 확인 가능한 같은 과목 전후 값, 전공 관련 이수, 미적분 성취와 실제 세특의 차이 등은 사실·해석·미확인 원인을 분리한다.
trajectory는 실제 양쪽 entity와 근거를 연결하는 possible connection이며 인과 사실이 아니다. priorities는 모든 실제 활동에 S/A/B/C/F와 구체 사유를 부여한다. 능력점수가 아니다. 지원 공식 요소명 또는 null만 쓴다. 적절한 대표 활동은 전공·학업·공동체·진로의 실제 근거를 고려하되 없는 균형을 조작하지 않는다.
objectives는 약45~60개 독립된 확인 목적으로 구체화한다. 기본 활동 외 실제 교과·성적 추이/학업 전략·이수 선택 가능성·진로 변화·기록 공백을 충분히 포함하되 소재가 없는 비율을 강제하지 않는다. 한 목적에 핵심 의미 하나만 둔다. 역할만 묻는 목적에 결과·배운점·근거를 숨은 필수조건으로 넣지 않는다. 기존 승인 목적과 실제 확인 요구가 같다면 seed semanticKey를 유지하고 다르면 새 고유 key다. 질문 문장·수치 점수·예시 답안은 생성하지 않는다. anchorProofRef는 제공 dictionary 정수 ID만 사용한다. entityLocalIds는 그룹 canonicalLocalId만 사용한다. 실제로 연결을 경험했는지 불명이면 openCheck이며 연결 없음도 정상 답변이다. 기억하지 못할 미기록 세부나 과목 선택권을 사실로 요구하지 않는다.`;

export async function loadDeepAnalysisPolicies(context: InterviewContext, root: string) {
  const slices = [{ role: 'studentAnalysisGuidelines', start: 1, end: null }, { role: 'operatingGuidelines', start: 1, end: 156 }, { role: 'questionGuidelines', start: 1, end: 210 }, { role: 'evaluationGuidelines', start: 1, end: 150 }];
  return Promise.all(slices.map(async slice => {
    const file = context.manifest.files.find(row => row.role === slice.role);
    if (!file?.sha256) throw new Error('DEEP_POLICY_SOURCE_MISSING');
    const text = await readFile(path.resolve(root, file.path), 'utf8');
    if (sha(text) !== file.sha256) throw new Error('DEEP_POLICY_SOURCE_CHANGED');
    return { ...slice, path: file.path, fullSourceSha256: file.sha256, text: text.split(/\r?\n/u).slice(slice.start - 1, slice.end ?? undefined).join('\n') };
  }));
}
export async function prepareStudentDeepAnalysis(args: string[], root = process.cwd()) {
  const arg = (name: string) => args.find(row => row.startsWith(`--${name}=`))?.slice(name.length + 3);
  const reportPath = path.resolve(root, arg('output') ?? `artifacts/student-deep-analysis-${Date.now()}.json`), relative = path.relative(root, reportPath);
  if (!relative.startsWith(`artifacts${path.sep}`) || relative.startsWith('..')) throw new Error('DEEP_OUTPUT_PATH_INVALID');
  await mkdir(path.dirname(reportPath), { recursive: true });
  const reportHandle = await open(reportPath, 'wx', 0o600);
  const report: Record<string, unknown> = { schemaVersion: 'student-deep-analysis-run-v1', createdAt: new Date().toISOString(), activated: false, pointerWrites: 0, bankWrites: 0, externalProviderCalls: 0, failure: null };
  const calls: Array<{ phase: string; path: string; usage: ReturnType<typeof normalizeProviderUsage>; cost: ReturnType<typeof estimateProviderCost> }> = [];
  try {
    const context = await loadInterviewContextAt(root, { writeManifest: false });
    if (context.errors.length) throw new Error('DEEP_CONTEXT_NOT_READY');
    const source = await loadFullRecord(root, context.student.pdfSha256), existing = await loadFullStudentAnalysis(context, root);
    if (!source || !existing || source.blocks.length > 80 || source.coverage.pagesRequiringOcrReview.length) throw new Error('DEEP_VERIFIED_SOURCE_REQUIRED');
    const seed = encodePreservedAnalysis(existing.common, source), policies = await loadDeepAnalysisPolicies(context, root);
    const projected = analysisSourceProjection(source, context.target.studentName);
    const model = arg('model') ?? 'gpt-6.1-terra', maxCalls = Number(arg('max-calls') ?? 7);
    if (!Number.isInteger(maxCalls) || maxCalls < 5 || maxCalls > 11) throw new Error('DEEP_CALL_BUDGET_INVALID');
    const jobRelative = arg('resume') ?? `data/prepared/student-analysis-proposals/deep-${Date.now()}`;
    const job = path.resolve(root, jobRelative), jobBase = path.resolve(root, 'data/prepared/student-analysis-proposals');
    if (!path.relative(jobBase, job) || path.relative(jobBase, job).startsWith('..') || path.isAbsolute(path.relative(jobBase, job))) throw new Error('DEEP_CHECKPOINT_PATH_INVALID');
    const base = { version: 'bounded-deep-extraction-v1', model, sourceContentSha256: source.contentSha256, sourcePdfSha256: source.pdfSha256, parentCommonContentSha256: existing.common.contentSha256, parentTargetContentSha256: existing.target.contentSha256, policies: policies.map(({ text, ...item }) => ({ ...item, selectedTextSha256: sha(text) })) };
    const batches = Array.from({length:Math.ceil(source.pageCount/6)},(_,index)=>index*6+1).map((start, index) => ({ phase: `extract-${index + 1}`, namespace: `N${index + 1}-`, start, end: Math.min(start + 5,source.pageCount), blocks: projected.filter(row => row.page >= start && row.page < start + 6) }));
    if(batches.length+1>maxCalls)throw new Error('DEEP_PLANNED_CALLS_EXCEED_BUDGET');
    Object.assign(report, { job: path.relative(root, job), base, plannedCalls: 5, maxCalls, maxSdkRetries: 0, jsonRepairRetries: 0, perCallMaxInputChars:300000, perCallMaxOutputTokens: { extraction: 30000, synthesis: 30000 }, seed: { activities: seed.activities.length, preservedAcademicRows: seed.academicRecords.length, preservedLiterals: seed.academicRecords.reduce((n, row) => n + row.literalValues.length, 0) }, batches: batches.map(({ blocks, ...row }) => ({ ...row, sourceKeys: blocks.map(b => b.sourceKey), sourceChars: blocks.reduce((n, b) => n + b.text.length, 0) })) });
    if (!args.includes('--run-live') && !args.includes('--use-checkpoints')) { report.dryRun = true; return report; }
    await mkdir(job, { recursive: true });
    const metadataFile = path.join(job, 'identity.json');
    try { await writeFile(metadataFile, JSON.stringify(base, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || sha(JSON.parse(await readFile(metadataFile, 'utf8'))) !== sha(base)) throw new Error('DEEP_CHECKPOINT_IDENTITY_CHANGED'); }
    const client = args.includes('--run-live') ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 600_000, maxRetries: 0 }) : null;
    const readReview = async (file: string | undefined) => {
      if (!file) return null;
      const absolute=path.resolve(root,file), rel=path.relative(path.resolve(root,'artifacts'),absolute);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('DEEP_REVIEW_PATH_INVALID');
      const text=await readFile(absolute,'utf8');return { path:path.relative(root,absolute),sha256:sha(text),body:JSON.parse(text) };
    };
    const quoteReview=await readReview(arg('quote-review')), academicCatalog=await readReview(arg('academic-catalog'));
    if(quoteReview)report.sourceQuoteReview={path:quoteReview.path,sha256:quoteReview.sha256};
    if(academicCatalog)report.academicCatalog={path:academicCatalog.path,sha256:academicCatalog.sha256,independentlyApproved:false};
    for(const alias of academicCatalog?.body.modelAliases??[]){
      const file=path.resolve(root,alias.rawResponse.path),relative=path.relative(job,file);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||sha(await readFile(file,'utf8'))!==alias.rawResponse.sha256)throw new Error('DEEP_ACADEMIC_ALIAS_RAW_RESPONSE_MISMATCH');
    }
    const policyText = policies.map(item => `--- ${item.role} ${item.path}:${item.start}-${item.end ?? 'end'} sha256=${item.fullSourceSha256} ---\n${item.text}`).join('\n');
    let attempts = (await readdir(job)).filter(name => name.endsWith('.request.json')).length;
    const phase = async <T>(name: string, schema: z.ZodType<T>, instructions: string, input: unknown, cap: number, validate: (value: T) => void): Promise<T> => {
      const baseInstructions = instructions + '\n최신 MD 정본의 해당 분석 규칙을 적용한다:\n' + policyText;
      // Reuse a completed, source-bound successful batch even when a later run
      // raises the output ceiling. Failed/truncated replies remain immutable.
      const previousNames = (await readdir(job)).filter(file => file.endsWith('.request.json') && (file === `${name}.request.json` || file.startsWith(`${name}-repair-`) || file.startsWith(`${name}-output-`))).sort();
      for (const file of previousNames) {
        const saved = JSON.parse(await readFile(path.join(job,file),'utf8'));
        if (saved.baseSha256 !== sha(base) || saved.requestSha256 !== sha(saved.request)) throw new Error('DEEP_SAVED_REQUEST_HASH_INVALID');
        const supplied = JSON.parse(saved.request.input);
        if (sha(supplied.base) !== sha(base) || sha(supplied.payload) !== sha(input) || saved.request.model !== model || !saved.request.instructions.startsWith(baseInstructions)) continue;
        let raw: { status?: string; output_text?: string; [key: string]: unknown },responseText:string;
        try { responseText=await readFile(path.join(job,file.replace('.request.json','.response.json')),'utf8');raw = JSON.parse(responseText); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('DEEP_PROVIDER_ATTEMPT_WITHOUT_RESPONSE'); throw error; }
        if (raw.status !== 'completed') continue;
        try {
          let suppliedOutput:unknown=JSON.parse(raw.output_text ?? 'null');
          if(quoteReview?.body.phase===name&&quoteReview.body.responseFileSha256===sha(responseText!))suppliedOutput=applyReviewedDeepQuoteCorrections(suppliedOutput,quoteReview.body,source,sha(responseText!),name);
          const value = schema.parse(suppliedOutput); validate(value);
          const usage = normalizeProviderUsage(raw, { requestedModel:model, requestedServiceTier:'default' });
          calls.push({ phase: file.replace('.request.json',''), path: path.relative(root,path.join(job,file.replace('.request.json','.response.json'))), usage, cost:estimateProviderCost(usage) });
          if (!Array.isArray(report.reusedSuccessfulResponses)) report.reusedSuccessfulResponses = [];
          (report.reusedSuccessfulResponses as unknown[]).push({ phase:name, requestSha256:saved.requestSha256, responseSha256:sha(raw), outputSha256:sha(value), providerCalls:0 });
          return value;
        } catch { /* A source/schema failure or empty fallback is never promoted. */ }
      }
      {
        const attemptName = `${name}-output-${cap}`, requestFile = path.join(job, `${attemptName}.request.json`), responseFile = path.join(job, `${attemptName}.response.json`);
        const request = { model, service_tier: 'default' as const, store: false, reasoning: { effort: 'low' as const }, max_output_tokens: cap,
          instructions: baseInstructions, input: JSON.stringify({ base, payload: input }), text: { format: zodTextFormat(schema, 'student_deep_' + name.replaceAll('-', '_')) } };
        if (request.instructions.length + request.input.length > 300_000) throw new Error('DEEP_REQUEST_INPUT_BOUND_EXCEEDED');
        const requestBody = { baseSha256: sha(base), requestSha256: sha(request), request };
        let raw: { status?: string; output_text?: string; [key: string]: unknown };
        try {
          const saved = JSON.parse(await readFile(requestFile, 'utf8'));
          if (saved.baseSha256 !== requestBody.baseSha256 || saved.requestSha256 !== requestBody.requestSha256) throw new Error('DEEP_REQUEST_CHECKPOINT_CHANGED');
          raw = JSON.parse(await readFile(responseFile, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          try { await readFile(requestFile); throw new Error('DEEP_PROVIDER_ATTEMPT_WITHOUT_RESPONSE'); } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
          if (!client) throw new Error('DEEP_REQUIRED_CHECKPOINT_MISSING');
          if (attempts >= maxCalls) throw new Error('DEEP_PROVIDER_CALL_BUDGET_EXHAUSTED');
          attempts++; report.externalProviderCalls = Number(report.externalProviderCalls) + 1;
          await writeFile(requestFile, JSON.stringify(requestBody, null, 2), { flag: 'wx', mode: 0o600 });
          const started = performance.now();
          try { raw = await client.responses.create(request) as unknown as typeof raw; }
          catch (providerError) { await writeFile(responseFile, JSON.stringify({ status: 'provider_error', error: providerError instanceof Error ? providerError.name : 'unknown', wallMs: performance.now() - started }), { flag: 'wx', mode: 0o600 }); throw new Error('DEEP_PROVIDER_ERROR_PRESERVED'); }
          await writeFile(responseFile, JSON.stringify({ ...raw, output_text: raw.output_text ?? null, wallMs: performance.now() - started }, null, 2), { flag: 'wx', mode: 0o600 });
        }
        const usage = normalizeProviderUsage(raw, { requestedModel: model, requestedServiceTier: 'default' });
        calls.push({ phase: attemptName, path: path.relative(root, responseFile), usage, cost: estimateProviderCost(usage) });
        if (raw.status !== 'completed') throw new Error(`DEEP_PROVIDER_OUTPUT_INCOMPLETE:${name}:output_cap_${cap}`);
        const value = schema.parse(JSON.parse(raw.output_text ?? 'null'));
        validate(value); return value;
      }
    };
    const extracted: Array<{ sourceKeys: string[]; namespace: string; output: StudentDeepBatch }> = [];
    for (const batch of batches) {
      const sourceKeys = batch.blocks.map(row => row.sourceKey);
      const payload = { namespace: batch.namespace, sourceBlocks: batch.blocks, adjacentContext: projected.filter(row => row.page === batch.start - 1 || row.page === batch.end + 1).map(row => ({ sourceKey: row.sourceKey, page: row.page, text: row.text.slice(row.page < batch.start ? -450 : 0, row.page < batch.start ? undefined : 450), contextOnlyNotOwned: true })),
        existingActivities: existing.common.activities.map(row => ({ localId: row.localId, title: row.title, grade: row.grade, area: row.area, actualSourceQuotes: Object.values(row.facts).flat().filter(p => p.page >= batch.start && p.page <= batch.end).map(p => p.quote) })),
        preservedAcademicRows: existing.common.academicRecords.filter(row => row.tableStructure?.status === 'resolved').map(row => ({ localId: row.localId, grade: row.grade, semester: row.semester, subject: row.subject, gradingSystem: row.gradingSystem, values: row.recordedValues, sourceQuotes: row.proofs.map(p => p.quote) })),
        outputBounds: { activityMax: 65, academicRowsMax: 90, quoteMax: 300, extractAllActualRowsAndMeaningfulExperiences: true } };
      const output = await phase(batch.phase, studentDeepBatchSchema, EXTRACT_RULES, payload, 30000, value => {
        verifyDeepBatchQuotes(source, value, sourceKeys); combineDeepBatches(seed, [{ sourceKeys, namespace: batch.namespace, output: value }], source, { allowPartialSources: true });
        const contentSources = value.sourceReviews.filter(row => !['identity_excluded','administrative_excluded'].includes(row.status));
        if (contentSources.length && (!value.activities.length && !value.academicRecords.length || contentSources.every(row => row.status === 'needs_review'))) throw new Error('DEEP_BATCH_HAS_NO_FULLY_PROCESSED_CONTENT');
      });
      extracted.push({ sourceKeys, namespace: batch.namespace, output });
    }
    let parts = combineDeepBatches(seed, extracted, source);
    if(academicCatalog){const merged=mergeSourceReviewedAcademicCatalog(parts,academicCatalog.body,source,existing.common.contentSha256);parts=merged.parts;report.academicCatalogAliases=merged.aliases;report.reviewedAcademicRows=merged.verifiedCatalogRows;}
    const partsFile=path.join(job,`combined-common-parts-${sha(parts).slice(0,16)}.json`);
    await writeFile(partsFile, JSON.stringify(parts, null, 2), { flag: 'wx', mode: 0o600 }).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || sha(JSON.parse(await readFile(partsFile, 'utf8'))) !== sha(parts)) throw error; });
    report.combinedPartsPath=path.relative(root,partsFile);
    const checkPreservation = (value: ReturnType<typeof materializeFullStudentAnalysis>) => {
      for (const old of existing.common.academicRecords.filter(row => row.tableStructure?.status === 'resolved')) {
        const retained = value.common.academicRecords.find(row => row.localId === old.localId);
        if (!retained || retained.id !== old.id || preservedAcademicRowSignature(old) !== preservedAcademicRowSignature(retained)) throw new Error('DEEP_EXISTING_ACADEMIC_LITERAL_OR_ID_CHANGED:' + old.localId);
      }
      for (const old of existing.common.activities) for (const field of ['recordedContext','studentActions','teamActions','choiceReasons','outcomes','teacherObservations'] as const) for (const proof of old.facts[field]) {
        const retained = value.common.activities.find(row => row.localId === old.localId);
        if (!retained || retained.id !== old.id || !retained.facts[field].some(p => p.page === proof.page && p.pageStart === proof.pageStart && p.pageEnd === proof.pageEnd && p.quote === proof.quote)) throw new Error('DEEP_EXISTING_ACTIVITY_FACT_OR_ID_CHANGED:' + old.localId);
      }
      for(const old of existing.common.trajectories){const retained=value.common.trajectories.find(row=>row.id===old.id);if(!retained||sha(retained)!==sha(old))throw new Error('DEEP_EXISTING_TRAJECTORY_CHANGED:'+old.id);}
    };
    const synthesis = await phase('synthesis', studentDeepSynthesisSchema, SYNTHESIS_RULES+`\nparts.preservedTrajectories는 이미 원문 좌표와 possible_connection_not_causal_fact로 확인한 관계이므로 변경하지 않는다. trajectories에는 그 외 새 관계만 최대${20-parts.preservedTrajectories.length}개 제안한다. 모든 academicGroups는 제공된 원문 대조${parts.academicRecords.length}행의 canonical localId를 각각 그대로 보존한다. row.literalValues의 column/columnIndex를 읽어 원점수·등급·분포·P·미산출기호를 구분한다.`, { parts: deepSynthesisProjection(parts), supportTarget: { university: context.target.university, department: context.target.department, track: context.target.track, officialCriteria: context.school.officialInterviewCriteria?.elements.map(row => row.name) }, existingObjectives: existing.target.objectives.map(row => ({ id: row.id, entityIds: row.activityIds, target: row.questionIntent, requiredMeaning: row.targetEvidence, primaryFunction: row.primaryFunction, depth: row.depth, semanticKey: row.semanticKey?.split(':').at(-1) ?? row.id })) }, 30000, value => { checkPreservation(materializeFullStudentAnalysis(context, source, materializeDeepWire(parts, value, source), { model,derivationVersion:'full-record-deep-v1' })); });
    const wire = materializeDeepWire(parts, synthesis, source), generatedAt = new Date().toISOString();
    const proposal = { schemaVersion: 'unapproved-full-analysis-proposal-v2', codecVersion: 'student-analysis-codec-v2', model, generatedAt, sourceContentSha256: source.contentSha256, status: 'completed', deepPreparation: base, output: wire, wholeRecordAxes: synthesis.wholeRecordAxes, sourceReviews: parts.sourceReviews };
    const proposalFile = path.join(job, 'deep-proposal.json');
    await writeFile(proposalFile, JSON.stringify(proposal, null, 2), { flag: 'wx', mode: 0o600 });
    const value = materializeFullStudentAnalysis(context, source, wire, { model, generatedAt,derivationVersion:'full-record-deep-v1' });
    checkPreservation(value);
    const staged = await saveFullStudentAnalysis(value, source, root), reloaded = await loadStagedFullStudentAnalysis(context, staged.revisionPath, root);
    Object.assign(report, { staged: true, independentlyApproved: false, revisionPath: staged.revisionPath, manifestPath: staged.manifestPath, proposalPath: path.relative(root, proposalFile), commonContentSha256: reloaded.common.contentSha256, targetContentSha256: reloaded.target.contentSha256, coverage: reloaded.common.coverage, academicRows: reloaded.common.academicRecords.length, literalValues: reloaded.manifest.academicLiteralCount, activities: reloaded.common.activities.length, trajectories: reloaded.common.trajectories.length, objectives: reloaded.target.objectives.length, sourceReviews: parts.sourceReviews, wholeRecordAxes: synthesis.wholeRecordAxes, existing13AcademicRowsPreserved: true, existing18ActivityFactsPreserved: true, independentReviewRequiredBeforeActivation: true });
    return report;
  } catch (error) { report.failure = error instanceof Error ? error.message.slice(0,1200) : 'DEEP_PREPARATION_FAILED'; return report; }
  finally {
    report.calls = calls; report.cost = aggregateProviderCosts(calls.map(row => row.cost));
    if (typeof report.job === 'string') {
      const directory = path.resolve(root,report.job), files = await readdir(directory).catch(() => []);
      const cumulative = [];
      for (const file of files.filter(name => name.endsWith('.response.json')).sort()) {
        const raw = JSON.parse(await readFile(path.join(directory,file),'utf8'));
        const usage = normalizeProviderUsage(raw,{ requestedModel:typeof (report.base as { model?: string } | undefined)?.model === 'string' ? (report.base as { model: string }).model : 'gpt-6.1-terra', requestedServiceTier:'default' });
        cumulative.push({ file:path.relative(root,path.join(directory,file)), status:raw.status ?? null, incompleteDetails:raw.incomplete_details ?? null, usage, cost:estimateProviderCost(usage) });
      }
      const outputTokens = cumulative.reduce((n,row) => n + (row.usage.usage?.output_tokens ?? 0),0), reasoningTokens = cumulative.reduce((n,row) => n + (row.usage.usage?.output_tokens_details?.reasoning_tokens ?? 0),0);
      report.cumulative = { physicalRequests:files.filter(name => name.endsWith('.request.json')).length, responses:cumulative, cost:aggregateProviderCosts(cumulative.map(row => row.cost)), outputTokens, reasoningTokens, reasoningShare:outputTokens ? reasoningTokens/outputTokens : null, incompleteResponses:cumulative.filter(row => row.status === 'incomplete').length, context:'원래 출력 제한 실패·복구 응답까지 모두 포함한 동일 작업의 누적 사용량. 계정 청구서와 별개이며 캐시 TTL이 없으면 비용은 범위/미확정이다.' };
    }
    await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportHandle.sync(); await reportHandle.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  dotenv.config({ path: '.env.local', quiet: true });
  prepareStudentDeepAnalysis(process.argv.slice(2)).then(report => { console.log(JSON.stringify({ report: report.revisionPath ?? null, job: report.job, calls: report.externalProviderCalls, coverage: report.coverage, failure: report.failure, dryRun: report.dryRun, cost: report.cost })); if (report.failure) process.exitCode = 1; }).catch(error => { console.error(error instanceof Error ? error.message : 'DEEP_PREPARATION_FAILED'); process.exitCode = 1; });
}
