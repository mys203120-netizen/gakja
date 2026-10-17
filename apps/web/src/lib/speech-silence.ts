import { validateSpeechTelemetry } from './speech-analysis';

export const NO_SPEECH_MESSAGE = '말소리가 확인되지 않았어요. 마이크를 확인해 다시 녹음하거나 직접 입력해 주세요.';

type PcmObservation = { durationMs: number; silent: boolean };
/** Inspect all PCM samples. Container headers, file size and VAD labels alone are not speech evidence. */
function pcmObservation(bytes: Buffer): PcmObservation | null {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  const declaredEnd = bytes.readUInt32LE(4) + 8;
  if (declaredEnd !== bytes.length) return null;
  let format: { encoding: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  const chunks: Array<{ start: number; length: number }> = [];
  for (let offset = 12; offset + 8 <= declaredEnd;) {
    const id = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > declaredEnd) return null;
    if (id === 'fmt ' && length >= 16) {
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
      // WAVE_FORMAT_EXTENSIBLE: accept only the exact PCM/float subformat GUID.
      if (format.encoding === 0xfffe) {
        if (length < 40 || bytes.readUInt16LE(start + 16) < 22 || bytes.readUInt16LE(start + 18) !== format.bits || bytes.toString('hex', start + 28, start + 40) !== '00001000800000aa00389b71') return null;
        format.encoding = bytes.readUInt32LE(start + 24);
      }
    } else if (id === 'data') chunks.push({ start, length });
    offset = start + length + (length % 2);
  }
  if (!format || !chunks.length || ![1, 3].includes(format.encoding) || format.channels < 1 || format.channels > 32 || format.sampleRate < 8000 || format.sampleRate > 384000) return null;
  const width = format.bits / 8;
  if (format.encoding === 1 && ![8, 16, 24, 32].includes(format.bits) || format.encoding === 3 && ![32, 64].includes(format.bits) || format.blockAlign !== width * format.channels) return null;
  if (chunks.some(chunk => !chunk.length || chunk.length % format.blockAlign)) return null;
  const frames = chunks.reduce((sum, chunk) => sum + chunk.length / format!.blockAlign, 0);
  // A very short clip is insufficient evidence; do not confuse it with an empty answer.
  if (frames / format.sampleRate < .75) return null;
  let silent = true;
  for (const chunk of chunks) for (let offset = chunk.start; offset < chunk.start + chunk.length; offset += width) {
    const value = format.encoding === 3 ? (width === 4 ? bytes.readFloatLE(offset) : bytes.readDoubleLE(offset))
      : format.bits === 8 ? (bytes[offset] - 128) / 128
      : bytes.readIntLE(offset, width) / 2 ** (format.bits - 1);
    if (!Number.isFinite(value) || Math.abs(value) > 1) return null;
    // Less than one 16-bit step is digital silence, not a low-volume voice threshold.
    if (Math.abs(value) > 1 / 32768) silent = false;
  }
  return { durationMs: frames * 1000 / format.sampleRate, silent };
}

/** Conservative preflight: legacy/missing/partial telemetry never becomes a claim of silence. */
export function observedSilence(bytes: Buffer, durationSeconds: number, telemetry?: unknown): 'pcm' | 'microphone' | null {
  const pcm = pcmObservation(bytes);
  // Actual nonzero audio overrides a mistaken or fabricated client VAD label.
  if (pcm) return pcm.silent ? 'pcm' : null;
  const timing = validateSpeechTelemetry(telemetry);
  if (!timing || timing.durationMs < 1000 || timing.speechSegments.length || timing.coverage.truncated || timing.limitations.includes('capture-gaps') || timing.limitations.includes('high-background-level')) return null;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || Math.abs(timing.durationMs - durationSeconds * 1000) > Math.max(250, timing.durationMs * .05)) return null;
  // Old telemetry has no peak: zero VAD segments by itself cannot prove silence.
  if (timing.analysis.peakRms === undefined || timing.analysis.peakRms > .00001 || timing.analysis.peakRms < timing.analysis.noiseFloorRms) return null;
  if (timing.coverage.observedMs / timing.durationMs < .98 || timing.coverage.maxGapMs > Math.min(200, timing.sampleIntervalMs * 2)) return null;
  return 'microphone';
}
