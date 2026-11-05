import { speakerIds, type SceneFrame, type SceneState, type SpeechClock, type SpeakerId } from './types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** Deterministic, bounded animation rules. No microphone, network, LLM or wall-clock timers. */
export class SceneDirector {
  private mouth = 0;
  private previousSpeaker: SpeakerId | null = null;

  reset() { this.mouth = 0; this.previousSpeaker = null; }

  frame(state: SceneState, clock: SpeechClock | null, rms: number, elapsedSeconds: number, deltaSeconds: number, reducedMotion = false): SceneFrame {
    const dt = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, .1);
    const playing = state === 'speaking' && clock?.playing === true;
    const speaker = playing ? clock.speakerId : null;
    if (speaker !== this.previousSpeaker) this.mouth = 0;
    this.previousSpeaker = speaker;
    const energy = Number.isFinite(rms) ? clamp((rms - .012) * 7, 0, .85) : 0;
    // Silence, pause, cancellation and non-speakers close immediately. Speech uses short attack/release.
    if (!playing || energy === 0) this.mouth = 0;
    else this.mouth += (energy - this.mouth) * (1 - Math.exp(-dt / (energy > this.mouth ? .035 : .065)));
    const parameters = {} as SceneFrame['parameters'];
    for (const [index, id] of speakerIds.entries()) {
      const active = speaker === id;
      const stopped = state === 'paused' || state === 'error' || state === 'initializing';
      const t = Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0);
      const cycle = index === 0 ? 5.7 : 7.1;
      const blinkTime = (t + (index === 0 ? 1.3 : 3.4)) % cycle;
      const blink = blinkTime < .19 ? 1 - Math.sin(blinkTime / .19 * Math.PI) : 1;
      const movement = stopped || reducedMotion ? 0 : state === 'listening' ? .25 : .6;
      parameters[id] = {
        ParamEyeLOpen: stopped ? 1 : blink,
        ParamEyeROpen: stopped ? 1 : blink,
        ParamEyeBallX: Math.sin(t * .19 + index * 2.1) * .045 * movement,
        ParamEyeBallY: Math.sin(t * .13 + index * 1.7) * .025 * movement,
        ParamAngleX: Math.sin(t * .23 + index * 2.4) * 1.8 * movement,
        ParamAngleY: Math.sin(t * .17 + index * 1.5) * 1.1 * movement,
        ParamAngleZ: Math.sin(t * .21 + index * 2) * .8 * movement,
        ParamBreath: stopped || reducedMotion ? .5 : .5 + Math.sin(t * (index === 0 ? 1.35 : 1.16) + index * 2) * .12,
        ParamMouthOpenY: active ? this.mouth : 0,
        ParamMouthForm: active ? .06 : 0,
        // Remains neutral until hand/desk occlusion and rig are approved. No invented hand animation.
        ParamQuestionGesture: 0,
      };
    }
    return { state, deltaSeconds: dt, elapsedSeconds, speech: clock, parameters };
  }
}

export function outputRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
