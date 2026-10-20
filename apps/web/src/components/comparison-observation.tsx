
import {ownedClassName} from './owned-class-name';
import { answerComparisonContext,compareAnswerGrowth,type GrowthVersion } from '@/lib/learning-growth';

function withMeanings(value:GrowthVersion&{comparison?:{required_meanings?:Array<string|{text:string}>}}):GrowthVersion {
  return {...value,required_meanings:value.required_meanings||value.comparison?.required_meanings?.map(meaning=>typeof meaning==='string'?meaning:meaning.text).filter(Boolean)};
}
/** The comparison exposes saved evidence; it never turns a local checkbox into verified mastery. */
export function ComparisonObservation({before,after}:{before:GrowthVersion;after:GrowthVersion}) {
  const attempt=answerComparisonContext(before,after);
  const comparison=compareAnswerGrowth(withMeanings(before),withMeanings(after));
  return <section className={ownedClassName("comparison-observation",true)} aria-label="답변을 남긴 조건과 문장 근거">
    <div className={ownedClassName("comparison-evidence",true)}><span className={ownedClassName(undefined,true)}>{attempt.label}</span><span className={ownedClassName(undefined,true)}>{attempt.modeLabel}</span><span className={ownedClassName(undefined,true)}>{attempt.helpLabel}</span>{attempt.scheduledRecall&&<span className={ownedClassName(undefined,true)}>복습 예정 시점 이후</span>}{attempt.sourceChanged&&<span className={ownedClassName(undefined,true)}>교재 기준 변경</span>}</div>
    <p className={ownedClassName("comparison-notice",true)}>{attempt.note}</p>
    {comparison.criterionBasis==='reviewed_meanings'&&<details className={ownedClassName("content-growth-evidence",true)}><summary className={ownedClassName(undefined,true)}>이번 질문의 요소와 실제 문장</summary>{comparison.elements.map((element,index)=><div className={ownedClassName("content-growth-evidence-row",true)} key={element.key+':'+index}><h4 className={ownedClassName(undefined,true)}>{element.label}</h4><blockquote className={ownedClassName(undefined,true)}>{element.afterEvidence.join(' ')||'자동으로 찾은 문장이 없어요. 실제 답변에서 직접 확인해 보세요.'}</blockquote></div>)}<p className={ownedClassName("speech-caption",true)}>{comparison.note}</p></details>}
  </section>;
}
