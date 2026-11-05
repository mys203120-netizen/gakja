/** Q0 transport only: literal word ranges and authorized source ID closure.
 * Meaning, support and verdicts remain the independent reviewer's decisions. */
import { z } from 'zod';
import type { QuestionDraft } from '../protocol';
import { canonicalizeQuestionCitations, findVerifiedSourceQuote, type GroundingSource } from './question-grounding';
import { buildRuntimeReviewPayload } from './natural-question';
import { materializeStablePremiseReview, QuestionPremiseReviewError, questionPremiseReviewSchema, stableQuestionPremiseReviewSchema, type QuestionPremiseReviewInput } from './question-premises';

export const QUESTION_SPAN_WIRE_VERSION='question-word-span-proof-id-v2';
export const QUESTION_WORD_SPAN_RULES=`이번 Q0 검수 출력에는 questionSpan 문자열을 다시 쓰지 않는다. questionWordRanges는 실제 질문의 공백으로 나뉜 리터럴 단어 구간이다. 각 전제의 연속 구간을 첫 단어 firstTokenId와 마지막 단어 lastTokenId로 지정한다. 같은 단어이면 두 ID가 같고, 두 ID 사이의 원문 전체가 그대로 복원된다. 단어를 고치거나 생략·이어붙이거나 별도 오프셋을 계산하지 않는다. 해당 구간을 의미적으로 입증하는지는 여전히 검수 모델이 판단한다. proofId는 같은 입력의 proofChoices만 고른다. verdict=allowed는 전체 전제 검수가 끝나고 모든 구간의 supported가 true일 때만 가능하다. 반대로 coreIntentCount=1, intentMatches=true, completeAssertionCoverage=true이고 모든 전제가 supported=true이며 별도의 실제 불확실성도 없다면 verdict는 allowed다. rewrite/uncertain은 실제 실패하거나 알 수 없는 검수 기준에 대응해야 한다. 하나라도 supported=false이거나 의도/범위가 불명확하면 allowed를 사용하지 말고 rewrite 또는 uncertain으로 유지한다. 이 지시는 실패한 전제를 true로 고치거나 서버가 모순된 verdict를 승인으로 덮으라는 뜻이 아니다.`;
export interface QuestionWordRange {id:string;text:string;startOffset:number;endOffset:number}
export function questionWordRanges(questionText:string):QuestionWordRange[]{
  return [...questionText.matchAll(/\S+/gu)].map((match,index)=>({id:`QW${index+1}`,text:match[0],startOffset:match.index!,endOffset:match.index!+match[0].length}));
}
export class QuestionSpanWireError extends QuestionPremiseReviewError{
  constructor(readonly spanReason:'schema_invalid'|'unknown_token'|'reverse_tokens'|'source_closure_invalid'|'source_not_authorized'|'source_proof_invalid'){super('REVIEW_SCHEMA_INVALID');}
}
const premise=stableQuestionPremiseReviewSchema.shape.premises.element.omit({questionSpan:true}).extend({firstTokenId:z.string().min(1).max(24),lastTokenId:z.string().min(1).max(24)}).strict();
/** Static grammar: O(n) word ranges travel in the input, never O(n²) enums. */
export const questionSpanPremiseReviewWireSchema=stableQuestionPremiseReviewSchema.omit({premises:true}).extend({premises:z.array(premise).max(12)}).strict();
function assertSourceBounds(sources:GroundingSource[]){
  if(sources.length>6||new Set(sources.map(source=>source.id)).size!==sources.length||sources.some(source=>!source.text.trim()||source.text.length>2200))throw new QuestionSpanWireError('source_closure_invalid');
}

/** Add only the bounded source set already authorized by the selected objective.
 * Existing draft citations are still checked by the ordinary source validator. */
export function withAuthorizedQuestionReviewSources(input:QuestionPremiseReviewInput,allowedSources:GroundingSource[],authorizedSourceIds:readonly string[]):QuestionPremiseReviewInput{
  if(input.question.questionKind!=='main'||authorizedSourceIds.length>6||new Set(authorizedSourceIds).size!==authorizedSourceIds.length)throw new QuestionSpanWireError('source_closure_invalid');
  const sources=authorizedSourceIds.map(id=>{
    const matches=allowedSources.filter(source=>source.id===id);
    if(matches.length!==1||!matches[0].text.trim()||matches[0].text.length>2200)throw new QuestionSpanWireError('source_closure_invalid');
    return{id:matches[0].id,text:matches[0].text,status:'record_only_not_scientific_verification' as const};
  });
  assertSourceBounds(sources);
  if(input.sources.some(old=>!sources.some(source=>source.id===old.id&&source.text===old.text)))throw new QuestionSpanWireError('source_not_authorized');
  return{...structuredClone(input),sources};
}
export function buildQuestionSpanReviewPayload(input:QuestionPremiseReviewInput){
  return{...buildRuntimeReviewPayload(input),questionWordRanges:questionWordRanges(input.question.questionText),questionSpanWireVersion:QUESTION_SPAN_WIRE_VERSION};
}
/** Restore exact UTF-16 substrings before the unchanged canonical proof gate. */
export function materializeQuestionSpanPremiseReview(output:unknown,input:QuestionPremiseReviewInput){
  const parsed=questionSpanPremiseReviewWireSchema.safeParse(output);if(!parsed.success)throw new QuestionSpanWireError('schema_invalid');
  const words=new Map(questionWordRanges(input.question.questionText).map(word=>[word.id,word]));
  const premises=parsed.data.premises.map(({firstTokenId,lastTokenId,...row})=>{
    const first=words.get(firstTokenId),last=words.get(lastTokenId);
    if(!first||!last)throw new QuestionSpanWireError('unknown_token');
    if(first.startOffset>last.startOffset)throw new QuestionSpanWireError('reverse_tokens');
    return{...row,questionSpan:input.question.questionText.slice(first.startOffset,last.endOffset)};
  });
  return materializeStablePremiseReview({...parsed.data,premises},input);
}

/** Attach only exact record quotes actually selected by a supported review row.
 * No verdict is altered and this function creates no approval/blueprint trace. */
export function bindQuestionReviewSources(draft:QuestionDraft,review:unknown,input:QuestionPremiseReviewInput):QuestionDraft{
  assertSourceBounds(input.sources);
  const parsed=questionPremiseReviewSchema.parse(review),bound=structuredClone(draft);
  // A changed source set must pass the fresh canonical review and contract
  // builder. A cached approval must never survive as this helper's authority.
  delete bound.premiseValidation;delete bound.approvedQuestion;delete bound.questionBlueprint;
  const sources=new Map(input.sources.map(source=>[source.id,source]));
  if(bound.evidenceIds.some(id=>!sources.has(id)))throw new QuestionSpanWireError('source_not_authorized');
  for(const row of parsed.premises){
    if(row.basis!=='record'||!row.supported)continue;
    if(!row.sourceId||!row.supportQuote)throw new QuestionSpanWireError('source_proof_invalid');
    const source=sources.get(row.sourceId);if(!source)throw new QuestionSpanWireError('source_not_authorized');
    const proof=findVerifiedSourceQuote(source.text,row.supportQuote);if(!proof)throw new QuestionSpanWireError('source_proof_invalid');
    const previous=bound.evidenceQuotes.find(quote=>quote.evidenceId===source.id);
    if(!bound.evidenceIds.includes(source.id))bound.evidenceIds.push(source.id);
    if(!previous){const quote=proof.quote.length>=4?proof.quote:source.text;if(quote.length<4)throw new QuestionSpanWireError('source_proof_invalid');bound.evidenceQuotes.push({evidenceId:source.id,quote});}
    else if(!previous.quote.includes(proof.quote)){
      // Distinct used ranges from one authorized source need its actual complete
      // bounded text, not concatenated quotations or a fabricated span.
      previous.quote=proof.quote.includes(previous.quote)?proof.quote:source.text;
    }
  }
  if(bound.evidenceIds.length>6)throw new QuestionSpanWireError('source_closure_invalid');
  return canonicalizeQuestionCitations(bound,input.sources);
}
