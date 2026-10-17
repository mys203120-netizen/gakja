import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {schoolDirectory,normalizeSchoolSelection} from '../apps/web/src/lib/school-directory.ts';
import {schoolTalentCoverage,schoolTalentForTarget,schoolTalentQuestionRows,talentQuestionMatchesTarget} from '../apps/web/src/lib/school-talent-model.ts';
const questions=schoolTalentQuestionRows();
const rows=schoolDirectory.map(school=>{
  const failures:string[]=[];
  for(const department of school.departments){
    const selection=normalizeSchoolSelection({referenceId:school.id,departmentId:department.id});
    const target={school_reference_id:school.id,university:selection.university,department:selection.major,campus:selection.campus,admission_year:2027};
    const profile=schoolTalentForTarget(target);
    const eligible=questions.filter(question=>question.school_reference_id===school.id && talentQuestionMatchesTarget(question.data,target));
    if(profile.status!=='official_source' || !profile.points.length || !profile.points.every(point=>eligible.some(question=>question.id===point.practiceQuestionId)))failures.push(department.id);
  }
  const first=school.departments[0];
  const selection=normalizeSchoolSelection({referenceId:school.id,departmentId:first.id});
  const profile=schoolTalentForTarget({school_reference_id:school.id,university:selection.university,department:selection.major,campus:selection.campus,admission_year:2027});
  return {schoolReferenceId:school.id,university:school.university,departmentsTested:school.departments.length,failedDepartmentIds:failures,
    definitions:profile.profiles.filter(item=>item.scope==='university').map(item=>({profileId:item.id,revision:item.revision,title:item.title,definitionKind:item.definitionKind || 'talent',points:item.points.length,source:item.source})),
  };
});
const coverage=schoolTalentCoverage();
const result={checkedAt:coverage.checkedAt,admissionYear:2027,registeredSchools:coverage.registeredSchools,officialSourceSchools:coverage.officialSourceSchools,
  needsConfirmationSchools:coverage.needsConfirmationSchools,departmentsTested:rows.reduce((n,row)=>n+row.departmentsTested,0),
  failedDepartmentCount:rows.reduce((n,row)=>n+row.failedDepartmentIds.length,0),activeTalentQuestionCount:questions.length,rows};
writeFileSync(resolve('.local/school-talent-department-coverage-2026-10-13.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,rows:undefined}));
if(result.failedDepartmentCount || result.officialSourceSchools!==88)process.exitCode=1;
