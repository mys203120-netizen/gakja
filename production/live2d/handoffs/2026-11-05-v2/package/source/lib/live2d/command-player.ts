import { sameOriginAsset } from './manifest';
import type { SceneCommand, SceneEvent, SceneState, SpeechIdentity } from './types';

export type CommandAudio = Pick<HTMLAudioElement, 'src' | 'currentTime' | 'paused' | 'ended' | 'play' | 'pause' | 'load' | 'removeAttribute' | 'addEventListener' | 'removeEventListener'>;
/** Used only by the standalone/WebView endpoint; the existing interview keeps its own player. */
export class SceneCommandPlayer {
  private identity: SpeechIdentity | null = null;
  private state: SceneState = 'ready';
  private generation = 0;
  private announced = false;
  private disposed = false;
  private wantPaused = false;
  private playing = () => {
    if (this.disposed || !this.identity) return;
    if (this.wantPaused) { this.audio.pause(); return; }
    this.setState('speaking');
    if (!this.announced) { this.announced = true; this.emit({ type: 'speechStarted', ...this.identity }); }
  };
  private ended = () => {
    if (!this.identity || !this.announced || !this.audio.ended) return;
    const ended = this.identity; this.identity = null; this.announced = false;
    this.setState('waiting'); this.emit({ type: 'speechEnded', ...ended });
  };
  private paused = () => {
    if (this.audio.paused && this.identity && !this.audio.ended && this.announced) { this.wantPaused = true; this.setState('paused'); }
  };
  private failed = () => {
    if (!this.identity) return;
    this.cancel(); this.setState('error'); this.emit({ type: 'error', code: 'audio_failed', message: '면접관 음성을 재생하지 못했습니다.' });
  };
  constructor(private audio: CommandAudio, private origin: string, private emit: (event: SceneEvent) => void, private update: (state: SceneState, identity: SpeechIdentity | null) => void) {
    audio.addEventListener('playing', this.playing); audio.addEventListener('ended', this.ended);
    audio.addEventListener('pause', this.paused); audio.addEventListener('error', this.failed);
  }
  private setState(state: SceneState) { this.state = state; this.update(state, this.identity); this.emit({ type: 'stateChanged', state }); }
  private cancel() {
    ++this.generation;
    const previous = this.identity; this.identity = null; this.announced = false;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (previous) this.emit({ type: 'speechCancelled', ...previous });
    this.setState('waiting');
  }
  async execute(command: SceneCommand): Promise<void> {
    if (this.disposed) return;
    if (command.type === 'prepare') { if (!this.identity) this.setState('ready'); return; }
    if (command.type === 'dispose') { this.dispose(); return; }
    if (command.type === 'cancel') { if (this.identity?.turnId === command.turnId) this.cancel(); return; }
    if (command.type === 'setListening') { this.cancel(); this.setState(command.listening ? 'listening' : 'waiting'); return; }
    if (command.type === 'pause') { this.wantPaused = true; this.audio.pause(); this.setState('paused'); return; }
    if (command.type === 'resume') {
      this.wantPaused = false;
      if (!this.identity) { this.setState('ready'); return; }
    }
    if (command.type === 'speak') {
      const url = sameOriginAsset(command.audioUrl, this.origin);
      this.cancel(); this.wantPaused = false;
      this.identity = { turnId: command.turnId, speakerId: command.speakerId };
      this.audio.src = url; this.audio.currentTime = 0; this.setState('waiting');
    }
    const epoch = this.generation;
    try {
      await this.audio.play();
      if (epoch !== this.generation || this.disposed) return;
      // Speech starts exclusively from native `playing`, never promise resolution.
    } catch {
      if (epoch === this.generation && !this.disposed && !this.wantPaused) this.failed();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.cancel(); this.disposed = true;
    this.audio.removeEventListener('playing', this.playing); this.audio.removeEventListener('ended', this.ended);
    this.audio.removeEventListener('pause', this.paused); this.audio.removeEventListener('error', this.failed);
  }
}
