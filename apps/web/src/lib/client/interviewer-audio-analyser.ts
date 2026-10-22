export type MouthCalibration={gate:number;gain:number;attackMs:number;releaseMs:number};
const defaults:MouthCalibration={gate:.008,gain:9,attackMs:45,releaseMs:110};
export function outputRms(samples:ArrayLike<number>):number{if(!samples.length)return 0;let sum=0;for(let index=0;index<samples.length;index++){const value=samples[index];if(!Number.isFinite(value))return 0;sum+=value*value;}return Math.sqrt(sum/samples.length);}
export function smoothMouth(rms:number,previous:number,elapsedMs:number,calibration:Partial<MouthCalibration>={}):number{
  const config={...defaults,...calibration},target=Number.isFinite(rms)&&rms>config.gate?Math.min(1,Math.pow(Math.max(0,(rms-config.gate)*config.gain),.75)):0;
  const duration=target>previous?config.attackMs:config.releaseMs,alpha=1-Math.exp(-Math.max(0,Math.min(100,elapsedMs))/Math.max(1,duration));
  const value=previous+(target-previous)*alpha;return Number.isFinite(value)&&value>.001?Math.max(0,Math.min(1,value)):0;
}

type Graph={context:AudioContext;source:MediaElementAudioSourceNode;analyser:AnalyserNode};
const elementGraphs=new WeakMap<HTMLAudioElement,Graph>();
/** This analyser only observes the interviewer output. It never opens a microphone. */
export class InterviewerAudioAnalyser{
  private graph?:Graph;private frame=0;private last=0;private mouth=0;private disposed=false;private unlocking?:Promise<void>;
  private stream:MediaStream|null=null;private attachedStream:MediaStream|null|undefined;private streamSource?:MediaStreamAudioSourceNode;
  constructor(private element:HTMLAudioElement,private update:(value:number)=>void){}
  unlock(){if(this.unlocking)return this.unlocking;const work=this.prepare().finally(()=>{if(this.unlocking===work)this.unlocking=undefined;});this.unlocking=work;return work;}
  private async prepare(){
    if(this.disposed)return;
    try{
      let graph=elementGraphs.get(this.element);
      if(!graph){
        const Constructor=typeof window!=='undefined'?(window.AudioContext||(window as unknown as {webkitAudioContext?:typeof AudioContext}).webkitAudioContext):undefined;
        if(!Constructor)return;
        const context=new Constructor();await context.resume();
        if(this.disposed||context.state!=='running'){await context.close();return;}
        const analyser=context.createAnalyser();analyser.fftSize=1024;
        const source=context.createMediaElementSource(this.element);
        // Only this direct edge is audible; the analyser's unconnected output is observation-only.
        source.connect(context.destination);source.connect(analyser);
        graph={context,source,analyser};elementGraphs.set(this.element,graph);
      }
      this.graph=graph;if(graph.context.state==='suspended'||graph.context.state==='interrupted')await graph.context.resume();
      try{this.connectInput();}catch{/* Observation failure must not prevent resuming audio after interruption. */}
    }catch{/* Keep the existing HTML audio path usable when Web Audio is unavailable. */}
  }
  /** Chromium does not expose srcObject audio through MediaElementAudioSource. Observe the remote stream directly. */
  setStream(stream:MediaStream|null){this.stream=stream;try{this.connectInput();}catch{/* Avatar observation cannot interrupt the audible element. */}}
  private connectInput(){
    const graph=this.graph;if(!graph||this.attachedStream===this.stream)return;
    this.streamSource?.disconnect();this.streamSource=undefined;
    try{graph.source.disconnect(graph.analyser);}catch{}
    if(this.stream){
      this.streamSource=graph.context.createMediaStreamSource(this.stream);
      // Observation only: the HTML audio element remains the sole audible stream path.
      this.streamSource.connect(graph.analyser);
    }else graph.source.connect(graph.analyser);
    this.attachedStream=this.stream;
  }
  start(){
    this.stop();if(this.disposed)return;if(!this.graph||this.graph.context.state!=='running'){
      // Device permission dialogs and Safari audio interruptions can suspend the
      // observer while the remote HTML stream remains audible. Resume at playback too.
      void this.unlock().then(()=>{if(this.graph?.context.state==='running'&&!this.disposed&&!this.element.paused&&!this.element.ended)this.start();});return;
    }
    const samples=new Float32Array(this.graph.analyser.fftSize);this.last=performance.now();
    const tick=(now:number)=>{
      if(this.disposed||!this.graph||this.element.paused||this.element.ended){this.stop();return;}
      try{this.graph.analyser.getFloatTimeDomainData(samples);this.mouth=smoothMouth(outputRms(samples),this.mouth,now-this.last);this.last=now;this.update(this.mouth);}catch{this.stop();return;}
      this.frame=requestAnimationFrame(tick);
    };
    this.frame=requestAnimationFrame(tick);
  }
  stop(){if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;this.mouth=0;this.update(0);}
  dispose(){if(this.disposed)return;this.stop();this.disposed=true;this.streamSource?.disconnect();this.streamSource=undefined;const graph=this.graph;this.graph=undefined;if(graph){graph.source.disconnect();graph.analyser.disconnect();void graph.context.close().catch(()=>{});}}
}
