'use client';
import {ownedClassName} from './owned-class-name';


import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, ExternalLink, Plus, RotateCcw, Search, Trash2, Users } from 'lucide-react';
import { useApp } from './app-shell';
import { api, post, Alert, Badge, Breadcrumb, Empty, Modal, PageTitle, Spinner } from './shared';
import type { AdmissionSchedule } from '@/lib/schedule';
import { isReferenceCalendarUrl, visibleCalendarSourceLabel, visibleCalendarSourceText } from '@/lib/calendar-source-presentation';
import './admin-calendar.css';

type CalendarStatus = 'dated' | 'no_interview' | 'date_pending' | 'unpublished' | 'unverified';
type SchoolOption = { id: string; university: string; registrationCount: number; departments?: { id: string; name: string; campus: string }[] };
type CalendarRow = {
  id: string; schoolReferenceId: string; university: string; admissionYear: number; trackLabel: string;
  departments: string[]; campus: string | null; status: CalendarStatus; dates: string[];
  format: 'in_person' | 'video_submission'; sourceUrl: string; sourceLabel: string; rawDate: string;
  note: string | null; checkedAt: string; revision: number; origin: 'acon' | 'official' | 'admin'; modified: boolean; deleted: boolean;
};
type Registration = {
  targetId: string; schoolReferenceId: string | null; university: string; department: string; campus: string;
  track: string; admissionYear: number; student: { id: string; name: string; email: string; active: boolean };
  registeredAt: string; personalSchedule: Partial<AdmissionSchedule> | null; personalRevision: number;
};
type CalendarData = { admissionYear: number; schools: SchoolOption[]; rows: CalendarRow[]; registrations: Registration[]; counts: { rows: number; registrations: number } };
type PendingAction = { kind: 'delete' | 'restore'; row: CalendarRow } | { kind: 'personal_delete'; registration: Registration };
type Tab = 'common' | 'registrations' | 'deleted';

const endpoint = '/api/admin/admission-calendar';
const statusNames: Record<CalendarStatus, string> = { dated: '일정 등록', no_interview: '면접 미실시', date_pending: '날짜 미정', unpublished: '일정 미공개', unverified: '확인 필요' };
const reviewNames: Record<string, string> = { awaiting: '개별 발표 대기', needs_review: '검수 필요', reviewed: '검수 완료', changed: '변경 확인' };
const statusTone = (value: CalendarStatus) => value === 'dated' ? 'green' : ['date_pending', 'unverified'].includes(value) ? 'amber' : 'neutral';
const safeUrl = (value: string | null | undefined) => { try { const url = new URL(value || ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !isReferenceCalendarUrl(value) ? url.href : ''; } catch { return ''; } };
const koreanDay = (value: string | null | undefined) => {
  if (!value) return ''; const parsed = new Date(value.length === 10 ? `${value}T00:00:00+09:00` : value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
};
const koreanTime = (value: string | null | undefined) => {
  if (!value || !value.includes('T')) return ''; const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed) : '';
};
const shortDay = (value: string) => { const day = koreanDay(value); return day ? `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}` : ''; };
function dateSummary(dates: string[]) {
  const unique = [...new Set(dates)].sort(), spans: string[][] = [];
  for (const value of unique) {
    const previous = spans.at(-1), last = previous?.at(-1);
    if (last && Date.parse(`${value}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`) === 86400000) previous!.push(value);
    else spans.push([value]);
  }
  return spans.map(span => span.length > 1 ? `${shortDay(span[0])}–${shortDay(span.at(-1)!)}` : shortDay(span[0])).join(' · ');
}
const savedPersonal = (schedule: Partial<AdmissionSchedule> | null) => !!schedule && !!(schedule.personal_date || schedule.personal_at || schedule.period_start || schedule.period_end || schedule.location || schedule.source_url || schedule.checked_at || schedule.review_note || schedule.required_materials?.length);
function personalSummary(registration: Registration) {
  const schedule = registration.personalSchedule;
  if (schedule?.personal_at || schedule?.personal_date) { const value = schedule.personal_at || schedule.personal_date!; return `${koreanDay(value)}${koreanTime(value) ? ` ${koreanTime(value)}` : ' · 시간 미정'}`; }
  if (schedule?.period_start && schedule.period_end) return `${shortDay(schedule.period_start)}${schedule.period_start === schedule.period_end ? '' : `–${shortDay(schedule.period_end)}`} · 개별 일정 대기`;
  if (schedule?.period_start || schedule?.period_end) return `${shortDay(schedule.period_start || schedule.period_end!)} ${schedule.period_start ? '이후' : '이전'} · 개별 일정 대기`;
  return '개별 일정 미등록';
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className={ownedClassName("admin-calendar-field",true)}><span className={ownedClassName(undefined,true)}>{label}</span>{children}{hint && <small className={ownedClassName(undefined,true)}>{hint}</small>}</label>; }
function SourceLink({ url, label }: { url: string | null | undefined; label?: string }) { const href = safeUrl(url); return href ? <a className={ownedClassName("text-link",true)} href={href} target="_blank" rel="noopener noreferrer">{visibleCalendarSourceLabel(label, url) || '출처 원문'}<ExternalLink size={13} /></a> : null; }
const rowSourceLabel = (row: CalendarRow) => row.modified && row.origin === 'official' ? '입학처 원문' : visibleCalendarSourceLabel(row.sourceLabel, row.sourceUrl) || '출처 원문';

export function AdminAdmissionCalendar() {
  const app = useApp();
  const [value, setValue] = useState<CalendarData | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('common'), [school, setSchool] = useState(''), [term, setTerm] = useState(''), [status, setStatus] = useState('all'), [page, setPage] = useState(1);
  const [editing, setEditing] = useState<CalendarRow | 'new' | null>(null), [personal, setPersonal] = useState<Registration | null>(null), [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false), [operationError, setOperationError] = useState('');
  const loadSequence = useRef(0), list = useRef<HTMLElement>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    setError('');
    try { const result = await api<CalendarData>(endpoint, { signal, cache: 'no-store' }); if (sequence === loadSequence.current && !signal?.aborted) setValue(result); }
    catch (err) { if (sequence === loadSequence.current && !signal?.aborted) { setError((err as Error).message); throw err; } }
    finally { if (sequence === loadSequence.current && !signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(() => {}); return () => { controller.abort(); loadSequence.current++; }; }, [load]);
  useEffect(() => { setPage(1); }, [tab, school, term, status]);
  const schools = value?.schools || [], registrations = value?.registrations || [], allRows = value?.rows || [];
  const registrationCounts = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const entry of registrations) { const key = entry.schoolReferenceId || entry.university; if (!counts.has(key)) counts.set(key, new Set()); counts.get(key)!.add(entry.student.id); }
    return counts;
  }, [registrations]);
  const filteredRows = allRows.filter(row => row.deleted === (tab === 'deleted') && (!school || row.schoolReferenceId === school) && (status === 'all' || row.status === status) && `${row.university} ${row.trackLabel} ${row.departments.join(' ')} ${row.campus || ''}`.toLowerCase().includes(term.trim().toLowerCase())).sort((a, b) => a.university.localeCompare(b.university, 'ko') || a.trackLabel.localeCompare(b.trackLabel, 'ko') || a.id.localeCompare(b.id));
  const filteredRegistrations = registrations.filter(entry => (!school || (school === 'unlinked' ? !entry.schoolReferenceId : entry.schoolReferenceId === school)) && `${entry.university} ${entry.department} ${entry.track} ${entry.student.name} ${entry.student.email}`.toLowerCase().includes(term.trim().toLowerCase()));
  const total = tab === 'registrations' ? filteredRegistrations.length : filteredRows.length, perPage = 40, pages = Math.max(1, Math.ceil(total / perPage)), currentPage = Math.min(page, pages);
  const visibleRows = filteredRows.slice((currentPage - 1) * perPage, currentPage * perPage), visibleRegistrations = filteredRegistrations.slice((currentPage - 1) * perPage, currentPage * perPage);
  const changeTab = (next: Tab) => { setTab(next); setOperationError(''); if (next !== 'registrations' && school === 'unlinked') setSchool(''); };
  const showRegistrations = (schoolId: string) => { changeTab('registrations'); setSchool(schoolId); setTerm(''); };
  async function mutate(body: Record<string, unknown>, message: string, close: () => void) {
    if (busy) return; setBusy(true); setOperationError('');
    try { await post(endpoint, body); close(); app.toast(message); await Promise.all([load(), app.refresh()]); }
    catch (err) { setOperationError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function confirmAction() {
    if (!pending) return;
    if (pending.kind === 'personal_delete') await mutate({ action: 'personal_delete', targetId: pending.registration.targetId, expectedRevision: pending.registration.personalRevision }, '개인 면접 일정을 삭제했습니다.', () => setPending(null));
    else await mutate({ action: pending.kind, id: pending.row.id, expectedRevision: pending.row.revision }, pending.kind === 'restore' ? '학교 공통 일정을 복원했습니다.' : '학교 공통 일정을 삭제했습니다.', () => setPending(null));
  }
  const liveCount = allRows.filter(row => !row.deleted).length, deletedCount = allRows.length - liveCount;
  const closeEditor = () => { if (!busy) { setEditing(null); setOperationError(''); } };
  const closePersonal = () => { if (!busy) { setPersonal(null); setOperationError(''); } };
  return <div className={ownedClassName("admin-calendar",true)}>
    <Breadcrumb items={[{ label: '운영 현황', href: '/admin' }, { label: '면접 일정' }]} />
    <PageTitle title="면접 일정" aside={<button className={ownedClassName("button primary",true)} onClick={() => { setOperationError(''); setEditing('new'); }} disabled={loading || !value}><Plus size={17} />학교 일정 추가</button>}>
      {value ? `${value.admissionYear}학년도 · ${schools.length}개 학교` : '학교 일정과 개인 면접 일정'}
    </PageTitle>
    <div className={ownedClassName("admin-calendar-tabs",true)} role="tablist" aria-label="면접 일정 관리">
      {([['common', '학교 공통 일정', liveCount], ['registrations', '학교 등록 계정', new Set(registrations.map(entry => entry.student.id)).size], ['deleted', '삭제 내역', deletedCount]] as const).map(([key, label, count]) => <button key={key} type="button" role="tab" id={`calendar-tab-${key}`} aria-selected={tab === key} aria-controls="admin-calendar-list" className={ownedClassName(tab === key ? 'active' : '',true)} onClick={() => changeTab(key)}>{label}<span className={ownedClassName(undefined,true)}>{count}</span></button>)}
    </div>
    <div className={ownedClassName("admin-calendar-toolbar",true)}>
      <label className={ownedClassName("admin-calendar-school-filter",true)}><span className={ownedClassName("sr-only",true)}>학교 필터</span><select aria-label="학교 필터" value={school} onChange={event => setSchool(event.target.value)} className={ownedClassName(undefined,true)}><option value="" className={ownedClassName(undefined,true)}>학교 전체</option>{schools.map(option => <option key={option.id} value={option.id} className={ownedClassName(undefined,true)}>{option.university}{registrationCounts.get(option.id)?.size ? ` · ${registrationCounts.get(option.id)!.size}명 등록` : ''}</option>)}{tab === 'registrations' && registrations.some(entry => !entry.schoolReferenceId) && <option value="unlinked" className={ownedClassName(undefined,true)}>학교 미연결 계정</option>}</select></label>
      <div className={ownedClassName("search-field",true)}><Search size={17} /><input aria-label={tab === 'registrations' ? '학교 등록 계정 검색' : '학교 면접 일정 검색'} value={term} onChange={event => setTerm(event.target.value)} placeholder={tab === 'registrations' ? '이름·이메일·학교·학과 검색' : '학교·전형·학과 검색'} className={ownedClassName(undefined,true)} /></div>
      {tab !== 'registrations' && <label className={ownedClassName("admin-calendar-status-filter",true)}><span className={ownedClassName("sr-only",true)}>일정 상태 필터</span><select aria-label="일정 상태 필터" value={status} onChange={event => setStatus(event.target.value)} className={ownedClassName(undefined,true)}><option value="all" className={ownedClassName(undefined,true)}>상태 전체</option>{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key} className={ownedClassName(undefined,true)}>{label}</option>)}</select></label>}
    </div>
    {error && <Alert>{error}<button type="button" className={ownedClassName("text-link",true)} onClick={() => void load().catch(() => {})}>다시 불러오기<RotateCcw size={14} /></button></Alert>}
    {operationError && !editing && !personal && !pending && <Alert>{operationError}</Alert>}
    <section id="admin-calendar-list" ref={list} role="tabpanel" aria-labelledby={`calendar-tab-${tab}`} aria-busy={loading} className={ownedClassName(undefined,true)}>
      <div className={ownedClassName("admin-calendar-list-meta",true)}><span className={ownedClassName(undefined,true)}>{tab === 'registrations' ? `${total}개 지원처` : `${total}건`}</span><span className={ownedClassName(undefined,true)}>{tab === 'registrations' ? '개별 면접 시간은 계정별로 저장됩니다.' : tab === 'deleted' ? '삭제한 학교 공통 일정을 복원할 수 있습니다.' : '학교 공통 일정은 해당 지원 계정의 캘린더에 반영됩니다.'}</span></div>
      {loading ? <Spinner /> : tab === 'registrations' ? visibleRegistrations.length ? <>
        <div className={ownedClassName("admin-calendar-grid-head registration",true)}><span className={ownedClassName(undefined,true)}>등록 계정</span><span className={ownedClassName(undefined,true)}>학교·지원 정보</span><span className={ownedClassName(undefined,true)}>개인 일정 · 한국 시간</span><span className={ownedClassName("sr-only",true)}>관리</span></div>
        {visibleRegistrations.map(entry => <article className={ownedClassName("admin-calendar-row registration",true)} key={entry.targetId}>
          <div className={ownedClassName("admin-calendar-identity",true)}><Link href={`/admin/students/${entry.student.id}`}>{entry.student.name}<ArrowUpRight size={13} /></Link><span className={ownedClassName(undefined,true)}>{entry.student.email}</span>{!entry.student.active && <small className={ownedClassName(undefined,true)}>비활성 계정</small>}<small className={ownedClassName(undefined,true)}>{koreanDay(entry.registeredAt) ? `${koreanDay(entry.registeredAt)} 등록` : '등록일 미확인'}</small></div>
          <div className={ownedClassName("admin-calendar-scope",true)}><h3 className={ownedClassName(undefined,true)}>{entry.university}</h3><p className={ownedClassName(undefined,true)}>{entry.department || '학과 미등록'}</p><span className={ownedClassName(undefined,true)}>{[entry.track || '전형 미등록', entry.campus, entry.admissionYear ? `${entry.admissionYear}학년도` : ''].filter(Boolean).join(' · ')}</span>{!entry.schoolReferenceId && <small className={ownedClassName("admin-calendar-unlinked",true)}>학교 카탈로그 연결 필요</small>}</div>
          <div className={ownedClassName("admin-calendar-date",true)}><p className={ownedClassName(undefined,true)}>{personalSummary(entry)}</p>{entry.personalSchedule?.location && <span className={ownedClassName(undefined,true)}>{entry.personalSchedule.location}</span>}{savedPersonal(entry.personalSchedule) && <small className={ownedClassName(undefined,true)}>{reviewNames[entry.personalSchedule?.status || ''] || '검수 필요'}</small>}<SourceLink url={entry.personalSchedule?.source_url} /></div>
          <div className={ownedClassName("admin-calendar-row-actions",true)}><button type="button" className={ownedClassName("button small secondary",true)} onClick={() => { setOperationError(''); setPersonal(entry); }}>{savedPersonal(entry.personalSchedule) ? '개인 일정 수정' : '개인 일정 설정'}</button>{savedPersonal(entry.personalSchedule) && <button className={ownedClassName("icon-button",true)} type="button" aria-label={`${entry.student.name} ${entry.university} 개인 일정 삭제`} onClick={() => { setOperationError(''); setPending({ kind: 'personal_delete', registration: entry }); }}><Trash2 size={16} /></button>}</div>
        </article>)}
      </> : <Empty title="조건에 맞는 학교 등록 계정이 없습니다" /> : visibleRows.length ? <>
        <div className={ownedClassName("admin-calendar-grid-head common",true)}><span className={ownedClassName(undefined,true)}>학교·적용 범위</span><span className={ownedClassName(undefined,true)}>면접 일정 · 2026년</span><span className={ownedClassName(undefined,true)}>출처</span><span className={ownedClassName("sr-only",true)}>관리</span></div>
        {visibleRows.map(row => <article className={ownedClassName(`admin-calendar-row common${row.deleted ? ' deleted' : ''}`,true)} key={row.id}>
          <div className={ownedClassName("admin-calendar-scope",true)}><h3 className={ownedClassName(undefined,true)}>{row.university}</h3><p className={ownedClassName(undefined,true)}>{row.trackLabel || '전체 전형'}{row.campus ? ` · ${row.campus}` : ''}</p>{row.departments.length > 3 ? <details className={ownedClassName("admin-calendar-departments",true)}><summary className={ownedClassName(undefined,true)}>{row.departments.slice(0, 2).join(' · ')} 외 {row.departments.length - 2}개 모집단위</summary><p className={ownedClassName(undefined,true)}>{row.departments.join(' · ')}</p></details> : <span className={ownedClassName(undefined,true)}>{row.departments.length ? row.departments.join(' · ') : '해당 전형 전체 모집단위'}</span>}{registrationCounts.get(row.schoolReferenceId)?.size ? <button className={ownedClassName("text-link admin-calendar-registrants",true)} type="button" onClick={() => showRegistrations(row.schoolReferenceId)}><Users size={13} />등록 계정 {registrationCounts.get(row.schoolReferenceId)!.size}명<ChevronRight size={13} /></button> : null}</div>
          <div className={ownedClassName("admin-calendar-date",true)}><Badge tone={row.deleted ? 'neutral' : statusTone(row.status)}>{row.deleted ? '삭제됨' : statusNames[row.status]}</Badge>{row.status === 'dated' && <p className={ownedClassName(undefined,true)}>{dateSummary(row.dates)}</p>}{row.format === 'video_submission' && row.status === 'dated' && <span className={ownedClassName(undefined,true)}>동영상 면접 제출기간</span>}{visibleCalendarSourceText(row.note) && <details className={ownedClassName("admin-calendar-note",true)}><summary className={ownedClassName(undefined,true)}>안내 내용</summary><p className={ownedClassName(undefined,true)}>{visibleCalendarSourceText(row.note)}</p></details>}</div>
          <div className={ownedClassName("admin-calendar-source",true)}><SourceLink url={row.sourceUrl} label={rowSourceLabel(row)} />{!safeUrl(row.sourceUrl) && (row.origin === 'admin' || visibleCalendarSourceLabel(row.sourceLabel, row.sourceUrl)) && <span className={ownedClassName(undefined,true)}>{row.origin === 'admin' ? '관리자 등록' : visibleCalendarSourceLabel(row.sourceLabel, row.sourceUrl)}</span>}{row.modified && row.origin !== 'admin' && <small className={ownedClassName(undefined,true)}>관리자 수정</small>}{row.origin === 'admin' && safeUrl(row.sourceUrl) && <small className={ownedClassName(undefined,true)}>관리자 등록</small>}{koreanDay(row.checkedAt) && <small className={ownedClassName(undefined,true)}>{koreanDay(row.checkedAt)} 확인</small>}</div>
          <div className={ownedClassName("admin-calendar-row-actions",true)}>{row.deleted ? <button type="button" className={ownedClassName("button small secondary",true)} onClick={() => { setOperationError(''); setPending({ kind: 'restore', row }); }}><RotateCcw size={14} />복원</button> : <><button type="button" className={ownedClassName("button small secondary",true)} onClick={() => { setOperationError(''); setEditing(row); }}>수정</button><button className={ownedClassName("icon-button",true)} type="button" aria-label={`${row.university} ${row.trackLabel} 공통 일정 삭제`} onClick={() => { setOperationError(''); setPending({ kind: 'delete', row }); }}><Trash2 size={16} /></button></>}</div>
        </article>)}
      </> : <Empty title={tab === 'deleted' ? '삭제한 일정이 없습니다' : '조건에 맞는 학교 일정이 없습니다'} />}
      {!loading && total > perPage && <nav className={ownedClassName("admin-calendar-pagination",true)} aria-label="일정 페이지"><button type="button" className={ownedClassName("button small secondary",true)} disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); list.current?.scrollIntoView({ block: 'start' }); }}><ChevronLeft size={15} />이전</button><span aria-live="polite" className={ownedClassName(undefined,true)}>{currentPage} / {pages}</span><button type="button" className={ownedClassName("button small secondary",true)} disabled={currentPage === pages} onClick={() => { setPage(currentPage + 1); list.current?.scrollIntoView({ block: 'start' }); }}>다음<ChevronRight size={15} /></button></nav>}
    </section>
    {editing && <Modal title={editing === 'new' ? '학교 공통 일정 추가' : '학교 공통 일정 수정'} onClose={closeEditor}><CommonCalendarEditor row={editing === 'new' ? null : editing} schools={schools} initialSchool={school === 'unlinked' ? '' : school} busy={busy} error={operationError} onClose={closeEditor} onSave={body => mutate(body, '학교 공통 일정을 저장했습니다.', () => { if (editing === 'new') { changeTab('common'); setSchool((body.data as { schoolReferenceId: string }).schoolReferenceId); setStatus('all'); setTerm(''); setPage(1); } setEditing(null); })} /></Modal>}
    {personal && <Modal title="개인 면접 일정" onClose={closePersonal}><PersonalCalendarEditor registration={personal} busy={busy} error={operationError} onClose={closePersonal} onSave={body => mutate(body, '개인 면접 일정을 저장했습니다.', () => setPersonal(null))} /></Modal>}
    {pending && <Modal title={pending.kind === 'restore' ? '일정을 복원할까요?' : '면접 일정을 삭제할까요?'} onClose={() => { if (!busy) { setPending(null); setOperationError(''); } }}><div className={ownedClassName("admin-calendar-confirm",true)}>{pending.kind === 'personal_delete' ? <><p className={ownedClassName(undefined,true)}>{pending.registration.student.name} · {pending.registration.university}</p><p className={ownedClassName("muted",true)}>이 계정의 개인 일정만 삭제됩니다. 지원 학교 등록과 학교 공통 일정은 유지됩니다.</p></> : <><p className={ownedClassName(undefined,true)}>{pending.row.university} · {pending.row.trackLabel}</p><p className={ownedClassName("muted",true)}>{pending.kind === 'restore' ? '해당 지원 계정의 캘린더에 다시 표시됩니다.' : '해당 지원 계정의 캘린더에서 학교 공통 일정이 사라집니다. 별도로 저장한 개인 면접 시간은 유지되며, 삭제 내역에서 복원할 수 있습니다.'}</p></>}{operationError && <Alert>{operationError}</Alert>}<div className={ownedClassName("form-actions",true)}><button type="button" className={ownedClassName("button secondary",true)} disabled={busy} onClick={() => { setPending(null); setOperationError(''); }}>취소</button><button type="button" className={ownedClassName(`button ${pending.kind === 'restore' ? 'primary' : 'danger'}`,true)} disabled={busy} onClick={() => void confirmAction()}>{busy ? '처리 중' : pending.kind === 'restore' ? '복원' : '삭제'}{pending.kind === 'restore' ? <RotateCcw size={15} /> : <Trash2 size={15} />}</button></div></div></Modal>}
  </div>;
}

function CommonCalendarEditor({ row, schools, initialSchool, busy, error, onSave, onClose }: { row: CalendarRow | null; schools: SchoolOption[]; initialSchool: string; busy: boolean; error: string; onSave: (body: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [school, setSchool] = useState(row?.schoolReferenceId || initialSchool), [track, setTrack] = useState(row?.trackLabel || ''), [campus, setCampus] = useState(row?.campus || ''), [departments, setDepartments] = useState(row?.departments.join('\n') || '');
  const [status, setStatus] = useState<CalendarStatus>(row?.status || 'dated'), [format, setFormat] = useState<'in_person' | 'video_submission'>(row?.format || 'in_person'), [dates, setDates] = useState(row?.dates.length ? [...row.dates] : ['']);
  const [source, setSource] = useState(safeUrl(row?.sourceUrl)), [note, setNote] = useState(visibleCalendarSourceText(row?.note)), [validation, setValidation] = useState('');
  const [sourceEdited, setSourceEdited] = useState(false), [noteEdited, setNoteEdited] = useState(false);
  const selectedSchool = schools.find(option => option.id === school), [schoolDepartments, setSchoolDepartments] = useState<SchoolOption['departments']>(selectedSchool?.departments || []);
  useEffect(() => {
    const selected = schools.find(option => option.id === school);
    setSchoolDepartments(selected?.departments || []);
    if (!school || selected?.departments?.length) return;
    const controller = new AbortController();
    api(`/api/schools/catalog?schoolId=${encodeURIComponent(school)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setSchoolDepartments(result.school?.departments || []); }).catch(() => {});
    return () => controller.abort();
  }, [school, schools]);
  const names = [...new Set(schoolDepartments?.map(item => item.name) || [])].sort((a, b) => a.localeCompare(b, 'ko'));
  async function submit(event: FormEvent) {
    event.preventDefault(); setValidation('');
    const uniqueDates = [...new Set(dates.filter(Boolean))].sort();
    if (!school || !track.trim()) { setValidation('학교와 적용할 전형을 입력해 주세요.'); return; }
    if (status === 'dated' && (!uniqueDates.length || dates.some(value => !value))) { setValidation('면접 날짜를 입력하거나 빈 날짜 항목을 삭제해 주세요.'); return; }
    if (uniqueDates.length > 100) { setValidation('면접 날짜는 100개 이내로 입력해 주세요.'); return; }
    if (isReferenceCalendarUrl(source)) { setValidation('학교 입학처의 공식 URL을 입력해 주세요.'); return; }
    await onSave({ action: row ? 'update' : 'create', ...(row ? { id: row.id } : {}), expectedRevision: row?.revision || 0, data: { schoolReferenceId: school, admissionYear: 2027, trackLabel: track.trim(), departments: [...new Set(departments.split('\n').map(value => value.trim()).filter(Boolean))], campus: campus.trim() || null, status, dates: status === 'dated' ? uniqueDates : [], format: status === 'dated' ? format : 'in_person', ...(!row || sourceEdited ? { sourceUrl: source.trim() } : {}), ...(!row || noteEdited ? { note: note.trim() } : {}) } });
  }
  return <form className={ownedClassName("admin-calendar-editor",true)} onSubmit={submit}>
    <p className={ownedClassName("admin-calendar-editor-intro",true)}>해당 학교·전형·학과를 지원한 계정에 함께 반영됩니다.</p>
    <fieldset disabled={busy} className={ownedClassName(undefined,true)}><section className={ownedClassName("admin-calendar-form-section",true)}><h3 className={ownedClassName(undefined,true)}>적용 범위</h3><div className={ownedClassName("admin-calendar-form-grid",true)}><Field label="학교"><select required disabled={!!row} value={school} onChange={event => { setSchool(event.target.value); setCampus(''); setDepartments(''); }} className={ownedClassName(undefined,true)}><option value="" className={ownedClassName(undefined,true)}>학교 선택</option>{schools.map(option => <option key={option.id} value={option.id} className={ownedClassName(undefined,true)}>{option.university}</option>)}</select></Field><Field label="학년도"><input value="2027학년도" readOnly className={ownedClassName(undefined,true)} /></Field></div><div className={ownedClassName("admin-calendar-form-grid",true)}><Field label="전형"><input required value={track} maxLength={300} placeholder="학생부종합전형Ⅰ(면접형)" onChange={event => setTrack(event.target.value)} className={ownedClassName(undefined,true)} /></Field><Field label="캠퍼스" hint="빈칸은 해당 학교의 전체 캠퍼스"><input value={campus} maxLength={150} placeholder="서울캠퍼스" onChange={event => setCampus(event.target.value)} className={ownedClassName(undefined,true)} /></Field></div><Field label="대상 학과·모집단위" hint="한 줄에 하나 · 빈칸은 해당 전형 전체 모집단위"><textarea rows={3} value={departments} maxLength={60000} onChange={event => setDepartments(event.target.value)} placeholder="환경공학부" className={ownedClassName(undefined,true)} /></Field>{names.length > 0 && <label className={ownedClassName("admin-calendar-department-picker",true)}><span className={ownedClassName(undefined,true)}>학교 학과에서 추가</span><select aria-label="대상 학과 추가" value="" onChange={event => { const selectedDepartment = event.currentTarget.value; if (selectedDepartment) setDepartments(previous => [...new Set([...previous.split('\n').filter(Boolean), selectedDepartment])].join('\n')); }} className={ownedClassName(undefined,true)}><option value="" className={ownedClassName(undefined,true)}>학과 선택</option>{names.map(name => <option value={name} key={name} className={ownedClassName(undefined,true)}>{name}</option>)}</select><small className={ownedClassName(undefined,true)}>2026 교육부 공시 기준 · 모집단위 명칭은 직접 입력할 수 있습니다.</small></label>}</section>
    <section className={ownedClassName("admin-calendar-form-section",true)}><h3 className={ownedClassName(undefined,true)}>면접 일정</h3><div className={ownedClassName("admin-calendar-form-grid",true)}><Field label="일정 상태"><select value={status} onChange={event => { const next = event.target.value as CalendarStatus; setStatus(next); if (next !== 'dated') setDates(['']); }} className={ownedClassName(undefined,true)}>{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key} className={ownedClassName(undefined,true)}>{label}</option>)}</select></Field>{status === 'dated' && <Field label="일정 유형"><select value={format} onChange={event => setFormat(event.target.value as typeof format)} className={ownedClassName(undefined,true)}><option value="in_person" className={ownedClassName(undefined,true)}>면접일</option><option value="video_submission" className={ownedClassName(undefined,true)}>동영상 면접 제출기간</option></select></Field>}</div>{status === 'dated' && <div className={ownedClassName("admin-calendar-date-editor",true)}><span className={ownedClassName(undefined,true)}>{format === 'video_submission' ? '제출 가능한 날짜' : '면접 날짜'} · 2026년</span><small className={ownedClassName(undefined,true)}>분리된 날짜는 항목을 추가해 각각 입력합니다.</small><div className={ownedClassName(undefined,true)}>{dates.map((value, index) => <div className={ownedClassName("admin-calendar-date-input",true)} key={index}><input aria-label={`면접 날짜 ${index + 1}`} type="date" required min="2026-01-01" max="2026-12-31" value={value} onInput={event => { const nextDate = event.currentTarget.value; setDates(previous => previous.map((item, current) => current === index ? nextDate : item)); }} onChange={event => { const nextDate = event.currentTarget.value; setDates(previous => previous.map((item, current) => current === index ? nextDate : item)); }} className={ownedClassName(undefined,true)} /><button type="button" className={ownedClassName("icon-button",true)} disabled={dates.length === 1} aria-label={`면접 날짜 ${index + 1} 삭제`} onClick={() => setDates(previous => previous.filter((_, current) => current !== index))}><Trash2 size={16} /></button></div>)}</div><button type="button" className={ownedClassName("text-link",true)} onClick={() => setDates(previous => [...previous, ''])}><Plus size={14} />날짜 추가</button></div>}{visibleCalendarSourceText(row?.rawDate) && <details className={ownedClassName("admin-calendar-original",true)}><summary className={ownedClassName(undefined,true)}>기존 일정 원문</summary><p className={ownedClassName(undefined,true)}>{visibleCalendarSourceText(row?.rawDate)}</p></details>}</section>
    <section className={ownedClassName("admin-calendar-form-section",true)}><h3 className={ownedClassName(undefined,true)}>출처·안내</h3><Field label="출처 URL"><input type="url" value={source} maxLength={2000} placeholder="https://입학처…" onChange={event => { setSourceEdited(true); setSource(event.target.value); }} className={ownedClassName(undefined,true)} /></Field><Field label="학생에게 보이는 안내"><textarea rows={3} value={note} maxLength={4000} placeholder="개별 면접 시각은 입학처에서 확인해 주세요." onChange={event => { setNoteEdited(true); setNote(event.target.value); }} className={ownedClassName(undefined,true)} /></Field></section></fieldset>
    {(validation || error) && <Alert>{validation || error}</Alert>}<div className={ownedClassName("form-actions",true)}><button type="button" className={ownedClassName("button secondary",true)} disabled={busy} onClick={onClose}>취소</button><button className={ownedClassName("button primary",true)} disabled={busy}>{busy ? '저장 중' : '학교 일정 저장'}<Check size={16} /></button></div>
  </form>;
}

function PersonalCalendarEditor({ registration, busy, error, onSave, onClose }: { registration: Registration; busy: boolean; error: string; onSave: (body: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const original = registration.personalSchedule || {}, personalValue = original.personal_at || original.personal_date;
  const [form, setForm] = useState({ period_start: koreanDay(original.period_start), period_end: koreanDay(original.period_end), personal_date: koreanDay(personalValue), personal_time: koreanTime(personalValue), location: original.location || '', required_materials: original.required_materials?.join('\n') || '', source_url: safeUrl(original.source_url), checked_at: koreanDay(original.checked_at), status: original.status || 'needs_review', review_note: visibleCalendarSourceText(original.review_note) });
  const [validation, setValidation] = useState('');
  const [sourceEdited, setSourceEdited] = useState(false), [noteEdited, setNoteEdited] = useState(false);
  const requiresSource = form.status === 'reviewed' && (sourceEdited || original.status !== 'reviewed');
  const update = (key: keyof typeof form, value: string) => { if (key === 'source_url') setSourceEdited(true); if (key === 'review_note') setNoteEdited(true); setForm(previous => ({ ...previous, [key]: value })); };
  async function submit(event: FormEvent) {
    event.preventDefault(); setValidation('');
    if (form.period_start && form.period_end && form.period_start > form.period_end) { setValidation('학교 면접 기간의 시작·종료일을 확인해 주세요.'); return; }
    if (form.personal_time && !form.personal_date) { setValidation('면접 시간을 입력하려면 날짜도 입력해 주세요.'); return; }
    if (isReferenceCalendarUrl(form.source_url)) { setValidation('학교 입학처의 공식 URL을 입력해 주세요.'); return; }
    if (form.status === 'reviewed' && ((requiresSource && !safeUrl(form.source_url)) || !form.checked_at)) { setValidation('검수 완료 전 출처와 확인일을 입력해 주세요.'); return; }
    const { personal_time, source_url, review_note, ...fields } = form;
    await onSave({ action: 'personal_update', targetId: registration.targetId, expectedRevision: registration.personalRevision, schedule: { ...fields, ...(sourceEdited ? { source_url: source_url.trim() } : {}), ...(noteEdited ? { review_note: review_note.trim() } : {}), period_start: form.period_start || null, period_end: form.period_end || null, personal_date: form.personal_date || null, personal_at: form.personal_date && personal_time ? `${form.personal_date}T${personal_time}:00+09:00` : null, checked_at: form.checked_at || null, required_materials: form.required_materials.split('\n').map(value => value.trim()).filter(Boolean) } });
  }
  return <form className={ownedClassName("admin-calendar-editor",true)} onSubmit={submit}>
    <div className={ownedClassName("admin-calendar-personal-intro",true)}><p className={ownedClassName(undefined,true)}>{registration.student.name}<span className={ownedClassName(undefined,true)}>{registration.student.email}</span></p><p className={ownedClassName(undefined,true)}>{registration.university} · {registration.department}<span className={ownedClassName(undefined,true)}>{registration.track || '전형 미등록'}{registration.campus ? ` · ${registration.campus}` : ''}</span></p><small className={ownedClassName(undefined,true)}>이 지원처의 개인 일정만 변경됩니다.</small></div>
    <fieldset disabled={busy} className={ownedClassName(undefined,true)}><section className={ownedClassName("admin-calendar-form-section",true)}><h3 className={ownedClassName(undefined,true)}>개별 면접 시간</h3><div className={ownedClassName("admin-calendar-form-grid",true)}><Field label="면접 날짜"><input type="date" value={form.personal_date} onInput={event => update('personal_date', event.currentTarget.value)} onChange={event => update('personal_date', event.target.value)} className={ownedClassName(undefined,true)} /></Field><Field label="면접 시간 · 한국 시간" hint="시간을 모르면 빈칸으로 유지"><input type="time" value={form.personal_time} onInput={event => update('personal_time', event.currentTarget.value)} onChange={event => update('personal_time', event.target.value)} className={ownedClassName(undefined,true)} /></Field></div><Field label="장소"><input value={form.location} maxLength={500} onChange={event => update('location', event.target.value)} className={ownedClassName(undefined,true)} /></Field><Field label="준비할 자료" hint="자료별로 한 줄씩 입력"><textarea rows={3} value={form.required_materials} maxLength={4000} onChange={event => update('required_materials', event.target.value)} className={ownedClassName(undefined,true)} /></Field><details className={ownedClassName("admin-calendar-original",true)}><summary className={ownedClassName(undefined,true)}>계정에 저장한 면접 기간</summary><div className={ownedClassName("admin-calendar-form-grid",true)}><Field label="시작일"><input type="date" value={form.period_start} onInput={event => update('period_start', event.currentTarget.value)} onChange={event => update('period_start', event.target.value)} className={ownedClassName(undefined,true)} /></Field><Field label="종료일"><input type="date" value={form.period_end} onInput={event => update('period_end', event.currentTarget.value)} onChange={event => update('period_end', event.target.value)} className={ownedClassName(undefined,true)} /></Field></div></details></section>
    <section className={ownedClassName("admin-calendar-form-section",true)}><h3 className={ownedClassName(undefined,true)}>확인 정보</h3><Field label="출처 URL"><input type="url" value={form.source_url} maxLength={2000} required={requiresSource} onChange={event => update('source_url', event.target.value)} className={ownedClassName(undefined,true)} /></Field><div className={ownedClassName("admin-calendar-form-grid",true)}><Field label="확인일"><input type="date" value={form.checked_at} onInput={event => update('checked_at', event.currentTarget.value)} required={form.status === 'reviewed'} onChange={event => update('checked_at', event.target.value)} className={ownedClassName(undefined,true)} /></Field><Field label="검수 상태"><select value={form.status} onChange={event => update('status', event.target.value)} className={ownedClassName(undefined,true)}>{Object.entries(reviewNames).map(([key, label]) => <option key={key} value={key} className={ownedClassName(undefined,true)}>{label}</option>)}</select></Field></div><Field label="검수 메모"><textarea rows={3} value={form.review_note} maxLength={4000} onChange={event => update('review_note', event.target.value)} className={ownedClassName(undefined,true)} /></Field></section></fieldset>
    {(validation || error) && <Alert>{validation || error}</Alert>}<div className={ownedClassName("form-actions",true)}><button type="button" className={ownedClassName("button secondary",true)} disabled={busy} onClick={onClose}>취소</button><button className={ownedClassName("button primary",true)} disabled={busy}>{busy ? '저장 중' : '개인 일정 저장'}<Check size={16} /></button></div>
  </form>;
}
