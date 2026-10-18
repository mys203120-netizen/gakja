import directory from '../data/school-directory.json';
import {schoolHasDocumentInterview,schoolDepartmentAvailable,interviewSupportForTarget} from './school-interview-scope';
import details from '../data/school-department-details.json';

export type SchoolDepartment = { id:string;name:string;campus:string;college:string;schoolCode:string;departmentCode:string;field:string;category:string;year:number;sourceUrl:string;programs?:string[];programSourceUrl?:string;programSourceYear?:number };
export type SchoolDirectoryEntry = { id:string;university:string;canonicalName:string;publicSchoolCode:string;campusLabel:string|null;departments:SchoolDepartment[];admissionUrl:string|null;websiteUrl?:string|null;logoUrl:string|null;directoryUrl:string;checkedAt:string;linkStatus:string;logoSourceUrl?:string;officialSourceUrl?:string };
/** Keep the original disclosure snapshot intact; aggregate statistical labels are not selectable majors. */
const historicalDirectory = directory.schools.map(school=>({...school,departments:school.departments.filter(department=>department.name!=='기타모집단위').map(department=>{const supplement=details.units.find(unit=>unit.university===school.canonicalName&&unit.unit===department.name);return {...department,...(supplement?{programs:supplement.programs,programSourceUrl:supplement.sourceUrl,programSourceYear:supplement.sourceYear}:{})};})})) as SchoolDirectoryEntry[];
export const schoolDirectory = historicalDirectory.filter(school=>schoolHasDocumentInterview(school.canonicalName)).map(school=>({...school,departments:school.departments.filter(department=>schoolDepartmentAvailable(school.canonicalName,department.name))}));
export const schoolDepartmentSource = directory.departmentSource;
export type DepartmentVerification = {status:'public_2026'|'manual_unverified'|'not_selected';sourceYear:2026;sourceUrl:string;note:string};
export function schoolDirectoryEntry(referenceId?:string|null) { return historicalDirectory.find(school=>school.id===referenceId)||null; }
export function schoolDirectorySummary(school:SchoolDirectoryEntry) {
  const {departments,...summary}=school;
  return {...summary,departmentCount:departments.length,departmentYear:schoolDepartmentSource.year,departmentSourceUrl:schoolDepartmentSource.url};
}
export function schoolDirectoryForTarget(target:Record<string,any>) {
  return schoolDirectoryEntry(target.school_reference_id) || schoolDirectory.find(school=>school.university===target.university||school.canonicalName===target.university)||null;
}
export function enrichSchoolTarget<T extends Record<string,any>>(target:T):T & Record<string,any> & {departmentVerification:DepartmentVerification;school_logo_url?:string|null;school_admission_url?:string|null;school_directory_url?:string;school_website_url?:string|null} {
  const school=schoolDirectoryForTarget(target);
  const major=String(target.department||target.major||'').trim();
  const department=school&&target.school_reference_id&&school.id===target.school_reference_id
    ?school.departments.find(row=>row.id===target.department_catalog_id&&row.name===major&&(!target.campus||target.campus==='미정'||row.campus===target.campus||school.campusLabel===target.campus)):null;
  const status:DepartmentVerification['status']=!major||major==='미정'?'not_selected':department?'public_2026':'manual_unverified';
  const departmentVerification:DepartmentVerification={status,sourceYear:2026,sourceUrl:schoolDepartmentSource.url,note:status==='public_2026'
    ?'교육부 2026 공시 확인 · 지원 학년도 모집단위 확인 전'
    :status==='manual_unverified'?'직접 입력 · 학교·학과 조합 확인 전':'학과·모집단위 선택 전'};
  return {...target,...(school?{school_logo_url:school.logoUrl,school_admission_url:school.admissionUrl,school_directory_url:school.directoryUrl,school_website_url:school.websiteUrl}:{}),departmentVerification};
}
export class SchoolSelectionError extends Error { constructor(message:string) {super(message);this.name='SchoolSelectionError';} }
/** A submitted department ID is resolved inside its selected university only. */
export function normalizeSchoolSelection(input:{referenceId?:string|null;departmentId?:string|null;university?:string;major?:string;campus?:string;interestDepartment?:string}) {
  const school=schoolDirectoryEntry(input.referenceId),major=(input.major||'').trim();
  if(!schoolHasDocumentInterview(school?.canonicalName||input.university||''))throw new SchoolSelectionError(interviewSupportForTarget({university:school?.canonicalName||input.university}).reason);
  if(input.departmentId&&!school)throw new SchoolSelectionError('대학을 먼저 선택해 주세요.');
  const department=input.departmentId?school!.departments.find(row=>row.id===input.departmentId):null;
  if(input.departmentId&&!department)throw new SchoolSelectionError('선택한 대학의 학과를 다시 선택해 주세요.');
  if(input.interestDepartment&&!department?.programs?.includes(input.interestDepartment))throw new SchoolSelectionError('선택한 모집단위에 속한 관심 전공을 다시 선택해 주세요.');
  if(!schoolDepartmentAvailable(school?.canonicalName||input.university||'',department?.name||major))throw new SchoolSelectionError('제시문·교과 구술 면접을 제외한 학생부형 학과를 선택해 주세요.');
  if(!department&&(!major||major==='미정'))throw new SchoolSelectionError('지원 학과·학부를 선택하거나 입력해 주세요.');
  return {
    university:school?.university||input.university?.trim(),
    major:department?.name||major,
    campus:department?(school?.campusLabel||department.campus):(input.campus?.trim()||school?.campusLabel||'미정'),
    department,
    school,
  };
}
