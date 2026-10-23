import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {beginNonverbalTracking,cancelNonverbalTracking,getNonverbalTracking,saveNonverbalTracking} from '@/lib/nonverbal-tracking';
import {trackingSchema} from '@/lib/nonverbal-timeline';
export const runtime='nodejs';export const maxDuration=90;
const headers={'Cache-Control':'private, no-store'};
const source={mediaId:z.string().uuid(),lease:z.string().uuid()};
const inputSchema=z.discriminatedUnion('action',[z.object({...source,action:z.literal('begin')}).strict(),z.object({...source,action:z.literal('cancel')}).strict(),z.object({...source,action:z.literal('save'),tracking:trackingSchema}).strict()]);
async function student(){const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정으로 확인해 주세요.');return user;}
export async function GET(request:Request){try{const user=await student(),id=z.string().uuid().parse(new URL(request.url).searchParams.get('mediaId'));return Response.json(await getNonverbalTracking(user.id,id),{headers});}catch(error){return errorResponse(error instanceof z.ZodError?new ApiError(400,'질문 녹화를 선택해 주세요.'):error);}}
export async function POST(request:Request){try{
  checkOrigin(request);const user=await student(),limit=4_000_000;
  if(Number(request.headers.get('content-length')||0)>limit)throw new ApiError(413,'추적 결과가 너무 커요. 다시 시도해 주세요.');
  const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'영상 추적 요청이 필요해요.');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new ApiError(413,'추적 결과가 너무 커요.');}chunks.push(value);}}finally{reader.releaseLock();}
  let raw;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'영상 추적 형식을 확인해 주세요.');}
  const input=inputSchema.parse(raw);
  const result=input.action==='begin'?await beginNonverbalTracking(user.id,input.mediaId,input.lease):input.action==='cancel'?await cancelNonverbalTracking(user.id,input.mediaId,input.lease):await saveNonverbalTracking(user.id,input.mediaId,input.lease,input.tracking);
  return Response.json(result,{headers});
}catch(error){return errorResponse(error instanceof z.ZodError?new ApiError(400,'영상 추적 정보와 시간을 다시 확인해 주세요.'):error);}}
