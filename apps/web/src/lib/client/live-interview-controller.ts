import type {LiveAnswerCapture, LiveAnswerRecording, LiveCaptureProgress} from './live-interview-recorder';

export type LivePhase = 'idle'|'preparing'|'speaking'|'listening'|'saving'|'paused'|'recovering'|'complete'|'error';
export type LiveInfo = Record<string, any>;
export type LiveSnapshot = {phase:LivePhase;info:LiveInfo;error:string;progress?:LiveCaptureProgress;recording?:LiveAnswerRecording};
type Pending = {question:LiveInfo;generation:number;recording?:LiveAnswerRecording;mediaId?:string};
export type LiveInterviewServices = {
  load():Promise<LiveInfo>;
  prepare():Promise<void>;
  mute(paused:boolean):void;
  suspend():Promise<void>;
  resume():Promise<void>;
  speak(question:LiveInfo,generation:number,signal:AbortSignal):Promise<void>;
  beforeCapture?(question:LiveInfo,generation:number,signal:AbortSignal):Promise<void>;
  capture(onProgress:(value:LiveCaptureProgress)=>void,question:LiveInfo,generation:number):LiveAnswerCapture;
  upload(recording:LiveAnswerRecording,question:LiveInfo,generation:number):Promise<string>;
  transcribe(mediaId:string):Promise<void>;
  answer(mediaId:string,question:LiveInfo,generation:number):Promise<unknown>;
  finish():Promise<void>;
  release():void;
  wait():Promise<void>;
};

/** One owner for the voice loop. Pauses retain the current recording and retry identity. */
export class LiveInterviewController {
  private snapshot:LiveSnapshot;
  private capture?:LiveAnswerCapture;
  private speech?:AbortController;
  private pending?:Pending;
  private running?:Promise<void>;
  private starting?:Promise<void>;
  private rerecording?:Promise<void>;
  private runRevision=0;
  private ignoredMediaIds=new Set<string>();
  private suspension:Promise<void>=Promise.resolve();
  private paused=true;
  private requested=false;
  private intent=0;
  private disposed=false;
  private ending=false;
  private devicePrepared=false;
  private wake?:()=>void;
  constructor(info:LiveInfo,private services:LiveInterviewServices,private changed:(value:LiveSnapshot)=>void){
    this.snapshot={phase:info.session.state==='completed'?'complete':'idle',info,error:''};
  }
  get state(){return this.snapshot;}
  restoreRecording(recording:LiveAnswerRecording,question:LiveInfo,generation:number){
    if(this.disposed||this.running||this.capture||this.pending||this.snapshot.info.question?.turnId!==question.turnId||Number(this.snapshot.info.session.data.generation||0)!==generation)return false;
    this.pending={question,generation,recording};this.emit({recording});return true;
  }
  /** Stop safely before an explicit switch to typing; final chunks still reach persistence. */
  async preserveAnswer(){this.pause();if(this.capture){const recording=await this.capture.stop('interrupted');return recording;}return this.pending?.recording;}
  async acceptTypedAnswer(info:LiveInfo){
    this.pause();this.runRevision++;this.wake?.();this.wake=undefined;await this.running;
    this.pending=undefined;this.capture=undefined;this.ending=false;
    if(info.session.state==='completed')this.services.release();
    this.emit({info,phase:info.session.state==='completed'?'complete':'paused',recording:undefined,progress:undefined,error:''});
  }
  private emit(patch:Partial<LiveSnapshot>){if(this.disposed)return;this.snapshot={...this.snapshot,...patch};this.changed(this.snapshot);}
  private phase(phase:LivePhase){if(!this.paused)this.emit({phase});}
  private async checkpoint(revision=this.runRevision){while(this.paused&&!this.disposed&&revision===this.runRevision)await new Promise<void>(resolve=>{this.wake=resolve;});if(this.disposed||revision!==this.runRevision)throw new DOMException('진행을 중단했어요.','AbortError');}
  private async load(){const info=await this.services.load();this.emit({info});return info;}
  private control(action:()=>Promise<void>){const work=this.suspension.catch(()=>{}).then(action);this.suspension=work;return work;}
  private ensureRunning(){
    if(this.running||this.disposed||this.paused||!this.requested||this.snapshot.phase==='complete')return;
    const work=this.run().finally(()=>{if(this.running===work)this.running=undefined;this.ensureRunning();});
    this.running=work;
  }
  private rememberSavedMedia(info:LiveInfo){
    if(this.pending||!info.question)return;
    const generation=Number(info.session.data.generation||0);
    const media=[...(info.media||[])].reverse().find(item=>!this.ignoredMediaIds.has(item.id)&&item.metadata?.kind==='answer_recording'&&item.metadata.turnId===info.question.turnId&&item.metadata.generation===generation);
    if(media)this.pending={question:info.question,generation,mediaId:media.id};
  }
  start():Promise<void>{
    if(this.disposed||this.snapshot.phase==='complete')return Promise.resolve();
    if(this.rerecording)return this.rerecording;
    if(!this.requested){this.requested=true;this.intent++;}
    if(this.starting)return this.starting;
    if(!this.paused&&this.running)return Promise.resolve();
    const work=this.begin().finally(()=>{if(this.starting===work)this.starting=undefined;});this.starting=work;return work;
  }
  private async begin(){
    try{
      while(this.requested&&!this.disposed){
        const intent=this.intent;
        const changed=()=>this.disposed||!this.requested||this.intent!==intent;
        this.emit({phase:'preparing',error:''});
        await this.suspension.catch(()=>{});if(changed())continue;
        this.rememberSavedMedia(this.snapshot.info);
        if(!this.ending&&!this.pending){await this.services.prepare();this.devicePrepared=true;}
        if(this.disposed){this.services.release();return;}
        if(changed()){this.services.mute(true);continue;}
        let info=await this.load();if(changed())continue;
        while(info.session.data.processing&&!changed()){this.emit({phase:'recovering'});await this.services.wait();if(changed())break;info=await this.load();}
        if(changed())continue;
        if(info.session.state!=='active'){this.requested=false;this.emit({phase:'complete'});this.services.release();return;}
        await this.control(()=>this.services.resume());if(changed())continue;
        info=await this.load();if(changed())continue;
        if(info.session.state!=='active'){this.requested=false;this.emit({phase:'complete'});this.services.release();return;}
        this.paused=false;this.services.mute(false);this.capture?.resume();this.wake?.();this.wake=undefined;
        if(this.capture)this.emit({phase:'listening'});
        this.ensureRunning();return;
      }
    }catch(error){await this.fail(error);}
  }
  pause(){
    if(this.disposed||this.snapshot.phase==='complete')return;
    this.requested=false;this.intent++;this.paused=true;this.capture?.pause();this.speech?.abort();this.services.mute(true);this.emit({phase:'paused'});
    void this.control(()=>this.services.suspend()).catch(()=>this.emit({error:'일시정지를 서버에 저장하지 못했어요. 연결 후 계속해 주세요.'}));
  }
  finishAnswer(){if(!this.paused)this.capture?.stop('manual');}
  /** An explicit new attempt preserves server files and drafts, but skips the old audio locally. */
  rerecord():Promise<void>{
    if(this.disposed||this.snapshot.phase==='complete')return Promise.resolve();
    if(this.rerecording)return this.rerecording;
    const work=this.replaceRecording().finally(()=>{if(this.rerecording===work)this.rerecording=undefined;});this.rerecording=work;return work;
  }
  private async replaceRecording(){
    const previous=this.pending;
    const question=previous?.question||this.snapshot.info.question;
    const generation=previous?.generation??Number(this.snapshot.info.session.data.generation||0);
    if(!question)return;
    this.ending=false;this.pause();const intent=this.intent;
    const changed=()=>this.disposed||intent!==this.intent;
    const answered=(info:LiveInfo)=>info.turns?.some((turn:LiveInfo)=>turn.id===question.turnId&&turn.answer&&!turn.invalidated);
    const assertCurrent=(info:LiveInfo)=>{
      if(answered(info))return;
      if(info.session.state!=='active'||info.question?.turnId!==question.turnId||Number(info.session.data.generation||0)!==generation)throw new Error('질문 상태가 바뀌었어요. 보관한 녹음을 내려받고 면접을 다시 열어 주세요.');
    };
    try{
      await this.suspension.catch(()=>{});if(changed())return;
      await this.starting;if(changed())return;
      let info=await this.load();if(changed())return;assertCurrent(info);
      this.emit({phase:'preparing',error:''});
      // A paused loop may still own a pending upload or answer. Retire it before
      // clearing pending data; its late result must never become the new attempt.
      this.runRevision++;this.capture?.dispose();this.wake?.();this.wake=undefined;
      await this.running;if(changed())return;
      info=await this.load();if(changed())return;assertCurrent(info);
      if(previous?.mediaId)this.ignoredMediaIds.add(previous.mediaId);
      for(const media of info.media||[])if(media.metadata?.kind==='answer_recording'&&media.metadata.turnId===question.turnId&&Number(media.metadata.generation)===generation)this.ignoredMediaIds.add(media.id);
      this.pending=undefined;this.emit({recording:undefined,progress:undefined,error:''});
      this.requested=true;this.intent++;await this.begin();
    }catch(error){if(!changed())await this.fail(error);}
  }
  finish(){
    this.ending=true;this.speech?.abort();
    if(this.capture)void this.capture.stop('manual');
    return this.start();
  }
  private async fail(error:unknown){
    if(this.disposed)return;
    this.requested=false;this.intent++;this.paused=true;this.capture?.pause();this.services.mute(true);this.speech?.abort();
    this.emit({phase:'error',error:error instanceof Error?error.message:'연결을 확인하고 다시 시도해 주세요.'});
    await this.control(()=>this.services.suspend()).catch(()=>{});
  }
  private async run(){
    const revision=this.runRevision;
    try{
      while(!this.disposed){
        await this.checkpoint(revision);
        const intent=this.intent;
        let info=await this.load();
        await this.checkpoint(revision);
        // A pause/resume can complete while this read is in flight. Its old
        // paused snapshot must not suspend the newly resumed session again.
        if(intent!==this.intent)continue;
        if(info.session.state!=='active'){this.requested=false;this.emit({phase:'complete'});this.services.release();return;}
        if(info.session.data.processing){this.phase('recovering');await this.services.wait();continue;}
        if(info.session.data.paused){this.pause();continue;}
        this.rememberSavedMedia(info);
        if(this.pending){
          const pending=this.pending;
          // A lost response can mean the answer succeeded. Never attach old audio to the next turn.
          if(info.turns?.some((turn:LiveInfo)=>turn.id===pending.question.turnId&&turn.answer&&!turn.invalidated)){this.pending=undefined;this.emit({recording:undefined});continue;}
          if(info.question?.turnId!==pending.question.turnId||Number(info.session.data.generation||0)!==pending.generation)throw new Error('다른 화면에서 질문 상태가 바뀌었어요. 보관한 녹음을 내려받고 면접을 다시 열어 주세요.');
          this.phase('saving');
          if(!pending.mediaId)pending.mediaId=await this.services.upload(pending.recording!,pending.question,pending.generation);
          await this.checkpoint(revision);
          await this.services.transcribe(pending.mediaId);
          await this.checkpoint(revision);
          try{await this.services.answer(pending.mediaId,pending.question,pending.generation);}
          catch(error){
            // The HTTP response can be lost after the owned media answer was committed.
            // Reload its receipt before asking the user to retry or sending another answer.
            let recovered:LiveInfo;try{recovered=await this.load();}catch{throw error;}
            await this.checkpoint(revision);
            if(!recovered.turns?.some((turn:LiveInfo)=>turn.id===pending.question.turnId&&turn.answer&&!turn.invalidated)){
              if(recovered.session.data.processing)continue;
              throw error;
            }
          }
          if(this.disposed||revision!==this.runRevision)return;
          this.pending=undefined;this.emit({recording:undefined,progress:undefined});
          continue;
        }
        if(this.ending||!info.question){
          this.phase('saving');await this.services.finish();if(this.disposed||revision!==this.runRevision)return;await this.load();this.requested=false;this.emit({phase:'complete'});this.services.release();return;
        }
        const question=info.question,generation=Number(info.session.data.generation||0);
        if(!this.devicePrepared){await this.services.prepare();this.devicePrepared=true;await this.checkpoint(revision);}
        this.phase('speaking');const speech=new AbortController();this.speech=speech;
        try{
          await this.services.speak(question,generation,speech.signal);
          if(speech.signal.aborted||this.paused||this.ending)continue;
          await this.services.beforeCapture?.(question,generation,speech.signal);
          await this.checkpoint(revision);
          // Pausing can release a prepared recording reservation while this await
          // is pending. Reacquire it before creating a recorder after resume.
          if(speech.signal.aborted||this.ending)continue;
          this.emit({phase:'listening',progress:undefined,recording:undefined});
          if(speech.signal.aborted||this.paused)continue;
          this.capture=this.services.capture(progress=>{this.emit({progress});this.phase('listening');},question,generation);
        }catch(error){if(speech.signal.aborted||this.paused||this.ending)continue;throw error;}
        finally{if(this.speech===speech)this.speech=undefined;}
        let recording:LiveAnswerRecording;
        try{recording=await this.capture.finished;}finally{this.capture=undefined;}
        if(this.disposed||revision!==this.runRevision)return;
        this.emit({recording});
        if(recording.measurementAvailable&&!recording.speechStarted&&recording.reason!=='manual'){
          if(this.ending)continue;
          throw new Error('아직 목소리가 들리지 않았어요. 마이크를 확인하고 같은 질문에 다시 답해 주세요.');
        }
        this.pending={question,generation,recording};
        if(recording.partial&&recording.reason!=='limit')throw new Error(recording.issue||'녹음 연결이 끊겼어요. 보관한 답변을 저장한 뒤 계속할 수 있어요.');
      }
    }catch(error){if(revision===this.runRevision)await this.fail(error);}
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.requested=false;this.intent++;this.speech?.abort();if(this.capture)void this.capture.stop('interrupted').catch(()=>{});this.wake?.();this.wake=undefined;this.services.release();}
}
