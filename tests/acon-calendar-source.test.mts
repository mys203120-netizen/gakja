import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseAconDateCell,parseAconInterviewCalendar,matchAconUniversity,splitAdmissionDepartments,ACON_CALENDAR_MAX_BYTES} from '../apps/web/src/lib/acon-calendar-source.ts';
import {calendarForTargets,matchCalendarSchoolTarget,type AdmissionCalendarCatalogue} from '../apps/web/src/lib/admission-calendar-model.ts';

const catalogue=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url),'utf8')) as AdmissionCalendarCatalogue;
const uos=catalogue.schools.find(school=>school.university==='서울시립대학교')!;
const target={id:'read-only-harin-shape',school_reference_id:uos.schoolReferenceId,university:uos.university,admission_year:2027,campus:'본교',admission_type:'학생부종합전형Ⅰ(면접형)',major:'환경공학부'};

test('date range crosses month and includes only its dates',()=>{
  assert.deepEqual(parseAconDateCell('10월 31일(토) ~ 11월 1일(일)',2026).dates,['2026-10-31','2026-11-01']);
});
test('separated ranges do not turn the days in between into exams',()=>{
  const parsed=parseAconDateCell('10월 3일(토) ~ 10월 4일(일) 10월 10일(토) ~ 10월 11일(일)',2026);
  assert.deepEqual(parsed.dates,['2026-10-03','2026-10-04','2026-10-10','2026-10-11']);assert.equal(parsed.segments.length,2);
});
test('weekday mistakes, missing weekday, partial uncertainty, and malformed ranges never yield events',()=>{
  for(const raw of ['10월 26일(일)','10월 26일','10월 15일(목) 원문 확인 필요 — 일부 날짜를 확정하지 못함','2월 30일(월)','11월 1일(일) ~ 10월 31일(토)','10월 31일(토) 또는 11월 1일(일)','10월 3일(토) ~ 10월 4일(일) 또는 10월 10일(토) ~ 10월 11일(일)','10월 3일(토) ~ 10월 4일(일) ~ 10월 10일(토)','추후 공지'])assert.equal(parseAconDateCell(raw,2026).dates.length,0,raw);
});
test('a lone date and disjoint dates retain the real calendar year',()=>{
  assert.deepEqual(parseAconDateCell('11월 29일(일)',2026).dates,['2026-11-29']);
  assert.deepEqual(parseAconDateCell('10월 14일(수) 10월 21일(수)',2026).dates,['2026-10-14','2026-10-21']);
});
test('modern official names and science university names map exactly',()=>{
  for(const [source,expected] of [['공주대학교','국립공주대학교'],['한경대학교','한경국립대학교'],['디지스트(DGIST)','대구경북과학기술원 DGIST'],['카이스트(KAIST)','한국과학기술원 KAIST']])assert.equal(matchAconUniversity(source)?.university,expected);
});
test('separate admissions campuses and unregistered universities never map to main schools',()=>{
  for(const source of ['건국대학교(글로컬)','동국대학교(WISE)','한양대학교(ERICA)','고려대학교(세종)','연세대학교(미래)','대구대학교','한성대학교'])assert.equal(matchAconUniversity(source),null,source);
});
test('same-university internal campuses retain their qualifier',()=>{
  assert.equal(matchAconUniversity('단국대학교(천안)')?.sourceCampus,'천안');assert.equal(matchAconUniversity('홍익대학교(세종)')?.sourceCampus,'세종');
});
test('department list preserves a college with several parenthetical subunits',()=>{
  assert.deepEqual(splitAdmissionDepartments('환경공학부, AI인문대학(한국어문학과,중국어문학과), 화학과'),['환경공학부','AI인문대학(한국어문학과,중국어문학과)','화학과']);
});
test('all 88 registered schools have one coverage status, and only interviews are dated',()=>{
  assert.equal(catalogue.schools.length,88);assert.equal(new Set(catalogue.schools.map(school=>school.schoolReferenceId)).size,88);
  assert.equal(catalogue.source.admissionYear,2027);assert.equal(catalogue.source.calendarYear,2026);
  assert.equal(catalogue.audit.availableSchools,80);assert.equal(catalogue.audit.notListedSchools,6);assert.equal(catalogue.audit.noInterviewSchools,2);
  const entries=catalogue.schools.flatMap(school=>school.entries);assert.equal(entries.length,507);
  for(const entry of entries){assert.equal(entry.kind,'interview');assert.ok(entry.dates.length>0);assert.ok(entry.dates.every(date=>/^2026-\d{2}-\d{2}$/.test(date)));assert.ok(!/원문 확인/.test(entry.rawDate));}
});
test('uncertain interview raw dates and unpublished unclassified rows are separate from events',()=>{
  const unresolved=catalogue.schools.flatMap(school=>school.unresolved);
  assert.equal(unresolved.filter(row=>row.kind==='interview').length,2);assert.equal(unresolved.filter(row=>row.kind==='unclassified').length,5);
  assert.ok(unresolved.every(row=>!('startDate' in row)&&!('dates' in row)));
});
test('a source absence does not become a false no-interview assertion',()=>{
  assert.equal(catalogue.schools.find(school=>school.university==='감리교신학대학교')?.status,'not_listed');
  assert.equal(catalogue.schools.find(school=>school.university==='국립부경대학교')?.status,'no_interview');
});
test('Harin school/year/track/department selects 29 November with Roman numeral normalization',()=>{
  const projection=calendarForTargets(catalogue,[target]);assert.equal(projection.schools[0].entries.length,1);
  assert.deepEqual(projection.schools[0].entries[0].dates,['2026-11-29']);assert.equal(projection.schools[0].entries[0].scopeMatch,'target');
});
test('other admission years do not inherit this season and another school ID cannot fuzzy match',()=>{
  assert.equal(calendarForTargets(catalogue,[{...target,admission_year:2028}]).schools[0].entries.length,0);
  assert.equal(matchCalendarSchoolTarget(uos,{...target,school_reference_id:'wrong'}),false);
});
test('manually entered separate-campus labels cannot receive main-school dates',()=>{
  const dongguk=catalogue.schools.find(school=>school.university==='동국대학교')!;
  assert.equal(calendarForTargets(catalogue,[{id:'sample',school_reference_id:dongguk.schoolReferenceId,university:dongguk.university,campus:'WISE',admission_year:2027}]).schools[0].entries.length,0);
});
test('an unknown track stays a school schedule, not a personal interview allocation',()=>{
  const projected=calendarForTargets(catalogue,[{...target,admission_type:'미정'}]);assert.ok(projected.schools[0].entries.length>0);assert.ok(projected.schools[0].entries.every(entry=>entry.scopeMatch==='school'));
});
test('an exactly selected unresolved interview track never borrows another track date',()=>{
  const school=catalogue.schools.find(school=>school.unresolved.some(row=>row.kind==='interview'))!;
  const unresolved=school.unresolved.find(row=>row.kind==='interview')!;
  const result=calendarForTargets(catalogue,[{id:'uncertain',school_reference_id:school.schoolReferenceId,university:school.university,admission_year:2027,campus:'미정',major:'미정',admission_type:unresolved.trackLabel}]).schools[0];
  assert.equal(result.entries.length,0);assert.equal(result.trackDatesMissing,true);assert.ok(result.unresolved.length>0);
});
test('an unknown numeric campus never promotes a qualified school date into exact applicability',()=>{
  const modified=structuredClone(catalogue),school=modified.schools.find(school=>school.schoolReferenceId===uos.schoolReferenceId)!;
  school.entries=[{...uos.entries.find(entry=>entry.dates[0]==='2026-11-29')!,sourceCampus:'춘천'}];
  const entries=calendarForTargets(modified,[{...target,campus:'제3캠퍼스'}]).schools[0].entries;
  assert.equal(entries.length,1);assert.equal(entries[0].scopeMatch,'school');
});
test('an incomplete departmental list is preserved as a school candidate',()=>{
  const modified=structuredClone(catalogue),school=modified.schools.find(school=>school.schoolReferenceId===uos.schoolReferenceId)!;
  school.entries=[{...uos.entries.find(entry=>entry.dates[0]==='2026-11-29')!,departmentLabel:'화학과',departments:['화학과'],departmentCount:22}];
  assert.equal(calendarForTargets(modified,[{...target,admission_type:'미정'}]).schools[0].entries.length,1);
});
test('similar major substrings do not become exact personal applicability',()=>{
  const modified=structuredClone(catalogue),school=modified.schools.find(school=>school.schoolReferenceId===uos.schoolReferenceId)!;
  school.entries=[{...uos.entries.find(entry=>entry.dates[0]==='2026-11-29')!,departmentLabel:'건설환경공학과',departments:['건설환경공학과'],departmentCount:1}];
  const result=calendarForTargets(modified,[{...target,major:'환경공학과',admission_type:'미정'}]).schools[0].entries;
  assert.equal(result.length,1);assert.equal(result[0].scopeMatch,'school');assert.match(result[0].qualificationNote!,/명칭을 대조하지 못/);
});
test('empty, login, oversized, and changed source markup fail closed',()=>{
  for(const html of ['', '<html><title>로그인</title></html>', '<html><title>2027 수시 고사 일정</title><p>2026년</p></html>'])assert.throws(()=>parseAconInterviewCalendar(html));
  assert.throws(()=>parseAconInterviewCalendar('x'.repeat(ACON_CALENDAR_MAX_BYTES+1)));
});
test('synthetic captured markup parses exact dates without local source files',()=>{
  const blocks=Array.from({length:100},(_,index)=>`<details data-exam-univ="${catalogue.schools[index]?.university||'합성대학'+index}"><table><tr data-exam-entry="true" data-kind="면접"><td>면접</td><td>합성전형</td><td>11월 29일(일)</td><td>합성학과</td></tr><tr data-exam-entry="true" data-kind="면접"><td>면접</td><td>두번째합성전형</td><td>11월 29일(일)</td><td>합성학과</td></tr></table></details>`).join('');
  const html=`<html><title>2027 수시 고사 일정</title><p>2026년</p><section id="universities">${blocks}</section></html>`;
  const fresh=parseAconInterviewCalendar(html,{checkedAt:'2026-10-17T00:00:00Z'});
  const school=fresh.schools.find(row=>row.university==='서울시립대학교')!;
  assert.equal(school.entries.length,2);assert.deepEqual(school.entries[0].dates,['2026-11-29']);
  assert.ok(school.entries.some(row=>row.trackLabel==='합성전형'));
  assert.deepEqual(parseAconInterviewCalendar(html,{checkedAt:fresh.source.checkedAt}),fresh);
});
