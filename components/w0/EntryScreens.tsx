'use client';

import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import Link from 'next/link';
import {
  Archive, BookOpen, Brain, CalendarClock, ChartNoAxesCombined,
  CircleHelp, FileText, Lightbulb, ListChecks, LockKeyhole,
  MessageSquare, Mic, Newspaper, NotebookPen, Video,
} from 'lucide-react';
import { evaluationLabel, interviewDateLabel } from '@/lib/w0/view-model';
import { canEditExampleMemo, isMemoDirty, memoDraftReducer, readPreviewMemoDraft, storePreviewMemoDraft } from '@/lib/w0/memo-draft';
import { guideChapters as chapterDefinitions } from '@/lib/w0/navigation';
import { useW0 } from './W0Context';
import { MenuCard, PageHeading, StateNotice } from './ui';
import styles from './EntryScreens.module.css';

const guideChapters = chapterDefinitions.map(([id, label]) => ({ id, label, href: id === 'G01' ? '/w0/record' : `/w0/view/${id}` }));

export function GuideContents({ currentId = 'G01' }: { currentId?: string }) {
  const { viewHref } = useW0();
  return (
    <nav aria-label="가이드북 목차" className={styles.guideNav}>
      <p className={styles.contentsLabel}>나의 가이드북</p>
      <ol>
        {guideChapters.map((chapter, index) => (
          <li key={chapter.id}>
            <Link href={viewHref(chapter.href)} aria-current={currentId === chapter.id ? 'page' : undefined}>
              <span className={styles.chapterNumber} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              {chapter.label}
            </Link>
          </li>
        ))}
      </ol>
      <Link href={viewHref('/w0/view/G07')} className={styles.helpLink} aria-current={currentId === 'G07' ? 'page' : undefined}>
        <CircleHelp size={16} aria-hidden="true" />가이드북 사용법
      </Link>
    </nav>
  );
}

function ContextState() {
  const { model, viewHref } = useW0();
  if (model.status === 'ready') return null;
  return (
    <div className={styles.contextState}>
      <StateNotice status={model.status} compact />
      {model.status === 'empty' && (
        <Link href={viewHref('/w0/view/U01')} className={styles.textLink}>지원처 등록</Link>
      )}
      {model.status === 'pending' && (
        <Link href={viewHref('/w0/view/O05')} className={styles.textLink}>진행 상태 보기</Link>
      )}
    </div>
  );
}

export function HomeScreen() {
  const { model, viewHref } = useW0();
  const hasLoadedData = model.status === 'ready' || model.status === 'empty' || model.status === 'review_required';
  return (
    <div className={styles.page}>
      <PageHeading eyebrow="MY HOME" title="MY 홈" description="오늘의 준비를 이어가세요." />
      <ContextState />
      <section aria-label="학습 메뉴" className={styles.homeGrid}>
        <MenuCard href={viewHref('/w0/record')} icon={BookOpen} label="생기부" />
        <MenuCard href={viewHref('/w0/interviews')} icon={Mic} label="면접 연습실" />
        <MenuCard href={viewHref('/w0/answers')} icon={Archive} label="내 답변" />
        <MenuCard href={viewHref('/w0/memory')} icon={Brain} label="암기 훈련실" />
      </section>

      <section aria-labelledby="w0-usage-heading" className={styles.section}>
        <div className={styles.sectionHeading}><h2 id="w0-usage-heading">이용 현황</h2><span>나의 준비 현황</span></div>
        <dl className={styles.usage}>
          <div><dt>잔여 실전 면접</dt><dd>{model.tickets === null ? <span className={styles.unknownValue}>확인 필요</span> : <>{model.tickets}<small>회</small></>}</dd></div>
          <div><dt>연습 이용기간</dt><dd className={styles.dateValue}>{model.practiceUntil ? <>{interviewDateLabel(model.practiceUntil)}<small>까지</small></> : <span className={styles.unknownValue}>확인 필요</span>}</dd></div>
          <div><dt>기록된 면접</dt><dd>{hasLoadedData ? <>{model.sessions.length}<small>개</small></> : <span className={styles.unknownValue}>확인 필요</span>}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="w0-schedule-heading" className={styles.section}>
        <div className={styles.sectionHeading}><h2 id="w0-schedule-heading">면접 일정</h2><span>개인 확정일 기준</span></div>
        {model.targets.length ? (
          <ul className={styles.scheduleList}>
            {model.targets.map((item) => (
              <li key={item.id}>
                <CalendarClock size={21} aria-hidden="true" />
                <div className={styles.scheduleTarget}><strong>{item.university}</strong><span>{item.department}</span></div>
                <div className={styles.scheduleDate}><strong>{interviewDateLabel(item.interviewDate)}</strong><span>{item.interviewDate ? '개인 면접일' : '등록된 면접일 없음'}</span></div>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.emptyRow}><CalendarClock size={22} aria-hidden="true" /><p>등록된 면접 일정을 확인할 수 없어요.<span>면접일은 지원처 관리에서 등록할 수 있어요.</span></p></div>
        )}
      </section>
    </div>
  );
}

function PersonalMemo() {
  const { model, selectedTargetId } = useW0();
  const canEdit = canEditExampleMemo(model, selectedTargetId);
  const [state, dispatch] = useReducer(memoDraftReducer, selectedTargetId, readPreviewMemoDraft);
  const latestState = useRef(state);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const dirty = isMemoDirty(state, canEdit);
  useLayoutEffect(() => {
    latestState.current = state;
    if (model.isExample) storePreviewMemoDraft(selectedTargetId, state);
  }, [model.isExample, selectedTargetId, state]);
  useEffect(() => {
    if (!canEdit) return;
    const discard = () => {
      const cancelled = memoDraftReducer(latestState.current, { type: 'cancel' });
      latestState.current = cancelled;
      storePreviewMemoDraft(selectedTargetId, cancelled);
      dispatch({ type: 'cancel' });
      window.dispatchEvent(new CustomEvent('w0-draft-change', { detail: { dirty: false } }));
    };
    window.addEventListener('w0-draft-discard', discard);
    return () => window.removeEventListener('w0-draft-discard', discard);
  }, [canEdit, selectedTargetId]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('w0-draft-change', { detail: { dirty } }));
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    if (dirty) window.addEventListener('beforeunload', guard);
    return () => {
      window.removeEventListener('beforeunload', guard);
      window.dispatchEvent(new CustomEvent('w0-draft-change', { detail: { dirty: false } }));
    };
  }, [dirty]);
  useEffect(() => {
    if (!canEdit) return;
    if (state.editing) editor.current?.focus();
    else if (restoreFocus.current) {
      editTrigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [canEdit, state.editing]);
  function finish(type: 'save' | 'cancel') {
    restoreFocus.current = true;
    dispatch({ type });
  }
  return (
    <section aria-labelledby="w0-memo-heading" className={styles.memoSection}>
      <div className={styles.sectionHeading}><h2 id="w0-memo-heading"><NotebookPen size={18} aria-hidden="true" />나의 메모</h2></div>
      {canEdit ? (
        <>
          <p className={styles.smallNote}>예시 메모 · 현재 브라우저 미리보기에만 유지돼요. 새로고침하면 사라져요.</p>
          {state.editing ? (
            <form onSubmit={(event) => { event.preventDefault(); finish('save'); }}>
              <label htmlFor="w0-personal-memo" className={styles.inputLabel}>기억하고 싶은 키워드나 메모</label>
              <textarea ref={editor} id="w0-personal-memo" value={state.draft} onChange={(event) => dispatch({ type: 'change', value: event.target.value })} rows={4} maxLength={2000} />
              <div className={styles.memoActions}>
                <button type="submit" className={styles.saveButton}>예시 메모 저장</button>
                <button type="button" className={styles.cancelButton} onClick={() => finish('cancel')}>취소</button>
              </div>
            </form>
          ) : (
            <>
              <p className={styles.memoText}>{state.saved || '아직 작성한 메모가 없어요.'}</p>
              <button ref={editTrigger} type="button" className={styles.cancelButton} onClick={() => dispatch({ type: 'edit' })}>메모 수정하기</button>
            </>
          )}
        </>
      ) : <p className={styles.smallNote}>가이드북을 확인할 수 있게 되면 개인 메모를 작성할 수 있어요.</p>}
    </section>
  );
}

export function RecordScreen() {
  const { model, target } = useW0();
  return (
    <div className={styles.page}>
      <PageHeading eyebrow="GUIDEBOOK" title="나의 면접 전략" description="학생부의 경험을 나만의 답변으로 연결해 보세요." />
      <div className={styles.guideLayout}>
        <aside className={styles.desktopContents}><GuideContents /></aside>
        <details className={styles.mobileContents}>
          <summary><ListChecks size={18} aria-hidden="true" />목차</summary>
          <GuideContents />
        </details>
        <div className={styles.guideBody}>
          {model.status !== 'ready' && <StateNotice status={model.status} />}
          <section className={styles.strategySection} aria-labelledby="w0-strategy-heading">
            <p className={styles.chapterEyebrow}>CHAPTER 01</p>
            <h2 id="w0-strategy-heading">나의 경험에서 시작하는 답변</h2>
            {model.strategy ? <p className={styles.strategyText}>{model.strategy}</p> : <p className={styles.unavailableText}>확인된 전략 자료가 아직 없어요. 학생부와 지원처의 자료가 준비되면 이곳에서 살펴볼 수 있어요.</p>}
          </section>
          <section className={styles.activitySection} aria-labelledby="w0-activities-heading">
            <div className={styles.sectionHeading}><h2 id="w0-activities-heading">대표 활동</h2></div>
            {model.activities.length ? (
              <ol className={styles.activityList}>
                {model.activities.map((activity, index) => <li key={activity}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><p>{activity}</p></li>)}
              </ol>
            ) : <p className={styles.unavailableText}>확인된 대표 활동이 없어요. 분석 결과를 확인한 뒤 표시해 드릴게요.</p>}
          </section>
          <PersonalMemo key={target?.id ?? 'no-target'} />
        </div>
      </div>
    </div>
  );
}

export function InterviewEntry() {
  const { model, viewHref } = useW0();
  return (
    <div className={styles.page}>
      <PageHeading eyebrow="INTERVIEW" title="면접 연습실" description="연습은 채팅·화상, 실전 모의면접은 화상으로 진행해요." />
      <div className={styles.binaryGrid} aria-label="면접 종류 선택">
        <MenuCard href={viewHref('/w0/view/I01')} icon={MessageSquare} label="연습 면접" />
        <MenuCard href={viewHref('/w0/view/I05')} icon={Video} label="실전 모의면접" />
      </div>
      {model.status !== 'ready' && <div className={styles.entryState}><StateNotice status={model.status} compact /></div>}
      <div className={styles.quietNote}><Mic size={18} aria-hidden="true" /><p>이용기간과 이용권은 선택한 면접의 준비 화면에서 확인할 수 있어요.</p></div>
    </div>
  );
}

export function AnswerEntry() {
  const { model, target, viewHref } = useW0();
  return (
    <div className={styles.page}>
      <PageHeading eyebrow="MY ANSWERS" title="내 답변" description="연습과 실전에서 쌓은 답변을 돌아보세요." />
      <div className={styles.threeGrid} aria-label="내 답변 메뉴">
        <MenuCard href={viewHref('/w0/view/A01')} icon={Archive} label="답변 보관함" />
        <MenuCard href={viewHref('/w0/view/A03')} icon={ChartNoAxesCombined} label="면접 리포트" />
        <MenuCard href={viewHref('/w0/view/A06')} icon={LockKeyhole} label="면접 직전 요약" state={target?.interviewDate ? '면접 하루 전 열려요' : '면접일 미확정'} />
      </div>
      {model.status !== 'ready' && <div className={styles.entryState}><StateNotice status={model.status} compact /></div>}
      <section className={styles.section} aria-labelledby="w0-recent-sessions-heading">
        <div className={styles.sectionHeading}><h2 id="w0-recent-sessions-heading">최근 면접 기록</h2></div>
        {model.sessions.length ? (
          <ul className={styles.sessionList}>
            {model.sessions.map((session) => (
              <li key={session.id}>
                <div><span className={styles.sessionKind}>{session.kind === 'practice' ? '연습 면접' : '실전 모의면접'}</span><strong>{session.title}</strong><time dateTime={session.date}>{interviewDateLabel(session.date)}</time></div>
                <span className={styles.sessionStatus}>{session.kind === 'practice' && session.evaluation === 'ready' ? '피드백 준비됨' : evaluationLabel(session.evaluation, session.score)}</span>
              </li>
            ))}
          </ul>
        ) : <div className={styles.emptyRow}><FileText size={22} aria-hidden="true" /><p>{model.status === 'empty' ? '아직 면접 기록이 없어요.' : '확인할 수 있는 면접 기록이 없어요.'}<span>기록이 준비되면 답변과 평가 상태를 함께 확인할 수 있어요.</span></p></div>}
      </section>
    </div>
  );
}

export function MemoryEntry() {
  const { model, viewHref } = useW0();
  return (
    <div className={styles.page}>
      <PageHeading eyebrow="MEMORY TRAINING" title="암기 훈련실" description="이해한 내용을 기억하고, 답변의 배경을 넓혀 보세요." />
      <div className={styles.threeGrid} aria-label="암기 훈련실 메뉴">
        <MenuCard href={viewHref('/w0/view/M01')} icon={ListChecks} label="퀴즈" />
        <MenuCard href={viewHref('/w0/view/M03')} icon={Lightbulb} label="지식한입" />
        <MenuCard href={viewHref('/w0/view/M04')} icon={Newspaper} label="이슈픽" />
      </div>
      {model.status !== 'ready' && <div className={styles.entryState}><StateNotice status={model.status} compact /></div>}
      <div className={styles.quietNote}><BookOpen size={18} aria-hidden="true" /><p>이용 가능한 학습 범위는 각 메뉴에서 확인할 수 있어요.</p></div>
    </div>
  );
}
