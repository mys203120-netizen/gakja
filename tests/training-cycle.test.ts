import test from 'node:test';
import assert from 'node:assert/strict';
import {hybridAllocation,hybridTrainingDays,type HybridQuestion,type HybridDeadline} from '../apps/web/src/lib/hybrid-training';
import {trainingCycleEvidenceSql,withRehearsalEvidence} from '../apps/web/src/lib/training-cycle';

const today='2026-10-23',target={id:'school',university:'학교',department:'학과',admission_year:2027,campus:'본교',admission_type:'학종'};
const question:HybridQuestion={id:'q',title:'내 역할',targetId:target.id,sourceType:'personal',sourceVersion:1,activityIds:['activity'],category:'personal',area:'세특',attempts:[{at:'2026-10-22T01:00:00Z',assistanceKnown:true,assisted:false}]};
const deadline:HybridDeadline={targetId:target.id,date:'2026-10-25',university:'학교',department:'학과',source:'goal',label:'목표',periodStart:null,periodEnd:null,status:'ready',reason:'등록 목표',daysLeft:2,availableMinutes:120};
const availability={version:2,startDate:today,revision:1,savedAt:'2026-10-23T00:00:00Z',weekdayMinutes:60,weekendMinutes:60,blockedDates:[],overrides:{}};
const row={session_id:'session',target_id:target.id,target_snapshot:target,content_version:1,roots:[{id:'q',source_type:'personal'}],completed_at:'2026-10-22T01:00:00Z',report_id:'report'};

test('cycle evidence requires actual completed real roots and matches saved school, question, namespace and revision',()=>{
 assert.match(trainingCycleEvidenceSql,/s\.student_id=\$1 and s\.state='completed' and s\.data->>'sessionMode'='real'/);
 assert.match(trainingCycleEvidenceSql,/r\.student_id=s\.student_id/);assert.match(trainingCycleEvidenceSql,/completion_turn\.student_id=s\.student_id/);assert.match(trainingCycleEvidenceSql,/invalidated/);assert.match(trainingCycleEvidenceSql,/followupDepth/);
 assert.equal(withRehearsalEvidence([question],[row],[target])[0].rehearsal?.reportId,'report');
 for(const invalid of [{...row,target_snapshot:{...target,department:'예전 학과'}},{...row,target_id:'other'},{...row,content_version:2},{...row,roots:[{id:'different'}]},{...row,roots:[{id:'q',source_type:'common',common_revision:1}]}])assert.equal(withRehearsalEvidence([question],[invalid],[target])[0].rehearsal,undefined);
 assert.equal(withRehearsalEvidence([{...question,sourceType:'common',sourceVersion:3}],[{...row,roots:[{id:'q',source_type:'common',common_revision:3}]}],[target])[0].rehearsal?.sessionId,'session');
});

test('real completion, an actual report and remaining review drive the preparation cycle ahead of the deadline',()=>{
 assert.equal(hybridAllocation(today,[question],[deadline]).stage,'real');
 const awaiting=withRehearsalEvidence([question],[{...row,report_id:null}],[target]);assert.equal(hybridAllocation(today,awaiting,[deadline]).stage,'report');assert.equal(hybridAllocation(today,awaiting,[deadline]).reportId,undefined);
 const reported=withRehearsalEvidence([{...question,attempts:[{...question.attempts[0],needsReview:true,evaluationReason:'근거 확인'}]}],[row],[target]);
 const allocation=hybridAllocation(today,reported,[deadline]);assert.equal(allocation.stage,'final_review');assert.equal(allocation.mode,'repair');assert.equal(allocation.mixedShare,0);assert.equal(allocation.reportId,'report');
 const resolved=withRehearsalEvidence([question],[row],[target]);assert.equal(hybridAllocation(today,resolved,[deadline]).stage,'final_review');assert.match(hybridAllocation(today,resolved,[deadline]).reason,/남은 보완 요청은 없어요/);
 assert.equal(hybridAllocation(today,[{...question,attempts:[]}],[deadline]).stage,'practice');
});

test('post-report review chooses its actual area and focus while preserving started and completed tasks',()=>{
 const review=withRehearsalEvidence([{...question,area:'진로활동',attempts:[{...question.attempts[0],needsReview:true}]}],[row],[target])[0];
 const other={...question,id:'other',area:'동아리활동'};
 const day=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[other,review],windowDays:1})[0];
 assert.equal(day.area,'진로활동');assert.equal(day.allocation.stage,'final_review');assert.ok(day.tasks.some(task=>task.kind==='focus'&&task.questionId==='q'&&task.title.startsWith('최종 보완')));assert.ok(!day.tasks.some(task=>task.kind==='mixed'));assert.equal(day.plannedMinutes,60);
 const fixed={...day.tasks.find(task=>task.kind==='focus')!,id:'existing',kind:'mixed' as const,minutes:20,status:'in_progress' as const,startedAt:'2026-10-23T01:00:00Z',sequence:0};
 const complete={...day.tasks[0],id:'completed',completed:true,status:'completed' as const,sequence:1};
 const after=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[other,review],fixedTasks:[fixed,complete],windowDays:1})[0];assert.ok(after.tasks.includes(fixed));assert.ok(after.tasks.includes(complete));assert.equal(after.tasks[0],fixed);assert.equal(after.plannedMinutes,60);
});
