import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseTodayAction,resumableQuizSessions,localQuizDraftActivity} from '../apps/web/src/lib/learning-journey';
import {dashboardDeadlineRows,primaryDeadlineRow} from '../apps/web/src/lib/dashboard-deadlines';
import {todayPlanAgenda} from '../apps/web/src/lib/automatic-practice';
import {dashboardAgenda} from '../apps/web/src/lib/dashboard-agenda';

const target={id:'t',university:'고려대학교',campus:'본교',department:'경영학과',admission_year:2027,admission_type:'학생부종합'};
const session=(fields:Record<string,unknown>={})=>({id:'s',student_id:'student',mode:'answer',state:'active',current_index:0,total:3,updated_at:'2026-10-19T01:00:00Z',metadata:{targetId:target.id,targetSnapshot:target,drafts:{'0':{response:'내가 직접 한 일',updatedAt:'2026-10-19T01:00:00Z'}}},...fields});
const input={studentId:'student',targets:[target]};
test('home resumes current first-question drafts and paused or review-waiting sessions before new recommendations',()=>{
  for(const state of ['active','paused','ready']){
    const action=chooseTodayAction({...input,hasPackage:true,quiz:{sessions:[session({state})],recommendation:{count:5,wrong:2}}});
    assert.equal(action.href,'/quiz/session/s');assert.equal(action.resume,'quiz');assert.match(action.reason,/작성 중인 답변 1개/);
  }
  const ready=session({state:'ready',current_index:1,metadata:{targetId:'t',targetSnapshot:target}});
  assert.equal(resumableQuizSessions({...input,sessions:[ready]})[0].id,'s');
});
test('resume chooses recent activity, including an unsent local first-item draft, instead of session creation order',()=>{
  const recent=session({id:'new-activity',created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-19T03:00:00Z'});
  const old=session({id:'new-created',created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-19T01:00:00Z'});
  assert.equal(resumableQuizSessions({...input,sessions:[old,recent]})[0].id,'new-activity');
  const empty=session({id:'local',metadata:{targetId:'t',targetSnapshot:target}});
  const localDrafts=[{sessionId:'local',itemIndex:0,hasDraft:true,updatedAt:'2026-10-19T04:00:00Z'}];
  assert.equal(resumableQuizSessions({...input,sessions:[recent,empty],localDrafts})[0].id,'local');
  assert.equal(resumableQuizSessions({...input,sessions:[empty],localDrafts:[{...localDrafts[0],itemIndex:1}]}).length,0);
});
test('resume rejects another student, school, changed registration, invalid index and finished sessions',()=>{
  for(const foreign of [session({student_id:'other'}),session({student_id:undefined}),session({state:'completed'}),session({state:'ended'}),session({current_index:3}),session({current_index:-1}),session({metadata:{targetId:'other',targetSnapshot:target,drafts:{'0':'text'}}}),session({metadata:{targetId:'t',targetSnapshot:{...target,department:'다른 학과'},drafts:{'0':'text'}}}),session({metadata:{targetId:'t',drafts:{'0':'text'}}})]){
    assert.equal(resumableQuizSessions({...input,sessions:[foreign]}).length,0);
  }
  assert.equal(resumableQuizSessions({...input,sessions:[session()],targets:[{...target,archived_at:'2026-10-19'}]}).length,0);
});
test('local draft discovery reads only authenticated server-listed current-item keys, with newest valid activity timestamp',()=>{
  const values=new Map([['gakja-quiz:student:s:0','own text'],['gakja-quiz:other:s:0','foreign text'],['gakja-quiz:student:unlisted:0','unlisted'],['gakja-quiz-activity:student:s',JSON.stringify({itemIndex:0,hasDraft:true,updatedAt:'2026-10-19T05:00:00Z'})]]);
  const oldStore={getItem:(key:string)=>key.includes('activity')?JSON.stringify({itemIndex:0,hasDraft:true,updatedAt:'2026-10-19T01:00:00Z'}):null};
  const found=localQuizDraftActivity('student',[session(),session({student_id:'other'})],[{getItem:key=>values.get(key)||null},oldStore]);
  assert.deepEqual(found,[{sessionId:'s',itemIndex:0,hasDraft:true,updatedAt:'2026-10-19T05:00:00Z'}]);
  assert.deepEqual(localQuizDraftActivity('student',[session()],[{getItem(){throw Error('disabled');}}]),[]);
});
test('today work is not hidden by many overdue manual plans; practice evidence and automatic history remain distinct',()=>{
  const old=Array.from({length:30},(_,i)=>({id:`old${i}`,date:'2026-10-01',title:'밀린 일',completed:false,target:{targetId:'t'}}));
  const current={id:'today',date:'2026-10-19',title:'오늘 할 한 가지',completed:false,target:{targetId:'t'}};
  const performed={...current,id:'performed',performedAt:'2026-10-19T00:00:00Z'};
  const oldAuto={...old[0],id:'old-auto',target:{targetId:'t',automaticPractice:{status:'active'}}};
  const superseded={...current,id:'superseded',target:{targetId:'t',automaticPractice:{status:'superseded'}}};
  const result=todayPlanAgenda([...old,performed,oldAuto,superseded,current],'2026-10-19','t');
  assert.equal(result[0].id,'today');assert.equal(result[1].id,'performed');assert.equal(result.length,32);
  assert.equal(performed.completed,false);assert.equal(current.completed,false);assert.equal(result.filter(row=>row.overdue).length,30);
});
test('today counts exclude overdue plans, future tasks and work already performed or submitted, preserving every category',()=>{
 const plans=todayPlanAgenda([
  ...Array.from({length:30},(_,i)=>({id:`past-${i}`,date:'2026-10-01',completed:false})),
  {id:'pending',date:'2026-10-19',completed:false},
  {id:'checked',date:'2026-10-19',completed:true},
  {id:'performed',date:'2026-10-19',completed:false,performedAt:'2026-10-19T01:00:00Z'},
 ],'2026-10-19');
 const tasks=[
  ...Array.from({length:10},(_,i)=>({id:`late-${i}`,due_at:'2026-10-18T14:59:00Z',state:'assigned'})),
  {id:'today-end',due_at:'2026-10-19T14:59:00Z',state:'assigned'},
  {id:'tomorrow-kst',due_at:'2026-10-19T15:00:00Z',state:'assigned'},
  {id:'no-deadline',due_at:null,state:'assigned'},
  {id:'submitted',due_at:'2026-10-18T01:00:00Z',state:'submitted'},
  ...['reviewed','completed','cancelled'].map(state=>({id:state,due_at:'2026-10-19T01:00:00Z',state})),
 ];
 const result=dashboardAgenda(plans,tasks,'2026-10-19');
 assert.equal(result.remainingPlans,1);assert.equal(result.overdue.length,30);assert.equal(result.current.length,3);
 assert.deepEqual(result.currentTasks.map(task=>task.id),['today-end','no-deadline']);assert.equal(result.pastTasks.length,10);assert.deepEqual(result.upcomingTasks.map(task=>task.id),['tomorrow-kst']);assert.deepEqual(result.reviewTasks.map(task=>task.id),['submitted']);
 assert.equal(plans.find(plan=>plan.id==='performed')?.completed,false);assert.equal(tasks.find(task=>task.id==='submitted')?.state,'submitted');
});
test('an audio-only first-item checkpoint is discoverable without text and remains bound to its exact item',()=>{
  const empty=session({metadata:{targetId:'t',targetSnapshot:target}});
  const activity=JSON.stringify({itemIndex:0,hasDraft:true,hasRecording:true,updatedAt:'2026-10-19T06:00:00Z'});
  const localDrafts=localQuizDraftActivity('student',[empty],[{getItem:key=>key==='gakja-quiz-activity:student:s'?activity:null}]);
  assert.equal(chooseTodayAction({...input,localDrafts,hasPackage:true,quiz:{sessions:[empty]}}).href,'/quiz/session/s');
  assert.equal(localQuizDraftActivity('student',[{...empty,current_index:1}],[{getItem:key=>key==='gakja-quiz-activity:student:s'?activity:null}]).length,0);
});
test('deadline status honors no interview, pending and unverified without inventing dates or register prompts',()=>{
  const targets=['no_interview','date_pending','unverified','unpublished'].map(status=>({...target,id:status,school_interview_date:'2026-10-29'}));
  const coverage={targets:targets.map(school=>({targetId:school.id,status:school.id}))};
  const rows=dashboardDeadlineRows(targets,[],coverage,'2026-10-19');
  assert.deepEqual(rows.map(row=>row.label),['면접 미실시','면접일 발표 대기','전형 일정 확인 필요','일정 미공개']);
  for(const row of rows){assert.equal(row.deadline,null);assert.equal(row.days,null);assert.equal(row.canRegister,false);}
  const confirmed=dashboardDeadlineRows([{...targets[1],schedule:{personal_date:'2026-10-25'}}],[],coverage,'2026-10-19');
  assert.equal(confirmed[0].label,'D-6');
});
test('deadline summary is nearest upcoming appointment, retaining duplicate applications and reference uncertainty',()=>{
  const rows=dashboardDeadlineRows([{...target,id:'current',schedule:{personal_date:'2026-10-29'}},{...target,id:'nearest',schedule:{personal_date:'2026-10-27'}},{...target,id:'duplicate',schedule:{personal_date:'2026-10-27'}},{...target,id:'reference'}],[{targetId:'reference',startDate:'2026-10-21',endDate:'2026-10-21',applicability:'school_reference'}],undefined,'2026-10-19');
  assert.equal(rows.length,4);assert.equal(rows.filter(row=>row.label==='D-8').length,2);
  assert.equal(primaryDeadlineRow(rows,'current')?.school.id,'nearest');assert.equal(rows[3].label,'면접일 등록');
});
