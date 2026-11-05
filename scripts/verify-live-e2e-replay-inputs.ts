import dotenv from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank } from '../server/data/prepared-question-bank';
import { readSpeechAudio, speechAudioCacheId } from '../server/providers/clova-tts';
import { assertReplayBank, createReplayCheckpoint, replayHash, type ReplayBaseline } from './live-e2e-replay';
import { decodeSyntheticAudio } from './live-e2e-audio';
import type { InterviewSession } from '../server/protocol';

dotenv.config({ path: '.env.local', quiet: true });
const sources = process.argv.slice(2);
if (!sources.length) throw new Error('REPLAY_SOURCES_REQUIRED');
const context = await loadInterviewContext(), bank = await loadQuestionBank(context);
if (context.errors.length || !bank) throw new Error('VERIFIED_BANK_REQUIRED');
const manifest: Record<string, any> = { generatedAt: new Date().toISOString(), bankIdentity: bank.key,
  bankContentSha256: bank.contentSha256, providerCalls: 0, answers: [], sources: [],
  limits: ['Historical runs did not store audio hashes. PCM hashes are reconstructed from the still-cached original synthesis and recorded trailing silence, then frozen for replay.', 'No answers are copied into live engine state.'] };
for (const sourcePath of sources) {
  if (!/^artifacts\/live-interview-e2e-[a-zA-Z0-9-]+\.json$/u.test(sourcePath)) throw new Error('REPLAY_SOURCE_PATH_INVALID');
  const bytes = await readFile(sourcePath), baseline = JSON.parse(bytes.toString()) as ReplayBaseline;
  const original = JSON.parse(await readFile(`data/sessions/${baseline.sessionId}.json`, 'utf8')) as InterviewSession;
  assertReplayBank(baseline, bank, original);
  const checkpoint = createReplayCheckpoint(context, bank, original, 'synthetic-replay-input-verification');
  if (checkpoint.turns.some(turn => turn.answerId || turn.rawTranscript)) throw new Error('ANSWER_AT_UNANSWERED_CHECKPOINT');
  manifest.sources.push({ sourcePath, sourceSha256: replayHash(bytes), originalSessionId: original.id,
    originalSessionPlanSha256: replayHash(JSON.stringify(original.plan)), answerCount: baseline.turns.length,
    checkpointPolicy: checkpoint.runtime?.runtimePolicy });
  for (const row of baseline.turns) {
    const intended = row.syntheticStudent.text, originalTurn = original.turns.find(turn => turn.id === row.turnId);
    if (!originalTurn || originalTurn.rawTranscript !== row.capture.rawTranscript) throw new Error('ORIGINAL_TRANSCRIPT_CHANGED');
    const settings = { speaker: 'nara', speed: 0, pitch: 0, volume: 0, format: 'mp3' as const };
    const audioId = intended ? speechAudioCacheId(intended, settings) : null, audio = audioId ? await readSpeechAudio(audioId) : null;
    if (audioId && !audio) throw new Error('ORIGINAL_CACHED_AUDIO_MISSING');
    const decoded = audio ? await decodeSyntheticAudio(audio) : { pcm: Buffer.alloc(row.capture.pcmBytes), durationMs: row.capture.audioDurationMs };
    const tailMs = intended ? Number(row.capture.trailingSilenceMs ?? baseline.trailingSilenceMs ?? 0) : 0;
    const pcm = tailMs ? Buffer.concat([decoded.pcm, Buffer.alloc(tailMs * 32)]) : decoded.pcm;
    if (pcm.length !== row.capture.pcmBytes) throw new Error(`PCM_RECONSTRUCTION_MISMATCH_${row.index}`);
    manifest.answers.push({ sourcePath, sourceIndex: row.index, scenario: row.scenario, answerSha256: replayHash(intended),
      mp3Sha256: audio ? replayHash(audio) : null, reconstructedBaselinePcmSha256: replayHash(pcm),
      pcmBytes: pcm.length, tailMs, decodedAudioDurationMs: decoded.durationMs,
      originalTranscriptSha256: replayHash(originalTurn.rawTranscript ?? '') });
  }
}
await writeFile('artifacts/live-e2e-replay-input-manifest.json', JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ output: 'artifacts/live-e2e-replay-input-manifest.json', sources: manifest.sources.length,
  frozenAnswerInputs: manifest.answers.length, providerCalls: 0 }));
