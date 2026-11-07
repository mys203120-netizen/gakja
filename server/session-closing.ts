import { randomUUID } from 'node:crypto';
import type { InterviewSession } from './protocol';
import { checkpointSession, type ClosingUtterance } from './session-runtime';
import { runTurnWorkStage, type TurnWorkContext } from './turn-work';
import type { SpeechSynthesisSettings } from './providers/speech-audio-cache';
import type { ConversationEvent } from './storage/conversation-log';

export interface SessionClosingDependencies {
  ownerId: string;
  synthesizeSpeech: typeof import('./providers/clova-tts').synthesizeSpeech;
  interviewerVoiceDefaults: typeof import('./providers/clova-tts').interviewerVoiceDefaults;
  audioOwners: Map<string, string>;
  journal(session: InterviewSession, event: ConversationEvent): unknown;
  HttpError: new (status: number, message: string, code?: string) => Error;
}
/** Shared original non-evaluative closing preparation. Provider work remains
 * outside persistence; the caller owns its explicit progress/final commit. */
export function createSessionClosingPreparer(dependencies: SessionClosingDependencies) {
  const { synthesizeSpeech, interviewerVoiceDefaults, audioOwners, journal, HttpError } = dependencies;
  const owner = { id: dependencies.ownerId };
  return async function prepareClosing(session: InterviewSession, reason: ClosingUtterance['reason'], workContext?: TurnWorkContext): Promise<ClosingUtterance> {
  workContext?.assertLive();
  if (session.runtime?.closingUtterance) return session.runtime.closingUtterance;
  const epoch = session.runtime!.epoch;
  const delivered = [...(session.questionPresentations ?? [])].reverse().find(item => item.startedAtMs !== null);
  const last = session.turns.find(turn => turn.id === delivered?.turnId) ?? session.turns.at(-1);
  const interviewerId = last?.interviewerId ?? 'interviewer-1', role = interviewerId === 'interviewer-1' ? 'primary' : 'secondary';
  const settings = (last?.metadata as { voiceSettings?: { question?: SpeechSynthesisSettings } } | undefined)?.voiceSettings;
  const speaker = settings?.question?.speaker ?? (role === 'primary' ? process.env.CLOVA_VOICE_SPEAKER || interviewerVoiceDefaults.primary : process.env.CLOVA_VOICE_SECOND_SPEAKER || interviewerVoiceDefaults.secondary);
  const text = reason === 'technical_failure' ? '연결 상태를 확인한 뒤 다시 진행해 주세요.' : '면접은 여기까지 하겠습니다. 수고하셨습니다.';
  let voiceSettings: SpeechSynthesisSettings | undefined;
  const audioUrl = await runTurnWorkStage(workContext, 35_000, stage => synthesizeSpeech(text, speaker, { signal: stage.signal, role, ...(settings?.question ? { settings: settings.question } : {}), onTiming: timing => { voiceSettings = timing.settings; } }));
  workContext?.assertLive();
  if (session.runtime!.epoch !== epoch || session.status === 'completed') throw new HttpError(409, '종료된 면접의 늦은 음성 결과를 무시했습니다.');
  const closing: ClosingUtterance = { id: randomUUID(), text, audioUrl, interviewerId, nonEvaluative: true, reason, ...(voiceSettings ? { voiceSettings } : {}) };
  session.runtime!.closingUtterance = closing; audioOwners.set(audioUrl, owner.id);
  checkpointSession(session, 'closing_prepared');
  void journal(session, { type: 'closing.prepared', actor: 'server', role: interviewerId, payload: closing });
  return closing;
}

}
