import {requireUser,checkOrigin} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {getAdminAdmissionCalendar,editAdminAdmissionCalendar} from '@/lib/admin-admission-calendar';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
export async function GET(){
  try{return Response.json(await getAdminAdmissionCalendar(await requireUser()),{headers});}
  catch(error){const response=errorResponse(error);response.headers.set('Cache-Control','private, no-store');return response;}
}
export async function POST(request:Request){
  try{
    checkOrigin(request);const user=await requireUser();
    if(user.role!=='admin')throw new ApiError(403,'관리자만 면접 일정을 관리할 수 있어요.');
    const body=await request.text();if(body.length>100_000)throw new ApiError(413,'일정 내용이 너무 커요.');
    let input;try{input=JSON.parse(body);}catch{throw new ApiError(400,'요청 형식을 확인해 주세요.');}
    return Response.json(await editAdminAdmissionCalendar(user,input),{headers});
  }catch(error){const response=errorResponse(error);response.headers.set('Cache-Control','private, no-store');return response;}
}
