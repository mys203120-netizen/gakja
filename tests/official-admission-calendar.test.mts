import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  OFFICIAL_SUPPLEMENT_SCHOOLS,officialDateSegments,officialDecisionForTarget,
  overlayOfficialCalendar,validateOfficialCalendarSupplement,
  type OfficialCalendarSupplement,type OfficialCalendarDecision,
} from '../apps/web/src/lib/official-admission-calendar.ts';
import {saveOfficialCalendarSupplement,OFFICIAL_ADMISSION_CALENDAR_SOURCE_KEY} from '../apps/web/src/lib/official-admission-calendar-storage.ts';
import type {AdmissionCalendarCatalogue} from '../apps/web/src/lib/admission-calendar-model.ts';

const base=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url),'utf8')) as AdmissionCalendarCatalogue;
const fixture=():OfficialCalendarSupplement=>({schemaVersion:1,admissionYear:2027,checkedAt:'2026-10-13T02:00:00.000Z',
  schools:OFFICIAL_SUPPLEMENT_SCHOOLS.map(university=>({
    schoolReferenceId:base.schools.find(school=>school.university===university)!.schoolReferenceId,university,
    sources:[{url:`https://admissions.example.test/${encodeURIComponent(university)}/guide`,title:'Fixture evidence, not an actual admissions announcement'}],
    entries:[],decisions:[{trackLabel:'*',departments:[],status:'unverified',reason:'Fixture source deliberately makes no factual schedule assertion.',sourceUrl:`https://admissions.example.test/${encodeURIComponent(university)}/guide`}],
    scopeNote:'Fictional testing fixture only.',
  })),
});
function decision(status:OfficialCalendarDecision['status'],trackLabel='*',departments:string[]=[]):OfficialCalendarDecision{
  return {trackLabel,departments,status,reason:'Explicit fixture evidence.',sourceUrl:fixture().schools[0].sources[0].url};
}
function target(){const school=fixture().schools[0];return {id:'fixture',school_reference_id:school.schoolReferenceId,university:school.university,admission_type:'종합Ⅰ',major:'환경공학부',admission_year:2027};}
function addDates(supplement:OfficialCalendarSupplement){
  const school=supplement.schools[0];school.entries.push({trackLabel:'종합Ⅰ',departments:['환경공학부'],
    startDate:'2026-11-01',endDate:'2026-11-08',dates:['2026-11-01','2026-11-02','2026-11-08'],
    rawDate:'Fixture dates only.',note:null,sourceUrl:school.sources[0].url});
  return supplement;
}

test('the supplemental cohort is exactly eight registered schools with matching IDs',()=>{
  assert.equal(validateOfficialCalendarSupplement(fixture()).schools.length,8);
  for(const alter of [
    (data:OfficialCalendarSupplement)=>data.schools.pop(),
    (data:OfficialCalendarSupplement)=>data.schools[0]=data.schools[1],
    (data:OfficialCalendarSupplement)=>data.schools[0].university='서울시립대학교',
    (data:OfficialCalendarSupplement)=>data.schools[0].schoolReferenceId='unregistered',
  ]){const data=fixture();alter(data);assert.throws(()=>validateOfficialCalendarSupplement(data));}
});

test('undated and no-interview decisions never become calendar events',()=>{
  const data=fixture();data.schools[0].decisions=[decision('no_interview')];
  data.schools[1].decisions=[{...decision('date_pending'),sourceUrl:data.schools[1].sources[0].url}];
  data.schools[2].decisions=[{...decision('unpublished'),sourceUrl:data.schools[2].sources[0].url}];
  const merged=overlayOfficialCalendar(base,data);
  for(const school of data.schools)assert.equal(merged.schools.find(row=>row.schoolReferenceId===school.schoolReferenceId)!.entries.length,0);
  assert.equal(merged.schools.find(row=>row.schoolReferenceId===data.schools[0].schoolReferenceId)!.status,'no_interview');
  assert.equal(merged.schools.find(row=>row.schoolReferenceId===data.schools[1].schoolReferenceId)!.status,'needs_review');
  assert.equal(officialDecisionForTarget(data.schools[0],target())!.status,'no_interview');
});

test('a scoped no-interview decision cannot apply to another track or department',()=>{
  const school=fixture().schools[0];school.decisions=[decision('no_interview','종합Ⅰ',['환경공학부'])];
  assert.equal(officialDecisionForTarget(school,target())!.status,'no_interview');
  for(const change of [{admission_type:'다른 전형'},{major:'건설환경공학부'},{admission_type:'미정'},{major:'미정'},{school_reference_id:'another-school'}])assert.equal(officialDecisionForTarget(school,{...target(),...change}),null);
});

test('exact track and department evidence precedes a general fallback',()=>{
  const school=fixture().schools[0];school.decisions=[decision('unverified'),decision('unpublished','종합Ⅰ'),decision('date_pending','종합Ⅰ',['환경공학부'])];
  assert.equal(officialDecisionForTarget(school,target())!.status,'date_pending');
  assert.equal(officialDecisionForTarget(school,{...target(),major:'화학과'})!.status,'unpublished');
  assert.equal(officialDecisionForTarget(school,{...target(),admission_type:'미정'})!.status,'unverified');
});

test('exact Roman numeral normalization is supported without fuzzy school or major matching',()=>{
  const school=fixture().schools[0];school.decisions=[decision('date_pending','종합I',['환경 공학부'])];
  assert.equal(officialDecisionForTarget(school,target())!.status,'date_pending');
  assert.equal(officialDecisionForTarget(school,{...target(),school_reference_id:undefined,university:'감리교신학대'}),null);
});

test('date segments retain separated days without inventing dates in between',()=>{
  assert.deepEqual(officialDateSegments(['2026-11-08','2026-11-01','2026-11-02']),[
    {startDate:'2026-11-01',endDate:'2026-11-02'},{startDate:'2026-11-08',endDate:'2026-11-08'},
  ]);
  assert.deepEqual(officialDateSegments([]),[]);
});

test('official overlay preserves Acon original records, parser source totals, and source attribution',()=>{
  const original=JSON.stringify(base),data=addDates(fixture()),merged=overlayOfficialCalendar(base,data);
  assert.equal(JSON.stringify(base),original);
  assert.equal(merged.audit.sourceUniversities,base.audit.sourceUniversities);
  assert.equal(merged.audit.matchedSourceUniversities,base.audit.matchedSourceUniversities);
  assert.equal(merged.audit.importedInterviewRows,base.audit.importedInterviewRows+1);
  assert.equal(merged.audit.importedDateOccurrences,base.audit.importedDateOccurrences+3);
  assert.equal(merged.audit.availableSchools,base.audit.availableSchools+1);
  const entry=merged.schools.find(row=>row.schoolReferenceId===data.schools[0].schoolReferenceId)!.entries[0];
  assert.equal(entry.sourceKind,'official_admissions');assert.equal(entry.sourceLabel,'입학처');assert.equal(entry.checkedAt,data.checkedAt);
  assert.equal(entry.sourceUrl,data.schools[0].sources[0].url);assert.equal(entry.segments.length,2);
  assert.equal(overlayOfficialCalendar(merged,data).audit.importedInterviewRows,merged.audit.importedInterviewRows);
});

test('wrong year, invented days, duplicates, unordered dates, and wrong min/max are rejected',()=>{
  for(const alter of [
    (data:any)=>data.admissionYear=2028,
    (data:any)=>data.checkedAt='not a timestamp',
    (data:any)=>data.schools[0].entries[0].dates=['2026-02-30'],
    (data:any)=>data.schools[0].entries[0].dates=['2027-11-01'],
    (data:any)=>data.schools[0].entries[0].dates=[],
    (data:any)=>data.schools[0].entries[0].dates=['2026-11-01','2026-11-01'],
    (data:any)=>data.schools[0].entries[0].dates=['2026-11-08','2026-11-01'],
    (data:any)=>data.schools[0].entries[0].startDate='2026-10-31',
    (data:any)=>data.schools[0].decisions[0].dates=['2026-11-01'],
  ]){const data=addDates(fixture());alter(data);assert.throws(()=>validateOfficialCalendarSupplement(data));}
});

test('every official date and decision must cite the selected school sources',()=>{
  for(const alter of [
    (data:any)=>data.schools[0].entries[0].sourceUrl=data.schools[1].sources[0].url,
    (data:any)=>data.schools[0].decisions[0].sourceUrl='https://elsewhere.example.test/guide',
    (data:any)=>data.schools[0].sources[0].url='javascript:alert(1)',
    (data:any)=>data.schools[0].sources[0].url='https://user:password@example.test/guide',
    (data:any)=>data.schools[0].sources=[],
  ]){const data=addDates(fixture());alter(data);assert.throws(()=>validateOfficialCalendarSupplement(data));}
});

test('persistence uses a separate source key and reuses unchanged evidence hashes',async()=>{
  const calls:Array<{sql:string;values:any[]}>=[];
  const db={query:async(sql:string,values:any[])=>{
    calls.push({sql,values});return {rows:sql.startsWith('select')?[{id:'existing-version'}]:[]};
  }};
  const data=fixture();
  const result=await saveOfficialCalendarSupplement(db as any,data);
  assert.equal(result.id,'existing-version');assert.equal(result.inserted,false);
  assert.ok(calls.every(call=>call.values[0]===OFFICIAL_ADMISSION_CALENDAR_SOURCE_KEY));
  const firstHash=calls[0].values[2];calls.length=0;
  await saveOfficialCalendarSupplement(db as any,{...data,checkedAt:'2026-10-14T02:00:00.000Z'});
  assert.equal(calls[0].values[2],firstHash);
  assert.equal(calls.at(-1)!.values[2],'2026-10-14T02:00:00.000Z');
  calls.length=0;const invalid=fixture();invalid.schools.pop();
  await assert.rejects(()=>saveOfficialCalendarSupplement(db as any,invalid));assert.equal(calls.length,0);
});
