const scripts = new Map<string, Promise<void>>();

/** Licensed Core files are supplied locally by the operator, never fetched from an unofficial CDN. */
export async function loadCoreScript(url: string, globalName: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (globalName in globalThis) return;
  let task = scripts.get(url);
  if (!task) {
    task = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script'); script.src = url; script.async = true;
      const timer = window.setTimeout(() => done(new Error('Live2D Core를 불러오는 시간이 초과되었습니다.')), 20_000);
      const done = (error?: Error) => {
        window.clearTimeout(timer); script.onload = null; script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolve();
      };
      script.onload = () => done(globalName in globalThis ? undefined : new Error('제공된 Live2D Core 파일을 확인해 주세요.'));
      script.onerror = () => done(new Error('Live2D Core 파일이 필요합니다.'));
      document.head.appendChild(script);
    });
    scripts.set(url, task);
    void task.catch(() => { if (scripts.get(url) === task) scripts.delete(url); });
  }
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void task!.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
