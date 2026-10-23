import type {CSSProperties} from 'react';
import styles from './learning-charts.module.css';

/** Charts always expose the same counts as text; zero never means unmeasured ability. */
export function ProgressRing({completed,total,label}:{completed:number;total:number;label:string}) {
  const safeTotal=Math.max(0,total),safeCompleted=Math.max(0,Math.min(completed,safeTotal));
  const percentage=safeTotal?Math.round(safeCompleted/safeTotal*100):0;
  return <div className={styles.ringGroup}>
    <div className={styles.ring} style={{'--progress':`${percentage}%`} as CSSProperties} aria-hidden="true"><div><strong>{safeTotal?<>{percentage}<small>%</small></>:'—'}</strong></div></div>
    <p className={styles.ringLabel}>{label}<strong>{safeTotal?`${safeCompleted} / ${safeTotal}개`:'등록된 계획 없음'}</strong></p>
  </div>;
}

export function LearningDistribution({rows}:{rows:Array<{label:string;value:number;tone?:'green'|'sage'|'mint'}>}) {
  const total=rows.reduce((sum,row)=>sum+Math.max(0,row.value),0);
  return <div className={styles.distribution}>
    <div className={styles.stack} aria-hidden="true">{total?rows.map((row,index)=>({...row,tone:row.tone||(['green','sage','mint'] as const)[index%3]})).filter(row=>row.value>0).map((row,index)=><span key={row.label} data-tone={row.tone||['green','sage','mint'][index%3]} style={{flex:row.value}}/>):<span data-empty="true"/>}</div>
    <ul>{rows.map((row,index)=><li key={row.label}><span className={styles.dot} data-tone={row.tone||['green','sage','mint'][index%3]} aria-hidden="true"/><span>{row.label}</span><strong>{row.value}<small>개</small></strong></li>)}</ul>
  </div>;
}

export function ActivityBars({rows,label}:{rows:Array<{label:string;value:number;current?:boolean}>;label:string}) {
  const maximum=Math.max(1,...rows.map(row=>row.value));
  return <div className={styles.activity} role="group" aria-label={label}>
    <div className={styles.bars}>{rows.map((row,index)=><div className={styles.column} key={`${row.label}-${index}`}><span className={styles.barValue}>{row.value||''}</span><span className={styles.track}><span data-current={row.current||undefined} style={{height:row.value?`${Math.max(8,row.value/maximum*100)}%`:'0%'}}/></span><span className={styles.barLabel} data-current={row.current||undefined}>{row.label}</span><span className={styles.srOnly}>{row.value}회 완료</span></div>)}</div>
  </div>;
}

export function SpeechHistoryChart({rows}:{rows:Array<{label:string;value:number}>}) {
  const points=rows.filter(row=>Number.isFinite(row.value)&&row.value>=0&&row.value<=100).slice(-8);
  if(points.length<2)return null;
  const locations=points.map((row,index)=>({x:24+index/(points.length-1)*552,y:116-row.value*.94}));
  const path=locations.map((point,index)=>`${index?'L':'M'}${point.x},${point.y}`).join(' ');
  const area=`${path} L${locations.at(-1)!.x},116 L24,116 Z`;
  return <figure className={styles.history}><figcaption>같은 질문의 음성 공백 변화<small>녹음별 공백 비율 · 낮을수록 좋다는 뜻은 아니에요.</small></figcaption><svg viewBox="0 0 600 144" role="img" aria-label={points.map(row=>`${row.label} ${row.value}%`).join(', ')}>
    {[22,69,116].map(y=><line key={y} x1="24" x2="576" y1={y} y2={y} stroke="#dfe9e2" strokeDasharray="4 6"/>)}
    <path d={area} fill="#e1f8eb"/><path d={path} fill="none" stroke="#00b65e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
    {locations.map((point,index)=><g key={index}><circle cx={point.x} cy={point.y} r="5" fill="#00d873" stroke="white" strokeWidth="2"/><text x={point.x} y="138" textAnchor="middle" fill="#617169" fontSize="12">{index+1}회</text></g>)}
  </svg><div className={styles.historyValues}><span>첫 기록 <strong>{points[0].value}%</strong></span><span>최근 기록 <strong>{points.at(-1)!.value}%</strong></span></div></figure>;
}
