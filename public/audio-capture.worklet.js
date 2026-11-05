/* Mono 16 kHz, signed little-endian PCM16. Time-weighted resampling uses the actual AudioContext rate. */
class InterviewPCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.enabled = false; this.position = 0; this.area = 0; this.weight = 0; this.samples = [];
    this.ratio = sampleRate / 16000;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'capture') {
        this.enabled = data.enabled;
        if (!data.enabled) this.flush();
      }
      if (data.type === 'flush') { this.flush(); this.port.postMessage({ type: 'flushed', id: data.id }); }
    };
  }
  flush() {
    if (!this.samples.length) return;
    const buffer = new ArrayBuffer(this.samples.length * 2); const view = new DataView(buffer);
    this.samples.forEach((v, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), true));
    this.samples = []; this.port.postMessage({ type: 'pcm', buffer }, [buffer]);
  }
  process(inputs) {
    const channels = inputs[0]; if (!channels || !channels.length) return true;
    if (!this.enabled) { this.position = 0; this.area = 0; this.weight = 0; return true; }
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0; for (const channel of channels) value += channel[i] / channels.length;
      let left = 1;
      while (left > 0.000001) {
        const portion = Math.min(left, this.ratio - this.position);
        this.area += value * portion; this.weight += portion; this.position += portion; left -= portion;
        if (this.position >= this.ratio - 0.000001) {
          this.samples.push(this.area / this.weight); this.area = 0; this.weight = 0; this.position = 0;
          if (this.samples.length >= 1600) this.flush();
        }
      }
    }
    return true;
  }
}
registerProcessor('interview-pcm', InterviewPCM);
