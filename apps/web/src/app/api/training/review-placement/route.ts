import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {validPlanDay} from '@/lib/planner-model';
import {trainingReviewPlacement} from '@/lib/training-review-placement-store';
const headers={'Cache-Control':'private, no-store'};
const selection=z.object({questionKey:z.string().min(1).max(5000),date:z.string().refine(validPlanDay)}).strict();
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('preview'),selection}).strict(),
 z.object({action:z.literal('apply'),selection,fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
async function student(){const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생의 훈련 계획에서 이용해 주세요.');return user;}
export async function GET(){try{const user=await student();return Response.json(await trainingReviewPlacement(user.id),{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){
 try{
  checkOrigin(request);const user=await student(),text=await request.text();if(text.length>10000)throw new ApiError(413,'입력 내용을 줄여 주세요.');
  let value;try{value=JSON.parse(text);}catch{throw new ApiError(400,'입력 내용을 확인해 주세요.');}
  const parsed=schema.safeParse(value);if(!parsed.success)throw new ApiError(400,'보완 질문과 날짜를 다시 선택해 주세요.');
  const input=parsed.data;return Response.json(await trainingReviewPlacement(user.id,input.selection,input.action==='apply'?input.fingerprint:undefined),{headers});
 }catch(error){return errorResponse(error);}
}
