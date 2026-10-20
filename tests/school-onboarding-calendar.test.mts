import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSchoolCalendarPreview,schoolCalendarRegistration} from '../apps/web/src/lib/school-onboarding-calendar-model.ts';
import {overlayOfficialCalendar,type OfficialCalendarSupplement} from '../apps/web/src/lib/official-admission-calendar.ts';
import type {AdmissionCalendarCatalogue} from '../apps/web/src/lib/admission-calendar-model.ts';
import {schoolDirectory,normalizeSchoolSelection} from '../apps/web/src/lib/school-directory.ts';
import {isReferenceCalendarUrl} from '../apps/web/src/lib/calendar-source-presentation.ts';
const base=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url),'utf8')) as AdmissionCalendarCatalogue;
const official=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-official.json',import.meta.url),'utf8')) as OfficialCalendarSupplement;
const snapshot=()=>{const copy=JSON.parse(JSON.stringify({base,official}));return {catalogue:overlayOfficialCalendar(copy.base,copy.official),official:copy.official,officialSchools:8,stale:false,lastRefreshFailed:false,refreshDue:false};};
const uos=schoolDirectory.find(school=>school.canonicalName==='서울시립대학교')!;
const target={university:uos.university,school_reference_id:uos.id,campus:'본교',department:'환경공학부',admission_type:'학생부종합전형Ⅰ(면접형)',admission_year:2027};
test('2027 environmental engineering chooses 2026-11-29, not humanities on the preceding day',()=>{
  const preview=buildSchoolCalendarPreview(snapshot(),target);
  assert.equal(preview.status,'registered');assert.equal(preview.calendarYear,2026);assert.equal(preview.matched.length,1);
  assert.equal(preview.matched[0].startDate,'2026-11-29');assert.equal(preview.matched[0].endDate,'2026-11-29');assert.equal(preview.references.length,0);
  assert.equal(preview.matched[0].matchedDepartment,'환경공학부');assert.equal(preview.matched[0].sourceLabel,'');assert.equal(preview.matched[0].sourceUrl,'');
});
test('a humanities major resolves its own 2026-11-28 departmental split',()=>{
  const preview=buildSchoolCalendarPreview(snapshot(),{...target,department:'경제학부'});
  assert.equal(preview.matched[0].startDate,'2026-11-28');assert.equal(preview.references.length,0);
});
test('unknown tracks may show reference dates but cannot assert a personal match',()=>{
  const preview=buildSchoolCalendarPreview(snapshot(),{...target,admission_type:'공식 확인 전 입력 전형'});
  assert.equal(preview.status,'school_reference');assert.equal(preview.matched.length,0);assert.ok(preview.references.length);
  assert.ok(preview.references.every(item=>item.applicability==='school_reference'));
  assert.equal(preview.canReview,false,'free text cannot turn unmatched school reference dates into a registrable target');
});
test('an empty track cannot complete the calendar confirmation step',()=>{
  const preview=buildSchoolCalendarPreview(snapshot(),{...target,admission_type:'미정'});
  assert.equal(preview.canReview,false);assert.ok(preview.tracks.includes('학생부종합전형I (면접형)'));
});
test('interview-only school hints stay selectable references without claiming a department match',()=>{
  const data=snapshot(),school=data.catalogue.schools.find(row=>row.schoolReferenceId===uos.id)!;
  const original=school.entries.find(entry=>entry.departments.includes('환경공학부')&&entry.trackLabel.includes('면접형'))!;
  school.entries=[{...original,trackLabel:'다른 학과 전형',departments:['컴퓨터과학부'],departmentLabel:'컴퓨터과학부',departmentCount:99},
    {...original,trackLabel:'학생부종합전형Ⅱ(서류형)'},
    {...original,trackLabel:'학과 확인된 면접 전형'}];
  school.unresolved.push({id:'unscoped',kind:'interview',sourceUniversity:school.university,trackLabel:'학교 전체 미확인 전형',rawDate:'미정',reason:'학과 범위 미확인',departmentCount:5,sourceUrl:'https://example.edu'});
  const preview=buildSchoolCalendarPreview(data,{...target,admission_type:'미정'});
  assert.deepEqual(preview.tracks,['다른 학과 전형','학과 확인된 면접 전형','학교 전체 미확인 전형']);
  for(const label of ['다른 학과 전형','학교 전체 미확인 전형']){const reference=buildSchoolCalendarPreview(data,{...target,admission_type:label});assert.equal(reference.canReview,true);assert.equal(reference.status,'school_reference');assert.equal(reference.registrationScope,'school_reference');assert.equal(reference.matched.length,0);assert.match(reference.note,/학과.*확인 전/);}
  assert.equal(buildSchoolCalendarPreview(data,{...target,admission_type:'학생부종합전형Ⅱ(서류형)'}).canReview,false);
  school.entries[0].departmentCount=1;
  assert.ok(!buildSchoolCalendarPreview(data,{...target,admission_type:'미정'}).tracks.includes('다른 학과 전형'),'an explicit complete exclusion never becomes a selectable broad reference');
});
test('an unknown campus preserves school references while an explicit other campus stays excluded',()=>{
  const data=snapshot(),school=data.catalogue.schools.find(row=>row.schoolReferenceId===uos.id)!;
  school.entries=school.entries.map(entry=>({...entry,sourceCampus:'서울'}));
  const unknown=buildSchoolCalendarPreview(data,{...target,campus:'미정'});assert.ok(unknown.tracks.length>0);assert.ok(unknown.trackOptions.every(option=>option.scope==='school_reference'));
  assert.ok(buildSchoolCalendarPreview(data,{...target,campus:'서울'}).tracks.length>0);
  assert.deepEqual(buildSchoolCalendarPreview(data,{...target,campus:'다른캠퍼스'}).tracks,[]);
});
test('another admission year never borrows the 2027 schedule',()=>{
  for(const year of [2026,2028]){const preview=buildSchoolCalendarPreview(snapshot(),{...target,admission_year:year});assert.equal(preview.status,'year_mismatch');assert.equal(preview.matched.length+preview.references.length,0);assert.deepEqual(preview.tracks,[]);}
});
test('2027 susi dates accidentally dated 2027 remain unresolved and are never registered',()=>{
  const data=snapshot(),entry=data.catalogue.schools.find(school=>school.schoolReferenceId===uos.id)!.entries.find(entry=>entry.departments.includes('환경공학부')&&entry.trackLabel.includes('면접형'))!;
  entry.startDate=entry.endDate='2027-11-29';entry.dates=['2027-11-29'];entry.segments=[{startDate:'2027-11-29',endDate:'2027-11-29'}];
  const preview=buildSchoolCalendarPreview(data,target);assert.equal(preview.status,'unverified');assert.equal(preview.matched.length,0);
});
test('a no-interview decision is separate from a pending date and never borrows other track dates',()=>{
  for(const status of ['no_interview','date_pending','unpublished','unverified'] as const){
    const data=snapshot(),school=data.official.schools[0];
    school.decisions=[{trackLabel:'Fixture track',departments:['Fixture major'],status,reason:'Fixture evidence only.',sourceUrl:school.sources[0].url}];
    const preview=buildSchoolCalendarPreview(data,{university:school.university,school_reference_id:school.schoolReferenceId,campus:'본교',department:'Fixture major',admission_type:'Fixture track',admission_year:2027});
    assert.equal(preview.status,status);assert.equal(preview.matched.length+preview.references.length,0);assert.ok(preview.decisionSourceUrl);
    if(status==='no_interview'||status==='unverified'){assert.equal(preview.canReview,false);assert.ok(!preview.tracks.includes('Fixture track'));}
  }
});
test('a department ID is resolved only inside its actual selected university',()=>{
  const first=schoolDirectory.find(school=>school.departments.length)!,other=schoolDirectory.find(school=>school.id!==first.id&&school.departments.length)!;
  assert.throws(()=>normalizeSchoolSelection({referenceId:first.id,departmentId:other.departments[0].id}),/선택한 대학의 학과/);
});
test('all 88 university previews preserve dates and official evidence without reference-site attribution or personal appointments',()=>{
  const data=snapshot();assert.equal(data.catalogue.schools.length,88);
  for(const school of schoolDirectory){
    if(!school.departments.length)continue;
    const calendarSchool=data.catalogue.schools.find(row=>row.schoolReferenceId===school.id)!;
    const preview=buildSchoolCalendarPreview(data,{university:school.university,school_reference_id:school.id,campus:school.departments[0].campus,department:school.departments[0].name,admission_type:calendarSchool.entries[0]?.trackLabel||'미정',admission_year:2027});
    for(const entry of [...preview.matched,...preview.references]){assert.match(entry.startDate,/^2026-/);assert.equal(isReferenceCalendarUrl(entry.sourceUrl),false);assert.doesNotMatch(entry.sourceLabel,/아컨|acon/i);assert.ok(entry.checkedAt);}
    const registered=schoolCalendarRegistration({...preview,fingerprint:'0'.repeat(64)},'2026-10-14T08:00:00Z');
    assert.equal(registered.personal_appointment_confirmed,false);assert.equal((registered as any).personal_at,undefined);assert.equal((registered as any).interview_date,undefined);
    assert.ok(registered.source_urls.every(url=>url&&!isReferenceCalendarUrl(url)));
  }
});
test('registration retains public reference labels, exact entries and the reviewed fingerprint',()=>{
  const preview={...buildSchoolCalendarPreview(snapshot(),target),fingerprint:'a'.repeat(64)};
  const registered=schoolCalendarRegistration(preview,'2026-10-14T08:00:00Z');
  assert.equal(registered.admission_year,2027);assert.equal(registered.calendar_year,2026);assert.equal(registered.fingerprint,preview.fingerprint);
  assert.equal(registered.matched_entry_ids.length,1);assert.ok(registered.matched_entry_ids.every(id=>!id.endsWith(':preview')));assert.deepEqual(registered.source_urls,[]);
});
