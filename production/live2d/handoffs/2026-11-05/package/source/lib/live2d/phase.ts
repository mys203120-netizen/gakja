import type { Phase } from '@/hooks/useInterviewSession';
import type { SceneState, SpeechIdentity } from './types';
export function sceneStateForPhase(phase: Phase, activeSpeech: SpeechIdentity | null): SceneState {
  if (phase === 'suspended') return 'paused';
  if (phase === 'error') return 'error';
  if (phase === 'speaking_question' || phase === 'speaking_acknowledgement' || (phase === 'ending' && activeSpeech)) return 'speaking';
  if (phase === 'listening') return 'listening';
  if (phase === 'preparing' || phase === 'countdown') return 'initializing';
  if (phase === 'preparing_next' || phase === 'finalizing_transcript' || phase === 'ending') return 'waiting';
  return 'ready';
}
