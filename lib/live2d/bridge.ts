import { isSpeakerId, type SceneCommand } from './types';
export const sceneChannel = 'each-answer-scene-v1';
export type SceneEnvelope = { channel: typeof sceneChannel; sessionId: string; sequence: number; command: SceneCommand };
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
export function isSceneCommand(value: unknown): value is SceneCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  if (command.type === 'speak') return id(command.turnId) && isSpeakerId(command.speakerId) && typeof command.audioUrl === 'string' && command.audioUrl.length > 0 && command.audioUrl.length < 4096;
  if (command.type === 'cancel') return id(command.turnId);
  if (command.type === 'setListening') return typeof command.listening === 'boolean';
  return ['prepare', 'pause', 'resume', 'dispose'].includes(String(command.type));
}
/** Monotonic commands prevent late bridge messages from reviving cancelled speech. */
export class SceneBridgeGate {
  sessionId: string | null = null;
  private sequence = -1;
  accept(data: unknown): SceneEnvelope | null {
    if (typeof data !== 'string' || data.length > 8192) return null;
    let envelope: SceneEnvelope;
    try { envelope = JSON.parse(data); } catch { return null; }
    if (!envelope || envelope.channel !== sceneChannel || !id(envelope.sessionId) || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0 || !isSceneCommand(envelope.command)) return null;
    if (!this.sessionId && envelope.command.type !== 'prepare') return null;
    if (this.sessionId && this.sessionId !== envelope.sessionId || envelope.sequence <= this.sequence) return null;
    this.sessionId = envelope.sessionId; this.sequence = envelope.sequence;
    return envelope;
  }
}
