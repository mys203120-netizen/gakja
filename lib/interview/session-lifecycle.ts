type Ref<T> = { current: T };
type SocketHandle = { onopen: unknown; onmessage: unknown; onerror: unknown; onclose: unknown; close(): void };

/** A successfully finalized empty observation is silence, not a transport failure or invented answer. */
export function finalizedAnswerAction(rawTranscript: string, finishAfterAnswer: boolean): 'end' | 'next' {
  void rawTranscript;
  if (finishAfterAnswer) return 'end';
  return 'next';
}

/** Retire only after the current answer has been flushed/finalized, or on explicit reset. */
export function retirePlaybackRun<TTurn>(refs: {
  generation: Ref<number>;
  turn: Ref<TTurn | null>;
  pendingTurn: Ref<TTurn | null>;
  answerId: Ref<string>;
  transcript: Ref<string>;
  submitted: Ref<boolean>;
  submitting: Ref<boolean>;
  answerFinalized: Ref<boolean>;
  nextCommitted: Ref<string | null>;
  resumePhase: Ref<string>;
  retryAction: Ref<(() => void) | null>;
  pcmAllowed: Ref<boolean>;
  socketIdentity: Ref<string>;
  socket: Ref<SocketHandle | null>;
  audio: Ref<{ pause(): void } | null>;
  finalized: Ref<{ reject(reason: Error): void } | null>;
  pauseResolve: Ref<(() => void) | null>;
  pauseFinished: Ref<Promise<void>>;
}) {
  const epoch = ++refs.generation.current;
  refs.pcmAllowed.current = false;
  refs.turn.current = null; refs.pendingTurn.current = null;
  refs.answerId.current = ''; refs.transcript.current = '';
  refs.submitted.current = false; refs.submitting.current = false; refs.answerFinalized.current = false;
  refs.nextCommitted.current = null; refs.resumePhase.current = 'idle'; refs.retryAction.current = null;
  refs.finalized.current?.reject(new Error('면접 세션이 종료되었습니다.'));
  refs.finalized.current = null;
  refs.pauseResolve.current?.(); refs.pauseResolve.current = null; refs.pauseFinished.current = Promise.resolve();
  refs.audio.current?.pause();
  const socket = refs.socket.current;
  if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
  refs.socket.current = null; refs.socketIdentity.current = '';
  return epoch;
}
