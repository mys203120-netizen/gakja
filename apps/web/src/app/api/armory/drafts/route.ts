import {z} from 'zod';
import {requireUser,checkOrigin} from '@/lib/auth';
import {query,transaction} from '@/lib/db';
import {requireStudent,FeatureError,featureError} from '@/lib/ai';
import {experienceSchema} from '@/lib/armory-model';
export const runtime='nodejs';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
const shape=(row:any)=>({id:row.id,draft:row.data,revision:row.card_revision,step:row.step,serverRevision:row.revision,updatedAt:new Date(row.updated_at).toISOString()});
export async function GET(){try{const user=await requireUser();requireStudent(user);return json({drafts:(await query('select id,data,card_revision,step,revision,updated_at from experience_card_drafts where student_id=$1 order by updated_at desc',[user.id])).map(shape)});}catch(e){const r=featureError(e);return json(r,r.status);}}
export async function PUT(request:Request){try{
 checkOrigin(request);const user=await requireUser();requireStudent(user);
 const input=z.object({id:z.string().uuid(),draft:experienceSchema,revision:z.number().int().min(0),step:z.number().int().min(0).max(3),serverRevision:z.number().int().min(0),updatedAt:z.string().optional()}).strict().parse(await request.json());
 const row=await transaction(async client=>{
  await client.query('select pg_advisory_xact_lock(hashtext($1))',['armory:'+user.id]);
  const {rows:cards}=await client.query('select revision from experience_cards where id=$1 and student_id=$2',[input.id,user.id]);
  if(input.revision>0&&!cards[0])throw new FeatureError(404,'내 경험 초안을 찾을 수 없어요.');
  if(cards[0]&&cards[0].revision!==input.revision)throw new FeatureError(409,'저장된 경험이 바뀌었어요. 현재 초안은 이 기기에 보관했어요. 목록에서 최신 경험을 확인해 주세요.');
  const values=[input.id,user.id,JSON.stringify({...input.draft,confirmed:false}),input.revision,input.step];
  const result=input.serverRevision===0
   ?await client.query('insert into experience_card_drafts(id,student_id,data,card_revision,step) values($1,$2,$3,$4,$5) on conflict(id) do nothing returning *',values)
   :await client.query('update experience_card_drafts set data=$3,card_revision=$4,step=$5,revision=revision+1,updated_at=now() where id=$1 and student_id=$2 and revision=$6 returning *',[...values,input.serverRevision]);
  return result.rows[0];
 });
 if(!row){
  // A lost HTTP response can be retried without producing a spurious conflict.
  const [previous]=await query('select * from experience_card_drafts where id=$1 and student_id=$2',[input.id,user.id]);
  if(previous&&previous.card_revision===input.revision&&previous.step===input.step&&JSON.stringify(experienceSchema.parse(previous.data))===JSON.stringify({...input.draft,confirmed:false}))return json({draft:shape(previous)});
  throw new FeatureError(409,'다른 화면에서 초안이 바뀌었어요. 이 기기의 글은 보관했어요. 서버 초안을 확인한 뒤 이어 써 주세요.');
 }
 return json({draft:shape(row)});
 }catch(e){const r=featureError(e);return json(r,r.status);}}
