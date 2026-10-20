import type {InterviewerAvatarFrame} from './interviewer-avatar';

/** Licensed browser runtime boundary. The application does not bundle or accept Cubism/model licenses. */
export type Live2DModel={
  /** Implementations return cached Cubism ID handles, never a guessed wrapper string API. */
  parameter(name:string):{id:unknown;min:number;max:number}|null;
  setParameter(id:unknown,value:number):void;
  update(deltaSeconds:number,state:InterviewerAvatarFrame['state'],reducedMotion:boolean):void;
  render():void;destroy():void;
};
export type Live2DRuntime={mount(canvas:HTMLCanvasElement,modelUrl:string,signal:AbortSignal):Promise<Live2DModel>};
declare global{interface Window{gakjaLive2D?:Live2DRuntime;}}

/** Motion updates run first; the measured mouth value is applied last so idle motion cannot overwrite it. */
export class Live2DController{
  private mouth:ReturnType<Live2DModel['parameter']>;private disposed=false;
  constructor(private model:Live2DModel){this.mouth=model.parameter('ParamMouthOpenY');if(!this.mouth)throw new Error('The supplied model has no mouth-open parameter');}
  frame(frame:InterviewerAvatarFrame,deltaSeconds:number,reducedMotion:boolean){
    if(this.disposed)return;this.model.update(Math.max(0,Math.min(.1,deltaSeconds)),frame.state,reducedMotion);
    const parameter=this.mouth!;const opening=frame.state==='speaking'?Math.max(0,Math.min(1,frame.mouthOpen)):0;
    this.model.setParameter(parameter.id,parameter.min+(parameter.max-parameter.min)*opening);this.model.render();
  }
  dispose(){if(this.disposed)return;this.disposed=true;try{const parameter=this.mouth;if(parameter)this.model.setParameter(parameter.id,parameter.min);}catch{/* A failed avatar must not break the audio owner's cleanup. */}try{this.model.destroy();}catch{/* Keep the static portrait and interview controls usable. */}}
}
const runtimes=new Map<string,Promise<Live2DRuntime>>();
export function loadLive2DRuntime(path:string):Promise<Live2DRuntime>{
  if(window.gakjaLive2D)return Promise.resolve(window.gakjaLive2D);
  if(!path.startsWith('/')||path.startsWith('//')||!path.endsWith('.js'))return Promise.reject(new Error('Use a licensed, same-origin runtime'));
  const previous=runtimes.get(path);if(previous)return previous;
  const loading=new Promise<Live2DRuntime>((resolve,reject)=>{
    const script=document.createElement('script');script.src=path;script.async=true;
    const timer=setTimeout(()=>{script.remove();runtimes.delete(path);reject(new Error('Avatar runtime timeout'));},12000);
    script.onload=()=>{clearTimeout(timer);if(window.gakjaLive2D)resolve(window.gakjaLive2D);else{runtimes.delete(path);reject(new Error('Avatar runtime adapter missing'));}};
    script.onerror=()=>{clearTimeout(timer);script.remove();runtimes.delete(path);reject(new Error('Avatar runtime unavailable'));};document.head.append(script);
  });runtimes.set(path,loading);return loading;
}
