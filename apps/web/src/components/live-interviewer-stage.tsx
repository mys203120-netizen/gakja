
import {ownedClassName} from './owned-class-name';
import {Check, CircleAlert, LoaderCircle, Mic, Pause, Volume2} from 'lucide-react';
import {Interviewer} from './interviewer-character';
import styles from './live-interview-session.module.css';
import type {InterviewerAvatarSignal} from '@/lib/client/interviewer-avatar';

export type LiveInterviewPhase='idle'|'preparing'|'speaking'|'listening'|'saving'|'paused'|'recovering'|'complete'|'error';
export type LivePanelist={id:string;name:string;gender?:string};
export type LiveInterviewerStageProps={
  people:LivePanelist[];
  speakerId?:string;
  phase:LiveInterviewPhase;
  question?:string;
  questionNumber?:number;
  questionCount?:number;
  questionKind?:string;
  statusText?:string;
  answerSeconds?:number;
  avatarSignal?:InterviewerAvatarSignal;
  diagnostic?:boolean;
  answerMode?:'text'|'voice';
};

const phaseCopy:Record<LiveInterviewPhase,{label:string;hint:string}>={
  idle:{label:'시작 전',hint:'시작하면 질문을 듣고, 내 말로 답할 수 있어요.'},
  preparing:{label:'면접 준비 중',hint:'마이크와 질문 음성을 준비하고 있어요.'},
  speaking:{label:'질문을 듣는 시간',hint:'질문이 끝나면 답변 녹음이 시작돼요.'},
  listening:{label:'답변 녹음 중',hint:'지금 편하게 말씀해 주세요.'},
  saving:{label:'답변 저장 중',hint:'말한 내용을 글로 옮기고 저장하고 있어요.'},
  paused:{label:'잠시 쉬는 중',hint:'준비되면 같은 질문에서 이어갈 수 있어요.'},
  recovering:{label:'진행 상태 확인 중',hint:'저장된 답변과 이어갈 위치를 확인하고 있어요.'},
  complete:{label:'면접 완료',hint:'리포트에서 답변과 피드백을 확인해 보세요.'},
  error:{label:'진행을 멈췄어요',hint:'안내를 확인한 뒤 다시 시도해 주세요.'},
};
const fallback:LivePanelist[]=[{id:'A',name:'면접관 A',gender:'female'}];

/** Presentation only: device access, speech and recording stay in the session controller. */
export function LiveInterviewerStage({people,speakerId,phase,question,questionNumber,questionCount,questionKind,statusText,answerSeconds,avatarSignal,diagnostic=false,answerMode='voice'}:LiveInterviewerStageProps){
  const panelists=people.length?people:fallback;
  const current=panelists.find(person=>person.id===speakerId)||panelists[0];
  const others=panelists.filter(person=>person.id!==current.id);
  const busy=['preparing','saving','recovering'].includes(phase);
  const StatusIcon=busy?LoaderCircle:phase==='listening'?Mic:phase==='speaking'?Volume2:phase==='paused'?Pause:phase==='complete'?Check:phase==='error'?CircleAlert:Mic;
  const questionLabel=questionKind==='generated'?'꼬리질문':questionKind==='verification'?'근거 확인':questionNumber?`질문 ${questionNumber}${questionCount?` / ${questionCount}`:''}`:'현재 질문';
  const seconds=Math.max(0,Math.floor(answerSeconds||0));
  return <section className={ownedClassName(styles.stage,true)} data-phase={phase} aria-label={diagnostic?'첫 진단 질문':'Live 면접 진행'}>
    {!diagnostic&&<div className={ownedClassName(styles.stageScene,true)}>
      <div className={ownedClassName(styles.stageTopline,true)}><span className={ownedClassName(styles.liveBadge,true)}><span aria-hidden="true" className={ownedClassName(undefined,true)}/>Live 면접</span><span className={ownedClassName(undefined,true)}>{panelists.length}명의 면접관</span></div>
      <div className={ownedClassName(styles.portraitStack,true)} aria-hidden="true">
        {panelists.map((person,index)=><div key={person.id} className={ownedClassName(styles.portrait,true)} data-current={person.id===current.id}>
          <Interviewer person={person} portraitIndex={index} avatarSignal={person.id===current.id?avatarSignal:undefined} compact speaking={person.id===current.id&&phase==='speaking'} listening={person.id===current.id&&phase==='listening'} pending={busy}/>
        </div>)}
      </div>
      <div className={ownedClassName(styles.speakerIdentity,true)}><strong className={ownedClassName(undefined,true)}>{current.name}</strong><span className={ownedClassName(undefined,true)}>{phase==='speaking'?'질문하고 있어요':phase==='listening'?'답변을 듣고 있어요':'함께 면접을 진행해요'}</span></div>
      {others.length>0&&<ul className={ownedClassName(styles.otherPanelists,true)} aria-label="함께하는 면접관">{others.map(person=><li key={person.id} className={ownedClassName(undefined,true)}><div aria-hidden="true" className={ownedClassName(undefined,true)}><Interviewer person={person} portraitIndex={panelists.indexOf(person)} compact/></div><span className={ownedClassName(undefined,true)}>{person.name}</span></li>)}</ul>}
    </div>}
    <div className={ownedClassName(styles.questionArea,true)}>
      <div className={ownedClassName(styles.questionMeta,true)}><span className={ownedClassName(undefined,true)}>{question?questionLabel:phase==='complete'?'답변 기록':'질문을 듣고 답해보세요'}</span>{!diagnostic&&<span className={ownedClassName(undefined,true)}>{current.name}</span>}</div>
      <h2 className={ownedClassName(styles.question,true)}>{question||(phase==='complete'?'준비한 질문에 모두 답했어요.':'준비되면 면접을 시작해요.')}</h2>
      <div className={ownedClassName(styles.stageStatus,true)}>
        <p role="status" aria-live="polite" aria-atomic="true" className={ownedClassName(undefined,true)}><StatusIcon size={17} className={ownedClassName(busy?styles.spinner:undefined)} aria-hidden="true"/><strong className={ownedClassName(undefined,true)}>{answerMode==='text'&&!busy?'내 답변 작성':phaseCopy[phase].label}</strong></p>
        {phase==='listening'&&answerSeconds!==undefined&&<span className={ownedClassName(styles.timer,true)} role="timer" aria-live="off" aria-label="답변 녹음 경과 시간">{String(Math.floor(seconds/60)).padStart(2,'0')}:{String(seconds%60).padStart(2,'0')}</span>}
      </div>
      <p className={ownedClassName(styles.stageHint,true)}>{statusText||phaseCopy[phase].hint}</p>
    </div>
  </section>;
}
