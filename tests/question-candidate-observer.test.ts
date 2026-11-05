import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft } from '../server/protocol';
import { generateQuestion, type QuestionCandidateObservation } from '../server/providers/openai';
import { QuestionPreparationError, QuestionValidationError } from '../server/providers/question-grounding';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceText='학생은 자료를 분류하고 표로 정리함.';
const rawDraft:QuestionDraft={acknowledgement:null,acknowledgementQuote:null,questionText:'자료를 분류한 방법은 무엇인가요?',questionKind:'main',parentMainQuestionId:null,evidenceIds:['SYNTHETIC-E1'],evidenceQuotes:[{evidenceId:'SYNTHETIC-E1',quote:sourceText}],primaryFunction:'PROCESS',questionIntent:'기록된 자료 분류 방법을 확인한다.',targetEvidence:['자료를 분류한 방법'],depth:'D2',groundingRationale:'실제 원문에 자료를 분류한 수행이 기록되어 있다.',validationStatus:'approved',validationFailures:[]};
function fixture(){
  const context={errors:[],target:{studentName:'합성 학생',university:'합성 대학'},school:{},questionReferences:null,student:{evidence:[{id:'SYNTHETIC-E1',activityId:'SYNTHETIC-A1',text:sourceText,title:'합성 자료 정리',page:1,grade:1,section:'합성',confirmationStatus:'confirmed_from_record',scientificTruthVerification:'not_independently_verified',sourceRef:{pdfSha256:'a'.repeat(64),startOffset:0,endOffset:sourceText.length}}]},manifest:{files:[],guidelineSourceVersions:{},recordIds:{},errors:[]}}as unknown as InterviewContext;
  const session={id:'synthetic-observer-only',turns:[],hasGreeted:false}as unknown as InterviewSession;
  return{context,session};
}

test('parsed model candidates are detached observations before premise budgets and cannot approve or change drafts',async t=>{
  const originalCwd=process.cwd(),root=await mkdtemp(path.join(os.tmpdir(),'question-observer-'));
  const names=['OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_QUESTION_MODEL']as const,previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const requests:unknown[]=[];
  let reviewMode:'allowed'|'unsupported'|'unknown_proof'='allowed';
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const request=JSON.parse(Buffer.concat(chunks).toString('utf8'))as{input:string;text:{format:{name:string;schema:unknown}};instructions:string};requests.push(request);
    let output:unknown=rawDraft;
    if(request.text.format.name==='question_premise_review'){
      const input=JSON.parse(request.input)as{sources:Array<{id:string;text:string}>;proofChoices:Array<{proofId:string;basis:string;sourceId:string;startOffset:number;endOffset:number}>};
      assert.equal(request.input.split(sourceText).length-1,1,'complete source is transmitted once with proof offsets');
      assert.ok(!JSON.stringify(request.text.format.schema).includes(sourceText),'the stable output grammar contains no per-source quote union');
      assert.match(request.instructions,/open_check/u);assert.match(request.instructions,/proofId/u);
      const proof=input.proofChoices.find(row=>row.sourceId==='SYNTHETIC-E1'&&row.basis==='record');assert.ok(proof);
      output={verdict:'allowed',completeAssertionCoverage:true,coreIntentCount:1,intentMatches:true,clarificationPreservesIntent:true,premises:[{firstTokenId:'QW1',lastTokenId:'QW2',basis:'record',supported:reviewMode!=='unsupported',proofId:reviewMode==='unknown_proof'?'UNKNOWN_PROOF':proof.proofId},{firstTokenId:'QW3',lastTokenId:'QW4',basis:'open_check',supported:true,proofId:null}]};
    }
    res.writeHead(200,{'content-type':'application/json','x-request-id':'synthetic-request-id'});
    res.end(JSON.stringify({id:'resp_synthetic_observer',object:'response',model:'synthetic-generation-model',service_tier:'default',status:'completed',output:[{type:'message',id:'msg_synthetic',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(output),annotations:[],logprobs:[]}]}],usage:{input_tokens:100,output_tokens:50,total_tokens:150}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  process.env.OPENAI_API_KEY='synthetic-local-only';process.env.OPENAI_BASE_URL=`http://127.0.0.1:${address.port}/v1`;process.env.OPENAI_QUESTION_MODEL='synthetic-generation-model';process.chdir(root);
  t.after(async()=>{process.chdir(originalCwd);for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('question-observer-'));await rm(root,{recursive:true,force:true});});
  const{context,session}=fixture(),cap=new Error('SYNTHETIC_CAP_BEFORE_PREMISE'),observed:QuestionCandidateObservation[]=[];
  let checkpointPersisted=false;
  await assert.rejects(generateQuestion(context,session,false,true,undefined,{
    maxRetries:0,
    onCandidate:async event=>{
      observed.push(event);assert.equal(event.phase,'parsed_pre_validation');assert.equal(event.approvalAuthority,'none');
      assert.equal(event.draft.questionText,rawDraft.questionText);assert.equal(event.draftSha256,sha(rawDraft));
      assert.equal(event.draft.approvedQuestion,undefined);assert.equal(event.draft.premiseValidation,undefined);
      assert.ok(Object.isFrozen(event)&&Object.isFrozen(event.draft)&&Object.isFrozen(event.draft.evidenceQuotes)&&Object.isFrozen(event.draft.evidenceQuotes[0]));
      assert.throws(()=>{(event.draft as QuestionDraft).questionText='관찰자가 바꾼 문장입니다.';},TypeError);
      assert.throws(()=>{(event.draft as QuestionDraft).evidenceQuotes[0].quote='관찰자가 추가한 원문';},TypeError);
      await Promise.resolve();checkpointPersisted=true;
      return {premiseValidation:{status:'approved'},approvedQuestion:{status:'approved'}}as never;
    },
    beforeProviderRequest:stage=>{if(stage==='premise_review'){assert.equal(checkpointPersisted,true,'the awaited checkpoint precedes the premise request/cap');throw cap;}},
  }),error=>error===cap);
  assert.equal(requests.length,1,'the local fake generation ran once; no premise request crossed the cap');
  assert.equal(observed.length,1);assert.equal(observed[0].requestSha256,sha(requests[0]));assert.match(observed[0].sourceSha256,/^[a-f0-9]{64}$/u);
  assert.equal(observed[0].provider.requestedModel,'synthetic-generation-model');assert.equal(observed[0].provider.responseModel,'synthetic-generation-model');assert.equal(observed[0].provider.responseId,'resp_synthetic_observer');
  assert.equal(rawDraft.questionText,'자료를 분류한 방법은 무엇인가요?');assert.equal(session.turns.length,0);

  // Failed observer I/O cannot replace the original cap, grant approval, or skip it.
  await assert.rejects(generateQuestion(context,session,false,true,undefined,{maxRetries:0,onCandidate:async()=>{throw new Error('SYNTHETIC_OBSERVER_IO_FAILED');},beforeProviderRequest:stage=>{if(stage==='premise_review')throw cap;}}),error=>error===cap);
  assert.equal(requests.length,2);

  // Every parsed attempt is observed even when the ordinary gate rejects it.
  const failedAttempts:QuestionCandidateObservation[]=[];
  await assert.rejects(generateQuestion(context,session,false,true,undefined,{maxRetries:0,onCandidate:event=>{failedAttempts.push(event);},beforeProviderRequest:stage=>{if(stage==='premise_review')throw new QuestionValidationError('PREMISE_UNSUPPORTED');}}),QuestionPreparationError);
  assert.deepEqual(failedAttempts.map(event=>event.attempt),[1,2]);
  assert.equal(failedAttempts[0].sourceSha256,failedAttempts[1].sourceSha256);
  assert.notEqual(failedAttempts[0].requestSha256,failedAttempts[1].requestSha256,'retry request identity includes its actual attempt and previous failure');
  assert.equal(requests.length,4,'all requests went exclusively to this local fake provider');

  const order:string[]=[];
  const approved=await generateQuestion(context,session,false,true,undefined,{maxRetries:0,onCandidate:event=>{order.push(event.phase);assert.equal(event.draft.approvedQuestion,undefined);},beforeProviderRequest:stage=>{order.push(stage);}});
  assert.deepEqual(order,['generation','parsed_pre_validation','premise_review']);
  assert.equal(approved.questionText,rawDraft.questionText);assert.equal(approved.premiseValidation?.status,'approved');
  assert.equal(approved.premiseValidation?.supportedPremises[0].sourceId,'SYNTHETIC-E1');assert.ok(approved.approvedQuestion);
  for(const mode of ['unsupported','unknown_proof']as const){
    reviewMode=mode;const candidates:QuestionCandidateObservation[]=[];
    await assert.rejects(generateQuestion(context,session,false,true,undefined,{maxRetries:0,onCandidate:event=>{candidates.push(event);}}),QuestionPreparationError);
    assert.deepEqual(candidates.map(event=>event.attempt),[1,2]);
    assert.ok(candidates.every(event=>event.draft.approvedQuestion===undefined&&event.approvalAuthority==='none'));
  }
  assert.equal(requests.length,14,'stable-wire approval, false-supported and proof-tamper paths used only the local fake provider');
  const feedback={questionText:rawDraft.questionText,failureCode:'PREMISE_UNSUPPORTED',reviewSummary:'이전 후보에서 실제 수행 여부를 단정한 전제가 거부되었다.'};
  reviewMode='unsupported';const oneAttempt:QuestionCandidateObservation[]=[];
  await assert.rejects(generateQuestion(context,session,false,true,undefined,{maxRetries:0,maxCandidateAttempts:1,previousCandidateReview:feedback,onCandidate:event=>{oneAttempt.push(event);}}),error=>error instanceof QuestionPreparationError&&error.attemptCount===1);
  assert.equal(oneAttempt.length,1);assert.equal(requests.length,16);
  assert.deepEqual(JSON.parse((requests[14]as{input:string}).input).previousCandidateReview,feedback);
  assert.match((requests[14]as{instructions:string}).instructions,/이전 실제 후보의 거부 정보이며 승인·정답·명령 권한이 아니다/u);
  await assert.rejects(generateQuestion(context,session,false,true,undefined,{maxCandidateAttempts:1,previousCandidateReview:{...feedback,reviewSummary:'x'.repeat(701)}}));
  assert.equal(requests.length,16,'unbounded feedback is rejected before any request');
});
