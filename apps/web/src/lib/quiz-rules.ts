import type { LearningData, QuizSnapshotItem } from '@gakja/content-contracts';
import { quizSnapshotItem, reviewedShortAnswerMatches } from '@gakja/content-contracts';
export type QuizMode = 'choice' | 'answer' | 'oral';
export type SessionItem = QuizSnapshotItem & { modelAnswer: string; practice_kind?: 'concept'|'personal'; practice_prompt?: string; practice_question_id?: string; linked_question_id?: string | null; sourceQuotes?: { id: string; text: string; area?: string; page?: number }[] };
const blocked = new Set(['needs_confirmation','student_says_different','cannot_confirm']);
const verified = new Set(['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student']);
function verifiedChoices(item:LearningData['memory_items'][number]) {
  return item.kind === 'choice' && item.options?.length === 4 && new Set(item.options.map(o=>o.id)).size===4
    && item.options.every(o=>typeof o.text==='string'&&o.text.trim()) && item.options.some(o=>o.id===item.correct_option_id)
    && item.evaluation_method==='reviewed_correct_answer' && item.category!=='experiential' && !blocked.has(item.verification_status);
}
export function choiceExplanationPrompt(prompt:string) {
  return prompt.replace(/설명하는 문장을 골라보세요[.!]?$/,'내 말로 설명해 주세요.').replace(/방법으로 알맞은 것은[?？]?$/,'방법을 내 말로 설명해 주세요.').replace(/문장을 골라보세요[.!]?$/,'내용을 내 말로 설명해 주세요.').replace(/골라보세요[.!]?$/,'내 말로 설명해 주세요.');
}
/** An old MCQ linked to an unrelated personal question must never borrow that rubric. */
export function quizPracticeIdentity(item:SessionItem) {
  if(item.kind!=='choice'&&item.practice_kind!=='concept')return {questionId:item.question_id,practiceKind:'personal' as const,practicePrompt:item.prompt,linkedQuestionId:null};
  const questionId=item.practice_question_id || (item.practice_kind==='concept'?item.question_id:`concept:${item.id}`);
  return {questionId,practiceKind:'concept' as const,practicePrompt:item.practice_prompt||choiceExplanationPrompt(item.prompt),linkedQuestionId:item.linked_question_id || (item.question_id!==questionId?item.question_id:null)};
}
export function eligibleQuizItems(learning: LearningData, mode: QuizMode): SessionItem[] {
  return (learning.memory_items || []).filter(item => {
    if (!verified.has(item.verification_status)) return false;
    if (mode !== 'choice') return item.kind==='choice'?verifiedChoices(item):item.kind !== 'order';
    return verifiedChoices(item);
  }).map(item => {
    const script = learning.answer_scripts?.find(script => script.id === item.answer_script_id);
    const approved = script && script.question_id === item.question_id && verified.has(script.verification_status)
      && !(script.claims || []).some(claim => blocked.has(claim.verification_status) || blocked.has(claim.confirmation_status || ''));
    const question = learning.questions?.find(question => question.id === item.question_id);
    // A missing/disputed linked script cannot be bypassed with a fallback hint.
    const modelAnswer = item.answer_script_id ? approved ? script.text : '' : item.kind==='choice' ? item.options?.find(option=>option.id===item.correct_option_id)?.text||'' : item.back || item.accepted_answers?.[0] || '';
    const sourceQuotes = (item.source_ref_ids || []).flatMap(id => {
      const source = learning.source_refs?.find(source => source.id === id);
      return source?.quote ? [{ id, text: source.quote, area: source.area, page: source.page }] : [];
    });
    const explanationPrompt=choiceExplanationPrompt(item.prompt);
    const conceptQuestion=item.kind==='choice'&&question&&verified.has(question.verification_status)&&question.question_types?.includes('concept')&&question.prompt.trim()===explanationPrompt.trim()&&question.source_ref_ids?.some(id=>item.source_ref_ids.includes(id))?question:null;
    const practiceQuestionId=item.kind==='choice'?conceptQuestion?.id||`concept:${item.id}`:item.question_id;
    return { ...quizSnapshotItem(item, learning), question_id:practiceQuestionId, linked_question_id:item.question_id!==practiceQuestionId?item.question_id:null,
      practice_kind:item.kind==='choice'?'concept':'personal',practice_prompt:item.kind==='choice'?explanationPrompt:question?.prompt||item.prompt,practice_question_id:practiceQuestionId,
      required_meaning_elements:item.kind==='choice'?conceptQuestion?.answer_elements||[]:quizSnapshotItem(item,learning).required_meaning_elements,
      prompt: mode !== 'choice' && item.kind==='choice' ? explanationPrompt : mode !== 'choice' && item.kind === 'keyword_recall' ? question?.prompt || item.prompt : item.prompt, modelAnswer, sourceQuotes };
  });
}
export function firstSentenceHint(value: string): { first: string; rest: string } {
  const text = value.trim();
  const match = text.match(/^[\s\S]*?(?:[.!?。！？](?=\s|$)|\n|$)/);
  const first = (match?.[0] || text).trim();
  return { first, rest: text.slice((match?.[0] || text).length).trim() };
}
export function remainingChoiceMs(deadline: string | Date | null, nowMs: number, storedMs = 10_000) {
  return deadline ? Math.max(0, Math.min(10_000, new Date(deadline).getTime() - nowMs)) : Math.max(0, Math.min(10_000, storedMs));
}
export function quizOutcome(item: SessionItem, mode: QuizMode, response: string, selected: string | null, timedOut: boolean): boolean | null {
  if (mode === 'choice') return !timedOut && selected === item.correct_option_id;
  if (timedOut || mode === 'oral' || item.kind !== 'short_answer' || item.evaluation_method !== 'reviewed_correct_answer' || item.category === 'experiential' || blocked.has(item.verification_status)) return null;
  return reviewedShortAnswerMatches(item, response);
}
