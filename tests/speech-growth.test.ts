import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpeech,analyzeTranscript,validateSpeechTelemetry } from '../apps/web/src/lib/speech-analysis';
import { buildSpeechTelemetry } from '../apps/web/src/lib/speech-telemetry';
import { answerComparisonContext,buildContentGrowth,compareAnswerGrowth,contentEvidence,growthContextResolver,growthNextReason } from '../apps/web/src/lib/learning-growth';

function capture(levels: Array<{start:number;end:number}>,duration=8000,gaps:Array<{start:number;end:number}>=[]) {
  return buildSpeechTelemetry(Array.from({length:duration/100},(_,index)=>index*100).filter(at=>!gaps.some(gap=>at>=gap.start&&at<gap.end)).map(at=>({atMs:at,rms:levels.some(level=>at>=level.start&&at<level.end)?.08:.002})),duration)!;
}
test('only microphone evidence produces pauses or a speaking rate',()=>{
  const analysis=analyzeSpeech({transcript:'음 저는 활동을 했습니다.',durationMs:20_000});
  assert.equal(analysis.timing,null);assert.equal(analysis.status,'not_measured');assert.equal(analysis.transcript?.eojeolPerMinute,null);
  assert.equal(analysis.transcript?.countsAreLowerBounds,true);
});
test('whole sounds catch fillers without treating ordinary Korean words as fillers',()=>{
  const observation=analyzeTranscript('음... 어, 음 그니까 제가. 음악과 음성은 어머니에게 들었습니다. 그러니까 결과를 봤어요.');
  assert.equal(observation.fillerCount,5);
  assert.deepEqual(observation.fillers.find(hit=>hit.text==='음')?.offsets,[0,8]);
  assert.ok(!observation.fillers.some(hit=>hit.text==='음악'||hit.text==='어머니'));
});
test('verbatim manual transcription is distinguished from a recognizer lower bound',()=>{
  assert.equal(analyzeSpeech({transcript:'음 음',transcriptSource:'verbatim_manual'}).transcript?.countsAreLowerBounds,false);
});
test('leading and trailing silence do not inflate the internal long pause count',()=>{
  const telemetry=capture([{start:1000,end:2000},{start:4000,end:6000}]);
  const analysis=analyzeSpeech({telemetry,transcript:'제가 조건을 비교했습니다. 결과를 확인했습니다.'});
  assert.equal(analysis.timing?.longPauseCount,1);
  assert.equal(analysis.timing?.pauses[0].startMs,2000);
  assert.equal(analysis.timing?.pauses[0].durationMs,2000);
  assert.equal(analysis.timing?.leadingSilenceMs,1000);assert.equal(analysis.timing?.trailingSilenceMs,2000);
  assert.equal(analysis.timing?.voicedMs,3000);assert.equal(analysis.timing?.silenceRatio,.625);
  assert.equal(analysis.transcript?.eojeolPerMinute,38); // Five whitespace-delimited Korean eojeol / eight seconds.
});
test('an unobserved background gap is not interpreted as a silent pause',()=>{
  const telemetry=capture([{start:0,end:1000},{start:4000,end:6000}],8000,[{start:1000,end:4000}]);
  const analysis=analyzeSpeech({telemetry,transcript:'저는 조건을 비교했습니다.'});
  assert.equal(analysis.status,'partial');assert.equal(analysis.timing?.longPauseCount,0);
  assert.equal(analysis.timing?.observedMs,5000);assert.equal(analysis.transcript?.eojeolPerMinute,null);
});
test('high background noise and truncated capture remain partial observations',()=>{
  const telemetry=capture([{start:1000,end:2000}]);telemetry.limitations.push('high-background-level');
  assert.equal(analyzeSpeech({telemetry}).status,'partial');
  telemetry.limitations=telemetry.limitations.filter(value=>value!=='high-background-level');telemetry.coverage.truncated=true;
  assert.equal(analyzeSpeech({telemetry}).status,'partial');
});
test('forged or escaped intervals and coverage values are rejected',()=>{
  const valid=capture([{start:1000,end:3000}]);assert.ok(validateSpeechTelemetry(valid));
  assert.equal(validateSpeechTelemetry({...valid,speechSegments:[{startMs:1000,endMs:9000}]}),null);
  assert.equal(validateSpeechTelemetry({...valid,coverage:{...valid.coverage,observedMs:1}}),null);
  assert.equal(validateSpeechTelemetry({...valid,coverage:{...valid.coverage,maxGapMs:3000}}),null);
  assert.equal(validateSpeechTelemetry({...valid,speechSegments:[{startMs:2500,endMs:3000},{startMs:1000,endMs:2000}]}),null);
});
test('phrase repetition preserves actual offsets and removes nested duplicates',()=>{
  const observation=analyzeTranscript('조건을 비교했습니다 그리고 조건을 비교했습니다. 저는 조건을 비교했습니다.');
  assert.equal(observation.repeatedPhrases.find(hit=>hit.text==='조건을 비교했습니다')?.count,3);
  assert.equal(observation.repeatedWords.find(hit=>hit.text==='조건을')?.count,3);
});
test('an immediate two-copy one-eojeol echo is observed without flagging every twice-used word',()=>{
  const raw='수지를 비교했습니다. 비교했습니다. 정확한 채수 위치와 비교 조건은 아직 설명하기 어렵습니다.';
  const observed=analyzeTranscript(raw);
  assert.deepEqual(observed.repeatedWords.find(hit=>hit.text==='비교했습니다'),{text:'비교했습니다',count:2,offsets:[raw.indexOf('비교했습니다'),raw.lastIndexOf('비교했습니다')]});
  assert.deepEqual(analyzeTranscript('수지를 비교했습니다. 조건을 기록하고 다시 비교했습니다.').repeatedWords,[]);
  assert.deepEqual(analyzeTranscript('했습니다. 했습니다.').repeatedWords,[]);
  assert.equal(analyzeSpeech({transcript:raw,transcriptSource:'openai'}).transcript?.countsAreLowerBounds,true);
});
const before={id:'first',question_id:'question-a',question:'활동에서 무엇을 했나요?',script:'활동에 참여했습니다.',created_at:'2026-01-01',revision_kind:'answer_edit'};
const after={id:'latest',question_id:'question-a',question:before.question,script:'저는 시료 준비를 맡았습니다. 조건을 3회 반복해 비교했습니다. 결과에서 오차가 나타나 한계를 확인했습니다.',created_at:'2026-01-02',revision_kind:'interview_answer',assisted:true};
test('content change is accompanied by exact before/after sentence evidence',()=>{
  const comparison=compareAnswerGrowth(before,after);
  assert.equal(comparison.elements.find(element=>element.key==='role')?.afterEvidence[0],'저는 시료 준비를 맡았습니다.');
  assert.equal(comparison.elements.find(element=>element.key==='evidence')?.change,'added');
  assert.equal(comparison.elements.find(element=>element.key==='result')?.afterEvidence[0],'결과에서 오차가 나타나 한계를 확인했습니다.');
  assert.equal(comparison.after.assisted,true);assert.equal(comparison.method,'quoted-sentence-cues');
});
test('different questions cannot become an apparent progression',()=>{
  assert.throws(()=>compareAnswerGrowth(before,{...after,question_id:'other'}),/same question/);
  assert.equal(buildContentGrowth([before,{...after,question_id:'other'}]).comparisons.length,0);
});
test('STT correction and repeated identical save are not a new practice improvement',()=>{
  const result=buildContentGrowth([before,{...before,id:'duplicate',created_at:'2026-01-02'},{...after,revision_kind:'transcript_correction'}]);
  assert.equal(result.comparisons.length,0);
});
test('concept explanation and personal activity answer keep their comparison context',()=>{
  const result=buildContentGrowth([{...before,practice_kind:'concept'},after]);
  assert.equal(result.comparisons.length,0);
});
test('first-person opinions and future plans are not performed role evidence',()=>{
  for(const text of ['저는 고립된 섬에서 환경 정책이 중요하다고 생각합니다.','제가 앞으로 연구에서 시료 준비를 담당할 예정입니다.','저는 직접 분석하고 싶습니다.','저는 자료를 분석했으면 합니다.','제 역할은 앞으로 실험을 맡을 계획입니다.']) {
    assert.deepEqual(contentEvidence(text).find(element=>element.key==='role')?.evidence,[]);
  }
});
test('actual assigned or performed roles retain their exact evidence sentence',()=>{
  for(const text of ['제가 시료 준비를 맡았습니다.','시료 준비와 세척 절차를 담당했습니다.','저는 직접 조건을 3회 비교했습니다.','직접 시료를 분석했습니다.','내 역할은 시료 준비였습니다.','저는 실험 결과를 분석했습니다.']) {
    assert.deepEqual(contentEvidence(text).find(element=>element.key==='role')?.evidence,[text]);
  }
});
test('performed responsibility phrased as 제 담당 is retained without matching future or unknown roles',()=>{
  const text='제 담당은 채취 조건을 정하고 측정표를 작성하는 일이었습니다.';
  assert.deepEqual(contentEvidence(text,['본인 역할']).find(element=>element.key==='role')?.evidence,[text]);
  for(const text of ['제 담당은 앞으로 측정표를 작성할 계획입니다.','제 담당은 아직 기억나지 않습니다.','친구가 측정표 작성을 담당했습니다.','친구가 측정표 작성을 담당했고 저는 중요하다고 생각했습니다.','내 역할은 시료 준비였으면 합니다.','제가 자료를 분석했다면 좋았을 것입니다.'])assert.deepEqual(contentEvidence(text,['본인 역할'])[0].evidence,[]);
  const actual='저는 측정표를 작성할 계획이 아니라 시료 채취를 담당했습니다.';
  assert.deepEqual(contentEvidence(actual,['본인 역할'])[0].evidence,[actual]);
});
test('question reviewed meanings define observations and prevent a role-only question acquiring generic deficits',()=>{
  const first={...before,required_meanings:['본인 역할']},last={...after,script:'제 담당은 측정표를 작성하는 일이었습니다.',required_meanings:['본인 역할']};
  const comparison=compareAnswerGrowth(first,last);
  assert.deepEqual(comparison.elements.map(element=>element.label),['본인 역할']);
  assert.deepEqual(comparison.missingElements,[]);
  assert.equal(comparison.criterionBasis,'reviewed_meanings');
  assert.ok(!growthNextReason(last,comparison).includes('근거·수치'));
  assert.equal(compareAnswerGrowth(first,{...last,required_meanings:[]}).criterionBasis,'general_observations','an explicitly unavailable latest criterion does not inherit an older question definition');
});
test('unrecognized concept criteria keep literal evidence and never invent semantic completion',()=>{
  const comparison=compareAnswerGrowth({...before,required_meanings:['농도 기울기']},{...after,script:'조건을 비교했습니다.',required_meanings:['농도 기울기']});
  assert.deepEqual(comparison.elements[0].afterEvidence,[]);
  assert.ok(growthNextReason(comparison.after,comparison).includes('설명했는지 확인'));
  assert.ok(!growthNextReason(comparison.after,comparison).includes('빠졌'));
  assert.deepEqual(contentEvidence('농도 기울기가 생겼습니다.',['농도 기울기'])[0].evidence,['농도 기울기가 생겼습니다.']);
});
test('generic word cues and longer answers do not create missing requirements or improvement verdicts',()=>{
  const comparison=compareAnswerGrowth(before,{...after,script:'저는 중요하다고 생각합니다. '.repeat(20)});
  assert.equal(comparison.criterionBasis,'general_observations');assert.deepEqual(comparison.missingElements,[]);
  assert.deepEqual(comparison.elements.find(element=>element.key==='role')?.afterEvidence,[]);
  assert.ok(comparison.note.includes('실력 향상을 판정하지'));
});
test('immediate answers, elapsed answers, and scheduled recall remain distinct from content edits',()=>{
  const first={...before,created_at:'2026-01-01T23:55:00Z'};
  const instant=answerComparisonContext(first,{...after,created_at:'2026-01-02T00:00:00Z',assistance_recorded:true,assisted:false});
  assert.equal(instant.interval,'immediate');assert.equal(instant.label,'바로 재답변');assert.equal(instant.scheduledRecall,false);assert.equal(instant.help,'none');
  const elapsed=answerComparisonContext(first,{...after,created_at:'2026-01-04T00:00:00Z',assisted:false});
  assert.equal(elapsed.interval,'elapsed');assert.equal(elapsed.scheduledRecall,false);assert.equal(elapsed.help,'unknown');
  assert.equal(answerComparisonContext(first,{...after,created_at:'2026-01-04T00:00:00Z',practice_due_at:'2026-01-03T00:00:00Z'}).scheduledRecall,true);
  const edit=answerComparisonContext(first,{...after,revision_kind:'answer_edit',practice_due_at:'2026-01-01T23:56:00Z'});
  assert.equal(edit.kind,'content_edit');assert.equal(edit.interval,'editing');assert.equal(edit.scheduledRecall,false);
});
test('transcript correction, rerecording and assistance uncertainty have explicit comparison conditions',()=>{
  assert.equal(answerComparisonContext(before,{...after,revision_kind:'transcript_correction'}).label,'전사 정정');
  assert.equal(answerComparisonContext(before,{...after,answer_attempt_kind:'rerecord'}).label,'다시 녹음');
  assert.equal(answerComparisonContext(before,{...after,assisted:false,hint_used:true}).help,'used');
  assert.equal(answerComparisonContext(before,{...after,assisted:false,assistance_recorded:false}).helpLabel,'도움 여부 미기록');
  assert.equal(answerComparisonContext(before,{...after,response_mode:'text'}).modeLabel,'입력한 답변');
  assert.equal(answerComparisonContext(before,{...after,response_mode:'audio'}).modeLabel,'음성으로 남긴 답변');
  assert.equal(answerComparisonContext(before,after).modeLabel,'답변 방식 미확인');
});
test('same question at different target or common school revision never becomes an apparent growth sequence',()=>{
  assert.equal(buildContentGrowth([{...before,target_id:'a'},{...after,target_id:'b'}]).comparisons.length,0);
  assert.equal(buildContentGrowth([{...before,target_id:'a',common_revision:1},{...after,target_id:'a',common_revision:2}]).comparisons.length,0);
});
test('identical text in a real later answer keeps its elapsed attempt without claiming content improvement',()=>{
  const first={...before,revision_kind:'interview_answer',session_id:'first-session'};
  const latest={...first,id:'later-real-attempt',session_id:'second-session',created_at:'2026-01-04'};
  const result=buildContentGrowth([first,latest]);
  assert.equal(result.comparisons.length,1);assert.equal(result.comparisons[0].attempt.interval,'elapsed');
  assert.ok(result.comparisons[0].elements.every(element=>element.change==='same'));
  assert.equal(result.comparisons[0].addedDetails.length,0);
  assert.equal(buildContentGrowth([first,first]).comparisons.length,0);
  assert.equal(buildContentGrowth([before,{...before,id:'same-draft-save'}]).unpaired.length,1);
});
test('same quiz and interview target compare across catalogue IDs, canonical names and one unambiguous stage',()=>{
  const target={university:'서울시립대학교',department:'환경공학부',campus:'본교',admission_year:2027,admission_type:'학생부종합전형Ⅰ(면접형)'};
  const quiz={...before,id:'quiz-q1',revision_kind:'quiz_answer',target_id:'uos',target_snapshot:target,content_version:6};
  const interview={...after,id:'interview-q1',revision_kind:'interview_answer',target_id:'uos',target_snapshot:{...target,university:'서울시립 대학교',department:'환경 공학부',school_reference_id:'uos-reference',department_catalog_id:'uos-environment',admission_type:'학생부종합전형 I (면접형)',interview_stage:'2 단계'},content_version:6};
  const frozen=JSON.stringify([quiz,interview]);
  const growth=buildContentGrowth([quiz,interview]);
  assert.equal(growth.comparisons.length,1);assert.equal(growth.comparisons[0].before.id,quiz.id);
  assert.equal(growth.comparisons[0].after.id,interview.id);assert.equal(JSON.stringify([quiz,interview]),frozen);
});
test('canonical and campus-labelled names of one reviewed school retain cumulative answer comparisons',()=>{
  const target={university:'가톨릭대학교',school_reference_id:'catholic-sungsim',department:'수학과',department_catalog_id:'math-main',campus:'성심교정',admission_year:2027,admission_type:'학생부종합'};
  const quiz={...before,id:'campus-quiz',target_id:'owned-campus-target',target_snapshot:target,common_revision:1,content_version:0,source_type:'general_practice'};
  const interview={...after,id:'campus-interview',target_id:'owned-campus-target',target_snapshot:{...target,university:'가톨릭대학교 — 성심교정'},common_revision:1,content_version:1,source_type:'general_practice'};
  const frozen=JSON.stringify([quiz,interview]);
  const growth=buildContentGrowth([quiz,interview]);
  assert.equal(growth.comparisons.length,1);assert.equal(growth.comparisons[0].before.id,quiz.id);assert.equal(growth.comparisons[0].after.id,interview.id);
  assert.equal(JSON.stringify([quiz,interview]),frozen,'historic school snapshots stay unchanged');
  for(const target_snapshot of [{...interview.target_snapshot,campus:'성의교정'},{...interview.target_snapshot,department:'물리학과'},{...interview.target_snapshot,school_reference_id:'catholic-other'}]){
    assert.equal(buildContentGrowth([quiz,{...interview,target_snapshot}]).comparisons.length,0);
  }
});
test('a name-only legacy school cannot bridge two reviewed identities with the same display name',()=>{
  const target={university:'같은 표시 대학',department:'학과',campus:'본교',admission_year:2027,admission_type:'학생부종합'};
  const first={...before,id:'school-a',target_id:'reused-target',target_snapshot:{...target,school_reference_id:'reference-a'},content_version:1};
  const second={...after,id:'school-b',target_id:'reused-target',target_snapshot:{...target,school_reference_id:'reference-b'},content_version:1};
  const legacy={...before,id:'legacy-name-only',target_id:'reused-target',target_snapshot:target,content_version:1};
  const resolve=growthContextResolver([first,second,legacy]);
  assert.notEqual(resolve(first),resolve(second));assert.notEqual(resolve(legacy),resolve(first));assert.notEqual(resolve(legacy),resolve(second));
  assert.equal(buildContentGrowth([first,second,legacy]).comparisons.length,0);
});
test('stage aliases share one known context while unknown cannot bridge distinct stages',()=>{
  const target={university:'학교',department:'학과',campus:'본교',admission_year:2027,admission_type:'학생부종합'};
  const base={...before,target_id:'target',target_snapshot:target,content_version:6};
  const first={...base,id:'known-first',target_snapshot:{...target,interview_stage:'1단계'}};
  const second={...after,id:'known-second',target_id:'target',target_snapshot:{...target,interview_stage:'2단계'},content_version:6};
  const unknown={...base,id:'unknown'};
  assert.equal(buildContentGrowth([unknown,second]).comparisons.length,1);
  const resolve=growthContextResolver([first,second,unknown]);
  assert.notEqual(resolve(unknown),resolve(first));assert.notEqual(resolve(unknown),resolve(second));
  assert.equal(buildContentGrowth([first,unknown,second]).comparisons.length,0);
  assert.equal(buildContentGrowth([first,{...second,target_snapshot:{...target,stage:'1차 면접'},content_version:6}]).comparisons.length,1);
});
test('different source version, track, department and explicit stage remain separate even with a reused target ID',()=>{
  const target={university:'학교',department:'학과',campus:'본교',admission_year:2027,admission_type:'학생부종합',interview_stage:'1단계'};
  const first={...before,target_id:'target',target_snapshot:target,content_version:6};
  const second={...after,target_id:'target',target_snapshot:target,content_version:6};
  for(const changed of [{...second,content_version:7},{...second,target_snapshot:{...target,department:'다른학과'}},{...second,target_snapshot:{...target,admission_type:'지역균형'}},{...second,target_snapshot:{...target,interview_stage:'2단계'}}]){
    assert.equal(buildContentGrowth([first,changed]).comparisons.length,0);
    assert.throws(()=>compareAnswerGrowth(first,changed),/same practice context/);
  }
});
test('common questions use their reviewed revision independently of personal book version and common subtype storage',()=>{
  const target={university:'학교',department:'학과',campus:'본교',admission_year:2027,admission_type:'학생부종합'};
  const first={...before,target_id:'target',target_snapshot:target,common_revision:3,content_version:6,source_type:'verified_past'};
  const next={...after,target_id:'target',target_snapshot:target,common_revision:3,content_version:7,source_type:'common'};
  assert.equal(buildContentGrowth([first,next]).comparisons.length,1);
  const scope={...first,id:'scope',content_version:undefined,source_type:undefined};
  assert.equal(growthContextResolver([first,next,scope])(scope),growthContextResolver([first,next,scope])(next));
  assert.equal(buildContentGrowth([first,{...next,common_revision:1}]).comparisons.length,0);
  assert.equal(compareAnswerGrowth(first,next).attempt.sourceChanged,false);
});

test('explicit role and difficulty requests outrank an unrelated generic motivation criterion without editing the approved list',()=>{
  const question='이 활동에서 본인이 맡은 역할과 가장 어려웠던 점은 무엇인가요?';
  const required=['탐구 동기','본인 역할','실제 행동','어려움','배운 점'];
  const first={...before,question,required_meanings:required};
  const latest={...after,question,script:'제 담당은 채취 지점과 비교 조건을 설계하고 측정표를 작성하는 일이었습니다.',required_meanings:required};
  const preserved=JSON.stringify([first,latest]);
  const comparison=compareAnswerGrowth(first,latest);
  assert.match(growthNextReason(latest,comparison),/“어려움”/);
  assert.doesNotMatch(growthNextReason(latest,comparison),/동기/);
  assert.deepEqual(comparison.elements.map(element=>element.label),required);
  assert.equal(JSON.stringify([first,latest]),preserved);
  const complete={...latest,script:latest.script+' 강우 전후 조건을 구분하는 것이 가장 어려웠습니다.',assisted:true};
  assert.equal(growthNextReason(complete,compareAnswerGrowth(first,complete)),'자료를 덮고 같은 질문에 새 답변을 남겨 보세요.');
});

test('common school questions retain all approved criteria and use their original order when no explicit focus is found',()=>{
  const required=['지원 동기','입학 후 계획','본인 역할'];
  const first={...before,question:'학교와 연결해서 자유롭게 이야기해 주세요.',required_meanings:required,source_type:'common',common_revision:2};
  const latest={...after,question:first.question,script:'제가 시료 채취를 담당했습니다.',required_meanings:required,source_type:'common',common_revision:2};
  const comparison=compareAnswerGrowth(first,latest);
  assert.match(growthNextReason(latest,comparison),/“지원 동기”/);
  assert.deepEqual(comparison.elements.map(element=>element.label),required);
  const plan={...latest,question:'지원 동기와 입학 후 계획을 말해 주세요.',script:'환경을 연구하고 싶은 것이 제 목표입니다.'};
  assert.match(growthNextReason(plan,compareAnswerGrowth({...first,question:plan.question},plan)),/“지원 동기”/);
});
