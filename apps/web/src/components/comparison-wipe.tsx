'use client';

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
  return <section className="comparison-wipe" aria-label="두 답변 겹쳐 보기">
    <div className="comparison-wipe-legend"><span>먼저 볼 답변</span><span><i aria-hidden="true" />함께 볼 답변</span></div>
    <div className="comparison-wipe-stage" aria-hidden="true" style={{ '--answer-reveal': `${reveal}%` } as CSSProperties}>
      <p className="comparison-wipe-layer comparison-wipe-before">{previous}</p>
      <p className="comparison-wipe-layer comparison-wipe-after">{parts.map((part, index) => part.added ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</p>
      <span className="comparison-wipe-divider" style={{ visibility: reveal === 0 || reveal === 100 ? 'hidden' : 'visible' }}><span>↔</span></span>
    </div>
    <div className="comparison-wipe-controls">
      <label htmlFor={id}>함께 볼 답변 표시</label><output htmlFor={id} aria-hidden="true">{reveal}%</output>
      <input id={id} type="range" min="0" max="100" step="1" value={reveal} aria-describedby={`${id}-note`} aria-valuetext={`함께 볼 답변 ${reveal}%, 먼저 볼 답변 ${100 - reveal}%`} onChange={event => setReveal(Number(event.target.value))} />
      <div className="comparison-wipe-endpoints" aria-hidden="true"><span>먼저 볼 답변</span><span>함께 볼 답변</span></div>
    </div>
    <p id={`${id}-note`} className="comparison-wipe-note">초록색은 새로 추가되거나 달라진 문구예요.</p>
    <details className="comparison-wipe-full"><summary>두 답변 전문 보기</summary><div className="comparison-wipe-transcripts"><section><h3>먼저 볼 답변 · {previousLabel}</h3><p>{previous}</p></section><section><h3>함께 볼 답변 · {currentLabel}</h3><p>{current}</p></section></div></details>
  </section>;
}
