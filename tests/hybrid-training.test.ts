import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hybridDeadlines,hybridTrainingDays,hybridQuestionObservation,hybridAllocation,preserveHybridPlan,type HybridQuestion,type HybridDeadline} from '../apps/web/src/lib/hybrid-training';
import {projectAdmissionCalendar} from '../apps/web/src/lib/admission-calendar-projection';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar';

const today='2026-10-20';
const availability={version:1 as const,startDate:today,revision:1,savedAt:'2026-10-20T00:00:00Z',weekdayMinutes:120,weekendMinutes:180,csatDate:'2026-11-19',beforeCsatWeekdayMinutes:20,beforeCsatWeekendMinutes:30,blockedDates:['2026-10-23'],overrides:{'2026-10-21':120}};
const q=(id:string,targetId='a',attempts:HybridQuestion['attempts']=[]):HybridQuestion=>({id,title:'측정 조건을 선택한 이유',targetId,sourceType:'personal',sourceVersion:1,activityIds:['water'],category:'major',attempts,href:'/interview/new'});
const deadline=(id='a',date='2026-11-29'):HybridDeadline=>({targetId:id,university:'학교',department:'학과',date,source:'public_day',label:'공개 일정',periodStart:date,periodEnd:date,status:'ready',reason:'공개 일정 확인',daysLeft:40,availableMinutes:0});

test('real stored project schedules include D-56 and retain public period semantics',()=>{
  const catalogue=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url),'utf8'));
  const official=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-official.json',import.meta.url),'utf8'));
  const base=overlayOfficialCalendar(catalogue,official);
  const school=(name:string)=>base.schools.find((row:any)=>row.university===name||row.canonicalName===name)!;
  const targets=[{id:'gachon',university:'가천대학교',school_reference_id:school('가천대학교').schoolReferenceId,admission_year:2027,department:'약학과',admission_type:'가천의약학전형'},
    {id:'kwangwoon',university:'광운대학교',school_reference_id:school('광운대학교').schoolReferenceId,admission_year:2027,department:'전자공학과',admission_type:'광운참빛인재전형I (면접형)'}];
  const calendar=projectAdmissionCalendar({catalogue:base,official,officialSchools:official.schools.length,stale:false,lastRefreshFailed:false,refreshDue:false},targets);
  const result=hybridDeadlines({today,targets,schedules:calendar.interviewSchedules,coverage:calendar.interviewScheduleCoverage.targets,availability});
  const gachon=result.find(item=>item.targetId==='gachon')!;
  assert.equal(gachon.date,'2026-12-15');assert.equal(gachon.daysLeft,56);assert.ok(gachon.availableMinutes>0);
  const kwangwoon=result.find(item=>item.targetId==='kwangwoon')!;
  assert.equal(kwangwoon.source,'public_period');assert.equal(kwangwoon.date,'2026-10-31');assert.equal(kwangwoon.periodEnd,'2026-11-01');
  assert.match(kwangwoon.label,/준비 목표/);assert.match(kwangwoon.label,/개인 배정 대기/);
});

test('verified target scope is required, a personal day takes priority, no interview stays blocked',()=>{
  const targets=[{id:'a',university:'대학',department:'학과',school_interview_date:'2026-10-25'},{id:'b',schedule:{personal_date:'2026-11-07',status:'reviewed'}},{id:'c',schedule:{personal_date:'2026-11-08'}}];
  const result=hybridDeadlines({today,targets,schedules:[{targetId:'a',applicability:'school_reference',startDate:'2026-10-30',endDate:'2026-10-31'}],coverage:[{targetId:'a',status:'available'},{targetId:'b',status:'available'},{targetId:'c',status:'no_interview'}],availability});
  assert.equal(result.find(item=>item.targetId==='a')!.date,null);
  assert.equal(result.find(item=>item.targetId==='b')!.source,'personal');
  assert.equal(result.find(item=>item.targetId==='c')!.status,'no_interview');
  const goal=hybridDeadlines({today,targets:[targets[0]],schedules:[],coverage:[],settings:{a:{interviewDate:'2026-11-01',dateSource:'goal'}},availability})[0];
  assert.equal(goal.source,'goal');assert.match(goal.label,/직접/);
});

test('one daily capacity covers several schools, blocked days are empty, long horizons remain usable',()=>{
  const result=hybridTrainingDays({today,availability,deadlines:[deadline('a','2026-12-15'),deadline('b','2027-09-01')],questions:[q('qa'),q('qb','b')]});
  assert.equal(result.length,7);
  assert.equal(result[0].plannedMinutes,20);assert.equal(result[1].plannedMinutes,120);
  assert.equal(result[3].plannedMinutes,0);assert.equal(result[4].capacityMinutes,30);
  assert.ok(result.every(day=>day.plannedMinutes<=day.capacityMinutes));
  const scheduledTargets=new Set(result.flatMap(day=>day.tasks.map(task=>task.targetId)));
  assert.ok(scheduledTargets.has('a'));assert.ok(scheduledTargets.has('b'));
  assert.deepEqual(new Set(result[1].tasks.map(task=>task.kind)),new Set(['diagnostic','focus','mixed','review']));
  assert.equal(hybridTrainingDays({today,availability:null,deadlines:[deadline()],questions:[q('qa')]}).reduce((sum,day)=>sum+day.plannedMinutes,0),0);
});

test('assistance triggers an explicit recheck; unseen questions remain unconfirmed, not weak',()=>{
  const unseen=hybridQuestionObservation(q('qa'),{},today);
  assert.equal(unseen.unseen,true);assert.equal(unseen.needsReview,false);
  const helped=hybridQuestionObservation(q('qa','a',[{at:'2026-10-19T09:00:00Z',assisted:true,inputMode:'voice'}]),{},today);
  assert.equal(helped.needsReview,true);assert.match(helped.reason,/도움/);assert.equal(helped.due,true);
  const allDay={...availability,csatDate:null,weekdayMinutes:120,weekendMinutes:120};
  const base=hybridTrainingDays({today,availability:allDay,deadlines:[deadline()],questions:[q('qa')],diagnostics:{a:{state:'completed'}}})[0];
  const adapted=hybridTrainingDays({today,availability:allDay,deadlines:[deadline()],questions:[q('qa','a',[{at:'2026-10-19T09:00:00Z',assisted:true}])],diagnostics:{a:{state:'completed'}}})[0];
  assert.equal(base.allocation.mode,'foundation');assert.equal(adapted.allocation.mode,'repair');
  assert.ok(adapted.tasks.some(task=>task.kind==='focus'&&task.questionId==='qa'));
  assert.equal(adapted.tasks[0].kind,'recall');
});

test('legacy current-period capacity stays fixed across future CSAT dates',()=>{
  const result=hybridDeadlines({today,targets:[{id:'a',schedule:{personal_date:'2026-11-29'}}],schedules:[],coverage:[],availability:{...availability,blockedDates:[],overrides:{},beforeCsatWeekdayMinutes:20,beforeCsatWeekendMinutes:20,weekdayMinutes:120,weekendMinutes:120}})[0];
  assert.equal(result.availableMinutes,40*20);
  assert.equal(result.daysLeft,40);
});

test('manual, completed, performed, past, and same-day started tasks survive replanning',()=>{
  const automatic={date:today,target:{automaticPractice:{hybrid:{kind:'focus'}}}};
  assert.equal(preserveHybridPlan(automatic,today),false);
  assert.equal(preserveHybridPlan({...automatic,completed:true},today),true);
  assert.equal(preserveHybridPlan({...automatic,performedAt:'2026-10-20T00:00:00Z'},today),true);
  assert.equal(preserveHybridPlan({...automatic,date:'2026-10-19'},today),true);
  assert.equal(preserveHybridPlan({...automatic,target:{automaticPractice:{startedAt:'2026-10-20T00:00:00Z'}}},today),true);
  assert.equal(preserveHybridPlan({...automatic,date:'2026-10-21',target:{automaticPractice:{startedAt:'2026-10-20T00:00:00Z'}}},'2026-10-21'),true);
  assert.equal(preserveHybridPlan({date:today,target:null},today),true);
  const fixed={id:'manual',title:'직접 계획',kind:'focus' as const,minutes:15,reason:'manual',targetId:'a',activityIds:[],status:'pending' as const,date:today,manual:true};
  const days=hybridTrainingDays({today,availability,deadlines:[deadline()],questions:[q('qa')],fixedTasks:[fixed]});
  assert.equal(days[0].tasks[0],fixed);assert.equal(days[0].plannedMinutes,20);
});

test('finishing diagnosis changes the remaining work without inserting another opening block',()=>{
  const full={...availability,csatDate:null,weekdayMinutes:120,weekendMinutes:120};
  const initial=hybridTrainingDays({today,availability:full,deadlines:[deadline()],questions:[q('qa'),q('qb')]})[0];
  const opening={...initial.tasks.find(task=>task.kind==='diagnostic')!,id:'completed-diagnostic',completed:true,status:'completed' as const};
  const after=hybridTrainingDays({today,availability:full,deadlines:[deadline()],questions:[q('qa'),q('qb')],diagnostics:{a:{state:'completed'}},fixedTasks:[opening]})[0];
  assert.equal(after.tasks[0],opening);
  assert.equal(after.tasks.filter(task=>task.kind==='diagnostic'||task.kind==='recall').length,1);
  assert.equal(after.plannedMinutes,120);
  assert.ok(after.tasks.some(task=>task.kind==='focus'));
  assert.ok(after.tasks.some(task=>task.kind==='mixed'));
});

test('deadline and observed diagnosis change time ratios; D-3 without evidence still keeps foundations',()=>{
  const full={...availability,csatDate:null,weekdayMinutes:120,weekendMinutes:120};
  const practiced=[q('qa','a',[{at:'2026-10-19T09:00:00Z'}]),q('qb','a',[{at:'2026-10-19T09:00:00Z'}])];
  const diagnostics={a:{state:'completed'}};
  const close=hybridTrainingDays({today,availability:full,deadlines:[deadline('a','2026-10-23')],questions:practiced,diagnostics})[0];
  const far=hybridTrainingDays({today,availability:full,deadlines:[deadline('a','2026-12-15')],questions:practiced,diagnostics})[0];
  const foundational=hybridTrainingDays({today,availability:full,deadlines:[deadline('a','2026-10-23')],questions:[q('qa'),q('qb')]})[0];
  const duration=(day:typeof close,kind:string)=>day.tasks.filter(task=>task.kind===kind).reduce((sum,task)=>sum+task.minutes,0);
  assert.equal(close.allocation.mode,'rehearsal');assert.equal(far.allocation.mode,'connection');assert.equal(foundational.allocation.mode,'foundation');
  assert.ok(duration(close,'mixed')>duration(far,'mixed'));
  assert.ok(duration(foundational,'focus')>duration(close,'focus'));
  assert.ok(duration(foundational,'mixed')<duration(close,'mixed'));
  const repair=hybridAllocation(today,[q('qa','a',[{at:'2026-10-19T09:00:00Z',assisted:true}])],[deadline('a','2026-10-23')],diagnostics);
  assert.equal(repair.mode,'repair');assert.ok(repair.mixedShare<.4,'remaining review precedes deadline-driven rehearsal');
});

test('a date-specific time change reuses a stable task identity while changing its stored minutes',()=>{
  const full={...availability,csatDate:null,weekdayMinutes:120,weekendMinutes:120};
  const next='2026-10-21';
  const initial=hybridTrainingDays({today,availability:full,deadlines:[deadline()],questions:[q('qa')]});
  const changed=hybridTrainingDays({today,availability:{...full,revision:2,overrides:{[next]:180}},deadlines:[deadline()],questions:[q('qa')]});
  assert.equal(initial[1].tasks[0].id,changed[1].tasks[0].id);
  assert.notEqual(initial[1].tasks[0].minutes,changed[1].tasks[0].minutes);
  assert.equal(initial[1].plannedMinutes,120);assert.equal(changed[1].plannedMinutes,180);
  assert.equal(initial[0].plannedMinutes,changed[0].plannedMinutes);
});


test('all available minutes are learning time; old automatic breaks do not reduce or enter the plan',()=>{
 for(const capacity of [1,20,50,90,120,180,480]){
  const current={...availability,version:2,weekdayMinutes:capacity,weekendMinutes:capacity,blockedDates:[],overrides:{}};delete (current as any).csatDate;delete (current as any).beforeCsatWeekdayMinutes;delete (current as any).beforeCsatWeekendMinutes;
  const oldBreak={id:'legacy-break',title:'잠시 쉬기',kind:'break' as const,minutes:10,reason:'old',targetId:'a',activityIds:[],status:'completed' as const,completed:true,date:today};
  const result=hybridTrainingDays({today,availability:current,deadlines:[deadline()],questions:[q('qa')],fixedTasks:[oldBreak]})[0];
  assert.equal(result.capacityMinutes,capacity);assert.equal(result.plannedMinutes,capacity);assert.equal(result.unallocatedMinutes,0);assert.ok(result.tasks.every(task=>task.kind!=='break'));assert.equal(result.tasks.reduce((sum,task)=>sum+task.minutes,0),capacity);
 }
});
