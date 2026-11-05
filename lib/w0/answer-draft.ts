/** Local development-preview interactions; no server persistence or approval implied. */
export type AnswerDraft = {
  savedAnswer: string;
  draftAnswer: string;
  editing: boolean;
  hasSavedRevision: boolean;
  questionSaved: boolean;
  notice: 'answer-saved' | 'answer-cancelled' | 'question-saved' | 'question-unsaved' | null;
};

export type AnswerDraftAction =
  | { type: 'edit' }
  | { type: 'change'; value: string }
  | { type: 'save' }
  | { type: 'cancel' }
  | { type: 'toggle-question' };

export function createAnswerDraft(initialAnswer: string): AnswerDraft {
  return {
    savedAnswer: initialAnswer,
    draftAnswer: initialAnswer,
    editing: false,
    hasSavedRevision: false,
    questionSaved: false,
    notice: null,
  };
}

// Synthetic preview interaction state only. A full reload or tab close clears it.
// Never read or write localStorage, cookies, or actual student answer data here.
const previewDraftCache = new Map<string, AnswerDraft>();

export function previewAnswerDraftKey(targetId: string, question: string, initialAnswer: string): string {
  return JSON.stringify([targetId, question, initialAnswer]);
}

export function readPreviewAnswerDraft(key: string, initialAnswer: string): AnswerDraft {
  const cached = previewDraftCache.get(key);
  return cached ? { ...cached } : createAnswerDraft(initialAnswer);
}

export function storePreviewAnswerDraft(key: string, state: AnswerDraft): void {
  previewDraftCache.set(key, { ...state });
}

export function isAnswerDirty(state: AnswerDraft): boolean {
  return state.editing && state.draftAnswer !== state.savedAnswer;
}

export function answerDraftReducer(state: AnswerDraft, action: AnswerDraftAction): AnswerDraft {
  switch (action.type) {
    case 'edit':
      if (state.editing) return state;
      return { ...state, editing: true, draftAnswer: state.savedAnswer, notice: null };
    case 'change':
      return state.editing ? { ...state, draftAnswer: action.value, notice: null } : state;
    case 'save':
      if (!state.editing || !state.draftAnswer.trim()) return state;
      return { ...state, savedAnswer: state.draftAnswer, editing: false, hasSavedRevision: true, notice: 'answer-saved' };
    case 'cancel':
      return { ...state, draftAnswer: state.savedAnswer, editing: false, notice: 'answer-cancelled' };
    case 'toggle-question':
      return { ...state, questionSaved: !state.questionSaved, notice: state.questionSaved ? 'question-unsaved' : 'question-saved' };
  }
}
