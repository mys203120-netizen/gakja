import 'server-only';
import {answerComparison,type LearningData} from '@gakja/content-contracts';
import type {Profile} from './auth';
import {ApiError,query} from './db';
import {answerAssistance,quizAnswerContext} from './learning-record-rules';
import {observedAnswerText} from './transcript-provenance';
import {parseRecordCursor,recordPage,RECORD_CURSOR_TIMESTAMP} from './record-cursor';

type Rows=Record<string,any>[];
export function projectLearningHistory({versions,interviews,quizAnswers,attempts,assignments,archivedContent,preferenceRows}:{versions:Rows;interviews:Rows;quizAnswers:Rows;attempts:Rows;assignments:Rows;archivedContent:Rows;preferenceRows:Rows}){
  const sourceAt=(version:number|undefined)=>archivedContent.find(row=>row.version===version)?.data as LearningData|undefined;
  const editedVersions = versions.map(v => {
    const source = sourceAt(v.data?.contentVersion);
    const question = v.data?.question || source?.questions.find(q=>q.id===v.question_id);
    const design = v.data?.answerDesign || source?.answer_designs?.find(d=>d.question_id===v.question_id);
    return {...v,revision_kind:'answer_edit',response_mode:'text',activity_ids:Array.isArray(question?.activity_ids)?question.activity_ids:[],assistance_recorded:v.data?.assistance_recorded===true||v.data?.assisted===true||v.data?.ai_assisted===true,question:question?.prompt,content_version:v.data?.contentVersion ?? null,assisted:v.data?.assisted===true||v.data?.ai_assisted===true,ai_assisted:v.data?.ai_assisted===true,chat_thread_id:v.data?.chatThreadId||null,chat_message_id:v.data?.chatMessageId||null,ai_assistance:v.data?.aiAssistance||null,source_status:question?'saved':'unavailable',comparison:answerComparison(v.script,question,design)};
  });
  const interviewVersions = interviews.filter(t => t.__selected_versions?.length || typeof t.data?.answer === 'string' && t.data.answer.trim()).flatMap(t => {
    const corrections = Array.isArray(t.data.transcriptRevisions) ? t.data.transcriptRevisions : [];
    const savedRevisions = Array.isArray(t.data.answerRevisions) ? t.data.answerRevisions : [];
    const original = typeof t.data.originalAnswer === 'string' ? t.data.originalAnswer : corrections.length ? null : t.data.answer;
    const values = t.__selected_versions || (savedRevisions.length ? savedRevisions.filter((r:any) => typeof r.text === 'string' && r.text.trim()).map((r:any,i:number) => ({id:`${t.id}:revision:${r.revision ?? i+1}`,revision:r.revision ?? i+1,script:r.text,revision_kind:r.kind==='transcript_correction'?'transcript_correction':'interview_answer',created_at:r.at ?? t.created_at})) : [
      ...(original ? [{id:`${t.id}:answer`,revision:1,script:original,revision_kind:'interview_answer',created_at:t.data.answeredAt ?? t.created_at}] : []),
      ...corrections.filter((r:any) => typeof r.transcript === 'string' && r.transcript.trim()).map((r:any,i:number) => ({id:`${t.id}:transcript:${r.revision ?? i+1}`,revision:i+2,script:r.transcript,revision_kind:'transcript_correction',created_at:r.at ?? t.created_at})),
      ...(!original && !corrections.length ? [{id:`${t.id}:answer-current`,revision:1,script:t.data.answer,revision_kind:'interview_answer',created_at:t.data.answeredAt ?? t.created_at}] : []),
    ]);
    const source = sourceAt(t.content_version);
    const sourceQuestion = t.context_questions?.find((q:any)=>q.id===t.question_id)||source?.questions.find(q=>q.id===t.question_id);
    const rootQuestionId=t.data.rootQuestionId||t.question_id;
    const activityQuestion=t.context_questions?.find((q:any)=>q.id===rootQuestionId)||source?.questions.find(q=>q.id===rootQuestionId)||sourceQuestion;
    const activityIds=Array.isArray(activityQuestion?.activity_ids)?activityQuestion.activity_ids:[];
    return values.map((v:any) => {
      const rawScript=v.revision_kind!=='transcript_correction'&&t.data.speechSource?.cleanupStatus==='completed'?t.data.speechSource.rawText:null;
      return {...v,...(rawScript?{raw_script:rawScript,transcript_formatting:t.data.speechSource}:{}),question_id:t.question_id,question:t.data.question,activity_ids:activityIds,practice_kind:sourceQuestion?.question_types?.includes('concept')?'concept':'personal',session_id:t.session_id,experience_card:t.experience_card?{id:t.experience_card.id,revision:t.experience_card.revision}:null,target_id:t.target_id,target_snapshot:t.target_snapshot||null,turn_id:t.id,assisted:!!t.data.assisted,assistance_recorded:t.data.assistance_recorded===true||t.data.assisted===true,response_mode:t.data.submissionSource==='text'?'text':t.data.submissionSource==='recording'?'audio':t.kind==='chat'?'text':rawScript?'audio':'unknown',structure:'',content_version:t.content_version,source_kind:t.source_kind||'personal',source_type:t.data.sourceType||'personal',common_revision:t.data.commonRevision||null,source_snapshot:t.data.sourceSnapshot||null,practice_label:t.data.practiceLabel||null,source_status:'saved',comparison:answerComparison(observedAnswerText({script:v.script,raw_script:rawScript}),sourceQuestion,source?.answer_designs?.find(d=>d.question_id===t.question_id))};
    });
  });
  const quizVersions = quizAnswers.filter(row=>row.mode!=='choice'&&(row.response.trim()||row.data?.recording_id)).map(row=>{
    const source=sourceAt(row.content_version),identity=quizAnswerContext(row.item||{},row.data,source),assistance=answerAssistance(row);
    const sourceQuestion=source?.questions.find(q=>q.id===identity.question_id);
    return {
    id:`quiz:${row.id}`,revision:1,...identity,memory_item_id:row.memory_item_id,script:row.response,...(row.data?.speech_source?.cleanupStatus==='completed'?{raw_script:row.data.speech_source.rawText,transcript_formatting:row.data.speech_source}:{}),structure:'',revision_kind:row.mode==='oral'?'quiz_oral':'quiz_answer',created_at:row.created_at,
    target_id:row.data?.target_id||row.item?.target_id||row.session_metadata?.targetId||null,target_snapshot:row.data?.target_snapshot||row.item?.target_snapshot||row.session_metadata?.targetSnapshot||null,source_kind:row.data?.source_kind||row.item?.source_kind||'personal',source_type:row.data?.source_type||row.item?.source_type||'personal',common_revision:row.data?.common_revision||row.item?.common_revision||null,source_snapshot:row.data?.source_snapshot||row.item?.source_snapshot||null,quiz_session_id:row.session_id,response_mode:row.mode==='oral'&&row.data?.recording_id?'audio':'text',audio_id:row.data?.recording_id||null,assisted:assistance.assisted,ai_assisted:assistance.aiAssisted,hint_used:assistance.hintUsed,assistance_recorded:assistance.assisted||row.data?.assistance_recorded===true,content_version:row.content_version,source_status:'saved',source_ref_ids:row.item?.source_ref_ids||[],outcome:row.mode==='oral'?null:row.outcome,evaluation_method:row.mode==='oral'||row.outcome===null?'ungraded':'reviewed_correct_answer',
    comparison:answerComparison(observedAnswerText({script:row.response,raw_script:row.data?.speech_source?.cleanupStatus==='completed'?row.data.speech_source.rawText:null}),sourceQuestion,source?.answer_designs?.find(d=>d.question_id===identity.question_id)),
  }});
  const assignmentVersions = attempts.filter(row=>typeof row.response?.response==='string'&&row.response.response.trim()).map(row=>{
    const assignment = assignments.find(a=>a.id===row.assignment_id),item=assignment?.items.find((i:any)=>i.id===row.memory_item_id);
    const source=sourceAt(assignment?.content_version),identity=quizAnswerContext(item||{}, row.response||{},source);
    const response=item?.kind==='choice'?item.options?.find((option:any)=>option.id===row.response.selectedOptionId||option.id===row.response.response)?.text||row.response.response:row.response.response;
    const help=row.response||{},assistance={assisted:help.assisted===true||help.hintUsed===true||help.aiAssisted===true,hintUsed:help.hintUsed===true,aiAssisted:help.aiAssisted===true},question=item?.question_snapshot||source?.questions.find(q=>q.id===identity.question_id);
    return {id:`assignment:${row.id}`,revision:1,...identity,question:identity.practice_kind!=='concept'&&question?.prompt?question.prompt:identity.question,memory_item_id:row.memory_item_id,script:response,structure:'',revision_kind:'assignment_answer',response_mode:'text',created_at:row.submitted_at,assignment_id:row.assignment_id,target_id:item?.target_id||row.response?.target_id||assignment?.target_id||null,target_snapshot:item?.target_snapshot||row.response?.target_snapshot||assignment?.target_snapshot||null,source_kind:item?.source_kind||row.response?.source_kind||'personal',source_type:item?.source_type||row.response?.source_type||'personal',common_revision:item?.common_revision||row.response?.common_revision||null,source_snapshot:item?.source_snapshot||row.response?.source_snapshot||null,content_version:assignment?.content_version,source_status:item?'saved':'unavailable',outcome:row.result?.correct,evaluation_method:row.result?.evaluation_method,...assistance,ai_assisted:assistance.aiAssisted,hint_used:assistance.hintUsed,assistance_recorded:assistance.assisted||row.response?.assistance_recorded===true,required_meanings:item?.required_meaning_elements||question?.answer_elements||[],comparison:answerComparison(response,question)};
  });
  const checks=preferenceRows[0]?.data?.answer_meaning_checks||{};
  const answerRevisions = [...editedVersions,...interviewVersions,...quizVersions,...assignmentVersions].filter(v=>v.question_id).map(version=>{const saved=checks[version.id],required=version.comparison?.required_meanings.map((m:any)=>m.text)||[];return {...version,self_checked_meanings:Array.isArray(saved?.checkedMeanings)?saved.checkedMeanings.filter((text:unknown)=>typeof text==='string'&&required.includes(text)):[],self_checked_at:saved?.checkedAt||null};}).sort((a,b) => new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
  return answerRevisions;
}

export type LearningHistoryOptions={cursor?:string|null;questionId?:string|null;targetId?:string|null;sourceType?:string|null;sourceVersion?:string|number|null;limit?:number;versionId?:string|null};
async function assertHistoryScope(user:Profile,studentId:string){
  if(user.role==='student'){if(user.id!==studentId)throw new ApiError(403,'내 기록만 확인할 수 있어요.');return;}
  if(user.role==='staff'){
    const[assigned]=await query("select student_id from staff_assignments where staff_id=$1 and student_id=$2 and permissions @> '[\"review\"]'::jsonb",[user.id,studentId]);
    if(!assigned)throw new ApiError(403,'배정된 학생의 기록만 확인할 수 있어요.');
  }
  const[student]=await query("select id from profiles where id=$1 and role='student' and active=true",[studentId]);if(!student)throw new ApiError(404,'학생을 찾을 수 없어요.');
}

/** Page metadata first; only selected answer bodies and their frozen question/design fragments cross the DB boundary. */
export async function getLearningHistoryPage(user:Profile,requestedStudentId?:string,options:LearningHistoryOptions={}){
  const studentId=requestedStudentId||user.id;if(!/^[0-9a-f-]{36}$/i.test(studentId))throw new ApiError(400,'학생을 확인해 주세요.');
  await assertHistoryScope(user,studentId);
  const limit=options.limit??30,questionId=options.questionId||'',targetId=options.targetId||'',sourceType=options.sourceType||'',sourceVersion=options.sourceVersion==null?'':String(options.sourceVersion),versionId=options.versionId||'';
  if(!Number.isInteger(limit)||limit<1||limit>250||questionId.length>200||sourceType.length>100||(sourceVersion&&!/^\d{1,9}$/.test(sourceVersion))||(versionId&&!/^[\w.:-]{1,200}$/.test(versionId)))throw new ApiError(400,'기록 범위를 확인해 주세요.');
  if(targetId){if(targetId.length>160)throw new ApiError(400,'지원 학교를 확인해 주세요.');const[owned]=await query('select id from support_targets where student_id=$1 and id=$2',[studentId,targetId]);if(!owned)throw new ApiError(404,'지원 학교를 찾을 수 없어요.');}
  const scope=JSON.stringify([user.id,studentId,'learning-history',questionId,targetId,sourceType,sourceVersion,versionId]);let cursor;
  try{cursor=parseRecordCursor(options.cursor,scope);}catch(error){throw new ApiError(400,(error as Error).message);}
  const values:unknown[]=[studentId],where=['student_id=$1',"nullif(question_id,'') is not null"];
  if(questionId){values.push(questionId);where.push(`question_id=$${values.length}`);}
  if(targetId){values.push(targetId);where.push(`(target_id=$${values.length} or target_ids ? $${values.length})`);}
  if(sourceType){values.push(sourceType);where.push(`source_type=$${values.length}`);}
  if(sourceVersion){values.push(Number(sourceVersion));where.push(`${sourceType==='common'?'common_revision':'source_version'}=$${values.length}`);}
  if(versionId){values.push(versionId);where.push(`id=$${values.length}`);}
  if(cursor){values.push(cursor.anchor.at,cursor.anchor.id,cursor.after.at,cursor.after.id);const start=values.length-3;where.push(`(created_at,id)<=($${start}::timestamptz,$${start+1}::text) and (created_at,id)<($${start+2}::timestamptz,$${start+3}::text)`);}
  values.push(limit+1);
  const metadata=await query(`select id,origin,source_id,ordinal,created_at,question_id,source_version,${RECORD_CURSOR_TIMESTAMP} as __cursor_at from learning_answer_history_index where ${where.join(' and ')} order by created_at desc,id desc limit $${values.length}`,values);
  const page=recordPage(metadata,limit,scope,cursor),selected=page.items;
  if(!selected.length)return {versions:[],versionsPage:page.page};
  const ids=(kind:string)=>selected.filter(row=>row.origin===kind).map(row=>row.source_id);
  const interviewRows=selected.filter(row=>String(row.origin).startsWith('interview_'));
  const [versions,interviews,quizAnswers,assignmentRows,preferenceRows]=await Promise.all([
    ids('edit').length?query('select r.*,a.question_id from answer_revisions r join user_answers a on a.id=r.answer_id where a.student_id=$1 and r.id=any($2::uuid[])',[studentId,ids('edit')]):Promise.resolve([]),
    interviewRows.length?query(`select t.id,t.session_id,t.question_id,t.created_at,
      t.data-'answer'-'originalAnswer'-'draft'-'answerRevisions'-'transcriptRevisions' as data,
      s.target_id,s.data->'context'->'target' as target_snapshot,
      jsonb_build_object('id',s.data->'experienceCard'->'id','revision',s.data->'experienceCard'->'revision') as experience_card,
      (select jsonb_agg(q) from jsonb_array_elements(coalesce(s.data->'context'->'questions','[]'::jsonb))q where q->>'id' in(t.question_id,t.data->>'rootQuestionId')) as context_questions,
      s.kind,s.content_version,s.data->'context'->>'sourceKind' as source_kind,
      jsonb_build_array(jsonb_build_object('id',h.id,'revision',case when h.origin='interview_revision' then coalesce(t.data->'answerRevisions'->(h.ordinal::int-1)->'revision',to_jsonb(h.ordinal)) when h.origin='interview_transcript' then to_jsonb(h.ordinal+1) else '1'::jsonb end,
        'script',case h.origin when 'interview_revision' then t.data->'answerRevisions'->(h.ordinal::int-1)->>'text' when 'interview_transcript' then t.data->'transcriptRevisions'->(h.ordinal::int-1)->>'transcript' when 'interview_original' then case when jsonb_typeof(t.data->'originalAnswer')='string' then t.data->>'originalAnswer' else t.data->>'answer' end else t.data->>'answer' end,
        'revision_kind',case when h.origin='interview_transcript' or h.origin='interview_revision' and t.data->'answerRevisions'->(h.ordinal::int-1)->>'kind'='transcript_correction' then 'transcript_correction' else 'interview_answer' end,'created_at',h.created_at)) as __selected_versions
      from jsonb_to_recordset($2::jsonb)h(id text,source_id uuid,origin text,ordinal bigint,created_at timestamptz)
      join interview_turns t on t.id=h.source_id and t.student_id=$1
      join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id
      where s.state not in('cancelled','deleted') and coalesce(t.data->>'invalidated','false')!='true'`,[studentId,JSON.stringify(interviewRows)]):Promise.resolve([]),
    ids('quiz').length?query('select r.*,s.mode,s.content_version,s.metadata as session_metadata,s.items->r.item_index as item from quiz_responses r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.student_id=$1 and r.id=any($2::uuid[])',[studentId,ids('quiz')]):Promise.resolve([]),
    ids('assignment').length?query(`select r.*,a.content_version as assignment_content_version,a.target_id as assignment_target_id,a.target_snapshot as assignment_target_snapshot,
      (select item from jsonb_array_elements(a.items)item where item->>'id'=r.memory_item_id limit 1) as assignment_item
      from quiz_submissions r join quiz_assignments a on a.id=r.assignment_id and a.student_id=r.student_id where r.student_id=$1 and r.id=any($2::uuid[])`,[studentId,ids('assignment')]):Promise.resolve([]),
    query(`select jsonb_build_object('answer_meaning_checks',coalesce((select jsonb_object_agg(key,value) from jsonb_each(coalesce(data->'answer_meaning_checks','{}'::jsonb)) where key=any($2::text[])),'{}'::jsonb)) as data from student_preferences where student_id=$1`,[studentId,selected.map(row=>row.id)]),
  ]);
  const assignmentMap=new Map<string,Record<string,any>>();
  for(const row of assignmentRows){
    let assignment=assignmentMap.get(row.assignment_id);
    if(!assignment){assignment={id:row.assignment_id,content_version:row.assignment_content_version,target_id:row.assignment_target_id,target_snapshot:row.assignment_target_snapshot,items:[]};assignmentMap.set(row.assignment_id,assignment);}
    if(row.assignment_item&&!assignment.items.some((item:any)=>item.id===row.assignment_item.id))assignment.items.push(row.assignment_item);
  }
  const assignments=[...assignmentMap.values()];
  const neededVersions=[...new Set([...versions.map(row=>row.data?.contentVersion),...interviews.map(row=>row.content_version),...quizAnswers.map(row=>row.content_version),...assignments.map(row=>row.content_version)].filter(value=>typeof value==='number'&&value>0))];
  const questionIds=[...new Set([...selected.map(row=>row.question_id),...interviews.flatMap(row=>[row.question_id,row.data?.rootQuestionId]),...quizAnswers.map(row=>row.item?.question_id),...assignmentRows.map(row=>row.assignment_item?.question_id)].filter(Boolean))];
  const archivedContent=neededVersions.length?await query(`select v.version,jsonb_build_object(
    'questions',coalesce((select jsonb_agg(q) from jsonb_array_elements(coalesce(v.data->'questions','[]'::jsonb))q where q->>'id'=any($3::text[])),'[]'::jsonb),
    'answer_designs',coalesce((select jsonb_agg(d) from jsonb_array_elements(coalesce(v.data->'answer_designs','[]'::jsonb))d where d->>'question_id'=any($3::text[])),'[]'::jsonb)) as data
    from content_versions v join content_packages p on p.id=v.package_id where p.student_id=$1 and v.status='published' and v.version=any($2::int[]) order by v.version`,[studentId,neededVersions,questionIds]):[];
  const projected=projectLearningHistory({versions,interviews,quizAnswers,attempts:assignmentRows,assignments,archivedContent,preferenceRows});
  const byId=new Map(projected.map(row=>[row.id,row]));
  return {versions:selected.map(row=>byId.get(row.id)).filter(Boolean),versionsPage:page.page};
}
