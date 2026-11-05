export const speakerIds = ['interviewer-1', 'interviewer-2'] as const;
export type SpeakerId = typeof speakerIds[number];
export type SceneState = 'initializing' | 'ready' | 'speaking' | 'listening' | 'waiting' | 'paused' | 'error';
export type SpeechIdentity = { turnId: string; speakerId: SpeakerId };
export type SpeechClock = SpeechIdentity & { src: string; timeSeconds: number; playing: boolean };
export type SceneFrame = {
  state: SceneState;
  deltaSeconds: number;
  elapsedSeconds: number;
  speech: SpeechClock | null;
  parameters: Record<SpeakerId, Record<string, number>>;
};
export type SceneModel = {
  speakerId: SpeakerId;
  url: string;
  /** Pixel coordinates in the shared scene canvas, NOT normalized units or CSS cover transforms. */
  layout: { centerX: number; centerY: number; width: number; height: number };
  motionSyncUrl?: string;
};
export type SceneLayer = { id: string; url: string; order: number };
/** Registration summary produced from a delivery report. Structural validation
 * of this summary is not a replacement for executing the referenced checks. */
export type SceneValidation = {
  deliveryId: string;
  modelKind: 'dedicated' | 'sample';
  assetValidationPassed: boolean;
  modelLoadVerified: boolean;
  motionSyncVerified: boolean;
  runtimeQAComplete: boolean;
  releaseReady: boolean;
  reportSha256: string;
};
export type SceneManifest = {
  version: 1;
  status: 'blocked' | 'ready';
  canvas: { width: number; height: number };
  fallback: string;
  runtime: { moduleUrl: string; coreUrl: string; motionSyncCoreUrl?: string; lipSync: 'amplitude' | 'motion-sync' } | null;
  models: SceneModel[];
  /** Full-canvas RGBA layers. Models have draw order 100 and 110. */
  layers: SceneLayer[];
  blockers: string[];
  /** Required before enabling dedicated-model development rendering. */
  validation?: SceneValidation;
};
/** This is our application adapter contract, not a claimed Live2D SDK API. */
export interface SceneRenderer {
  prepare(canvas: HTMLCanvasElement, manifest: SceneManifest, signal: AbortSignal): Promise<void>;
  render(frame: SceneFrame): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
}
export type SceneEvent =
  | { type: 'ready'; mode: 'live2d' | 'static-fallback' }
  | ({ type: 'speechStarted' | 'speechEnded' | 'speechCancelled' } & SpeechIdentity)
  | { type: 'stateChanged'; state: SceneState }
  | { type: 'error'; code: string; message: string };
export type SceneCommand =
  | { type: 'prepare' }
  | ({ type: 'speak'; audioUrl: string } & SpeechIdentity)
  | { type: 'cancel'; turnId: string }
  | { type: 'pause' | 'resume' | 'dispose' }
  | { type: 'setListening'; listening: boolean };
export function isSpeakerId(value: unknown): value is SpeakerId {
  return value === 'interviewer-1' || value === 'interviewer-2';
}
