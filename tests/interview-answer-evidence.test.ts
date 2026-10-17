import assert from 'node:assert/strict';
import {test} from 'node:test';
import {interviewAnswerEvidence} from '../apps/web/src/lib/interview-answer-evidence';

const scope={sessionId:'owned-session',turnId:'owned-turn',questionId:'root-q',targetId:'target',contentVersion:'6',activityId:null,briefingId:null};
const raw='음, 반복 측정은 하지 않았습니다.';
const formatted='반복 측정은 하지 않았습니다.';
const turn={id:scope.turnId,session_id:scope.sessionId,question_id:'followup-q',data:{question:'측정을 여러 번 했나요?',answer:null,draft:formatted,
  mediaId:'selected-audio',rawTranscriptMediaId:'selected-audio',rawTranscript:raw,displayTranscript:formatted,transcriptCleanup:{status:'completed'},
  transcriptRevisions:[{correctedBy:'student',transcript:'도구 보정도 제가 한 일이 아닙니다.',at:'2026-10-15T00:00:00Z'}],
  unrelatedSecret:'never expose',reaction:{engagement:95},helpEvents:[{kind:'ai',content:'이전 AI의 제안'}]}};
test('current denial and original STT remain separate unverified evidence for the exact owned turn',()=>{
  const before=JSON.stringify(turn),value=interviewAnswerEvidence(turn,scope)!;
  assert.equal(value.status,'student_statement_unverified');assert.equal(value.question_id,'followup-q');assert.equal(value.root_question_id,'root-q');
  assert.equal(value.current_draft,formatted);assert.equal(value.draft_origin,'formatted_transcript');assert.equal(value.recording?.raw_stt,raw);
  assert.equal(value.recording?.formatted_transcript,formatted);assert.equal(value.student_transcript_corrections[0].text,'도구 보정도 제가 한 일이 아닙니다.');
  assert.doesNotMatch(JSON.stringify(value),/unrelatedSecret|engagement|이전 AI의 제안/);assert.equal(JSON.stringify(turn),before);
});
test('a manually changed current draft is never replaced by the formatted transcription',()=>{
  const current='반복 측정은 하지 않았고 원문 확인이 필요합니다.';
  const value=interviewAnswerEvidence({...turn,data:{...turn.data,draft:current}},scope)!;
  assert.equal(value.current_draft,current);assert.equal(value.draft_origin,'student_edited');assert.equal(value.recording?.formatted_transcript,formatted);
});
test('a different take cannot supply raw speech for the selected formatted recording',()=>{
  const data={...turn.data,rawTranscriptMediaId:'new-unselected-take',rawTranscript:'다른 녹음',mediaVersions:[{mediaId:'selected-audio',transcript:raw}]};
  assert.equal(interviewAnswerEvidence({...turn,data},scope)!.recording?.raw_stt,raw);
  assert.equal(interviewAnswerEvidence({...turn,data:{...data,mediaVersions:[]}},scope)!.recording?.raw_stt,null);
});
test('foreign, submitted or invalidated turns cannot become current answer evidence',()=>{
  for(const changed of [{...turn,id:'foreign'},{...turn,session_id:'another-session'},{...turn,data:{...turn.data,answer:'already submitted'}},{...turn,data:{...turn.data,invalidated:true}}])assert.equal(interviewAnswerEvidence(changed,scope),null);
});
test('only an explicitly allowed saved-thread read can include the original submitted answer and later student correction',()=>{
  const original='반복 측정은 하지 않았습니다.',current='반복 측정도 도구 보정도 하지 않았습니다.';
  const submitted={...turn,data:{...turn.data,answer:current,originalAnswer:original,draft:'제출 전의 오래된 초안'}};
  const value=interviewAnswerEvidence(submitted,scope,true)!;
  assert.equal(value.answer_state,'submitted');assert.equal(value.submitted_answer,original);assert.equal(value.current_answer,current);assert.equal(value.current_draft,null);
  assert.equal(value.recording?.raw_stt,raw);assert.equal(interviewAnswerEvidence({...submitted,id:'another-turn'},scope,true),null);
});
test('only the latest bounded student corrections and allowed fields enter the provider context',()=>{
  const corrections=Array.from({length:5},(_,i)=>({correctedBy:'student',transcript:'정정 '+i,at:'at'}));
  corrections.push({correctedBy:'model',transcript:'학생이 한 일이라는 AI 추정',at:'at'});
  const value=interviewAnswerEvidence({...turn,data:{...turn.data,draft:'가'.repeat(30_000),question:'나'.repeat(5_000),transcriptRevisions:corrections}},scope)!;
  assert.equal(value.current_draft?.length,12_000);assert.equal(value.question?.length,2_000);assert.deepEqual(value.student_transcript_corrections.map(item=>item.text),['정정 2','정정 3','정정 4']);
});
