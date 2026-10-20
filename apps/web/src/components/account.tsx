'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Settings2, Flag, ArrowUpRight, Check } from 'lucide-react';
import { useApp } from './app-shell';
import { useLearningWorkflows } from './practice';
import { LearningPreferences } from './learning-preferences';
import { SettingsSelect } from './settings-select';
import { action, post, Breadcrumb, PageTitle, Alert, FloatingNotice, Badge, Empty, Spinner, dateLabel, targetName, targetMajor, targetDate, Modal, type Item } from './shared';

export function AccountPages({ slug = [] }: { slug?: string[] }) {
  const { data, refresh, toast } = useApp();
  const [error, setError] = useState('');
  const [welcome, setWelcome] = useState(false);
  const [savingPreference,setSavingPreference]=useState('');
  useEffect(() => { setWelcome(new URLSearchParams(window.location.search).get('welcome') === '1'); }, []);
  const settings = slug[0] === 'settings';
  if (slug[0] === 'confirmations') return <ConfirmationInbox />;
  async function preference(key: string, value: any) {
    if(savingPreference)return;
    setSavingPreference(key);
    try { await action('preference', { [key]: value }); await refresh(); setError(''); toast('설정을 저장했어요.'); }
    catch (e) { setError((e as Error).message); }
    finally { setSavingPreference(''); }
  }
  return <>
    <Breadcrumb items={[{ label: '내 계정', href: settings ? '/account' : undefined }, ...(settings ? [{ label: '설정' }] : [])]} />
    <PageTitle title={settings ? '설정' : '내 계정'} aside={!settings ? <Link className="button ghost" href="/account/settings"><Settings2 size={16} />설정</Link> : undefined} />
    {error && <Alert>{error}</Alert>}
    {welcome && !settings && <FloatingNotice onDismiss={()=>setWelcome(false)}>계정이 연결됐어요. 지원 학교를 선택해 주세요.</FloatingNotice>}
    {settings ? <section className="settings-list">
      <h2>학습·대화</h2>
      <div className="settings-row"><div><strong>설명 길이</strong></div><SettingsSelect label="설명 길이" value={data.preferences?.answerLength || 'normal'} disabled={Boolean(savingPreference)} onChange={value=>void preference('answerLength',value)} options={[{value:'short',label:'짧게'},{value:'normal',label:'보통'},{value:'long',label:'자세히'}]}/></div>
      <div className="settings-row"><div><strong>설명 방식</strong></div><SettingsSelect label="설명 방식" value={data.preferences?.explanationStyle || 'step'} disabled={Boolean(savingPreference)} onChange={value=>void preference('explanationStyle',value)} options={[{value:'step',label:'단계별로'},{value:'example',label:'예시 중심'},{value:'question',label:'질문과 함께'}]}/></div>
      <LearningPreferences/>
    </section> : <>
      <div className="account-grid">
        <section className="account-profile"><h2>{data.user.name}</h2><p>{data.user.email}</p></section>
        <section className="detail-section"><div className="section-heading"><h2>지원 정보</h2><Link href="/schools/new">학교 등록<ArrowUpRight size={15}/></Link></div>
          {data.targets.length ? data.targets.map(t => {
            const track = t.admission_type || t.admission || t.track;
            const year = t.admission_year || t.year;
            return <Link href={`/schools/${encodeURIComponent(t.id)}`} className="linked-row" key={t.id}><div className="row-text"><strong>{[targetName(t), targetMajor(t)].filter(Boolean).join(' · ')}</strong><span>{[track, year ? `${year}학년도` : null].filter(Boolean).join(' · ')}</span></div><span className="muted">면접 안내<ArrowUpRight size={14}/></span></Link>;
          }) : <Link className="linked-row" href="/schools/new"><div className="row-text"><strong>지원 학교 선택</strong><span>면접 안내와 공통 질문을 바로 확인해 보세요.</span></div><ArrowUpRight size={18}/></Link>}
        </section>
      </div>
      <section className="detail-section"><div className="section-heading"><h2>사실 확인함</h2><Flag size={18} /></div>
        <Link className="linked-row" href="/account/confirmations"><div className="row-text"><strong>내 역할과 기록 확인하기</strong><span>{data.confirmations.length ? `${data.confirmations.length}개 확인 요청` : '기억이 안 나는 내용과 정정할 사실을 남겨주세요.'}</span></div><ArrowUpRight size={20} /></Link>
      </section>
    </>}
  </>;
}

const confirmationStatusNames: Item = { confirmed_from_record: '학생부에서 확인', confirmed_by_student: '내가 확인함', needs_confirmation: '확인 필요', student_says_different: '기록과 다름', cannot_confirm: '확인할 수 없음' };
const confirmationReasonNames: Item = { cannot_recall: '기억 안 남', record_differs: '기록과 다름', role_check: '내 역할 확인' };
function confirmationStatus(item: Item) {
  const legacy: Item = { confirmed: 'confirmed_by_student', different: 'student_says_different', unknown: 'needs_confirmation', cannot_confirm: 'cannot_confirm', reviewed: 'confirmed_by_student' };
  return item.data?.confirmation_status || legacy[item.state] || 'needs_confirmation';
}

function ConfirmationInbox() {
  const { data, refresh, toast } = useApp();
  const { workflows, setWorkflows, loading, error, reload } = useLearningWorkflows();
  const [filter, setFilter] = useState('open');
  const [editing, setEditing] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [entityId, setEntityId] = useState('');
  const [question, setQuestion] = useState('');
  const [response, setResponse] = useState('');
  const [reason, setReason] = useState('cannot_recall');
  const [status, setStatus] = useState('needs_confirmation');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const sending = useRef(false);
  const requestId = useRef('');
  const confirmations: Item[] = workflows?.confirmations || [];
  const sources: Item[] = workflows?.sources || [];
  const entities: Item[] = [...(data.learning.activities || []), ...(data.learning.questions || []), ...(data.learning.source_refs || [])];
  const visible = confirmations.filter(c => filter === 'all' || (filter === 'confirmed' ? ['confirmed_from_record', 'confirmed_by_student'].includes(confirmationStatus(c)) : !['confirmed_from_record', 'confirmed_by_student'].includes(confirmationStatus(c))));
  function open(item: Item) { setEditing(item); setResponse(item.response || ''); setStatus(confirmationStatus(item) === 'confirmed_from_record' ? 'confirmed_by_student' : confirmationStatus(item)); setSaveError(''); }
  async function save() {
    if (sending.current) return;
    sending.current = true; setBusy(true); setSaveError('');
    requestId.current ||= crypto.randomUUID();
    try {
      const result = await post('/api/learning', editing ? { action: 'confirmation_respond', confirmationId: editing.id, response, status } : { action: 'confirmation_save', entityId, question: question.trim(), response, reason, requestId: requestId.current });
      if (result.data) setWorkflows(result.data); else await reload();
      await refresh(); setEditing(null); setCreating(false); setQuestion(''); setResponse(''); requestId.current = ''; toast('사실 확인함에 저장했어요.');
    } catch (err) { setSaveError((err as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  const connectedEntity = editing && entities.find(e => e.id === editing.entity_id);
  const connectedSources: Item[] = editing ? sources.filter(s => (editing.data?.source_ref_ids || connectedEntity?.source_ref_ids || []).includes(s.id) || s.id === editing.entity_id) : [];
  const canSave = editing ? !['confirmed_by_student', 'student_says_different'].includes(status) || response.trim().length > 0 : !!entityId && question.trim().length > 0;
  return <div className="learning-v2 confirmation-inbox">
    <PageTitle title="사실 확인" aside={<button className="button primary" disabled={!entities.length || loading} onClick={() => { setCreating(true); setEditing(null); setEntityId(entities[0]?.id || ''); setQuestion(''); setResponse(''); setReason('cannot_recall'); setSaveError(''); requestId.current = ''; }}>확인할 내용 남기기</button>} />
    <nav className="learning-tabs" aria-label="사실 확인 상태">{[['open', '확인할 내용'], ['confirmed', '확인한 내용'], ['all', '전체']].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</nav>
    {error && <><Alert>{error}</Alert><button className="button ghost" onClick={reload}>다시 불러오기</button></>}
    {loading && !workflows ? <Spinner /> : visible.length ? <div className="confirmation-rows">{visible.map(c => {
      const currentStatus = confirmationStatus(c);
      const entity = entities.find(e => e.id === c.entity_id);
      const href = entity && (data.learning.activities || []).some((a: Item) => a.id === entity.id) ? '/materials/activities/' + entity.id : entity && (data.learning.questions || []).some((q: Item) => q.id === entity.id) ? '/materials/questions/' + entity.id : null;
      return <section className="confirmation-row" key={c.id}>
        <div className="confirmation-row-meta"><span>{confirmationReasonNames[c.data?.reason] || '사실 확인'}</span><Badge tone={currentStatus.startsWith('confirmed') ? 'green' : 'neutral'}>{confirmationStatusNames[currentStatus] || '확인 필요'}</Badge></div>
        <h2>{c.question || c.data?.question}</h2>{c.response && <p className="confirmation-response">{c.response}</p>}
        <div className="confirmation-row-actions">{href && <Link href={href}>{entity?.title || '질문과 근거'}<ArrowUpRight size={15} /></Link>}<span>{dateLabel(c.updated_at || c.created_at)}</span><button className="button ghost" onClick={() => open(c)}>확인·회신</button></div>
        {c.data?.review_note && <p className="confirmation-review-note">담당자 의견 · {c.data.review_note}</p>}
      </section>;
    })}</div> : !error && <Empty title={filter === 'confirmed' ? '확인한 내용이 없어요' : '지금 확인할 내용이 없어요'} />}
    {(creating || editing) && <Modal title={editing ? '사실 확인·정정' : '확인할 내용 남기기'} onClose={() => { if (!busy) { setCreating(false); setEditing(null); } }}>
      {saveError && <Alert>{saveError}</Alert>}
      {editing ? <>
        <p className="body-copy">{editing.question}</p>
        {connectedSources.length > 0 && <div className="confirmation-source"><h3>학생부 근거</h3>{connectedSources.map(s => <div key={s.id}><p>{s.quote || s.text || s.content}</p><small>{[s.grade && `${s.grade}학년`, s.area, s.subject, s.page_label || s.printed_page_label].filter(Boolean).join(' · ')}</small></div>)}</div>}
        <label>확인 상태<select disabled={busy} value={status} onChange={e => setStatus(e.target.value)}><option value="confirmed_by_student">내 경험과 같아요</option><option value="student_says_different">기록과 달라요</option><option value="needs_confirmation">아직 확인이 필요해요</option><option value="cannot_confirm">확인할 수 없어요</option></select></label>
        {!!editing.history?.length && <details className="confirmation-history"><summary>확인 이력</summary>{editing.history.map((event: Item) => <div key={event.id}><time>{dateLabel(event.created_at)}</time><strong>{confirmationStatusNames[event.confirmation_status] || '확인 필요'}</strong>{event.response && <p>{event.response}</p>}{event.data?.review_note && <p>담당자 의견 · {event.data.review_note}</p>}</div>)}</details>}
      </> : <>
        <label>관련 활동·질문<select disabled={busy} value={entityId} onChange={e => { setEntityId(e.target.value); requestId.current = ''; }}>{entities.map(entity => <option key={entity.id} value={entity.id}>{entity.title || entity.prompt || [entity.grade, entity.area, entity.subject].filter(Boolean).join(' · ') || '학생부 근거'}</option>)}</select></label>
        <label>확인할 이유<select disabled={busy} value={reason} onChange={e => { setReason(e.target.value); requestId.current = ''; }}><option value="cannot_recall">기억 안 남</option><option value="record_differs">기록과 다름</option><option value="role_check">내 역할 확인</option></select></label>
        <label>확인할 내용<textarea disabled={busy} value={question} maxLength={2000} onChange={e => { setQuestion(e.target.value); requestId.current = ''; }} placeholder="어떤 부분을 확인해야 하나요?" /></label>
      </>}
      <label>나의 설명<textarea disabled={busy} value={response} maxLength={10000} onChange={e => { setResponse(e.target.value); requestId.current = ''; }} placeholder="기억나는 내용과 기록이 다른 부분을 적어주세요." /></label>
      <button className="button primary full" disabled={busy || !canSave} onClick={save}>{busy ? '저장 중' : '저장'}<Check size={16} /></button>
    </Modal>}
  </div>;
}
