'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, Check, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, Alert, Modal, type Item } from './shared';
import styles from './chat-history.module.css';

type Management = 'rename' | 'archive' | 'restore' | 'delete';
function ThreadMenu({ thread, archived, disabled, onAction }: { thread: Item; archived: boolean; disabled?: boolean; onAction: (action: Management) => void }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), lastOnOpen = useRef(false), id = useId();
  function close(restore = true) { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect(), popup = menu.current.getBoundingClientRect();
    const below = rect.bottom + 6, above = rect.top - popup.height - 6;
    const top = below + popup.height > window.innerHeight - 12 && above >= 12 ? above : below;
    setPosition({ left: Math.max(12, Math.min(rect.right - popup.width, window.innerWidth - popup.width - 12)), top: Math.max(12, Math.min(top, window.innerHeight - popup.height - 12)) });
    const items = menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    items[lastOnOpen.current ? items.length - 1 : 0]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const viewportChange = (event: Event) => { if (event.type === 'resize' || !(event.target instanceof Node) || !menu.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', viewportChange); window.addEventListener('scroll', viewportChange, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', viewportChange); window.removeEventListener('scroll', viewportChange, true); };
  }, [open]);
  function select(action: Management) { close(); onAction(action); }
  return <>
    <button ref={trigger} type="button" className={ownedClassName(styles.menuTrigger,true)} aria-label={`${thread.title || '대화'} 메뉴`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => { lastOnOpen.current = false; setOpen(value => !value); }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); lastOnOpen.current = event.key === 'ArrowUp'; setOpen(true); } }}><MoreHorizontal size={17} /></button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={`${thread.title || '대화'} 메뉴`} className={ownedClassName(styles.popover,true)} style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')), index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (!items.length) return;
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
    }}>
      <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => select('rename')} className={ownedClassName(undefined,true)}><Pencil size={14} />이름 바꾸기</button>
      <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => select(archived ? 'restore' : 'archive')} className={ownedClassName(undefined,true)}>{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{archived ? '보관 해제' : '보관'}</button>
      <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => select('delete')} className={ownedClassName(undefined,true)}><Trash2 size={14} />삭제</button>
    </div>, document.body)}
  </>;
}
export function ChatHistory({ threads, currentId, busy, onChange,hasMore=false,loading=false,error:readError='',onMore }: { threads: Item[]; currentId?: string; busy?: boolean; onChange: (id: string, action: Management) => void | Promise<void>;hasMore?:boolean;loading?:boolean;error?:string;onMore?:()=>void }) {
  const [archivedPage,setArchivedPage]=useState<Item|null>(null),[archivedLoading,setArchivedLoading]=useState(false);
  const [view, setView] = useState<'active' | 'archived'>('active'), [archived, setArchived] = useState<Item[]>([]);
  const [intent, setIntent] = useState<{ action: Management; thread: Item } | null>(null), [title, setTitle] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { if (view !== 'archived') return; let live = true; api('/api/chat?view=archived').then(r => { if (live) { setArchived(r.threads);setArchivedPage(r.page); setError(''); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [view, threads]);
  async function moreArchived(){if(archivedLoading||!archivedPage?.nextCursor)return;setArchivedLoading(true);try{const result=await api('/api/chat?view=archived&cursor='+encodeURIComponent(archivedPage.nextCursor));setArchived(previous=>[...previous,...result.threads.filter((item:Item)=>!previous.some(row=>row.id===item.id))]);setArchivedPage(result.page);}catch(error){setError((error as Error).message);}finally{setArchivedLoading(false);}}
  function choose(action: Management, thread: Item) { setIntent({ action, thread }); setTitle(thread.title || '새 대화'); setError(''); }
  async function manage(action: Management, thread: Item) {
    if (saving || busy) return;
    setSaving(true); setError('');
    try {
      await api('/api/chat', { method: 'PATCH', body: JSON.stringify({ action, threadId: thread.id, ...(action === 'rename' ? { title: title.trim() } : {}) }) });
      setArchived(items => items.filter(item => item.id !== thread.id)); setIntent(null); await onChange(thread.id, action);
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  const list = view === 'archived' ? archived : threads;
  const history = <>
    <Link href="/on" className={ownedClassName("button ghost full")}><Plus size={17} />새 대화</Link>
    <div className={ownedClassName(styles.tabs,true)} aria-label="대화 목록"><button type="button" aria-pressed={view === 'active'} onClick={() => setView('active')} className={ownedClassName(undefined,true)}>대화</button><button type="button" aria-pressed={view === 'archived'} onClick={() => setView('archived')} className={ownedClassName(undefined,true)}><Archive size={13} />보관함</button></div>
    <div className={ownedClassName(styles.list,true)}>{list.map(thread => <div key={thread.id} className={ownedClassName(`${styles.row} ${thread.id === currentId ? styles.active : ''}`,true)}>
      <Link href={`/on/${thread.id}`} title={thread.title || '새 대화'} aria-current={thread.id === currentId ? 'page' : undefined}>{thread.title || '새 대화'}</Link>
      <ThreadMenu thread={thread} archived={view === 'archived'} disabled={busy || saving} onAction={action => { if (action === 'rename' || action === 'delete') choose(action, thread); else void manage(action, thread); }} />
    </div>)}</div>
    {readError&&view==='active'&&<Alert>{readError}</Alert>}
    {view==='active'&&hasMore&&<button className={ownedClassName("button ghost full",true)} disabled={loading} onClick={onMore}>{loading?'불러오는 중':'이전 대화 더 보기'}</button>}
    {view==='archived'&&archivedPage?.hasMore&&<button className={ownedClassName("button ghost full",true)} disabled={archivedLoading} onClick={()=>void moreArchived()}>보관한 대화 더 보기</button>}
    {!(view==='active'&&loading)&&!list.length && <p className={ownedClassName("fine-print",true)}>{view === 'archived' ? '보관한 대화가 없어요.' : '저장한 대화가 없어요.'}</p>}
  </>;
  return <>
    <aside className={ownedClassName("chat-history",true)}>{history}</aside>
    <details className={ownedClassName("chat-mobile-history",true)}><summary className={ownedClassName(undefined,true)}>대화·보관함</summary>{history}</details>
    {error && !intent && <Alert>{error}</Alert>}
    {intent && <Modal title={intent.action === 'rename' ? '대화 이름 바꾸기' : '대화를 삭제할까요?'} onClose={() => { if (!saving) { setIntent(null); setError(''); } }}>
      {error && <Alert>{error}</Alert>}
      {intent.action === 'rename' ? <label className={ownedClassName(styles.name,true)}>대화 이름<input autoFocus data-autofocus value={title} maxLength={80} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && title.trim()) void manage('rename', intent.thread); }} className={ownedClassName(undefined,true)} /></label> : <p className={ownedClassName("body-copy",true)}>이 대화가 목록에서 사라집니다. 저장한 면접 답변과 학습 기록은 유지돼요.</p>}
      <div className={ownedClassName("inline-actions",true)}><button type="button" className={ownedClassName("button ghost",true)} disabled={saving} onClick={() => setIntent(null)}>취소</button><button type="button" className={ownedClassName(`button ${intent.action === 'delete' ? 'danger' : 'primary'}`,true)} disabled={saving || intent.action === 'rename' && !title.trim()} onClick={() => void manage(intent.action, intent.thread)}>{intent.action === 'delete' ? <Trash2 size={15} /> : <Check size={15} />}{saving ? '저장 중' : intent.action === 'delete' ? '삭제' : '저장'}</button></div>
    </Modal>}
  </>;
}
