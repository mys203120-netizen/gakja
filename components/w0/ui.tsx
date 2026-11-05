'use client';

import Link from 'next/link';
import { ArrowUpRight, CircleAlert, Clock3, FileClock, Inbox, LockKeyhole, PlugZap, type LucideIcon } from 'lucide-react';
import type { W0Status } from '@/lib/w0/view-model';
import styles from './W0.module.css';

export function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className={styles.heading}><p className={styles.eyebrow}>{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>;
}

export function MenuCard({ href, icon: Icon, label, state }: { href: string; icon: LucideIcon; label: string; state?: string }) {
  return <Link href={href} className={styles.menuCard}><span className={styles.cardIcon}><Icon size={25} aria-hidden="true" /></span><span className={styles.cardLabel}>{label}{state && <small>{state}</small>}</span><ArrowUpRight size={18} className={styles.cardArrow} aria-hidden="true" /></Link>;
}

const notices: Record<Exclude<W0Status, 'ready'>, { icon: LucideIcon; title: string; body: string }> = {
  disconnected: { icon: PlugZap, title: '학습 공간을 준비하고 있어요', body: '개인 자료와 이용 현황은 아직 확인할 수 없어요. 메뉴를 둘러보며 준비할 내용을 확인해 보세요.' },
  loading: { icon: Clock3, title: '자료를 불러오고 있어요', body: '확인된 자료가 도착하면 이곳에 표시해요.' },
  empty: { icon: Inbox, title: '아직 등록된 자료가 없어요', body: '지원처와 학생부를 등록하면 나에게 맞는 준비를 시작할 수 있어요.' },
  pending: { icon: FileClock, title: '자료 확인을 기다리고 있어요', body: '분석과 검수가 끝나면 열람할 수 있어요. 확인되지 않은 내용은 먼저 보여드리지 않아요.' },
  error: { icon: CircleAlert, title: '자료를 불러오지 못했어요', body: '잠시 후 다시 확인해 주세요. 문제가 계속되면 고객센터에서 도움을 받을 수 있어요.' },
  forbidden: { icon: LockKeyhole, title: '이 기능의 이용 범위를 확인해 주세요', body: '현재 이용 가능한 기능을 확인한 뒤 학습을 이어갈 수 있어요.' },
  review_required: { icon: FileClock, title: '평가 검수 대기', body: '답변 기록은 보존되며, 평가 자료의 검수가 끝난 뒤 결과를 확인할 수 있어요. 점수는 아직 확정되지 않았어요.' },
};

export function StateNotice({ status, compact = false }: { status: W0Status; compact?: boolean }) {
  if (status === 'ready') return null;
  const { icon: Icon, title, body } = notices[status];
  return <div className={`${styles.notice} ${compact ? styles.compactNotice : ''}`} data-state={status} role={status === 'error' ? 'alert' : 'status'}><Icon size={21} aria-hidden="true" /><div><strong>{title}</strong><p>{body}</p></div></div>;
}
