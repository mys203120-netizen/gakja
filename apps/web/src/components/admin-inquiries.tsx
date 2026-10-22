'use client';
import { useEffect, useState } from 'react';
import { INQUIRY_TYPES, type InquiryType } from '@/lib/support-inquiry';
import { Breadcrumb, PageTitle } from './shared';
import styles from './public-page.module.css';

type Inquiry = { id: string; email: string; type: InquiryType; content: string; status: string; operator_note: string; created_at: string; policy_version: string; response_time_notice: string };
const states = { received: '접수됨', in_progress: '확인 중', resolved: '처리 완료' };
export function AdminInquiries() {
  const [items, setItems] = useState<Inquiry[]>([]), [error, setError] = useState(''), [offset, setOffset] = useState(0), [more, setMore] = useState(false), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetch(`/api/support/inquiries?offset=${offset}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '문의를 불러오지 못했어요.');
      setItems(body.inquiries); setMore(body.hasMore);
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset]);
  return <><Breadcrumb items={[{ label: '운영 현황', href: '/admin' }, { label: '문의 관리' }]}/><PageTitle title="문의 관리"/><p>답변받을 이메일로 별도 회신한 뒤 처리 상태와 메모를 남겨 주세요. 개인정보·삭제 요청은 본인과 대상 자료를 확인한 후 처리해 주세요.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}{loading ? <p role="status">문의를 불러오고 있어요…</p> : items.length ? items.map(item => <InquiryRow key={item.id} item={item}/>) : <p>접수된 문의가 없어요.</p>}
    <div className={styles.actions}><button type="button" className={styles.button} disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 30))}>이전</button><button type="button" className={styles.button} disabled={!more || loading} onClick={() => setOffset(value => value + 30)}>다음</button></div>
  </>;
}
function InquiryRow({ item }: { item: Inquiry }) {
  const [state, setState] = useState(item.status), [note, setNote] = useState(item.operator_note), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function save() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/support/inquiries', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, status: state, note }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '저장하지 못했어요.');
      setMessage('처리 상태를 저장했어요.');
    } catch (error) { setMessage(error instanceof Error ? error.message : '저장하지 못했어요.'); }
    finally { setBusy(false); }
  }
  return <section className={styles.inquiry} aria-label={`${INQUIRY_TYPES[item.type]} 문의`}><h2>{INQUIRY_TYPES[item.type]}</h2><p className={styles.receipt}>접수번호: {item.id}</p><p>{new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))} · 답변 이메일: {item.email}</p><pre>{item.content}</pre><p className={styles.hint}>접수 당시 응답 안내: {item.response_time_notice}<br/>동의 방침 버전: {item.policy_version}</p><div className={styles.form}><label className={styles.field}>처리 상태<select value={state} onChange={event => setState(event.target.value)} disabled={busy}>{Object.entries(states).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label className={styles.field}>운영 메모<textarea maxLength={5000} value={note} onChange={event => setNote(event.target.value)} disabled={busy}/></label><div className={styles.actions}><button type="button" className={styles.button} onClick={() => void save()} disabled={busy}>{busy ? '저장 중…' : '처리 내역 저장'}</button><span role="status">{message}</span></div></div></section>;
}
