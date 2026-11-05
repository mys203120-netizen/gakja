import { createHash } from 'node:crypto';
import type { InterviewContext, StudentEvidence } from './data/load-interview-context';
import type { PreparedActivities, ActivityQuote } from './data/prepared-activities';
import type { InterviewSession, QuestionDraft } from './protocol';
import { assertRepairProof, type RepairContract } from './providers/repair-contract';

export const QUESTION_OBJECTIVE_VERSION = 'question-objective-v2';
type PrimaryFunction = QuestionDraft['primaryFunction'];
export type ConfirmationStatus = 'confirmed_from_record' | 'confirmed_by_student' | 'needs_confirmation' | 'student_says_different' | 'cannot_confirm';
export interface ObjectiveEvidenceRef {
  kind: 'RECORD' | 'STUDENT_CONFIRMED' | 'ANSWER_TURN';
  sourceId: string; revision: string; start: number; end: number;
  confirmationStatus: ConfirmationStatus;
  claimStatus: 'record_fact' | 'student_confirmed' | 'student_claim_unverified' | 'conflict_needs_review';
}
export interface StudentObjectiveCandidate {
  id: string; evidenceIds: string[]; activityIds: string[];
  primaryFunction: PrimaryFunction; depth: QuestionDraft['depth'];
  questionIntent: string; targetEvidence: string[]; targetDescription: string;
  anchorRefs: ObjectiveEvidenceRef[]; anchorQuote: string;
  scope: 'record_based' | 'record_grounded_extension' | 'common_approved' | 'admission_grounded';
  requiresOpenCheck: boolean;
  selectionBasis: string;
  semanticKey?: string;
  originKind?: 'activity' | 'academic_record' | 'trajectory' | 'record_gap' | 'common_approved';
  originEntityId?: string;
  grounding?: QuestionBlueprint['grounding'];
  knownFacts?: string[];
  unknowns?: string[];
  forbiddenPremises?: string[];
  analysisRevision?: string;
  supportTargetId?: string;
  priority?: 'S' | 'A' | 'B' | 'C' | 'F';
  priorityReason?: string;
  sourcingStatus?: 'verified_span' | 'verified_span_in_partially_structured_source';
  moduleApproval?: { moduleVersion: string; questionGuidelinesSha256: string; supportTargetId: string; authority: 'explicit_user_approved_local_registry'; sourceClauses: string[] };
}
export interface StudentTrajectoryLink {
  id: string; fromEvidenceId: string; toEvidenceId: string;
  fromGrade: number; toGrade: number; sharedTerm: string;
  status: 'possible_connection_not_causal_fact';
  anchorRefs: ObjectiveEvidenceRef[];
  rationale?: string;
  relationship?: string;
}
export interface QuestionBlueprint {
  version: typeof QUESTION_OBJECTIVE_VERSION; id: string; questionId: string; clusterId: string;
  clusterObjective: { id: string; description: string };
  parentQuestionId: string | null; answerTurnId: string | null;
  questionIntent: string;
  grounding: { kind: 'STUDENT_EVIDENCE' } | { kind: 'COMMON_APPROVED'; moduleId: string; approvalRevision: string; supportTargetId: string } | { kind: 'ADMISSION_VERIFIED'; sourceIds: string[] };
  anchorRefs: ObjectiveEvidenceRef[];
  target: { id: string; description: string; unresolvedReason: string };
  primaryFunction: PrimaryFunction; depth: QuestionDraft['depth']; expectedEvidence: string[];
  expansionRationale: string | null; subordinationRationale: string | null;
  criterionLinks: Array<{ kind: 'admission_criterion' | 'department_talent' | 'university_talent'; sourceIds: string[]; rationale: string }>;
  strategyIds: string[];
}
export interface ApprovedQuestionContract {
  version: 'approved-question-contract-v1'; blueprint: QuestionBlueprint;
  blueprintSha256: string; finalUtteranceSha256: string; semanticContractSha256: string; reviewTraceSha256: string;
  validation: { method: 'independent_semantic_review' | 'independent_fact_review' | 'approved_ir_source_and_surface' | 'approved_restatement'; independentSemanticReview: boolean; independentPremiseReview?: boolean; semanticAuthority?: 'single_core'; residualSemanticRisk: boolean };
  policyDigest: string | null; strategyCatalogDigest: string | null;
  contentSha256: string;
}
type DraftWithContract = QuestionDraft & { questionBlueprint?: QuestionBlueprint; approvedQuestion?: ApprovedQuestionContract };
type BlueprintOptions = {
  questionId?: string; objectiveCandidate?: StudentObjectiveCandidate; strategyIds?: string[];
  targetDescription?: string; expansionRationale?: string | null; subordinationRationale?: string | null;
  answerRefs?: Array<{ turnId: string; answerId: string; start: number; end: number }>;
  grounding?: QuestionBlueprint['grounding'];
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const compact = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function recordRef(source: StudentEvidence, start: number, end: number): ObjectiveEvidenceRef {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.text.length) throw new Error('OBJECTIVE_SOURCE_RANGE_INVALID');
  return { kind: 'RECORD', sourceId: source.id, revision: source.sourceRef.pdfSha256, start, end, confirmationStatus: 'confirmed_from_record', claimStatus: 'record_fact' };
}
function sourceAnchor(source: StudentEvidence, quote?: ActivityQuote) {
  if (quote && (quote.sourceId !== source.id || source.text.slice(quote.excerptStartOffset, quote.excerptEndOffset) !== quote.quote)) throw new Error('OBJECTIVE_ACTIVITY_QUOTE_INVALID');
  if (quote) return { text: quote.quote, ref: recordRef(source, quote.excerptStartOffset, quote.excerptEndOffset) };
  const text = source.text.trim().split(/(?<=[.!?。])\s/u)[0];
  const start = source.text.indexOf(text);
  return { text, ref: recordRef(source, start, start + text.length) };
}
const objectiveDefinitions: Record<Exclude<PrimaryFunction, 'CLARIFY_CONTENT' | 'VERIFY_CLAIM'>, { intent: string; target: string; depth: QuestionDraft['depth']; open: boolean; extension?: boolean }> = {
  FACT: { intent: '기록된 활동에서 실제로 다룬 내용을 확인한다.', target: '활동에서 실제 다룬 핵심 내용 한 가지', depth: 'D1', open: false },
  MOTIVE: { intent: '기록된 활동에 관심이나 참여 계기가 있었는지 열린 질문으로 확인한다.', target: '관심이나 참여 계기의 존재와 해당 계기', depth: 'D2', open: true },
  ROLE: { intent: '공동 활동을 개인 성과로 단정하지 않고 본인의 실제 행동을 확인한다.', target: '해당 활동에서 본인이 직접 한 행동 한 가지', depth: 'D2', open: true },
  PROCESS: { intent: '기록된 수행에서 실제 거친 방법 한 단계를 확인한다.', target: '실제로 거친 방법 한 단계', depth: 'D2', open: false },
  CHOICE: { intent: '기록된 선택의 판단 기준을 확인한다.', target: '선택에서 우선한 기준 한 가지', depth: 'D2', open: true },
  CONCEPT: { intent: '기록에 실제 등장한 개념을 학생이 어떻게 이해하는지 확인한다.', target: '기록에 등장한 개념의 핵심 의미', depth: 'D1', open: false },
  EVIDENCE: { intent: '기록된 판단이나 결과에 사용한 근거를 확인한다.', target: '판단을 지지하는 근거 한 가지', depth: 'D2', open: false },
  RESULT: { intent: '기록에 명시된 관찰이나 산출물의 내용을 확인한다.', target: '실제로 관찰하거나 도출한 내용 한 가지', depth: 'D1', open: false },
  LIMIT: { intent: '기록된 해석이나 결과를 일반화할 수 있는 범위를 확인한다.', target: '해석의 적용 범위 또는 한계 한 가지', depth: 'D4', open: false, extension: true },
  ALTERNATIVE: { intent: '확인된 수행을 다시 한다는 가정에서 바꿀 한 가지를 확인한다.', target: '다시 수행한다면 바꿀 한 가지', depth: 'D4', open: false, extension: true },
  TRANSFER: { intent: '확인된 개념을 새로운 조건에 적용하는 사고를 확인한다.', target: '명시적으로 제시한 가정에서의 적용 판단 한 가지', depth: 'D3', open: false, extension: true },
  CONNECTION: { intent: '확인된 경험과 학습 사이에 연결이 있었는지 열린 질문으로 확인한다.', target: '경험과 후속 학습의 연결 여부와 연결 지점', depth: 'D3', open: true, extension: true },
  VALUE: { intent: '기록된 공동체 행동에서 무엇을 우선했는지 확인한다.', target: '실제 선택에서 우선한 기준 한 가지', depth: 'D2', open: true },
};

export const COMMON_OBJECTIVE_MODULE_VERSION = 'approved-common-objectives-v1';
/** Explicitly authorized local policy modules. This is neither a university's actual
 * question list nor a claim of independent review of the final generated utterance. */
export function createApprovedCommonObjectives(context: InterviewContext): StudentObjectiveCandidate[] {
  const supportTargetId = context.school.interview?.id;
  const guidelineHash = context.manifest?.files.find(file => file.role === 'questionGuidelines')?.sha256;
  if (!supportTargetId || !guidelineHash || !/^[a-f0-9]{64}$/u.test(guidelineHash) || context.errors?.length || context.manifest.errors?.length || !context.target?.department) return [];
  const definitions = [
    { moduleId: 'common-major-selection-motive', primaryFunction: 'MOTIVE' as const, target: `${context.target.department}를 지원 전공으로 선택하게 된 학생 본인의 계기 한 가지`, required: '지원 전공 선택의 개인적인 계기 한 가지', forbidden: ['학생이 해당 전공 진로를 오래전부터 확정했다고 단정하지 않는다.', '특정 학생부 활동을 지원 계기로 가정하지 않는다.'] },
    { moduleId: 'common-future-study-choice', primaryFunction: 'CHOICE' as const, target: `입학 후 ${context.target.department} 학업에서 우선 배우고 싶은 분야를 고르는 학생 본인의 기준 한 가지`, required: '입학 후 우선 학습 분야를 선택할 때의 본인 기준 한 가지', forbidden: ['학생이 이미 구체적인 학업 계획을 수립했다고 단정하지 않는다.', '검증하지 않은 학과 교육과정·교과목·연구실을 실제 제공 정보로 언급하지 않는다.'] },
  ];
  return definitions.map(definition => {
    const semanticKey = `COMMON:${definition.moduleId}:${supportTargetId}`;
    const approvalRevision = `${COMMON_OBJECTIVE_MODULE_VERSION}:${guidelineHash}:${hash(supportTargetId).slice(0, 16)}`;
    return { id: 'OBJ-' + hash(semanticKey).slice(0, 24), evidenceIds: [], activityIds: [], primaryFunction: definition.primaryFunction, depth: 'D2', questionIntent: definition.target, targetEvidence: [definition.required], targetDescription: definition.target, anchorRefs: [], anchorQuote: '', scope: 'common_approved', requiresOpenCheck: true,
      semanticKey, originKind: 'common_approved', originEntityId: definition.moduleId, supportTargetId, knownFacts: [], unknowns: ['개인 계기·선택 기준은 학생의 실제 답변으로 확인한다.'], forbiddenPremises: definition.forbidden,
      grounding: { kind: 'COMMON_APPROVED', moduleId: definition.moduleId, approvalRevision, supportTargetId },
      moduleApproval: { moduleVersion: COMMON_OBJECTIVE_MODULE_VERSION, questionGuidelinesSha256: guidelineHash, supportTargetId, authority: 'explicit_user_approved_local_registry', sourceClauses: ['제7조④', '제8조②'] },
      selectionBasis: '현재 사용자가 승인한 지원동기·전공 학업 연결 공통 모듈이다. 정책 모듈 승인과 최종 질문 문장의 독립 전제 검수는 구분하며 자기소개·마지막 자유발언을 평가 문항으로 강제하지 않는다.' };
  });
}

/** Local objective candidates are proposals, never inferred student facts or ability scores. */
export function createStudentObjectiveCandidates(context: InterviewContext, activities?: PreparedActivities | null): StudentObjectiveCandidate[] {
  if (context.targetAnalysis) {
    // The full-record analysis already chose specific, source-bound purposes. Do not replace
    // those purposes with the legacy per-function regex templates below.
    for (const objective of context.targetAnalysis.objectives) {
      if (!objective.anchorRefs.length) throw new Error('OBJECTIVE_ANALYSIS_SOURCE_STALE');
      for (const [index, ref] of objective.anchorRefs.entries()) {
        const source = context.student.evidence.find(source => source.id === ref.sourceId);
        // anchorQuote is the primary anchor's text. Other approved source references
        // can support a comparison/connection without repeating that same quotation.
        if (!source || ref.kind !== 'RECORD' || !objective.evidenceIds.includes(ref.sourceId) || ref.revision !== source.sourceRef.pdfSha256 || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > source.text.length || index === 0 && source.text.slice(ref.start, ref.end) !== objective.anchorQuote) throw new Error('OBJECTIVE_ANALYSIS_SOURCE_STALE');
      }
    }
    return [...context.targetAnalysis.objectives.map(saved => {
      const objective = structuredClone(saved);
      const sameEntities = context.student.evidence.filter(source => source.originEntityId === objective.originEntityId || Boolean(source.activityId) && objective.activityIds.includes(source.activityId));
      const anchorSources = objective.evidenceIds.flatMap(id => context.student.evidence.find(source => source.id === id) ?? []);
      // Keep the selected anchor, then exact, explicitly same-entity quoted context.
      // Legacy supplements are reviewed ranges, not an authority for other blocks.
      const related = [...sameEntities.filter(source => source.projectionProvenance), ...sameEntities.filter(source => !source.projectionProvenance)];
      const selected = [...new Map([...anchorSources, ...related].map(source => [source.id, source])).values()].slice(0, 6);
      objective.evidenceIds = selected.map(source => source.id);
      objective.knownFacts = selected.map(source => source.text);
      objective.anchorRefs = selected.map(source => recordRef(source, 0, source.text.length));
      return objective;
    }), ...createApprovedCommonObjectives(context)];
  }
  const sources = context.student?.evidence ?? [];
  const candidates: StudentObjectiveCandidate[] = [];
  for (const source of sources) {
    if (source.confirmationStatus !== 'confirmed_from_record' || !source.text.trim() || !source.sourceRef?.pdfSha256) continue;
    const unit = activities?.units.find(item => item.sourceId === source.id);
    if (unit && (unit.excerpt !== source.text || unit.sourceRef.pdfSha256 !== source.sourceRef.pdfSha256)) throw new Error('OBJECTIVE_ACTIVITY_SOURCE_STALE');
    const text = source.text;
    const completed = /조사|탐구|분석|실험|설계|제작|발표|정리|토론|참여|수행|관찰|비교|읽/u.test(text);
    const collective = Boolean(unit?.facts.teamActions.length) || /공동|협업|협력|모둠|조별|학급|의견|소통|함께|봉사|배려/u.test(text);
    const judgement = Boolean(unit?.facts.outcomes.length) || /판단|결론|해석|근거|결과|도출|관찰|차이/u.test(text);
    const concept = /개념|원리|이론|법칙|반응|기작|구조|모형|모델|화학|수학|과학|DNA|단백질|유전자/u.test(text);
    const funcs: Array<keyof typeof objectiveDefinitions> = ['FACT'];
    if (completed) funcs.push('PROCESS', 'MOTIVE', 'ALTERNATIVE');
    if (collective) funcs.push('ROLE', 'VALUE');
    if (concept) funcs.push('CONCEPT', 'TRANSFER');
    if (Boolean(unit?.facts.choiceReasons.length) || /선택|기준|조건|방법|자료|주제/u.test(text)) funcs.push('CHOICE');
    if (judgement) funcs.push('EVIDENCE', 'LIMIT');
    if (Boolean(unit?.facts.outcomes.length) || /도출|제작|관찰|산출|결과를|결과가/u.test(text)) funcs.push('RESULT');
    if (/진로|전공|관심|학습|교과|연계|연결/u.test(text)) funcs.push('CONNECTION');
    for (const primaryFunction of [...new Set(funcs)]) {
      const definition = objectiveDefinitions[primaryFunction];
      const field = primaryFunction === 'ROLE' || primaryFunction === 'VALUE' ? 'teamActions' : primaryFunction === 'CHOICE' ? 'choiceReasons' : primaryFunction === 'RESULT' || primaryFunction === 'EVIDENCE' || primaryFunction === 'LIMIT' ? 'outcomes' : 'studentActions';
      const quotes = [...(unit?.facts[field] ?? [])];
      if (primaryFunction === 'PROCESS') {
        const actionScore = (fact: ActivityQuote) => Number(/직접|계산|측정|분류|재설정|제작|작성|비교|정리/u.test(fact.quote)) * 8 - Number(/하고자|하려|가설|예정|계획|기획/u.test(fact.quote)) * 10 - fact.quote.length / 500;
        quotes.sort((left, right) => actionScore(right) - actionScore(left));
      }
      const anchor = sourceAnchor(source, quotes[0] ?? unit?.facts.recordedContext[0]);
      const focus = definition.target + '를 선택된 원문 구간의 실제 내용에서 확인한다.';
      candidates.push({ id: 'OBJ-' + hash(source.id + ':' + source.sourceRef.pdfSha256 + ':' + primaryFunction + ':' + anchor.ref.start + ':' + anchor.ref.end).slice(0, 24), evidenceIds: [source.id], activityIds: [source.activityId], primaryFunction, depth: definition.depth, questionIntent: definition.intent, targetEvidence: [definition.target], targetDescription: focus, anchorRefs: [anchor.ref], anchorQuote: anchor.text, scope: definition.extension ? 'record_grounded_extension' : 'record_based', requiresOpenCheck: definition.open, selectionBasis: '확인 대상 후보이며 원문의 사실·학생 역량·필수 출제 순서를 추가하지 않는다.' });
    }
  }
  return [...candidates, ...createApprovedCommonObjectives(context)];
}

/** Shared literal terms propose connections; they never assert causal influence or progress. */
export function buildStudentTrajectory(context: InterviewContext): StudentTrajectoryLink[] {
  if (context.studentAnalysis) return context.studentAnalysis.trajectories.flatMap(link => {
    const from = context.student.evidence.find(source => source.originEntityId === link.fromEntityId), to = context.student.evidence.find(source => source.originEntityId === link.toEntityId);
    if (!from || !to) return [];
    return [{ id: link.id, fromEvidenceId: from.id, toEvidenceId: to.id, fromGrade: from.grade, toGrade: to.grade, sharedTerm: '', relationship: link.relationship, rationale: link.rationale, status: 'possible_connection_not_causal_fact' as const, anchorRefs: [recordRef(from, 0, from.text.length), recordRef(to, 0, to.text.length)] }];
  });
  const sources = context.student?.evidence ?? [];
  const stop = new Set(['자료를', '내용을', '통해서', '활동을', '학생은', '수업에서', '수행하고', '이해하고', '탐구하는', '바탕으로']);
  const tokens = (text: string) => [...new Set(text.match(/[A-Za-z][A-Za-z0-9-]{2,}|[가-힣]{3,12}/gu) ?? [])].filter(word => !stop.has(word));
  const result: StudentTrajectoryLink[] = [];
  for (let left = 0; left < sources.length; left++) for (let right = left + 1; right < sources.length; right++) {
    const a = sources[left], b = sources[right];
    if (a.grade === b.grade || a.confirmationStatus !== 'confirmed_from_record' || b.confirmationStatus !== 'confirmed_from_record') continue;
    const [from, to] = a.grade < b.grade ? [a, b] : [b, a];
    const term = tokens(from.text).find(word => tokens(to.text).includes(word));
    if (!term) continue;
    const fromStart = from.text.indexOf(term), toStart = to.text.indexOf(term);
    result.push({ id: 'TRAJ-' + hash(from.id + ':' + to.id + ':' + term).slice(0, 20), fromEvidenceId: from.id, toEvidenceId: to.id, fromGrade: from.grade, toGrade: to.grade, sharedTerm: term, status: 'possible_connection_not_causal_fact', anchorRefs: [recordRef(from, fromStart, fromStart + term.length), recordRef(to, toStart, toStart + term.length)] });
  }
  return result;
}

function semanticContract(draft: QuestionDraft) {
  return { questionText: draft.questionText, questionKind: draft.questionKind, primaryFunction: draft.primaryFunction, depth: draft.depth, questionIntent: draft.questionIntent, targetEvidence: draft.targetEvidence, evidenceIds: draft.evidenceIds, evidenceQuotes: draft.evidenceQuotes };
}
function rootBlueprint(session: InterviewSession) {
  const current = session.turns.at(-1);
  const root = session.turns.find(turn => turn.id === current?.parentMainQuestionId) ?? current;
  return { current, root, blueprint: (root?.metadata as { questionBlueprint?: QuestionBlueprint } | undefined)?.questionBlueprint };
}
/** All references and IDs are server-owned; model prose cannot provide source offsets. */
export function createQuestionBlueprint(draft: QuestionDraft, context: InterviewContext, session: InterviewSession, options: BlueprintOptions = {}): QuestionBlueprint {
  if (draft.questionKind === 'end' || draft.validationStatus !== 'approved' || draft.validationFailures.length || draft.targetEvidence.length !== 1) throw new Error('OBJECTIVE_QUESTION_INVALID');
  const { current, root, blueprint: original } = rootBlueprint(session);
  const questionId = options.questionId ?? 'QUESTION-' + hash((session.id ?? 'offline') + ':' + draft.questionText).slice(0, 24);
  const clusterId = draft.questionKind === 'main' ? questionId : current?.parentMainQuestionId;
  if (!clusterId || draft.questionKind !== 'main' && !current) throw new Error('OBJECTIVE_CLUSTER_INVALID');
  const refs: ObjectiveEvidenceRef[] = draft.evidenceQuotes.map(citation => {
    const source = context.student.evidence.find(item => item.id === citation.evidenceId);
    if (!source || !draft.evidenceIds.includes(source.id)) throw new Error('OBJECTIVE_SOURCE_UNKNOWN');
    const start = citation.sourceStartOffset ?? source.text.indexOf(citation.quote), end = citation.sourceEndOffset ?? start + citation.quote.length;
    if (source.text.slice(start, end) !== citation.quote) throw new Error('OBJECTIVE_CITATION_INVALID');
    return recordRef(source, start, end);
  });
  const answerBindings = [...(options.answerRefs ?? [])];
  for (const support of draft.premiseValidation?.supportedPremises ?? []) {
    if (support.basis !== 'answer_turn_attributed') continue;
    const answerTurn = session.turns.find(turn => support.sourceId === 'ANSWER_TURN:' + turn.id + ':' + turn.answerId);
    if (!answerTurn?.answerId) throw new Error('OBJECTIVE_ANSWER_REF_INVALID');
    answerBindings.push({ turnId: answerTurn.id, answerId: answerTurn.answerId, start: support.sourceStartOffset, end: support.sourceEndOffset });
  }
  for (const ref of answerBindings) {
    const turn = session.turns.find(item => item.id === ref.turnId);
    if (!turn || turn.transcriptStatus !== 'finalized' || turn.answerId !== ref.answerId || ref.start < 0 || ref.end <= ref.start || ref.end > (turn.rawTranscript?.length ?? 0)) throw new Error('OBJECTIVE_ANSWER_REF_INVALID');
    const sourceId = 'ANSWER_TURN:' + ref.turnId + ':' + ref.answerId;
    if (!refs.some(existing => existing.sourceId === sourceId && existing.start === ref.start && existing.end === ref.end)) refs.push({ kind: 'ANSWER_TURN', sourceId, revision: hash(turn.rawTranscript!), start: ref.start, end: ref.end, confirmationStatus: 'needs_confirmation', claimStatus: 'student_claim_unverified' });
  }
  if (draft.questionKind === 'follow_up' && !refs.some(ref => ref.kind === 'ANSWER_TURN' && ref.sourceId === 'ANSWER_TURN:' + current!.id + ':' + current!.answerId)) throw new Error('OBJECTIVE_ANSWER_SOURCE_MISSING');
  const common = (draft as QuestionDraft & { commonApproval?: { moduleId: string; approvalRevision: string; supportTargetId: string } }).commonApproval;
  const grounding = options.grounding ?? (common ? { ...common, kind: 'COMMON_APPROVED' as const } : { kind: 'STUDENT_EVIDENCE' as const });
  if (grounding.kind === 'STUDENT_EVIDENCE' && !refs.length) throw new Error('OBJECTIVE_SOURCE_MISSING');
  if (grounding.kind === 'COMMON_APPROVED' && (!grounding.moduleId || !grounding.approvalRevision || !grounding.supportTargetId)) throw new Error('OBJECTIVE_COMMON_APPROVAL_MISSING');
  if (grounding.kind === 'ADMISSION_VERIFIED' && (!grounding.sourceIds.length || grounding.sourceIds.some(id => !context.school.sources.some(source => source.id === id)))) throw new Error('OBJECTIVE_ADMISSION_SOURCE_UNKNOWN');
  const description = options.targetDescription ?? draft.targetEvidence[0];
  const clusterObjective = draft.questionKind === 'main' ? { id: options.objectiveCandidate?.id ?? 'TARGET-' + hash(draft.evidenceIds.join(':') + ':' + draft.questionIntent + ':' + draft.targetEvidence.join(':')).slice(0, 24), description: draft.questionIntent } : original?.clusterObjective ?? { id: 'TARGET-' + hash(root!.id + ':' + root!.metadata.questionIntent).slice(0, 24), description: root!.metadata.questionIntent };
  if (draft.questionKind === 'follow_up' && !options.subordinationRationale?.trim()) throw new Error('OBJECTIVE_SUBORDINATION_MISSING');
  const candidate = options.objectiveCandidate;
  // A candidate lists allowed, verified context; the independently reviewed final
  // question cites the subset it actually needs. It must never escape that set.
  if (candidate && (candidate.primaryFunction !== draft.primaryFunction || candidate.depth !== draft.depth || draft.evidenceIds.some(id => !candidate.evidenceIds.includes(id)))) throw new Error('OBJECTIVE_CANDIDATE_MISMATCH');
  const blueprint: QuestionBlueprint = { version: QUESTION_OBJECTIVE_VERSION, id: 'BLUEPRINT-' + hash(questionId + ':' + description).slice(0, 24), questionId, clusterId, clusterObjective, parentQuestionId: draft.questionKind === 'main' ? null : current!.id, answerTurnId: draft.questionKind === 'main' ? null : current!.id, questionIntent: draft.questionIntent, grounding, anchorRefs: refs, target: { id: 'TARGET-' + hash(clusterObjective.id + ':' + draft.primaryFunction + ':' + compact(description)).slice(0, 24), description, unresolvedReason: draft.questionKind === 'main' ? '회차에서 아직 확인하지 않은 검증 대상' : draft.questionKind === 'clarification' ? '원래 요구의 의미를 유지한 재안내' : '실제 답변에서 후속 확인할 한 지점' }, primaryFunction: draft.primaryFunction, depth: draft.depth, expectedEvidence: [...draft.targetEvidence], expansionRationale: options.expansionRationale ?? null, subordinationRationale: options.subordinationRationale ?? null, criterionLinks: (draft.schoolConnections ?? []).map(item => ({ kind: item.kind, sourceIds: [...item.sourceIds], rationale: item.rationale })), strategyIds: [...new Set(options.strategyIds ?? [])] };
  return deepFreeze(blueprint);
}

export function approveQuestionContract(draft: QuestionDraft, blueprint: QuestionBlueprint, options: { policyDigest?: string; strategyCatalogDigest?: string; repairContract?: RepairContract } = {}): ApprovedQuestionContract {
  assertRepairProof(draft, options.repairContract);
  const review = draft.premiseValidation;
  if (!review || !['bounded_semantic_review', 'bounded_fact_review', 'verified_approved_restatement', 'constrained_answer_follow_up', 'approved_strategy_ir'].includes(review.method) || review.status !== 'approved' || review.questionSha256 !== hash(draft.questionText) || review.coreIntentCount !== 1 || blueprint.questionIntent !== draft.questionIntent || blueprint.primaryFunction !== draft.primaryFunction || blueprint.depth !== draft.depth || JSON.stringify(blueprint.expectedEvidence) !== JSON.stringify(draft.targetEvidence)) throw new Error('QUESTION_CONTRACT_REVIEW_INVALID');
  const factOnly = review.method === 'bounded_fact_review';
  if (factOnly && (review.semanticAuthority !== 'single_core' || review.coreIntentCountAuthority !== 'single_core_single_target_contract' || draft.targetEvidence.length !== 1)) throw new Error('QUESTION_CONTRACT_REVIEW_INVALID');
  const independent = review.method === 'bounded_semantic_review';
  const method = factOnly ? 'independent_fact_review' : independent ? 'independent_semantic_review' : review.method === 'verified_approved_restatement' ? 'approved_restatement' : 'approved_ir_source_and_surface';
  // Preserve the exact historical shape for existing Q0 contracts and hashes.
  const validation: ApprovedQuestionContract['validation'] = factOnly
    ? { method, independentSemanticReview: false, independentPremiseReview: true, semanticAuthority: 'single_core', residualSemanticRisk: true }
    : { method, independentSemanticReview: independent, residualSemanticRisk: !independent };
  const body: Omit<ApprovedQuestionContract, 'contentSha256'> = { version: 'approved-question-contract-v1', blueprint: structuredClone(blueprint), blueprintSha256: hash(JSON.stringify(blueprint)), finalUtteranceSha256: hash(draft.questionText), semanticContractSha256: hash(JSON.stringify(semanticContract(draft))), reviewTraceSha256: hash(JSON.stringify(review)), validation, policyDigest: options.policyDigest ?? null, strategyCatalogDigest: options.strategyCatalogDigest ?? null };
  return deepFreeze({ ...body, contentSha256: hash(JSON.stringify(body)) });
}

/** Existing hash preimage and serialization, exposed for lossless codec reads.
 * Full utterance/semantic/review authority still requires the original draft. */
export function assertApprovedQuestionContractHashes(contract: ApprovedQuestionContract): void {
  const { contentSha256, ...body } = contract;
  if (contract.version !== 'approved-question-contract-v1' || contentSha256 !== hash(JSON.stringify(body)) || contract.blueprintSha256 !== hash(JSON.stringify(contract.blueprint))) throw new Error('QUESTION_CONTRACT_MUTATED');
}
export function assertQuestionContractIntegrity(draft: QuestionDraft, contract: ApprovedQuestionContract): void {
  assertRepairProof(draft);
  if (draft.questionBlueprint && hash(JSON.stringify(draft.questionBlueprint)) !== contract.blueprintSha256) throw new Error('QUESTION_CONTRACT_MUTATED');
  assertApprovedQuestionContractHashes(contract);
  if (contract.finalUtteranceSha256 !== hash(draft.questionText) || contract.semanticContractSha256 !== hash(JSON.stringify(semanticContract(draft))) || contract.reviewTraceSha256 !== hash(JSON.stringify(draft.premiseValidation))) throw new Error('QUESTION_CONTRACT_MUTATED');
}

/** A bank question receives actual turn/cluster IDs without repeating its unchanged semantic review. */
export function bindQuestionContractToTurn(draft: DraftWithContract, context: InterviewContext, session: InterviewSession, questionId: string, options: BlueprintOptions = {}) {
  if (draft.approvedQuestion) assertQuestionContractIntegrity(draft, draft.approvedQuestion);
  const previous = draft.questionBlueprint ?? draft.approvedQuestion?.blueprint;
  const preservedAnswerRefs = previous?.anchorRefs.filter(ref => ref.kind === 'ANSWER_TURN').map(ref => {
    const turn = session.turns.find(item => ref.sourceId === 'ANSWER_TURN:' + item.id + ':' + item.answerId);
    if (!turn?.answerId || turn.transcriptStatus !== 'finalized' || ref.revision !== hash(turn.rawTranscript ?? '')) throw new Error('OBJECTIVE_ANSWER_REF_STALE');
    return { turnId: turn.id, answerId: turn.answerId, start: ref.start, end: ref.end };
  });
  const blueprint = createQuestionBlueprint(draft, context, session, { grounding: previous?.grounding, strategyIds: previous?.strategyIds, targetDescription: previous?.target.description, expansionRationale: previous?.expansionRationale, subordinationRationale: previous?.subordinationRationale, answerRefs: preservedAnswerRefs, ...options, questionId });
  const approvedQuestion = approveQuestionContract(draft, blueprint, { policyDigest: draft.approvedQuestion?.policyDigest ?? undefined, strategyCatalogDigest: draft.approvedQuestion?.strategyCatalogDigest ?? undefined });
  return { questionBlueprint: blueprint, approvedQuestion };
}
