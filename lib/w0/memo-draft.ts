import type { W0Model } from './view-model';

/** Browser-memory state for synthetic guidebook examples only. */
export type MemoDraft = { saved: string; draft: string; editing: boolean };
export type MemoDraftAction =
  | { type: 'edit' }
  | { type: 'change'; value: string }
  | { type: 'save' }
  | { type: 'cancel' };

export function canEditExampleMemo(model: W0Model, targetId: string): boolean {
  const hasGuideContent = Boolean(model.strategy || model.activities.length || model.questionPreview);
  return model.isExample && Boolean(targetId) && model.contentTargetId === targetId && hasGuideContent
    && (model.status === 'ready' || model.status === 'review_required');
}

export function isMemoDirty(state: MemoDraft, canEdit: boolean): boolean {
  return canEdit && state.editing && state.draft !== state.saved;
}

export function memoDraftReducer(state: MemoDraft, action: MemoDraftAction): MemoDraft {
  switch (action.type) {
    case 'edit':
      return state.editing ? state : { ...state, draft: state.saved, editing: true };
    case 'change':
      return state.editing ? { ...state, draft: action.value } : state;
    case 'save':
      return state.editing ? { saved: state.draft, draft: state.draft, editing: false } : state;
    case 'cancel':
      return { ...state, draft: state.saved, editing: false };
  }
}

// Target-scoped preview state survives client navigation, not refresh or tab close.
const previewMemoCache = new Map<string, MemoDraft>();

export function readPreviewMemoDraft(targetId: string): MemoDraft {
  const cached = previewMemoCache.get(targetId);
  return cached ? { ...cached } : { saved: '', draft: '', editing: false };
}

export function storePreviewMemoDraft(targetId: string, state: MemoDraft): void {
  previewMemoCache.set(targetId, { ...state });
}
