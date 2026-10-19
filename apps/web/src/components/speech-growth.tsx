'use client';
import Link from 'next/link';
import { useCallback,useEffect,useRef,useState } from 'react';
import { ArrowUpRight,Mic,RefreshCw,Volume2 } from 'lucide-react';
import { api,post,Alert,Spinner,dateLabel,InfoTip,type Item } from './shared';
import { decodeRecordingTelemetry } from '@/lib/client/speech-recorder';
import { studyAnswerComparisonHref } from '@/lib/study-record-links';
import { SchoolPicker } from './school-picker';

type CurrentPracticeContext={targetId:string;contentVersion:number;questions:Item[];targets:Item[]};
/** The overall report resumes current learning; a frozen detail remains at its saved source. */
export function resolveGrowthNext(next:Item|undefined,context?:CurrentPracticeContext,pinned=false):Item|undefined {
  if(!next||pinned||!context||!next.questionId||!String(next.href).startsWith('/interview/new?'))return next;
  // News and school common practice have their own article/school snapshot, retained verbatim.
  if(/^(?:briefing_|bible_|common_)/.test(next.questionId)||String(next.href).includes('briefingId='))return next;
  if(!context.targets.some(target=>target.id===context.targetId)||!Number.isInteger(context.contentVersion)||context.contentVersion<1)return next;
  const question=context.questions.find(item=>item.id===next.questionId);
  if(!question||question.source_type&&question.source_type!=='personal')return next;
  const eligible=Array.isArray(question.support_target_ids)?question.support_target_ids:[];
  if(eligible.length&&!eligible.includes(context.targetId))return next;
  const params=new URLSearchParams(String(next.href).split('?')[1]);params.set('questionId',next.questionId);params.set('targetId',context.targetId);params.set('sourceType','personal');params.set('sourceVersion',String(context.contentVersion));
  return {...next,prompt:question.prompt||next.prompt,href:'/interview/new?'+params.toString()};
}
export function contentCueLabel(element:Item):string {
  if(element.change==='added')return '새 문장';
  if(element.change==='changed')return '표현 변화';
  if(element.change==='not_found')return '최근 표현 미확인';
  return element.afterEvidence?.length?'표현 확인':'문장 확인 필요';
}
export function comparisonAttemptLabels(comparison:Item):string[] {
  if(!comparison.attempt)return comparison.after?.assisted||comparison.after?.hint_used?['도움 사용']:['도움 여부 미기록'];
  return [comparison.attempt.label,...(comparison.attempt.modeLabel?[comparison.attempt.modeLabel]:[]),comparison.attempt.helpLabel,...(comparison.attempt.scheduledRecall?['복습 예정 시점 이후']:[]),...(comparison.attempt.sourceChanged?['교재 기준 변경']:[])];
}
export function SpeechGrowth({reportId,studySessionId,currentContext}:{reportId?:string;studySessionId?:string;currentContext?:CurrentPracticeContext}) {
  const [info,setInfo]=useState<Item|null>(null),[loadedScope,setLoadedScope]=useState(''),[error,setError]=useState(''),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false);
  const [transcribing,setTranscribing]=useState(false);
  const audio=useRef<HTMLAudioElement>(null);
  const targetScope=reportId||studySessionId?'':currentContext?.targetId||'';
  const scope=JSON.stringify([reportId||'',studySessionId||'',targetScope]),activeScope=useRef(scope),requestEpoch=useRef(0),mounted=useRef(true),controller=useRef<AbortController|null>(null);
  activeScope.current=scope;
  const reload=useCallback(async()=>{
    const key=JSON.stringify([reportId||'',studySessionId||'',targetScope]),epoch=++requestEpoch.current;
    controller.current?.abort();const abort=new AbortController();controller.current=abort;
    try{const params=new URLSearchParams();if(targetScope)params.set('targetId',targetScope);if(reportId)params.set('reportId',reportId);if(studySessionId)params.set('studySessionId',studySessionId);const next=await api('/api/reports'+(params.size?'?'+params:''),{cache:'no-store',signal:abort.signal});if(mounted.current&&activeScope.current===key&&requestEpoch.current===epoch){setInfo(next);setLoadedScope(key);setError('');}}
    catch(err){if(!abort.signal.aborted&&mounted.current&&activeScope.current===key&&requestEpoch.current===epoch)setError((err as Error).message);}
  },[reportId,studySessionId,targetScope]);
  useEffect(()=>{mounted.current=true;setInfo(null);setSelected('');setError('');void reload();const update=()=>{if(document.visibilityState==='visible')void reload();};window.addEventListener('focus',update);window.addEventListener('gakja:report-growth',update);return()=>{mounted.current=false;requestEpoch.current++;controller.current?.abort();window.removeEventListener('focus',update);window.removeEventListener('gakja:report-growth',update);};},[reload]);
  const visibleInfo=loadedScope===scope?info:null;
  const recordings:Item[]=visibleInfo?.speech?.recordings||[],current=recordings.find(recording=>recording.id===selected)||recordings.find(recording=>recording.id===visibleInfo?.speech?.defaultRecordingId&&recording.growthEligible!==false)||recordings.find(recording=>recording.growthEligible!==false)||recordings[0],analysis=current?.analysis,timing=analysis?.timing,transcript=analysis?.transcript;
  async function reanalyze(){
    if(!current||busy)return;setBusy(true);setError('');
    try{let telemetry;
      if(!timing&&current.analysisAudioUrl){const response=await fetch(current.analysisAudioUrl,{credentials:'same-origin'});if(!response.ok)throw new Error('녹음 음성을 가져오지 못했어요.');telemetry=await decodeRecordingTelemetry(await response.blob());if(!telemetry)throw new Error('이 브라우저에서 녹음 음성을 읽지 못했어요.');}
      await post('/api/reports',{action:'analyze',recordingId:current.id,kind:current.kind,...(telemetry?{speechTelemetry:telemetry}:{})});await reload();window.dispatchEvent(new Event('gakja:report-growth'));
    }catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  async function transcribe(){
    if(!current||busy)return;setBusy(true);setTranscribing(true);setError('');
    try{const result=await post(current.kind==='interview'?'/api/media':'/api/reports',current.kind==='interview'?{action:'transcribe',mediaId:current.id}:{action:'transcribe',recordingId:current.id,kind:'quiz'});await reload();window.dispatchEvent(new Event('gakja:report-growth'));if(result.cleanupStatus!=='completed')setError(result.cleanupError||result.transcriptionError||'원전사는 보관했어요. 문장 정리를 다시 시도해 주세요.');}
    catch(err){setError((err as Error).message);}finally{setBusy(false);setTranscribing(false);}
  }
  function seek(ms:number){if(audio.current){audio.current.currentTime=Math.max(0,ms/1000-.3);void audio.current.play().catch(()=>{});}}
  if(!visibleInfo&&!error)return <Spinner/>;
  const trend=visibleInfo?.speech?.trend,comparisons:Item[]=visibleInfo?.content?.comparisons||[];
  const next=resolveGrowthNext(visibleInfo?.next,currentContext,Boolean(reportId||studySessionId));
  return <div className="speech-growth-view">
    {error&&<Alert>{error}</Alert>}
    {next&&<div className="speech-next"><div><span>다음 연습</span><h3>{next.prompt}</h3><p>{next.reason}</p></div><Link className="button primary" href={next.href}>{next.questionId?'다시 말하기':recordings.length?'녹음 시작':'첫 녹음 시작'}<ArrowUpRight size={17}/></Link></div>}

    {(comparisons.length>0||!visibleInfo?.content?.newsComparisons?.length)&&<section className="speech-growth-section content-growth"><div className="section-heading"><h2>답변 내용의 변화<InfoTip label="답변 변화와 도움 기록 안내"><p>작성한 답변, Q&amp;A, 면접 답변을 같은 질문끼리 연결해 실제 문장의 변화를 확인해요.</p><p>도움 사용 여부는 연습 조건이에요. 답변 길이나 도움 사용만으로 실력 향상을 판단하지 않아요.</p></InfoTip></h2><Link href="/records/comparisons" className="text-link">전체 답변 비교<ArrowUpRight size={16}/></Link></div>
      {comparisons.length?comparisons.slice(0,1).map(comparison=><article className="content-growth-question" key={comparison.questionId+'|'+comparison.after.id}><h3>{comparison.prompt}</h3><div className="content-growth-dates"><span>{dateLabel(comparison.before.created_at)}</span><ArrowUpRight size={14}/><span>{dateLabel(comparison.after.created_at)}</span>{comparisonAttemptLabels(comparison).map(label=><span key={label}>{label}</span>)}{comparison.attempt?.note&&<InfoTip label="이 답변의 연습 조건">{comparison.attempt.note}</InfoTip>}</div>
        <div className="content-growth-cues" aria-label={comparison.criterionBasis==='reviewed_meanings'?'이번 질문의 검수된 요소':'일반 표현 관찰'}>{comparison.elements.map((element:Item,index:number)=><span key={element.key+':'+index} className={element.change==='added'?'added':''}>{element.label}<small>{contentCueLabel(element)}</small></span>)}</div>
        <details className="content-growth-evidence"><summary>실제 문장으로 확인</summary>{comparison.elements.filter((element:Item)=>comparison.criterionBasis==='reviewed_meanings'||element.beforeEvidence.length||element.afterEvidence.length).map((element:Item,index:number)=><div className="content-growth-evidence-row" key={element.key+':'+index}><h4>{element.label}</h4><div><span>이전</span><blockquote>{element.beforeEvidence.join(' ')||'표현 미확인'}</blockquote></div><div><span>최근</span><blockquote>{element.afterEvidence.join(' ')||'표현 미확인'}</blockquote></div></div>)}<div className="content-growth-originals"><div><h4>이전 답변 전체</h4><p>{comparison.before.script}</p></div><div><h4>최근 답변 전체</h4><p>{comparison.after.script}</p></div></div><p className="speech-caption">{comparison.note}</p></details>
        {!!comparison.addedDetails.length&&<div className="content-growth-added"><span>달라진 문장</span><p>{comparison.addedDetails[0]}</p></div>}
        <Link className="text-link" href={studyAnswerComparisonHref(comparison.questionId,comparison.after,comparison.after.turn_id)}>이 질문의 답변 비교<ArrowUpRight size={16}/></Link>
      </article>):<div className="content-growth-empty"><h3>같은 질문의 다음 답변을 기다리고 있어요</h3></div>}
    </section>}
    {!!visibleInfo?.content?.newsComparisons?.length&&<section className="speech-growth-section content-growth"><div className="section-heading"><h2>기사에서 면접 답변으로</h2></div>{visibleInfo.content.newsComparisons.slice(0,2).map((comparison:Item)=><article key={comparison.articleId} className="content-growth-question"><h3>{comparison.prompt}</h3><div className="content-growth-dates"><span>기사에서 남긴 생각</span><ArrowUpRight size={14}/><span>면접에서 말한 답변</span>{comparison.after.assisted&&<span>도움 사용</span>}</div><div className="content-growth-cues">{comparison.elements.filter((element:Item)=>element.change!=='same').map((element:Item)=><span key={element.key}>{element.label}<small>{contentCueLabel(element)}</small></span>)}</div><details className="content-growth-evidence"><summary>내 생각과 실제 답변 확인</summary><div className="content-growth-originals"><div><h4>기사에서 남긴 생각 · {dateLabel(comparison.before.created_at)}</h4><p>{comparison.before.script}</p></div><div><h4>면접 답변 · {dateLabel(comparison.after.created_at)}</h4><p>{comparison.after.script}</p></div></div><p className="speech-caption">{comparison.note}</p></details><div className="inline-actions"><Link className="text-link" href={comparison.sourceHref}>기사와 내 생각<ArrowUpRight size={16}/></Link><Link className="text-link" href={comparison.retryHref}>같은 기사 다시 말하기<ArrowUpRight size={16}/></Link></div></article>)}</section>}
    <section className="speech-growth-section" aria-label="음성 관찰">{!!recordings.length&&<div className="section-heading"><h2>나의 말하기</h2>{current&&<span className="muted">{dateLabel(current.createdAt)}</span>}</div>}
      {!recordings.length?<div className="speech-empty"><Mic size={17}/><p>녹음 기록이 없어요. 쉼·습관어는 녹음 후 확인할 수 있어요.</p><Link className="text-link" href="/quiz?mode=oral">녹음 답변<ArrowUpRight size={15}/></Link></div>:<>
        <div className="speech-recording-select"><SchoolPicker label="분석할 답변" value={current?.id||''} onChange={setSelected} placeholder="녹음 답변 선택" searchPlaceholder="질문·연습 유형 검색" choices={recordings.map(recording=>({id:recording.id,label:recording.prompt,detail:dateLabel(recording.createdAt)+' · '+(recording.kind==='interview'?'모의면접':'퀴즈')+(recording.growthEligible===false?' · 말소리 미확인 · 비교 제외':'')}))}/></div>
        <h3 className="speech-question">{current.prompt}</h3>
        {current.growthEligible===false?<p className="speech-measurement-empty" role="status">말소리가 확인되지 않은 녹음이에요. 말하기 변화 비교에는 포함하지 않아요. 마이크를 확인해 다시 녹음하거나 직접 입력해 주세요.</p>:timing?<><div className="speech-metrics">
          <SpeechMetric label="긴 쉼" value={timing.longPauseCount+'회'} note="답변 중 1.5초 이상"/>
          <SpeechMetric label="음성 공백" value={Math.round(timing.silenceRatio*100)+'%'} note={timing.reliable?'관찰한 녹음 시간 기준':'부분 기록 · 관찰 구간 기준'}/>
          <SpeechMetric label="확인한 습관어" value={transcript?transcript.fillerCount+'회':'—'} note={transcript?'원전사에서 확인':'원전사 미완료'}/>
          <SpeechMetric label="말하기 속도" value={transcript?.eojeolPerMinute!=null?transcript.eojeolPerMinute+'':'—'} note={transcript?.eojeolPerMinute!=null?'어절/분 · 전체 답변 시간 기준':'녹음·원전사 모두 필요'}/>
        </div><div className="speech-timeline"><div className="speech-timeline-label"><span>발화와 쉼</span><span>{formatDuration(timing.durationMs)}</span></div>
          <svg role="img" aria-label={'녹음 '+formatDuration(timing.durationMs)+' 중 발화 구간'} viewBox="0 0 1000 28" preserveAspectRatio="none"><rect width="1000" height="28" rx="6" fill="#eef1ef"/>{current.analysis?.timing&&recordingSegments(current).map((segment:Item,index:number)=><rect key={index} x={segment.startMs/timing.durationMs*1000} y="2" width={Math.max(1,(segment.endMs-segment.startMs)/timing.durationMs*1000)} height="24" rx="3" fill="#21ad70"/>)}{timing.pauses.filter((pause:Item)=>pause.long).map((pause:Item,index:number)=><rect key={'pause-'+index} x={pause.startMs/timing.durationMs*1000} y="2" width={(pause.endMs-pause.startMs)/timing.durationMs*1000} height="24" rx="3" fill="#edd6ad"/>)}</svg>
          <div className="speech-timeline-legend"><span><i/>발화</span><span><i/>긴 쉼</span></div>
        </div>{timing.pauses.some((pause:Item)=>pause.long)&&<div className="speech-pause-links">{timing.pauses.filter((pause:Item)=>pause.long).slice(0,6).map((pause:Item,index:number)=><button key={index} type="button" className="button ghost small" onClick={()=>seek(pause.startMs)}><Volume2 size={14}/>{formatDuration(pause.startMs)}의 {(pause.durationMs/1000).toFixed(1)}초 쉼</button>)}</div>}</>:<p className="speech-measurement-empty">이 녹음에는 시간 측정이 없어요. 저장한 음성을 다시 읽어 분석할 수 있어요.</p>}
        <audio key={current.id} ref={audio} controls preload="metadata" src={current.playbackUrl} aria-label="분석한 내 답변 녹음" className="speech-playback"/>
        <div className="speech-analysis-actions"><button className="button ghost small" type="button" onClick={reanalyze} disabled={busy||(!timing&&!current.analysisAudioUrl)}><RefreshCw size={14} className={busy?'spin':''}/>{busy?'음성 분석 중':'녹음 다시 분석'}</button>{current.cleanupStatus!=='completed'&&<button type="button" className="button ghost small" disabled={busy||!current.analysisAudioUrl} onClick={transcribe}>{transcribing?'문장 정리 중':current.rawTranscript?'문장 정리 다시 시도':'전사 생성'}</button>}{timing&&!timing.reliable&&<span className="speech-partial">시간 측정 일부 누락</span>}</div>
        {transcribing&&<p className="transcript-processing" role="status">녹음을 글로 옮기고 문장을 정리하고 있어요.</p>}{current.transcript&&current.cleanupStatus==='completed'&&<div className="speech-display-transcript"><h3>정리된 전사</h3><p>{current.transcript}</p></div>}{current.rawTranscript&&<details className="transcript-raw"><summary>원전사 보기</summary><p>{current.rawTranscript}</p></details>}
        {transcript&&<div className="speech-language-observations"><div><h3>습관어</h3>{transcript.fillers.length?<div className="speech-word-list">{transcript.fillers.map((hit:Item)=><span key={hit.text}>“{hit.text}” <small>{hit.count}회</small></span>)}</div>:<p>원전사에서 확인된 습관어가 없어요.</p>}</div><div><h3>반복된 표현</h3>{transcript.repeatedPhrases.length||transcript.repeatedWords.length?<div className="speech-word-list">{[...transcript.repeatedPhrases,...transcript.repeatedWords].slice(0,6).map((hit:Item)=><span key={hit.text}>“{hit.text}” <small>{hit.count}회</small></span>)}</div>:<p>여러 번 반복된 표현이 확인되지 않았어요.</p>}</div></div>}
        {!!analysis?.limitations?.length&&<details className="speech-measurement-notes"><summary>측정 기준</summary>{analysis.limitations.map((note:string)=><p key={note}>{note}</p>)}<p>반복된 핵심 용어는 자연스러운 설명일 수 있어요. 녹음을 듣고 확인해 보세요.</p></details>}
      </>}
      {trend&&<div className="speech-trend"><h3>같은 질문에 답한 두 번의 녹음</h3><p>{trend.prompt}</p><div>{[['긴 쉼',trend.before.analysis.timing?.longPauseCount,trend.after.analysis.timing?.longPauseCount,'회'],['음성 공백',Math.round(trend.before.analysis.timing?.silenceRatio*100),Math.round(trend.after.analysis.timing?.silenceRatio*100),'%']].map(([label,before,after,unit])=><span key={String(label)}>{label}<strong>{before}{unit} <span aria-label="에서">→</span> {after}{unit}</strong></span>)}</div><p className="speech-caption">같은 질문에 남긴 녹음끼리 비교해요. 쉼이 줄어든 것이 항상 더 좋은 답변을 뜻하지는 않아요.</p></div>}
    </section>
  </div>;
}
function SpeechMetric({label,value,note}:{label:string;value:string;note:string}){return <div><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;}
function formatDuration(ms:number){const seconds=Math.floor(ms/1000);return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');}
function recordingSegments(recording:Item):Item[]{return recording.analysis?.timing?.speechSegments||[];}

