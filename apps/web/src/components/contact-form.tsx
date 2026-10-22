'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { INQUIRY_TYPES } from '@/lib/support-inquiry';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy-policy';
import styles from './public-page.module.css';
import { SettingsSelect } from './settings-select';

type Receipt = { receipt: string; email: string; responseTime: string };
export function ContactForm({ responseTime, retention, initialType = 'service' }: { responseTime: string; retention: string; initialType?: 'service' | 'privacy' }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [type, setType] = useState<string>(initialType);
  const requestId = useRef(''), lastPayload = useRef(''), sending = useRef(false), success = useRef<HTMLDivElement>(null);
  useEffect(() => { if (receipt) success.current?.focus(); }, [receipt]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const payload = { email: form.get('email'), type, content: form.get('content'), consent: form.get('consent') === 'on', policyVersion: PRIVACY_POLICY_VERSION, website: form.get('website') };
    const signature = JSON.stringify(payload);
    if (!requestId.current || signature !== lastPayload.current) { requestId.current = crypto.randomUUID(); lastPayload.current = signature; }
    try {
      const response = await fetch('/api/support/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, requestId: requestId.current }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '접수하지 못했어요. 잠시 후 다시 시도해 주세요.');
      setReceipt(result);
    } catch (error) { setError(error instanceof Error ? error.message : '접수하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
    finally { sending.current = false; setBusy(false); }
  }
  if (receipt) return <div className={styles.success} ref={success} tabIndex={-1} role="status"><h2>문의가 접수됐어요</h2><p className={styles.receipt}>접수번호: <strong>{receipt.receipt}</strong></p><p>답변은 <strong>{receipt.email}</strong>로 보내드려요.</p><p>{receipt.responseTime}</p><p>이 화면은 문의 저장 완료 안내예요. 확인 메일이 자동 발송되지는 않아요.</p><div className={styles.actions}><Link href="/">홈으로</Link><button className={styles.button} type="button" onClick={() => { requestId.current = ''; setReceipt(null); }}>새 문의 작성</button></div></div>;
  return <form className={styles.form} onSubmit={submit} aria-busy={busy}>
    <label className={styles.field}>답변받을 이메일<input type="email" name="email" autoComplete="email" maxLength={254} required disabled={busy}/></label>
    <div className={styles.field}><span>문의 유형</span><SettingsSelect label="문의 유형" name="type" value={type} onChange={setType} disabled={busy} fullWidth options={Object.entries(INQUIRY_TYPES).map(([value,label])=>({value,label}))}/></div>
    <label className={styles.field}>문의 내용<textarea name="content" maxLength={5000} rows={7} required disabled={busy}/><span className={styles.hint}>5,000자 이내로 적어 주세요. 비밀번호·주민등록번호·학생부 원문은 보내지 마세요. 삭제 요청은 대상 자료와 요청 범위를 알려 주세요.</span></label>
    <label className={styles.trap} aria-hidden="true">웹사이트<input name="website" tabIndex={-1} autoComplete="off"/></label>
    <div className={styles.notice}><strong>문의 접수를 위한 개인정보 수집·이용</strong><p>이메일·문의 유형·문의 내용·접수 및 동의 시각을 문의 확인과 답변에 사용해요. 로그인한 경우 계정과 연결해 요청자를 확인해요.</p><p>보관 안내: {retention}</p><p>동의를 거부할 수 있으며 거부하면 이 양식으로 접수할 수 없어요. <Link href="/privacy">개인정보 처리방침</Link>에서 자세히 확인해 주세요.</p></div>
    <label className={styles.consent}><input name="consent" type="checkbox" required disabled={busy}/><span>문의 접수를 위한 개인정보 수집·이용에 동의해요. (필수)</span></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <p className={styles.hint}>{responseTime}</p><button type="submit" className={styles.button} disabled={busy}>{busy ? '접수하고 있어요…' : '문의 접수하기'}</button>
  </form>;
}
