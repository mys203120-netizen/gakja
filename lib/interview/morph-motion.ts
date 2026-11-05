export type MorphRole = 'ready' | 'processing' | 'interviewer' | 'candidate';
export type MorphMotion = 'silence' | 'processing' | 'interviewer' | 'candidate';

export function morphRoleForPhase(phase: string): MorphRole {
  if (phase === 'listening') return 'candidate';
  if (phase === 'speaking_question' || phase === 'speaking_acknowledgement') return 'interviewer';
  if (['preparing', 'finalizing_transcript', 'preparing_next', 'ending'].includes(phase)) return 'processing';
  return 'ready';
}

/** Shared motion for either voice. VAD gates the microphone; RMS supplies the pulse envelope. */
export class MorphMotionTracker {
  private role: MorphRole = 'ready';
  private lastTick: number | null = null;
  private lastVoice = -Infinity;
  private voiced = false;
  private energy = 0;
  private pulseScale = 1;
  private voiceCycleMs = 0;

  step(role: MorphRole, rms: number, now: number, candidateSpeech: boolean | null = null) {
    const time = Math.max(this.lastTick ?? 0, Number.isFinite(now) ? now : this.lastTick ?? 0);
    const elapsed = this.lastTick === null ? 16 : Math.min(100, Math.max(0, time - this.lastTick));
    this.lastTick = time;
    if (role !== this.role) {
      this.role = role;
      this.lastVoice = -Infinity;
      this.voiced = false;
      this.energy = 0;
      this.pulseScale = 1;
      this.voiceCycleMs = 0;
    }
    const level = Number.isFinite(rms) ? Math.max(0, Math.min(1, rms)) : 0;
    const listeningToAudio = role === 'candidate' || role === 'interviewer';
    const threshold = this.voiced ? .006 : .01;
    const detected = listeningToAudio && (role === 'candidate' && candidateSpeech !== null ? candidateSpeech && level >= .001 : level >= threshold);
    if (detected) this.lastVoice = time;
    this.voiced = listeningToAudio && time - this.lastVoice < 220;
    const motion: MorphMotion = this.voiced && (role === 'candidate' || role === 'interviewer') ? role : role === 'processing' ? 'processing' : 'silence';
    // A negative VAD gate releases the envelope even when background RMS remains high.
    const targetEnergy = detected ? Math.min(1, level * 20) : 0;
    this.energy += (targetEnergy - this.energy) * (1 - Math.exp(-elapsed / (targetEnergy > this.energy ? 70 : 240)));
    if (!detected && this.energy < .0005) this.energy = 0;
    if (this.voiced) this.voiceCycleMs += elapsed;
    else this.voiceCycleMs = 0;
    // The same small-to-large cycle keeps a sustained vowel alive. Its amplitude comes
    // only from the observed voice envelope; silence has a neutral scale of exactly 1.
    const cycle = (1 - Math.cos(this.voiceCycleMs / 720 * Math.PI * 2)) / 2;
    const targetScale = this.voiced ? 1 + this.energy * (-.1 + .17 * cycle) : 1;
    const pulseTimeConstant = this.voiced ? 45 : 180;
    this.pulseScale += (targetScale - this.pulseScale) * (1 - Math.exp(-elapsed / pulseTimeConstant));
    this.pulseScale = Math.min(1.07, Math.max(.9, this.pulseScale));
    if (!this.voiced && Math.abs(this.pulseScale - 1) < .0005) this.pulseScale = 1;
    return { motion, energy: this.energy, pulseScale: this.pulseScale, playbackRate: 1, sway: 0 };
  }
}
