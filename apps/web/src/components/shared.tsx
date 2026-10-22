'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import { ChevronRight, LoaderCircle, X, Check, ArrowUpRight, CircleHelp } from 'lucide-react';
import type { ReactNode, RefObject, ButtonHTMLAttributes } from 'react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { requestJson } from '@/lib/client/request-cache';
export {seedClientRequestIdentity,peekRequestJson as peekApi} from '@/lib/client/request-cache';
import modalStyles from './modal.module.css';
import {InfoTip} from './info-tip';
import tooltipStyles from './tooltip.module.css';
export {InfoTip} from './info-tip';
export {FloatingNotice} from './floating-notice';
export type Item = Record<string, any>;
export type Bootstrap = { user: Item; targets: Item[]; package: Item | null; documents: Item[]; learning: Item; answers: Item[]; memoryAttempts: Item[]; threads: Item[]; interviews: Item[]; reports: Item[]; confirmations: Item[]; notifications: Item[]; admin?: Item; [key:string]:any };
export async function api<T = any>(url: string, options?: RequestInit): Promise<T> { return requestJson<T>(url, options); }
export const post = (url: string, body: any) => api(url, { method: 'POST', body: JSON.stringify(body) });
export const action = (action: string, payload: any = {}) => post('/api/actions', { action, payload });
export function ActionButton({pending=false,pendingLabel,disabled,children,type='button',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{pending?:boolean;pendingLabel?:ReactNode}) {
  return <button {...props} type={type} disabled={disabled||pending} aria-busy={pending||undefined} data-pending={pending||undefined} className={ownedClassName((props).className,true)}>{pending?<><LoaderCircle size={16} className={ownedClassName("spin cta-spinner")} aria-hidden="true"/>{pendingLabel??children}</>:children}</button>;
}
export function Logo({ size = 34, wordmark = true }: { size?: number; wordmark?: boolean }) { return <span className={ownedClassName("brand",true)}><img src="/brand-logo.svg" width={size} alt="" className={ownedClassName(undefined,true)} />{wordmark && <strong className={ownedClassName("brand-wordmark",true)}><span aria-hidden="true" className={ownedClassName(undefined,true)}>각자</span><sup className={ownedClassName("brand-on-sup",true)} aria-hidden="true"><img className={ownedClassName("brand-on-image",true)} src="/brand-on.png" alt="" width={26} height={15}/></sup><span className={ownedClassName("sr-only",true)}>각자ON</span></strong>}</span>; }
export function Spinner() { return <div className={ownedClassName("loading",true)}><LoaderCircle className={ownedClassName("spin")} size={25} /><span className={ownedClassName(undefined,true)}>불러오는 중</span></div>; }
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={ownedClassName(`badge ${tone}`,true)}>{children}</span>; }
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  if(!items.length)return null;
  return <nav className={ownedClassName("breadcrumb",true)} aria-label="현재 위치">{items.map((item,i)=><span key={i} className={ownedClassName(undefined,true)}>{i>0&&<ChevronRight size={13} aria-hidden="true"/>}{i===items.length-1?<span aria-current="page">{item.label}</span>:item.href?<Link href={item.href}>{item.label}</Link>:<span>{item.label}</span>}</span>)}</nav>;
}
const tabTitles=new Set(['연습','퀴즈','모의면접','AI 비서','내 경험','자료','내 교재','지식한입','시사 브리핑','지원 학교','내 리포트','내 기록','연습 이력','답변 비교','활동','예상 질문']);
export function PageTitle({ title, children, aside, questionId,titleMode,help }: { eyebrow?: string; title: string; children?: ReactNode; aside?: ReactNode; questionId?:string;titleMode?:'visible'|'tab';help?:ReactNode }) {
  const tab=titleMode==='tab'||(titleMode!=='visible'&&!questionId&&tabTitles.has(title));
  return <div className={ownedClassName('page-title'+(tab?' '+tooltipStyles.tabTitle:''),true)} data-tab-title={tab||undefined} data-title-only={tab&&!help&&!aside||undefined}><div className={ownedClassName(tab?tooltipStyles.tabTitleContent:undefined,true)}><h1 className={ownedClassName(tab?tooltipStyles.hiddenTitle:undefined,true)} data-question-key={questionId}>{title}</h1>{!tab&&children&&<div className={ownedClassName("subtitle",true)}>{children}</div>}{help&&<InfoTip label={title+' 안내'}>{help}</InfoTip>}</div>{aside}</div>;
}
export function Empty({ title = '아직 기록이 없어요', children, href, label }: { title?: string; children?: ReactNode; href?: string; label?: string }) { return <div className={ownedClassName("empty",true)}><CircleHelp size={28} /><h3 className={ownedClassName(undefined,true)}>{title}</h3>{children && <p className={ownedClassName(undefined,true)}>{children}</p>}{href && <Link className={ownedClassName("button primary")} href={href}>{label || '시작하기'}</Link>}</div>; }
export function Alert({ children }: { children: ReactNode }) { return <div className={ownedClassName("alert",true)} role="alert">{children}</div>; }
export function Modal({ title, onClose, children, initialFocusRef }: { title: string; onClose: () => void; children: ReactNode; initialFocusRef?: RefObject<HTMLElement | null> }) {
  const dialog=useRef<HTMLDialogElement>(null),id=useId();
  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;document.body.style.overflow='hidden';element?.showModal();const initialFocus=initialFocusRef?.current||element?.querySelector<HTMLElement>('[data-autofocus]');initialFocus?.focus({preventScroll:true});return()=>{element?.close();document.body.style.overflow=overflow;previous?.focus({preventScroll:true});};},[]);
  return createPortal(<dialog ref={dialog} className={ownedClassName(`modal-backdrop native-modal ${modalStyles.backdrop}`,true)} aria-labelledby={id} onKeyDown={event=>{
    if(event.key!=='Tab')return;
    const items=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(item=>item.getClientRects().length>0);
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><section className={ownedClassName(`modal ${modalStyles.surface}`,true)}><div className={ownedClassName(`section-heading ${modalStyles.heading}`,true)}><h2 id={id} className={ownedClassName(undefined,true)}>{title}</h2><button type="button" className={ownedClassName("icon-button",true)} aria-label="닫기" onClick={onClose}><X size={20}/></button></div>{children}</section></dialog>,document.body);
}
export function LinkedRow({ href, title, subtitle, end, children }: { href: string; title: string; subtitle?: string; end?: ReactNode; children?: ReactNode }) { return <Link className={ownedClassName("linked-row")} href={href}>{children}<div className={ownedClassName("row-text",true)}><strong className={ownedClassName(undefined,true)}>{title}</strong>{subtitle && <span className={ownedClassName(undefined,true)}>{subtitle}</span>}</div>{end || <ArrowUpRight size={18} />}</Link>; }
export function dateLabel(value?: string) { return value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' }).format(new Date(value)) : '일정 미정'; }
export function dday(value?: string) { if (!value) return '미정'; const koreaDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); const days = Math.round((Date.parse(koreaDay(new Date(value))) - Date.parse(koreaDay(new Date()))) / 86400000); return days === 0 ? 'D-DAY' : days > 0 ? `D-${days}` : `D+${-days}`; }
export function targetName(target?: Item) { return target?.university || target?.institution_name || target?.institution || target?.name || '지원처 미등록'; }
export function targetMajor(target?: Item) { return target?.department || target?.major || target?.recruitment_unit || ''; }
export function targetDate(target?: Item) { return target?.interview_date || target?.interview_at || target?.data?.interview_date; }
export function CheckIcon() { return <Check size={16} />; }
