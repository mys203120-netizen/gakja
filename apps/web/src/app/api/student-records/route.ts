import {requireUser} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {getStudentRecords} from '@/lib/student-records';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정으로 이용해 주세요.');return Response.json(await getStudentRecords(user.id,new URL(request.url).searchParams),{headers:{'Cache-Control':'private, no-store'}});}catch(error){return errorResponse(error);}}
