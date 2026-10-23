import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {getExampleAnswer,saveExampleAnswer} from '@/lib/example-answer-service';
import {FeatureError} from '@/lib/ai';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const scope=z.object({reportId:z.string().uuid(),turnId:z.string().uuid()});
async function student(){const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');return user;}
export async function GET(request:Request){try{const user=await student(),params=new URL(request.url).searchParams,value=scope.safeParse({reportId:params.get('reportId'),turnId:params.get('turnId')});if(!value.success)throw new ApiError(400,'리포트와 질문을 확인해 주세요.');return Response.json(await getExampleAnswer(user.id,value.data.reportId,value.data.turnId),{headers});}catch(error){const response=errorResponse(error instanceof FeatureError?new ApiError(error.status,error.message):error);response.headers.set('Cache-Control','private, no-store');return response;}}
export async function POST(request:Request){try{checkOrigin(request);const user=await student(),text=await request.text();if(text.length>16_000)throw new ApiError(413,'선택한 문장 정보를 짧게 확인해 주세요.');let value:unknown;try{value=JSON.parse(text);}catch{throw new ApiError(400,'요청 내용을 확인해 주세요.');}return Response.json(await saveExampleAnswer(user.id,value),{headers});}catch(error){const response=errorResponse(error instanceof FeatureError?new ApiError(error.status,error.message):error);response.headers.set('Cache-Control','private, no-store');return response;}}
