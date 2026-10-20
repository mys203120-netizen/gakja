import { schoolDirectory,schoolDirectorySummary,schoolDepartmentSource } from '@/lib/school-directory';
export const runtime='nodejs';
export async function GET(request:Request) {
  const id=new URL(request.url).searchParams.get('schoolId');
  if(id){const school=schoolDirectory.find(item=>item.id===id);if(!school)return Response.json({error:'학생부형 면접을 지원하는 학교를 선택해 주세요.'},{status:404});const compact=new URL(request.url).searchParams.get('view')==='registration';return Response.json({school:compact?{...schoolDirectorySummary(school),departments:school.departments.map(({id,name,campus,college,programs,programSourceUrl,programSourceYear})=>({id,name,campus,college,...(programs?{programs,programSourceUrl,programSourceYear}:{})}))}:school,departmentSource:schoolDepartmentSource},{headers:{'Cache-Control':'public, max-age=3600'}});}
  return Response.json({schools:schoolDirectory.map(schoolDirectorySummary),departmentSource:schoolDepartmentSource},{headers:{'Cache-Control':'public, max-age=3600'}});
}
