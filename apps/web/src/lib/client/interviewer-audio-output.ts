import {InterviewerAudioAnalyser} from './interviewer-audio-analyser';
import type {InterviewerAvatarSignal,InterviewerAvatarState} from './interviewer-avatar';

/** Sole audio-element owner shared by TTS and RTC. Avatar failure never owns or stops playback. */
export class InterviewerAudioOutput{
  private analyser:InterviewerAudioAnalyser;private speaking=false;private speakerId='';private disposed=false;
  constructor(readonly element:HTMLAudioElement,private signal:InterviewerAvatarSignal){
    this.analyser=new InterviewerAudioAnalyser(element,value=>signal.mouth(value));
    element.addEventListener('playing',this.playing);element.addEventListener('pause',this.silent);element.addEventListener('ended',this.silent);element.addEventListener('emptied',this.silent);element.addEventListener('error',this.silent);
  }
  unlock(){return this.analyser.unlock();}
  select(speakerId:string){
    // RTC can select a speaker on an already-playing stream. play() does not emit
    // another `playing` event then, so selecting must preserve the live output state.
    if(this.speakerId!==speakerId)this.signal.silence();
    this.speakerId=speakerId;this.signal.state(this.speaking&&!this.element.paused?'speaking':'thinking',speakerId);
  }
  /** UI renders or late captions must not close a mouth while its output is still playing. */
  syncState(state:InterviewerAvatarState,speakerId=this.speakerId){this.signal.state(this.speaking&&!this.element.paused?'speaking':state,this.speaking?this.speakerId:speakerId);}
  private playing=()=>{if(this.disposed)return;this.speaking=true;this.signal.state('speaking',this.speakerId);this.analyser.start();};
  private silent=()=>{this.speaking=false;this.analyser.stop();this.signal.state('idle',this.speakerId);};
  stop(){this.element.pause();this.silent();}
  setStream(stream:MediaStream|null){this.stop();this.element.removeAttribute('src');this.element.srcObject=stream;this.analyser.setStream(stream);}
  clear(){this.stop();this.element.srcObject=null;this.analyser.setStream(null);}
  dispose(){if(this.disposed)return;this.disposed=true;this.clear();this.element.removeEventListener('playing',this.playing);for(const event of ['pause','ended','emptied','error'])this.element.removeEventListener(event,this.silent);this.analyser.dispose();this.signal.reset();}
}
