'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { Ellipsis, LogOut, Settings2, UserRound, X } from 'lucide-react';

export function AccountMenu({ name, admin, compact = false, onLogout }: { name: string; admin: boolean; compact?: boolean; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null), lock = useRef(false);
  const id = useId(), path = usePathname();
  useEffect(() => { setOpen(false); setConfirm(false); }, [path]);
  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus(); }
  useEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(248, window.innerWidth - 24), height = admin ? 126 : 170;
    setPosition({ left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12), top: compact ? rect.bottom + 10 : Math.max(12, rect.top - height - 10) });
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const resize = () => close(true);
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [open, admin, compact]);
  useEffect(() => {
    if (!confirm || !dialog.current) return;
    dialog.current.showModal();
    dialog.current.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return () => { dialog.current?.close(); trigger.current?.focus(); };
  }, [confirm]);
  async function logout() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await onLogout(); }
    catch (err) { setError((err as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <button ref={trigger} type="button" className={compact ? 'account-trigger compact' : 'account-trigger'} aria-label={`${name} 계정 메뉴`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      <span className="avatar">{name.slice(0, 1)}</span><span className="account-name">{name}</span><Ellipsis className="account-chevron" size={18} aria-hidden="true"/>
    </button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label="계정 메뉴" className="account-popover" style={position} onKeyDown={event => {
      const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []), index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      if (event.key === 'Tab') close(true);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    }}>
      {!admin && <Link role="menuitem" href="/account" onClick={() => close()}><UserRound size={17}/>내 계정</Link>}
      <Link role="menuitem" href={admin ? '/admin/settings' : '/account/settings'} onClick={() => close()}><Settings2 size={17}/>설정</Link>
      <button type="button" role="menuitem" onClick={() => { close(); setError(''); setConfirm(true); }}><LogOut size={17}/>로그아웃</button>
    </div>, document.body)}
    {confirm && createPortal(<dialog ref={dialog} className="logout-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); if (!busy) setConfirm(false); }} onClick={event => { if (event.target === dialog.current && !busy) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setConfirm(false); } }}>
      <button className="icon-button logout-close" aria-label="닫기" disabled={busy} onClick={() => setConfirm(false)}><X size={19}/></button>
      <span className="logout-symbol"><LogOut size={25} strokeWidth={1.5}/></span>
      <h2 id={`${id}-title`}>로그아웃할까요?</h2>
      <p id={`${id}-description`}>저장하지 않은 입력은 사라질 수 있어요.</p>
      {error && <p role="alert" className="logout-error">{error}</p>}
      <div className="logout-actions"><button type="button" data-cancel className="button ghost" disabled={busy} onClick={() => setConfirm(false)}>계속 이용하기</button><button type="button" className="button primary" disabled={busy} onClick={logout}>{busy ? '로그아웃 중' : '로그아웃'}</button></div>
    </dialog>, document.body)}
  </>;
}
