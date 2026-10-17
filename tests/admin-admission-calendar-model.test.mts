import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildCalendarAdminRows,validateCalendarAdminData,applyCalendarAdminEdits,type CalendarAdminRow,type CalendarAdminEdit} from '../apps/web/src/lib/admin-admission-calendar-model.ts';
import {overlayOfficialCalendar,officialDecisionForTarget,type OfficialCalendarSupplement} from '../apps/web/src/lib/official-admission-calendar.ts';
import {calendarForTargets,type AdmissionCalendarCatalogue} from '../apps/web/src/lib/admission-calendar-model.ts';

const raw=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-calendar.json',import.meta.url),'utf8')) as AdmissionCalendarCatalogue;
const supplement=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-interview-official.json',import.meta.url),'utf8')) as OfficialCalendarSupplement;
const fixture=()=>({catalogue:overlayOfficialCalendar(structuredClone(raw),structuredClone(supplement)),official:structuredClone(supplement)});
const rows=()=>{const {catalogue,official}=fixture();return buildCalendarAdminRows(catalogue,official);};
const acon=()=>rows().find(row=>row.origin==='acon'&&row.status==='dated'&&row.departments.length===1)!;
test('date-only admin edits preserve the incompleteness of an imported department list',()=>{
  const {catalogue,official}=fixture();
  const sample=buildCalendarAdminRows(catalogue,official).find(row=>row.status==='dated'&&row.departments.length>0)!;
  catalogue.schools.flatMap(school=>school.entries).find(entry=>entry.id===sample.sourceEntryId)!.departmentCount=sample.departments.length+2;
  const row=buildCalendarAdminRows(catalogue,official).find(row=>row.id===sample.id)!;
  const result=applyCalendarAdminEdits(catalogue,official,[edit(row,{dates:['2026-12-10']})]);
  const entry=result.catalogue.schools.flatMap(school=>school.entries).find(entry=>entry.id===`admin:${row.id}`)!;
  assert.equal(entry.departmentCount,row.departmentCount);
  assert.deepEqual(entry.departments,row.departments);
});
function edit(row:CalendarAdminRow,changes:Partial<CalendarAdminRow>={},deleted=false):CalendarAdminEdit{
  return {id:row.id,data:{...row,...changes,revision:1,modified:true,deleted},revision:1,deleted,updatedAt:'2026-10-13T10:00:00.000Z'};
}
function target(row:CalendarAdminRow){return {id:'fixture',school_reference_id:row.schoolReferenceId,university:row.university,major:row.departments[0]||'환경공학과',admission_type:row.trackLabel,admission_year:2027,campus:row.campus};}

test('all current dated, official decision, and unresolved interview records are exposed with source attribution',()=>{
  const data=rows();
  assert.equal(data.filter(row=>row.status==='dated').length,537);
  assert.equal(data.filter(row=>row.origin==='official'&&row.status!=='dated').length,44);
  assert.equal(data.filter(row=>row.origin==='acon'&&row.status==='unverified').length,2);
  assert.equal(data.length,583);assert.equal(new Set(data.map(row=>row.id)).size,data.length);
  for(const row of data){assert.match(row.id,/^source_[a-f0-9]{32}$/);assert.equal(row.revision,0);assert.equal(row.modified,false);assert.equal(row.deleted,false);assert.ok(['아컨','입학처'].includes(row.sourceLabel));}
});

test('semantic duplicate qualifications retain both separated dates in one stable admin record',()=>{
  const row=rows().find(row=>row.university==='계명대학교'&&row.trackLabel==='일반전형'&&row.departments.includes('의예과'))!;
  assert.deepEqual(row.dates,['2026-11-21','2026-11-28']);assert.equal(row.sourceEntryIds!.length,2);
  assert.match(row.rawDate,/11월 21일/);assert.match(row.rawDate,/11월 28일/);
});

test('source record identities survive date, raw text, source URL, and ordering refreshes',()=>{
  const {catalogue,official}=fixture(),before=buildCalendarAdminRows(catalogue,official);
  catalogue.source.checkedAt='2026-10-14T10:00:00.000Z';
  for(const school of catalogue.schools){school.entries.reverse();school.unresolved.reverse();
    for(const entry of school.entries){entry.dates=['2026-12-15'];entry.startDate='2026-12-15';entry.endDate='2026-12-15';entry.rawDate='Refreshed source';entry.sourceUrl='https://refreshed.example.test/guide';entry.departments.reverse();}}
  catalogue.schools.reverse();official.schools.reverse();for(const school of official.schools)school.decisions.reverse();
  const after=buildCalendarAdminRows(catalogue,official);
  assert.deepEqual(after.map(row=>row.id).sort(),before.map(row=>row.id).sort());
});

test('a source tombstone removes its entire logical group after dates refresh',()=>{
  const {catalogue,official}=fixture();
  const row=buildCalendarAdminRows(catalogue,official).find(row=>row.university==='계명대학교'&&row.trackLabel==='일반전형'&&row.departments.includes('의예과'))!;
  for(const entry of catalogue.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!.entries.filter(entry=>row.sourceEntryIds!.includes(entry.id))){entry.dates=['2026-12-09'];entry.rawDate='Changed date';entry.id=`new-source-id-${entry.id}`;}
  const projected=applyCalendarAdminEdits(catalogue,official,[edit(row,{},true)]);
  assert.ok(!projected.catalogue.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!.entries.some(entry=>entry.trackLabel===row.trackLabel&&entry.departments.includes('의예과')));
});

test('a dated edit replaces imported source dates and preserves disjoint days',()=>{
  const {catalogue,official}=fixture(),row=acon(),changed=edit(row,{dates:['2026-12-03','2026-12-11'],note:'Verified fixture update'});
  const projected=applyCalendarAdminEdits(catalogue,official,[changed]);
  const school=projected.catalogue.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!;
  assert.ok(!school.entries.some(entry=>row.sourceEntryIds!.includes(entry.id)));
  const entry=school.entries.find(entry=>entry.id===`admin:${row.id}`)!;
  assert.equal(entry.sourceKind,'admin');assert.equal(entry.sourceLabel,'관리자');assert.equal(entry.checkedAt,changed.updatedAt);
  assert.deepEqual(entry.dates,['2026-12-03','2026-12-11']);
  assert.deepEqual(entry.segments,[{startDate:'2026-12-03',endDate:'2026-12-03'},{startDate:'2026-12-11',endDate:'2026-12-11'}]);
  assert.equal(entry.note,'Verified fixture update');
  assert.ok(calendarForTargets(projected.catalogue,[target(row)]).schools[0].entries.some(entry=>entry.id===`admin:${row.id}`));
});

test('editing a source record to a new school or qualification removes the original scope',()=>{
  const {catalogue,official}=fixture(),row=acon(),destination=raw.schools.find(school=>school.schoolReferenceId!==row.schoolReferenceId)!;
  const projected=applyCalendarAdminEdits(catalogue,official,[edit(row,{schoolReferenceId:destination.schoolReferenceId,university:destination.university,trackLabel:'Fixture new track',departments:['Fixture new major'],campus:'Fixture campus'})]);
  assert.ok(!projected.catalogue.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!.entries.some(entry=>row.sourceEntryIds!.includes(entry.id)));
  const moved=projected.catalogue.schools.find(school=>school.schoolReferenceId===destination.schoolReferenceId)!.entries.find(entry=>entry.id===`admin:${row.id}`)!;
  assert.equal(moved.trackLabel,'Fixture new track');assert.deepEqual(moved.departments,['Fixture new major']);assert.equal(moved.sourceCampus,'Fixture campus');
});

test('admin non-dated decisions replace dated records without generating a calendar date',()=>{
  for(const status of ['no_interview','date_pending','unpublished','unverified'] as const){
    const {catalogue,official}=fixture(),row=acon();
    const projected=applyCalendarAdminEdits(catalogue,official,[edit(row,{status,dates:[],note:`Fixture ${status}`})]);
    assert.ok(!projected.catalogue.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!.entries.some(entry=>entry.id===`admin:${row.id}`||row.sourceEntryIds!.includes(entry.id)));
    const decision=officialDecisionForTarget(projected.official.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId),target(row))!;
    assert.equal(decision.status,status);assert.equal(decision.reason,`Fixture ${status}`);assert.equal(decision.sourceLabel,'관리자');assert.equal(decision.sourceKind,'admin');
    assert.equal(officialDecisionForTarget(projected.official.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId),{...target(row),admission_type:'Different fixture track'})?.sourceKind==='admin',false);
  }
});

test('an existing official decision can be edited into a dated entry or deleted',()=>{
  const {catalogue,official}=fixture(),row=buildCalendarAdminRows(catalogue,official).find(row=>row.origin==='official'&&row.status==='no_interview'&&row.trackLabel!=='*'&&row.departments.length)!;
  const changed=applyCalendarAdminEdits(catalogue,official,[edit(row,{status:'dated',dates:['2026-11-05']})]);
  assert.ok(changed.catalogue.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!.entries.some(entry=>entry.id===`admin:${row.id}`));
  assert.ok(!changed.official.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!.decisions.some(decision=>decision.trackLabel===row.trackLabel&&JSON.stringify(decision.departments)===JSON.stringify(row.departments)));
  const deleted=applyCalendarAdminEdits(catalogue,official,[edit(row,{},true)]);
  assert.ok(!deleted.official.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!.decisions.some(decision=>decision.trackLabel===row.trackLabel&&JSON.stringify(decision.departments)===JSON.stringify(row.departments)));
});

test('resolving malformed imported interview dates removes the unresolved row',()=>{
  const {catalogue,official}=fixture(),row=buildCalendarAdminRows(catalogue,official).find(row=>row.origin==='acon'&&row.status==='unverified')!;
  const changed=applyCalendarAdminEdits(catalogue,official,[edit(row,{status:'dated',dates:['2026-11-20'],departments:['Fixture major']})]);
  const school=changed.catalogue.schools.find(school=>school.schoolReferenceId===row.schoolReferenceId)!;
  assert.ok(!school.unresolved.some(item=>row.sourceEntryIds!.includes(item.id)));assert.ok(school.entries.some(entry=>entry.id===`admin:${row.id}`));
  assert.equal(changed.catalogue.audit.unresolvedInterviewRows,catalogue.audit.unresolvedInterviewRows-1);
});

test('source aliases are retained for date changes and discarded when qualifications change',()=>{
  const {catalogue,official}=fixture(),school=catalogue.schools.find(school=>school.entries.length)!,source=school.entries[0];
  source.trackAliases=['Source alias'];source.departmentAliases=['Source major alias'];
  const row=buildCalendarAdminRows(catalogue,official).find(row=>row.sourceEntryId===source.id)!;
  const retained=applyCalendarAdminEdits(catalogue,official,[edit(row,{dates:['2026-11-05']})]).catalogue.schools.find(item=>item.schoolReferenceId===row.schoolReferenceId)!.entries.find(entry=>entry.id===`admin:${row.id}`)!;
  assert.deepEqual(retained.trackAliases,['Source alias']);assert.deepEqual(retained.departmentAliases,['Source major alias']);
  const changed=applyCalendarAdminEdits(catalogue,official,[edit(row,{trackLabel:'Different track',departments:['Different major']})]).catalogue.schools.find(item=>item.schoolReferenceId===row.schoolReferenceId)!.entries.find(entry=>entry.id===`admin:${row.id}`)!;
  assert.equal(changed.trackAliases,undefined);assert.equal(changed.departmentAliases,undefined);
});

test('applying edits never mutates imported evidence or another school and recalculates projection totals',()=>{
  const {catalogue,official}=fixture(),row=acon(),before=JSON.stringify({catalogue,official}),untouched=catalogue.schools.find(school=>school.schoolReferenceId!==row.schoolReferenceId)!;
  const projected=applyCalendarAdminEdits(catalogue,official,[edit(row,{},true)]);
  assert.equal(JSON.stringify({catalogue,official}),before);assert.deepEqual(projected.catalogue.schools.find(school=>school.schoolReferenceId===untouched.schoolReferenceId),untouched);
  assert.equal(projected.catalogue.audit.sourceUniversities,catalogue.audit.sourceUniversities);
  assert.equal(projected.catalogue.audit.importedInterviewRows,catalogue.audit.importedInterviewRows-row.sourceEntryIds!.length);
  assert.throws(()=>applyCalendarAdminEdits(catalogue,official,[edit(row),edit(row)]));
});

test('school names, attribution, aliases, and revision cannot be forged through editable input',()=>{
  const row=acon(),validated=validateCalendarAdminData({...row,university:'Wrong school',sourceLabel:'Forged official',origin:'official',trackAliases:['Forged alias'],revision:999});
  assert.equal(validated.university,row.university);assert.equal('sourceLabel'in validated,false);assert.equal('origin'in validated,false);assert.equal('trackAliases'in validated,false);assert.equal('revision'in validated,false);
  assert.equal(validateCalendarAdminData({...row,note:'  Fixture note  ',dates:['2026-12-11','2026-12-03']}).note,'Fixture note');
  assert.deepEqual(validateCalendarAdminData({...row,dates:['2026-12-11','2026-12-03']}).dates,['2026-12-03','2026-12-11']);
});

test('invalid schools, qualification lists, status, dates, URLs, and bounded fields are rejected',()=>{
  const row=acon();
  for(const invalid of [null,[],{...row,schoolReferenceId:'not-registered'},{...row,admissionYear:2028},{...row,trackLabel:''},
    {...row,trackLabel:'a'.repeat(501)},{...row,campus:'a'.repeat(201)},{...row,departments:['환경공학과','환경 공학과']},
    {...row,departments:['*']},{...row,departments:['a'.repeat(121)]},{...row,departments:Array.from({length:101},(_,i)=>String(i))},
    {...row,status:'unknown'},{...row,format:'live'},{...row,dates:[]},{...row,dates:['2026-02-30']},{...row,dates:['2027-01-01']},
    {...row,dates:['2026-11-05','2026-11-05']},{...row,status:'no_interview',dates:['2026-11-05']},
    {...row,sourceUrl:'javascript:alert(1)'},{...row,sourceUrl:'https://user:secret@example.test/guide'},
    {...row,note:'a'.repeat(4001)}, {...row,sourceUrl:'a'.repeat(2001)}, {...row,dates:Array(101).fill('2026-11-05')}]){
    assert.throws(()=>validateCalendarAdminData(invalid));
  }
  assert.equal(validateCalendarAdminData({...row,status:'date_pending',dates:[],sourceUrl:''}).sourceUrl,'');
  assert.deepEqual(validateCalendarAdminData({...row,departments:[]}).departments,[]);
});

function adminCampusFixture(){
  const {catalogue,official}=fixture();
  const row=buildCalendarAdminRows(catalogue,official).find(row=>row.university==='서울시립대학교'&&row.status==='dated'&&row.departments.length)!;
  assert.ok(row,'A real university qualification backs the campus regression');
  const changed=edit(row,{campus:'서울캠퍼스',dates:['2026-11-29']});
  const projected=applyCalendarAdminEdits(catalogue,official,[changed]).catalogue;
  // Isolate the managed qualification so other imported school-reference dates cannot mask a mismatch.
  projected.schools=projected.schools.map(school=>school.schoolReferenceId===row.schoolReferenceId?
    {...school,entries:school.entries.filter(entry=>entry.id===`admin:${row.id}`),unresolved:[]}:school);
  return {catalogue:projected,target:target(row)};
}

test('an administrator campus-qualified date matches both Seoul campus label forms exactly',()=>{
  const {catalogue,target:registered}=adminCampusFixture();
  for(const campus of ['서울캠퍼스','서울']){
    const result=calendarForTargets(catalogue,[{...registered,campus}]).schools[0];
    assert.equal(result.entries.length,1,`${campus} receives the managed date`);
    assert.equal(result.entries[0].scopeMatch,'target',`${campus} retains exact campus, track and department scope`);
    assert.deepEqual(result.entries[0].dates,['2026-11-29']);
  }
});

test('an administrator Seoul campus date is excluded from a different named campus',()=>{
  const {catalogue,target:registered}=adminCampusFixture();
  const result=calendarForTargets(catalogue,[{...registered,campus:'부산캠퍼스'}]).schools[0];
  assert.equal(result.entries.length,0);
});

test('a generic main-campus registration never promotes a named administrator campus date to an exact match',()=>{
  const {catalogue,target:registered}=adminCampusFixture();
  const result=calendarForTargets(catalogue,[{...registered,campus:'본교'}]).schools[0];
  assert.equal(result.entries.length,1,'Unknown generic campus remains eligible only as a school reference');
  assert.equal(result.entries[0].scopeMatch,'school');
});
