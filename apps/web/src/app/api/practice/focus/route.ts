import {createHash} from 'node:crypto';
import {requireUser,checkOrigin} from '@/lib/auth';
import {ApiError,errorResponse,transaction} from '@/lib/db';
import {getPlanContext,ownedPlanTarget} from '@/lib/planner-context';
import {koreaToday,shiftPlanDay,planTargetHref} from '@/lib/planner-model';
import {focusTraining} from '@/lib/focus-training';
const headers={'Cache-Control':'private, no-store'};
async function course(targetId:string|null){
  const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정에서 이용해 주세요.');
  if(!targetId||targetId.length>200)throw new ApiError(400,'지원처를 선택해 주세요.');
  const context=await getPlanContext(user.id),school=context.schoolTargets.find(row=>row.id===targetId);
  if(!school)throw new ApiError(404,'현재 등록된 지원처를 선택해 주세요.');
  const targets=new Map<string,NonNullable<ReturnType<typeof ownedPlanTarget>>>();
  for(const source of context.sources.filter(source=>source.kind==='question'&&(source.sourceType==='common'?source.targetId===targetId:source.sourceVersion===context.contentVersion))){
    try{const target=ownedPlanTarget(context,{kind:'question',id:source.id,targetId,sourceType:source.sourceType,sourceVersion:source.sourceVersion});if(target)targets.set(source.id,target);}catch(error){if(!(error instanceof ApiError)||![404,409].includes(error.status))throw error;}
  }
  const focus=focusTraining(context.events,{...school.data,id:school.id},[...targets.values()]);
  const today=koreaToday(),items=focus.map(item=>({...item,quizHref:planTargetHref(item,'quiz'),interviewHref:planTargetHref(item,'interview')+'&followups=1',comparisonHref:'/records/comparisons/'+encodeURIComponent(item.id)+'?targetId='+encodeURIComponent(targetId)}));
  const token=createHash('sha256').update(JSON.stringify({user:user.id,targetId,items,today})).digest('hex');
  return {user,school,items,token,today};
}
export async function GET(request:Request){try{const result=await course(new URL(request.url).searchParams.get('targetId'));return Response.json({items:result.items,token:result.token},{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
  checkOrigin(request);const raw=await request.text();if(raw.length>1000)throw new ApiError(413,'요청 내용을 확인해 주세요.');
  let input;try{input=JSON.parse(raw);}catch{throw new ApiError(400,'요청 형식을 확인해 주세요.');}
  if(typeof input?.targetId!=='string'||typeof input?.token!=='string')throw new ApiError(400,'훈련을 먼저 확인해 주세요.');
  const {user,school,items,token,today}=await course(input.targetId);
  if(input.token!==token)throw new ApiError(409,'연습 기록이 바뀌었어요. 훈련을 새로 불러와 주세요.');
  if(!items.length)throw new ApiError(409,'집중 훈련을 만들 기록이 아직 없어요.');
  const count=await transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',['focus-training:'+user.id]);
    const [current]=(await db.query("select data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null for share",[school.id,user.id])).rows;
    if(!current||JSON.stringify(current.data)!==JSON.stringify(school.data))throw new ApiError(409,'지원처가 바뀌었어요. 다시 확인해 주세요.');
    const [existing]=(await db.query("select id from student_plans where student_id=$1 and target->'focusPractice'->>'token'=$2 limit 1",[user.id,token])).rows;
    if(existing)return 0;
    for(const item of items){
      const {score,reason,evidence,lastPracticedAt,quizHref,interviewHref,comparisonHref,...target}=item;
      for(const step of [{day:0,kind:'quiz',label:'다시 떠올리기'},{day:1,kind:'interview',label:'내 말로 설명하기'},{day:3,kind:'quiz',label:'도움 없이 다시 확인'}]){
        await db.query('insert into student_plans(student_id,title,planned_date,kind,target) values($1,$2,$3,$4,$5)',[user.id,`집중 훈련 · ${step.label} · ${target.title}`.slice(0,160),shiftPlanDay(today,step.day),step.kind,JSON.stringify({...target,focusPractice:{token,step:step.day,reason}})]);
      }
    }
    return items.length*3;
  });
  return Response.json({count},{headers});
}catch(error){return errorResponse(error);}}
