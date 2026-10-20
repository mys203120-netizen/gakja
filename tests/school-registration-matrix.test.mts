import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {schoolDirectory} from '../apps/web/src/lib/school-directory';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar';
import {buildSchoolCalendarPreview,schoolCalendarRegistration} from '../apps/web/src/lib/school-onboarding-calendar-model';

test('all 3551 current departments preserve known interview registration without upgrading school references',()=>{
 const base=JSON.parse(readFileSync('apps/web/src/data/school-interview-calendar.json','utf8')),official=JSON.parse(readFileSync('apps/web/src/data/school-interview-official.json','utf8'));
 const snapshot={catalogue:overlayOfficialCalendar(base,official),official,officialSchools:8,stale:false,lastRefreshFailed:false,refreshDue:false};
 let total=0,available=0,schools=0;
 for(const school of schoolDirectory){let usable=0;for(const department of school.departments){
  total++;const target={school_reference_id:school.id,university:school.university,admission_year:2027,department:department.name,campus:school.campusLabel||department.campus,admission_type:'미정'};
  const choices=buildSchoolCalendarPreview(snapshot,target);if(!choices.trackOptions.length)continue;available++;usable++;
  for(const option of choices.trackOptions)assert.doesNotMatch(option.label,/서류형|면접\s*미실시/);
  const first=choices.trackOptions[0],selected=buildSchoolCalendarPreview(snapshot,{...target,admission_type:first.label});assert.equal(selected.canReview,true,school.university+' '+department.name);
  if(first.scope==='school_reference'){
   assert.equal(selected.status,'school_reference');assert.equal(selected.matched.length,0);
   const saved=schoolCalendarRegistration({...selected,fingerprint:'a'.repeat(64)},'2026-10-21T00:00:00Z');
   assert.equal(saved.department_scope_confirmed,false);assert.equal(saved.personal_appointment_confirmed,false);assert.deepEqual(saved.matched_entry_ids,[]);
  }
 }if(usable)schools++;}
 // These counts freeze availability for this bundled disclosure snapshot. A real
 // source update may change them only alongside review of that source's scope.
 assert.equal(total,3551);assert.equal(available,3387);assert.equal(schools,78);
});
