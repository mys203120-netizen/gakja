import 'server-only';
import {ApiError,query} from './db';
import {parseRecordCursor,recordPage,RECORD_CURSOR_TIMESTAMP} from './record-cursor';
import {getStudentAssignment} from './student-assignment-records';

const interviewOverview=`id,student_id,kind,mode,target_id,content_version,state,created_at,updated_at,completed_at,
 jsonb_build_object('context',jsonb_build_object('target',data->'context'->'target','targetId',data->'context'->'targetId'),
 'trainingPurpose',data->'trainingPurpose','trainingPlanId',data->'trainingPlanId','targetName',data->'targetName',
 'experienceCard',case when data->'experienceCard'->>'id' is not null then jsonb_build_object('id',data->'experienceCard'->'id') else null end) as data`;
const definitions={
 answers:{table:'user_answers',columns:"id,question_id,revision,created_at,updated_at,(nullif(trim(script),'') is not null or nullif(trim(structure),'') is not null) as written"},
 interviews:{table:'interview_sessions',columns:interviewOverview},
 reports:{table:'interview_reports',columns:"id,session_id,created_at,jsonb_build_object('kind',data->'kind','trainingPurpose',data->'trainingPurpose') as data"},
 memory:{table:'memory_attempts',columns:'id,memory_item_id,rating,due_at,created_at'},
 threads:{table:'chat_threads',columns:'id,target_id,content_version,title,created_at,updated_at,archived_at,deleted_at'},
 notifications:{table:'notifications',columns:'id,title,body,href,read_at,created_at'},
 briefings:{table:'briefings',columns:'id,title,category,created_at'},
 confirmations:{table:'student_confirmations',columns:'id,entity_id,question,response,state,data,created_at,updated_at'},
 assignments:{table:'quiz_assignments',columns:"id,title,state,due_at,report_id,target_id,source_kind,content_version,created_at,updated_at,case when jsonb_typeof(items)='array' then jsonb_array_length(items) else 0 end as item_count"},
} as const;
export type StudentRecordKind=keyof typeof definitions;
export function studentRecordKind(value:unknown):StudentRecordKind {if(typeof value!=='string'||!Object.hasOwn(definitions,value))throw new ApiError(400,'기록 종류를 확인해 주세요.');return value as StudentRecordKind;}
export async function getStudentRecords(studentId:string,params:URLSearchParams){
 const kind=studentRecordKind(params.get('kind')),definition=definitions[kind],id=params.get('id'),questionId=params.get('questionId');
 const targetId=params.get('targetId')||'',sourceVersion=params.get('sourceVersion')||'',sourceType=params.get('sourceType')||'',archived=params.get('archived')==='1';
 if(targetId.length>160||sourceVersion&&(!/^\d{1,6}$/.test(sourceVersion)||Number(sourceVersion)<1)||sourceType&&!['personal','common'].includes(sourceType))throw new ApiError(400,'기록 범위를 확인해 주세요.');
 const values:unknown[]=[studentId],where=kind==='briefings'?["status='published' and (data->>'owner_student_id' is null or data->>'owner_student_id'=$1)"]:['student_id=$1'];
 if(targetId){const [owned]=await query('select id from support_targets where student_id=$1 and id=$2',[studentId,targetId]);if(!owned)throw new ApiError(404,'지원 학교를 찾을 수 없어요.');if(!['interviews','threads','reports'].includes(kind))throw new ApiError(400,'이 기록은 지원 학교로 나눌 수 없어요.');values.push(targetId);where.push(kind==='reports'?`session_id in(select id from interview_sessions where student_id=$1 and target_id=$${values.length})`:`target_id=$${values.length}`);}
 if(sourceVersion||sourceType){
  if(!['interviews','threads','reports'].includes(kind))throw new ApiError(400,'이 기록은 자료 버전으로 나눌 수 없어요.');
  let condition='';
  if(sourceType==='common'){
   const array=kind==='threads'?"context->'questions'":"data->'questionQueue'";
   const selected=kind==='threads'?" and (coalesce(context->>'questionId','')='' or saved->>'id'=context->>'questionId')":'';
   if(sourceVersion)values.push(Number(sourceVersion));
   condition=`exists(select 1 from jsonb_array_elements(case when jsonb_typeof(${array})='array' then ${array} else '[]'::jsonb end) saved where nullif(saved->>'common_revision','') is not null${sourceVersion?` and saved->>'common_revision'=$${values.length}::text`:''}${selected})`;
  }else{
   const clauses:string[]=[];
   if(sourceVersion){values.push(Number(sourceVersion));clauses.push(`content_version=$${values.length}`);}
   if(sourceType==='personal')clauses.push(kind==='threads'?"coalesce(context->>'sourceKind','personal')<>'common'":"coalesce(data->'context'->>'sourceKind','personal')<>'common'");
   condition=clauses.join(' and ');
  }
  where.push(kind==='reports'?`session_id in(select id from interview_sessions where student_id=$1 and ${condition})`:condition);
 }
 if(kind==='threads')where.push(`deleted_at is null and archived_at is ${archived?'not ':''}null`);
 const assignmentState=kind==='assignments'?params.get('state')||'all':'';
 if(assignmentState&&!['all','active','completed'].includes(assignmentState))throw new ApiError(400,'과제 상태를 확인해 주세요.');
 if(assignmentState==='active')where.push("state<>'completed'");else if(assignmentState==='completed')where.push("state='completed'");
 if(kind==='answers'&&params.get('view')==='state'){
  // One compact state per question in the current published package, independent
  // of how many revisions or previous packages the student has accumulated.
  const items=await query(`select ${definition.columns} from user_answers where student_id=$1 and question_id in(
    select question->>'id' from content_packages p join content_versions v on v.package_id=p.id and v.version=p.active_version and v.status='published'
    cross join lateral jsonb_array_elements(coalesce(v.data->'questions','[]'::jsonb)) as question where p.student_id=$1)`,[studentId]);
  return {items,page:{nextCursor:null,hasMore:false,limit:items.length}};
 }
 if(id||questionId){
  if(id){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new ApiError(400,'기록을 확인해 주세요.');values.push(id);where.push(`id=$${values.length}`);}
  else {if(kind!=='answers'||questionId!.length>200)throw new ApiError(400,'질문을 확인해 주세요.');values.push(questionId);where.push(`question_id=$${values.length}`);}
  if(kind==='assignments')return {item:await getStudentAssignment(studentId,id!)};
  const [item]=await query(`select * from ${definition.table} where ${where.join(' and ')} limit 1`,values);
  if(id&&!item)throw new ApiError(404,'기록을 찾을 수 없어요.');
  if(kind==='reports'&&item){const [session]=await query(`select ${interviewOverview} from interview_sessions where student_id=$1 and id=$2`,[studentId,item.session_id]);return {item:item||null,session:session||null};}
  return {item:item||null};
 }
 const limit=Number(params.get('limit')||30);if(!Number.isInteger(limit)||limit<1||limit>50)throw new ApiError(400,'한 번에 1~50개 기록을 불러올 수 있어요.');
 const scope=JSON.stringify([studentId,kind,targetId,sourceVersion,sourceType,archived,assignmentState]);let cursor;try{cursor=parseRecordCursor(params.get('cursor'),scope);}catch(error){throw new ApiError(400,(error as Error).message);}
 if(cursor){values.push(cursor.anchor.at,cursor.anchor.id,cursor.after.at,cursor.after.id);const start=values.length-3;where.push(`(created_at,id)<=($${start}::timestamptz,$${start+1}::uuid) and (created_at,id)<($${start+2}::timestamptz,$${start+3}::uuid)`);}
 values.push(limit+1);const rows=await query(`select ${definition.columns},${RECORD_CURSOR_TIMESTAMP} as __cursor_at from ${definition.table} where ${where.join(' and ')} order by created_at desc,id desc limit $${values.length}`,values);
 return recordPage(rows,limit,scope,cursor);
}
