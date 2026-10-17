import {createHash} from 'node:crypto';
import type {SessionItem} from './quiz-rules';
import {schoolDirectoryForTarget} from './school-directory';

export type SchoolQuizItem=SessionItem & {
  source_kind:'common';source_type:string;common_revision:number;source_snapshot:Record<string,any>;
  target_id:string|null;target_snapshot:Record<string,any>|null;talent_profile?:Record<string,any>;talent_context?:Record<string,any>;
};
/** A target change creates another practice identity; old sources stay readable. */
export function schoolQuizTargetIdentity(target:Record<string,any>|null) {
  if(!target)return null;
  const school=schoolDirectoryForTarget(target);
  const major=target.department || target.major || '';
  const matches=school?.departments.filter(item=>(!target.department_catalog_id || item.id===target.department_catalog_id) && item.name===major && (item.campus===target.campus || school.campusLabel===target.campus)) || [];
  const department=matches.length===1?matches[0]:null;
  const campus=school?.campusLabel && (target.campus===school.campusLabel || department?.campus===target.campus)?school.campusLabel:target.campus || '';
  return {id:target.id,university:school?.canonicalName || target.university || '',school_reference_id:school?.id || null,
    campus,department:major,major,department_catalog_id:department?.id || null,
    admission_year:target.admission_year || target.year || null,admission_type:target.admission_type || target.track || '',
    interview_stage:target.interview_stage || target.stage || null,department_field:department?.field || null};
}
/** These are interpretation/experience questions, never objective admission grades. */
export function schoolQuizItems(questions:Record<string,any>[],target:Record<string,any>|null,selection:{activity?:Record<string,any>|null;sourceRefs?:Record<string,any>[]}={}):SchoolQuizItem[] {
  const snapshot=schoolQuizTargetIdentity(target);
  const activity=selection.activity && ['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(selection.activity.fact_confirmation)?selection.activity:null;
  return questions.map(question=>{
    const id='schoolq_'+createHash('sha256').update(JSON.stringify({target:snapshot,questionId:question.id,revision:question.common_revision})).digest('hex').slice(0,32);
    const source=structuredClone(question.source_snapshot || {});
    const sourceId=question.source_ref_ids?.[0] || `school_question_${question.id}_v${question.common_revision}`;
    const quote=source.summary || source.point || source.title || '';
    const selectedActivity=question.talent_profile?activity:null;
    const personalSources=selectedActivity?(selectedActivity.source_ref_ids || []).flatMap((id:string)=>{const source=selection.sourceRefs?.find(source=>source.id===id);return source?.quote?[{id,text:source.quote,area:source.area,page:source.page}]:[];}):[];
    return {id,question_id:question.id,answer_script_id:null,activity_ids:selectedActivity?[selectedActivity.id]:[],prompt:question.prompt,
      kind:'short_speech',category:'experiential',evaluation_method:'self_check',verification_status:'approved',
      memory_keywords:[...(question.answer_elements || [])],required_meaning_elements:[...(question.answer_elements || [])],
      default_time_limit_seconds:60,source_ref_ids:[...new Set([...(question.source_ref_ids || []),...(selectedActivity?.source_ref_ids || [])])],modelAnswer:'',
      practice_kind:'personal',practice_prompt:question.prompt,practice_question_id:question.id,linked_question_id:null,
      sourceQuotes:[...(quote?[{id:sourceId,text:quote}]:[]),...personalSources],source_kind:'common',source_type:question.source_type || 'general_practice',
      common_revision:Number(question.common_revision),source_snapshot:source,target_id:target?.id || null,target_snapshot:snapshot,
      ...(question.talent_profile?{talent_profile:structuredClone(question.talent_profile)}:{}),
      ...(question.talent_context?{talent_context:structuredClone(question.talent_context)}:{}),
    };
  });
}
export function quizSchoolMetadata(item:SessionItem):Record<string,any> {
  const source=item as Partial<SchoolQuizItem>;
  return source.source_kind==='common'?{source_kind:'common',source_type:source.source_type,common_revision:source.common_revision,
    source_snapshot:source.source_snapshot,target_id:source.target_id,target_snapshot:source.target_snapshot,
    ...(source.talent_profile?{talent_profile:source.talent_profile}:{}),...(source.talent_context?{talent_context:source.talent_context}:{}),
  }:{};
}
/** Text matches alone cannot move an old answer to another school or source. */
export function sameSchoolQuizSource(saved:SessionItem,current:SessionItem) {
  const a=saved as Partial<SchoolQuizItem>,b=current as Partial<SchoolQuizItem>;
  if(a.source_kind!=='common' && b.source_kind!=='common')return true;
  const fields=['id','school_reference_id','university','campus','department','major','department_catalog_id','admission_year','admission_type','interview_stage'];
  return a.source_kind===b.source_kind && a.target_id===b.target_id && Number(a.common_revision)===Number(b.common_revision)
    && fields.every(field=>String(a.target_snapshot?.[field] ?? '')===String(b.target_snapshot?.[field] ?? ''));
}
