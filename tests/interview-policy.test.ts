import assert from 'node:assert/strict';
import test from 'node:test';
import {INTERVIEW_CHARACTERS,interviewPolicy,interviewPressureForStart,interviewEvaluationEvidence,requestedInterviewHelper,generatedInterviewQuestion} from '../apps/web/src/lib/interview-policy';
import {parseInterviewFeedback} from '../apps/web/src/lib/interview-feedback';
import {interviewSetupHref} from '../apps/web/src/lib/interview-flow';

test('legacy sessions stay practice and real policy cannot enable help, typing or retry',()=>{
 assert.equal(interviewPolicy().mode,'practice');
 const real=interviewPolicy({sessionMode:'real',feedbackTiming:'turn'});assert.equal(real.helpAllowed,false);assert.equal(real.retryAllowed,false);assert.equal(real.textAllowed,false);assert.equal(real.feedbackTiming,'end');
 assert.equal(interviewPolicy().maxFollowups,1);assert.equal(interviewPolicy({pressure:true,maxFollowups:100}).maxFollowups,2);
 assert.equal(new URL(interviewSetupHref('chat',new URLSearchParams(),{sessionMode:'real'}),'https://fixture.test').searchParams.get('kind'),'video');
});
test('five distinctive named characters require a name plus help intent',()=>{
 assert.deepEqual(INTERVIEW_CHARACTERS.map(person=>person.name),['유나','도윤','하람','태오','서진']);
 assert.equal(new Set(INTERVIEW_CHARACTERS.map(person=>person.voice)).size,5);
 for(const person of INTERVIEW_CHARACTERS){assert.equal(requestedInterviewHelper(`${person.name}아, 도와줘`)?.id,person.id);assert.equal(requestedInterviewHelper(`${person.name}와 함께 활동했습니다.`),null);}
 assert.equal(requestedInterviewHelper('도움이 필요해요'),null);
});

test('curriculum pressure is authoritative for scheduled practice and real mode keeps student choice',()=>{
 const plan=(pressure?:boolean)=>({target:{automaticPractice:{hybrid:{pressure}}}});
 assert.equal(interviewPressureForStart({sessionMode:'practice',pressure:false},plan(true)),true);
 assert.equal(interviewPressureForStart({sessionMode:'practice',pressure:true},plan(false)),false);
 assert.equal(interviewPressureForStart({sessionMode:'practice',pressure:true,mode:'pressure'},plan()),false);
 assert.equal(interviewPressureForStart({sessionMode:'real',pressure:true},plan(false)),true);
 assert.equal(interviewPressureForStart({sessionMode:'real',pressure:false},plan(true)),false);
 assert.equal(interviewPressureForStart({pressure:true}),true);
});
test('new generated questions reject long or direct school-value requests instead of rewriting them',()=>{
 assert.equal(generatedInterviewQuestion('  실제로 맡은 역할은 무엇인가요?  '),'실제로 맡은 역할은 무엇인가요?');
 for(const value of ['설명해 주세요.'.repeat(20),'인재상과 어떻게 연결되나요?','실천적 사회인과 활동을 연결해 주세요.','[NEXT]','역할은 무엇인가요?\n성과는 무엇인가요?'])assert.equal(generatedInterviewQuestion(value,['실천적 사회인']),null);
});
test('recorded raw evidence cannot be replaced by corrected or assisted display text',()=>{
 const evidence=interviewEvaluationEvidence({answer:'제가 모든 일을 총괄했습니다.',originalAnswer:'음 제가 설문을 했습니다.',speechSource:{rawText:'음 음 저는 설문을, 설문을 했어요.',studentEdited:true},assisted:true,helpKinds:['hint']});
 assert.equal(evidence.answer,'음 음 저는 설문을, 설문을 했어요.');assert.equal(evidence.submittedAnswer,'제가 모든 일을 총괄했습니다.');assert.equal(evidence.source,'recorded_speech');assert.equal(evidence.assisted,true);
});
test('review recommendations require exact original answer evidence and never invent scores',()=>{
 const valid=parseInterviewFeedback(JSON.stringify({summary:'역할을 더 구체적으로 말해요.',needsReview:true,reason:'본인의 행동이 모호해요.',evidence:['팀이 했어요']}),'음 팀이 했어요.');assert.equal(valid.evaluation.needsReview,true);
 const invalid=parseInterviewFeedback(JSON.stringify({summary:'추가 확인',needsReview:true,reason:'근거 없음',evidence:['없던 성과']}),'실제 답변');assert.equal(invalid.evaluation.needsReview,null);assert.deepEqual(invalid.evaluation.evidence,[]);
 assert.equal(parseInterviewFeedback('형식이 다른 응답','답변').evaluation.needsReview,null);
});
test('a versioned four-part rubric only totals complete evidence and matches source quotes exactly',()=>{
 const answer='설문을 설계했고 결과를 비교했습니다.',sources=[{id:'s1',quote:'설문을 설계하고 결과를 비교함.'}];
 const criteria=['question_response','record_grounding','personal_action','structure'].map(id=>({id,score:2,reason:'기록과 발화에서 확인',evidence:['설문을 설계'],sourceEvidence:id==='record_grounding'?[{sourceId:'s1',quote:'설문을 설계'}]:[]}));
 const content={summary:'역할을 구체적으로 설명했어요.',needsReview:false,reason:'근거 확인',evidence:['설문을 설계'],criteria};
 const result=parseInterviewFeedback(JSON.stringify(content),answer,sources,[{kind:'evaluation',version:3,id:'guide3',body:'지침'}]);
 assert.equal(result.evaluation.rubric?.total,8);assert.equal(result.evaluation.rubric?.version,'interview-content-v1');assert.equal(result.evaluation.guidelineVersions[0].version,3);
 assert.equal(result.evaluation.compositionExample?.parts[0].text,'설문을 설계');assert.equal(result.evaluation.compositionExample?.parts[1].text,'설문을 설계');assert.match(result.evaluation.compositionExample?.parts.at(-1)?.label||'',/확인 필요/);
 const school=parseInterviewFeedback(JSON.stringify(content),answer,[{...sources[0],type:'school_talent'}]);assert.equal(school.evaluation.rubric?.criteria[1].score,null);assert.equal(school.evaluation.compositionExample,null,'school values cannot be presented as personal school-record evidence');
 criteria[1].sourceEvidence=[{sourceId:'s1',quote:'존재하지 않는 성과'}];const invalid=parseInterviewFeedback(JSON.stringify(content),answer,sources);assert.equal(invalid.evaluation.rubric?.criteria[1].score,null);assert.equal(invalid.evaluation.rubric?.total,null);assert.equal(invalid.evaluation.rubric?.assessedCount,3);assert.equal(invalid.evaluation.compositionExample,null);
});
