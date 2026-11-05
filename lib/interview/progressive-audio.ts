import type { PreparedTurn } from '../../server/protocol';
import type { AcknowledgementReady } from './next-turn-stream';
type Plan = { acknowledgement?: AcknowledgementReady; acknowledgementPromise?: Promise<void>; acknowledgementDone: boolean; acknowledgementFailed?: boolean; questionPromise?: Promise<void>; questionFailed?: boolean };
export function canStartListeningAfterAudio(phase: string, paused: boolean) { return !paused && !['suspended', 'ending', 'completed'].includes(phase); }
export class ProgressiveInterviewAudio {
  private plans = new Map<string, Plan>();
  constructor(private callbacks: {
    prepare(url: string): Promise<string>;
    wait(): Promise<void>;
    current(): boolean;
    play(url: string, onPlaying: () => void): Promise<void>;
    acknowledgementPlaying(event: AcknowledgementReady): void;
    acknowledgementEnded(event: AcknowledgementReady): void;
    questionPlaying(turn: PreparedTurn): void;
  }) {}
  private assertCurrent() { if (!this.callbacks.current()) throw new DOMException('종료한 면접의 음성을 무시했습니다.', 'AbortError'); }
  private plan(id: string) { let value = this.plans.get(id); if (!value) { value = { acknowledgementDone: false }; this.plans.set(id, value); } return value; }
  prepareTurn(turn: PreparedTurn) { return this.callbacks.prepare(turn.questionAudioUrl); }
  acknowledge(event: AcknowledgementReady) {
    this.assertCurrent();
    const plan = this.plan(event.turnId);
    if (plan.acknowledgement && (plan.acknowledgement.acknowledgement !== event.acknowledgement || plan.acknowledgement.acknowledgementAudioUrl !== event.acknowledgementAudioUrl)) throw new Error('연결 멘트와 다음 질문의 응답이 일치하지 않습니다.');
    plan.acknowledgement = event;
    if (plan.acknowledgementDone) return Promise.resolve();
    if (!plan.acknowledgementPromise) {
      plan.acknowledgementPromise = (async () => {
        const audio = await this.callbacks.prepare(event.acknowledgementAudioUrl);
        await this.callbacks.wait(); this.assertCurrent();
        await this.callbacks.play(audio, () => { this.assertCurrent(); this.callbacks.acknowledgementPlaying(event); });
        this.assertCurrent(); plan.acknowledgementDone = true; this.callbacks.acknowledgementEnded(event);
      })().catch(error => { plan.acknowledgementFailed = true; throw error; });
      void plan.acknowledgementPromise.catch(() => {});
    }
    return plan.acknowledgementPromise;
  }
  playTurn(turn: PreparedTurn) {
    this.assertCurrent();
    const plan = this.plan(turn.id);
    if (!plan.questionPromise) {
      plan.questionPromise = (async () => {
        const questionAudio = this.prepareTurn(turn);
        if (turn.acknowledgement && turn.acknowledgementAudioUrl) await this.acknowledge({ type: 'acknowledgement_ready', turnId: turn.id, acknowledgement: turn.acknowledgement, acknowledgementAudioUrl: turn.acknowledgementAudioUrl, interviewerId: turn.interviewerId });
        else if (plan.acknowledgementPromise) await plan.acknowledgementPromise;
        const audio = await questionAudio;
        await this.callbacks.wait(); this.assertCurrent();
        await this.callbacks.play(audio, () => { this.assertCurrent(); this.callbacks.questionPlaying(turn); });
        this.assertCurrent();
      })().catch(error => { plan.questionFailed = true; throw error; });
      void plan.questionPromise.catch(() => {});
    }
    return plan.questionPromise;
  }
  retry(id: string) { const plan = this.plans.get(id); if (plan) { if (plan.questionFailed) { plan.questionPromise = undefined; plan.questionFailed = false; } if (plan.acknowledgementFailed && !plan.acknowledgementDone) { plan.acknowledgementPromise = undefined; plan.acknowledgementFailed = false; } } }
}
