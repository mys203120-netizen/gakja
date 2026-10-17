/** The URL is the source of truth for preparation, including Chat/Live navigation. */
export type InterviewSetupState = {
  mode: 'basic' | 'document' | 'major' | 'university';
  followups: boolean; pressure: boolean; reactions: boolean;
  difficulty: 'standard' | 'deep'; timing: 'end' | 'turn';
  count: number; panelistCount: number; advanced: boolean;
};
type Search = Pick<URLSearchParams, 'get' | 'has' | 'toString'>;
const modes = ['basic', 'document', 'major', 'university'];
function integer(value: string | null, fallback: number, max: number) {
  return value && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max ? Number(value) : fallback;
}
export function hasInterviewSelection(params: Search) {
  return Boolean(params.get('questionId') || params.get('briefingId') || params.get('activityId'));
}
export function interviewSetupState(params: Search): InterviewSetupState {
  const reactions = params.get('reactions') === '1';
  return {
    mode: (modes.includes(params.get('mode') || '') ? params.get('mode') : 'basic') as InterviewSetupState['mode'],
    followups: params.get('followups') === '1', pressure: params.get('pressure') === '1', reactions,
    difficulty: params.get('difficulty') === 'deep' ? 'deep' : 'standard',
    timing: reactions || params.get('feedback') === 'turn' ? 'turn' : 'end',
    count: integer(params.get('count'), hasInterviewSelection(params) ? 1 : 4, 8),
    panelistCount: integer(params.get('panelists'), 2, 5), advanced: params.get('details') === '1',
  };
}
export function interviewSetupHref(kind: 'chat' | 'video', params: Search, updates: Partial<InterviewSetupState> & { targetId?: string } = {}) {
  const query = new URLSearchParams(params.toString());
  const state = { ...interviewSetupState(params), ...updates };
  if (updates.timing === 'end') state.reactions = false;
  if (state.reactions) state.timing = 'turn';
  query.set('kind', kind);
  query.set('mode', state.mode);
  query.set('followups', state.followups ? '1' : '0');
  query.set('pressure', state.pressure ? '1' : '0');
  query.set('reactions', state.reactions ? '1' : '0');
  query.set('difficulty', state.difficulty);
  query.set('feedback', state.timing);
  query.set('count', String(state.count));
  query.set('panelists', String(state.panelistCount));
  query.set('details', state.advanced ? '1' : '0');
  if (updates.targetId !== undefined) {
    if (updates.targetId) query.set('targetId', updates.targetId); else query.delete('targetId');
  }
  return `/interview/new?${query}`;
}
/** Only context is used for previews; changing a switch never asks the AI for anything. */
export function interviewPreviewHref(params: Search, targetId: string) {
  const query = new URLSearchParams({ preview: '1' });
  for (const key of ['questionId', 'sourceType', 'sourceVersion', 'activityId', 'briefingId', 'briefingQuestionIndex', 'experienceCardId', 'experienceRevision']) {
    const value = params.get(key); if (value) query.set(key, value);
  }
  if (targetId) query.set('targetId', targetId);
  return `/api/interviews?${query}`;
}
export function sourceVersionInput(params: Search) {
  const value = params.get('sourceVersion');
  return value && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100000 ? Number(value) : undefined;
}
