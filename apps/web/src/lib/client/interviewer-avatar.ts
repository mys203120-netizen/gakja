export type InterviewerAvatarState='idle'|'listening'|'thinking'|'speaking';
export type InterviewerAvatarFrame={state:InterviewerAvatarState;speakerId:string;mouthOpen:number};

/** Frame values stay outside React state. Only the active output speaker receives mouth motion. */
export class InterviewerAvatarSignal{
  private frame:InterviewerAvatarFrame={state:'idle',speakerId:'',mouthOpen:0};
  private listeners=new Set<(frame:InterviewerAvatarFrame)=>void>();
  get snapshot(){return this.frame;}
  subscribe(listener:(frame:InterviewerAvatarFrame)=>void){this.listeners.add(listener);try{listener(this.frame);}catch{/* The fallback portrait remains available. */}return()=>{this.listeners.delete(listener);};}
  state(state:InterviewerAvatarState,speakerId=this.frame.speakerId){this.frame={state,speakerId,mouthOpen:state==='speaking'?this.frame.mouthOpen:0};this.emit();}
  mouth(value:number){const mouthOpen=this.frame.state==='speaking'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):0;this.frame={...this.frame,mouthOpen};this.emit();}
  silence(){this.frame={...this.frame,mouthOpen:0};this.emit();}
  reset(){this.frame={state:'idle',speakerId:'',mouthOpen:0};this.emit();}
  private emit(){for(const listener of this.listeners)try{listener(this.frame);}catch{/* Rendering cannot interrupt interview audio or recording. */}}
}
