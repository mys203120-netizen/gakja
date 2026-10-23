import {requireUser} from '@/lib/auth';
import {ApiError,errorResponse,query} from '@/lib/db';
import {koreaToday,shiftPlanDay} from '@/lib/planner-model';

export const dynamic='force-dynamic';

/** Aggregate every completed session rather than counting the shell's active-only list. */
export async function GET() {
  try {
    const user=await requireUser();
    if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
    const today=koreaToday(),start=shiftPlanDay(today,-6),end=shiftPlanDay(today,1);
    const counts=await query<{day:string;count:number}>(`select to_char(coalesce(completed_at,updated_at) at time zone 'Asia/Seoul','YYYY-MM-DD') as day,count(*)::int as count
      from interview_sessions where student_id=$1 and state='completed'
      and coalesce(completed_at,updated_at)>=$2::date at time zone 'Asia/Seoul'
      and coalesce(completed_at,updated_at)<$3::date at time zone 'Asia/Seoul'
      group by 1 order by 1`,[user.id,start,end]);
    const days=Array.from({length:7},(_,index)=>{const day=shiftPlanDay(start,index);return {day,count:counts.find(row=>row.day===day)?.count||0};});
    return Response.json({days,total:days.reduce((sum,row)=>sum+row.count,0)},{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return errorResponse(error);}
}
