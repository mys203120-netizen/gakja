import { growthContextResolver } from './learning-growth';

type FlowItem = Record<string, any>;
const answerKinds = new Set(['interview_answer','quiz_answer','quiz_oral','assignment_answer']);

/** Reading, editing and correcting one utterance are not a fresh recall attempt. */
export function questionPracticeState(revisions:FlowItem[], question:FlowItem, target:FlowItem|undefined, contentVersion?:number) {
  const targetId=target?.id;
  const scopeVersion={id:'scope',question_id:question.id,script:'',created_at:'',target_id:targetId,target_snapshot:target,common_revision:question.common_revision,source_type:question.source_type,content_version:contentVersion};
  const candidates=revisions.filter(row=>row.question_id===question.id&&row.target_id===targetId&&row.script?.trim());
  const resolveContext=growthContextResolver([...candidates,scopeVersion] as any);
  const scope=resolveContext(scopeVersion);
  const sourceScope=growthContextResolver([{...scopeVersion,target_snapshot:null}])({...scopeVersion,target_snapshot:null});
  const snapshotMissing=(row:FlowItem)=>!['university','school_reference_id','department','major','department_catalog_id','campus','admission_year','admission_type'].some(field=>row.target_snapshot?.[field]);
  const saved=candidates.flatMap(row=>{
    if(resolveContext(row as any)===scope)return [row];
    // Keep an owned historical answer visible without assigning today's school details to its missing snapshot.
    if(snapshotMissing(row)){
      const sourceRow={...row,target_snapshot:null};
      if(growthContextResolver([sourceRow] as any)(sourceRow as any)===sourceScope)return [{...row,context_unverified:true}];
    }
    return [];
  });
  const seen=new Set<string>();
  const attempts=saved.filter(row=>answerKinds.has(row.revision_kind)&&!seen.has(row.id)&&(seen.add(row.id),true))
    .sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  const helpUsed=attempts.filter(row=>row.assisted===true||row.hint_used===true||row.ai_assisted===true);
  const helpNotOpened=attempts.filter(row=>row.assistance_recorded===true&&row.assisted!==true&&row.hint_used!==true&&row.ai_assisted!==true);
  const helpUnknown=attempts.filter(row=>!helpUsed.includes(row)&&!helpNotOpened.includes(row));
  return {attempts,latest:attempts[0]||null,helpUsed,helpNotOpened,helpUnknown,contextUnknown:attempts.filter(row=>row.context_unverified),
    interviewSaved:attempts.some(row=>row.revision_kind==='interview_answer'&&!row.context_unverified),
    canCompare:attempts.filter(row=>!row.context_unverified).length>1,
    status:!attempts.length?'아직 새 답변 없음':helpNotOpened.length?'도움 조회 없이 남긴 답변 있음':helpUsed.length?'도움을 보고 남긴 답변 있음':'도움 여부 미기록'};
}

export function practiceHelpLabel(attempt:FlowItem) {
  const help=attempt.assisted===true||attempt.hint_used===true||attempt.ai_assisted===true?'도움 사용':attempt.assistance_recorded===true?'도움 조회 기록 없음':'도움 여부 미기록';
  return help+(attempt.context_unverified?' · 지원처 세부 기준 미기록':'');
}

/** A suggestion keeps its question, school and reviewed source; it is not a readiness score. */
export function todayQuestionContext(question:FlowItem,targetId?:string,contentVersion?:number|string) {
  const common=Boolean(question.common_revision||question.source_kind==='common'||question.sourceKind==='common');
  return {questionId:String(question.id),targetId,activityId:question.activity_ids?.[0] as string|undefined,
    sourceType:common?'common' as const:'personal' as const,
    sourceVersion:common?question.common_revision?String(question.common_revision):undefined:contentVersion?String(contentVersion):undefined};
}
