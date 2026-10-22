import {requireUser} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {accountDataBackup} from '@/lib/account-data-backup';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request:Request){try{
  const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정의 자료만 백업할 수 있어요.');
  const format=new URL(request.url).searchParams.get('format')||'json';if(!['json','html'].includes(format))throw new ApiError(400,'백업 형식을 확인해 주세요.');
  return await accountDataBackup(user,format as 'json'|'html');
}catch(error){return errorResponse(error);}}
