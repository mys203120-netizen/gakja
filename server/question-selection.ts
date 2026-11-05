import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { InterviewContext } from './data/load-interview-context';
import type { InterviewSession } from './protocol';
import { QUESTION_SELECTION_POLICY_VERSION, type InterviewPlan, type InterviewPlanSlot } from './interview-planner';
import { syntheticInterviewProvenance } from './interviewer-quality';
import type { QuestionPurposeLineageSnapshot } from './data/question-purpose-lineage';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (text: string) => text.normalize('NFC').replace(/\s|[.!?。？]/gu, '');
export const GUIDEBOOK_EXPOSURE_REGISTRY = 'data/publications/guidebook-exposures.json';
export interface QuestionSelectionScope { ownerId: string; studentId: string; supportTargetId: string }
export interface PublishedQuestionExposure {
  questionId: string; questionText: string; semanticKey: string;
  /** Reviewed links survive new IDs/revisions; never guessed by activity/function equality. */
  semanticAliases?: string[];
}
export interface GuidebookExposure {
  status: 'not_published' | 'published' | 'mapping_required';
  registryStatus: 'absent' | 'loaded' | 'explicit_fixture';
  scope: QuestionSelectionScope;
  publicationRevision: string | null;
  questions: PublishedQuestionExposure[];
  reason: string;
}
export interface QuestionSelectionOptions {
  sessionSeed?: string;
  history?: readonly InterviewSession[];
  mode?: 'mock' | 'practice';
  exposure?: GuidebookExposure;
  scope?: QuestionSelectionScope;
  purposeLineage?: QuestionPurposeLineageSnapshot;
}
export function questionSelectionScope(context: Pick<InterviewContext, 'target' | 'student'> & Partial<Pick<InterviewContext, 'school'>>): QuestionSelectionScope {
  const student = context.student as typeof context.student & { studentId?: string; ownerId?: string };
  return { ownerId: student.ownerId ?? 'local-development-owner', studentId: student.studentId ?? 'local-development-student', supportTargetId: context.school?.interview?.id ?? hash(context.target) };
}
const sameScope = (a: QuestionSelectionScope, b: QuestionSelectionScope) => a.ownerId === b.ownerId && a.studentId === b.studentId && a.supportTargetId === b.supportTargetId;
export async function loadGuidebookExposure(context: InterviewContext, root = process.cwd(), options: { scope?: QuestionSelectionScope } = {}): Promise<GuidebookExposure> {
  const scope = options.scope ?? questionSelectionScope(context);
  let text: string;
  try { text = await readFile(path.resolve(root, GUIDEBOOK_EXPOSURE_REGISTRY), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { status: 'not_published', registryStatus: 'absent', scope, publicationRevision: null, questions: [], reason: '이 로컬 저장소에는 가이드북 공개 매니페스트가 없습니다. 공개 서비스 연동을 구현한 것으로 간주하지 않습니다.' };
  }
  try {
    const registry = JSON.parse(text) as { schemaVersion?: string; publications?: Array<{ scope: QuestionSelectionScope; status: string; publicationRevision: string; questions: PublishedQuestionExposure[] }> };
    if (registry.schemaVersion !== 'guidebook-exposure-v1' || !Array.isArray(registry.publications)) throw new Error('INVALID_EXPOSURE_REGISTRY');
    const entries = registry.publications.filter(entry => entry.scope && sameScope(entry.scope, scope) && entry.status === 'published');
    if (!entries.length) return { status: 'not_published', registryStatus: 'loaded', scope, publicationRevision: null, questions: [], reason: '해당 소유자·학생·지원처에 공개된 가이드북이 없습니다.' };
    if (entries.some(entry => !entry.publicationRevision || !Array.isArray(entry.questions) || entry.questions.some(question => !question.questionId || !question.questionText || !question.semanticKey))) throw new Error('PUBLICATION_MAPPING_REQUIRED');
    return { status: 'published', registryStatus: 'loaded', scope, publicationRevision: entries.map(entry => entry.publicationRevision).join('+'), questions: entries.flatMap(entry => entry.questions), reason: '현재 및 이전 공개 발행본의 검증된 목적 계보를 함께 적용합니다. 실제 열람 여부로 제외를 해제하지 않습니다.' };
  } catch {
    return { status: 'mapping_required', registryStatus: 'loaded', scope, publicationRevision: null, questions: [], reason: '공개 매니페스트 또는 확인 목적의 계보를 검증할 수 없습니다. 공개 이력이 없는 것으로 우회하지 않습니다.' };
  }
}
export function slotSemanticKey(slot: InterviewPlanSlot) { return slot.semanticKey ?? slot.objective?.id ?? hash({ sources: slot.evidenceIds, intent: canonical(slot.questionIntent), function: slot.primaryFunction }); }
function turnSemanticKey(turn: InterviewSession['turns'][number]) {
  return turn.metadata.selectionTrace?.semanticKey ?? turn.metadata.questionBlueprint?.clusterObjective.id ?? null;
}
export function selectionEligibility(slot: InterviewPlanSlot, questionText: string, options: QuestionSelectionOptions, sessionTurns: InterviewSession['turns'] = []) {
  const semanticKey = slotSemanticKey(slot), exposure = options.exposure;
  if (options.mode !== 'practice' && exposure?.status === 'mapping_required') return { allowed: false, reason: 'PUBLICATION_MAPPING_REQUIRED' };
  if (options.mode !== 'practice' && exposure?.status === 'published') {
    if (options.scope && !sameScope(exposure.scope, options.scope)) return { allowed: false, reason: 'EXPOSURE_SCOPE_MISMATCH' };
    if (exposure.questions.some(question => canonical(question.questionText) === canonical(questionText))) return { allowed: false, reason: 'GUIDEBOOK_SAME_UTTERANCE' };
    if (exposure.questions.some(question => question.semanticKey === semanticKey || question.semanticAliases?.includes(semanticKey))) return { allowed: false, reason: 'GUIDEBOOK_SAME_VERIFICATION_TARGET' };
  }
  if (sessionTurns.some(turn => turnSemanticKey(turn) === semanticKey || canonical(turn.questionText) === canonical(questionText))) return { allowed: false, reason: 'CURRENT_SESSION_ALREADY_ASKED' };
  return { allowed: true, reason: 'UNASKED_IN_CURRENT_SESSION' };
}
/** Eligibility does not certify a human interview when old provenance is absent. */
export function questionHistoryEligibility(session: InterviewSession, target: unknown, options: Pick<QuestionSelectionOptions, 'scope'> = {}) {
  const provenance = syntheticInterviewProvenance(session);
  if (provenance.syntheticTest === true) return { allowed: false, reason: 'EXPLICIT_SYNTHETIC_SESSION', provenance };
  if (JSON.stringify(session.target) !== JSON.stringify(target)) return { allowed: false, reason: 'HISTORY_TARGET_MISMATCH', provenance };
  if (options.scope && (!session.plan?.selectionContext?.scope || !sameScope(session.plan.selectionContext.scope, options.scope))) return { allowed: false, reason: 'HISTORY_SCOPE_UNVERIFIED_OR_MISMATCHED', provenance };
  return { allowed: true, reason: provenance.syntheticTest === null ? 'HISTORY_PROVENANCE_UNKNOWN' : 'HISTORY_NOT_MARKED_SYNTHETIC', provenance };
}
function applicableHistory(target: unknown, options: QuestionSelectionOptions) {
  return (options.history ?? []).filter(session => questionHistoryEligibility(session, target, options).allowed);
}
export function rankQuestionSlots(slots: InterviewPlanSlot[], target: unknown, options: QuestionSelectionOptions): InterviewPlanSlot[] {
  const history = applicableHistory(target, options);
  const lineage = options.purposeLineage;
  if (lineage && (!options.scope || !sameScope(lineage.scope, options.scope) || JSON.stringify(lineage.target) !== JSON.stringify(target))) throw new Error('QUESTION_PURPOSE_LINEAGE_SCOPE_MISMATCH');
  const previousPurposes = new Map(lineage?.links.flatMap(link => link.previousSemanticKeys.map(key => [key, link] as const)) ?? []);
  const uses = new Map<string, number>();
  const latest = new Map<string, number>();
  for (const session of history) for (const turn of session.turns) {
    if (turn.questionKind !== 'main') continue;
    if (!session.questionPresentations?.some(event => event.turnId === turn.id && event.startedAtMs !== null && Number.isFinite(event.startedAtMs))) continue;
    const previousKey = turnSemanticKey(turn), relation = previousKey ? previousPurposes.get(previousKey) : undefined;
    const previousBank = relation ? lineage?.previousBanks.find(bank => bank.key === session.plan?.poolKey && bank.contentSha256 === session.plan.poolContentSha256) : undefined;
    const reviewedQuestion = previousBank && relation?.previousQuestions.some(question => question.bankKey === previousBank.key && question.bankKey === turn.metadata.selectionTrace?.bankKey && question.candidateId === turn.metadata.selectionTrace?.bankCandidateId && question.semanticKey === previousKey && question.questionSha256 === createHash('sha256').update(turn.questionText).digest('hex'));
    const key = previousKey ? reviewedQuestion ? relation!.currentSemanticKey : previousKey : null; if (key) uses.set(key, (uses.get(key) ?? 0) + 1);
    if (key) latest.set(key, Math.max(latest.get(key) ?? 0, Date.parse(session.createdAt) || 0));
  }
  // Equal-use purposes rotate by verified exposure recency before the seed.
  // An activity/function match alone never merges different purposes.
  const ranked = slots.map(slot => ({ slot, used: uses.get(slotSemanticKey(slot)) ?? 0, last: latest.get(slotSemanticKey(slot)) ?? 0, rank: hash(`${options.sessionSeed ?? ''}:${slotSemanticKey(slot)}`) }));
  ranked.sort((a, b) => a.used - b.used || a.last - b.last || a.rank.localeCompare(b.rank));
  // Interleave source areas without forcing quotas or an interviewer A-B sequence.
  const remaining = [...ranked], result: InterviewPlanSlot[] = [];
  while (remaining.length) {
    const minimumUses = remaining[0].used;
    const minimumRecency = remaining.find(item => item.used === minimumUses)!.last;
    // Topic interleaving is a tie-breaker, never a reason to repeat a recently
    // exposed purpose before an equally used but older purpose.
    const alternatives = remaining.filter(item => item.used === minimumUses && item.last === minimumRecency);
    const previous = result.at(-1);
    const chosen = alternatives.find(item => item.slot.topicArea !== previous?.topicArea && !item.slot.activityIds.some(id => previous?.activityIds.includes(id))) ?? alternatives[0];
    remaining.splice(remaining.indexOf(chosen), 1); result.push(chosen.slot);
  }
  return result;
}
export function sessionPlanFromPool(pool: InterviewPlan, target: unknown, bank: { key: string; contentSha256: string }, options: QuestionSelectionOptions): InterviewPlan {
  if (options.purposeLineage && (options.purposeLineage.bankKey !== bank.key || options.purposeLineage.bankContentSha256 !== bank.contentSha256)) throw new Error('QUESTION_PURPOSE_LINEAGE_BANK_MISMATCH');
  const slots = rankQuestionSlots(pool.slots, target, options).map((slot, index) => ({ ...structuredClone(slot), candidateSlotId: slot.id, index: index + 1 }));
  return { ...structuredClone(pool), purpose: 'session', scheduling: 'time_based', poolKey: bank.key, poolContentSha256: bank.contentSha256, selectionPolicyVersion: QUESTION_SELECTION_POLICY_VERSION, mode: options.mode ?? 'mock', slots, mainQuestionTarget: slots.length, selectionContext: { scope: options.scope, exposure: options.exposure ? structuredClone(options.exposure) : undefined, purposeLineage: options.purposeLineage ? structuredClone(options.purposeLineage) : undefined, historySessionIds: applicableHistory(target, options).map(session => session.id) } };
}
