'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MessagesSquare, Camera, Play, ArrowRight, Plus, Minus, BookOpen } from 'lucide-react';
import { useApp } from './app-shell';
import { LearningHelp } from './learning-help';
import {QuestionExperiencePicker} from './question-experience-picker';
import { api, ActionButton, PageTitle, Breadcrumb, Alert, targetName, type Item } from './shared';
import { hasInterviewSelection, interviewPreviewHref, interviewSetupHref, interviewSetupState, sourceVersionInput, type InterviewSetupState } from '@/lib/interview-flow';
import { learningScopeIdentity } from '@/lib/learning-target-scope';
import {interviewSupportForTarget} from '@/lib/school-interview-scope';

const modes = [{ id: 'basic', name: '기본', copy: '한 질문씩 차근차근' }, { id: 'document', name: '서류 집중', copy: '내 역할과 활동 과정' }, { id: 'major', name: '전공 심화', copy: '개념과 탐구의 깊이' }, { id: 'university', name: '대학 맞춤', copy: '지원처에 연결한 경험' }] as const;
function Switch({ label, value, onChange }: { label: string; value: boolean; onChange: () => void }) {
  return <label className={ownedClassName("toggle-row",true)}><span className={ownedClassName(undefined,true)}>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={value} className={ownedClassName("motion-toggle-button",true)} onClick={onChange}><span className={ownedClassName("motion-toggle-track",true)} aria-hidden="true"><span className={ownedClassName("motion-toggle-thumb",true)}/></span></button></label>;
}

export function InterviewSetup({ kind }: { kind: 'chat' | 'video' }) {
  const { data, targetId: appTargetId, setTargetId, openResource } = useApp();
  const router = useRouter(); const params = useSearchParams();
  const state = interviewSetupState(params);
  const targetId = params.get('targetId') || appTargetId;
  const target = data.targets.find(t => t.id === targetId);
  const interviewSupport=target?interviewSupportForTarget(target):null;
  const selected = hasInterviewSelection(params);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const schoolScope=JSON.stringify([data.user.id,targetId,learningScopeIdentity(target||{})]);
  const [catalogResult, setCatalog] = useState<Item | null>(null);
  const catalog=catalogResult?.scope===schoolScope?catalogResult.value:null;
  const [preview, setPreview] = useState<Item | null>(null);
  const [previewError, setPreviewError] = useState(''); const [previewLoading, setPreviewLoading] = useState(true);
  const previewHref = interviewPreviewHref(params, targetId);
  useEffect(() => { let active = true;const controller=new AbortController();setCatalog(null);api('/api/schools?scope=learning'+(targetId?'&targetId='+encodeURIComponent(targetId):''),{signal:controller.signal}).then(r => { if (active) setCatalog({scope:schoolScope,value:r}); }).catch(() => { if (active) setCatalog(null); }); return () => { active = false;controller.abort(); }; }, [schoolScope]);
  useEffect(() => { if (targetId && data.targets.some(t => t.id === targetId) && targetId !== appTargetId) setTargetId(targetId); }, [targetId, appTargetId, data.targets]);
  useEffect(() => {
    let active = true; setPreviewLoading(true); setPreviewError(''); setPreview(null);
    api(previewHref).then(r => { if (active) setPreview(r); }).catch(e => { if (active) setPreviewError((e as Error).message); }).finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [previewHref]);
  const personalPractice=preview?.practiceScope==='personal_record'&&preview?.practiceAllowed!==false;
  const profile = personalPractice?null:(data.schoolProfiles || []).filter((p: Item) => p.target_id === targetId).sort((a: Item, b: Item) => b.revision - a.revision)[0] || catalog?.targets?.find((t: Item) => t.id === targetId)?.profile;
  const school = profile?.data || profile || {};
  const provenance=profile?.provenance||profile?.source;
  const official = profile?.status === 'official_confirmed' && !profile?.stale && !profile?.is_stale && !profile?.needs_revalidation;
  const supported = !school.format || ['document_individual', 'document', 'document_based', '서류기반'].includes(school.format);
  const range = official && supported && school.interviewer_count?.min <= 5 ? { min: school.interviewer_count.min, max: Math.min(school.interviewer_count.max, 5) } : null;
  const panelistCount = range ? Math.max(range.min, Math.min(range.max, params.has('panelists') ? state.panelistCount : range.min)) : state.panelistCount;
  const commonOnly = preview?.sourceKind === 'common' || !data.package;
  const hasSchoolTalent=Boolean(preview?.questions?.some((item:Item)=>item.talent_profile));
  const unavailableMode=personalPractice&&state.mode==='university'||commonOnly && (state.mode==='document' || state.mode==='university' && !hasSchoolTalent);
  const effectiveMode = unavailableMode ? 'basic' : state.mode;
  const question = preview?.question || (!params.get('sourceVersion') || String(params.get('sourceVersion')) === String(data.package?.active_version) ? (data.learning?.questions || []).find((q: Item) => q.id === params.get('questionId')) : null);
  const activity = (preview?.activities || data.learning?.activities || []).find((a: Item) => a.id === params.get('activityId') || question?.activity_ids?.includes(a.id));
  const ready = (preview?.practiceAllowed??interviewSupport?.supported!==false)&&!previewLoading && !previewError && Boolean(preview?.questions?.length || preview?.question || catalog?.commonAvailable && !selected);
  function update(next: Partial<InterviewSetupState> & { targetId?: string }) { router.replace(interviewSetupHref(kind, params, next), { scroll: false }); }
  function selectQuestion(id: string) {
    const next = new URLSearchParams(params.toString()); next.set('questionId', id); next.set('sourceType', 'common'); next.delete('activityId'); next.delete('briefingId'); next.delete('briefingQuestionIndex'); next.delete('sourceVersion'); next.delete('assisted');
    router.replace(interviewSetupHref(kind, next, { count: 1 }), { scroll: false });
  }
  function markPreparedHelp() {
    const next = new URLSearchParams(params.toString()); next.set('assisted', '1');
    router.replace(interviewSetupHref(kind, next), { scroll: false });
  }
  async function start() {
    if (!ready || busy) return; setBusy(true); setError('');
    try {
      const response = await api('/api/interviews', { method: 'POST', body: JSON.stringify({ action: 'start', experienceCardId:params.get('experienceCardId')||undefined, experienceRevision:params.get('experienceRevision')||undefined, kind, mode: effectiveMode, targetId: targetId || undefined, questionId: params.get('questionId') || undefined, sourceType: commonOnly ? 'common' : params.get('sourceType') === 'personal' ? 'personal' : undefined, sourceVersion: sourceVersionInput(params), briefingId: params.get('briefingId') || undefined, briefingQuestionIndex: params.has('briefingQuestionIndex') ? Number(params.get('briefingQuestionIndex')) : undefined, activityId: params.get('activityId') || undefined, assisted: params.get('assisted') === '1', followups: state.followups, pressure: state.pressure, panelistCount, difficulty: state.difficulty, feedbackTiming: state.timing, questionCount: state.count, requestId: crypto.randomUUID() }) });
      router.push(`/interview/${response.session.id}?kind=${kind}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className={ownedClassName("interview-v2",true)}>
    <Breadcrumb items={[{ label: '모의면접', href: '/interview' }, { label: '새 면접' }]} />
    <PageTitle title={params.get('questionId') || params.get('briefingId') ? '이 질문 말하기' : params.get('activityId') ? '이 활동 말하기' : '모의면접 준비'} />
    {error && <Alert>{error}</Alert>}
    {personalPractice&&<div className={ownedClassName("interview-common-note",true)}><strong className={ownedClassName(undefined,true)}>{preview?.practiceLabel}</strong><p className={ownedClassName(undefined,true)}>{preview?.practiceNotice}</p></div>}
    {!previewLoading&&!previewError&&interviewSupport&&!interviewSupport.supported&&!personalPractice&&<Alert>{interviewSupport.reason} <Link href="/schools">지원 정보 확인</Link></Alert>}
    <div className={ownedClassName("interview-setup-layout",true)}>
      <section className={ownedClassName("interview-setup-main",true)}>
        <div className={ownedClassName("interview-format-tabs",true)} aria-label="답변 방식">
          <Link className={ownedClassName(kind === 'chat' ? 'active' : '')} aria-current={kind === 'chat' ? 'page' : undefined} href={interviewSetupHref('chat', params, { panelistCount, targetId })}><MessagesSquare size={18} />Chat</Link>
          <Link className={ownedClassName(kind === 'video' ? 'active' : '')} aria-current={kind === 'video' ? 'page' : undefined} href={interviewSetupHref('video', params, { panelistCount, targetId })}><Camera size={18} />Live</Link>
        </div>
        {selected && <section className={ownedClassName('interview-selected-question'+(question?.talent_profile?' interview-talent-question':''),true)} aria-labelledby="selected-question-title">
          <span className={ownedClassName("interview-context-label",true)}>{params.get('briefingId') ? '브리핑에서 이어서' : question?.talent_profile ? '학교 가치 질문 · 공식 원문 기반 연습' : question?.source_type === 'general_practice' ? '공통 연습 질문' : question ? activity?.title || '선택한 질문' : '연결된 활동'}</span>
          <h2 id="selected-question-title" data-question-key={!previewLoading?question?.id:undefined} className={ownedClassName(undefined,true)}>{previewLoading ? '질문을 확인하고 있어요.' : question?.prompt || activity?.title || '연결된 질문을 확인해 주세요.'}</h2>
          {previewError && <Alert>{previewError}{params.get('experienceCardId')&&<Link className={ownedClassName("text-link")} href={'/armory?card='+encodeURIComponent(params.get('experienceCardId')!)}>경험 카드 확인하고 다시 연결하기 →</Link>}</Alert>}
          {question?.talent_profile && question?.source_snapshot?.url && <a className={ownedClassName("text-link",true)} href={question.source_snapshot.url} target="_blank" rel="noreferrer">{question.source_snapshot.title}<ArrowRight size={14}/></a>}
          {!previewLoading && !previewError && (params.get('briefingId') ? <button className={ownedClassName("text-link",true)} type="button" onClick={() => openResource({ kind: 'briefing', id: params.get('briefingId') || undefined })}><BookOpen size={15} />브리핑과 근거</button> : (question || activity) && <LearningHelp questionId={question?.id} activityId={activity?.id} targetId={targetId} sourceVersion={commonOnly ? undefined : sourceVersionInput(params)} onAssisted={markPreparedHelp} snapshot={{ learning: { answer_scripts: [], memory_items: [], questions: preview?.questions || data.learning?.questions || [], activities: preview?.activities || data.learning?.activities || [], source_refs: preview?.sources || data.learning?.source_refs || [] }, documents: [] }} />)}
        </section>}
        {question&&!previewLoading&&!previewError&&<QuestionExperiencePicker key={[question.id,params.get('sourceVersion'),targetId].join(':')} question={{id:question.id,prompt:question.prompt}} targetId={targetId} value={preview?.experienceCard||null} onSelect={card=>{const next=new URLSearchParams(params.toString());if(card){next.set('experienceCardId',card.id);next.set('experienceRevision',String(card.revision));}else{next.delete('experienceCardId');next.delete('experienceRevision');}router.replace(interviewSetupHref(kind,next),{scroll:false});}}/>}
        {preview?.experienceCard && <section className={ownedClassName("detail-section",true)}><span className={ownedClassName("muted small",true)}>내 경험 · 학생이 확인한 경험</span><h3 className={ownedClassName(undefined,true)}>{preview.experienceCard.data.title}</h3><p className={ownedClassName(undefined,true)}>이 경험을 떠올려 선택한 질문에 답해보세요.</p><Link className={ownedClassName("text-link")} href={'/armory?card='+preview.experienceCard.id}>경험 카드 확인하기</Link></section>}
        {params.get('experienceCardId') && data.interviews?.some(s=>s.state==='active') && <p className={ownedClassName("interview-common-note",true)}>진행 중인 면접이 있어요. <Link href="/interview">기존 면접 이어하기</Link> 또는 아래에서 새 연습을 시작하세요.</p>}
        <div className={ownedClassName("interview-quick-start",true)}>
          {!selected && <h2 className={ownedClassName(undefined,true)}>{commonOnly ? '내 말로 시작해요.' : '한 번 더, 내 말로.'}</h2>}
          <p className={ownedClassName(undefined,true)}>{state.count}문항 · {kind === 'video' ? '질문 듣기 · 음성 답변 자동 저장' : '글로 답변'} · {state.timing === 'turn' ? '질문마다 피드백' : '마친 뒤 피드백'}</p>
          <ActionButton className={ownedClassName("button primary large")} disabled={busy || !ready} pending={busy || previewLoading} pendingLabel={busy ? '면접 준비 중' : '질문 불러오는 중'} onClick={start}><Play size={17} fill="currentColor" aria-hidden="true" />{kind === 'video' ? 'Live 면접 준비' : selected ? '이 질문 연습 시작' : '모의면접 시작'}</ActionButton>
          {!selected && previewError && <Alert>{previewError}</Alert>}
        </div>
        {commonOnly && !data.package && <div className={ownedClassName("interview-common-note",true)}><p className={ownedClassName(undefined,true)}>내 생기부 질문은 아직 준비 중이에요. {ready?'지금은 공통 질문으로 면접을 연습해 보세요.':data.targets.length?'연습할 수 있는 공통 질문을 확인해 주세요.':'먼저 지원 학교를 등록해 주세요.'}</p>{!data.targets.length&&<Link className={ownedClassName("text-link")} href="/schools/new">학교 등록<ArrowRight size={14} /></Link>}</div>}
        {!selected && commonOnly && catalog?.commonQuestions?.length > 0 && <section className={ownedClassName("interview-common-questions",true)} aria-label="공통 질문 골라 연습"><h3 className={ownedClassName(undefined,true)}>한 질문만 연습하기</h3>{(catalog?.commonQuestions || []).slice(0, 3).map((q: Item) => <button type="button" key={q.id} onClick={() => selectQuestion(q.id)} className={ownedClassName(undefined,true)}>{q.prompt}<ArrowRight size={16} /></button>)}</section>}
        <div className={ownedClassName("interview-school-note",true)}>
          <h3 className={ownedClassName(undefined,true)}>{personalPractice?'일반 경험 면접':target ? targetName(target) : '학교 면접 안내'}</h3>
          <p className={ownedClassName(undefined,true)}>{personalPractice?'내 자료의 질문과 이전 답변을 연결해 연습해요. 지원 전형의 실제 면접과는 구분해 기록해요.':!profile ? '학교 정보 확인 전 · 일반 면접 연습' : !supported ? '이 학교의 면접 형식은 전용 연습 준비 중이에요.' : official ? `${school.admission_year || ''} ${school.admission_type || ''} ${school.interview_stage || ''}` : '공식 운영 정보 확인 전 · 일반 면접 연습'}</p>
          <Link className={ownedClassName("text-link")} href={targetId ? `/schools/${encodeURIComponent(targetId)}` : '/schools'}>면접 개요 보기<ArrowRight size={14} /></Link>
          {provenance?.source_url && <a href={provenance.source_url} target="_blank" rel="noreferrer" className={ownedClassName(undefined,true)}>학교 원문 확인 <ArrowRight size={13} /></a>}
        </div>
        {kind === 'video' && <p className={ownedClassName("interview-device-note",true)}><Camera size={18} />시작 후 카메라·마이크를 직접 연결합니다.</p>}
      </section>
      <aside className={ownedClassName("interview-setup-settings",true)}>
        <label className={ownedClassName(undefined,true)}>지원처<select value={targetId} onChange={e => { setTargetId(e.target.value); update({ targetId: e.target.value }); }} className={ownedClassName(undefined,true)}>{data.targets.length ? data.targets.map(t => <option key={t.id} value={t.id} className={ownedClassName(undefined,true)}>{[targetName(t), t.department || t.major].filter(Boolean).join(" · ")}</option>) : <option value="" className={ownedClassName(undefined,true)}>공통 질문 연습</option>}</select></label>
        <button type="button" className={ownedClassName("interview-advanced-toggle",true)} aria-expanded={state.advanced} aria-controls="interview-advanced" onClick={() => update({ advanced: !state.advanced })}>상세 설정{state.advanced ? <Minus size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}</button>
        {state.advanced && <div id="interview-advanced" className={ownedClassName("interview-advanced",true)}>
          <h2 className={ownedClassName(undefined,true)}>연습 유형</h2>
          <div className={ownedClassName("interview-preset-list",true)} role="radiogroup" aria-label="연습 유형">{modes.map(m => <label key={m.id} className={ownedClassName(effectiveMode === m.id ? 'selected' : '',true)}><strong className={ownedClassName(undefined,true)}>{m.name}</strong><span className={ownedClassName(undefined,true)}>{m.copy}</span><input type="radio" name="interview-mode" value={m.id} checked={effectiveMode === m.id} disabled={personalPractice&&m.id==='university'||commonOnly && (m.id==='document' || m.id==='university' && !hasSchoolTalent)} onChange={() => update({ mode: m.id })} className={ownedClassName(undefined,true)} /></label>)}</div>
          <label className={ownedClassName(undefined,true)}>본 질문<select value={state.count} onChange={e => update({ count: Number(e.target.value) })} className={ownedClassName(undefined,true)}>{Array.from({ length: 8 }, (_, i) => i + 1).map(n => <option value={n} key={n} className={ownedClassName(undefined,true)}>{n}개</option>)}</select></label>
          <label className={ownedClassName(undefined,true)}>면접관<select value={panelistCount} onChange={e => update({ panelistCount: Number(e.target.value) })} className={ownedClassName(undefined,true)}>{Array.from({ length: range ? range.max - range.min + 1 : 5 }, (_, i) => range ? range.min + i : i + 1).map(n => <option value={n} key={n} className={ownedClassName(undefined,true)}>{n}명{!range ? ' · 연습 설정' : ''}</option>)}</select></label>
          <label className={ownedClassName(undefined,true)}>질문 깊이<select value={state.difficulty} onChange={e => update({ difficulty: e.target.value as 'standard' | 'deep' })} className={ownedClassName(undefined,true)}><option value="standard" className={ownedClassName(undefined,true)}>기본</option><option value="deep" className={ownedClassName(undefined,true)}>심화</option></select></label>
          <label className={ownedClassName(undefined,true)}>피드백<select value={state.timing} onChange={e => update({ timing: e.target.value as 'turn' | 'end' })} className={ownedClassName(undefined,true)}><option value="end" className={ownedClassName(undefined,true)}>종료 후</option><option value="turn" className={ownedClassName(undefined,true)}>질문마다</option></select></label>
          <Switch label="꼬리질문" value={state.followups} onChange={() => update({ followups: !state.followups })} />
          <Switch label="압박" value={state.pressure} onChange={() => update({ pressure: !state.pressure })} />
        </div>}
      </aside>
    </div>
  </div>;
}
