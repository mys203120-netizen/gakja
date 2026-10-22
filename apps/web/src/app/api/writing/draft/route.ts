import {checkOrigin,requireUser} from '@/lib/auth';
import {featureError,requireStudent} from '@/lib/ai';
import {ApiError} from '@/lib/db';
import {generateThoughtWriting} from '@/lib/thought-writing';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function POST(request:Request){
 const headers={'Cache-Control':'private, no-store'};
 try{
  checkOrigin(request);const user=await requireUser();requireStudent(user);
  const raw=await request.text();if(raw.length>40000)throw new ApiError(413,'적은 내용을 나누어 정리해 주세요.');
  let input:unknown;try{input=JSON.parse(raw);}catch{throw new ApiError(400,'적은 내용을 확인해 주세요.');}
  const result=await generateThoughtWriting(user.id,input,request.signal),current=await requireUser();requireStudent(current);
  if(current.id!==user.id)throw new ApiError(401,'현재 로그인 정보에서 다시 정리해 주세요.');
  return Response.json(result,{headers});
 }catch(error){const failure=featureError(error);return Response.json({error:failure.error,code:failure.code},{status:failure.status,headers});}
}
