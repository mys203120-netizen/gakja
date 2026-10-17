import 'server-only';
import type { Profile } from './auth';
import { ApiError, query, transaction } from './db';
import { getLearning } from './data';
import { KNOWLEDGE_CATALOG, matchKnowledgeVideos, knowledgeSearches, knowledgeTargetSearches, type KnowledgeActivity, type KnowledgeContext, type KnowledgeMatch, type KnowledgeQuestion } from './knowledge-bites-catalog';
import { connectKnowledgeQuestions, knowledgeCheckPrompt } from './knowledge-flow-model';
import { knowledgeTarget, schoolKnowledgeReadings, addCommonKnowledgeConnections, sameKnowledgeTarget } from './knowledge-target-model';
import { commonInterviewQuestions } from './school-learning';
import { recordStudyEvent, studySummary } from './study-sessions';
import { publishedQuestionMatchesTarget } from './published-question-scope';

function student(user: Profile) { if (user.role !== 'student') throw new ApiError(403, '학생 계정에서 이용해 주세요.'); }
function itemId(value: unknown): string { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(value)) throw new ApiError(400, '학습 자료를 확인해 주세요.'); return value; }
type Progress = { id: string; student_id: string; video_id: string; saved: boolean; completed_at: string | null; reflection: string; revision: number; snapshot: { activities?: KnowledgeActivity[]; contexts?: KnowledgeContext[]; contentVersion?: number; item?:KnowledgeMatch; [key: string]: any }; created_at: string; updated_at: string };
async function knowledgeContext(user:Profile, requestedTarget?:string|null, questionId?:string|null) {
  const [content,targets,preferences] = await Promise.all([getLearning(user.id), query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by created_at,id",[user.id]),query('select data from student_preferences where student_id=$1',[user.id])]);
  if(requestedTarget && !targets.some(row=>row.id===requestedTarget))throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
  const selected = targets.find(row=>row.id===(requestedTarget || preferences[0]?.data?.selectedTargetId)) || targets[0];
  const rawTarget = selected ? {...selected.data,id:selected.id} : null, target = rawTarget ? knowledgeTarget(rawTarget) : null;
  const common = target ? await commonInterviewQuestions(user.id,target.id) : [];
  const personal:KnowledgeQuestion[] = (content.learning.questions || []).filter((item:any)=>publishedQuestionMatchesTarget(item,content.learning,rawTarget)).map((item:any)=>({id:item.id,prompt:item.prompt,activityIds:Array.isArray(item.activity_ids)?item.activity_ids:[],sourceKind:'personal',targetId:target?.id || null,targetSnapshot:target?.snapshot || null}));
  const questions:KnowledgeQuestion[] = [...personal,...common.map((item:any)=>({id:item.id,prompt:item.prompt,activityIds:[],sourceKind:'common' as const,sourceType:item.source_type,commonRevision:item.common_revision,sourceSnapshot:item.source_snapshot,targetId:target!.id,targetSnapshot:target!.snapshot}))];
  const contextQuestion = questionId ? questions.find(item=>item.id===questionId) : null;
  if(questionId && !contextQuestion)throw new ApiError(404,'이 학교에 연결된 질문을 찾을 수 없어요.');
  let items=matchKnowledgeVideos(content.learning,target);
  if(target && rawTarget)items=[...schoolKnowledgeReadings(rawTarget,questions),...addCommonKnowledgeConnections(items,questions,target,questionId)];
  return {content,target,questions,contextQuestion,items};
}
export async function getKnowledgeBites(user: Profile, historyVideo?: string | null, questionId?: string | null, targetId?:string|null) {
  student(user);
  const {content,target,questions,contextQuestion,items} = await knowledgeContext(user,targetId,questionId);
  const events = await query("select id,kind,source_id,data,created_at from study_session_events where student_id=$1 and kind in ('quiz_response','memory_review','assignment_submission') union all select id,kind,source_id,data,occurred_at as created_at from study_imported_events where student_id=$1 and kind in ('quiz_response','memory_review','assignment_submission') order by created_at,id", [user.id]);
  const weak = new Set(studySummary(events.filter(row=>!row.data?.target_id || row.data.target_id===target?.id)).weakPoints.map(row => row.questionId));
  const rows = await query<Progress>('select * from knowledge_bite_progress where student_id=$1 order by updated_at desc', [user.id]);
  const byItem = new Map(rows.map(row => [row.video_id, row]));
  const scopedHistory = await query('select distinct on(video_id) video_id,metadata,reflection from knowledge_bite_revisions where student_id=$1 and coalesce(metadata->\'targetSnapshot\',\'null\'::jsonb)=$2::jsonb order by video_id,revision desc',[user.id,JSON.stringify(target?.snapshot || null)]);
  const scopedByItem=new Map(scopedHistory.map(row=>[row.video_id,row]));
  const videos:KnowledgeMatch[]=items.map(item=>{const progress=byItem.get(item.id);const scoped=scopedByItem.get(item.id);return {...item,progress:progress?(scoped&&!sameKnowledgeTarget(progress.snapshot.targetSnapshot,item.targetSnapshot)?{...progress,snapshot:scoped.metadata,reflection:scoped.reflection}:progress):null};});
  for(const row of rows) {
    if(videos.some(item=>item.id===row.video_id))continue;
    const catalog=row.snapshot?.item || KNOWLEDGE_CATALOG.find(item=>item.id===row.video_id);
    if(catalog)videos.push({...catalog,activities:row.snapshot.activities || [],contexts:row.snapshot.contexts || [],targetId:row.snapshot.targetId || null,targetSnapshot:row.snapshot.targetSnapshot || null,current:false,progress:row});
  }
  let history:Record<string,unknown>[]=[];
  if(historyVideo) {
    const id=itemId(historyVideo);
    if(!videos.some(item=>item.id===id))throw new ApiError(404,'연결된 학습 자료를 찾을 수 없어요.');
    history=await query('select revision,saved,completed_at,reflection,metadata,created_at from knowledge_bite_revisions where student_id=$1 and video_id=$2 order by revision desc limit 50',[user.id,id]);
  }
  const connected=connectKnowledgeQuestions(videos,questions.map(item=>({...item,needsReview:weak.has(item.id)})),questionId);
  return {videos:connected,readings:connected.filter(item=>item.kind==='reading'),targetId:target?.id || null,selectedTarget:target,contextQuestion:contextQuestion || null,history,
    searches:[...knowledgeSearches(content.learning,items),...(target?knowledgeTargetSearches(target):[])],
    activities:(content.learning.activities || []).map((item:any)=>({id:item.id,title:item.title,grade:item.grade,area:item.area})),
    contentVersion:content.package?.active_version ?? null,stats:{available:items.length,saved:rows.filter(row=>row.saved).length,completed:rows.filter(row=>row.completed_at).length}};
}
export async function mutateKnowledgeBite(user: Profile, input: Record<string, unknown>) {
  student(user);
  const id=itemId(input.videoId);
  if(!['save','complete','reflection','explanation','self_check'].includes(String(input.action)))throw new ApiError(400,'작업을 확인해 주세요.');
  if(!Number.isInteger(input.expectedRevision)||(input.expectedRevision as number)<0)throw new ApiError(400,'저장 번호를 확인해 주세요.');
  if(['save','complete'].includes(String(input.action))&&typeof input.value!=='boolean')throw new ApiError(400,'선택 값을 확인해 주세요.');
  if(['reflection','explanation'].includes(String(input.action))&&(typeof input.value!=='string'||input.value.length>4000))throw new ApiError(400,'기록은 4,000자까지 적을 수 있어요.');
  if(input.action==='explanation'&&!(input.value as string).trim())throw new ApiError(400,'내 말로 설명한 내용을 적어 주세요.');
  if(input.action==='self_check'&&!['explained','needs_review','not_yet'].includes(String(input.value)))throw new ApiError(400,'확인 상태를 선택해 주세요.');
  if(input.questionId!==undefined&&(typeof input.questionId!=='string'||!input.questionId||input.questionId.length>200))throw new ApiError(400,'연결 질문을 확인해 주세요.');
  if(input.targetId!==undefined&&(typeof input.targetId!=='string'||!input.targetId||input.targetId.length>200))throw new ApiError(400,'지원 학교를 확인해 주세요.');
  if(input.assisted!==undefined&&typeof input.assisted!=='boolean')throw new ApiError(400,'도움 사용 여부를 확인해 주세요.');
  if(input.commonRevision!==undefined&&(!Number.isInteger(input.commonRevision)||(input.commonRevision as number)<1))throw new ApiError(400,'자료 버전을 확인해 주세요.');
  const {content,target,questions,items}=await knowledgeContext(user,input.targetId as string|undefined,input.questionId as string|undefined);
  const matched=connectKnowledgeQuestions(items,questions).find(item=>item.id===id);
  return transaction(async client=>{
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[`knowledge-bite:${user.id}:${id}`]);
    const old=(await client.query<Progress>('select * from knowledge_bite_progress where student_id=$1 and video_id=$2 for update',[user.id,id])).rows[0];
    const catalog=matched || old?.snapshot?.item || KNOWLEDGE_CATALOG.find(item=>item.id===id);
    if(!catalog || !matched&&!old)throw new ApiError(404,'나에게 연결된 학습 자료만 저장할 수 있어요.');
    const question=input.questionId?matched?.relatedQuestions?.find(item=>item.id===input.questionId):null;
    if(input.questionId&&!question)throw new ApiError(404,'이 자료에 연결된 질문을 확인해 주세요.');
    if(question?.sourceKind==='common'&&input.commonRevision!==undefined&&question.commonRevision!==input.commonRevision)throw new ApiError(409,'학교 자료가 갱신되었어요. 다시 불러온 뒤 저장해 주세요.');
    const nextSaved=input.action==='save'?input.value as boolean:old?.saved ?? false;
    const nextCompleted=input.action==='complete'?input.value?old?.completed_at ?? new Date().toISOString():null:old?.completed_at ?? null;
    const sameTarget=!matched || sameKnowledgeTarget(old?.snapshot?.targetSnapshot,matched.targetSnapshot);
    const restored=matched&&!sameTarget?(await client.query('select metadata,reflection from knowledge_bite_revisions where student_id=$1 and video_id=$2 and coalesce(metadata->\'targetSnapshot\',\'null\'::jsonb)=$3::jsonb order by revision desc limit 1',[user.id,id,JSON.stringify(matched.targetSnapshot || null)])).rows[0]:null;
    const nextReflection=input.action==='reflection'?(input.value as string).trim():sameTarget?old?.reflection ?? '':restored?.reflection || '';
    const previous=(restored?.metadata || old?.snapshot)?.learning || {};
    const previousCurrent=!matched || matched.relatedQuestions?.some(item=>item.id===previous.questionId && item.commonRevision===previous.commonRevision) || !previous.questionId;
    const reset=Boolean(matched && (!sameTarget&&!restored || !previousCurrent || question && question.id!==previous.questionId));
    const learning={...previous,
      ...(reset?{questionId:undefined,prompt:undefined,checkPrompt:undefined,explanation:'',explanationSavedAt:null,selfCheck:undefined,assisted:false,sourceKind:undefined,sourceType:undefined,commonRevision:undefined,sourceSnapshot:undefined}:{}),
      ...(matched?{targetId:target?.id || null,targetSnapshot:target?.snapshot || null}:{}),
      ...(question?{questionId:question.id,prompt:question.prompt,checkPrompt:knowledgeCheckPrompt(catalog.topic,question),sourceKind:question.sourceKind,sourceType:question.sourceType,commonRevision:question.commonRevision,sourceSnapshot:question.sourceSnapshot,contentVersion:content.package?.active_version ?? null}:{}),
      ...(input.action==='explanation'?{explanation:(input.value as string).trim(),explanationSavedAt:new Date().toISOString(),contentVersion:content.package?.active_version ?? null,assisted:input.assisted===true || !reset&&previous.assisted===true}:{}),
      ...(input.action==='self_check'?{selfCheck:input.value}:{}),
    };
    const sameLearning=previous.questionId===learning.questionId && previous.explanation===learning.explanation && previous.selfCheck===learning.selfCheck && Boolean(previous.assisted)===Boolean(learning.assisted) && previous.commonRevision===learning.commonRevision && sameKnowledgeTarget(previous.targetSnapshot,learning.targetSnapshot);
    if(old&&sameTarget&&old.saved===nextSaved&&Boolean(old.completed_at)===Boolean(nextCompleted)&&old.reflection===nextReflection&&sameLearning)return {progress:old,unchanged:true};
    if((old?.revision ?? 0)!==input.expectedRevision)throw new ApiError(409,'다른 화면에서 수정했어요. 다시 불러온 뒤 저장해 주세요.');
    const revision=(old?.revision ?? 0)+1;
    const snapshot:Progress['snapshot']={...(matched?{title:catalog.title,label:catalog.label,topic:catalog.topic,focus:catalog.focus,stretch:catalog.stretch,activities:matched.activities,contexts:matched.contexts || [],contentVersion:content.package?.active_version,verifiedAt:catalog.verifiedAt,targetId:target?.id || null,targetSnapshot:target?.snapshot || null,sourceSnapshot:matched.sourceSnapshot,item:{...matched,progress:null,relatedQuestions:[]}}:old.snapshot),learning,lastAction:input.action};
    const progress=(await client.query<Progress>('insert into knowledge_bite_progress(student_id,video_id,saved,completed_at,reflection,revision,snapshot) values($1,$2,$3,$4,$5,$6,$7) on conflict(student_id,video_id) do update set saved=excluded.saved,completed_at=excluded.completed_at,reflection=excluded.reflection,revision=excluded.revision,snapshot=excluded.snapshot,updated_at=now() returning *',[user.id,id,nextSaved,nextCompleted,nextReflection,revision,JSON.stringify(snapshot)])).rows[0];
    await client.query('insert into knowledge_bite_revisions(progress_id,student_id,video_id,saved,completed_at,reflection,revision,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)',[progress.id,user.id,id,nextSaved,nextCompleted,nextReflection,revision,JSON.stringify(snapshot)]);
    if(input.action!=='save')await recordStudyEvent(client,user.id,{kind:'knowledge_progress',sourceId:`${progress.id}:${revision}`,data:{videoId:id,itemKind:catalog.kind || 'video',title:catalog.label,action:input.action,completed:Boolean(nextCompleted),reflection:nextReflection,explanation:learning.explanation || '',explanationSaved:input.action==='explanation',explanationContentVersion:learning.contentVersion ?? null,assisted:learning.assisted===true,selfCheck:learning.selfCheck || null,questionId:learning.questionId || null,prompt:learning.prompt || null,source_kind:learning.sourceKind==='common'?'common':'personal',source_type:learning.sourceType || null,common_revision:learning.commonRevision || null,source_snapshot:learning.sourceSnapshot || snapshot.sourceSnapshot || null,target_id:snapshot.targetId || null,target_snapshot:snapshot.targetSnapshot || null,activityIds:(snapshot.activities || []).map((activity:KnowledgeActivity)=>activity.id),recordContexts:snapshot.contexts || [],sourceRefIds:[...new Set((snapshot.contexts || []).flatMap((context:KnowledgeContext)=>context.sourceRefIds))],focus:catalog.focus,stretch:catalog.stretch,contentVersion:snapshot.contentVersion ?? null,selfReported:true}});
    return {progress,unchanged:false};
  });
}
