'use client';
import Link from 'next/link';
import { ChevronRight, LoaderCircle, X, Check, ArrowUpRight, CircleHelp } from 'lucide-react';
import type { ReactNode, RefObject, ButtonHTMLAttributes } from 'react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { requestJson } from '@/lib/client/request-cache';
import modalStyles from './modal.module.css';
export type Item = Record<string, any>;
export type Bootstrap = { user: Item; targets: Item[]; package: Item | null; documents: Item[]; learning: Item; answers: Item[]; memoryAttempts: Item[]; threads: Item[]; interviews: Item[]; reports: Item[]; confirmations: Item[]; notifications: Item[]; admin?: Item; [key:string]:any };
export async function api<T = any>(url: string, options?: RequestInit): Promise<T> { return requestJson<T>(url, options); }
export const post = (url: string, body: any) => api(url, { method: 'POST', body: JSON.stringify(body) });
export const action = (action: string, payload: any = {}) => post('/api/actions', { action, payload });
export function ActionButton({pending=false,pendingLabel,disabled,children,type='button',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{pending?:boolean;pendingLabel?:ReactNode}) {
  return <button {...props} type={type} disabled={disabled||pending} aria-busy={pending||undefined} data-pending={pending||undefined}>{pending?<><LoaderCircle size={16} className="spin cta-spinner" aria-hidden="true"/>{pendingLabel??children}</>:children}</button>;
}
export function Logo({ size = 34, wordmark = true }: { size?: number; wordmark?: boolean }) { return <span className="brand"><img src="/brand-logo.svg" width={size} alt="" />{wordmark && <strong>각자의답</strong>}</span>; }
export function Spinner() { return <div className="loading"><LoaderCircle className="spin" size={25} /><span>불러오는 중</span></div>; }
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) { const parents = items.slice(0, -1).filter(item => item.href); if (!parents.length) return null; return <nav className="breadcrumb" aria-label="상위 페이지">{parents.map((item, i) => <span key={i}>{i > 0 && <ChevronRight size={13}/>}<Link href={item.href!}>{item.label}</Link></span>)}</nav>; }
export function PageTitle({ title, children, aside, questionId }: { eyebrow?: string; title: string; children?: ReactNode; aside?: ReactNode; questionId?:string }) { return <div className="page-title"><div><h1 data-question-key={questionId}>{title}</h1>{children && <div className="subtitle">{children}</div>}</div>{aside}</div>; }
export function Empty({ title = '아직 기록이 없어요', children, href, label }: { title?: string; children?: ReactNode; href?: string; label?: string }) { return <div className="empty"><CircleHelp size={28} /><h3>{title}</h3>{children && <p>{children}</p>}{href && <Link className="button primary" href={href}>{label || '시작하기'}</Link>}</div>; }
export function Alert({ children }: { children: ReactNode }) { return <div className="alert" role="alert">{children}</div>; }
export function Modal({ title, onClose, children, initialFocusRef }: { title: string; onClose: () => void; children: ReactNode; initialFocusRef?: RefObject<HTMLElement | null> }) {
  const dialog=useRef<HTMLDialogElement>(null),id=useId();
  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';element?.showModal();const initialFocus=initialFocusRef?.current||element?.querySelector<HTMLElement>('[data-autofocus]');initialFocus?.focus();return()=>{element?.close();document.body.style.overflow=overflow;previous?.focus();};},[]);
  return createPortal(<dialog ref={dialog} className={`modal-backdrop native-modal ${modalStyles.backdrop}`} aria-labelledby={id} onKeyDown={event=>{
    if(event.key!=='Tab')return;
    const items=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(item=>item.getClientRects().length>0);
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><section className={`modal ${modalStyles.surface}`}><div className={`section-heading ${modalStyles.heading}`}><h2 id={id}>{title}</h2><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={20}/></button></div>{children}</section></dialog>,document.body);
}
export function LinkedRow({ href, title, subtitle, end, children }: { href: string; title: string; subtitle?: string; end?: ReactNode; children?: ReactNode }) { return <Link className="linked-row" href={href}>{children}<div className="row-text"><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div>{end || <ArrowUpRight size={18} />}</Link>; }
export function dateLabel(value?: string) { return value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' }).format(new Date(value)) : '일정 미정'; }
export function dday(value?: string) { if (!value) return '미정'; const koreaDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); const days = Math.round((Date.parse(koreaDay(new Date(value))) - Date.parse(koreaDay(new Date()))) / 86400000); return days === 0 ? 'D-DAY' : days > 0 ? `D-${days}` : `D+${-days}`; }
export function targetName(target?: Item) { return target?.university || target?.institution_name || target?.institution || target?.name || '지원처 미등록'; }
export function targetMajor(target?: Item) { return target?.department || target?.major || target?.recruitment_unit || ''; }
export function targetDate(target?: Item) { return target?.interview_date || target?.interview_at || target?.data?.interview_date; }
export function CheckIcon() { return <Check size={16} />; }
