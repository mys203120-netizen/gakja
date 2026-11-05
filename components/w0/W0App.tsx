'use client';

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BookOpenText, ChevronDown, CircleUserRound, Dumbbell, Files, LogOut, MessageCircle, MoveUpRight, X } from 'lucide-react';
import type { W0Model } from '@/lib/w0/view-model';
import { scopeW0Model } from '@/lib/w0/view-model';
import { primaryNavigation, profileLinks } from '@/lib/w0/navigation';
import { W0Context } from './W0Context';
import { HomeScreen, RecordScreen, InterviewEntry, AnswerEntry, MemoryEntry } from './EntryScreens';
import { DetailScreen } from './DetailScreen';
import styles from './W0.module.css';

const icons = [BookOpenText, MessageCircle, Files, Dumbbell];
const scenarios = ['ready', 'empty', 'loading', 'pending', 'error', 'forbidden', 'review_required', 'long-target', 'one-target'];

function containDialogFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const dialog = (event.target as Element).closest('dialog');
  if (!dialog) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

export function W0App({ model: initialModel, screen, detailId, preview, scenario, initialTargetId }: {
  model: W0Model; screen: string; detailId: string | null; preview: boolean; scenario: string; initialTargetId: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialTargetId);
  const [logoutNotice, setLogoutNotice] = useState(false);
  const profile = useRef<HTMLDialogElement>(null);
  const assistant = useRef<HTMLDialogElement>(null);
  const draftGuard = useRef<HTMLDialogElement>(null);
  const dirty = useRef(false);
  const pendingAction = useRef<(() => void) | null>(null);
  const main = useRef<HTMLElement>(null);
  const target = initialModel.targets.find((item) => item.id === selectedId) ?? initialModel.targets[0] ?? null;
  const model = scopeW0Model(initialModel, target?.id ?? null);
  const area = screen === 'detail' ? detailId?.startsWith('G') ? 'record' : detailId?.startsWith('I') ? 'interviews' : detailId?.startsWith('A') ? 'answers' : detailId?.startsWith('M') ? 'memory' : 'home' : screen;
  const guide = area === 'record' && (screen === 'record' || detailId?.startsWith('G'));

  function viewHref(path: string) {
    if (!preview || !path.startsWith('/w0')) return path;
    const query = new URLSearchParams({ scenario });
    if (target) query.set('target', target.id);
    return `/w0/preview${path.slice(3)}?${query}`;
  }
  function selectTarget(id: string) {
    if (!preview || !model.targets.some((item) => item.id === id)) return;
    requestAction(() => {
      setSelectedId(id);
      const query = new URLSearchParams(window.location.search);
      query.set('target', id);
      router.replace(`${pathname}?${query}`, { scroll: false });
    });
  }
  function requestAction(action: () => void) {
    if (!dirty.current) { action(); return; }
    pendingAction.current = action;
    draftGuard.current?.showModal();
  }
  function discardAndContinue() {
    dirty.current = false;
    window.dispatchEvent(new Event('w0-draft-discard'));
    draftGuard.current?.close();
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  }
  function guardLinks(event: MouseEvent<HTMLDivElement>) {
    if (!dirty.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest('a');
    const href = link?.getAttribute('href');
    if (!href?.startsWith('/w0') || link?.target === '_blank') return;
    event.preventDefault();
    event.stopPropagation();
    requestAction(() => router.push(href));
  }
  useLayoutEffect(() => {
    const onDraft = (event: Event) => { dirty.current = (event as CustomEvent<{ dirty: boolean }>).detail.dirty; };
    window.addEventListener('w0-draft-change', onDraft);
    return () => window.removeEventListener('w0-draft-change', onDraft);
  }, []);
  useEffect(() => { setSelectedId(initialTargetId); }, [initialTargetId]);
  useLayoutEffect(() => {
    profile.current?.close();
    assistant.current?.close();
    draftGuard.current?.close();
    pendingAction.current = null;
    setLogoutNotice(false);
    main.current?.scrollTo({ top: 0 });
  }, [pathname, scenario, target?.id]);

  const context = { model, target, selectedTargetId: target?.id ?? '', setSelectedTargetId: selectTarget, preview, scenario, viewHref };
  return <W0Context.Provider value={context}><div className={styles.shell} data-w0-shell="true" onClickCapture={guardLinks} onKeyDownCapture={containDialogFocus}>
    <a href="#w0-main" className={styles.skipLink}>본문으로 이동</a>
    <header className={styles.header}>
      <Link href={viewHref('/w0')} className={styles.logo} aria-label="각자의답 MY 홈"><span aria-hidden="true" className={styles.logoMark}>a<span>.</span></span><span>각자의답</span></Link>
      <nav aria-label="주 메뉴" className={styles.desktopNav}>{primaryNavigation.map((item) => <Link key={item.area} href={viewHref(item.path)} aria-current={area === item.area ? 'page' : undefined}>{item.label}</Link>)}</nav>
      <div className={styles.headerTools}>
        <div className={styles.targetControl}><label htmlFor="w0-target">현재 지원처</label><div className={styles.selectWrap}><select id="w0-target" value={target?.id ?? ''} disabled={!preview || !model.targets.length} onChange={(event) => selectTarget(event.target.value)} title={target ? `${target.university} · ${target.department} · ${target.admission}` : '지원처 확인 필요'}>{!model.targets.length && <option value="">지원처 확인 필요</option>}{model.targets.map((item) => <option value={item.id} key={item.id}>{item.university} · {item.department}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></div></div>
        <button className={styles.profileButton} aria-label="프로필 메뉴 열기" aria-haspopup="dialog" onClick={() => profile.current?.showModal()}><CircleUserRound size={23} aria-hidden="true" /></button>
      </div>
    </header>
    {preview && <div className={styles.previewBar}><span><strong>예시 데이터</strong> · 계정에 반영되지 않는 화면 미리보기</span><label>상태<select aria-label="미리보기 상태" value={scenario} onChange={(event) => { const value = event.target.value; requestAction(() => { const query = new URLSearchParams({ scenario: value }); router.push(`${pathname}?${query}`); }); }}>{scenarios.map((name) => <option key={name} value={name}>{({ ready: '자료 있음', empty: '자료 없음', loading: '불러오는 중', pending: '처리·검수 대기', error: '조회 오류', forbidden: '접근 불가', review_required: '평가 검수 대기', 'long-target': '긴 지원처명', 'one-target': '지원처 한 개' } as Record<string, string>)[name]}</option>)}</select></label></div>}
    <main id="w0-main" ref={main} tabIndex={-1} className={styles.main}>
      <div className={styles.content}>
        <div className={styles.location}><span>MY LEARNING SPACE</span><span className={styles.locationLine} /><span>{area === 'home' ? 'MY 홈' : primaryNavigation.find((item) => item.area === area)?.label}</span></div>
        {target && <p className={styles.targetContext}>{target.university}<span>{target.department}</span><small>{target.admission}</small></p>}
        {screen === 'home' && <HomeScreen />}{screen === 'record' && <RecordScreen />}{screen === 'interviews' && <InterviewEntry />}{screen === 'answers' && <AnswerEntry />}{screen === 'memory' && <MemoryEntry />}{screen === 'detail' && detailId && <DetailScreen id={detailId} />}
        <footer className={styles.footer}><span>나의 기록에서, 나다운 답으로.</span><div><Link href={viewHref('/w0/view/P05')}>약관·정책</Link><Link href={viewHref('/w0/view/U07')}>고객센터 <MoveUpRight size={12} aria-hidden="true" /></Link></div></footer>
      </div>
    </main>
    <nav aria-label="모바일 주 메뉴" className={styles.mobileNav}>{primaryNavigation.map((item, index) => { const Icon = icons[index]; return <Link key={item.area} href={viewHref(item.path)} aria-current={area === item.area ? 'page' : undefined}><Icon size={21} aria-hidden="true" /><span>{item.label}</span></Link>; })}</nav>
    {guide && <button className={styles.assistantTrigger} onClick={() => assistant.current?.showModal()} aria-haspopup="dialog"><MessageCircle size={19} aria-hidden="true" />AI 비서</button>}
    <dialog ref={profile} className={styles.dialog} aria-labelledby="w0-profile-title" onClose={() => setLogoutNotice(false)}><div className={styles.dialogHeader}><h2 id="w0-profile-title">내 계정</h2><button aria-label="프로필 메뉴 닫기" onClick={() => profile.current?.close()}><X size={21} /></button></div><p className={styles.dialogIntro}>지원처와 이용 정보를 확인해요.</p><nav aria-label="프로필 메뉴" className={styles.profileLinks}>{profileLinks.map(([id, label]) => <Link key={id} href={viewHref(`/w0/view/${id}`)} onClick={() => profile.current?.close()}>{label}<MoveUpRight size={15} aria-hidden="true" /></Link>)}<button onClick={() => setLogoutNotice(true)}><span>로그아웃</span><LogOut size={16} aria-hidden="true" /></button></nav>{logoutNotice && <p role="status" className={styles.inlineNote}>계정 연결을 준비하고 있어요. 현재는 로그아웃할 연결 계정이 없어요.</p>}</dialog>
    <dialog ref={assistant} className={`${styles.dialog} ${styles.assistantDialog}`} aria-labelledby="w0-assistant-title"><div className={styles.dialogHeader}><h2 id="w0-assistant-title">가이드북 AI 비서</h2><button aria-label="AI 비서 닫기" onClick={() => assistant.current?.close()}><X size={21} /></button></div><div className={styles.assistantEmpty}><MessageCircle size={32} aria-hidden="true" /><h3>가이드북과 함께 준비하고 있어요</h3><p>확인된 가이드북 내용으로 도움을 드릴 수 있도록 준비 중이에요. 지금은 목차에서 필요한 내용을 살펴보세요.</p><button className={styles.secondaryButton} onClick={() => assistant.current?.close()}>가이드북으로 돌아가기</button></div></dialog>
    <dialog ref={draftGuard} className={styles.dialog} aria-labelledby="w0-draft-title"><div className={styles.dialogHeader}><h2 id="w0-draft-title">수정 중인 내용이 있어요</h2></div><p className={styles.dialogIntro}>돌아가서 저장하거나, 수정을 취소하고 이동할 수 있어요.</p><div className={styles.guardActions}><button className={styles.secondaryButton} onClick={() => draftGuard.current?.close()}>계속 수정하기</button><button className={styles.secondaryButton} onClick={discardAndContinue}>수정 취소하고 이동</button></div></dialog>
  </div></W0Context.Provider>;
}
