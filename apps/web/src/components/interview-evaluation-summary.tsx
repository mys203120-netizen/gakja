import styles from './interview-evaluation-summary.module.css';

type Criterion={id:string;label:string;score:number|null;reason:string;evidence?:string[]};
type Evaluation={rubric?:{version:string;total:number|null;max:number;assessedCount:number;criteria:Criterion[]};compositionExample?:{title:string;parts:{kind:string;label:string;text:string;sourceId?:string}[];note:string}|null};

export function InterviewEvaluationSummary({evaluation}:{evaluation:Evaluation}) {
  const rubric=evaluation?.rubric;if(!rubric?.criteria?.length)return null;
  const complete=rubric.total!==null&&rubric.assessedCount===rubric.criteria.length;
  const example=evaluation.compositionExample;
  return <section className={styles.summary} aria-label="답변 요소 평가"><header><div><h4>답변 요소 확인</h4><p>질문과 내 발화의 근거를 기준으로 확인했어요.</p></div><strong>{complete?<>{rubric.total}<small> / {rubric.max}</small></>:'판단 보류'}</strong></header><details><summary>기준별 확인 결과</summary><ul>{rubric.criteria.map(item=><li key={item.id}><div><strong>{item.label}</strong><span data-level={item.score===null?'unknown':item.score}>{item.score===null?'판단 보류':item.score===2?'명확히 확인':item.score===1?'부분 확인':'보완 필요'}</span></div><p>{item.reason}</p>{Boolean(item.evidence?.length)&&<blockquote>{item.evidence!.join(' ')}</blockquote>}</li>)}</ul></details>{example?.parts?.length&&<details><summary>{example.title}</summary>{example.parts.map((part,index)=><div className={styles.examplePart} key={index}><strong>{part.label}</strong><p>{part.text}</p></div>)}<p className={styles.notice}>{example.note}</p></details>}<p className={styles.notice}>면접 연습을 위한 요소 확인 점수예요.</p></section>;
}
