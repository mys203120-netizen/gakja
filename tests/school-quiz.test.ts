import assert from 'node:assert/strict';
import {test} from 'node:test';
import {schoolDirectory} from '../apps/web/src/lib/school-directory';
import {schoolQuizItems,schoolQuizTargetIdentity,sameSchoolQuizSource} from '../apps/web/src/lib/school-quiz';
import {quizOutcome} from '../apps/web/src/lib/quiz-rules';
import {selectQuizItems} from '../apps/web/src/lib/quiz-selection';
const school=schoolDirectory.find(item=>item.canonicalName==='서울시립대학교')!;
const department=school.departments.find(item=>item.name==='환경공학부')!;
const target={id:'owned-target',university:school.university,school_reference_id:school.id,department_catalog_id:department.id,department:department.name,campus:department.campus,admission_year:2027,admission_type:'합성 검증'};
const question={id:'common_fixture',prompt:'배려와 책임을 본인의 공부와 연결해 말해 주세요.',common_revision:2,source_type:'general_practice',source_ref_ids:['source'],answer_elements:['판단 기준','실제 경험 또는 앞으로의 계획'],source_snapshot:{url:'https://admission.uos.ac.kr/',title:'공식 가치',summary:'타인에 대한 책임',officialPastQuestion:false},talent_profile:{id:'profile',revision:2,scope:'university',point:{id:'ethics',label:'배려와 책임'}}};
test('official value practice remains an ungraded experience question with no invented model answer',()=>{
  const [item]=schoolQuizItems([question],target);
  assert.equal(item.question_id,question.id);assert.equal(item.common_revision,2);assert.equal(item.evaluation_method,'self_check');assert.equal(item.category,'experiential');assert.equal(item.modelAnswer,'');assert.deepEqual(item.activity_ids,[]);
  for(const mode of ['answer','oral'] as const)assert.equal(quizOutcome(item,mode,'배려 배려 배려',null,false),null);
});
test('same public question has separate recall identity for school department year track and target',()=>{
  const changes=[{...target,id:'second-target'},{...target,department:'수학과'},{...target,campus:'다른 캠퍼스'},{...target,admission_year:2028},{...target,admission_type:'다른 전형'},{...target,university:'다른 대학교',school_reference_id:null}];
  const [original]=schoolQuizItems([question],target);
  for(const changed of changes){const [item]=schoolQuizItems([question],changed);assert.notEqual(item.id,original.id);assert.equal(sameSchoolQuizSource(original,item),false);}
});
test('revision identity cannot silently reuse a new source under a previous saved answer',()=>{
  const [original]=schoolQuizItems([question],target),[newer]=schoolQuizItems([{...question,common_revision:3}],target);
  assert.notEqual(original.id,newer.id);assert.equal(sameSchoolQuizSource(original,newer),false);assert.equal(sameSchoolQuizSource(original,schoolQuizItems([question],target)[0]),true);
});
test('saved source and talent snapshots are independent of later catalogue edits',()=>{
  const mutable=structuredClone(question);const [item]=schoolQuizItems([mutable],target);
  mutable.source_snapshot.summary='다른 정의';mutable.talent_profile.point.label='다른 가치';
  assert.equal(item.source_snapshot.summary,'타인에 대한 책임');assert.equal(item.talent_profile?.point.label,'배려와 책임');assert.equal(item.sourceQuotes?.[0].text,'타인에 대한 책임');
});
test('a department catalogue ID never authorizes another department name or campus',()=>{
  assert.equal(schoolQuizTargetIdentity(target)?.department_catalog_id,department.id);
  assert.equal(schoolQuizTargetIdentity({...target,department:'가짜 학과'})?.department_catalog_id,null);
  assert.equal(schoolQuizTargetIdentity({...target,campus:'가짜 캠퍼스'})?.department_catalog_id,null);
});
test('another target previous weak self-rating does not become the current target recall priority',()=>{
  const [old]=schoolQuizItems([question],target),[current]=schoolQuizItems([question],{...target,id:'another-target'});
  const result=selectQuizItems([current],[{memory_item_id:old.id,rating:'again',due_at:new Date(0),created_at:new Date(0),data:{correct:null}}]);
  assert.equal(result.wrong,0);assert.equal(result.due,0);assert.equal(result.unseen,1);assert.equal(result.items[0].id,current.id);
});
test('only an explicitly selected approved real activity may join a sourced talent exercise',()=>{
  const activity={id:'approved-club',title:'실험 역할 조율',fact_confirmation:'confirmed_from_record',source_ref_ids:['record']};
  const [item]=schoolQuizItems([question],target,{activity,sourceRefs:[{id:'record',quote:'실험 역할을 나누고 진행함',area:'동아리'}]});
  assert.deepEqual(item.activity_ids,[activity.id]);assert.ok(item.source_ref_ids.includes('record'));assert.ok(item.sourceQuotes?.some(source=>source.text==='실험 역할을 나누고 진행함'));
  assert.equal(item.modelAnswer,'');assert.equal(quizOutcome(item,'answer','우수한 리더입니다.',null,false),null);
  assert.deepEqual(schoolQuizItems([question],target,{activity:{...activity,fact_confirmation:'needs_confirmation'}})[0].activity_ids,[]);
  assert.deepEqual(schoolQuizItems([{...question,talent_profile:undefined}],target,{activity})[0].activity_ids,[]);
});
test('directory campus labels resolve the same authoritative public department identity',()=>{
  const campusSchool=schoolDirectory.find(item=>item.canonicalName==='가톨릭대학교')!,dept=campusSchool.departments[0];
  const snapshot=schoolQuizTargetIdentity({id:'campus-target',university:campusSchool.university,school_reference_id:campusSchool.id,department_catalog_id:dept.id,department:dept.name,campus:campusSchool.campusLabel});
  assert.equal(snapshot?.department_catalog_id,dept.id);assert.equal(snapshot?.campus,campusSchool.campusLabel);
  const prior=schoolQuizTargetIdentity({id:'campus-target',university:campusSchool.canonicalName,department:dept.name,campus:dept.campus});
  assert.equal(prior?.department_catalog_id,dept.id);assert.equal(prior?.campus,campusSchool.campusLabel);
});
test('PostgreSQL jsonb key order does not sever a semantically identical historic school exercise',()=>{
  const [item]=schoolQuizItems([question],target);
  const saved={...item,target_snapshot:Object.fromEntries(Object.entries(item.target_snapshot!).reverse())};
  assert.equal(sameSchoolQuizSource(saved,item),true);
});
