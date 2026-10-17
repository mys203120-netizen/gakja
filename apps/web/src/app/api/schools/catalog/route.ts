import { schoolDirectory,schoolDirectoryEntry,schoolDirectorySummary,schoolDepartmentSource } from '@/lib/school-directory';
export const runtime='nodejs';
export async function GET(request:Request) {
  const id=new URL(request.url).searchParams.get('schoolId');
  if(id){const school=schoolDirectoryEntry(id);if(!school)return Response.json({error:'학교를 찾을 수 없어요.'},{status:404});return Response.json({school,departmentSource:schoolDepartmentSource},{headers:{'Cache-Control':'public, max-age=3600'}});}
  return Response.json({schools:schoolDirectory.map(schoolDirectorySummary),departmentSource:schoolDepartmentSource},{headers:{'Cache-Control':'public, max-age=3600'}});
}
