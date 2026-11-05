import test from 'node:test';
import assert from 'node:assert/strict';
import { zodTextFormat } from 'openai/helpers/zod';
import type { QuestionDraft } from '../server/protocol';
import { buildQuestionPremiseReviewInput, buildStablePremiseProofOptions, finalizeQuestionPremiseReview, validateQuestionPremises } from '../server/providers/question-premises';
import { bindQuestionReviewSources, buildQuestionSpanReviewPayload, materializeQuestionSpanPremiseReview, questionSpanPremiseReviewWireSchema, questionWordRanges, QuestionSpanWireError, withAuthorizedQuestionReviewSources } from '../server/providers/question-span-wire';

const row={id:'ROW',text:'1 정보 2 85/78.4(9.4) B(162) 4'},header={id:'YEAR',text:'[1학년] 일반 교과 성적'},other={id:'OTHER',text:'학생이 다른 학년에 이수한 임의 과목이다.'};
function draft():QuestionDraft{return{acknowledgement:null,acknowledgementQuote:null,questionText:'1학년 정보 수업에서 학습한 방법이 있다면 무엇인가요?',questionKind:'main',parentMainQuestionId:null,evidenceIds:['ROW'],evidenceQuotes:[{evidenceId:'ROW',quote:row.text}],primaryFunction:'PROCESS',questionIntent:'기록된 정보 수업에서의 학습 방법을 확인한다.',targetEvidence:['도움이 된 학습 방법의 유무와 내용'],depth:'D2',groundingRationale:'실제 학생부 성적 행과 연결된 학습 경험을 열린 방식으로 확인한다.',validationStatus:'approved',validationFailures:[]};}
function reviewInput(){const ordinary=buildQuestionPremiseReviewInput(draft(),[row,header,other]);return withAuthorizedQuestionReviewSources(ordinary,[row,header,other],['ROW','YEAR']);}
function wire(){const input=reviewInput(),proofs=buildStablePremiseProofOptions(input);return{verdict:'allowed' as const,completeAssertionCoverage:true,coreIntentCount:1,intentMatches:true,clarificationPreservesIntent:true,premises:[{firstTokenId:'QW1',lastTokenId:'QW1',basis:'record' as const,supported:true,proofId:proofs.find(proof=>proof.sourceId==='YEAR')!.proofId},{firstTokenId:'QW2',lastTokenId:'QW2',basis:'record' as const,supported:true,proofId:proofs.find(proof=>proof.sourceId==='ROW')!.proofId},{firstTokenId:'QW3',lastTokenId:'QW7',basis:'open_check' as const,supported:true,proofId:null}]};}

test('word IDs restore exact Korean substrings, spacing, punctuation and UTF-16 ranges without fuzzy repair',()=>{
  const text='  1학년 정보\n  수업에서 “배운 것”을 설명해 주세요?  ',words=questionWordRanges(text);
  assert.deepEqual(words.map(word=>word.id),['QW1','QW2','QW3','QW4','QW5','QW6','QW7']);
  for(const word of words)assert.equal(text.slice(word.startOffset,word.endOffset),word.text);
  const input=reviewInput();input.question.questionText=text;
  const output={...wire(),premises:[{firstTokenId:'QW2',lastTokenId:'QW5',basis:'open_check' as const,supported:true,proofId:null}]};
  assert.equal(materializeQuestionSpanPremiseReview(output,input).premises[0].questionSpan,'정보\n  수업에서 “배운 것”을');
  const schema=JSON.stringify(zodTextFormat(questionSpanPremiseReviewWireSchema,'static_question_words').schema);
  assert.ok(!schema.includes(text)&&!schema.includes('QW1')&&!schema.includes(row.text),'one static grammar contains no word or substring enums');
});

test('unknown, reversed, incomplete and offset-shaped token references fail closed',()=>{
  const input=reviewInput(),valid=wire();
  for(const patch of[{firstTokenId:'QW999'},{lastTokenId:'not-a-token'},{firstTokenId:'QW3',lastTokenId:'QW1'},{firstTokenId:''},{firstTokenId:0},{startOffset:0}])assert.throws(()=>materializeQuestionSpanPremiseReview({...valid,premises:[{...valid.premises[0],...patch}]},input),QuestionSpanWireError);
});

test('a cited row retains its objective-authorized year header and used proofs bind into the final draft',async()=>{
  const original=draft(),before=JSON.stringify(original),ordinary=buildQuestionPremiseReviewInput(original,[row,header,other]);
  assert.deepEqual(ordinary.sources.map(source=>source.id),['ROW'],'the shared runtime builder keeps its original draft-only security contract');
  const input=reviewInput(),payload=buildQuestionSpanReviewPayload(input);
  assert.deepEqual(input.sources.map(source=>source.id),['ROW','YEAR']);
  assert.equal(JSON.stringify(payload).split(header.text).length-1,1);assert.equal(JSON.stringify(payload).split(row.text).length-1,1);
  assert.ok(payload.proofChoices.every(proof=>proof.sourceId!=='OTHER'));
  const canonical=materializeQuestionSpanPremiseReview(wire(),input),bound=bindQuestionReviewSources(original,canonical,input);
  assert.equal(JSON.stringify(original),before,'source binding returns a clone');
  assert.deepEqual(bound.evidenceIds,['ROW','YEAR']);assert.equal(bound.evidenceQuotes.find(quote=>quote.evidenceId==='YEAR')?.quote,header.text);
  assert.equal(bound.premiseValidation,undefined);assert.equal(bound.approvedQuestion,undefined,'source projection never grants approval');
  const stale=Object.assign(structuredClone(original),{premiseValidation:{status:'approved'},approvedQuestion:{status:'approved'},questionBlueprint:{version:'stale'}})as unknown as QuestionDraft;
  const rebound=bindQuestionReviewSources(stale,canonical,input);assert.equal(rebound.premiseValidation,undefined);assert.equal(rebound.approvedQuestion,undefined);assert.equal(rebound.questionBlueprint,undefined);
  await validateQuestionPremises({draft:bound,sources:[row,header],reviewModel:'synthetic-review',requestReview:async reviewed=>{assert.deepEqual(reviewed.sources.map(source=>source.id),['ROW','YEAR']);return canonical;}});
  const validation=bound.premiseValidation as QuestionDraft['premiseValidation'];
  assert.equal(validation?.status,'approved');assert.deepEqual(new Set(validation?.supportedPremises.map(proof=>proof.sourceId)),new Set(['ROW','YEAR']));
});

test('unauthorized, duplicate, missing or oversized sources cannot enter the closure or final citations',()=>{
  const input=buildQuestionPremiseReviewInput(draft(),[row,header]);
  for(const [sources,ids]of[[[row],['ROW','YEAR']],[[row,row],['ROW']],[[row,header],['ROW','ROW']],[[{...row,text:'x'.repeat(2201)}],['ROW']]]as const)assert.throws(()=>withAuthorizedQuestionReviewSources(input,[...sources],[...ids]),QuestionSpanWireError);
  assert.throws(()=>withAuthorizedQuestionReviewSources(input,[row,header],['YEAR']),QuestionSpanWireError);
  const valid=reviewInput(),canonical=materializeQuestionSpanPremiseReview(wire(),valid);
  canonical.premises[0].sourceId='OTHER';canonical.premises[0].supportQuote=other.text;
  assert.throws(()=>bindQuestionReviewSources(draft(),canonical,valid),QuestionSpanWireError);
});

test('source-ID restoration does not repair a false supported value or an inconsistent rewrite verdict',()=>{
  const input=reviewInput(),valid=wire();
  for(const changed of[{...valid,verdict:'rewrite'},{...valid,premises:valid.premises.map((row,index)=>({...row,supported:index!==0}))}]){
    const canonical=materializeQuestionSpanPremiseReview(changed,input);assert.throws(()=>finalizeQuestionPremiseReview(canonical,input,'synthetic-review'));
  }
  assert.throws(()=>materializeQuestionSpanPremiseReview({...valid,premises:[{...valid.premises[0],proofId:'UNKNOWN_PROOF'}]},input));
});

test('two used ranges of one source use its exact bounded text, never joined or truncated quotations',()=>{
  const source={id:'ROW',text:'첫 번째 근거를 기록함. 두 번째 근거를 따로 기록함.'},value=draft();value.evidenceQuotes=[{evidenceId:'ROW',quote:'첫 번째 근거를 기록함.'}];
  const input=buildQuestionPremiseReviewInput(value,[source]),canonical={verdict:'allowed',completeAssertionCoverage:true,coreIntentCount:1,intentMatches:true,clarificationPreservesIntent:true,premises:[{questionSpan:'정보',basis:'record',sourceId:'ROW',supportQuote:'두 번째 근거를 따로 기록함.',supported:true}]};
  const bound=bindQuestionReviewSources(value,canonical,input);assert.equal(bound.evidenceQuotes[0].quote,source.text);assert.equal(bound.evidenceQuotes[0].sourceEndOffset,source.text.length);
  assert.throws(()=>bindQuestionReviewSources(value,canonical,{...input,sources:[{...input.sources[0],text:'x'.repeat(2201)}]}),QuestionSpanWireError);
});
