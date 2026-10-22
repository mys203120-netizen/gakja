import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse,transaction} from '@/lib/db';
import {accountDataPage,accountDataMutationSchema,cancelAccountDataRequest,confirmAccountEmail,moveAccountDataToTrash,requestAccountDataDeletion,restoreAccountData} from '@/lib/account-data-store';
import {permanentlyDeleteAccountData} from '@/lib/account-data-files';
import {revokeOtherDeviceSessions} from '@/lib/account-device-sessions';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const json=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'private, no-store'}});
async function student(){const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정의 자료만 관리할 수 있어요.');return user;}
export async function GET(request:Request){try{return json(await accountDataPage(await student(),new URL(request.url).searchParams));}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
  checkOrigin(request);if(request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'허용되지 않은 요청이에요.');
  const user=await student(),text=await request.text();if(text.length>24000)throw new ApiError(413,'정리할 항목을 나누어 선택해 주세요.');
  let raw:unknown;try{raw=JSON.parse(text);}catch{throw new ApiError(400,'요청을 확인해 주세요.');}
  const input=accountDataMutationSchema.parse(raw);
  if(input.action==='revoke_sessions')return json({ok:true,count:await revokeOtherDeviceSessions(user.id)});
  if(input.action==='request_delete')return json({ok:true,request:await requestAccountDataDeletion(user,input.scope,input.confirmation)});
  if(input.action==='cancel_request')return json(await cancelAccountDataRequest(user,input.requestId));
  if(input.action==='delete'){confirmAccountEmail(user,input.confirmation);const result=await permanentlyDeleteAccountData(user,input.items);return Response.json(result,{status:'partial' in result?207:200,headers:{'Cache-Control':'private, no-store'}});}
  const items=await transaction(db=>input.action==='trash'?moveAccountDataToTrash(db,user,input.items):restoreAccountData(db,user,input.items));
  return json({ok:true,count:items.length,items});
}catch(error){if(error instanceof z.ZodError)return Response.json({error:'선택한 항목과 요청을 확인해 주세요.'},{status:400});return errorResponse(error);}}
