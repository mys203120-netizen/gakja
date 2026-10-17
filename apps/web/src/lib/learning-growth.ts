/** Evidence extraction is deliberately deterministic. It observes words, not correctness or ability. */
import { observedAnswerText } from './transcript-provenance';
export type GrowthVersion={id:string;question_id:string;question?:string;script:string;raw_script?:string|null;transcript_formatting?:unknown;created_at:string;revision_kind?:string;assisted?:boolean;ai_assisted?:boolean;hint_used?:boolean;assistance_recorded?:boolean;session_id?:string;target_id?:string;target_snapshot?:Record<string,any>|null;content_version?:number;source_type?:string;common_revision?:number;practice_kind?:string;required_meanings?:string[];answer_attempt_kind?:string;practice_due_at?:string|null;response_mode?:'text'|'audio'|'video'|'unknown'};
const contextText=(value:unknown)=>typeof value==='string'?value.normalize('NFKC').replace(/\s+/g,'').toLowerCase()||null:null;
const contextNumber=(value:unknown)=>Number.isInteger(Number(value))&&Number(value)>0?Number(value):null;
function growthSourceNamespace(version:GrowthVersion) {
  const commonTypes=new Set(['common','general_practice','book_reference','verified_past']);
  return contextNumber(version.common_revision)||commonTypes.has(contextText(version.source_type)||'')?'common':'personal';
}
function growthSchoolIdentity(version:GrowthVersion) {
  const target=version.target_snapshot||{},reference=contextText(target.school_reference_id);
  return reference?'id:'+reference:'name:'+(contextText(target.university)||'');
}
function growthContextBase(version:GrowthVersion,schoolIdentity=growthSchoolIdentity(version)) {
  const target=version.target_snapshot||{};
  const source=growthSourceNamespace(version);
  // Some quiz snapshots predate catalogue IDs. Their verified names are the same identity as a full target snapshot.
  // A school's reviewed question revision is its source. The unrelated personal guidebook version is not.
  return [version.target_id||null,schoolIdentity,contextText(target.department||target.major)||contextText(target.department_catalog_id),contextText(target.campus),contextNumber(target.admission_year),contextText(target.admission_type),source==='common'?contextNumber(version.common_revision):null,source==='personal'?contextNumber(version.content_version):null,source];
}
export function growthStage(value:unknown):string|null {
  const text=contextText(value);
  if(!text||['unknown','미확인','미정','확인필요'].includes(text))return null;
  const numbered=text.match(/^제?(\d+)(?:단계|차)(?:면접|평가)?$/);
  return numbered?'stage:'+Number(numbered[1]):text;
}
/** A single key keeps missing stages explicit; collection resolution is needed for safe legacy compatibility. */
export function growthContextKey(version:GrowthVersion,resolvedStage?:string|null,resolvedSchool?:string) {
  const stage=resolvedStage===undefined?growthStage(version.target_snapshot?.interview_stage||version.target_snapshot?.stage):resolvedStage;
  return JSON.stringify([...growthContextBase(version,resolvedSchool),stage]);
}
/** An unknown stage can join exactly one known stage, never bridge two distinct stages. Snapshots stay untouched. */
export function growthContextResolver(versions:GrowthVersion[]) {
  // Canonical and campus-labelled university names can share one reviewed ID.
  // Legacy name-only snapshots join an ID only when that same owned target and
  // campus expose one unambiguous identity; they cannot bridge distinct schools.
  const nameScope=(version:GrowthVersion)=>JSON.stringify([version.target_id||null,contextText(version.target_snapshot?.university),contextText(version.target_snapshot?.campus)]);
  const schoolIds=new Map<string,Set<string>>();
  for(const version of versions){
    if(!contextText(version.target_snapshot?.school_reference_id))continue;
    const key=nameScope(version),values=schoolIds.get(key)||new Set<string>();values.add(growthSchoolIdentity(version));schoolIds.set(key,values);
  }
  const school=(version:GrowthVersion)=>{
    if(contextText(version.target_snapshot?.school_reference_id))return growthSchoolIdentity(version);
    const known=schoolIds.get(nameScope(version));return known?.size===1?[...known][0]:growthSchoolIdentity(version);
  };
  const scope=(version:GrowthVersion)=>JSON.stringify([version.question_id,version.practice_kind==='concept'?'concept':'answer',...growthContextBase(version,school(version))]);
  const stages=new Map<string,Set<string>>();
  for(const version of versions){
    const stage=growthStage(version.target_snapshot?.interview_stage||version.target_snapshot?.stage);
    if(!stage)continue;const key=scope(version),values=stages.get(key)||new Set<string>();values.add(stage);stages.set(key,values);
  }
  return (version:GrowthVersion)=>{
    const stage=growthStage(version.target_snapshot?.interview_stage||version.target_snapshot?.stage),known=stages.get(scope(version));
    return growthContextKey(version,stage||known?.size===1&&[...known][0]||null,school(version));
  };
}
function actualRoleEvidence(sentence:string) {
  // First-person opinions and hoped-for/future assignments are not performed roles.
  const clauses=sentence.split(/[,;]|(?:그리고|하지만|다만|앞으로|다음에는|향후|아니라)\s*|(?<=했고|하였고|맡았고|했으며|하였으며|했지만|하였지만|맡았지만)\s*/);
  return clauses.some(clause=>{
    if(/(?:하고\s*싶|해\s*보고\s*싶|할\s*(?:계획|예정|것|거)|하려고|맡을|담당할|했으면|하였으면|했다면|하였다면|한다면|했을\s*(?:것|거)|기여하고자|기억(?:나지|이\s*나지|나지\s*않|하지\s*못)|모르|맡지\s*않|담당하지\s*않|역할.{0,15}(?:확인.{0,5}필요|불확실))/.test(clause))return false;
    if(/(?:친구|팀원|동료|다른\s*학생|선생님|연구원)(?:가|이|은|는)/.test(clause)&&!/(?:제가|저는|내가|나는|제\s*(?:역할|담당))/.test(clause))return false;
    const assigned=/(?:맡았|맡고\s*있|담당(?:했|하였|하고\s*있|합니다)|분담(?:했|하였|하고\s*있)|역할을?\s*(?:수행했|수행하였|맡았|했습니다|하였습니다))/.test(clause);
    const statedRole=/(?:제가|저는|내|제|저의|나의).{0,60}(?:(?:맡은|담당한|수행한)\s*(?:역할|일)(?:은|는)?|(?:역할|담당|업무|몫|기여)(?:은|는|이)).{1,100}(?:이었습니다|였습니다|입니다|이었어요|였어요)/.test(clause);
    const performed=/(?:제가|저는|내가|나는|직접)/.test(clause)&&/(?:준비|세척|정리|설계|조사|분석|측정|실험|비교|관찰|검증|수집|제작|발표|기록|진행|관리|기획|개발|구현|운영|연구|탐구|해결|인터뷰|실행|작성|구성|분류|조정|수행|제안|기여)(?:를\s*)?(?:했|하였|해봤|해\s*보았)/.test(clause);
    return assigned||statedRole||performed;
  });
}
const dimensions=[
  {key:'evidence',label:'근거·수치',pattern:/(?:\d+(?:[.,]\d+)?\s*(?:%|퍼센트|회|번|명|개|시간|분|초|배|도|mg|ml|g|㎎|mL|μm|㎛)|때문|근거|자료에|데이터|관찰|측정)/i},
  {key:'role',label:'내 역할',pattern:/(?:맡|담당|역할|분담|직접|제가|저는|나는|내가)/},
  {key:'process',label:'진행 과정',pattern:/(?:비교|반복|절차|과정|단계|방법|조건|대조군|변인|검증|분석|먼저|다음으로)/},
  {key:'result',label:'결과·한계',pattern:/(?:결과|확인했|확인하|밝혔|나타났|알게|한계|오차|부족|못했|개선|배웠|배운)/},
];
const meaningDimensions=[
  {key:'role',matches:/(?:역할|담당|기여|분담)/,observe:actualRoleEvidence},
  {key:'motivation',matches:/(?:동기|계기|시작한\s*이유|선택한\s*이유)/,observe:(sentence:string)=>/(?:궁금|관심|계기|동기|때문에|알아보|알고\s*싶|문제의식)/.test(sentence)},
  {key:'challenge',matches:/(?:어려|문제\s*해결|극복)/,observe:(sentence:string)=>/(?:어려웠|어려움|문제(?:가|를)|막혔|실패|해결|극복)/.test(sentence)&&!/(?:기억나지|모르|원문에\s*없|확인.{0,5}필요)/.test(sentence)},
  {key:'process',matches:/(?:과정|실제\s*행동|절차|방법|조건|실행)/,observe:(sentence:string)=>dimensions[2].pattern.test(sentence)||/(?:작성|채취|세척|준비|설계|정리|제작|구현|진행|실험)(?:했|하였|를|을|하)/.test(sentence)},
  {key:'result',matches:/(?:결과|한계|오차)/,observe:(sentence:string)=>/(?:결과|확인했|확인하|밝혔|나타났|한계|오차|부족|못했)/.test(sentence)},
  {key:'learning',matches:/(?:배운\s*점|깨달|성찰|느낀\s*점)/,observe:(sentence:string)=>/(?:배웠|배운|깨달|알게\s*(?:되|됐)|느꼈|돌아보|중요하다는)/.test(sentence)},
  {key:'evidence',matches:/(?:근거|수치|자료|출처)/,observe:(sentence:string)=>dimensions[0].pattern.test(sentence)},
  {key:'goal',matches:/(?:목표|계획|진로)/,observe:(sentence:string)=>/(?:목표|계획|진로|배우고\s*싶|연구하고\s*싶|하고자|할\s*예정)/.test(sentence)},
];
/** Reviewed criteria determine what to inspect. A sentence cue is never proof that a criterion is fulfilled. */
export function contentEvidence(text:string,requiredMeanings?:string[]) {
  const sentences=text.split(/(?<=[.!?。]|습니다\.)\s+|\n+/).map(value=>value.trim()).filter(Boolean);
  if(requiredMeanings?.length)return [...new Set(requiredMeanings.map(value=>value.trim()).filter(Boolean))].map((meaning,index)=>{
    const dimension=meaningDimensions.find(value=>value.matches.test(meaning));
    return {key:dimension?.key||'meaning-'+index,label:meaning,evidence:sentences.filter(sentence=>dimension?dimension.observe(sentence):sentence.includes(meaning)).slice(0,3),observationMethod:dimension?'sentence_cue':'literal_phrase'};
  });
  return dimensions.map(dimension=>({key:dimension.key,label:dimension.label,evidence:sentences.filter(sentence=>dimension.pattern.test(sentence)&&(dimension.key!=='role'||actualRoleEvidence(sentence))).slice(0,3)}));
}
/** Elapsed time is a display category, not evidence of delayed memory or ability. */
export function answerComparisonContext(before:GrowthVersion,after:GrowthVersion) {
  const elapsedMs=new Date(after.created_at).getTime()-new Date(before.created_at).getTime();
  const correction=after.revision_kind==='transcript_correction';
  const editing=after.revision_kind==='answer_edit'||after.answer_attempt_kind==='content_edit';
  const rerecorded=after.answer_attempt_kind==='rerecord'||after.revision_kind==='rerecord';
  const speech=after.revision_kind==='quiz_oral'||after.revision_kind==='interview_answer';
  const kind=correction?'transcript_correction':editing?'content_edit':rerecorded?'rerecord':speech?'new_answer':'written_answer';
  const interval=!Number.isFinite(elapsedMs)||elapsedMs<0?'unknown':correction||editing?'editing':elapsedMs<=60*60*1000?'immediate':elapsedMs<24*60*60*1000?'within_day':'elapsed';
  const due=after.practice_due_at?new Date(after.practice_due_at).getTime():NaN;
  const scheduledRecall=kind!=='transcript_correction'&&kind!=='content_edit'&&Number.isFinite(due)&&new Date(after.created_at).getTime()>=due;
  const help=after.assisted||after.hint_used||after.ai_assisted?'used':after.assistance_recorded===true?'none':'unknown';
  const mode=after.response_mode||(['answer_edit','quiz_answer','assignment_answer','news_thought'].includes(after.revision_kind||'')?'text':'unknown');
  return {kind,interval,elapsedMs:Number.isFinite(elapsedMs)&&elapsedMs>=0?elapsedMs:null,scheduledRecall,help,sourceChanged:growthSourceNamespace(after)==='personal'&&before.content_version!==after.content_version&&!!before.content_version&&!!after.content_version,
    mode,modeLabel:mode==='text'?'입력한 답변':mode==='audio'?'음성으로 남긴 답변':mode==='video'?'영상으로 남긴 답변':'답변 방식 미확인',
    label:correction?'전사 정정':editing?'작성 내용 수정':rerecorded?'다시 녹음':interval==='immediate'?'바로 재답변':interval==='within_day'?'하루 안의 재답변':interval==='elapsed'?'시간이 지난 재답변':'재답변 간격 미확인',
    helpLabel:help==='used'?'도움 사용':help==='none'?'도움 조회 기록 없음':'도움 여부 미기록',
    note:correction?'같은 발화의 인식 오류를 바로잡은 기록이에요.':editing?'작성 내용을 바꾼 기록이에요. 자료를 덮고 다시 답한 시도와 구분해요.':scheduledRecall?'복습 예정 시점 이후 남긴 답변이에요. 실제 문장과 도움 사용을 함께 확인해요.':interval==='elapsed'?'시간이 지난 뒤 남긴 답변이에요. 자료를 덮고 회상했는지는 별도로 확인해요.':interval==='unknown'?'두 답변의 시간 간격을 확인할 수 없어요.':'24시간 안에 다시 남긴 답변이에요. 이후 회상과 구분해요.'};
}
export function growthNextReason(version:GrowthVersion,comparison?:ReturnType<typeof compareAnswerGrowth>) {
  const elements=comparison?.elements||[],prompt=version.question||comparison?.prompt||'';
  // The approved list remains intact. Only the suggestion order follows an explicit question request.
  const requested=elements.filter(element=>meaningDimensions.find(dimension=>dimension.key===element.key)?.matches.test(prompt)||prompt.includes(element.label));
  const unchecked=(requested.length?requested:elements).find(element=>!element.afterEvidence.length);
  if(comparison?.criterionBasis==='reviewed_meanings'&&unchecked)return '이번 질문의 “'+unchecked.label+'” 부분을 내 문장으로 설명했는지 확인해 보세요.';
  return version.assisted||version.hint_used||version.ai_assisted?'자료를 덮고 같은 질문에 새 답변을 남겨 보세요.':'같은 질문에 새 답변을 남기고 실제 문장으로 비교해 보세요.';
}
export function compareAnswerGrowth(before:GrowthVersion,after:GrowthVersion) {
  if(before.question_id!==after.question_id)throw new Error('Only the same question can be compared.');
  const context=growthContextResolver([before,after]);
  if(context(before)!==context(after))throw new Error('Only the same practice context can be compared.');
  const requiredMeanings=Array.isArray(after.required_meanings)?after.required_meanings:before.required_meanings;
  const beforeObserved=observedAnswerText(before),afterObserved=observedAnswerText(after);
  const previous=contentEvidence(beforeObserved,requiredMeanings),current=contentEvidence(afterObserved,requiredMeanings);
  const elements=current.map((element,index)=>({key:element.key,label:element.label,beforeEvidence:previous[index].evidence,afterEvidence:element.evidence,
    change:!previous[index].evidence.length&&element.evidence.length?'added':previous[index].evidence.length&&!element.evidence.length?'not_found':JSON.stringify(previous[index].evidence)!==JSON.stringify(element.evidence)?'changed':'same'}));
  const beforeCompact=beforeObserved.replace(/\s+/g,''),sentences=afterObserved.split(/(?<=[.!?。])\s+|\n+/).map(value=>value.trim()).filter(Boolean);
  const addedDetails=sentences.filter(sentence=>!beforeCompact.includes(sentence.replace(/\s+/g,''))&&/\d|제가|저는|직접|조건|비교|결과|한계|오차|맡/.test(sentence)).slice(0,4);
  return {questionId:after.question_id,prompt:after.question||before.question||'나의 답변',before,after,elements,addedDetails,attempt:answerComparisonContext(before,after),criterionBasis:requiredMeanings?.length?'reviewed_meanings':'general_observations',
    addedElements:elements.filter(element=>element.change==='added').map(element=>element.label),
    missingElements:requiredMeanings?.length?elements.filter(element=>!element.afterEvidence.length).map(element=>element.label):[],method:'quoted-sentence-cues',
    note:requiredMeanings?.length?'이번 질문의 검수된 요소와 실제 문장을 나란히 확인해요. 표현 미확인이 내용 누락이나 오답을 뜻하지는 않아요.':'질문별 검수 요소가 없는 기록은 일반적인 표현만 보여요. 문장 길이나 표현 변화로 실력 향상을 판정하지 않아요.'};
}
export function buildContentGrowth(versions:GrowthVersion[]) {
  const groups=new Map<string,GrowthVersion[]>();
  const context=growthContextResolver(versions);
  for(const version of versions) {
    // Correcting STT spelling is the same utterance, not a new practice or skill improvement.
    if(!version.script?.trim()||version.revision_kind==='transcript_correction')continue;
    const key=version.question_id+'|'+(version.practice_kind==='concept'?'concept':'answer')+'|'+context(version);
    const group=groups.get(key)||[];group.push(version);groups.set(key,group);
  }
  const comparisons=[];
  const unpaired=[];
  for(const group of groups.values()) {
    group.sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime());
    const seen=new Set<string>();
    const distinct=group.filter((version,index)=>{
      if(seen.has(version.id))return false;seen.add(version.id);
      // Saving an unchanged draft is not another attempt. A real new answer can be identical after a delay.
      return !index||version.script.trim()!==group[index-1].script.trim()||version.revision_kind!=='answer_edit'||group[index-1].revision_kind!=='answer_edit';
    });
    if(distinct.length>=2)comparisons.push(compareAnswerGrowth(distinct[0],distinct.at(-1)!));
    else if(distinct.length===1)unpaired.push({questionId:distinct[0].question_id,prompt:distinct[0].question||'나의 답변',version:distinct[0]});
  }
  return {comparisons:comparisons.sort((a,b)=>new Date(b.after.created_at).getTime()-new Date(a.after.created_at).getTime()),
    unpaired:unpaired.slice(0,5)};
}
