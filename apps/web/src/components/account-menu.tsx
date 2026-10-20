'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { Ellipsis, LogOut, Settings2, UserRound } from 'lucide-react';

export function AccountMenu({ name, admin, compact = false, onLogout }: { name: string; admin: boolean; compact?: boolean; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), lock = useRef(false);
  const id = useId(), path = usePathname();
  useEffect(() => { setOpen(false); setError(''); }, [path]);
  function close(restore = false) { if(lock.current)return;setOpen(false); if (restore) trigger.current?.focus({preventScroll:true}); }
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(248, window.innerWidth - 24), height = admin ? 126 : 170;
    setPosition({ left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12), top: compact ? rect.bottom + 10 : Math.max(12, rect.top - height - 10) });
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({preventScroll:true});
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const resize = () => close(true);
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [open, admin, compact]);
  async function logout() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await onLogout(); }
    catch (err) { setError((err as Error).message); lock.current = false; setBusy(false); }
  }
  return <>
    <button ref={trigger} type="button" className={compact ? 'account-trigger compact' : 'account-trigger'} aria-label={`${name} 계정 메뉴`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={busy} onClick={() => setOpen(value => !value)}>
      <span className="avatar">{name.slice(0, 1)}</span><span className="account-name">{name}</span><Ellipsis className="account-chevron" size={18} aria-hidden="true"/>
    </button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label="계정 메뉴" aria-busy={busy} className="account-popover" style={position} onKeyDown={event => {
      const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []), index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      if (event.key === 'Tab') close(true);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus({preventScroll:true}); }
    }}>
      {!admin && <Link role="menuitem" href="/account" aria-disabled={busy||undefined} onClick={event => {if(lock.current)event.preventDefault();else close();}}><UserRound size={17}/>내 계정</Link>}
      <Link role="menuitem" href={admin ? '/admin/settings' : '/account/settings'} aria-disabled={busy||undefined} onClick={event => {if(lock.current)event.preventDefault();else close();}}><Settings2 size={17}/>설정</Link>
      <button type="button" role="menuitem" disabled={busy} onClick={()=>void logout()}><LogOut size={17}/>{busy?'저장하고 로그아웃 중…':'로그아웃'}</button>
      {error&&<p role="alert" className="logout-error">{error}</p>}
    </div>, document.body)}

  </>;
}
