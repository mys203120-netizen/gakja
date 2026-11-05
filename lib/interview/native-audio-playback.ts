type PlaybackAction = 'play' | 'pause' | 'return_to_check';
/** The shared audio element may be reused for closing while a prior question is pending. */
export function playNativeInterviewAudio(options: {
  audio: HTMLAudioElement;
  url: string;
  current(): boolean;
  action(): PlaybackAction;
  onPlaying(): void;
  onEnded(): void;
  onBlocked(): void;
  registerCancel(cancel: () => void): void;
  unregisterCancel(cancel: () => void): void;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { audio } = options;
    let announced = false, settled = false;
    const cleanup = () => {
      audio.removeEventListener('playing', playing);
      audio.removeEventListener('ended', ended);
      audio.removeEventListener('error', failed);
      options.unregisterCancel(cancel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      reject(error instanceof Error ? error : new Error('면접관 음성을 재생하지 못했습니다. 다시 듣기를 눌러 주세요.'));
    };
    const cancel = () => {
      if (settled) return;
      audio.pause(); fail(new DOMException('면접 음성 재생이 취소되었습니다.', 'AbortError'));
    };
    const playing = () => {
      if (settled) return;
      // Native DOM listeners cannot propagate rejected control-flow exceptions
      // back into their awaiting promise unless we catch them here.
      try {
        if (!options.current()) { cancel(); return; }
        const action = options.action();
        if (action !== 'play') { audio.pause(); if (action === 'return_to_check') options.onBlocked(); return; }
        if (!announced) { options.onPlaying(); announced = true; }
      } catch (error) { audio.pause(); fail(error); }
    };
    const ended = () => {
      if (settled) return;
      try {
        if (!options.current()) { cancel(); return; }
        options.onEnded(); settled = true; cleanup(); resolve();
      } catch (error) { fail(error); }
    };
    const failed = () => fail(new Error('면접관 음성을 재생하지 못했습니다. 다시 듣기를 눌러 주세요.'));
    audio.addEventListener('playing', playing); audio.addEventListener('ended', ended); audio.addEventListener('error', failed);
    options.registerCancel(cancel); audio.src = options.url;
    try {
      void audio.play().catch((error: unknown) => fail(new Error(error instanceof Error && error.name === 'NotAllowedError' ? '브라우저가 음성 재생을 일시 중지했습니다. 다시 듣기를 눌러 주세요.' : '음성을 재생하지 못했습니다. 다시 듣기를 눌러 주세요.')));
    } catch (error) { fail(error); }
  });
}
