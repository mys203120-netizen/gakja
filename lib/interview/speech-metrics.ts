export interface SpeechMetricInput {
  rawTranscript: string;
  durationMs: number;
  speakingMs: number | null;
  firstSpeechMs: number | null;
}

export function calculateSpeechMetrics(input: SpeechMetricInput) {
  const text = input.rawTranscript.normalize('NFC');
  const characterCount = [...text].filter(c => /[\p{L}\p{N}]/u.test(c)).length;
  const eojeolCount = text.trim() ? text.trim().split(/\s+/u).filter(s => /[\p{L}\p{N}]/u.test(s)).length : 0;
  const hangulSyllableCount = [...text].filter(c=>/[가-힣]/u.test(c)).length;
  const durationMs = Number.isFinite(input.durationMs) && input.durationMs > 0 ? input.durationMs : null;
  const speakingMs = durationMs !== null && input.speakingMs !== null && Number.isFinite(input.speakingMs) && input.speakingMs >= 0 && input.speakingMs <= durationMs ? input.speakingMs : null;
  const enough = durationMs !== null && durationMs >= 5000 && characterCount >= 10;
  const cpm = enough ? characterCount * 60000 / durationMs! : null;
  return {
    durationMs, speakingMs,
    silenceMs: durationMs !== null && speakingMs !== null ? durationMs-speakingMs : null,
    firstSpeechMs: durationMs !== null && input.firstSpeechMs !== null && Number.isFinite(input.firstSpeechMs) && input.firstSpeechMs >= 0 && input.firstSpeechMs <= durationMs ? input.firstSpeechMs : null,
    characterCount, eojeolCount, hangulSyllableCount,
    cpm,
    speakingCpm: enough && speakingMs !== null && speakingMs >= 1000 ? characterCount*60000/speakingMs : null,
    eojeolPerMinute: enough ? eojeolCount*60000/durationMs! : null,
    hangulSyllablesPerMinuteApprox: enough ? hangulSyllableCount*60000/durationMs! : null,
    pace: cpm === null ? null : cpm < 300 ? 'slow' : cpm <= 350 ? 'reference_range' : 'fast',
    policy: {version:'speech-v1', minimumDurationMs:5000, minimumCharacterCount:10, characterDefinition:'Unicode letters and numbers; spaces and punctuation excluded', paceBasis:'user coaching threshold; not an admissions criterion'}
  };
}
