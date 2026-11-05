import type { InterviewContext, StudentEvidence } from "./data/load-interview-context";
import type { InterviewSession, primaryFunctions } from "./protocol";
import { interviewConfig } from "../interview.config";
import { createStudentObjectiveCandidates, type StudentObjectiveCandidate } from './question-objective';
import { deliveredFollowUpCount } from './follow-up-count';

export const INTERVIEW_PLAN_POLICY_VERSION = "time-budget-objective-pool-v4";
export const QUESTION_SELECTION_POLICY_VERSION = "unseen-objective-history-selection-v2";
/** Full codec capacity (60 reviewed student purposes + 2 optional common purposes).
 * This is an offline cost bound, never an interview question quota. */
export const DEFAULT_POOL_OBJECTIVE_BUDGET = 62;
export const MAIN_QUESTION_SECONDS = interviewConfig.mainQuestionSeconds;
/** Scheduling reserves, not limits on a student's answer. Applied between turns only. */
export const MAIN_QUESTION_RESERVE_SECONDS = 75;
export const FOLLOW_UP_RESERVE_SECONDS = 45;

export type PrimaryFunction = typeof primaryFunctions[number];
export type InterviewTopicArea = "academic_inquiry" | "problem_solving" | "community_values" | "career_motivation" | "evidence_limits";
export type InterviewerRole = "academic" | "community_talent";
export interface SchoolConnection {
  kind: "admission_criterion" | "department_talent" | "university_talent";
  label: string;
  sourceIds: string[];
  /** Describes the intended verification; never declares the student already has a competency. */
  rationale: string;
}
export interface InterviewPlanSlot {
  id: string;
  index: number;
  topicArea: InterviewTopicArea;
  label: string;
  evidenceIds: string[];
  activityIds: string[];
  primaryFunction: PrimaryFunction;
  questionIntent: string;
  depth: "D1" | "D2" | "D3" | "D4";
  interviewerId: "interviewer-1" | "interviewer-2";
  interviewerRole: InterviewerRole;
  schoolConnections: SchoolConnection[];
  objective?: StudentObjectiveCandidate;
  /** Pool identity survives a different session order and fresh turn IDs. */
  candidateSlotId?: string;
  semanticKey?: string;
}
export interface InterviewPlan {
  policyVersion: string;
  durationSeconds: number;
  mainQuestionTarget: number;
  slots: InterviewPlanSlot[];
  limitations: string[];
  scheduling?: "time_based" | "legacy_count";
  purpose?: "candidate_pool" | "session";
  poolKey?: string;
  poolContentSha256?: string;
  selectionPolicyVersion?: string;
  mode?: "mock" | "practice";
  selectionContext?: {
    scope?: import('./question-selection').QuestionSelectionScope;
    exposure?: import('./question-selection').GuidebookExposure;
    historySessionIds: string[];
    purposeLineage?: import('./data/question-purpose-lineage').QuestionPurposeLineageSnapshot;
    lastSelection?: { mainIndex: number; eligibleCandidates: number; excluded: Array<{ candidateId: string; slotId: string; reason: string }> };
  };
}

interface TopicDefinition {
  area: InterviewTopicArea;
  label: string;
  role: InterviewerRole;
  signals: RegExp;
  functions: PrimaryFunction[];
  schoolSignals: RegExp;
}
const topics: TopicDefinition[] = [
  { area: "academic_inquiry", label: "학업·탐구", role: "academic", signals: /교과|세특|동아리|탐구|실험|원리|화학|수학|과학|연구/u, functions: ["PROCESS", "CONCEPT", "EVIDENCE"], schoolSignals: /학업|학문|수학|과학|학습|탐구/u },
  { area: "problem_solving", label: "문제해결·선택", role: "academic", signals: /선택|개선|조건|변인|한계|불확실|보완|비교|해결|오차|분석/u, functions: ["CHOICE", "LIMIT", "ALTERNATIVE"], schoolSignals: /잠재|문제|해결|창의|탐구|자율/u },
  { area: "community_values", label: "협업·가치", role: "community_talent", signals: /공동체|협업|협력|학급|조율|배려|봉사|접근성|소통|의견[^\n]{0,15}(?:듣|모|조)/u, functions: ["ROLE", "VALUE", "CHOICE"], schoolSignals: /사회|공동체|책임|협력|소통|배려/u },
  { area: "career_motivation", label: "진로·전공 연결", role: "community_talent", signals: /진로|전공|전문가|지원동기|관심|꿈/u, functions: ["CONNECTION", "MOTIVE", "CHOICE"], schoolSignals: /잠재|전공|자율|탐색|학습|발전/u },
  { area: "evidence_limits", label: "근거·한계", role: "academic", signals: /자료|근거|통계|설문|한계|오차|해석|유효|비교|분석|보고서/u, functions: ["EVIDENCE", "LIMIT", "RESULT"], schoolSignals: /학업|잠재|탐구|과학|수학|분석/u },
];
const intentByFunction: Partial<Record<PrimaryFunction, string>> = {
  FACT: "기록된 대상에서 실제로 다룬 내용을 확인한다.",
  PROCESS: "기록된 활동의 실제 수행 방법을 확인한다.",
  CONCEPT: "기록에 사용된 개념에 대한 학생의 이해를 확인한다.",
  EVIDENCE: "기록된 탐구 또는 주장에 사용한 근거를 확인한다.",
  CHOICE: "기록된 활동의 방법이나 자료를 선택한 판단 기준을 확인한다.",
  LIMIT: "기록된 자료나 결과를 해석할 때의 한계를 확인한다.",
  ALTERNATIVE: "기록된 활동에 관해 학생이 제안하는 개선 방향을 확인한다.",
  ROLE: "기록된 활동에서 학생 본인이 실제로 한 기여를 확인한다.",
  VALUE: "기록된 행동에서 학생이 우선한 판단 기준을 확인한다.",
  CONNECTION: "기록된 경험이 학생의 학습 또는 진로 관심과 연결되는지 확인한다.",
  MOTIVE: "기록된 활동에 관심을 갖게 된 계기를 열린 질문으로 확인한다.",
  RESULT: "기록된 활동에서 실제로 관찰하거나 도출한 내용을 확인한다.",
  TRANSFER: "확인된 개념을 명시된 가정에 적용하는 판단을 확인한다.",
};

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}을 확인할 수 없습니다.`);
  return value;
}
export function mainQuestionTargetForDuration(durationSeconds: number) {
  positiveInteger(durationSeconds, "면접 진행 시간");
  return Math.max(1, Math.round(durationSeconds / MAIN_QUESTION_SECONDS));
}
function seedNumber(value: string) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.codePointAt(0)!, 16777619) >>> 0;
  return result;
}
function connections(context: InterviewContext, topic: TopicDefinition, evidence: StudentEvidence, primaryFunction: PrimaryFunction): SchoolConnection[] {
  const result: SchoolConnection[] = [];
  const purpose = `「${evidence.title}」: ${intentByFunction[primaryFunction]}`;
  for (const element of context.school.officialInterviewCriteria?.elements ?? []) {
    if (topic.schoolSignals.test(element.name)) result.push({ kind: "admission_criterion", label: element.name, sourceIds: [...context.school.officialInterviewCriteria!.sourceIds], rationale: `${purpose} 이 ${topic.label} 확인 목적을 전형의 ${element.name}와 연결하되 학생의 역량 보유나 배점을 단정하지 않는다.` });
  }
  for (const [kind, profile] of [["department_talent", context.school.departmentProfile], ["university_talent", context.school.universityProfile]] as const) {
    if (!profile || profile.verification_status !== "verified_current_official") continue;
    for (const point of profile.points) if (topic.schoolSignals.test(point)) result.push({ kind, label: point, sourceIds: [profile.source.id], rationale: `${purpose} 이 확인 목적과 인재상 문구를 연결하되 학생이 이미 해당 역량을 갖췄다고 전제하지 않는다.` });
  }
  return result;
}

/** Preparation enumerates independent objectives; sessions select from this pool separately. */
export function createInterviewPlan(context: InterviewContext, sessionSeed = ""): InterviewPlan {
  const durationSeconds = positiveInteger(context.interviewOverview?.durationSeconds ?? NaN, "공식 면접 진행 시간");
  const seed = seedNumber(sessionSeed);
  const objectives = context.studentObjectives ?? createStudentObjectiveCandidates(context, context.preparedActivities);
  const candidates = objectives.filter(objective => {
    const common = 'grounding' in objective && (objective.grounding as { kind?: string } | undefined)?.kind === 'COMMON_APPROVED';
    return common || objective.evidenceIds.length > 0 && objective.evidenceIds.every(id => context.student.evidence.some(source => source.id === id && source.confirmationStatus === 'confirmed_from_record'));
  });
  const commonCandidates = candidates.filter(objective => 'grounding' in objective && (objective.grounding as { kind?: string } | undefined)?.kind === 'COMMON_APPROVED');
  const usedActivities = new Set<string>(), usedObjectives = new Set<string>(), usedSemanticKeys = new Set<string>(), usedFunctions = new Map<PrimaryFunction, number>();
  const slots: InterviewPlanSlot[] = [];
  const limitations = ["주질문 후보 수는 오프라인 준비 예산이며 면접 종료 상한이나 대학의 공식 문항 수가 아닙니다.", "회차는 남은 시간과 실제 답변·승인 후보 상태에 따라 계속 진행합니다.", "대학·학과 인재상과 전형 평가요소는 별도 출처로 연결하며 공식 비중을 문항 수 비율이나 내부 답변 점수로 바꾸지 않습니다.", "준비 우선도는 지원처별 분석에서만 참조하며 학생의 답변 점수로 바꾸지 않습니다."];
  const topicFor = (objective: StudentObjectiveCandidate) => {
    const matching = topics.filter(topic => topic.functions.includes(objective.primaryFunction));
    const sourceText = context.student.evidence.filter(source => objective.evidenceIds.includes(source.id)).map(source => `${source.section} ${source.title} ${source.text}`).join(' ');
    if (['EVIDENCE', 'LIMIT'].includes(objective.primaryFunction)) return topics[4];
    if (['ROLE', 'VALUE'].includes(objective.primaryFunction)) return topics[2];
    if (['MOTIVE', 'CONNECTION'].includes(objective.primaryFunction)) return topics[3];
    return matching.find(topic => topic.signals.test(sourceText)) ?? matching[0] ?? topics[0];
  };
  for (let index = 0; index < Math.min(DEFAULT_POOL_OBJECTIVE_BUDGET, candidates.length); index++) {
    const preferred = topics[index % topics.length];
    // Keep approved common purposes available in the bank; the session still decides if/when to ask.
    const eligible = index < Math.min(2, commonCandidates.length) ? commonCandidates : candidates;
    const choices = eligible.filter(objective => !usedObjectives.has(objective.id) && !usedSemanticKeys.has('semanticKey' in objective && typeof objective.semanticKey === 'string' ? objective.semanticKey : objective.id)).map((objective, candidateIndex) => {
      const topic = topicFor(objective), uniqueActivity = !objective.activityIds.some(id => usedActivities.has(id));
      const priority = 'priority' in objective ? objective.priority : undefined;
      const priorityScore = priority === 'S' ? 8 : priority === 'A' ? 6 : priority === 'B' ? 3 : 0;
      return { objective, topic, score: Number(uniqueActivity) * 100 + Number(topic.area === preferred.area) * 30 - (usedFunctions.get(objective.primaryFunction) ?? 0) * 8 + priorityScore + ((candidateIndex + seed) % Math.max(1, candidates.length)) / Math.max(1, candidates.length) };
    });
    choices.sort((left, right) => right.score - left.score || left.objective.id.localeCompare(right.objective.id));
    const selected = choices[0];
    if (!selected) break;
    const { topic, objective } = selected, primaryFunction = objective.primaryFunction;
    usedObjectives.add(objective.id); objective.activityIds.forEach(id => usedActivities.add(id)); usedFunctions.set(primaryFunction, (usedFunctions.get(primaryFunction) ?? 0) + 1);
    const source = context.student.evidence.find(item => objective.evidenceIds.includes(item.id));
    const semanticKey = 'semanticKey' in objective && typeof objective.semanticKey === 'string' ? objective.semanticKey : objective.id;
    usedSemanticKeys.add(semanticKey);
    slots.push({ id: `objective-slot-${objective.id}`, index: index + 1, topicArea: topic.area, label: topic.label, evidenceIds: [...objective.evidenceIds], activityIds: [...objective.activityIds], primaryFunction, questionIntent: objective.targetDescription, depth: objective.depth, objective, semanticKey, interviewerId: topic.role === "academic" ? "interviewer-1" : "interviewer-2", interviewerRole: topic.role, schoolConnections: source ? connections(context, topic, source, primaryFunction) : [] });
  }
  if (!slots.length) throw new Error("검증된 학생부 근거에서 주질문 후보를 선정할 수 없습니다.");
  return { policyVersion: INTERVIEW_PLAN_POLICY_VERSION, durationSeconds, mainQuestionTarget: slots.length, slots, limitations, scheduling: 'time_based', purpose: 'candidate_pool' };
}

/** Old sessions retain their saved turn count instead of silently adopting the new policy. */
export function sessionMainQuestionTarget(session: Pick<InterviewSession, "mainQuestionTarget" | "plan" | "turns">, durationSeconds: number, legacyMainCount?: number) {
  return positiveInteger(session.mainQuestionTarget ?? session.plan?.mainQuestionTarget ?? session.turns.find(turn => Number.isSafeInteger(turn.mainCount) && turn.mainCount > 0)?.mainCount ?? legacyMainCount ?? mainQuestionTargetForDuration(durationSeconds), "주질문 목표");
}
export function currentPlanSlot(session: Pick<InterviewSession, "plan" | "turns">): InterviewPlanSlot | null {
  const previous = session.turns.at(-1);
  return previous ? session.plan?.slots.find(slot => slot.index === previous.mainIndex) ?? null : null;
}
export function nextMainPlanSlot(session: Pick<InterviewSession, "plan" | "turns">): InterviewPlanSlot | null {
  const nextIndex = session.turns.reduce((largest, turn) => Math.max(largest, turn.mainIndex), 0) + 1;
  return session.plan?.slots.find(slot => slot.index === nextIndex) ?? null;
}
export function mayAskFollowUp(session: InterviewSession, durationSeconds: number, maxFollowUps: number) {
  if (!Number.isInteger(maxFollowUps) || maxFollowUps < 0 || maxFollowUps > 2) throw new Error("꼬리질문 상한은 0~2이어야 합니다.");
  positiveInteger(durationSeconds, "면접 진행 시간");
  const previous = session.turns.at(-1);
  if (!previous || (session.runtime ? deliveredFollowUpCount(session, previous.parentMainQuestionId) : session.followUpCountByMainQuestion[previous.parentMainQuestionId] ?? 0) >= maxFollowUps) return false;
  if (session.plan?.scheduling === 'time_based') return durationSeconds * 1000 - session.elapsedMs > FOLLOW_UP_RESERVE_SECONDS * 1000;
  const target = sessionMainQuestionTarget(session, durationSeconds);
  const remainingMains = Math.max(0, target - previous.mainIndex);
  const reservedMs = (remainingMains * MAIN_QUESTION_RESERVE_SECONDS + FOLLOW_UP_RESERVE_SECONDS) * 1000;
  return durationSeconds * 1000 - session.elapsedMs > reservedMs;
}
