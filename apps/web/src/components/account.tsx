'use client';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Settings2, Flag, ArrowUpRight, Check } from 'lucide-react';
import { useApp } from './app-shell';
import { useLearningWorkflows } from './practice';
import { LearningPreferences } from './learning-preferences';
import { SettingsSelect } from './settings-select';
import {PublicLinks} from './public-links';
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
    <PageTitle title={settings ? '설정' : '내 계정'} aside={!settings ? <Link className={ownedClassName("button ghost")} href="/account/settings"><Settings2 size={16} />설정</Link> : undefined} />
    {error && <Alert>{error}</Alert>}
    {welcome && !settings && <FloatingNotice onDismiss={()=>setWelcome(false)}>계정이 연결됐어요. 지원 학교를 선택해 주세요.</FloatingNotice>}
    {settings ? <section className={ownedClassName("settings-list",true)}>
      <h2 className={ownedClassName(undefined,true)}>학습·대화</h2>
      <div className={ownedClassName("settings-row",true)}><div className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>설명 길이</strong></div><SettingsSelect label="설명 길이" value={data.preferences?.answerLength || 'normal'} disabled={Boolean(savingPreference)} onChange={value=>void preference('answerLength',value)} options={[{value:'short',label:'짧게'},{value:'normal',label:'보통'},{value:'long',label:'자세히'}]}/></div>
      <div className={ownedClassName("settings-row",true)}><div className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>설명 방식</strong></div><SettingsSelect label="설명 방식" value={data.preferences?.explanationStyle || 'step'} disabled={Boolean(savingPreference)} onChange={value=>void preference('explanationStyle',value)} options={[{value:'step',label:'단계별로'},{value:'example',label:'예시 중심'},{value:'question',label:'질문과 함께'}]}/></div>
      <LearningPreferences/>
    </section> : <>
      <div className={ownedClassName("account-grid",true)}>
        <section className={ownedClassName("account-profile",true)}><h2 className={ownedClassName(undefined,true)}>{data.user.name}</h2><p className={ownedClassName(undefined,true)}>{data.user.email}</p></section>
        <section className={ownedClassName("detail-section",true)}><div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>지원 정보</h2><Link href="/schools/new">학교 등록<ArrowUpRight size={15}/></Link></div>
          {data.targets.length ? data.targets.map(t => {
            const track = t.admission_type || t.admission || t.track;
            const year = t.admission_year || t.year;
            return <Link href={`/schools/${encodeURIComponent(t.id)}`} className={ownedClassName("linked-row")} key={t.id}><div className={ownedClassName("row-text",true)}><strong className={ownedClassName(undefined,true)}>{[targetName(t), targetMajor(t)].filter(Boolean).join(' · ')}</strong><span className={ownedClassName(undefined,true)}>{[track, year ? `${year}학년도` : null].filter(Boolean).join(' · ')}</span></div><span className={ownedClassName("muted",true)}>면접 안내<ArrowUpRight size={14}/></span></Link>;
          }) : <Link className={ownedClassName("linked-row")} href="/schools/new"><div className={ownedClassName("row-text",true)}><strong className={ownedClassName(undefined,true)}>지원 학교 선택</strong><span className={ownedClassName(undefined,true)}>면접 안내와 공통 질문을 바로 확인해 보세요.</span></div><ArrowUpRight size={18}/></Link>}
        </section>
      </div>
      <section className={ownedClassName("detail-section",true)}><div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>사실 확인함</h2><Flag size={18} /></div>
        <Link className={ownedClassName("linked-row")} href="/account/confirmations"><div className={ownedClassName("row-text",true)}><strong className={ownedClassName(undefined,true)}>내 역할과 기록 확인하기</strong><span className={ownedClassName(undefined,true)}>{data.summary?.confirmations ? `${data.summary.confirmations}개 확인 요청` : '기억이 안 나는 내용과 정정할 사실을 남겨주세요.'}</span></div><ArrowUpRight size={20} /></Link>
      </section>
    </>}
    <section className={ownedClassName("detail-section",true)}><div className={ownedClassName("section-heading",true)}><h2 className={ownedClassName(undefined,true)}>이용 안내</h2></div><Link className={ownedClassName("linked-row")} href="/contact?type=privacy"><div className={ownedClassName("row-text",true)}><strong className={ownedClassName(undefined,true)}>개인정보 및 삭제 요청</strong><span className={ownedClassName(undefined,true)}>자료 열람·정정·삭제와 계정 관련 요청을 남겨주세요.</span></div><ArrowUpRight size={18}/></Link><PublicLinks/></section>
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
  return <div className={ownedClassName("learning-v2 confirmation-inbox",true)}>
    <PageTitle title="사실 확인" aside={<button className={ownedClassName("button primary",true)} disabled={!entities.length || loading} onClick={() => { setCreating(true); setEditing(null); setEntityId(entities[0]?.id || ''); setQuestion(''); setResponse(''); setReason('cannot_recall'); setSaveError(''); requestId.current = ''; }}>확인할 내용 남기기</button>} />
    <nav className={ownedClassName("learning-tabs",true)} aria-label="사실 확인 상태">{[['open', '확인할 내용'], ['confirmed', '확인한 내용'], ['all', '전체']].map(([key, label]) => <button key={key} className={ownedClassName(filter === key ? 'active' : '',true)} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</nav>
    {error && <><Alert>{error}</Alert><button className={ownedClassName("button ghost",true)} onClick={reload}>다시 불러오기</button></>}
    {loading && !workflows ? <Spinner /> : visible.length ? <div className={ownedClassName("confirmation-rows",true)}>{visible.map(c => {
      const currentStatus = confirmationStatus(c);
      const entity = entities.find(e => e.id === c.entity_id);
      const href = entity && (data.learning.activities || []).some((a: Item) => a.id === entity.id) ? '/materials/activities/' + entity.id : entity && (data.learning.questions || []).some((q: Item) => q.id === entity.id) ? '/materials/questions/' + entity.id : null;
      return <section className={ownedClassName("confirmation-row",true)} key={c.id}>
        <div className={ownedClassName("confirmation-row-meta",true)}><span className={ownedClassName(undefined,true)}>{confirmationReasonNames[c.data?.reason] || '사실 확인'}</span><Badge tone={currentStatus.startsWith('confirmed') ? 'green' : 'neutral'}>{confirmationStatusNames[currentStatus] || '확인 필요'}</Badge></div>
        <h2 className={ownedClassName(undefined,true)}>{c.question || c.data?.question}</h2>{c.response && <p className={ownedClassName("confirmation-response",true)}>{c.response}</p>}
        <div className={ownedClassName("confirmation-row-actions",true)}>{href && <Link href={href}>{entity?.title || '질문과 근거'}<ArrowUpRight size={15} /></Link>}<span className={ownedClassName(undefined,true)}>{dateLabel(c.updated_at || c.created_at)}</span><button className={ownedClassName("button ghost",true)} onClick={() => open(c)}>확인·회신</button></div>
        {c.data?.review_note && <p className={ownedClassName("confirmation-review-note",true)}>담당자 의견 · {c.data.review_note}</p>}
      </section>;
    })}</div> : !error && <Empty title={filter === 'confirmed' ? '확인한 내용이 없어요' : '지금 확인할 내용이 없어요'} />}
    {(creating || editing) && <Modal title={editing ? '사실 확인·정정' : '확인할 내용 남기기'} onClose={() => { if (!busy) { setCreating(false); setEditing(null); } }}>
      {saveError && <Alert>{saveError}</Alert>}
      {editing ? <>
        <p className={ownedClassName("body-copy",true)}>{editing.question}</p>
        {connectedSources.length > 0 && <div className={ownedClassName("confirmation-source",true)}><h3 className={ownedClassName(undefined,true)}>학생부 근거</h3>{connectedSources.map(s => <div key={s.id} className={ownedClassName(undefined,true)}><p className={ownedClassName(undefined,true)}>{s.quote || s.text || s.content}</p><small className={ownedClassName(undefined,true)}>{[s.grade && `${s.grade}학년`, s.area, s.subject, s.page_label || s.printed_page_label].filter(Boolean).join(' · ')}</small></div>)}</div>}
        <label className={ownedClassName(undefined,true)}>확인 상태<select disabled={busy} value={status} onChange={e => setStatus(e.target.value)} className={ownedClassName(undefined,true)}><option value="confirmed_by_student" className={ownedClassName(undefined,true)}>내 경험과 같아요</option><option value="student_says_different" className={ownedClassName(undefined,true)}>기록과 달라요</option><option value="needs_confirmation" className={ownedClassName(undefined,true)}>아직 확인이 필요해요</option><option value="cannot_confirm" className={ownedClassName(undefined,true)}>확인할 수 없어요</option></select></label>
        {!!editing.history?.length && <details className={ownedClassName("confirmation-history",true)}><summary className={ownedClassName(undefined,true)}>확인 이력</summary>{editing.history.map((event: Item) => <div key={event.id} className={ownedClassName(undefined,true)}><time className={ownedClassName(undefined,true)}>{dateLabel(event.created_at)}</time><strong className={ownedClassName(undefined,true)}>{confirmationStatusNames[event.confirmation_status] || '확인 필요'}</strong>{event.response && <p className={ownedClassName(undefined,true)}>{event.response}</p>}{event.data?.review_note && <p className={ownedClassName(undefined,true)}>담당자 의견 · {event.data.review_note}</p>}</div>)}</details>}
      </> : <>
        <label className={ownedClassName(undefined,true)}>관련 활동·질문<select disabled={busy} value={entityId} onChange={e => { setEntityId(e.target.value); requestId.current = ''; }} className={ownedClassName(undefined,true)}>{entities.map(entity => <option key={entity.id} value={entity.id} className={ownedClassName(undefined,true)}>{entity.title || entity.prompt || [entity.grade, entity.area, entity.subject].filter(Boolean).join(' · ') || '학생부 근거'}</option>)}</select></label>
        <label className={ownedClassName(undefined,true)}>확인할 이유<select disabled={busy} value={reason} onChange={e => { setReason(e.target.value); requestId.current = ''; }} className={ownedClassName(undefined,true)}><option value="cannot_recall" className={ownedClassName(undefined,true)}>기억 안 남</option><option value="record_differs" className={ownedClassName(undefined,true)}>기록과 다름</option><option value="role_check" className={ownedClassName(undefined,true)}>내 역할 확인</option></select></label>
        <label className={ownedClassName(undefined,true)}>확인할 내용<textarea disabled={busy} value={question} maxLength={2000} onChange={e => { setQuestion(e.target.value); requestId.current = ''; }} placeholder="어떤 부분을 확인해야 하나요?" className={ownedClassName(undefined,true)} /></label>
      </>}
      <label className={ownedClassName(undefined,true)}>나의 설명<textarea disabled={busy} value={response} maxLength={10000} onChange={e => { setResponse(e.target.value); requestId.current = ''; }} placeholder="기억나는 내용과 기록이 다른 부분을 적어주세요." className={ownedClassName(undefined,true)} /></label>
      <button className={ownedClassName("button primary full",true)} disabled={busy || !canSave} onClick={save}>{busy ? '저장 중' : '저장'}<Check size={16} /></button>
    </Modal>}
  </div>;
}
