import test from 'node:test';
import assert from 'node:assert/strict';
import {schoolDirectory,schoolDirectoryEntry,normalizeSchoolSelection} from '../apps/web/src/lib/school-directory';
import {interviewSupportForTarget,schoolHasDocumentInterview,isStudentRecordQuestion,interviewPracticeForContext} from '../apps/web/src/lib/school-interview-scope';
import {departmentLearningContext,departmentPracticeQuestions,departmentQuestionMatchesTarget} from '../apps/web/src/lib/department-learning';
import {knowledgeTarget,schoolKnowledgeReadings,addCommonKnowledgeConnections} from '../apps/web/src/lib/knowledge-target-model';
import {matchKnowledgeVideos} from '../apps/web/src/lib/knowledge-bites-catalog';
import {automaticPracticeDays,practicePhase,practiceDeadline,todayPlanAgenda} from '../apps/web/src/lib/automatic-practice';
import {planPracticeEventMatches} from '../apps/web/src/lib/planner-model';
import {learningScopeIdentity} from '../apps/web/src/lib/learning-target-scope';
import programDetails from '../apps/web/src/data/school-department-details.json';
const targetFor=(university:string,department:string)=>{const school=schoolDirectory.find(s=>s.canonicalName===university)!,unit=school.departments.find(d=>d.name===department)!;return {id:'target-a',university,department,major:department,school_reference_id:school.id,department_catalog_id:unit.id,campus:school.campusLabel||unit.campus,admission_year:2027,admission_type:'학생부종합(면접형)'};};

test('passage-only, video-submission and no-interview schools leave the selectable release, with historical IDs preserved',()=>{
  for(const name of ['연세대학교','부산교육대학교','경인교육대학교','공주교육대학교','한국에너지공과대학교','영남대학교','홍익대학교','한국과학기술원']){
    assert.equal(schoolHasDocumentInterview(name),false);assert.ok(!schoolDirectory.some(s=>s.canonicalName===name));
    assert.throws(()=>normalizeSchoolSelection({university:name,major:'임의학과'}));
  }
  assert.equal(schoolDirectory.length,80);
  assert.ok(schoolDirectoryEntry('bible_02f5a3e9a0f7b346'));
});
test('mixed universities are filtered by track and department, not deleted as a whole',()=>{
  const cases:[string,string,string,boolean][]=[
    ['서울대학교','지역균형전형','기계공학부',true],['서울대학교','일반전형','컴퓨터공학부',false],['서울대학교','지역균형전형','의예과',false],
    ['고려대학교','사이버국방전형','사이버국방학과',true],['고려대학교','계열적합전형','경영학과',false],
    ['성균관대학교','과학인재','반도체시스템공학과',false],['성균관대학교','성균인재','교육학과',true],['성균관대학교','융합인재','공학계열',false],['성균관대학교','성균인재','공학계열',false],
    ['삼육대학교','예체능인재','아트앤디자인학과',false],['삼육대학교','세움인재','간호학과',true],
    ['한양대학교','학생부종합(면접형)','컴퓨터소프트웨어학부',false],['한양대학교','학생부종합(면접형)','교육학과',true],
    ['포항공과대학교 POSTECH','일반전형Ⅰ','단일계열',false],['포항공과대학교 POSTECH','일반전형Ⅱ','단일계열',true],
    ['한국과학기술원 KAIST','일반전형','새내기과정학부',false],['한국과학기술원 KAIST','특기자전형','새내기과정학부',false],
    ['아주대학교','ACE','의학과',false],['아주대학교','ACE','간호학과',true],['세종대학교','세종인재(면접형)','디자인이노베이션전공',false],
  ];
  for(const [university,admission_type,department,expected] of cases)assert.equal(interviewSupportForTarget({university,admission_type,department,admission_year:2027}).supported,expected,[university,admission_type,department].join(' '));
  assert.ok(!schoolDirectory.find(s=>s.canonicalName==='한양대학교')!.departments.some(d=>/컴퓨터소프트웨어/.test(d.name)));
});
test('standalone passage questions are rejected while actual student-record questions remain',()=>{
  assert.equal(isStudentRecordQuestion({prompt:'제시문을 읽고 공통점을 설명하세요.'}),false);
  assert.equal(isStudentRecordQuestion({prompt:'질문',grounding_types:['passage_based']}),false);
  assert.equal(isStudentRecordQuestion({prompt:'실험의 그래프를 해석했던 과정을 설명해 주세요.',grounding_types:['document_based']}),true);
});
test('an old unsupported target permits owned published record practice, including unselected Chat entry',()=>{
  const target={id:'historical-target',university:'고려대학교',department:'경영학과',admission_type:'고른기회',admission_year:2027};
  const personal={id:'own-question',prompt:'활동에서 맡은 역할과 배운 점을 말해 주세요.',grounding_types:['document_based']};
  const context={target,packageId:'owned-published-package',sourceKind:'mixed',questions:[personal,{id:'public-question',prompt:'지원 동기를 말해 주세요.',common_revision:1},{id:'passage',prompt:'제시문을 읽고 답하세요.'}]};
  for(const questionId of [undefined,personal.id]){
    const practice=interviewPracticeForContext({...context,questionId});
    assert.equal(practice.allowed,true);assert.equal(practice.scope,'personal_record');assert.equal(practice.label,'일반 경험 면접');assert.match(practice.notice!,/실제 면접 방식/);assert.deepEqual(practice.questions,[personal]);
  }
  assert.equal(context.target,target);assert.equal(context.questions.length,3,'selection does not rewrite the published snapshot');
  for(const override of [{questionId:'public-question'},{questionId:'passage'},{sourceKind:'common'},{packageId:'common-bank'},{briefingId:'public-briefing'},{questions:[]}])assert.equal(interviewPracticeForContext({...context,...override}).allowed,false);
});
test('a compatible school stays in its normal scope and a forged Korea track cannot override its major',()=>{
  assert.equal(interviewPracticeForContext({target:{university:'서울시립대학교',department:'환경공학부'},questions:[]}).scope,'school');
  assert.equal(interviewSupportForTarget({university:'고려대학교',department:'경영학과',admission_type:'사이버국방전형'}).supported,false);
  assert.throws(()=>normalizeSchoolSelection({university:'고려대학교',major:'경영학과'}),/학생부형 학과/);
});
test('display-only link enrichment cannot change an acknowledged interview classification',()=>{
  const target={university:'서울시립대학교',department:'환경공학부',admission_type:'학생부종합전형Ⅰ(면접형)',admission_year:2027};
  assert.deepEqual(interviewSupportForTarget(target),interviewSupportForTarget({...target,school_admission_url:'https://admission.uos.ac.kr/'}));
});
test('another admission year cannot bypass the verified interview scope',()=>{
  for(const admission_year of [2026,2028]){
    const result=interviewSupportForTarget({university:'연세대학교',department:'경영학과',admission_type:'활동우수형',admission_year});
    assert.equal(result.supported,false);assert.equal(result.format,'needs_selection');
  }
});
test('all selectable school/department/campus combinations have sourced major learning and distinct question IDs',()=>{
  const ids=new Set<string>();let total=0;
  for(const school of schoolDirectory)for(const department of school.departments){
    const target={id:'matrix',university:school.university,school_reference_id:school.id,department:department.name,department_catalog_id:department.id,campus:school.campusLabel||department.campus,admission_year:2027};
    const context=departmentLearningContext(target)!;assert.ok(context);assert.ok(context.topics.length>=2);
    for(const question of departmentPracticeQuestions(target)){
      assert.ok(!ids.has(question.id));ids.add(question.id);assert.equal(question.source_snapshot.officialCurriculum,false);assert.ok(question.source_snapshot.url.startsWith('https:'));assert.deepEqual(question.activity_ids,[]);assert.equal(departmentQuestionMatchesTarget(question,target),true);assert.equal(departmentQuestionMatchesTarget(question,{...target,campus:'잘못된 캠퍼스'}),false);
    }
    total++;
  }
  assert.ok(total>3000);assert.ok(ids.size>6000);
});
test('unowned department metadata never becomes a confirmed major context',()=>{
  const target=targetFor('서울시립대학교','환경공학부');
  assert.equal(departmentLearningContext({...target,department:'존재하지 않는 과'}),null);
  assert.deepEqual(departmentPracticeQuestions({...target,department_catalog_id:'foreign'}),[]);
});
test('major readings and videos link to the same quiz/interview question and revision',()=>{
  const raw=targetFor('서울시립대학교','환경공학부'),target=knowledgeTarget(raw),questions=departmentPracticeQuestions(raw).map(q=>({id:q.id,prompt:q.prompt,activityIds:[],sourceKind:'common' as const,sourceType:q.source_type,commonRevision:q.common_revision,sourceSnapshot:q.source_snapshot,targetId:raw.id,targetSnapshot:target.snapshot}));
  const readings=schoolKnowledgeReadings(raw,questions).filter(item=>item.sourceSnapshot?.kind==='department_learning');
  assert.ok(readings.some(item=>item.topic==='수질과 정수'));assert.ok(readings.every(item=>item.summary&&item.relatedQuestionIds?.length&&item.id.length===11));
  const videos=addCommonKnowledgeConnections(matchKnowledgeVideos({},target),questions,target);
  for(const question of questions)assert.ok(videos.some(video=>video.id===question.sourceSnapshot.knowledgeVideoId&&video.relatedQuestionIds?.includes(question.id)));
});
test('a broad admission unit keeps its identity while validated constituent interests change learning',()=>{
  const raw=targetFor('명지대학교','스마트시스템공과대학'),unit=schoolDirectoryEntry(raw.school_reference_id)!.departments.find(d=>d.id===raw.department_catalog_id)!;
  assert.ok(unit.programs?.includes('기계시스템공학부 로봇공학전공'));
  const robot={...raw,interest_department:'기계시스템공학부 로봇공학전공'},environment={...raw,interest_department:'스마트인프라공학부 환경시스템공학전공'};
  assert.equal(departmentLearningContext(robot)?.admissionUnit,'스마트시스템공과대학');assert.ok(departmentLearningContext(robot)?.topics.some(t=>t.topic==='알고리즘'));
  assert.ok(departmentLearningContext(environment)?.topics.some(t=>t.topic==='수질과 정수'));
  assert.ok(departmentPracticeQuestions(robot).every(q=>!departmentQuestionMatchesTarget(q,environment)));
  assert.equal(departmentLearningContext({...raw,interest_department:'다른 학교 학과'})?.department,raw.department);
  assert.notDeepEqual(knowledgeTarget(robot).snapshot,knowledgeTarget(environment).snapshot);
  assert.notDeepEqual(learningScopeIdentity(robot),learningScopeIdentity(environment),'same broad unit reloads client learning when the interest changes');
});
test('every officially connected program belongs to its university unit and yields distinct sourced learning',()=>{
  const owners=new Set<string>(),ids=new Set<string>();
  for(const supplement of programDetails.units){
    const key=JSON.stringify([supplement.university,supplement.unit]);assert.ok(!owners.has(key));owners.add(key);
    const raw=targetFor(supplement.university,supplement.unit),unit=schoolDirectoryEntry(raw.school_reference_id)!.departments.find(d=>d.id===raw.department_catalog_id)!;
    const host=new URL(supplement.sourceUrl).hostname;assert.ok(host.endsWith('.ac.kr')||host==='admission.skku.edu');assert.ok([2026,2027].includes(unit.programSourceYear!));
    assert.equal(new Set(unit.programs).size,unit.programs?.length);assert.deepEqual(unit.programs,supplement.programs);
    for(const interest_department of supplement.programs){
      const target={...raw,interest_department},context=departmentLearningContext(target)!;assert.equal(context.department,interest_department);assert.equal(context.admissionUnit,supplement.unit);
      assert.ok(context.topics.length>=2);assert.equal(context.officialCurriculum,false);
      assert.doesNotThrow(()=>normalizeSchoolSelection({referenceId:raw.school_reference_id,departmentId:raw.department_catalog_id,interestDepartment:interest_department}));
      for(const question of departmentPracticeQuestions(target)){assert.ok(!ids.has(question.id));ids.add(question.id);assert.ok(departmentQuestionMatchesTarget(question,target));assert.equal(departmentQuestionMatchesTarget(question,{...target,interest_department:''}),false);}
    }
  }
  const computer={...targetFor('전북대학교','공학계열 2'),interest_department:'컴퓨터인공지능학부'};
  assert.ok(departmentLearningContext(computer)?.topics.some(item=>item.topic==='알고리즘'));
  const business={...targetFor('전북대학교','경상계열'),interest_department:'경영학과'};
  assert.ok(departmentLearningContext(business)?.topics.some(item=>item.topic==='시장과 기대'));
  const energy={...targetFor('전북대학교','공학계열 1'),interest_department:'토목/환경/자원·에너지공학부(자원·에너지공학전공)'};
  assert.ok(!departmentLearningContext(energy)?.topics.some(item=>item.topic==='수질과 정수'),'a shared faculty name does not override the selected specialization');
  assert.throws(()=>normalizeSchoolSelection({referenceId:computer.school_reference_id,departmentId:computer.department_catalog_id,interestDepartment:'경영학과'}));
});
test('D-day stages change practice, bound a rolling week and lighten the final day',()=>{
  assert.deepEqual([40,21,7,1].map(practicePhase),['foundation','connection','rehearsal','final']);
  const questions=[{id:'a',title:'개념',practiced:false,category:'major' as const},{id:'b',title:'내 경험',practiced:false,category:'personal' as const},{id:'c',title:'학교 가치',practiced:true,category:'talent' as const}];
  const early=automaticPracticeDays('2026-10-17','2026-12-01',20,questions);assert.equal(new Set(early.map(p=>p.date)).size,7);assert.equal(early[0].kind,'quiz');
  const late=automaticPracticeDays('2026-11-25','2026-12-01',30,questions);assert.ok(late.every(p=>p.kind==='interview'&&p.date<'2026-12-01'));
  assert.equal(late.filter(p=>p.date==='2026-11-30').length,1);assert.equal(late.at(-1)?.minutes,10);
  for(const date of new Set(late.map(p=>p.date))){const day=late.filter(p=>p.date===date);assert.ok(day.length<=3);assert.equal(new Set(day.map(p=>p.questionId)).size,day.length);}
});
test('deadline resolution separates a KST appointment, one public day, a goal and an unresolved period',()=>{
  assert.deepEqual(practiceDeadline({schedule:{personal_at:'2026-10-17T16:00:00Z'},school_interview_date:'2026-10-22'},{interviewDate:'2026-10-25'}),{date:'2026-10-18',source:'personal',label:'개별 면접일'});
  assert.equal(practiceDeadline({school_interview_date:'2026-11-20'})?.source,'public_day');
  assert.equal(practiceDeadline({schedule:{period_start:'2026-11-20',period_end:'2026-11-22'}}),null);
  assert.equal(practiceDeadline({}, {interviewDate:'2026-11-19'})?.source,'goal');
});
test('today work includes overdue manual plans without resurrecting old automatic backlog',()=>{
  const plans=[{id:'manual',date:'2026-10-15',completed:false},{id:'today',date:'2026-10-17',target:{targetId:'a',automaticPractice:{status:'active'}}},{id:'old-auto',date:'2026-10-16',target:{automaticPractice:{status:'active'}}},{id:'replaced',date:'2026-10-17',target:{automaticPractice:{status:'superseded'}}},{id:'other',date:'2026-10-17',target:{targetId:'b'}},{id:'future',date:'2026-10-18'}];
  assert.deepEqual(todayPlanAgenda(plans,'2026-10-17','a').map(p=>p.id).sort(),['manual','today']);
});
test('an answer today cannot mark every old automatic repetition as performed',()=>{
  const target={kind:'question',id:'q',targetId:'a',sourceType:'common',sourceVersion:1,common:true,automaticPractice:{}};
  const plan={date:'2026-10-16',created_at:'2026-10-15T01:00:00Z',kind:'interview',target};
  const event={kind:'interview_answer',created_at:'2026-10-17T01:00:00Z',data:{questionId:'q',targetId:'a',sourceType:'common',commonRevision:1}};
  assert.equal(planPracticeEventMatches(plan,event,new Set(['q']),()=>true),false);
  assert.equal(planPracticeEventMatches({...plan,date:'2026-10-17'},event,new Set(['q']),()=>true),true);
});
