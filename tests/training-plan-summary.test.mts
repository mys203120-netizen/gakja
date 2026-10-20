import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summarizeTrainingPlans} from '../apps/web/src/lib/training-plan-summary.ts';

test('weekly learning groups repeated categories and omits breaks and question text',()=>{
 const tasks=[{kind:'focus',minutes:25,title:'수질 실험에서 맡은 역할은?'},{kind:'break',minutes:10,title:'휴식'},{kind:'diagnostic',minutes:20,title:'공통 진단 질문'},{kind:'focus',minutes:15,title:'다른 탐구 질문'},{kind:'mixed',minutes:30,title:'실전 질문 전체'}];
 const before=JSON.stringify(tasks),summary=summarizeTrainingPlans(tasks);
 assert.deepEqual(summary,[{kind:'diagnostic',label:'첫 진단',count:1,minutes:20},{kind:'focus',label:'집중 보완',count:2,minutes:40},{kind:'mixed',label:'연결 면접',count:1,minutes:30}]);
 assert.ok(!JSON.stringify(summary).includes('질문'));assert.ok(!JSON.stringify(summary).includes('휴식'));assert.equal(JSON.stringify(tasks),before);
});

test('the same outline works with persisted planner rows and flat daily tasks',()=>{
 const daily=[{kind:'focus',minutes:25},{kind:'focus',minutes:15},{kind:'review',minutes:10},{kind:'break',minutes:10}];
 const persisted=daily.map((task,index)=>({kind:'interview',title:'공개하면 안 되는 긴 질문 '+index,target:{automaticPractice:{minutes:task.minutes,hybrid:{kind:task.kind}}}}));
 assert.deepEqual(summarizeTrainingPlans(persisted),summarizeTrainingPlans(daily));
 assert.equal(summarizeTrainingPlans(persisted).reduce((sum,item)=>sum+(item.minutes||0),0),50,'rest time is not counted as weekly learning time');
});

test('unknown manual durations do not become invented zero-minute totals',()=>{
 assert.deepEqual(summarizeTrainingPlans([{kind:'study',minutes:25},{kind:'study'},{kind:'reading',minutes:0},{kind:'custom',minutes:15}]),[{kind:'study',label:'공부',count:2,minutes:null},{kind:'reading',label:'읽기·영상',count:1,minutes:0},{kind:'other',label:'개인 학습',count:1,minutes:15}]);
 assert.deepEqual(summarizeTrainingPlans([{kind:'break',minutes:15}]),[]);
 assert.equal(summarizeTrainingPlans([{kind:'quiz',minutes:-10}])[0].minutes,null);
});
