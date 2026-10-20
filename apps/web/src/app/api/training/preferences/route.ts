import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse,query,transaction} from '@/lib/db';
import {availabilityWriteSchema,normalizeTrainingAvailability,type CurrentTrainingAvailability} from '@/lib/training-availability';

const headers={'Cache-Control':'private, no-store'};
const schema=z.object({expectedRevision:z.number().int().min(0),availability:availabilityWriteSchema}).strict();
const koreaDay=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);

export async function GET(){
  try{
    const user=await requireUser();
    if(user.role!=='student')throw new ApiError(403,'학생 계정에서 학습 시간을 설정해 주세요.');
    const [profile]=await query('select created_at from profiles where id=$1 and active=true',[user.id]);
    if(!profile)throw new ApiError(404,'가입 정보를 찾을 수 없어요.');
    const [preferences]=await query('select data from student_preferences where student_id=$1',[user.id]);
    const registeredAt=new Date(profile.created_at).toISOString();
    return Response.json({availability:normalizeTrainingAvailability(preferences?.data?.trainingAvailability),registeredAt,startDate:koreaDay(new Date(registeredAt))},{headers});
  }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
  try{
    checkOrigin(request);const user=await requireUser();
    if(user.role!=='student')throw new ApiError(403,'학생 계정에서 학습 시간을 설정해 주세요.');
    const raw=await request.text();if(raw.length>100_000)throw new ApiError(413,'일정 입력 내용을 줄여 주세요.');
    let value:unknown;try{value=JSON.parse(raw);}catch{throw new ApiError(400,'학습 시간과 날짜를 확인해 주세요.');}
    const parsed=schema.safeParse(value);
    if(!parsed.success)throw new ApiError(400,'학습 시간은 0~480분으로 입력하고 날짜를 확인해 주세요.');
    const availability=await transaction(async db=>{
      const [profile]=(await db.query('select created_at from profiles where id=$1 and active=true',[user.id])).rows;
      if(!profile)throw new ApiError(404,'가입 정보를 찾을 수 없어요.');
      // Create only this student's preference row, then lock it so two first saves also conflict safely.
      await db.query("insert into student_preferences(student_id,data) values($1,'{}'::jsonb) on conflict(student_id) do nothing",[user.id]);
      const [row]=(await db.query('select data from student_preferences where student_id=$1 for update',[user.id])).rows;
      const previous=normalizeTrainingAvailability(row?.data?.trainingAvailability);
      if((previous?.revision??0)!==parsed.data.expectedRevision)throw new ApiError(409,'다른 화면에서 학습 시간을 변경했어요. 최신 설정을 불러온 뒤 다시 저장해 주세요.');
      const saved:CurrentTrainingAvailability={...parsed.data.availability,blockedDates:[...parsed.data.availability.blockedDates].sort(),version:2,startDate:koreaDay(new Date(profile.created_at)),revision:(previous?.revision??0)+1,savedAt:new Date().toISOString()};
      // Update this key in-place; selected school, accessibility and other preferences survive.
      await db.query("update student_preferences set data=jsonb_set(jsonb_set(coalesce(data,'{}'::jsonb),'{trainingAvailability}',$2::jsonb,true),'{trainingAvailabilityRequired}','false'::jsonb,true),updated_at=now() where student_id=$1",[user.id,JSON.stringify(saved)]);
      return saved;
    });
    return Response.json({availability},{headers});
  }catch(error){return errorResponse(error);}
}
