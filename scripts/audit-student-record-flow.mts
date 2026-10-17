import {writeFileSync,readFileSync} from 'node:fs';
import {schoolDirectory} from '../apps/web/src/lib/school-directory';
import {schoolHasDocumentInterview,interviewSupportForTarget} from '../apps/web/src/lib/school-interview-scope';
import {departmentPracticeQuestions} from '../apps/web/src/lib/department-learning';
const original=JSON.parse(readFileSync('apps/web/src/data/school-directory.json','utf8'));
let questions=0,baseQuestions=0,programQuestions=0,programConnections=0;const questionIds=new Set<string>();
for(const school of schoolDirectory)for(const department of school.departments){
  const target={university:school.university,school_reference_id:school.id,department:department.name,department_catalog_id:department.id,campus:school.campusLabel||department.campus};
  for(const interest_department of ['',...(department.programs||[])]){
    const rows=departmentPracticeQuestions({...target,...(interest_department?{interest_department}:{})});
    questions+=rows.length;if(interest_department){programConnections++;programQuestions+=rows.length;}else baseQuestions+=rows.length;
    for(const row of rows){if(questionIds.has(row.id))throw new Error('duplicate learning question id: '+row.id);questionIds.add(row.id);}
  }
}
const report={checkedAt:'2026-10-17',sourceSchools:original.schools.length,sourceDepartments:original.schools.reduce((n:number,s:any)=>n+s.departments.length,0),selectableSchools:schoolDirectory.length,selectableDepartmentTuples:schoolDirectory.reduce((n,s)=>n+s.departments.length,0),broadProgramConnections:programConnections,baseDepartmentQuestionTemplates:baseQuestions,programQuestionTemplates:programQuestions,departmentLearningQuestionTemplates:questions,distinctQuestionIds:questionIds.size,all2027AdmissionUnitsVerified:false,
  excludedSchools:original.schools.filter((school:any)=>!schoolHasDocumentInterview(school.canonicalName)).map((school:any)=>({id:school.id,university:school.university,...interviewSupportForTarget({university:school.university,admission_year:2027})})),
  selectedSchools:schoolDirectory.map(school=>({id:school.id,university:school.university,departments:school.departments.length,programConnections:school.departments.reduce((n,d)=>n+(d.programs?.length||0),0)})),
  questionScope:'공시 분류·확인된 학과명과 검증 영상의 개념을 연결한 앱 연습 질문. 학과 공식 교육과정·기출 출제율 아님.',history:'원본 88교 스냅샷·기존 질문 revision·학생 기록을 삭제하지 않고 현재 선택 목록과 신규 연습 범위만 제한.'};
writeFileSync('docs/student-record-flow-audit-2026-10-17.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({sourceSchools:report.sourceSchools,selectableSchools:report.selectableSchools,selectableDepartments:report.selectableDepartmentTuples,questionTemplates:questions,distinctQuestionIds:questionIds.size}));
