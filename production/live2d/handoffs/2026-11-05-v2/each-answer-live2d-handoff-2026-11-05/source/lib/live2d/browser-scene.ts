import { SceneDirector, outputRms } from './director';
import { parseSceneManifest } from './manifest';
import { loadCoreScript } from './load-core';
import type { SceneEvent, SceneManifest, SceneRenderer, SceneState, SpeechIdentity } from './types';

type SceneInput = { state: SceneState; identity: SpeechIdentity | null; audio: HTMLAudioElement | null; outputAnalyser: AnalyserNode | null };
/** Observes the existing interview player. It never owns, pauses or replaces shared audio. */
export class BrowserInterviewScene {
  private director = new SceneDirector();
  private renderer: SceneRenderer | null = null;
  private controller = new AbortController();
  private input: SceneInput = { state: 'ready', identity: null, audio: null, outputAnalyser: null };
  private loopId = 0;
  private lastFrame = 0;
  private started = 0;
  private disposed = false;
  private samples = new Float32Array(0);
  private resizeObserver: ResizeObserver | null = null;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private onVisibility = () => {
    if (document.hidden) { cancelAnimationFrame(this.loopId); this.director.reset(); try { this.draw(performance.now(), true); } catch { this.fail('render_failed', '면접 장면을 표시하지 못해 이미지로 전환했습니다.'); } }
    else { this.lastFrame = 0; this.loopId = requestAnimationFrame(this.tick); }
  };
  constructor(private canvas: HTMLCanvasElement, private emit: (event: SceneEvent) => void) {}

  async prepare(): Promise<SceneManifest> {
    const response = await fetch('/live2d/scene.json', { cache: 'no-store', signal: this.controller.signal });
    if (!response.ok) throw new Error('장면 설정을 불러오지 못했습니다.');
    const manifest = parseSceneManifest(await response.json(), location.origin);
    if (this.disposed) return manifest;
    if (manifest.status !== 'ready' || !manifest.runtime) { this.emit({ type: 'ready', mode: 'static-fallback' }); return manifest; }
    // Native ESM is generated from the pinned official SDK by setup-live2d-sdk.mjs.
    await loadCoreScript(manifest.runtime.coreUrl, 'Live2DCubismCore', this.controller.signal);
    if (manifest.runtime.lipSync === 'motion-sync') await loadCoreScript(manifest.runtime.motionSyncCoreUrl!, 'Live2DCubismMotionSyncCore', this.controller.signal);
    const rendererModule = await import(/* webpackIgnore: true */ manifest.runtime.moduleUrl) as { createRenderer(): SceneRenderer };
    if (this.disposed) return manifest;
    if (typeof rendererModule.createRenderer !== 'function') throw new Error('Live2D 실행 모듈을 확인해 주세요.');
    this.renderer = rendererModule.createRenderer();
    await this.renderer.prepare(this.canvas, manifest, this.controller.signal);
    if (this.disposed) return manifest;
    const resize = () => {
      const rect = this.canvas.getBoundingClientRect();
      try { this.renderer?.resize(rect.width, rect.height, Math.min(devicePixelRatio || 1, 2)); }
      catch { this.fail('resize_failed', '면접 장면을 표시하지 못해 이미지로 전환했습니다.'); }
    };
    this.resizeObserver = new ResizeObserver(resize); this.resizeObserver.observe(this.canvas); resize();
    if (this.disposed) return manifest;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.started = performance.now();
    if (!document.hidden) this.loopId = requestAnimationFrame(this.tick);
    this.emit({ type: 'ready', mode: 'live2d' });
    return manifest;
  }
  update(input: SceneInput) {
    if (input.identity?.turnId !== this.input.identity?.turnId || input.identity?.speakerId !== this.input.identity?.speakerId) this.director.reset();
    this.input = input;
    if (input.state !== 'speaking' && this.renderer && !this.disposed) {
      try { this.draw(performance.now()); } catch { this.fail('render_failed', '면접 장면을 표시하지 못해 이미지로 전환했습니다.'); }
    }
  }
  private tick = (now: number) => {
    if (this.disposed || document.hidden) return;
    this.loopId = requestAnimationFrame(this.tick);
    if (now - this.lastFrame < 1000 / 30) return;
    try { this.draw(now); }
    catch { this.fail('render_failed', '면접 장면을 표시하지 못해 이미지로 전환했습니다.'); }
  };
  private draw(now: number, hidden = false) {
    const { audio, identity, outputAnalyser, state } = this.input;
    const playing = Boolean(identity && audio && !audio.paused && !audio.ended && !audio.seeking && audio.readyState >= 3 && state === 'speaking' && !hidden);
    let rms = 0;
    if (playing && outputAnalyser) {
      if (this.samples.length !== outputAnalyser.fftSize) this.samples = new Float32Array(outputAnalyser.fftSize);
      outputAnalyser.getFloatTimeDomainData(this.samples); rms = outputRms(this.samples);
    }
    const clock = identity && audio ? { ...identity, src: audio.currentSrc || audio.src, timeSeconds: audio.currentTime, playing } : null;
    const frame = this.director.frame(hidden ? 'paused' : state, clock, rms, Math.max(0, (now - this.started) / 1000), this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 30, this.reducedMotion.matches);
    this.lastFrame = now; this.renderer?.render(frame);
  }
  private fail(code: string, message: string) { this.dispose(); this.emit({ type: 'error', code, message }); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.controller.abort(); cancelAnimationFrame(this.loopId);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver?.disconnect();
    try { this.renderer?.dispose(); } catch { /* A failed renderer must not affect answer storage or session state. */ }
    this.renderer = null; this.director.reset();
    this.samples = new Float32Array(0);
  }
}
