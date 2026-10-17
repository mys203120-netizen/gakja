import type { LearningData, MemoryItem, Question } from './index';

export const FACT_CONFIRMATION_STATUSES = ['confirmed_from_record', 'confirmed_by_student', 'needs_confirmation', 'student_says_different', 'cannot_confirm'] as const;
export type FactConfirmationStatus = typeof FACT_CONFIRMATION_STATUSES[number];
export type QuestionDepth = 'D1' | 'D2' | 'D3' | 'D4';
export type ClaimKind = 'student_record_fact' | 'student_confirmed_experience' | 'interpretation_connection' | 'student_thought_plan' | 'needs_confirmation';
export const SCHOOL_PROFILE_STATUSES = ['official_confirmed', 'historical_reference', 'sampled', 'training_configuration', 'needs_confirmation'] as const;
export type SchoolProfileStatus = typeof SCHOOL_PROFILE_STATUSES[number];
export type QuizCategory = 'factual' | 'experiential' | 'concept';
export type QuizSnapshotItem = MemoryItem & { category: QuizCategory; required_meaning_elements: string[] };
export interface QuizResponse {
  memoryItemId: string; response: string | string[]; rating: 'again' | 'hard' | 'good' | 'easy';
  selectedOptionId?: string; order?: string[]; cannotRecall?: boolean; selfCheckedMeanings?: string[];
}
export interface QuizResult {
  correct: boolean | null; evaluation_method: MemoryItem['evaluation_method']; feedback: string;
  required_meanings: string[]; checked_meanings: string[]; missing_meanings: string[];
  cannot_recall: boolean; retry_due: boolean;
  reviewed_answer?: string;
}

const normalizeAnswer = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('ko-KR').replace(/\s+/g,'');
/** Compare only a reviewed key. No numeric value or tolerance is inferred. */
export function reviewedShortAnswerMatches(item: MemoryItem, response: string): boolean {
  if (item.accepted_answers?.some(answer => normalizeAnswer(answer) === normalizeAnswer(response))) return true;
  const numeric = item.numeric_answer;
  if (!numeric) return false;
  const match = response.normalize('NFKC').trim().match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?)\s*(.*)$/i);
  if (!match) return false;
  const value = Number(match[1].replace(/,/g,'')), unit = normalizeAnswer(match[2]);
  const allowed = [numeric.unit,...(numeric.accepted_units ?? [])].map(normalizeAnswer);
  return Number.isFinite(value) && allowed.includes(unit) && Math.abs(value - numeric.value) <= numeric.tolerance + Number.EPSILON * Math.max(1,Math.abs(numeric.value),Math.abs(value));
}

/** Derivation adds learning context; it never changes the approved question or answer. */
export function quizSnapshotItem(item: MemoryItem, learning: LearningData): QuizSnapshotItem {
  const question = learning.questions.find(q => q.id === item.question_id);
  const design = learning.answer_designs.find(d => d.question_id === item.question_id);
  const sourceTypes = item.source_ref_ids.map(id => learning.source_refs.find(s => s.id === id)?.type);
  const explicit = (item as MemoryItem & { category?: QuizCategory }).category;
  const category: QuizCategory = explicit ?? (item.evaluation_method === 'reviewed_correct_answer'
    ? sourceTypes.includes('student_record') ? 'factual' : 'concept'
    : 'experiential');
  return { ...item, category, required_meaning_elements: [...(design?.required_meanings ?? question?.answer_elements ?? item.memory_keywords)] };
}

/** A task's answer key stays on the server until its submission is finalized. */
export function publicQuizItem(item: QuizSnapshotItem) {
  return {
    id: item.id, memory_item_id: item.id, kind: item.kind, category: item.category,
    question_id: item.question_id, activity_ids: item.activity_ids, prompt: item.prompt,
    memory_keywords: item.memory_keywords, required_meaning_elements: item.required_meaning_elements,
    default_time_limit_seconds: item.default_time_limit_seconds, evaluation_method: item.evaluation_method,
    source_ref_ids: item.source_ref_ids, options: item.options, sequence: item.sequence,
  };
}

export function evaluateQuizResponse(item: QuizSnapshotItem, answer: QuizResponse): QuizResult {
  if (answer.memoryItemId !== item.id) throw new Error('과제 항목이 일치하지 않습니다.');
  const required = item.required_meaning_elements;
  const checked = [...new Set(answer.selfCheckedMeanings ?? [])];
  if (checked.some(text => !required.includes(text))) throw new Error('승인된 자기점검 요소만 선택할 수 있습니다.');
  if (!answer.cannotRecall && !['choice','order'].includes(item.kind) && (typeof answer.response !== 'string' || !answer.response.trim())) throw new Error('말한 내용이나 떠올린 답변을 입력해 주세요.');
  if (item.kind === 'choice' && !answer.cannotRecall) {
    const selected = answer.selectedOptionId ?? (typeof answer.response === 'string' ? answer.response : undefined);
    if (!item.options?.some(option => option.id === selected)) throw new Error('보기 중 하나를 선택해 주세요.');
  }
  if (item.kind === 'order' && !answer.cannotRecall) {
    const order = answer.order ?? (Array.isArray(answer.response) ? answer.response : []);
    const expected = item.sequence?.map(step => step.id) ?? [];
    if (order.length !== expected.length || new Set(order).size !== expected.length || order.some(id => !expected.includes(id))) throw new Error('순서 항목을 빠짐없이 한 번씩 제출해 주세요.');
  }
  const cannotRecall = answer.cannotRecall === true;
  // Unknown personal experiences are not objective answers, regardless of rating.
  const blocked = ['needs_confirmation', 'student_says_different', 'cannot_confirm'].includes(item.verification_status);
  const objective = ['choice','short_answer'].includes(item.kind) && item.evaluation_method === 'reviewed_correct_answer' && item.category !== 'experiential' && !blocked;
  const correct = cannotRecall || !objective ? null : item.kind === 'short_answer'
    ? typeof answer.response === 'string' && reviewedShortAnswerMatches(item,answer.response)
    : (answer.selectedOptionId ?? answer.response) === item.correct_option_id;
  const missing = objective ? [] : required.filter(text => !checked.includes(text));
  const retry = cannotRecall || correct === false || (!objective && (missing.length > 0 || ['again', 'hard'].includes(answer.rating)));
  return {
    correct, evaluation_method: objective ? 'reviewed_correct_answer' : 'self_check',
    feedback: cannotRecall ? '기억이 나지 않는 항목을 사실 확인함에 남겼어요.'
      : objective ? correct ? '검수된 정답과 일치해요.' : '근거를 확인한 뒤 다시 떠올려 보세요.'
      : missing.length ? '놓친 요소를 확인하고 다시 떠올려 보세요.' : '내 답변의 핵심 요소를 확인했어요.',
    required_meanings: required, checked_meanings: checked, missing_meanings: missing,
    cannot_recall: cannotRecall, retry_due: retry,
    ...(objective && !cannotRecall ? {reviewed_answer:item.kind==='choice' ? item.options?.find(o => o.id === item.correct_option_id)?.text : item.accepted_answers?.[0] ?? `${item.numeric_answer?.value ?? ''}${item.numeric_answer?.unit ?? ''}`} : {}),
  };
}

/** Literal mentions are a transparent comparison aid, never a semantic score. */
export function answerComparison(script: string, question?: Question, design?: { required_meanings: string[] }) {
  const meanings = design?.required_meanings ?? question?.answer_elements ?? [];
  return { character_count: [...script].length, required_meanings: meanings.map(text => ({ text, present: script.includes(text) })), comparison_basis: 'literal_mentions' as const };
}

export interface SchoolProfileData {
  admission_year: number; university: string; campus: string; department: string; admission_type: string; interview_stage: string;
  format: 'document_individual' | 'presentation' | 'mmi' | 'group' | 'other' | 'unknown';
  interview_conducted: boolean | null;
  interviewer_count: { min: number; max: number } | null;
  applicant_count: { min: number; max: number } | null;
  preparation_minutes: { min: number; max: number } | null;
  interview_minutes: { min: number; max: number } | null;
  blind_rules?: string; training_panelist_count?: number;
  admission_interview_weight: number | null;
  evaluation_weights: { element: string; weight: number }[];
  question_distribution: null | { basis: 'official' | 'sample' | 'training'; unit: 'root_question_count' | 'time'; buckets: { id: string; label: string; weight: number }[]; includes_followups: boolean; sample_size?: number };
}
export interface SchoolProfileProvenance {
  source_url: string | null; page: string | null; document_title: string | null;
  applicable_year: number; published_at: string | null; checked_at: string | null; review_note: string;
}

/** A stable target ID cannot make an old campus/year/admission profile current. */
export function schoolProfileIdentityMatches(profile: Record<string,unknown>, target: Record<string,unknown>): boolean {
  for (const key of ['admission_year','university','campus','department','admission_type']) {
    if (profile[key] === undefined || profile[key] === null || profile[key] === '' || profile[key] !== target[key]) return false;
  }
  const stage = target.interview_stage ?? target.stage;
  return !stage || profile.interview_stage === stage;
}

/** Older approved learning snapshots may omit the stage. Unknown is not a change;
 * it also cannot certify an official school profile. Keep that check strict above. */
export function learningTargetIdentityMatches(saved: Record<string,unknown>, current: Record<string,unknown>): boolean {
  for (const key of ['admission_year','university','campus','department','admission_type']) {
    if (saved[key] === undefined || saved[key] === null || saved[key] === '' || saved[key] !== current[key]) return false;
  }
  const oldStage = saved.interview_stage ?? saved.stage, currentStage = current.interview_stage ?? current.stage;
  const a = typeof oldStage === 'string' && oldStage.trim() && !['미정','확인 필요','unknown'].includes(oldStage.trim().toLowerCase()) ? oldStage.trim() : null;
  const b = typeof currentStage === 'string' && currentStage.trim() && !['미정','확인 필요','unknown'].includes(currentStage.trim().toLowerCase()) ? currentStage.trim() : null;
  return !a || !b || a === b;
}

export function validateSchoolProfile(data: SchoolProfileData, provenance: SchoolProfileProvenance, status: SchoolProfileStatus): void {
  if (!SCHOOL_PROFILE_STATUSES.includes(status)) throw new Error('학교 정보 상태를 확인해 주세요.');
  if (!Number.isInteger(data.admission_year) || data.admission_year < 2000 || provenance.applicable_year !== data.admission_year) throw new Error('적용 입학연도를 확인해 주세요.');
  for (const field of ['university', 'campus', 'department', 'admission_type', 'interview_stage'] as const) if (typeof data[field] !== 'string' || !data[field].trim()) throw new Error('학교·캠퍼스·학과·전형·단계를 구분해 주세요.');
  if (!['document_individual', 'presentation', 'mmi', 'group', 'other', 'unknown'].includes(data.format)) throw new Error('면접 형식을 확인해 주세요.');
  if (data.training_panelist_count !== undefined && (!Number.isInteger(data.training_panelist_count) || data.training_panelist_count < 1 || data.training_panelist_count > 5)) throw new Error('연습 면접관 수는 1~5명으로 입력해 주세요.');
  if (data.interview_conducted !== null && typeof data.interview_conducted !== 'boolean') throw new Error('면접 실시 여부를 확인해 주세요.');
  for (const range of [data.interviewer_count, data.applicant_count, data.preparation_minutes, data.interview_minutes]) {
    if (range !== null && (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min < 0 || range.max < range.min)) throw new Error('인원·시간 범위를 확인해 주세요.');
  }
  for (const range of [data.interviewer_count, data.applicant_count]) if (range && (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 1)) throw new Error('면접 인원은 1명 이상의 정수 범위로 입력해 주세요.');
  if (data.admission_interview_weight !== null && (!Number.isFinite(data.admission_interview_weight) || data.admission_interview_weight < 0 || data.admission_interview_weight > 100)) throw new Error('면접 반영비율을 확인해 주세요.');
  if (!Array.isArray(data.evaluation_weights) || data.evaluation_weights.some(w => !w.element?.trim() || !Number.isFinite(w.weight) || w.weight < 0 || w.weight > 100)) throw new Error('평가요소 배점을 확인해 주세요.');
  const dist = data.question_distribution;
  if (dist) {
    if (!['official', 'sample', 'training'].includes(dist.basis) || !['root_question_count', 'time'].includes(dist.unit) || typeof dist.includes_followups !== 'boolean') throw new Error('질문 편성 근거와 단위를 확인해 주세요.');
    if (!Array.isArray(dist.buckets) || !dist.buckets.length || new Set(dist.buckets.map(b => b.id)).size !== dist.buckets.length || dist.buckets.some(b => !b.id?.trim() || !b.label?.trim() || !Number.isFinite(b.weight) || b.weight < 0) || !dist.buckets.some(b => b.weight > 0)) throw new Error('질문 편성 범주와 비중을 확인해 주세요.');
    if (dist.basis === 'official' && status !== 'official_confirmed') throw new Error('공식 확인된 프로필에서만 공식 질문 편성을 사용할 수 있어요.');
    if (dist.basis === 'sample' && (!Number.isInteger(dist.sample_size) || (dist.sample_size ?? 0) < 1)) throw new Error('표본 수를 기록해 주세요.');
  }
  if (provenance.source_url) {
    const url = new URL(provenance.source_url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('출처 URL은 HTTP(S)만 사용할 수 있어요.');
  }
  if (provenance.checked_at && !Number.isFinite(Date.parse(provenance.checked_at))) throw new Error('확인일을 확인해 주세요.');
  if (provenance.published_at && !Number.isFinite(Date.parse(provenance.published_at))) throw new Error('발행일을 확인해 주세요.');
  if (status === 'official_confirmed' && (!provenance.source_url || !provenance.document_title || !provenance.checked_at)) throw new Error('공식 확인에는 원문·문서명·확인일과 담당자 검수가 필요해요.');
}
