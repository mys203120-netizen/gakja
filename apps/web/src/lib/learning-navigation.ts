/** Preserve the owned school and source version when retrying a saved answer. */
export function learningRetryHref(questionId:string,version:Record<string,any>) {
  const card=version.experience_card||version.experienceCard;
  const carryExperience=(params:URLSearchParams)=>{
    if(card?.id&&Number.isInteger(card.revision)&&card.revision>0){params.set('experienceCardId',card.id);params.set('experienceRevision',String(card.revision));}
  };
  if(version.practice_kind==='concept'&&questionId.startsWith('concept:')) return '/quiz?memoryItemId='+encodeURIComponent(version.memory_item_id||questionId.slice(8))+'&mode=answer';
  // Briefing turns have a generated identity, not a personal-package question ID.
  // Keep only the exact IDs produced by /api/interviews (indices 0 through 10).
  const briefing=questionId.match(/^briefing_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_(0|[1-9]|10)$/i);
  if(briefing){
    const params=new URLSearchParams({briefingId:briefing[1],briefingQuestionIndex:briefing[2]});
    carryExperience(params);
    if(version.target_id)params.set('targetId',String(version.target_id));
    if(version.content_version&&version.source_kind!=='common'&&version.source_type!=='common')params.set('sourceVersion',String(version.content_version));
    return '/interview/new?'+params.toString();
  }
  const common=version.source_kind==='common'||(version.source_type&&version.source_type!=='personal')||questionId.startsWith('common_')||questionId.startsWith('bible_');
  const params=new URLSearchParams({questionId});
  carryExperience(params);
  if(version.target_id)params.set('targetId',String(version.target_id));
  if(common){params.set('sourceType','common');if(version.common_revision)params.set('sourceVersion',String(version.common_revision));}
  else if(version.content_version){params.set('sourceType','personal');params.set('sourceVersion',String(version.content_version));}
  return '/interview/new?'+params.toString();
}
