import { createHash } from 'node:crypto';
import { schoolDirectoryForTarget } from './school-directory';
import { schoolTalentForTarget } from './school-talent-model';
import { schoolQuizTargetIdentity } from './school-quiz';
import { KNOWLEDGE_CATALOG, type KnowledgeMatch, type KnowledgeQuestion, type KnowledgeTarget } from './knowledge-bites-catalog';
import { knowledgeTargetKey } from './knowledge-flow-model';
import {departmentLearningContext} from './department-learning';

export function knowledgeTarget(raw: Record<string, any>): KnowledgeTarget {
  const school = schoolDirectoryForTarget(raw), unit = raw.department || raw.major || '';
  const department = school?.departments.find(item => item.id === raw.department_catalog_id && item.name === unit && (item.campus === raw.campus || school.campusLabel === raw.campus));
  const name=department?.programs?.includes(raw.interest_department)?raw.interest_department:unit;
  return { id:raw.id, university:school?.canonicalName || raw.university, department:name, campus:raw.campus || null,
    departmentCatalogId:department?.id || null, departmentField:department?.field || null, departmentCategory:department?.category || null,
    sourceUrl:department?.sourceUrl, snapshot:schoolQuizTargetIdentity(raw)! };
}
const readingId = (target: KnowledgeTarget, source: unknown) => 'r_' + createHash('sha256').update(JSON.stringify({ target:target.snapshot, source })).digest('base64url').slice(0, 9);

/** Official readings retain their exact scope and never masquerade as videos or official past questions. */
export function schoolKnowledgeReadings(raw: Record<string, any>, questions: KnowledgeQuestion[]): KnowledgeMatch[] {
  const target = knowledgeTarget(raw), talent = schoolTalentForTarget(raw);
  const schoolReadings=talent.profiles.flatMap(profile => profile.points.map(point => {
    const source = { ...point.source, profileId:point.profileId, profileRevision:point.profileRevision, pointId:point.id, scope:point.scope, definitionKind:point.definitionKind, summary:point.description };
    const label = point.definitionKind === 'education_goal' ? '교육목표' : point.definitionKind === 'core_competencies' ? '핵심역량' : '인재상';
    return { id:readingId(target, {profile:point.profileId,revision:point.profileRevision,point:point.id}), kind:'reading' as const,
      title:`${profile.department || target.university} · ${label}`, label:point.label, channel:target.university,
      topic:label, keywords:[], source:point.source.url, url:point.source.url, thumbnail:'', verifiedAt:point.source.checkedAt,
      focus:'humanities' as const, stretch:profile.scope === 'department' ? `${target.department}의 가치와 나의 경험·계획 연결하기` : `${target.university}의 가치를 ${target.department}에서 실천하려면`,
      summary:point.description, originLabels:['학교 연결'], targetId:target.id, targetSnapshot:target.snapshot, sourceSnapshot:source,
      relatedQuestionIds:questions.filter(question => question.id === point.practiceQuestionId).map(question=>question.id),
      activities:[], contexts:[{id:`school:${point.profileId}:${point.id}`,kind:'school' as const,title:`${profile.department || target.university} ${label}`,sourceRefIds:[],url:point.source.url,targetId:target.id}], current:true,progress:null };
  }));
  const department=departmentLearningContext(raw);
  const departmentReadings:KnowledgeMatch[]=(department?.topics||[]).map(concept=>{
    const source={kind:'department_learning',summary:concept.summary,url:concept.url,knowledgeVideoId:concept.videoId,officialCurriculum:false};
    return {id:readingId(target,{department:department!.departmentCatalogId,topic:concept.topic,revision:1}),kind:'reading',title:`${target.department} · 개념 한입`,label:concept.topic,channel:'학과 연결 학습',topic:concept.topic,keywords:[],source:concept.url,url:concept.url,thumbnail:'',verifiedAt:'2026-10-17',focus:KNOWLEDGE_CATALOG.find(item=>item.id===concept.videoId)!.focus,stretch:concept.check,summary:concept.summary,originLabels:['학과 연결'],targetId:target.id,targetSnapshot:target.snapshot,sourceSnapshot:source,
      relatedQuestionIds:questions.filter(question=>question.sourceSnapshot?.kind==='department_learning'&&question.sourceSnapshot.knowledgeVideoId===concept.videoId).map(question=>question.id),activities:[],contexts:[{id:`major:${target.id}:${concept.topic}`,kind:'major',title:`${target.department} · ${concept.topic}`,sourceRefIds:[],url:concept.url,targetId:target.id}],current:true,progress:null};
  });
  return [...departmentReadings,...schoolReadings];
}

/** An explicit common-question lens is pedagogical; it is not added to the student's record. */
export function addCommonKnowledgeConnections(videos: KnowledgeMatch[], questions: KnowledgeQuestion[], target: KnowledgeTarget, requested?: string | null): KnowledgeMatch[] {
  const result = videos.map(item=>({...item,relatedQuestionIds:[...(item.relatedQuestionIds || [])]}));
  const common = questions.filter(question=>question.sourceKind==='common' && question.targetId===target.id);
  for(const question of common) {
    const text = `${question.prompt} ${String(question.sourceSnapshot?.summary || '')}`.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    const matches = KNOWLEDGE_CATALOG.filter(video=>question.sourceSnapshot?.knowledgeVideoId===video.id||video.keywords.some(keyword=>keyword.length>3 && text.includes(keyword.replace(/\s+/g,'').toLowerCase())));
    // A requested general question can always practice checking its reasons, with a clear question label.
    const related = matches.length ? matches : question.id===requested ? KNOWLEDGE_CATALOG.filter(video=>video.topic==='근거 검토') : [];
    for(const catalog of related) {
      let item=result.find(video=>video.id===catalog.id);
      if(!item) { item={...catalog,kind:'video',originLabels:['질문 연결'],targetId:target.id,targetSnapshot:target.snapshot,activities:[],contexts:[],current:true,progress:null,relatedQuestionIds:[]};result.push(item); }
      item.relatedQuestionIds!.push(question.id);
      if(!item.originLabels?.includes('질문 연결'))item.originLabels=[...(item.originLabels || []),'질문 연결'];
      if(question.id===requested)item.contexts=[...(item.contexts || []),{id:`question:${question.id}`,kind:'question',title:question.prompt,sourceRefIds:[],targetId:target.id}];
    }
  }
  return result;
}

export function sameKnowledgeTarget(a?: Record<string, unknown> | null, b?: Record<string, unknown> | null) {
  return knowledgeTargetKey(a) === knowledgeTargetKey(b);
}
