type Value=Record<string,any>;

/** A common diagnosis belongs to its frozen common-question revision, not the personal booklet version. */
export function diagnosticReviewScope(context:Value){
  const roots:Value[]=context.questions||[];
  if(!roots.length)return null;
  const common=roots.map(question=>Number(question.common_revision||question.commonRevision||0));
  const isCommon=common.every(version=>Number.isInteger(version)&&version>0);
  if(isCommon&&common.some(version=>version!==common[0]))return null;
  if(!isCommon&&common.some(version=>version>0))return null;
  const version=isCommon?common[0]:Number(context.contentVersion);
  if(!Number.isInteger(version)||version<1)return null;
  return {sourceType:isCommon?'common' as const:'personal' as const,sourceVersion:version,questionIds:[...new Set(roots.map(question=>String(question.id))) ]};
}
