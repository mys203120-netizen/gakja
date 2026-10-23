export type LiveTranscript = {
  phase: 'connecting' | 'ready' | 'listening' | 'finishing' | 'finished' | 'unavailable';
  text: string;
};
export type LiveTranscription = {
  ready: Promise<void>;
  start(): void;
  finish(): void;
  close(): Promise<boolean>;
  mute(muted:boolean):void;
};
type Scope = { sessionId: string; itemIndex: number; attemptId: string } | { sessionId:string;turnId:string;generation:number;attemptId:string };

/** Reconciles provisional deltas and completed turns, including out-of-order completions. */
export class TranscriptTurns {
  private turns = new Map<string, { text: string; complete: boolean; previous?: string | null }>();
  accept(event: Record<string, unknown>): string {
    const id = typeof event.item_id === 'string' ? event.item_id : '';
    if (!id || id.length > 200) return this.text();
    let turn = this.turns.get(id);
    if (!turn) {
      if (this.turns.size >= 100) return this.text();
      turn = { text: '', complete: false }; this.turns.set(id, turn);
    }
    if (event.type === 'input_audio_buffer.committed') {
      if (event.previous_item_id === null || typeof event.previous_item_id === 'string') turn.previous = event.previous_item_id;
    } else if (event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string') {
      turn.text = event.transcript.slice(0, 12_000); turn.complete = true;
    } else if (event.type === 'conversation.item.input_audio_transcription.delta' && typeof event.delta === 'string' && !turn.complete) {
      turn.text = (turn.text + event.delta).slice(0, 12_000);
    }
    return this.text();
  }
  text(): string {
    const ordered: string[] = [], visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const turn = this.turns.get(id); if (!turn) return;
      if (turn.previous && this.turns.has(turn.previous)) visit(turn.previous);
      ordered.push(turn.text);
    };
    for (const id of this.turns.keys()) visit(id);
    return ordered.filter(Boolean).join('\n').slice(0, 12_000);
  }
}

/** Owns a disabled clone, never the original track used by the durable recorder. */
export function connectLiveTranscription(
  stream: MediaStream, scope: Scope, update: (snapshot: LiveTranscript) => void, endpoint='/api/quiz/realtime',
): LiveTranscription {
  const abort = new AbortController(), turns = new TranscriptTurns(), seen = new Set<string>();
  let peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined, track: MediaStreamTrack | undefined;
  let closed = false, started = false, finishing = false, callId = '', text = '', phase: LiveTranscript['phase'] = 'connecting';
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = (next: LiveTranscript['phase']) => { phase = next; update({ phase, text }); };
  let shutdown:Promise<boolean>|undefined;
  const cleanups=new Map<string,Promise<boolean>>();
  const cleanupCall=(id:string)=>{
    const known=cleanups.get(id);if(known)return known;
    const work=(async()=>{for(let attempt=0;attempt<2;attempt++)try{
      const result=await fetch(endpoint,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,callId:id}),keepalive:true});
      if(result.ok||result.status===404)return true;if(result.status===401||result.status===403)return false;
    }catch{/* The local track is already stopped; retry the owned hangup once. */}return false;})();
    cleanups.set(id,work);void work.then(confirmed=>{if(!confirmed)cleanups.delete(id);});return work;
  };
  const close=():Promise<boolean>=>{
    if(shutdown)return shutdown;
    if(!closed){closed=true;abort.abort();clearTimeout(finishTimer);if(track){track.enabled=false;track.stop();}channel?.close();peer?.close();}
    const pending=callId?cleanupCall(callId):Promise.resolve().then(()=>ready).catch(()=>{}).then(()=>callId?cleanupCall(callId):true);
    shutdown=pending;void pending.then(confirmed=>{if(!confirmed&&shutdown===pending)shutdown=undefined;});return pending;
  };
  const unavailable = () => { if (!closed) { emit('unavailable'); close(); } };
  const ready = (async () => {
    emit('connecting');
    try {
      if (typeof RTCPeerConnection === 'undefined') throw new Error('unsupported');
      const source = stream.getAudioTracks()[0]; if (!source) throw new Error('no audio');
      track = source.clone(); track.enabled = false;
      peer = new RTCPeerConnection(); peer.addTrack(track, new MediaStream([track]));
      channel = peer.createDataChannel('oai-events');
      peer.onconnectionstatechange = () => { if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') unavailable(); };
      channel.onmessage = ({ data }) => {
        if (closed || !started || typeof data !== 'string' || data.length > 100_000) return;
        let event: Record<string, unknown>; try { event = JSON.parse(data); } catch { return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        if (typeof event.event_id === 'string') {
          if (seen.has(event.event_id)) return;
          if (seen.size >= 2000) seen.clear(); seen.add(event.event_id);
        }
        if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') { unavailable(); return; }
        text = turns.accept(event); emit(finishing ? 'finishing' : 'listening');
      };
      channel.onclose = () => { if (!closed) unavailable(); };
      const offer = await peer.createOffer();
      if (closed) return;
      await peer.setLocalDescription(offer);
      if (closed) return;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scope, consent: true, sdp: offer.sdp }), signal: abort.signal });
      const value = await response.json();
      // A cancellation may happen after our server has already issued the call.
      if (closed) { if (typeof value.callId === 'string'){callId=value.callId;void cleanupCall(callId);} return; }
      if (!response.ok || typeof value.sdp !== 'string' || typeof value.callId !== 'string') throw new Error('connect failed');
      callId = value.callId;
      await peer.setRemoteDescription({ type: 'answer', sdp: value.sdp });
      if (closed) return;
      if (channel.readyState !== 'open') await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { dispose(); reject(new Error('connect timeout')); }, 8_000);
        const opened = () => { dispose(); resolve(); };
        const cancelled = () => { dispose(); resolve(); };
        const dispose = () => { clearTimeout(timer); channel?.removeEventListener('open', opened); abort.signal.removeEventListener('abort', cancelled); };
        channel!.addEventListener('open', opened, { once: true }); abort.signal.addEventListener('abort', cancelled, { once: true });
      });
      if (!closed) emit('ready');
    } catch { unavailable(); }
  })();
  return { ready, close, mute(muted){if(track&&started&&!finishing&&!closed)track.enabled=!muted;},
    start() {
      if (closed || phase !== 'ready' || !track) return;
      started = true; track.enabled = true; emit('listening');
    },
    finish() {
      if (closed || finishing) return;
      if (!started || channel?.readyState !== 'open') { close(); return; }
      finishing = true; if (track) track.enabled = false; emit('finishing');
      try { channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch { unavailable(); return; }
      finishTimer = setTimeout(() => { if (!closed) { emit('finished'); close(); } }, 2_000);
    },
  };
}
