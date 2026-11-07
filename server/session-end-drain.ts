export interface SessionEndCaptureScope { turnId: string; answerId: string; captureRevision: number }
export interface SessionEndCaptureDrain {
  turnId: string; answerId: string; captureRevision?: number;
  receipt: Promise<void>; markFinishReceived(): void;
  finishForEnd(): Promise<void>;
}
interface EndDrainClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface SessionEndDrainerDependencies<TCapture> {
  drainFor(capture: TCapture): SessionEndCaptureDrain | undefined;
  finish(capture: TCapture): Promise<unknown>;
  close(capture: TCapture): void | Promise<void>;
  onFailure(capture: TCapture, drain: SessionEndCaptureDrain | undefined, error: unknown): void;
  forget?(captures: readonly TCapture[]): void;
  clock?: EndDrainClock;
}
const systemClock: EndDrainClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Shared local end handshake. HTTP may overtake PCM/finish on the socket, so
 * only the matching accepted scope waits for its ordered finish marker (2s).
 * A missing marker is an unconfirmed capture, never observed silence. The
 * composition still owns transcript mutation, provider identity and persistence. */
export function createSessionEndDrainer<TCapture>(dependencies: SessionEndDrainerDependencies<TCapture>) {
  const clock = dependencies.clock ?? systemClock;
  return async function drainSessionCapturesForEnd(input: { captures: readonly TCapture[]; finishScope: SessionEndCaptureScope | null }) {
    const { captures, finishScope } = input;
    await Promise.all(captures.map(async capture => {
      const drain = dependencies.drainFor(capture);
      try {
        if (drain && finishScope && drain.turnId === finishScope.turnId && drain.answerId === finishScope.answerId && drain.captureRevision === finishScope.captureRevision) {
          let timer: unknown;
          let received: boolean;
          try {
            received = await Promise.race([drain.receipt.then(() => true), new Promise<false>(resolve => { timer = clock.setTimeout(() => resolve(false), 2_000); })]);
          } finally { if (timer !== undefined) clock.clearTimeout(timer); }
          if (!received) throw new Error('END_CAPTURE_FINISH_NOT_RECEIVED');
        }
        if (drain) await drain.finishForEnd(); else await dependencies.finish(capture);
      } catch (error) { dependencies.onFailure(capture, drain, error); }
    }));
    for (const capture of captures) await dependencies.close(capture);
    dependencies.forget?.(captures);
    return { activeStreamsFlushed: captures.length > 0 };
  };
}
