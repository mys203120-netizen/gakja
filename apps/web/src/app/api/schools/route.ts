import { requireUser,checkOrigin } from '@/lib/auth';
import { featureError,requireStudent } from '@/lib/ai';
import { studentSchoolContext,studentSchoolRegistrations,commonInterviewQuestions,registerStudentSchool,registerStudentSchools,updateStudentSchool,archiveStudentSchool } from '@/lib/school-learning';
export const runtime='nodejs';
export const dynamic='force-dynamic';
function json(value:unknown,status=200) { return Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}}); }
export async function GET(request:Request) {
  try { const user=await requireUser();requireStudent(user);const params=new URL(request.url).searchParams,targetId=params.get('targetId');
    if(params.get('scope')==='registration')return json({targets:await studentSchoolRegistrations(user.id)});
    const [{catalog,targets},commonQuestions]=await Promise.all([studentSchoolContext(user.id,{compact:params.get('scope')==='learning'}),commonInterviewQuestions(user.id,targetId)]);
    return json({catalog,targets,commonQuestions,commonAvailable:commonQuestions.length>0});
  } catch(error) { const result=featureError(error);return json({error:result.error,code:result.code},result.status); }
}
export async function POST(request:Request) {
  try { checkOrigin(request);const user=await requireUser();requireStudent(user);const input=await request.json();
    if(input&&typeof input==='object'&&'registrations' in input){const targets=await registerStudentSchools(user.id,input);return json({targets,target:targets.at(-1)});}
    const target=await registerStudentSchool(user.id,input);return json({target}); }
  catch(error) { const result=featureError(error);return json({error:result.error,code:result.code},result.status); }
}
export async function PATCH(request:Request) {
  try { checkOrigin(request);const user=await requireUser();requireStudent(user);const target=await updateStudentSchool(user.id,await request.json());return json({target}); }
  catch(error) { const result=featureError(error);return json({error:result.error,code:result.code},result.status); }
}
export async function DELETE(request:Request) {
  try { checkOrigin(request);const user=await requireUser();requireStudent(user);return json(await archiveStudentSchool(user.id,await request.json())); }
  catch(error) { const result=featureError(error);return json({error:result.error,code:result.code},result.status); }
}
