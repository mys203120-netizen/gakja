import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPosition, nextRequestSchema, replaceTranscriptAt, concatenateStreamTranscript, type InterviewSession, type RecordedTurn } from '../server/protocol';

const baseTurn = { id:'turn0', parentMainQuestionId:'root0', mainIndex:1, followUpIndex:0 } as RecordedTurn;
const session = (changes:Partial<InterviewSession> = {}) => ({turns:[baseTurn],followUpCountByMainQuestion:{root0:0},elapsedMs:0,...changes} as InterviewSession);

test('nested follow-ups remain on the same main root and stop at server cap',()=>{
  assert.deepEqual(nextPosition(session(),'follow_up',4,2,600),{kind:'follow_up',mainIndex:1,followUpIndex:1,parentId:'root0'});
  const second=session({turns:[{...baseTurn,id:'nested',followUpIndex:2}],followUpCountByMainQuestion:{root0:2}});
  assert.deepEqual(nextPosition(second,'follow_up',4,2,600),{kind:'main',mainIndex:2,followUpIndex:0,parentId:null});
  assert.throws(()=>nextPosition(session(),'follow_up',4,4,600));
  assert.throws(()=>nextPosition(session(),'follow_up',4,3,600));
});
test('remaining time and last main question never force extra follow-ups',()=>{
  assert.equal(nextPosition(session({elapsedMs:600000}),'follow_up',4,2,600),null);
  assert.equal(nextPosition(session({turns:[{...baseTurn,mainIndex:4}],followUpCountByMainQuestion:{root0:2}}),'follow_up',4,2,600),null);
  assert.equal(nextPosition(session(),'end',4,2,600),null);
  assert.equal(nextPosition(session({elapsedMs:570000}),'follow_up',4,2,600)?.kind,'main');
});
test('partial revisions replace text without accumulating filler duplicates',()=>{
  let transcript='어 생각';
  transcript=replaceTranscriptAt(transcript,'어 생각했습니다',0);
  assert.equal(transcript,'어 생각했습니다');
  transcript=replaceTranscriptAt(transcript,'했습니다.',4);
  assert.equal(transcript,'어 생각했습니다.');
  assert.throws(()=>replaceTranscriptAt(transcript,'x',500));
});
test('paused streams concatenate only new PCM results, preserving spoken repetitions',()=>{
  assert.equal(concatenateStreamTranscript('어 음','그 경험입니다.'),'어 음 그 경험입니다.');
  assert.equal(concatenateStreamTranscript('네','네 계속하겠습니다'),'네 네 계속하겠습니다');
  assert.equal(concatenateStreamTranscript('','어'),'어');
});
test('pinned five-question target overrides stale numeric defaults and preserves time for main questions',()=>{
  const pinned=session({mainQuestionTarget:5,turns:[{...baseTurn,mainIndex:4}]});
  assert.equal(nextPosition(pinned,'main',4,2,720)?.mainIndex,5);
  const budget=session({mainQuestionTarget:5,elapsedMs:375000});
  assert.equal(nextPosition(budget,'follow_up',4,2,720)?.kind,'main');
  assert.equal(budget.elapsedMs,375000);
});
test('next request preserves finite client timing observations and rejects malformed values',()=>{
  const request={turnId:'00000000-0000-4000-8000-000000000001',answerId:'answer',elapsedMs:1000,clientTimings:{submittedAt:1234,finalizedAt:1240}};
  assert.deepEqual(nextRequestSchema.parse(request).clientTimings,request.clientTimings);
  for(const invalid of [-1,Infinity,NaN,'123']) assert.equal(nextRequestSchema.safeParse({...request,clientTimings:{submittedAt:invalid}}).success,false);
});
