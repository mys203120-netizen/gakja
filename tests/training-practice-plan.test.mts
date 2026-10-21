import test from 'node:test';
import assert from 'node:assert/strict';
import {hybridTrainingDays,type HybridAssignment,type HybridDeadline,type HybridQuestion,type HybridTask} from '../apps/web/src/lib/hybrid-training';

const today='2026-10-21';
const availability={version:2,startDate:today,revision:1,savedAt:'2026-10-21T00:00:00Z',weekdayMinutes:120,weekendMinutes:120,blockedDates:[] as string[],overrides:{}};
const deadline=(targetId='school-a'):HybridDeadline=>({targetId,university:'시험대학교',department:'학과',date:'2026-11-29',source:'public_day',label:'학교 공개 면접일',periodStart:'2026-11-29',periodEnd:'2026-11-29',status:'ready',reason:'확인된 일정',daysLeft:39,availableMinutes:4680});
const question=(id='question-a',targetId='school-a',quiz=true):HybridQuestion=>({id,title:'탐구 방법을 선택한 이유',targetId,sourceType:'personal',sourceVersion:3,activityIds:['activity-'+targetId],category:'major',attempts:[],...(quiz?{quiz:{kind:'quiz' as const,mode:'choice' as const,itemIds:['quiz-'+id]}}:{})});
const assignment=(id='assignment-a',questionId='question-a',targetId='school-a',minutes=16):HybridAssignment=>({id,title:'자료 확인 과제',targetId,sourceType:'personal',sourceVersion:3,questionId,minutes,dueDate:today});
const minutes=(tasks:HybridTask[],kinds:string[])=>tasks.filter(task=>kinds.includes(task.kind)).reduce((sum,task)=>sum+task.minutes,0);
const first=(input:Partial<Parameters<typeof hybridTrainingDays>[0]>={})=>hybridTrainingDays({today,availability,questions:[question()],deadlines:[deadline()],...input})[0];

test('quiz and received assignments use the focus budget while diagnosis, connected interview, and review retain their time',()=>{
 const original=first({questions:[question('question-a','school-a',false)]});
 const planned=first({assignments:[assignment()]});
 assert.equal(original.plannedMinutes,120);assert.equal(planned.plannedMinutes,120);
 for(const kind of ['diagnostic','mixed','review'])assert.equal(minutes(planned.tasks,[kind]),minutes(original.tasks,[kind]),`${kind} keeps its original time`);
 assert.equal(minutes(planned.tasks,['focus','quiz','assignment']),minutes(original.tasks,['focus']));
 assert.equal(planned.tasks.filter(task=>task.kind==='quiz').length,1);assert.equal(planned.tasks.filter(task=>task.kind==='assignment').length,1);
 assert.deepEqual(planned.tasks.find(task=>task.kind==='quiz')?.practice,{kind:'quiz',mode:'choice',itemIds:['quiz-question-a']});
 assert.deepEqual(planned.tasks.find(task=>task.kind==='assignment')?.practice,{kind:'assignment',assignmentId:'assignment-a'});
 assert.ok(planned.tasks.some(task=>task.kind==='focus'));assert.ok(planned.tasks.every(task=>task.kind!=='break'));
});

test('multiple schools share one 120 minute day and receive only practice matching their own question and publication',()=>{
 const questions=[question(),question('question-b','school-b')],assignments=[assignment('assignment-b','question-b','school-b')];
 const days=hybridTrainingDays({today,availability,questions,deadlines:[deadline(),deadline('school-b')],assignments});
 for(const day of days){assert.equal(day.plannedMinutes,120);assert.equal(day.tasks.reduce((sum,task)=>sum+task.minutes,0),120);assert.equal(day.unallocatedMinutes,0);}
 assert.deepEqual(new Set(days.flatMap(day=>day.tasks.map(task=>task.targetId))),new Set(['school-a','school-b']));
 const received=days.flatMap(day=>day.tasks).find(task=>task.practice?.kind==='assignment')!;
 assert.equal(received.targetId,'school-b');assert.equal(received.questionId,'question-b');assert.equal(received.sourceVersion,3);
 for(const task of days.flatMap(day=>day.tasks).filter(task=>task.kind==='quiz')){
   assert.equal(task.practice?.kind,'quiz');if(task.practice?.kind==='quiz')assert.deepEqual(task.practice.itemIds,['quiz-'+task.questionId]);
 }
});

test('one received assignment is scheduled at most once in the rolling week, even when duplicated by the source list',()=>{
 const same=assignment(),others=[assignment('assignment-b'),assignment('assignment-c')];
 const days=hybridTrainingDays({today,availability,questions:[question()],deadlines:[deadline()],assignments:[same,same,...others]});
 const assignmentIds=days.flatMap(day=>day.tasks.flatMap(task=>task.practice?.kind==='assignment'?[task.practice.assignmentId]:[]));
 assert.equal(assignmentIds.length,3);assert.equal(new Set(assignmentIds).size,assignmentIds.length);
 assert.deepEqual(new Set(assignmentIds),new Set(['assignment-a','assignment-b','assignment-c']));
});

test('a blocked day allocates no quiz, assignment, or other automatic training',()=>{
 const days=hybridTrainingDays({today,availability:{...availability,blockedDates:[today,'2026-10-24']},questions:[question()],deadlines:[deadline()],assignments:[assignment()]});
 for(const date of [today,'2026-10-24']){
   const day=days.find(day=>day.date===date)!;assert.equal(day.capacityMinutes,0);assert.equal(day.plannedMinutes,0);assert.equal(day.tasks.length,0);
 }
 assert.equal(days.flatMap(day=>day.tasks).filter(task=>task.practice?.kind==='assignment').length,1);
});

test('started and completed practice stays intact on replan without adding the same quiz or assignment again',()=>{
 for(const kind of ['quiz','assignment'] as const)for(const state of ['in_progress','completed'] as const){
   const original=first({assignments:[assignment()]}),source=original.tasks.find(task=>task.kind===kind)!;
   const fixed:HybridTask={...source,status:state,startedAt:today+'T09:00:00+09:00',...(state==='completed'?{completed:true,performedAt:today+'T09:01:00+09:00'}:{})};
   const days=hybridTrainingDays({today,availability,questions:[question()],deadlines:[deadline()],assignments:[assignment()],fixedTasks:[fixed]});
   assert.equal(days[0].tasks[0],fixed);assert.equal(days[0].plannedMinutes,120);
   assert.equal(days[0].tasks.filter(task=>task.kind===kind).length,1);
   if(kind==='assignment')assert.equal(days.flatMap(day=>day.tasks).filter(task=>task.practice?.kind==='assignment'&&task.practice.assignmentId==='assignment-a').length,1);
   assert.equal(new Set(days[0].tasks.map(task=>task.id)).size,days[0].tasks.length);
 }
});

test('new assignments cannot expand the daily budget or replace preserved work',()=>{
 const original=first(),fixed=original.tasks.map(task=>({...task,status:'completed' as const,completed:true,performedAt:today+'T09:00:00+09:00'}));
 const filled=first({fixedTasks:fixed,assignments:[assignment('late-assignment')]});
 assert.equal(filled.plannedMinutes,120);assert.deepEqual(filled.tasks,fixed);assert.ok(!filled.tasks.some(task=>task.practice?.kind==='assignment'));
 const oversized=first({assignments:[assignment('too-long','question-a','school-a',120),assignment('fits','question-a','school-a',20)]});
 assert.equal(oversized.plannedMinutes,120);assert.ok(oversized.tasks.some(task=>task.practice?.kind==='assignment'&&task.practice.assignmentId==='fits'));
 assert.ok(!oversized.tasks.some(task=>task.practice?.kind==='assignment'&&task.practice.assignmentId==='too-long'));
 for(const capacity of [5,20,35,50,120]){
   const day=first({availability:{...availability,weekdayMinutes:capacity,weekendMinutes:capacity},assignments:[assignment()]});
   assert.ok(day.plannedMinutes<=capacity);assert.equal(day.tasks.reduce((sum,task)=>sum+task.minutes,0),day.plannedMinutes);
 }
});

test('assignments from another school, changed question, or previous content version cannot enter the plan',()=>{
 const wrongSchool=assignment('other-school','question-a','school-b'),wrongQuestion=assignment('other-question','replaced-question'),oldVersion={...assignment('old-version'),sourceVersion:2};
 const day=first({assignments:[wrongSchool,wrongQuestion,oldVersion]});assert.equal(day.plannedMinutes,120);assert.ok(!day.tasks.some(task=>task.kind==='assignment'));
});

test('an unfinished fixed focus uses its time once and new focus prefers another eligible question',()=>{
 const existing:HybridTask={id:'fixed-focus',date:today,kind:'focus',title:'진행 중인 질문',minutes:25,targetId:'school-a',questionId:'question-a',sourceType:'personal',sourceVersion:3,activityIds:[],status:'in_progress',startedAt:today+'T01:00:00Z'};
 const day=first({questions:[question('question-a','school-a',false),question('question-b','school-a',false)],fixedTasks:[existing]});
 assert.equal(day.plannedMinutes,120);assert.equal(day.tasks.filter(task=>task.id==='fixed-focus').length,1);
 const added=day.tasks.filter(task=>task.kind==='focus'&&task.id!==existing.id);assert.ok(added.length);assert.ok(added.every(task=>task.questionId==='question-b'));
 const only=first({questions:[question('question-a','school-a',false)],fixedTasks:[existing]});assert.equal(only.plannedMinutes,120);assert.ok(only.tasks.some(task=>task.kind==='focus'&&task.id!==existing.id&&task.questionId==='question-a'),'one eligible question remains usable');
});

test('fixed school load is counted and a shared question ID in another school receives no fixed-question penalty',()=>{
 const existing:HybridTask={id:'fixed-focus',date:today,kind:'focus',title:'학교A 질문',minutes:25,targetId:'school-a',questionId:'shared',sourceType:'personal',sourceVersion:3,activityIds:[],status:'in_progress',startedAt:today+'T01:00:00Z'};
 const day=first({questions:[question('shared','school-a',false),question('different','school-a',false),question('shared','school-b',false)],deadlines:[deadline('school-a'),deadline('school-b')],fixedTasks:[existing]});
 const opening=day.tasks.find(task=>task.id!==existing.id&&task.kind==='diagnostic');assert.equal(opening?.targetId,'school-b');assert.equal(opening?.questionId,'shared');assert.equal(day.plannedMinutes,120);
 const addedFocus=day.tasks.filter(task=>task.id!==existing.id&&task.kind==='focus');assert.ok(addedFocus.every(task=>task.targetId!=='school-a'||task.questionId!=='shared'),'same text ID at another school is a separate question scope');
});
