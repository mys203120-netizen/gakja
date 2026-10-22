import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {koreaToday,validPlanDay} from '@/lib/planner-model';
import {calendarRequestFromText} from '@/lib/calendar-edit';
import {calendarEditHistory,editCalendarPlans,undoCalendarEdit} from '@/lib/calendar-edit-store';

const date=z.string().refine(validPlanDay);
const change=z.object({ids:z.array(z.string().uuid()).min(1).max(200).optional(),fromDate:date.optional(),endDate:date.optional(),toDate:date,mode:z.enum(['move','merge','shift','spread'])}).strict();
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('preview'),request:change.optional(),text:z.string().trim().min(1).max(300).optional()}).strict(),
 z.object({action:z.literal('apply'),request:change,fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 z.object({action:z.literal('undoPreview'),operationId:z.string().uuid().optional()}).strict(),
 z.object({action:z.literal('undo'),operationId:z.string().uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
const headers={'Cache-Control':'private, no-store'};
async function student(){const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생의 계획표에서 이용해 주세요.');return user;}
export async function GET(){try{const user=await student();return Response.json(await calendarEditHistory(user.id),{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){
 try{
  checkOrigin(request);const user=await student(),text=await request.text();if(text.length>20000)throw new ApiError(413,'변경할 일정을 줄여 주세요.');
  let value;try{value=JSON.parse(text);}catch{throw new ApiError(400,'입력 내용을 확인해 주세요.');}
  const parsed=schema.safeParse(value);if(!parsed.success)throw new ApiError(400,'변경할 계획과 날짜를 확인해 주세요.');const input=parsed.data;
  if(input.action==='undoPreview'||input.action==='undo')return Response.json(await undoCalendarEdit(user.id,input.operationId,input.action==='undo'?input.fingerprint:undefined),{headers});
  let selection=input.request;
  if(input.action==='preview'&&input.text){try{selection=calendarRequestFromText(input.text,koreaToday());}catch(error){throw new ApiError(400,(error as Error).message);}}
  if(!selection)throw new ApiError(400,'변경할 계획이나 문장을 입력해 주세요.');
  const result=await editCalendarPlans(user.id,selection,input.action==='apply'?input.fingerprint:undefined);
  return Response.json({...result,request:selection},{headers});
 }catch(error){return errorResponse(error);}
}
