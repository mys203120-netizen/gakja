'use client';

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Bookmark, Check, FileText, MessageSquareText, Pencil } from 'lucide-react';
import { answerDraftReducer, isAnswerDirty, previewAnswerDraftKey, readPreviewAnswerDraft, storePreviewAnswerDraft } from '@/lib/w0/answer-draft';
import type { W0Model } from '@/lib/w0/view-model';
import { useW0 } from './W0Context';
import styles from './QuestionPreview.module.css';

type ExampleQuestion = NonNullable<W0Model['questionPreview']>;

const notices = {
  'answer-saved': '현재 미리보기의 예시 답변에 반영했어요. 계정에는 저장되지 않아요.',
  'answer-cancelled': '수정을 취소했어요. 이전 예시 답변을 유지해요.',
  'question-saved': '예시 질문 저장됨 · 현재 브라우저의 미리보기에만 유지돼요.',
  'question-unsaved': '예시 질문 저장을 취소했어요.',
};

function ExampleEditor({ example, cacheKey }: { example: ExampleQuestion; cacheKey: string }) {
  const [state, dispatch] = useReducer(answerDraftReducer, { cacheKey, initialAnswer: example.initialAnswer }, (initial) => readPreviewAnswerDraft(initial.cacheKey, initial.initialAnswer));
  const [pane, setPane] = useState<'source' | 'answer'>('answer');
  const editor = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const latestState = useRef(state);
  const dirty = isAnswerDirty(state);

  useLayoutEffect(() => {
    latestState.current = state;
  }, [state]);

  useEffect(() => () => {
    storePreviewAnswerDraft(cacheKey, latestState.current);
  }, [cacheKey]);

  useEffect(() => {
    const discard = () => {
      const cancelled = answerDraftReducer(latestState.current, { type: 'cancel' });
      // Navigation may unmount before React commits the dispatched state. Keep
      // the synchronous cache/ref aligned with the explicit discard decision.
      latestState.current = cancelled;
      storePreviewAnswerDraft(cacheKey, cancelled);
      dispatch({ type: 'cancel' });
      window.dispatchEvent(new CustomEvent('w0-draft-change', { detail: { dirty: false } }));
    };
    window.addEventListener('w0-draft-discard', discard);
    return () => window.removeEventListener('w0-draft-discard', discard);
  }, [cacheKey]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    if (dirty) window.addEventListener('beforeunload', guard);
    window.dispatchEvent(new CustomEvent('w0-draft-change', { detail: { dirty } }));
    return () => {
      window.removeEventListener('beforeunload', guard);
      window.dispatchEvent(new CustomEvent('w0-draft-change', { detail: { dirty: false } }));
    };
  }, [dirty]);

  useEffect(() => {
    if (state.editing) editor.current?.focus();
  }, [state.editing]);

  useLayoutEffect(() => {
    const textarea = editor.current;
    if (!textarea) return;
    const fitContent = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    };
    fitContent();
    window.addEventListener('resize', fitContent);
    return () => window.removeEventListener('resize', fitContent);
  }, [state.draftAnswer, state.editing, pane]);

  function finish(type: 'save' | 'cancel') {
    dispatch({ type });
    // The edit button is restored after the reducer closes the editor.
    requestAnimationFrame(() => editButton.current?.focus());
  }

  return <section className={styles.preview} aria-label="예시 질문·답변 편집">
    <p className={styles.exampleNote}>예시 데이터 · 현재 브라우저의 미리보기에만 유지돼요. 새로고침하거나 닫으면 사라져요.</p>
    <div className={styles.mobileSwitch} role="group" aria-label="예시 자료 보기">
      <button type="button" aria-pressed={pane === 'source'} onClick={() => setPane('source')}><FileText size={16} aria-hidden="true" />학생부</button>
      <button type="button" aria-pressed={pane === 'answer'} onClick={() => setPane('answer')}><MessageSquareText size={16} aria-hidden="true" />질문·답변</button>
    </div>
    <div className={styles.columns}>
      <section className={styles.source} data-mobile-hidden={pane !== 'source'} aria-labelledby="w0-example-source-title">
        <div className={styles.paneHeading}><FileText size={17} aria-hidden="true" /><h2 id="w0-example-source-title">학생부 원문 예시</h2><span>읽기 전용</span></div>
        <p className={styles.sourceText}>{example.source}</p>
      </section>
      <section className={styles.answerPane} data-mobile-hidden={pane !== 'answer'} aria-labelledby="w0-example-question-title">
        <div className={styles.questionHeading}><span>예상 질문 예시</span><button type="button" className={styles.questionSave} aria-pressed={state.questionSaved} aria-label={state.questionSaved ? '예시 질문 저장 취소' : '질문 저장하기'} onClick={() => dispatch({ type: 'toggle-question' })}>{state.questionSaved ? <Check size={16} aria-hidden="true" /> : <Bookmark size={16} aria-hidden="true" />}{state.questionSaved ? '예시 질문 저장됨' : '질문 저장하기'}</button></div>
        <h2 id="w0-example-question-title" className={styles.question}>{example.question}</h2>
        <div className={styles.answerHeading}><h3>{state.hasSavedRevision ? '수정한 예시 답변' : '예상 답변 예시'}</h3>{!state.editing && <button type="button" ref={editButton} className={styles.editButton} onClick={() => dispatch({ type: 'edit' })}><Pencil size={14} aria-hidden="true" />답변 수정하기</button>}</div>
        {!state.hasSavedRevision && <p className={styles.answerNote}>학습용으로 만든 예상 답변 예시예요. 학생이 작성한 실제 답변이 아니에요.</p>}
        {state.editing ? <div className={styles.editor}>
          <label htmlFor="w0-example-answer">예시 답변 수정</label>
          <textarea id="w0-example-answer" ref={editor} value={state.draftAnswer} rows={7} onChange={(event) => dispatch({ type: 'change', value: event.target.value })} aria-describedby="w0-example-save-scope" />
          <p id="w0-example-save-scope">저장은 현재 브라우저의 예시에만 반영돼요. 계정에 저장되지 않으며 새로고침하면 사라져요.</p>
          <div className={styles.actions}><button type="button" className={styles.saveButton} disabled={!state.draftAnswer.trim()} onClick={() => finish('save')}>저장</button><button type="button" className={styles.cancelButton} onClick={() => finish('cancel')}>취소</button>{dirty && <span>수정 중인 예시 답변</span>}</div>
        </div> : <p className={styles.answerText}>{state.savedAnswer}</p>}
        <p className={styles.notice} role="status" aria-live="polite">{state.notice ? notices[state.notice] : ''}</p>
      </section>
    </div>
  </section>;
}

export function QuestionPreview() {
  const { model, selectedTargetId } = useW0();
  if (!model.isExample || !model.questionPreview) return null;
  const example = model.questionPreview;
  const cacheKey = previewAnswerDraftKey(selectedTargetId, example.question, example.initialAnswer);
  return <ExampleEditor key={cacheKey} example={example} cacheKey={cacheKey} />;
}
