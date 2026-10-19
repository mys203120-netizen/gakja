import { z } from 'zod';
import { requireUser, checkOrigin } from '@/lib/auth';
import { query, transaction } from '@/lib/db';
import { requireStudent, FeatureError, featureError } from '@/lib/ai';
import { experienceSaveSchema } from '@/lib/armory-model';
export const runtime='nodejs';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(){try{
 const user=await requireUser();requireStudent(user);
 const cards=await query('select id,data,revision,updated_at from experience_cards where student_id=$1 order by updated_at desc',[user.id]);
 const sessions=await query("select s.id,s.kind,s.state,s.data->'experienceCard' as card,s.created_at,coalesce((select jsonb_agg(jsonb_build_object('question',t.data->>'question','answer',t.data->>'answer','feedback',t.data->'feedback')) from interview_turns t where t.session_id=s.id and t.student_id=$1 and t.data->>'answer' is not null),'[]'::jsonb) as answers from interview_sessions s where s.student_id=$1 and s.data ? 'experienceCard' order by s.created_at desc limit 100",[user.id]);
 return json({cards,sessions});
 }catch(e){const r=featureError(e);return json(r,r.status);}}
export async function POST(request:Request){try{
 checkOrigin(request);const user=await requireUser();requireStudent(user);
 const input=z.object({id:z.string().uuid(),revision:z.number().int().min(0),draftRevision:z.number().int().positive().optional(),data:experienceSaveSchema}).parse(await request.json());
 const card=await transaction(async client=>{
  await client.query('select pg_advisory_xact_lock(hashtext($1))',['armory:'+user.id]);
  if(input.draftRevision){const pending=await client.query('select revision from experience_card_drafts where id=$1 and student_id=$2',[input.id,user.id]);if(pending.rows[0]?.revision!==input.draftRevision)throw new FeatureError(409,'초안이 다른 화면에서 바뀌었어요. 지금 쓴 글은 보관했어요. 최신 초안을 확인해 주세요.');}
  if(input.data.pinned){const pinned=await client.query("select count(*)::int as count from experience_cards where student_id=$1 and id<>$2 and data->>'pinned'='true'",[user.id,input.id]);if(pinned.rows[0].count>=3)throw new FeatureError(409,'면접용 경험은 3개까지 고정할 수 있어요. 다른 카드의 고정을 해제해 주세요.');}
  const result=input.revision===0
   ? await client.query('insert into experience_cards(id,student_id,data) values($1,$2,$3) on conflict(id) do nothing returning id,data,revision,updated_at',[input.id,user.id,JSON.stringify(input.data)])
   : await client.query('update experience_cards set data=$3,revision=revision+1,updated_at=now() where id=$1 and student_id=$2 and revision=$4 returning id,data,revision,updated_at',[input.id,user.id,JSON.stringify(input.data),input.revision]);
  if(result.rows[0]&&input.draftRevision)await client.query('delete from experience_card_drafts where id=$1 and student_id=$2 and revision=$3',[input.id,user.id,input.draftRevision]);
  return result.rows[0];
 });
 if(!card)throw new FeatureError(409,'다른 화면에서 변경되었어요. 목록을 새로 불러온 뒤 다시 수정해 주세요.');
 return json({card});
 }catch(e){const r=featureError(e);return json(r,r.status);}}
