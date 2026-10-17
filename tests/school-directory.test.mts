import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {schoolDirectory,schoolDirectoryEntry,schoolDirectorySummary,normalizeSchoolSelection,enrichSchoolTarget} from '../apps/web/src/lib/school-directory.ts';
import {officialProfileForTarget,uosEnvironment2027Profile} from '../apps/web/src/lib/official-school-profiles.ts';
import {schoolHasDocumentInterview,schoolDepartmentAvailable} from '../apps/web/src/lib/school-interview-scope';
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const uos=schoolDirectory.find(school=>school.canonicalName==='서울시립대학교')!;
const department=uos.departments.find(row=>row.name==='환경공학부')!;
const rawDirectory=JSON.parse(readFileSync('apps/web/src/data/school-directory.json','utf8'));

test('raw disclosure provenance is preserved while statistical aggregate labels are not selectable',()=>{
  const rawDepartments=rawDirectory.schools.flatMap((school:any)=>school.departments);
  const excluded=rawDepartments.filter((row:any)=>row.name==='기타모집단위');
  assert.equal(rawDepartments.length,3934);assert.equal(excluded.length,50);
  const eligible=rawDirectory.schools.filter((school:any)=>schoolHasDocumentInterview(school.canonicalName)).flatMap((school:any)=>school.departments.filter((department:any)=>department.name!=='기타모집단위'&&schoolDepartmentAvailable(school.canonicalName,department.name)));
  assert.equal(schoolDirectory.reduce((count,school)=>count+school.departments.length,0),eligible.length);
  for(const school of schoolDirectory)assert.ok(school.departments.every(row=>row.name!=='기타모집단위'));
  for(const raw of rawDirectory.schools)for(const row of raw.departments.filter((department:any)=>department.name==='기타모집단위')){
    assert.throws(()=>normalizeSchoolSelection({referenceId:raw.id,departmentId:row.id}),{name:'SchoolSelectionError'});
  }
});
test('the 88 source universities retain provenance and the supported release has actual coded departments',()=>{
  const bible=JSON.parse(readFileSync('apps/web/src/data/school-bible.json','utf8'));
  assert.equal(bible.schools.length,88);assert.equal(schoolDirectory.length,80);assert.deepEqual(schoolDirectory.map(s=>s.id).sort(),bible.schools.filter((s:any)=>schoolHasDocumentInterview(s.university)).map((s:any)=>s.id).sort());
  assert.equal(new Set(schoolDirectory.map(s=>s.id)).size,80);
  for(const school of schoolDirectory){assert.ok(school.departments.length);assert.match(school.publicSchoolCode,/^\d{7}$/);assert.ok(['http:','https:'].includes(new URL(school.admissionUrl!).protocol));assert.ok(school.logoUrl?.startsWith('/school-logos/'));const raw=JSON.parse(readFileSync('apps/web/src/data/school-directory.json','utf8')).schools.find((s:any)=>s.id===school.id);assert.equal(hash('apps/web/public'+school.logoUrl),raw.logoSha256);for(const row of school.departments){assert.equal(row.year,2026);assert.match(row.schoolCode,/^\d{7}$/);assert.match(row.departmentCode,/^\d{7}$/);assert.match(row.sourceUrl,/data\.go\.kr\/data\/15163924/);}}
});
test('school list summaries do not ship thousands of unnecessary department records',()=>{const summary=schoolDirectorySummary(uos);assert.equal((summary as any).departments,undefined);assert.equal(summary.departmentCount,uos.departments.length);assert.equal(summary.departmentYear,2026);});
test('chosen department wins over forged client major or campus',()=>{const value=normalizeSchoolSelection({referenceId:uos.id,departmentId:department.id,major:'존재하지 않는 가짜 학과',campus:'다른 캠퍼스'});assert.equal(value.major,'환경공학부');assert.equal(value.campus,'본교');assert.equal(value.department?.departmentCode,'0002122');});
test('department IDs belonging to another university are rejected',()=>{const other=schoolDirectory.find(s=>s.id!==uos.id&&s.departments.some(row=>!uos.departments.some(owned=>owned.id===row.id)))!;const foreign=other.departments.find(row=>!uos.departments.some(owned=>owned.id===row.id))!;assert.throws(()=>normalizeSchoolSelection({referenceId:uos.id,departmentId:foreign.id}),/선택한 대학/);assert.throws(()=>normalizeSchoolSelection({departmentId:department.id}),/대학을 먼저/);});
test('directly entered new admission units remain explicit student entries, without invented catalog codes',()=>{const value=normalizeSchoolSelection({referenceId:uos.id,major:'신설 모집단위',campus:'본교'});assert.equal(value.department,null);assert.equal(value.major,'신설 모집단위');assert.throws(()=>normalizeSchoolSelection({referenceId:uos.id,major:'미정'}),/지원 학과/);assert.throws(()=>normalizeSchoolSelection({referenceId:uos.id}),/지원 학과/);});
test('fixed-campus university references never mix departments from another campus',()=>{for(const name of ['가톨릭대학교 — 성심교정','경기대학교 — 수원캠퍼스','명지대학교 — 자연캠퍼스']){const school=schoolDirectory.find(s=>s.university===name)!;assert.ok(school.departments.every(row=>row.campus==='본교'));const value=normalizeSchoolSelection({referenceId:school.id,departmentId:school.departments[0].id});assert.equal(value.campus,school.campusLabel);}});
test('school identity enrich preserves a legacy target and marks its manual department as unverified',()=>{assert.equal(schoolDirectoryEntry('unknown'),null);const target={id:'legacy',university:'개인직접입력대학교',department:'특수학과'};const enriched=enrichSchoolTarget(target);const {departmentVerification,...original}=enriched;assert.deepEqual(original,target);assert.equal(departmentVerification.status,'manual_unverified');assert.equal(enrichSchoolTarget({school_reference_id:uos.id}).school_logo_url,uos.logoUrl);});
test('department verification requires an owned catalogue ID and exact current name',()=>{
  const target={school_reference_id:uos.id,department_catalog_id:department.id,department:department.name,admission_year:2027};
  const verified=enrichSchoolTarget(target).departmentVerification;
  assert.equal(verified.status,'public_2026');assert.equal(verified.sourceYear,2026);assert.equal(verified.sourceUrl,department.sourceUrl);
  assert.match(verified.note,/모집단위 확인 전/);
  assert.equal(enrichSchoolTarget({...target,department_catalog_id:null}).departmentVerification.status,'manual_unverified');
  assert.equal(enrichSchoolTarget({...target,school_reference_id:null}).departmentVerification.status,'manual_unverified');
  assert.equal(enrichSchoolTarget({...target,department:'위조 학과'}).departmentVerification.status,'manual_unverified');
  assert.equal(enrichSchoolTarget({...target,campus:'소속이 다른 캠퍼스'}).departmentVerification.status,'manual_unverified');
  assert.equal(enrichSchoolTarget({...target,department:'',major:department.name}).departmentVerification.status,'public_2026');
  assert.equal(enrichSchoolTarget({...target,department:'미정'}).departmentVerification.status,'not_selected');
  assert.equal(enrichSchoolTarget({school_reference_id:uos.id}).departmentVerification.status,'not_selected');
});
test('official 2027 interview guide only matches exact school year department campus and track',()=>{const target={...uosEnvironment2027Profile};assert.equal(officialProfileForTarget(target)?.status,'official_confirmed');for(const key of ['university','admission_year','campus','department','admission_type','interview_stage']){assert.equal(officialProfileForTarget({...target,[key]:key==='admission_year'?2028:'다른 정보'}),null);}assert.equal(officialProfileForTarget({...target,department:'환경공학과'}),null);});
test('official evaluation weights are preserved separately from unknown question-topic percentages',()=>{const profile=officialProfileForTarget(uosEnvironment2027Profile)!;assert.equal(profile.data.question_distribution,null);assert.deepEqual(profile.data.evaluation_weights.map(row=>row.weight),[35,40,25]);assert.equal(profile.data.interview_minutes?.min,12);assert.equal(profile.data.interviewer_count?.min,2);assert.equal(profile.data.applicant_count?.min,1);assert.equal(profile.data.admission_interview_weight,50);assert.equal(profile.data.interview_date,'2026-11-29');});
test('Unicode Roman numeral and whitespace variants preserve the same verified track',()=>{
  for(const admission_type of ['학생부종합전형I (면접형)','학생부종합전형Ⅰ(면접형)','학생부종합전형Ｉ (면접형)']){
    const profile=officialProfileForTarget({...uosEnvironment2027Profile,admission_type,university:' 서울시립대학교 ',department:'환경공학부 ',campus:'본교\u00a0'});
    assert.equal(profile?.status,'official_confirmed');assert.equal(profile?.data.admission_type,'학생부종합전형Ⅰ(면접형)');
  }
  for(const admission_type of ['학생부종합전형II (서류형)','학생부종합전형II (면접형)','학생부종합전형Ⅰ(서류형)']){
    assert.equal(officialProfileForTarget({...uosEnvironment2027Profile,admission_type}),null);
  }
});
test('all explicit stage values must agree while an unknown stage can display the official overview',()=>{
  assert.equal(officialProfileForTarget({...uosEnvironment2027Profile,interview_stage:undefined})?.status,'official_confirmed');
  assert.equal(officialProfileForTarget({...uosEnvironment2027Profile,interview_stage:'2 단계',stage:'2단계'})?.status,'official_confirmed');
  assert.equal(officialProfileForTarget({...uosEnvironment2027Profile,interview_stage:'3단계',stage:'2단계'}),null);
  assert.equal(officialProfileForTarget({...uosEnvironment2027Profile,interview_stage:'2단계',stage:'1단계'}),null);
});
test('2027 academic-year susi provides a 2026 public interview day and no invented personal time',()=>{
  const profile=officialProfileForTarget(uosEnvironment2027Profile)!;
  assert.equal(profile.data.admission_year,2027);assert.match(profile.data.interview_date,/^2026-\d{2}-\d{2}$/);
  assert.equal(profile.data.interview_date.includes('T'),false);assert.match(profile.provenance.review_note||'',/개인 입실 시각은 별도 공지/);
});
