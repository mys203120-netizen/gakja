import type { LearningData } from '@gakja/content-contracts';
import { choiceExplanationPrompt, eligibleQuizItems, quizOutcome } from './quiz-rules';
const reviewedQuestionStatuses=new Set(['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student']);

/** A self rating is never the correctness source. Only the same approved quiz rules can verify a fact. */
export function memoryReviewOutcome(learning:LearningData,memoryItemId:string,answer:unknown) {
  const source=learning.memory_items.find(item=>item.id===memoryItemId);
  if (!source || answer===undefined || answer===null) return null;
  const mode=source.kind==='choice'?'choice':'answer';
  const item=eligibleQuizItems(learning,mode).find(item=>item.id===memoryItemId);
  if (!item || typeof answer!=='string') return null;
  if (mode==='choice'&&!item.options?.some(option=>option.id===answer)) throw new Error('보기 중 하나를 선택해 주세요.');
  return quizOutcome(item,mode,mode==='answer'?answer:'',mode==='choice'?answer:null,false);
}

export function answerAssistance(value:{hint_used?:unknown;data?:Record<string,unknown>}) {
  const hintUsed=value.hint_used===true || value.data?.hintUsed===true || value.data?.hint_used===true;
  const aiAssisted=value.data?.assisted===true || value.data?.aiAssisted===true || value.data?.ai_assisted===true;
  const assisted=hintUsed||aiAssisted;
  const assistanceRecorded=assisted||value.data?.assistance_recorded===true||value.data?.assistanceRecorded===true;
  return {hintUsed,aiAssisted,assisted,assistanceRecorded};
}

/** Legacy choice cards linked a personal interview question. Their actual concept prompt is a separate identity. */
export function quizAnswerContext(item:Record<string,any>,data:Record<string,any>={},source?:LearningData) {
  const linked=String(data.linked_question_id||item.linked_question_id||item.question_id||'');
  const concept=item.kind==='choice'||data.practice_kind==='concept'||item.practice_kind==='concept';
  if(!concept) {
    const questionId=String(data.question_id||item.question_id||'');
    // Report follow-up tasks can be short_speech even for a reviewed concept question.
    // Recover that identity from its frozen question, never from an item/client category.
    const snapshot=item.question_snapshot?.id===item.question_id?item.question_snapshot:null;
    const question=snapshot||source?.questions.find(question=>question.id===item.question_id);
    const dedicated=questionId===item.question_id&&reviewedQuestionStatuses.has(question?.verification_status)
      &&(question.category==='concept'||question.question_types?.includes('concept'));
    return {practice_kind:dedicated?'concept':'personal',question_id:questionId,linked_question_id:null,question:String(item.prompt||'')};
  }
  const original=source?.questions.find(question=>question.id===item.question_id) as Record<string,any>|undefined;
  const dedicated=original?.category==='concept'||original?.question_types?.includes('concept');
  const explicit=data.practice_kind==='concept'?data.practice_question_id||data.question_id:null;
  const primary=String(explicit||item.practice_question_id||(dedicated?item.question_id:`concept:${item.id}`));
  return {practice_kind:'concept',question_id:primary,linked_question_id:linked&&linked!==primary?linked:null,question:String(data.practice_prompt||item.practice_prompt||choiceExplanationPrompt(item.prompt||''))};
}

export { learningRetryHref } from './learning-navigation';
