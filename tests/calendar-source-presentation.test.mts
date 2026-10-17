import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isReferenceCalendarUrl,visibleCalendarSourceLabel,visibleCalendarSourceUrl,visibleCalendarSourceText,presentCalendarSource,retainCalendarSourceFields} from '../apps/web/src/lib/calendar-source-presentation.ts';
import {projectAdmissionCalendar,type AdmissionCalendarSnapshot} from '../apps/web/src/lib/admission-calendar-projection.ts';
import {overlayOfficialCalendar,type OfficialCalendarSupplement} from '../apps/web/src/lib/official-admission-calendar.ts';
import type {AdmissionCalendarCatalogue} from '../apps/web/src/lib/admission-calendar-model.ts';

const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../apps/web/src/data/${name}`,import.meta.url),'utf8')) as T;
const raw=read<AdmissionCalendarCatalogue>('school-interview-calendar.json');
const official=read<OfficialCalendarSupplement>('school-interview-official.json');
const snapshot=():AdmissionCalendarSnapshot=>({catalogue:overlayOfficialCalendar(structuredClone(raw),structuredClone(official)),official:structuredClone(official),officialSchools:8,stale:false,lastRefreshFailed:false,refreshDue:false});
const reference='https://www.acon.io.kr/susi/calendar';

test('reference URL matching uses the actual http(s) hostname, including subdomains',()=>{
  for(const url of [reference,'http://acon.io.kr/susi/calendar','https://ACON.IO.KR:443/','https://calendar.www.acon.io.kr/path?year=2027','//www.acon.io.kr/susi/calendar','https://acon.io.kr./calendar'])assert.equal(isReferenceCalendarUrl(url),true,url);
  for(const url of [null,undefined,{},'',42,'not a url','https://acon.io.kr.example.com/calendar','https://example.com/acon.io.kr','https://notacon.io.kr/calendar','https://admission.example.edu/?source=acon.io.kr','ftp://acon.io.kr/calendar'])assert.equal(isReferenceCalendarUrl(url),false,String(url));
});

test('reference labels and links are omitted while official admissions evidence stays usable',()=>{
  for(const label of ['아컨','아컨 수시 일정','ACON','Acon calendar'])assert.equal(visibleCalendarSourceLabel(label),'');
  assert.equal(visibleCalendarSourceLabel('면접 일정',reference),'');
  assert.equal(visibleCalendarSourceUrl(reference),'');
  const officialUrl='https://admission.example.edu/2027/interview.pdf';
  assert.equal(visibleCalendarSourceLabel('입학처',officialUrl),'입학처');
  assert.equal(visibleCalendarSourceUrl(officialUrl),officialUrl);
  assert.equal(visibleCalendarSourceLabel(null),'');assert.equal(visibleCalendarSourceUrl(undefined),'');
});

test('free text loses reference metadata but keeps actual dates and official guidance',()=>{
  const text=visibleCalendarSourceText(`아컨에서 참고: 2027학년도 면접은 2026-11-29 10:30. ${reference} 입학처 https://admission.example.edu/interview 확인`);
  assert.doesNotMatch(text,/아컨|acon\.io\.kr/i);
  for(const retained of ['2027학년도','2026-11-29','10:30','입학처','https://admission.example.edu/interview'])assert.ok(text.includes(retained),retained);
  assert.equal(visibleCalendarSourceText(undefined),'');
});

test('presentation copies leave original row identity, dates, revisions and import bookkeeping intact',()=>{
  const original={id:'source_fixture',origin:'acon',revision:4,dates:['2026-11-29'],checkedAt:'2026-10-16T00:00:00Z',sourceUrl:reference,sourceLabel:'아컨',note:'아컨 2026-11-29 입학처 확인',rawDate:'11월 29일(일)'};
  const before=JSON.stringify(original),presented=presentCalendarSource(original);
  assert.notEqual(presented,original);assert.equal(presented.sourceUrl,'');assert.equal(presented.sourceLabel,'');assert.doesNotMatch(presented.note,/아컨/);
  for(const key of ['id','origin','revision','dates','checkedAt','rawDate'] as const)assert.deepEqual(presented[key],original[key]);
  assert.equal(JSON.stringify(original),before);
  assert.deepEqual(presentCalendarSource({id:'without-source',note:null}),{id:'without-source',note:null});
});

test('date-only edit input retains omitted hidden provenance while an explicit clear wins',()=>{
  const previous={sourceUrl:reference,note:'아컨 2026-11-29 입학처 확인',dates:['2026-11-29'],revision:2};
  const input={dates:['2026-11-30']},before=JSON.stringify({previous,input});
  const retained=retainCalendarSourceFields(input,previous);
  assert.deepEqual(retained,{sourceUrl:reference,note:previous.note,dates:['2026-11-30']});
  assert.equal('revision' in retained,false,'Only hidden provenance is restored, never a stale date or revision');
  assert.deepEqual(retainCalendarSourceFields({...input,sourceUrl:'',note:''},previous),{dates:['2026-11-30'],sourceUrl:'',note:''});
  assert.equal(JSON.stringify({previous,input}),before,'Merging hidden provenance mutates neither shared input nor stored evidence');
});

test('personal date edits preserve omitted source_url/review_note with explicit clearing and deletion available',()=>{
  const previous={source_url:reference,review_note:'아컨 2026-11-29 입학처 확인',personal_date:'2026-11-29'},fields=['source_url','review_note'];
  const input={personal_date:'2026-11-30'},before=JSON.stringify({previous,input});
  assert.deepEqual(retainCalendarSourceFields(input,previous,fields),{source_url:reference,review_note:previous.review_note,personal_date:'2026-11-30'});
  assert.deepEqual(retainCalendarSourceFields({...input,source_url:'',review_note:''},previous,fields),{personal_date:'2026-11-30',source_url:'',review_note:''});
  assert.equal(JSON.stringify({previous,input}),before);
});

test('student projection removes reference metadata without mutating source versions, identities, dates or verification times',()=>{
  const data=snapshot(),before=JSON.stringify(data);
  const targets=data.catalogue.schools.map(school=>{
    const entry=school.entries[0];
    return {id:`fixture:${school.schoolReferenceId}`,school_reference_id:school.schoolReferenceId,university:school.university,admission_year:2027,campus:entry?.sourceCampus||'본교',department:entry?.departments[0]||'미정',admission_type:entry?.trackLabel||'미정'};
  });
  const projected=projectAdmissionCalendar(data,targets),entries=data.catalogue.schools.flatMap(school=>school.entries);
  assert.equal(targets.length,88);assert.equal(projected.interviewScheduleCoverage.targets.length,88);
  assert.equal(projected.interviewScheduleCoverage.source.url,'');assert.doesNotMatch(projected.interviewScheduleCoverage.source.title,/아컨|acon/i);
  assert.equal(projected.interviewScheduleCoverage.source.checkedAt,data.catalogue.source.checkedAt);
  assert.equal(projected.interviewScheduleCoverage.source.sha256,data.catalogue.source.sha256);
  assert.equal(projected.interviewScheduleCoverage.totalInterviewEntries,data.catalogue.audit.importedInterviewRows);
  assert.ok(projected.interviewSchedules.length>0);
  for(const item of projected.interviewSchedules){
    const entry=entries.find(row=>item.id.startsWith(row.id+':'))!;
    assert.ok(entry,'Every displayed calendar row retains its original stable entry ID');
    assert.ok(entry.segments.some(segment=>segment.startDate===item.startDate&&segment.endDate===item.endDate));
    assert.equal(item.admissionYear,2027);assert.equal(item.schoolReferenceId,entry.schoolReferenceId);
    assert.equal(item.checkedAt,entry.checkedAt||data.catalogue.source.checkedAt);
    assert.equal(item.sourceUrl,visibleCalendarSourceUrl(entry.sourceUrl));
    assert.equal(isReferenceCalendarUrl(item.sourceUrl),false);assert.doesNotMatch(item.sourceLabel,/아컨|acon/i);
    if(entry.sourceKind==='official_admissions'){assert.equal(item.sourceUrl,entry.sourceUrl);assert.equal(item.sourceLabel,'입학처');}
  }
  for(const target of projected.interviewScheduleCoverage.targets){
    for(const source of target.officialSources){assert.ok(source.url);assert.equal(isReferenceCalendarUrl(source.url),false);}
    if(target.decisionSourceUrl)assert.equal(isReferenceCalendarUrl(target.decisionSourceUrl),false);
  }
  assert.equal(JSON.stringify(data),before,'Student presentation never rewrites the imported public evidence or its hash');
});

test('cached legacy branded entry notes are sanitized while their exact schedule remains',()=>{
  const data=snapshot(),school=data.catalogue.schools.find(row=>row.university==='서울시립대학교')!;
  const entry=school.entries.find(row=>row.departments.includes('환경공학부')&&row.trackLabel.includes('면접형'))!;
  entry.sourceKind='admin';entry.sourceLabel='아컨';entry.note=`아컨 ${reference} 2026-11-29 입학처 확인`;
  const projected=projectAdmissionCalendar(data,[{id:'legacy',school_reference_id:school.schoolReferenceId,university:school.university,admission_year:2027,campus:'본교',department:'환경공학부',admission_type:entry.trackLabel}]);
  const item=projected.interviewSchedules.find(row=>row.id.startsWith(entry.id+':'))!;
  assert.ok(item);assert.equal(item.startDate,'2026-11-29');assert.equal(item.sourceUrl,'');assert.equal(item.sourceLabel,'');
  assert.doesNotMatch(item.note||'',/아컨|acon\.io\.kr/i);assert.ok(item.note?.includes('2026-11-29'));assert.ok(item.note?.includes('입학처'));
});
