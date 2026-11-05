import type { TurnWorkClock } from '../../server/turn-work';
export class WorkTestClock implements TurnWorkClock {
  time = 0; private sequence = 0; private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, milliseconds: number) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + milliseconds, callback }); return id; };
  clearTimeout = (timer: unknown) => { this.timers.delete(timer as number); };
  advance(milliseconds: number) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = target;
  }
}
