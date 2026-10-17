import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { ClaimKind, FactConfirmationStatus, QuestionDepth } from './workflows';

export const SCHEMA_VERSION = '1.2.0';
export const TOC_VERSION = 'final-toc-v1.1';
export const FINAL_TOC = {
  guidebook: [
    ['00. 가이드북 사용법', ['1. 면접 준비 로드맵', '2. 자료 활용법']],
    ['01. 나의 면접 전략', ['1. 지원 정보', '2. 진로·학업 흐름', '3. 핵심 키워드', '4. 대표 활동', '5. 면접 우선순위']],
    ['02. 학생부 분석', ['1. 기본정보·출결·수상·자격', '2. 창의적 체험활동·봉사활동', '3. 교과 성적·세부능력 및 특기사항', '4. 독서활동·행동특성 및 종합의견', '5. 학생부 종합 흐름']],
    ['03. 대학·학과 분석', ['1. 대학·학과 이해', '2. 인재상·평가요소', '3. 면접 특성', '4. 학생부 매칭', '5. 강조 전략']],
    ['04. 예상 질문·답변', ['1. 최우선 예상 질문', '2. 학생부·활동 질문', '3. 전공·탐구·학업 질문', '4. 인재상·공동체 질문', '5. 대학·학과·공통·시사 질문', '6. 답변 설계', '7. 꼬리·압박 질문']],
    ['05. 실전 훈련', ['1. 기억 구조화', '2. 발화 훈련', '3. 돌발·꼬리·압박 대응', '4. 모의면접·피드백', '5. 면접 직전 점검']],
    ['부록', ['1. 전체 예상 질문 리스트', '2. 사실 확인표', '3. 전공·대학·학과 핵심자료', '4. 모의면접 기록지']],
  ],
  handbook: [
    ['01. 나의 면접 핵심지도', ['1. 지원 정보·진로 목표', '2. 핵심 키워드·대표 활동', '3. 최우선 질문']],
    ['02. 대표 경험', ['1. 전공·탐구 경험', '2. 학업 경험', '3. 공동체·인성 경험', '4. 기타 대표 경험']],
    ['03. 핵심 답변', ['1. 자기소개·지원동기', '2. 장점·단점·가치관', '3. 학업·진로계획', '4. 최우선 질의응답']],
    ['04. 핵심 키워드', ['1. 전공·탐구', '2. 독서·사례·시사', '3. 인재상·역량', '4. 대학·학과']],
    ['05. 사실 확인·최종 점검', ['1. 사실 확인', '2. 자주 헷갈리는 내용', '3. 면접 직전 체크']],
  ],
} as const;

export type Priority = 'S' | 'A' | 'B' | 'C' | 'F';
export type DocumentKind = keyof typeof FINAL_TOC;
export type ContentVerificationStatus = 'verified' | 'approved' | 'confirmed' | 'synthetic_reviewed' | FactConfirmationStatus;
export interface SourceRef {
  id: string; type: string; revision: number; page?: number; area?: string;
  quote?: string; url?: string; location?: string; synthetic?: boolean;
}
export interface SupportTarget {
  id: string; student_id: string; university: string; campus: string; department: string;
  admission_type: string; admission_year: number; interview_stage?: string | null; verification_status: string;
  field_sources: Record<string, { source_ref_ids: string[]; verification_status: string }>;
  talent_tags: string[]; evaluation_elements: string[]; major_connection: string;
  source_ref_ids: string[]; knowledge_release_refs: string[]; synthetic?: boolean;
}
export interface PriorityAssignment {
  support_target_id: string; priority: Priority; reason: string;
  source_ref_ids: string[]; criteria_version: string;
  talent_tags?: string[]; major_relevance?: string | null;
  representative_candidate?: boolean; representative_reason?: string;
}
export interface Activity {
  id: string; title: string; grade: number; area: string; activity_summary: string;
  interview_priority: Priority; priority_reason: string; priority_assignments: PriorityAssignment[];
  talent_tags: string[]; major_relevance: string | null; source_ref_ids: string[];
  fact_confirmation: ContentVerificationStatus; motivation?: string; role?: string; process?: string;
  result?: string; lessons?: string; keywords?: string[];
}
export interface Question {
  id: string; prompt: string; question_intent: string; grounding_types: string[];
  question_types: string[]; activity_ids: string[]; support_target_ids: string[];
  source_ref_ids: string[]; evaluation_links: { support_target_id: string; element: string; source_ref_ids: string[] }[];
  answer_elements: string[]; answer_structure: string[]; followup_question_ids: string[];
  verification_status: string; interview_priority?: Priority; depth?: QuestionDepth;
}
export interface AnswerScript {
  id: string; question_id: string; revision: number; text: string;
  verification_status: string; source_ref_ids: string[];
  claims: { text: string; fact_kind: string; claim_type?: ClaimKind; confirmation_status?: FactConfirmationStatus; source_ref_ids: string[]; verification_status: string }[];
}
export interface MemoryItem {
  id: string; kind: 'choice' | 'order' | 'keyword_recall' | 'flip_card' | 'short_answer' | 'short_speech';
  question_id: string; answer_script_id: string | null; activity_ids: string[];
  prompt: string; memory_keywords: string[]; default_time_limit_seconds: number;
  evaluation_method: 'reviewed_correct_answer' | 'self_check';
  options?: { id: string; text: string }[]; correct_option_id?: string;
  sequence?: { id: string; text: string }[]; correct_order?: string[];
  category?: 'factual' | 'experiential' | 'concept'; accepted_answers?: string[];
  numeric_answer?: { value: number; unit: string; tolerance: number; accepted_units?: string[] };
  back?: string; source_ref_ids: string[]; verification_status: string;
}
export interface LearningData {
  criteria_version: string; knowledge_release_refs: string[];
  student_context: {
    student_id: string; name: string; core_keywords: string[];
    career_academic_flow: { grade: number; focus: string; source_ref_ids: string[] }[];
    representative_activity_ids: string[];
    confirmed_goals: { text: string; source_ref_ids: string[]; verification_status: string }[];
    confirmed_plans: { text: string; source_ref_ids: string[]; verification_status: string }[];
    source_ref_ids: string[]; synthetic?: boolean;
  };
  support_targets: SupportTarget[]; source_refs: SourceRef[];
  activities: Activity[]; questions: Question[];
  answer_designs: { id: string; question_id: string; materials: string[]; structure: string[]; required_meanings: string[]; source_ref_ids: string[] }[];
  answer_scripts: AnswerScript[];
  memory_keywords: { id: string; answer_script_id: string; activity_ids: string[]; keywords: string[]; logical_structure: string[]; example: string }[];
  memory_items: MemoryItem[];
}
export interface BookSection { id: string; title: string; children?: BookSection[] }
export interface BookBlock {
  id: string; section_id: string;
  type: 'text' | 'activity_ref' | 'question_ref' | 'answer_script_ref' | 'memory_item_ref' | 'source_ref' | 'support_target_ref';
  text?: string; activity_id?: string; question_id?: string; answer_script_id?: string;
  memory_item_id?: string; source_ref_id?: string; support_target_id?: string;
}
export interface BookDocument {
  id: string; kind: DocumentKind; document_revision: number; template_version: string;
  toc_version: typeof TOC_VERSION; sections: BookSection[]; blocks: BookBlock[];
}
export interface LearningPack {
  schema_version: typeof SCHEMA_VERSION; package_id: string; content_version: number;
  package_status: 'draft' | 'reviewed'; production_job_ref: string;
  learning_data_hash: string; criteria_version: string; knowledge_release_refs: string[];
  document: BookDocument; learning_data: LearningData;
  provenance: { production_ref: string; review_ref: string; reviewed_at: string; contract_version: typeof SCHEMA_VERSION; synthetic?: boolean };
}
export interface ValidationContext { studentId: string; productionJobRef: string; registeredTargetIds?: string[] }
export class ContractError extends Error {
  readonly code = 'CONTENT_CONTRACT_INVALID';
  constructor(public readonly issues: string[]) { super(issues.join('\n')); this.name = 'ContractError'; }
}

/** Object keys are sorted recursively; array order is meaningful and retained. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return '{' + entries.map(([key, val]) => JSON.stringify(key) + ':' + canonicalJson(val)).join(',') + '}';
}
export function hashLearningData(data: LearningData | unknown): string {
  return createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
function inspectPack(input: unknown): asserts input is LearningPack {
  const issues: string[] = [];
  const fail = (path: string, message: string) => issues.push(`${path}: ${message}`);
  const object = (value: unknown, path: string): RecordValue => {
    if (!record(value)) { fail(path, '객체가 필요합니다.'); return {}; }
    return value;
  };
  const string = (value: unknown, path: string) => { if (typeof value !== 'string' || !value.trim()) fail(path, '빈 값이 아닌 문자열이 필요합니다.'); };
  const integer = (value: unknown, path: string, min = 1) => { if (!Number.isInteger(value) || (value as number) < min) fail(path, `${min} 이상의 정수가 필요합니다.`); };
  const array = (value: unknown, path: string): unknown[] => { if (!Array.isArray(value)) { fail(path, '배열이 필요합니다.'); return []; } return value; };
  const strings = (value: unknown, path: string, nonempty = false): string[] => {
    const values = array(value, path); values.forEach((v, i) => string(v, `${path}[${i}]`));
    if (nonempty && !values.length) fail(path, '적어도 한 항목이 필요합니다.');
    if (new Set(values).size !== values.length) fail(path, '중복 값이 있습니다.');
    return values.filter((v): v is string => typeof v === 'string');
  };
  const ids = new Set<string>();
  const entities = (value: unknown, path: string): RecordValue[] => array(value, path).map((v, i) => {
    const item = object(v, `${path}[${i}]`); string(item.id, `${path}[${i}].id`);
    if (typeof item.id === 'string') { if (ids.has(item.id)) fail(`${path}[${i}].id`, '패키지 내 ID가 중복됩니다.'); ids.add(item.id); }
    return item;
  });
  const pack = object(input, 'pack');
  if (pack.schema_version !== SCHEMA_VERSION) fail('schema_version', '1.2.0 계약만 지원합니다. 이전 계약은 명시적인 migration이 필요합니다.');
  ['package_id', 'production_job_ref', 'criteria_version'].forEach(k => string(pack[k], k));
  integer(pack.content_version, 'content_version');
  if (!['draft', 'reviewed'].includes(String(pack.package_status))) fail('package_status', 'draft 또는 reviewed가 필요합니다.');
  if (typeof pack.learning_data_hash !== 'string' || !/^[a-f0-9]{64}$/.test(pack.learning_data_hash)) fail('learning_data_hash', 'SHA-256 해시가 필요합니다.');
  const releases = strings(pack.knowledge_release_refs, 'knowledge_release_refs');
  const provenance = object(pack.provenance, 'provenance');
  ['production_ref', 'review_ref', 'reviewed_at'].forEach(k => string(provenance[k], `provenance.${k}`));
  if (provenance.contract_version !== SCHEMA_VERSION) fail('provenance.contract_version', '적용 계약 버전이 다릅니다.');
  if (typeof provenance.reviewed_at === 'string' && !Number.isFinite(Date.parse(provenance.reviewed_at))) fail('provenance.reviewed_at', '유효한 검수 시각이 필요합니다.');
  const data = object(pack.learning_data, 'learning_data');
  string(data.criteria_version, 'learning_data.criteria_version');
  if (data.criteria_version !== pack.criteria_version) fail('criteria_version', 'learning_data의 기준 버전과 다릅니다.');
  if (canonicalJson(strings(data.knowledge_release_refs, 'learning_data.knowledge_release_refs')) !== canonicalJson(releases)) fail('knowledge_release_refs', 'learning_data의 지식 버전과 다릅니다.');
  const sources = entities(data.source_refs, 'source_refs');
  const targets = entities(data.support_targets, 'support_targets');
  const activities = entities(data.activities, 'activities');
  const questions = entities(data.questions, 'questions');
  const designs = entities(data.answer_designs, 'answer_designs');
  const scripts = entities(data.answer_scripts, 'answer_scripts');
  const keywords = entities(data.memory_keywords, 'memory_keywords');
  const memories = entities(data.memory_items, 'memory_items');
  const idSet = (items: RecordValue[]) => new Set(items.map(i => i.id));
  const sourceIds = idSet(sources), targetIds = idSet(targets), activityIds = idSet(activities), questionIds = idSet(questions), scriptIds = idSet(scripts), memoryIds = idSet(memories);
  const ref = (value: unknown, allowed: Set<unknown>, path: string, nullable = false) => {
    if (nullable && value === null) return;
    string(value, path); if (!allowed.has(value)) fail(path, `참조 ${String(value)}가 없습니다.`);
  };
  const refs = (value: unknown, allowed: Set<unknown>, path: string, nonempty = false) => strings(value, path, nonempty).forEach(v => ref(v, allowed, path));
  const status = (value: unknown, path: string) => { if (!['verified', 'approved', 'needs_confirmation', 'confirmed', 'synthetic_reviewed', 'confirmed_from_record', 'confirmed_by_student', 'student_says_different', 'cannot_confirm'].includes(String(value))) fail(path, '확인·검수 상태가 필요합니다.'); };
  const priority = (value: unknown, path: string) => { if (!['S', 'A', 'B', 'C', 'F'].includes(String(value))) fail(path, 'S/A/B/C/F 값이 필요합니다.'); };
  sources.forEach((s, i) => {
    const path = `source_refs[${i}]`; string(s.type, `${path}.type`); integer(s.revision, `${path}.revision`);
    if (s.type === 'student_record') { integer(s.page, `${path}.page`); string(s.area, `${path}.area`); string(s.quote, `${path}.quote`); }
    else if (!s.quote && !s.url) fail(path, '인용 또는 URL 근거가 필요합니다.');
    if (s.url !== undefined && (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url))) fail(`${path}.url`, 'HTTP(S) URL이 필요합니다.');
  });
  const context = object(data.student_context, 'student_context');
  string(context.student_id, 'student_context.student_id'); string(context.name, 'student_context.name');
  strings(context.core_keywords, 'student_context.core_keywords', true);
  refs(context.representative_activity_ids, activityIds, 'student_context.representative_activity_ids', true);
  refs(context.source_ref_ids, sourceIds, 'student_context.source_ref_ids', true);
  array(context.career_academic_flow, 'student_context.career_academic_flow').forEach((v, i) => {
    const item = object(v, `student_context.career_academic_flow[${i}]`); integer(item.grade, 'career_academic_flow.grade'); string(item.focus, 'career_academic_flow.focus'); refs(item.source_ref_ids, sourceIds, 'career_academic_flow.source_ref_ids', true);
  });
  for (const key of ['confirmed_goals', 'confirmed_plans']) array(context[key], `student_context.${key}`).forEach((v, i) => {
    const item = object(v, `student_context.${key}[${i}]`); string(item.text, `${key}.text`); refs(item.source_ref_ids, sourceIds, `${key}.source_ref_ids`, true); status(item.verification_status, `${key}.verification_status`);
  });
  if (!targets.length) fail('support_targets', '지원처가 필요합니다.');
  targets.forEach((t, i) => {
    const path = `support_targets[${i}]`;
    ['student_id', 'university', 'campus', 'department', 'admission_type', 'major_connection'].forEach(k => string(t[k], `${path}.${k}`));
    if (t.student_id !== context.student_id) fail(`${path}.student_id`, '학생 맥락과 소유자가 다릅니다.');
    integer(t.admission_year, `${path}.admission_year`, 2000); status(t.verification_status, `${path}.verification_status`);
    if (t.interview_stage !== undefined && t.interview_stage !== null) string(t.interview_stage, `${path}.interview_stage`);
    strings(t.talent_tags, `${path}.talent_tags`); strings(t.evaluation_elements, `${path}.evaluation_elements`, true);
    refs(t.source_ref_ids, sourceIds, `${path}.source_ref_ids`, true); strings(t.knowledge_release_refs, `${path}.knowledge_release_refs`);
    const fields = object(t.field_sources, `${path}.field_sources`);
    for (const key of ['university', 'campus', 'department', 'admission_type', 'admission_year']) {
      const field = object(fields[key], `${path}.field_sources.${key}`); refs(field.source_ref_ids, sourceIds, `${path}.field_sources.${key}.source_ref_ids`, true); status(field.verification_status, `${path}.field_sources.${key}.verification_status`);
    }
  });
  activities.forEach((a, i) => {
    const path = `activities[${i}]`; ['title', 'area', 'activity_summary', 'priority_reason'].forEach(k => string(a[k], `${path}.${k}`)); integer(a.grade, `${path}.grade`);
    if ((a.grade as number) > 3) fail(`${path}.grade`, '학년은 1~3이어야 합니다.');
    priority(a.interview_priority, `${path}.interview_priority`); status(a.fact_confirmation, `${path}.fact_confirmation`);
    refs(a.source_ref_ids, sourceIds, `${path}.source_ref_ids`, true); strings(a.talent_tags, `${path}.talent_tags`);
    if (a.major_relevance !== null) string(a.major_relevance, `${path}.major_relevance`);
    const seenTargets = new Set();
    array(a.priority_assignments, `${path}.priority_assignments`).forEach((v, j) => {
      const assignment = object(v, `${path}.priority_assignments[${j}]`); ref(assignment.support_target_id, targetIds, `${path}.priority_assignments.support_target_id`);
      if (seenTargets.has(assignment.support_target_id)) fail(`${path}.priority_assignments`, '동일 지원처의 우선도 판정이 중복됩니다.'); seenTargets.add(assignment.support_target_id);
      priority(assignment.priority, `${path}.priority_assignments.priority`); string(assignment.reason, `${path}.priority_assignments.reason`);
      refs(assignment.source_ref_ids, sourceIds, `${path}.priority_assignments.source_ref_ids`, true);
      if (assignment.criteria_version !== data.criteria_version) fail(`${path}.priority_assignments.criteria_version`, '기준 버전이 다릅니다.');
      const assignmentPath = `${path}.priority_assignments[${j}]`;
      if (assignment.talent_tags !== undefined) strings(assignment.talent_tags, `${assignmentPath}.talent_tags`);
      if (assignment.major_relevance !== undefined && assignment.major_relevance !== null) string(assignment.major_relevance, `${assignmentPath}.major_relevance`);
      if (assignment.representative_candidate !== undefined && typeof assignment.representative_candidate !== 'boolean') fail(`${assignmentPath}.representative_candidate`, '대표 활동 후보 여부는 boolean이어야 합니다.');
      if (assignment.representative_candidate === true || assignment.representative_reason !== undefined) string(assignment.representative_reason, `${assignmentPath}.representative_reason`);
    });
    if (!seenTargets.size && pack.package_status === 'reviewed') fail(`${path}.priority_assignments`, '검수본에는 지원처별 우선도·사유·근거가 필요합니다.');
  });
  questions.forEach((q, i) => {
    const path = `questions[${i}]`; string(q.prompt, `${path}.prompt`); string(q.question_intent, `${path}.question_intent`);
    strings(q.grounding_types, `${path}.grounding_types`, true); strings(q.question_types, `${path}.question_types`, true);
    refs(q.activity_ids, activityIds, `${path}.activity_ids`); refs(q.support_target_ids, targetIds, `${path}.support_target_ids`);
    refs(q.source_ref_ids, sourceIds, `${path}.source_ref_ids`, true); refs(q.followup_question_ids, questionIds, `${path}.followup_question_ids`);
    if (Array.isArray(q.followup_question_ids) && q.followup_question_ids.includes(q.id)) fail(`${path}.followup_question_ids`, '자기 자신을 꼬리질문으로 참조할 수 없습니다.');
    strings(q.answer_elements, `${path}.answer_elements`, true); strings(q.answer_structure, `${path}.answer_structure`, true); status(q.verification_status, `${path}.verification_status`);
    if (q.depth !== undefined && !['D1','D2','D3','D4'].includes(String(q.depth))) fail(`${path}.depth`, 'D1~D4 질문 깊이가 필요합니다.');
    array(q.evaluation_links, `${path}.evaluation_links`).forEach(v => { const link = object(v, `${path}.evaluation_links`); ref(link.support_target_id, targetIds, `${path}.evaluation_links.support_target_id`); string(link.element, `${path}.evaluation_links.element`); refs(link.source_ref_ids, sourceIds, `${path}.evaluation_links.source_ref_ids`, true); });
  });
  designs.forEach((d, i) => { const path = `answer_designs[${i}]`; ref(d.question_id, questionIds, `${path}.question_id`); strings(d.materials, `${path}.materials`, true); strings(d.structure, `${path}.structure`, true); strings(d.required_meanings, `${path}.required_meanings`, true); refs(d.source_ref_ids, sourceIds, `${path}.source_ref_ids`, true); });
  scripts.forEach((s, i) => {
    const path = `answer_scripts[${i}]`; ref(s.question_id, questionIds, `${path}.question_id`); integer(s.revision, `${path}.revision`); string(s.text, `${path}.text`); status(s.verification_status, `${path}.verification_status`); refs(s.source_ref_ids, sourceIds, `${path}.source_ref_ids`, true);
    const claims = array(s.claims, `${path}.claims`); if (!claims.length) fail(`${path}.claims`, '발화본에는 문장별 사실·근거 검수가 필요합니다.');
    claims.forEach(v => { const claim = object(v, `${path}.claims`); string(claim.text, `${path}.claims.text`); string(claim.fact_kind, `${path}.claims.fact_kind`); status(claim.verification_status, `${path}.claims.verification_status`); refs(claim.source_ref_ids, sourceIds, `${path}.claims.source_ref_ids`, true);
      if (claim.claim_type !== undefined && !['student_record_fact','student_confirmed_experience','interpretation_connection','student_thought_plan','needs_confirmation'].includes(String(claim.claim_type))) fail(`${path}.claims.claim_type`, '사실·경험·해석·생각·확인 필요를 구분해 주세요.');
      if (claim.confirmation_status !== undefined && !['confirmed_from_record','confirmed_by_student','needs_confirmation','student_says_different','cannot_confirm'].includes(String(claim.confirmation_status))) fail(`${path}.claims.confirmation_status`, '사실 확인 상태를 확인해 주세요.');
    });
  });
  keywords.forEach((k, i) => { const path = `memory_keywords[${i}]`; ref(k.answer_script_id, scriptIds, `${path}.answer_script_id`); refs(k.activity_ids, activityIds, `${path}.activity_ids`); strings(k.keywords, `${path}.keywords`, true); strings(k.logical_structure, `${path}.logical_structure`, true); string(k.example, `${path}.example`); });
  memories.forEach((m, i) => {
    const path = `memory_items[${i}]`; ref(m.question_id, questionIds, `${path}.question_id`); ref(m.answer_script_id, scriptIds, `${path}.answer_script_id`, true); refs(m.activity_ids, activityIds, `${path}.activity_ids`);
    string(m.prompt, `${path}.prompt`); strings(m.memory_keywords, `${path}.memory_keywords`, true); integer(m.default_time_limit_seconds, `${path}.default_time_limit_seconds`); status(m.verification_status, `${path}.verification_status`); refs(m.source_ref_ids, sourceIds, `${path}.source_ref_ids`, true);
    if (!['choice', 'order', 'keyword_recall', 'flip_card', 'short_answer', 'short_speech'].includes(String(m.kind))) fail(`${path}.kind`, '지원하지 않는 암기 유형입니다.');
    if (m.category !== undefined && !['factual','experiential','concept'].includes(String(m.category))) fail(`${path}.category`, '사실·경험·개념 문제를 구분해 주세요.');
    if (!['reviewed_correct_answer', 'self_check'].includes(String(m.evaluation_method))) fail(`${path}.evaluation_method`, '객관 개념 정답 또는 자기 점검 방식이 필요합니다.');
    if (m.evaluation_method === 'reviewed_correct_answer' && (m.category === 'experiential' || ['needs_confirmation','student_says_different','cannot_confirm'].includes(String(m.verification_status)))) fail(`${path}.evaluation_method`, '미확인 개인 경험은 객관 정답으로 사용할 수 없습니다.');
    if (m.kind === 'choice') {
      const options = array(m.options, `${path}.options`).map(v => object(v, `${path}.options`));
      if (options.length < 2) fail(`${path}.options`, '두 개 이상의 선택지가 필요합니다.');
      options.forEach(o => { string(o.id, `${path}.options.id`); string(o.text, `${path}.options.text`); });
      if (new Set(options.map(o => o.id)).size !== options.length) fail(`${path}.options`, '선택지 ID가 중복됩니다.');
      ref(m.correct_option_id, new Set(options.map(o => o.id)), `${path}.correct_option_id`);
      if (m.evaluation_method !== 'reviewed_correct_answer') fail(`${path}.evaluation_method`, '객관 선택은 검수된 정답이 필요합니다.');
    } else if (m.kind === 'order') {
      const seq = array(m.sequence, `${path}.sequence`).map(v => object(v, `${path}.sequence`));
      seq.forEach(o => { string(o.id, `${path}.sequence.id`); string(o.text, `${path}.sequence.text`); });
      const order = strings(m.correct_order, `${path}.correct_order`, true);
      if (seq.length < 2 || new Set(seq.map(o => o.id)).size !== seq.length || order.length !== seq.length || order.some(id => !seq.some(o => o.id === id))) fail(`${path}.correct_order`, '순서 항목 전체를 정확히 한 번씩 참조해야 합니다.');
      if (m.evaluation_method !== 'self_check') fail(`${path}.evaluation_method`, '개인 답변 순서는 자기 점검으로 확인합니다.');
    } else if (m.kind === 'short_answer') {
      if (m.evaluation_method === 'reviewed_correct_answer') {
        if (m.category === 'experiential') fail(`${path}.evaluation_method`, '개인 경험은 문장 일치로 판정할 수 없습니다.');
        if (['needs_confirmation','student_says_different','cannot_confirm'].includes(String(m.verification_status))) fail(`${path}.verification_status`, '확인되지 않은 사실은 객관 정답으로 사용할 수 없습니다.');
        const accepted = m.accepted_answers === undefined ? [] : strings(m.accepted_answers, `${path}.accepted_answers`, true);
        if (m.numeric_answer !== undefined) {
          const numeric = object(m.numeric_answer, `${path}.numeric_answer`);
          if (typeof numeric.value !== 'number' || !Number.isFinite(numeric.value)) fail(`${path}.numeric_answer.value`, '검수된 유한한 수치가 필요합니다.');
          if (typeof numeric.unit !== 'string') fail(`${path}.numeric_answer.unit`, '단위 문자열이 필요합니다. 단위가 없으면 빈 문자열로 지정하세요.');
          if (typeof numeric.tolerance !== 'number' || !Number.isFinite(numeric.tolerance) || numeric.tolerance < 0) fail(`${path}.numeric_answer.tolerance`, '0 이상의 검수된 허용 오차가 필요합니다.');
          if (numeric.accepted_units !== undefined) strings(numeric.accepted_units, `${path}.numeric_answer.accepted_units`, true);
        }
        if (!accepted.length && m.numeric_answer === undefined) fail(`${path}.accepted_answers`, '단답형에는 검수된 허용 표기 또는 수치·단위 정답이 필요합니다.');
      }
    } else {
      if (m.evaluation_method !== 'self_check') fail(`${path}.evaluation_method`, '경험 회상은 자기 점검으로 확인합니다.');
      if (m.kind === 'flip_card') string(m.back, `${path}.back`);
    }
    if (m.answer_script_id !== null) {
      const linkedScript = scripts.find(s => s.id === m.answer_script_id);
      if (linkedScript && linkedScript.question_id !== m.question_id) fail(`${path}.answer_script_id`, '다른 질문의 발화본을 참조합니다.');
      if (linkedScript && ['needs_confirmation','student_says_different','cannot_confirm'].includes(String(linkedScript.verification_status))) fail(`${path}.answer_script_id`, '미확인 개인 사실을 확정 경험 회상으로 훈련할 수 없습니다.');
      if (linkedScript && Array.isArray(linkedScript.claims) && linkedScript.claims.some(v => record(v) && ['needs_confirmation','student_says_different','cannot_confirm'].includes(String(v.confirmation_status)))) fail(`${path}.answer_script_id`, '미확인 주장을 포함한 발화본을 확정 회상으로 훈련할 수 없습니다.');
    }
  });
  const doc = object(pack.document, 'document');
  string(doc.id, 'document.id'); integer(doc.document_revision, 'document.document_revision'); string(doc.template_version, 'document.template_version');
  if (typeof doc.id === 'string') { if (ids.has(doc.id)) fail('document.id', '문서 ID가 중복됩니다.'); ids.add(doc.id); }
  if (doc.toc_version !== TOC_VERSION) fail('document.toc_version', '확정 목차 final-toc-v1.1이 필요합니다.');
  const kind = doc.kind;
  if (kind !== 'guidebook' && kind !== 'handbook') fail('document.kind', 'guidebook 또는 handbook이 필요합니다.');
  const sectionIds = new Set<unknown>(), leafIds = new Set<unknown>();
  const sections = array(doc.sections, 'document.sections');
  if (kind === 'guidebook' || kind === 'handbook') {
    const expected = FINAL_TOC[kind];
    if (sections.length !== expected.length) fail('document.sections', '확정 목차의 모든 장이 지정된 순서로 필요합니다.');
    sections.forEach((v, i) => {
      const chapter = object(v, `document.sections[${i}]`); string(chapter.id, `document.sections[${i}].id`);
      if (ids.has(String(chapter.id))) fail(`document.sections[${i}].id`, 'ID가 중복됩니다.'); ids.add(String(chapter.id)); sectionIds.add(chapter.id);
      if (chapter.title !== expected[i]?.[0]) fail(`document.sections[${i}].title`, `확정 제목·순서가 다릅니다. 필요한 제목: ${expected[i]?.[0] ?? '(추가 장 없음)'}`);
      const children = array(chapter.children, `document.sections[${i}].children`);
      if (children.length !== expected[i]?.[1].length) fail(`document.sections[${i}].children`, '하위 목차 개수·위계가 다릅니다.');
      children.forEach((child, j) => {
        const section = object(child, `document.sections[${i}].children[${j}]`); string(section.id, `document.sections[${i}].children[${j}].id`);
        if (ids.has(String(section.id))) fail(`document.sections[${i}].children[${j}].id`, 'ID가 중복됩니다.'); ids.add(String(section.id)); sectionIds.add(section.id); leafIds.add(section.id);
        if (section.title !== expected[i]?.[1][j]) fail(`document.sections[${i}].children[${j}].title`, '하위 목차 제목·순서가 다릅니다.');
        if (section.children !== undefined && (!Array.isArray(section.children) || section.children.length)) fail(`document.sections[${i}].children[${j}].children`, '확정 목차는 장 → 절 두 단계입니다.');
      });
    });
  }
  const covered = new Set<unknown>();
  const blockRefKeys: Record<string, [string, Set<unknown>]> = { activity_ref: ['activity_id', activityIds], question_ref: ['question_id', questionIds], answer_script_ref: ['answer_script_id', scriptIds], memory_item_ref: ['memory_item_id', memoryIds], source_ref: ['source_ref_id', sourceIds], support_target_ref: ['support_target_id', targetIds] };
  entities(doc.blocks, 'document.blocks').forEach((b, i) => {
    const path = `document.blocks[${i}]`; ref(b.section_id, sectionIds, `${path}.section_id`); covered.add(b.section_id);
    if (b.type === 'text') string(b.text, `${path}.text`);
    else if (typeof b.type === 'string' && blockRefKeys[b.type]) { const [key, allowed] = blockRefKeys[b.type]; ref(b[key], allowed, `${path}.${key}`); }
    else fail(`${path}.type`, '지원하지 않는 구조화 block입니다.');
  });
  leafIds.forEach(id => { if (!covered.has(id)) fail('document.blocks', `목차 절 ${String(id)}의 본문 block이 없습니다.`); });
  if (record(pack.learning_data) && pack.learning_data_hash !== hashLearningData(pack.learning_data)) fail('learning_data_hash', '학습 데이터 해시가 일치하지 않습니다.');
  if (issues.length) throw new ContractError(issues);
}

/** Parse once on the server. Imported markup is never a student rendering source. */
export function parseLearningHtml(html: string): { pack: LearningPack; fileHash: string } {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 10 * 1024 * 1024) throw new ContractError(['html: 최대 10 MiB의 UTF-8 HTML이 필요합니다.']);
  const tree = parse(html);
  const issues: string[] = [];
  const jsonScripts: DefaultTreeAdapterMap['element'][] = [];
  const documentMains: DefaultTreeAdapterMap['element'][] = [];
  const remote = (value: string) => /^(?:https?:|ftp:|file:|\/\/)/i.test(value.trim());
  const dangerousUrl = (value: string) => /^(?:javascript|vbscript|data:text\/html):/i.test(value.replace(/[\u0000-\u0020]/g, ''));
  const cssUnsafe = (css: string) => {
    const decoded = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, '$1');
    return /@import\b|(?:expression|behavior)\s*[:(]|url\s*\(\s*["']?\s*(?:https?:|\/\/|javascript:|data:text\/html)/i.test(decoded);
  };
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('tagName' in node) {
      const attrs = new Map(node.attrs.map(a => [a.name.toLowerCase(), a.value]));
      if (node.tagName === 'main' && attrs.has('data-document-kind')) documentMains.push(node);
      if (node.tagName === 'script') {
        if (attrs.get('type')?.toLowerCase() !== 'application/json' || attrs.get('id') !== 'gakja-learning-pack' || attrs.has('src')) issues.push('html.script: 실행 script 또는 계약 외 데이터 블록은 허용하지 않습니다.');
        else jsonScripts.push(node);
      }
      if (['iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'animate', 'animateMotion', 'animateTransform', 'set'].includes(node.tagName)) issues.push(`html.${node.tagName}: 실행·삽입 요소는 허용하지 않습니다.`);
      if (node.tagName === 'meta' && attrs.get('http-equiv')?.toLowerCase() === 'refresh') issues.push('html.meta: 새로고침 이동은 허용하지 않습니다.');
      for (const [name, value] of attrs) {
        if (/^on/i.test(name)) issues.push(`html.${name}: 이벤트 핸들러는 허용하지 않습니다.`);
        if (name === 'srcdoc') issues.push('html.srcdoc: 내장 실행 문서는 허용하지 않습니다.');
        if (['src', 'poster', 'background', 'data', 'srcset'].includes(name) && (remote(value) || /(?:https?:|\/\/)/i.test(value))) issues.push(`html.${name}: 외부 리소스는 허용하지 않습니다.`);
        if ((name === 'href' || name === 'xlink:href' || name === 'src') && dangerousUrl(value)) issues.push(`html.${name}: 실행 URL은 허용하지 않습니다.`);
        if ((name === 'href' || name === 'xlink:href') && node.tagName !== 'a' && remote(value)) issues.push(`html.${node.tagName}.${name}: 외부 리소스는 허용하지 않습니다.`);
        if (node.tagName === 'link' && name === 'href' && remote(value)) issues.push('html.link: 외부 리소스는 허용하지 않습니다.');
        if (name === 'style' && cssUnsafe(value)) issues.push('html.style: 외부·실행 CSS는 허용하지 않습니다.');
      }
      if (node.tagName === 'style') {
        const css = node.childNodes.filter((n): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text').map(n => n.value).join('');
        if (cssUnsafe(css)) issues.push('html.style: 외부·실행 CSS는 허용하지 않습니다.');
      }
      if ('content' in node) visit((node as DefaultTreeAdapterMap['template']).content);
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(tree);
  if (jsonScripts.length !== 1) issues.push('html: id="gakja-learning-pack"인 application/json 블록이 정확히 하나 필요합니다. 외부 제작 HTML에 활동·질문·퀴즈·지원처·검수 기록을 포함한 학습 데이터를 내장해 주세요. 본문만으로 학습 문제를 자동 생성하지 않습니다.');
  if (documentMains.length !== 1) issues.push('html: data-document-kind가 있는 책 본문 main이 정확히 하나 필요합니다.');
  if (issues.length) throw new ContractError(issues);
  const jsonText = jsonScripts[0].childNodes.filter((n): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text').map(n => n.value).join('');
  let pack: unknown;
  try { pack = JSON.parse(jsonText); } catch { throw new ContractError(['html.json: 유효한 JSON이 필요합니다. < 문자는 \\u003c로 직렬화하세요.']); }
  inspectPack(pack);
  if (documentMains[0].attrs.find(a => a.name === 'data-document-kind')?.value !== pack.document.kind) throw new ContractError(['html.main: 본문과 JSON 문서 종류가 다릅니다.']);
  return { pack, fileHash: createHash('sha256').update(html, 'utf8').digest('hex') };
}

export function validatePair(packs: LearningPack[], context: ValidationContext): { learning: LearningData; documents: BookDocument[]; packageId: string; contentVersion: number; learningHash: string } {
  if (packs.length !== 2) throw new ContractError(['documents: 가이드북·암기 핸드북 두 파일이 필요합니다.']);
  packs.forEach(inspectPack);
  const [first, second] = packs;
  const issues: string[] = [];
  if (new Set(packs.map(p => p.document.kind)).size !== 2) issues.push('documents: guidebook과 handbook이 각각 하나 필요합니다.');
  if (first.document.id === second.document.id) issues.push('documents: 두 문서의 ID가 같을 수 없습니다.');
  for (const key of ['package_id', 'content_version', 'learning_data_hash', 'production_job_ref', 'criteria_version'] as const) if (first[key] !== second[key]) issues.push(`${key}: 두 책의 값이 다릅니다.`);
  if (canonicalJson(first.learning_data) !== canonicalJson(second.learning_data)) issues.push('learning_data: 두 책의 학습 데이터가 다릅니다.');
  for (const pack of packs) {
    if (pack.production_job_ref !== context.productionJobRef) issues.push('production_job_ref: 서버에 연결된 제작 건과 다릅니다.');
    if (pack.learning_data.student_context.student_id !== context.studentId) issues.push('student_context.student_id: 지정된 학생의 콘텐츠가 아닙니다.');
    for (const target of pack.learning_data.support_targets) {
      if (target.student_id !== context.studentId) issues.push(`support_targets.${target.id}: 다른 학생의 지원처입니다.`);
      if (context.registeredTargetIds && !context.registeredTargetIds.includes(target.id)) issues.push(`support_targets.${target.id}: 서버에 등록된 학생 지원처가 아닙니다.`);
    }
  }
  if (issues.length) throw new ContractError([...new Set(issues)]);
  return { learning: first.learning_data, documents: [...packs].sort((a, b) => a.document.kind === 'guidebook' ? -1 : b.document.kind === 'guidebook' ? 1 : 0).map(p => p.document), packageId: first.package_id, contentVersion: first.content_version, learningHash: first.learning_data_hash };
}

export interface GuidebookValidationResult {
  learning: LearningData; documents: BookDocument[];
  packageId: string; contentVersion: number; learningHash: string;
}

/** Accept one externally approved final guidebook; its authored data powers web practice. */
export function validateGuidebook(pack: LearningPack, context: ValidationContext): GuidebookValidationResult {
  inspectPack(pack);
  const issues: string[] = [];
  if (pack.document.kind !== 'guidebook') issues.push('document.kind: 최종 가이드북 HTML 한 파일이 필요합니다. 핸드북은 단독 발행할 수 없습니다.');
  if (pack.package_status !== 'reviewed') issues.push('package_status: 외부 최종 검수를 완료한 reviewed 가이드북만 등록할 수 있습니다.');
  if (pack.production_job_ref !== context.productionJobRef) issues.push('production_job_ref: 서버에 연결된 제작 건과 다릅니다.');
  if (pack.learning_data.student_context.student_id !== context.studentId) issues.push('student_context.student_id: 지정된 학생의 콘텐츠가 아닙니다.');
  const data = pack.learning_data;
  for (const target of data.support_targets) {
    if (target.student_id !== context.studentId) issues.push(`support_targets.${target.id}: 다른 학생의 지원처입니다.`);
    if (context.registeredTargetIds && !context.registeredTargetIds.includes(target.id)) issues.push(`support_targets.${target.id}: 서버에 등록된 학생 지원처가 아닙니다.`);
    for (const activity of data.activities) {
      if (!activity.priority_assignments.some(assignment => assignment.support_target_id === target.id)) {
        issues.push(`activities.${activity.id}.priority_assignments: 지원처 ${target.id}의 활동별 우선도·판정 사유·근거가 필요합니다. 교재에 포함된 지원처마다 평가를 작성해 주세요.`);
      }
    }
  }
  const trainingStatuses = new Set(['verified', 'approved', 'confirmed', 'synthetic_reviewed', 'confirmed_from_record', 'confirmed_by_student']);
  const practiceQuestionIds = new Set(data.questions.filter(question => trainingStatuses.has(question.verification_status)).map(question => question.id));
  if (!practiceQuestionIds.size) issues.push('questions: 모의면접에 연결할 검수된 질문이 적어도 하나 필요합니다. 질문·의도·답변 요소·근거를 학습 데이터에 작성해 주세요.');
  if (!data.memory_items.some(item => trainingStatuses.has(item.verification_status) && practiceQuestionIds.has(item.question_id)
    && item.kind !== 'order' && (item.kind !== 'choice' || item.options?.length === 4))) {
    issues.push('memory_items: 검수된 질문에 연결하고 웹에서 풀 수 있는 검수된 퀴즈가 적어도 하나 필요합니다. 4지선다·회상·카드·단답·발화 항목을 작성해 주세요. 순서 훈련만 있는 교재는 웹 퀴즈에 연결할 수 없습니다.');
  }
  for (const item of data.memory_items) {
    if (item.kind === 'choice' && item.options?.length !== 4) {
      issues.push(`memory_items.${item.id}.options: 웹 퀴즈의 4지선다에는 검수된 선택지 정확히 4개가 필요합니다.`);
    }
    const question = data.questions.find(candidate => candidate.id === item.question_id)!;
    if (item.activity_ids.some(id => !question.activity_ids.includes(id))) {
      issues.push(`memory_items.${item.id}.activity_ids: 연결 질문 ${question.id}에 포함되지 않은 활동을 참조합니다. 교재의 활동·질문·퀴즈 연결을 확인해 주세요.`);
    }
  }
  if (issues.length) throw new ContractError([...new Set(issues)]);
  return { learning: data, documents: [pack.document], packageId: pack.package_id, contentVersion: pack.content_version, learningHash: pack.learning_data_hash };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function renderLearningHtml(pack: LearningPack): string {
  inspectPack(pack);
  const doc = pack.document, data = pack.learning_data;
  const resolveBlock = (b: BookBlock) => b.text ?? data.activities.find(a => a.id === b.activity_id)?.activity_summary ?? data.questions.find(q => q.id === b.question_id)?.prompt ?? data.answer_scripts.find(s => s.id === b.answer_script_id)?.text ?? data.memory_items.find(m => m.id === b.memory_item_id)?.prompt ?? data.source_refs.find(s => s.id === b.source_ref_id)?.quote ?? data.support_targets.find(t => t.id === b.support_target_id)?.major_connection ?? '';
  const body = doc.sections.map(chapter => `<section id="${escapeHtml(chapter.id)}"><h2>${escapeHtml(chapter.title)}</h2>${chapter.children?.map(section => `<section id="${escapeHtml(section.id)}"><h3>${escapeHtml(section.title)}</h3>${doc.blocks.filter(b => b.section_id === section.id).map(b => `<p>${escapeHtml(resolveBlock(b))}</p>`).join('')}</section>`).join('')}</section>`).join('');
  const safeJson = JSON.stringify(pack).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(data.student_context.name)} ${doc.kind === 'guidebook' ? '가이드북' : '암기 핸드북'}</title></head><body><main data-document-kind="${doc.kind}">${body}</main><script type="application/json" id="gakja-learning-pack">${safeJson}</script></body></html>`;
}

export { createDemoPack } from './fixtures';
export * from './workflows';
