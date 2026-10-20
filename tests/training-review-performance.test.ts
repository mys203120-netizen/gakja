import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {applyReviewReflection,reconcileTrainingReviews,reviewQuestionKey,type ReviewAttempt,type ReviewQuestion,type ReviewState} from '../apps/web/src/lib/training-review';

const base=Date.parse('2026-10-21T00:00:00.000Z');
const stamp=(offset:number)=>new Date(base+offset).toISOString();
const question=(id:string,attempts:ReviewAttempt[]=[]):ReviewQuestion=>({id,targetId:'school',targetKey:'school-major-2027',sourceType:'personal',sourceVersion:2,category:'major',activityIds:['activity'],attempts});
const success=(id:string,offset:number):ReviewAttempt=>({id,at:stamp(offset),assistanceKnown:true,assisted:false,kind:'interview_answer'});
const reconcile=(questions:ReviewQuestion[],state?:ReviewState)=>reconcileTrainingReviews({questions,state,diagnostics:{},now:stamp(200_000)});
const history=(state:ReviewState)=>state.requests.map(({status:_,resolvedEvidenceIds:__,resolvedAt:___,resolvedQuestionKeys:____,resolvedEvidenceByQuestion:_____,...original})=>original);

test('10,000 adverse receipts resolve, reactivate and retain every original request with linear evidence reads',t=>{
 const count=10_000;let reads=0;
 const attempts=Array.from({length:count},(_,index):ReviewAttempt=>({id:'bad-'+index,get at(){if(++reads>count*4)throw Error('Evidence was normalized repeatedly instead of using its per-reconciliation index');return stamp(index);},assistanceKnown:true,assisted:index%2===0,outcome:index%2===0?undefined:false,kind:'interview_answer'}));
 const current=question('q',attempts),timings:Record<string,number>={};
 function measure<T>(label:string,run:()=>T){reads=0;const start=performance.now(),value=run();timings[label]=Math.round(performance.now()-start);assert.ok(reads<=count*3,`${label} folds source timestamps a bounded number of times`);return value;}
 const initial=measure('adverse',()=>reconcile([current]));
 assert.equal(initial.state.requests.length,count);assert.ok(initial.state.requests.every(r=>r.status==='active'));assert.equal(initial.questions[0].status,'active');
 const original=history(initial.state),independent=success('independent',count+1);current.attempts.push(independent);
 const complete=measure('resolved',()=>reconcile([current],initial.state));
 assert.equal(complete.state.requests.length,count);assert.ok(complete.state.requests.every(r=>r.status==='resolved'&&r.resolvedEvidenceIds[0]==='independent'));assert.equal(complete.questions[0].status,'resolved');assert.deepEqual(history(complete.state),original);
 independent.valid=false;
 const reopened=measure('invalidated',()=>reconcile([current],complete.state));
 assert.equal(reopened.questions[0].status,'active');assert.ok(reopened.state.requests.every(r=>r.status==='active'&&r.resolvedEvidenceIds.length===0));assert.deepEqual(history(reopened.state),original);
 independent.valid=true;
 const restored=measure('restored',()=>reconcile([current],reopened.state));assert.equal(restored.questions[0].status,'resolved');assert.deepEqual(restored.state,complete.state);
 independent.assisted=true;
 const corrected=measure('help-corrected',()=>reconcile([current],restored.state));assert.equal(corrected.questions[0].status,'active');assert.equal(corrected.state.requests.length,count+1);assert.deepEqual(history({...corrected.state,requests:corrected.state.requests.slice(0,count)}),original);
 independent.assisted=false;
 const withdrawn=measure('trigger-withdrawn',()=>reconcile([current],corrected.state));assert.equal(withdrawn.questions[0].status,'resolved');assert.equal(withdrawn.state.requests.length,count+1);assert.equal(withdrawn.state.requests[count].status,'withdrawn');
 t.diagnostic(`10k receipt reconciliation milliseconds: ${JSON.stringify(timings)}`);
});

test('qualified search excludes unknown-date baselines and one receipt shared by multiple questions',()=>{
 const first=question('a',[success('old',1)]),second=question('b',[success('old',1)]);
 const legacy={sessionId:'legacy',targetKey:first.targetKey,sourceType:'personal',sourceVersion:2,focusCategories:['major']};
 const initial=reconcileTrainingReviews({questions:[first,second],diagnostics:{school:legacy},now:stamp(10)});
 first.attempts[0].at=stamp(50);second.attempts[0].at=stamp(50);
 first.attempts.push(success('shared',20));second.attempts.push(success('shared',20),success('second',30));
 const done=reconcileTrainingReviews({questions:[first,second],state:initial.state,diagnostics:{school:legacy},now:stamp(40)});
 assert.equal(done.state.requests.length,1);assert.equal(done.state.requests[0].status,'resolved');assert.deepEqual(done.state.requests[0].resolvedEvidenceIds,['shared','second']);assert.equal(done.state.requests[0].resolvedAt,stamp(30));
 second.attempts.pop();
 const reopened=reconcileTrainingReviews({questions:[first,second],state:done.state,diagnostics:{school:legacy},now:stamp(40)});
 assert.equal(reopened.state.requests[0].status,'active');assert.deepEqual(reopened.state.requests[0].resolvedEvidenceIds,['shared']);assert.equal(reopened.questions[0].status,'resolved');assert.equal(reopened.questions[1].status,'active');
});

test('duplicate retries preserve earliest timestamp, first kind and conservative merged facts',()=>{
 const current=question('q'),diagnostic={sessionId:'diagnosis',targetKey:current.targetKey,sourceType:'personal',sourceVersion:2,reviewSchemaVersion:1};
 const state=applyReviewReflection({questions:[current],targetId:'school',diagnostic,needsReviewQuestionIds:['q'],focusCategories:[],now:stamp(10)});
 current.attempts=[success('retry',20),{...success('retry',5),kind:'quiz_response',outcome:true}];
 const beforeRequest=reconcile([current],state);assert.equal(beforeRequest.questions[0].status,'active');
 current.attempts=[{...success('retry',20),outcome:true},{...success('retry',30),kind:'quiz_response',outcome:true}];
 const completed=reconcile([current],state);assert.equal(completed.questions[0].status,'resolved');assert.equal(completed.state.requests[0].resolvedAt,stamp(20));
 current.attempts.push({...success('retry',40),valid:false});
 assert.equal(reconcile([current],completed.state).questions[0].status,'active');
 current.attempts=[{...success('retry',20),kind:'quiz_response'},{...success('retry',30),outcome:true}];
 assert.equal(reconcile([current],state).questions[0].status,'active','a first quiz kind with unknown correctness is not promoted by a later interview-shaped copy');
});

test('same-time ordering and per-question source indexes preserve receipt assignment',()=>{
 const a=question('a'),b=question('b'),diagnostic={sessionId:'diagnosis',targetKey:a.targetKey,sourceType:'personal',sourceVersion:2,reviewSchemaVersion:1};
 const state=applyReviewReflection({questions:[a,b],targetId:'school',diagnostic,needsReviewQuestionIds:[],focusCategories:['major'],now:stamp(10)});
 a.attempts=[success('z',20),success('a',20)];b.attempts=[success('a',20),success('b',20)];
 const result=reconcile([a,b],state);assert.deepEqual(result.state.requests[0].resolvedEvidenceByQuestion,{[reviewQuestionKey(a)]:'a',[reviewQuestionKey(b)]:'b'});assert.equal(result.state.requests[0].resolvedAt,stamp(20));
 const first=question('same',[{...success('orphan',20),assisted:true}]),last=question('same');
 const duplicateKey=reconcile([first,last]);assert.equal(duplicateKey.state.requests.length,1);assert.equal(duplicateKey.state.requests[0].status,'withdrawn','as before, the last current question with an identical scope supplies authoritative evidence');
});
