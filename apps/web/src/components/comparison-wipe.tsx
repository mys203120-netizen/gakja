'use client';
import {ownedClassName} from './owned-class-name';


import { useId, useMemo, useState, type CSSProperties } from 'react';
import { addedAnswerText } from '@/lib/answer-diff';

export function ComparisonWipe({ previous, current, previousLabel, currentLabel }: {
  previous: string;
  current: string;
  previousLabel: string;
  currentLabel: string;
}) {
  const [reveal, setReveal] = useState(50);
  const id = useId();
  const parts = useMemo(() => addedAnswerText(previous, current), [previous, current]);
  return <section className={ownedClassName("comparison-wipe",true)} aria-label="두 답변 겹쳐 보기">
    <div className={ownedClassName("comparison-wipe-legend",true)}><span className={ownedClassName(undefined,true)}>먼저 볼 답변</span><span className={ownedClassName(undefined,true)}><i aria-hidden="true" className={ownedClassName(undefined,true)} />함께 볼 답변</span></div>
    <div className={ownedClassName("comparison-wipe-stage",true)} aria-hidden="true" style={{ '--answer-reveal': `${reveal}%` } as CSSProperties}>
      <p className={ownedClassName("comparison-wipe-layer comparison-wipe-before",true)}>{previous}</p>
      <p className={ownedClassName("comparison-wipe-layer comparison-wipe-after",true)}>{parts.map((part, index) => part.added ? <mark key={index} className={ownedClassName(undefined,true)}>{part.text}</mark> : <span key={index} className={ownedClassName(undefined,true)}>{part.text}</span>)}</p>
      <span className={ownedClassName("comparison-wipe-divider",true)} style={{ visibility: reveal === 0 || reveal === 100 ? 'hidden' : 'visible' }}><span className={ownedClassName(undefined,true)}>↔</span></span>
    </div>
    <div className={ownedClassName("comparison-wipe-controls",true)}>
      <label htmlFor={id} className={ownedClassName(undefined,true)}>함께 볼 답변 표시</label><output htmlFor={id} aria-hidden="true" className={ownedClassName(undefined,true)}>{reveal}%</output>
      <input id={id} type="range" min="0" max="100" step="1" value={reveal} aria-describedby={`${id}-note`} aria-valuetext={`함께 볼 답변 ${reveal}%, 먼저 볼 답변 ${100 - reveal}%`} onChange={event => setReveal(Number(event.target.value))} className={ownedClassName(undefined,true)} />
      <div className={ownedClassName("comparison-wipe-endpoints",true)} aria-hidden="true"><span className={ownedClassName(undefined,true)}>먼저 볼 답변</span><span className={ownedClassName(undefined,true)}>함께 볼 답변</span></div>
    </div>
    <p id={`${id}-note`} className={ownedClassName("comparison-wipe-note",true)}>초록색은 새로 추가되거나 달라진 문구예요.</p>
    <details className={ownedClassName("comparison-wipe-full",true)}><summary className={ownedClassName(undefined,true)}>두 답변 전문 보기</summary><div className={ownedClassName("comparison-wipe-transcripts",true)}><section className={ownedClassName(undefined,true)}><h3 className={ownedClassName(undefined,true)}>먼저 볼 답변 · {previousLabel}</h3><p className={ownedClassName(undefined,true)}>{previous}</p></section><section className={ownedClassName(undefined,true)}><h3 className={ownedClassName(undefined,true)}>함께 볼 답변 · {currentLabel}</h3><p className={ownedClassName(undefined,true)}>{current}</p></section></div></details>
  </section>;
}
