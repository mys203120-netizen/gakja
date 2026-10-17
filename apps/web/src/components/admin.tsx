'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUpRight, Users, Upload, Clock3, Check, FileCode2, Plus, Search, ChevronRight, RotateCcw, ShieldCheck, Send, BookOpen, CalendarDays, Activity, X, UserRound, Bell, History, CircleAlert } from 'lucide-react';
import { useApp } from './app-shell';
import { AdminAssignments, AdminSchools, AdminSchedules } from './admin-learning';
import { AdminAdmissionCalendar } from './admin-calendar';
import { action, api, post, PageTitle, Breadcrumb, Badge, Empty, Alert, Modal, LinkedRow, dateLabel, targetName, targetMajor, type Item } from './shared';
import './admin-guidebook.css';
import overviewStyles from './admin-overview.module.css';
import { materialQuestionPracticeItems } from '@/lib/material-learning-flow';

const labels: Record<string, string> = { staged: '발행 대기', published: '발행 완료', rejected: '반려', pending: '확인 대기', responded: '회신 도착', confirmed: '사실 확인', different: '내용 다름', unknown: '기억 안 남', cannot_confirm: '확인 어려움', reviewed: '검토 완료', needs_revision: '재제작 요청', draft: '작성 중', completed: '완료', failed: '실패', student: '학생', staff: '담당자', admin: '관리자' };
const checks: Record<string, string> = { schema: '규격', toc: '목차', references: '참조 연결', hash: '데이터 무결성', hash_pair: '두 책 일치', ownership: '학생 연결', production_link: '제작 건 연결', final_approval: '최종 승인', activity_evaluation: '활동별 평가', learning_links: '학습 연결' };
const auditLabels: Record<string, string> = { 'content.import.staged': '콘텐츠 등록', 'content.preview.confirmed': '교재 미리보기 확인', 'content.publish': '콘텐츠 발행', 'content.rollback': '이전 버전 복귀', 'review.completed': '검토 완료', 'confirmation.response': '학생 회신', 'account.create_student': '계정 생성', 'account.invite': '계정 초대', 'account.active': '계정 상태 변경', 'assignment.update': '담당자 배정', 'support_target.update': '지원 정보 변경', 'production_link.update': '제작 건 연결', 'briefing.save': '공용 자료 저장', 'notification.send': '알림 발송' };
const statusTone = (state?: string) => ['published', 'reviewed', 'confirmed', 'completed'].includes(state || '') ? 'green' : ['rejected', 'different', 'failed', 'needs_revision'].includes(state || '') ? 'red' : ['staged', 'pending', 'responded'].includes(state || '') ? 'amber' : 'neutral';
const status = (state?: string) => <Badge tone={statusTone(state)}>{labels[state || ''] || state || '미지정'}</Badge>;
const rows = (value: unknown): Item[] => Array.isArray(value) ? value : [];
const dateTime = (value?: string) => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '날짜 미등록';
const versionBadge = (version: Item, activeVersion?: number) => version.version === activeVersion ? <Badge tone="green">현재 발행</Badge> : version.status === 'published' ? <Badge>이전 발행</Badge> : status(version.status);
const productionName = (links: Item[], id?: string) => links.find(p => p.id === id)?.data?.name || links.find(p => p.id === id)?.data?.title || '제작 자료';

function useOperation() {
  const { refresh, toast } = useApp();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run(fn: () => Promise<unknown>, message: string, done?: () => void) {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); await refresh(); toast(message); done?.(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return { busy, error, run, setError };
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function ErrorMessage({ error }: { error: string }) { return error ? <Alert>{error}</Alert> : null; }
function ImportSteps({ current }: { current: number }) { return <ol className="guidebook-import-steps" aria-label="교재 발행 단계">{['학생·파일 선택', '등록 검사', '미리보기 확인', '발행'].map((label, index) => <li key={label} className={index < current ? 'done' : index === current ? 'current' : ''} aria-current={index === current ? 'step' : undefined}><span>{index < current ? <Check size={14} /> : index + 1}</span>{label}</li>)}</ol>; }
function AdminCrumb({ section, detail }: { section: string; detail?: string }) { const path: Record<string, string> = { '학생 관리': 'students', '콘텐츠 등록': 'imports', '콘텐츠 이력': 'content', '검수·확인': 'reviews', '공용 자료': 'knowledge', '운영 설정': 'settings' }; return <Breadcrumb items={[{ label: '운영 현황', href: '/admin' }, { label: section, href: detail ? `/admin/${path[section]}` : undefined }, ...(detail ? [{ label: detail }] : [])]} />; }
function useAdminData() { const { data } = useApp(); return data.admin || {}; }

export function AdminPages({ slug = [] }: { slug?: string[] }) {
  const { data } = useApp();
  if (slug[0] === 'assignments') return <AdminAssignments data={data}/>;
  if (slug[0] === 'schools') return <AdminSchools data={data}/>;
  if (slug[0] === 'schedules') return data.user.role === 'admin' ? <AdminAdmissionCalendar /> : <AdminSchedules data={data}/>;
  if (!slug.length) return <Overview />;
  if (slug[0] === 'students') return slug[1] ? <StudentDetail key={slug[1]} id={slug[1]} /> : <Students />;
  if (slug[0] === 'imports') return slug[1] === 'new' ? <ImportForm initialStudent={slug[2]} /> : slug[1] ? <VersionDetail key={slug[1]} id={slug[1]} /> : <Imports />;
  if (slug[0] === 'content') return slug[1] ? <VersionDetail key={slug[1]} id={slug[1]} history /> : <ContentHistory />;
  if (slug[0] === 'reviews') return slug[1] ? <ReviewDetail key={slug[1]} id={slug[1]} /> : <Reviews />;
  if (slug[0] === 'knowledge') return <Knowledge key={slug[1]} id={slug[1]} />;
  if (slug[0] === 'settings') return <Settings />;
  return <Empty title="이 화면을 찾을 수 없습니다" href="/admin" label="운영 현황으로" />;
}

function Overview() {
  const admin = useAdminData(), students = rows(admin.students), imports = rows(admin.imports), confirmations = rows(admin.confirmations);
  const staged = imports.filter(v => v.status === 'staged'), pending = confirmations.filter(c => !['reviewed', 'rejected'].includes(c.state)), failed = imports.filter(v => v.status === 'rejected');
  return <>
    <PageTitle title="운영 현황" aside={<Link className="button primary" href="/admin/imports/new"><Upload size={17} />콘텐츠 등록</Link>} />
    <div className={overviewStyles.overview}>
      <div className={overviewStyles.queues} aria-label="처리할 일">
        {pending.length ? <section className={overviewStyles.queue} aria-labelledby="overview-confirmations">
          <div className={overviewStyles.heading}><h2 id="overview-confirmations">확인 요청 <Badge tone="amber">{pending.length}건</Badge></h2><Link className="text-link" href="/admin/reviews">전체 보기<ChevronRight size={15} /></Link></div>
          {pending.slice(0, 5).map(c => <LinkedRow key={c.id} href={`/admin/reviews/${c.id}`} title={c.question} subtitle={`${c.student_name} · ${dateLabel(c.created_at)}`} end={status(c.state)} />)}
        </section> : <Link className={overviewStyles.emptyQueue} href="/admin/reviews"><Check size={17} /><span>모든 요청을 확인했습니다</span><ChevronRight size={15} /></Link>}
        {staged.length ? <section className={overviewStyles.queue} aria-labelledby="overview-staged">
          <div className={overviewStyles.heading}><h2 id="overview-staged">발행 대기 <Badge>{staged.length}건</Badge></h2><Link className="text-link" href="/admin/imports">전체 보기<ChevronRight size={15} /></Link></div>
          {staged.slice(0, 5).map(v => <LinkedRow key={v.id} href={`/admin/imports/${v.id}`} title={v.student_name} subtitle={dateTime(v.created_at)} end={status(v.status)}><span className="round-icon"><FileCode2 size={21} /></span></LinkedRow>)}
        </section> : <Link className={overviewStyles.emptyQueue} href="/admin/imports"><Check size={17} /><span>발행 대기 자료가 없습니다</span><ChevronRight size={15} /></Link>}
      </div>
      <section className={overviewStyles.summary} aria-label="운영 요약">
        {[{ label: '전체 학생', value: students.length, unit: '명', icon: Users, href: '/admin/students' }, { label: '발행 대기', value: staged.length, unit: '건', icon: Upload, href: '/admin/imports' }, { label: '확인 요청', value: pending.length, unit: '건', icon: Clock3, href: '/admin/reviews' }, { label: '반려 자료', value: failed.length, unit: '건', icon: CircleAlert, href: '/admin/content' }].map(s => <Link className={overviewStyles.stat} href={s.href} key={s.label}><span><s.icon size={17} />{s.label}</span><span className={overviewStyles.value}>{s.value}<small>{s.unit}</small><ArrowUpRight size={15} /></span></Link>)}
      </section>
      <section className={overviewStyles.recent}><div className={overviewStyles.heading}><h2>최근 작업</h2><History size={19} /></div><AuditList logs={rows(admin.audit).slice(0, 8)} students={students} /></section>
    </div>
  </>;
}

function AccountForm({ role = 'student', onClose }: { role?: string; onClose: () => void }) {
  const { busy, error, run } = useOperation();
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  async function submit(e: FormEvent) { e.preventDefault(); await run(() => action('create_student', { name, email, password, role }), role === 'staff' ? '담당자 계정을 만들었습니다.' : '학생 계정을 만들었습니다.', onClose); }
  return <form className="admin-form" onSubmit={submit}><Field label="이름"><input required maxLength={80} value={name} onChange={e => setName(e.target.value)} autoFocus data-autofocus /></Field><Field label="이메일"><input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" /></Field><Field label="초기 비밀번호" hint="10자 이상"><input type="password" required minLength={10} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></Field><ErrorMessage error={error} /><button className="button primary full" disabled={busy}>{busy ? '생성 중' : '계정 생성'}</button></form>;
}

function Students() {
  const { data } = useApp(), admin = useAdminData();
  const [term, setTerm] = useState(''), [filter, setFilter] = useState('all'), [create, setCreate] = useState(false);
  const students = rows(admin.students).filter(s => `${s.name} ${s.email}`.toLowerCase().includes(term.toLowerCase()) && (filter === 'all' || (filter === 'active' ? s.active : !s.active)));
  return <><AdminCrumb section="학생 관리" /><PageTitle title="학생 관리" aside={data.user.role === 'admin' && <button className="button primary" onClick={() => setCreate(true)}><Plus size={17} />학생 생성</button>} /><div className="filter-bar"><div className="search-field"><Search size={18} /><input aria-label="학생 검색" placeholder="이름·이메일 검색" value={term} onChange={e => setTerm(e.target.value)} /></div><select aria-label="계정 상태" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">전체 계정</option><option value="active">활성 계정</option><option value="inactive">비활성 계정</option></select><Badge>{students.length}명</Badge></div><div className="panel admin-table"><div className="admin-table-head"><span>학생</span><span>지원처</span><span>담당자</span><span>자료</span><span>계정</span></div>{students.length ? students.map(s => <Link className="admin-table-row" key={s.id} href={`/admin/students/${s.id}`}><div className="student-identity"><span className="avatar">{s.name?.slice(0, 1)}</span><div><strong>{s.name}</strong><small>{s.email}</small></div></div><span>{rows(admin.targets).filter(t => t.student_id === s.id).map(targetName).join(', ') || '미등록'}</span><span>{rows(admin.assignments).filter(a => a.student_id === s.id).map(a => a.staff_name).join(', ') || '미배정'}</span><span>{s.active_version ? <Badge tone="green">발행 중</Badge> : '미발행'}</span><span><i className={`status-dot ${s.active ? 'active' : ''}`} />{s.active ? '활성' : '비활성'}</span></Link>) : <Empty title="검색 결과가 없습니다" />}</div>{create && <Modal title="학생 계정 생성" onClose={() => setCreate(false)}><AccountForm onClose={() => setCreate(false)} /></Modal>}</>;
}

function StudentDetail({ id }: { id: string }) {
  const admin = useAdminData(), { data } = useApp(), s = rows(admin.students).find(s => s.id === id), op = useOperation();
  const [editTarget, setEditTarget] = useState<Item | null>(null), [editProduction, setEditProduction] = useState<Item | null>(null), [activeConfirm, setActiveConfirm] = useState(false);
  if (!s) return <Empty title="학생을 찾을 수 없습니다" href="/admin/students" label="학생 목록" />;
  const targets = rows(admin.targets).filter(t => t.student_id === id), versions = rows(admin.imports).filter(v => v.student_id === id), links = rows(admin.productionLinks).filter(p => p.student_id === id), assignments = rows(admin.assignments).filter(a => a.student_id === id);
  return <>
    <AdminCrumb section="학생 관리" detail={s.name} />
    <PageTitle title={s.name} aside={<Link className="button primary" href={`/admin/imports/new/${id}`}><Upload size={17} />자료 등록</Link>}>{s.email}</PageTitle>
    <div className="admin-profile-strip panel">
      <div><span>자료</span><strong>{s.active_version ? '발행 중' : '미발행'}</strong></div>
      <div><span>담당자</span><strong>{assignments.map(a => a.staff_name).join(', ') || '미배정'}</strong></div>
      <div><span>계정</span><Badge tone={s.active ? 'green' : 'neutral'}>{s.active ? '활성' : '비활성'}</Badge></div>
    </div>
    <ErrorMessage error={op.error} />
    <div className="dashboard-middle-grid">
      <section className="panel"><div className="section-heading"><h2>지원 정보</h2><button className="button small ghost" onClick={() => setEditTarget({})}><Plus size={16} />지원처 추가</button></div>
        {targets.length ? targets.map(t => <button className="linked-row full" key={t.id} onClick={() => setEditTarget(t)}><div className="row-text"><strong>{targetName(t)}</strong><span>{[targetMajor(t), t.admission_type].filter(Boolean).join(' · ')}</span></div><span className="muted">{t.interview_date ? dateLabel(t.interview_date) : '날짜 미정'}</span><ChevronRight size={16} /></button>) : <Empty title="지원처가 없습니다" />}
      </section>
      <section className="panel"><div className="section-heading"><h2>제작 건</h2><button className="button small ghost" onClick={() => setEditProduction({})}><Plus size={16} />연결</button></div>
        {links.length ? links.map(p => <button className="linked-row full" key={p.id} onClick={() => setEditProduction(p)}><div className="row-text"><strong>{p.data?.name || p.data?.title || '제작 자료'}</strong><span>{dateTime(p.created_at)}</span></div><ChevronRight size={16} /></button>) : <Empty title="연결된 제작 건이 없습니다" />}
      </section>
    </div>
    <section className="panel"><div className="section-heading"><h2>자료 이력</h2><Link className="text-link" href="/admin/content">전체 이력<ChevronRight size={15} /></Link></div>
      {versions.length ? versions.map(v => <LinkedRow key={v.id} href={`/admin/content/${v.id}`} title={dateTime(v.created_at)} subtitle={productionName(links, v.production_job_ref)} end={versionBadge(v, s.active_version)} />) : <Empty title="등록된 자료가 없습니다" />}
    </section>
    <section className="panel"><div className="section-heading"><h2>작업 이력</h2></div><AuditList logs={rows(admin.audit).filter(a => a.student_id === id)} students={[s]} /></section>
    {data.user.role === 'admin' && <div className="admin-danger-row"><button className="button ghost" onClick={() => setActiveConfirm(true)}>{s.active ? '계정 비활성화' : '계정 활성화'}</button></div>}
    {editTarget && <Modal title={editTarget.id ? '지원 정보 수정' : '지원처 추가'} onClose={() => setEditTarget(null)}><TargetForm studentId={id} target={editTarget} onClose={() => setEditTarget(null)} /></Modal>}
    {editProduction && <Modal title="제작 건 연결" onClose={() => setEditProduction(null)}><ProductionForm studentId={id} value={editProduction} onClose={() => setEditProduction(null)} /></Modal>}
    {activeConfirm && <Modal title={s.active ? '계정을 비활성화할까요?' : '계정을 활성화할까요?'} onClose={() => setActiveConfirm(false)}><p>{s.name} · {s.email}</p>{s.active && <p className="muted">현재 로그인한 세션이 종료됩니다.</p>}<ErrorMessage error={op.error} /><button disabled={op.busy} className="button primary full" onClick={() => op.run(() => action('deactivate', { studentId: id, active: !s.active }), '계정 상태를 변경했습니다.', () => setActiveConfirm(false))}>{op.busy ? '처리 중' : s.active ? '비활성화' : '활성화'}</button></Modal>}
  </>;
}

function TargetForm({ studentId, target, onClose }: { studentId: string; target: Item; onClose: () => void }) {
  const op = useOperation(), [form, setForm] = useState({ id: target.id || `target-${crypto.randomUUID().slice(0, 8)}`, university: target.university || '', department: target.department || '', admission_type: target.admission_type || '', campus: target.campus || '', admission_year: target.admission_year || new Date().getFullYear() + 1, interview_date: target.interview_date?.slice(0, 10) || '' });
  const update = (key: string, value: string) => setForm({ ...form, [key]: value });
  async function submit(e: FormEvent) { e.preventDefault(); const { id, ...value } = form; await op.run(() => action('support_target', { studentId, id, data: { ...target, ...value, admission_year: Number(value.admission_year) } }), '지원 정보를 저장했습니다.', onClose); }
  return <form className="admin-form" onSubmit={submit}><details><summary>연결 식별값</summary><Field label="지원처 ID"><input required value={form.id} readOnly={!!target.id} onChange={e => update('id', e.target.value)} /></Field></details><div className="form-grid"><Field label="대학"><input required value={form.university} onChange={e => update('university', e.target.value)} /></Field><Field label="학과·모집단위"><input required value={form.department} onChange={e => update('department', e.target.value)} /></Field></div><Field label="전형"><input required value={form.admission_type} onChange={e => update('admission_type', e.target.value)} /></Field><div className="form-grid"><Field label="캠퍼스"><input value={form.campus} onChange={e => update('campus', e.target.value)} /></Field><Field label="모집 연도"><input type="number" min="2026" max="2100" required value={form.admission_year} onChange={e => update('admission_year', e.target.value)} /></Field></div><Field label="면접일"><input type="date" value={form.interview_date} onChange={e => update('interview_date', e.target.value)} /></Field><ErrorMessage error={op.error} /><button disabled={op.busy} className="button primary full">{op.busy ? '저장 중' : '저장'}</button></form>;
}

function ProductionForm({ studentId, value, onClose }: { studentId: string; value: Item; onClose: () => void }) {
  const op = useOperation(), [id, setId] = useState(value.id || ''), [name, setName] = useState(value.data?.name || ''), [reference, setReference] = useState(value.data?.reference || '');
  async function submit(e: FormEvent) { e.preventDefault(); await op.run(() => action('production_link', { studentId, id, data: { ...value.data, name, reference } }), '제작 건을 연결했습니다.', onClose); }
  return <form className="admin-form" onSubmit={submit}><Field label="제작 건 ID" hint="HTML의 production_job_ref와 같은 값을 입력합니다."><input required value={id} readOnly={!!value.id} onChange={e => setId(e.target.value)} /></Field><Field label="제작 건 이름"><input required value={name} onChange={e => setName(e.target.value)} /></Field><Field label="제작 참조"><input value={reference} onChange={e => setReference(e.target.value)} /></Field><ErrorMessage error={op.error} /><button disabled={op.busy} className="button primary full">{op.busy ? '연결 중' : '저장'}</button></form>;
}

function Imports() {
  const admin = useAdminData(), [filter, setFilter] = useState('all');
  const versions = rows(admin.imports).filter(v => filter === 'all' || v.status === filter);
  return <><AdminCrumb section="콘텐츠 등록" /><PageTitle title="콘텐츠 등록" aside={<Link className="button primary" href="/admin/imports/new"><Upload size={17} />새 자료 등록</Link>} /><div className="admin-tabs">{[['all', '전체'], ['staged', '발행 대기'], ['published', '발행 완료'], ['rejected', '반려']].map(([key, title]) => <button className={filter === key ? 'active' : ''} key={key} onClick={() => setFilter(key)}>{title}<span>{rows(admin.imports).filter(v => key === 'all' || v.status === key).length}</span></button>)}</div><section className="panel">{versions.length ? versions.map(v => <LinkedRow key={v.id} href={`/admin/imports/${v.id}`} title={v.student_name} subtitle={dateTime(v.created_at)} end={<div className="inline-actions">{status(v.status)}<ChevronRight size={16} /></div>}><span className="round-icon"><FileCode2 size={22} /></span></LinkedRow>) : <Empty title="등록된 자료가 없습니다" href="/admin/imports/new" label="자료 등록" />}</section></>;
}

function ImportForm({ initialStudent }: { initialStudent?: string }) {
  const admin = useAdminData(), router = useRouter(), op = useOperation();
  const [studentId, setStudent] = useState(initialStudent || ''), [production, setProduction] = useState(''), [guidebook, setGuidebook] = useState<File | null>(null);
  const student = rows(admin.students).find(s => s.id === studentId), links = rows(admin.productionLinks).filter(l => l.student_id === studentId);
  const productionId = production || (links.length === 1 ? links[0].id : '');
  function selectFile(file: File | null) { op.setError(''); if (file && (!/\.html?$/i.test(file.name) || file.size === 0 || file.size > 5 * 1024 * 1024)) { setGuidebook(null); op.setError('내용이 있는 HTML 파일을 5MB 이내로 선택해 주세요.'); return; } setGuidebook(file); }
  async function submit(e: FormEvent) { e.preventDefault(); if (!guidebook) { op.setError('최종 가이드북 HTML을 선택해 주세요.'); return; } const body = new FormData(); body.set('studentId', studentId); body.set('productionJobRef', productionId); body.append('files', guidebook); let imported: Item = {}; await op.run(async () => { imported = await api('/api/imports', { method: 'POST', body }); }, '등록 검사를 통과했습니다. 교재를 미리 확인해 주세요.', () => router.push(`/admin/imports/${imported.id}`)); }
  return <><AdminCrumb section="콘텐츠 등록" detail="새 자료 등록" /><PageTitle title="최종 가이드북 등록" /><ImportSteps current={op.busy ? 1 : 0} /><form onSubmit={submit} className="admin-form guidebook-import-form"><section className="panel"><div className="section-heading"><h2>연결할 학생</h2><Users size={20} /></div><div className="form-grid"><Field label="학생"><select required value={studentId} onChange={e => { setStudent(e.target.value); setProduction(''); setGuidebook(null); op.setError(''); }}><option value="">학생 선택</option>{rows(admin.students).filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name} · {s.email}</option>)}</select></Field><Field label="제작 건"><select required disabled={!studentId || !links.length} value={productionId} onChange={e => setProduction(e.target.value)}><option value="">제작 건 선택</option>{links.map(p => <option key={p.id} value={p.id}>{p.data?.name || p.data?.title || '제작 자료'}</option>)}</select></Field></div>{studentId && !links.length && <div className="inline-notice"><span>연결된 제작 건이 없습니다.</span><Link className="text-link" href={`/admin/students/${studentId}`}>제작 건 연결<ArrowUpRight size={15} /></Link></div>}{student && <div className="version-strip"><strong>{student.name}</strong><span>{rows(admin.targets).filter(t => t.student_id === studentId).map(t => `${targetName(t)} ${targetMajor(t)}`).join(' · ') || '지원처 미등록'}</span><Badge>{student.active_version ? '개정본 등록' : '최초 등록'}</Badge></div>}</section><section className="panel"><div className="section-heading"><h2>최종 가이드북 HTML</h2><span className="muted">파일 1개 · 5MB 이하</span></div><label className={`import-dropzone guidebook-dropzone ${guidebook ? 'selected' : ''}`}><input key={studentId} aria-label="최종 가이드북 HTML 파일" type="file" accept=".html,.htm,text/html" required onChange={e => selectFile(e.target.files?.[0] || null)} /><FileCode2 size={30} /><strong>{guidebook ? guidebook.name : '검수가 끝난 가이드북 선택'}</strong><span>{guidebook ? `${(guidebook.size / 1024).toFixed(1)} KB · 다른 파일로 변경` : 'HTML 파일 선택'}</span>{guidebook && <Check size={17} />}</label><p className="guidebook-upload-note">활동별 평가·질문·퀴즈 데이터와 최종 승인 정보가 포함된 HTML을 등록해 주세요.</p><p className="guidebook-upload-note">미리보기 확인 후 발행하면 학생에게 공개됩니다. 기존 답변과 학습 기록은 유지됩니다.</p></section><ErrorMessage error={op.error} /><div className="form-actions"><Link className="button ghost" href="/admin/imports">취소</Link><button className="button primary" disabled={op.busy || !studentId || !productionId || !guidebook}>{op.busy ? '검사 중' : '검사하고 미리보기'}<ChevronRight size={16} /></button></div></form></>;
}

function ContentHistory() {
  const admin = useAdminData(), [term, setTerm] = useState('');
  const students = rows(admin.students).filter(s => s.package_id && `${s.name} ${s.email}`.toLowerCase().includes(term.toLowerCase()));
  return <><AdminCrumb section="콘텐츠 이력" /><PageTitle title="콘텐츠 이력" />
    <div className="filter-bar"><div className="search-field"><Search size={18} /><input aria-label="학생 검색" value={term} placeholder="학생 이름·이메일 검색" onChange={e => setTerm(e.target.value)} /></div><span className="muted">{students.length}명</span></div>
    <div className="admin-package-grid">{students.length ? students.map(s => {
      const versions = rows(admin.imports).filter(v => v.student_id === s.id);
      return <section className="panel" key={s.id}><div className="section-heading"><h2>{s.name}</h2><Link className="text-link" href={`/admin/students/${s.id}`}>학생 정보<ChevronRight size={15} /></Link></div>
        {versions.map(v => <LinkedRow key={v.id} href={`/admin/content/${v.id}`} title={dateTime(v.created_at)} subtitle={productionName(rows(admin.productionLinks), v.production_job_ref)} end={versionBadge(v, s.active_version)} />)}
      </section>;
    }) : <section className="panel"><Empty title="등록된 자료가 없습니다" href="/admin/imports/new" label="자료 등록" /></section>}</div>
  </>;
}

function VersionDetail({ id, history = false }: { id: string; history?: boolean }) {
  const admin = useAdminData(), op = useOperation(), [tab, setTab] = useState('activities'), [confirm, setConfirm] = useState<'publish' | 'rollback' | 'reject' | null>(null), [note, setNote] = useState('');
  const version = rows(admin.imports).find(v => v.id === id), [selected, setSelected] = useState<Item | null>(null);
  const [preview, setPreview] = useState<Item | null>(null), [previewLoading, setPreviewLoading] = useState(false), [previewError, setPreviewError] = useState(''), [previewReady, setPreviewReady] = useState(false), [acknowledged, setAcknowledged] = useState(false);
  if (!version) return <Empty title="등록 자료를 찾을 수 없습니다" href={history ? '/admin/content' : '/admin/imports'} label="목록으로" />;
  const student = rows(admin.students).find(s => s.id === version.student_id), learning = version.data || {}, active = student?.active_version === version.version;
  const versions = rows(admin.imports).filter(v => v.package_id === version.package_id), otherVersions = versions.filter(v => v.id !== version.id);
  const previous = versions.filter(v => v.version < version.version).sort((a, b) => b.version - a.version)[0];
  const diff = version.review?.diff, currentTab = rows(learning[tab]), tabs = [['activities', '활동별 평가'], ['questions', '질문·학습 연결'], ['memory_items', '퀴즈'], ['support_targets', '지원 정보'], ['source_refs', '근거']];
  const previewConfirmation = version.review?.preview_confirmation, previewConfirmed = Boolean(previewConfirmation?.confirmed_at) && (!preview || previewConfirmation.digest === preview.digest);
  const approval = preview?.externalApproval || version.review?.external_approval;
  async function openBookPreview() {
    if (previewLoading) return;
    setPreviewLoading(true); setPreviewError(''); setPreviewReady(false); setAcknowledged(false);
    try { const result = await api(`/api/imports/${encodeURIComponent(id)}/preview`); setPreview(result); }
    catch (error) { setPreviewError((error as Error).message); }
    finally { setPreviewLoading(false); }
  }
  function selectPreviewItem(kind: string, item: Item) { setTab(kind); setSelected(item); }
  async function execute() {
    if (!confirm) return;
    const operation = confirm;
    await op.run(() => operation === 'reject' ? action('review', { studentId: version!.student_id, versionId: version!.id, note, reject: true }) : action(operation, { versionId: version!.id, note }), operation === 'publish' ? '자료를 발행했습니다.' : operation === 'rollback' ? '이전 자료로 복귀했습니다.' : '등록 자료를 반려했습니다.', () => { setConfirm(null); setNote(''); });
  }
  return <>
    <AdminCrumb section={history ? '콘텐츠 이력' : '콘텐츠 등록'} detail={version.student_name} />
    <PageTitle title={`${version.student_name}의 자료`} aside={versionBadge(version, student?.active_version)}>{dateTime(version.created_at)} 등록</PageTitle>
    {version.status === 'staged' && <ImportSteps current={previewConfirmed ? 3 : 2} />}
    <section className="panel"><div className="admin-meta-grid">
      <div><span>학생 정보</span><Link className="text-link" href={`/admin/students/${version.student_id}`}>{student?.email || '학생 정보 보기'}<ArrowUpRight size={14} /></Link></div>
      <div><span>지원처</span>{rows(learning.support_targets).length ? rows(learning.support_targets).map(t => <p key={t.id}>{targetName(t)}<br /><span className="muted">{targetMajor(t)}</span></p>) : <strong>미등록</strong>}</div>
      <div><span>제작 건</span><strong>{productionName(rows(admin.productionLinks), version.production_job_ref)}</strong></div>
      {version.published_at && <div><span>발행일</span><strong>{dateTime(version.published_at)}</strong></div>}
    </div><details><summary>등록 검사</summary><div className="check-list">{rows(version.review?.checks).length ? rows(version.review.checks).map((c: any) => <span key={String(c)}><Check size={15} />{checks[c] || '검사 완료'}</span>) : <span><Check size={15} />규격 검사 통과</span>}</div></details>{approval && <div className="guidebook-approval"><ShieldCheck size={17} /><span>외부 최종 승인 {approval.review_ref || approval.approval_ref || ''}{(approval.reviewed_at || approval.approved_at) ? ` · ${dateTime(approval.reviewed_at || approval.approved_at)}` : ''}</span></div>}</section>
    {previous && <section className="panel"><details><summary>이전 자료와 비교</summary>
      {tabs.slice(0, 3).map(([key, title]) => <div className="linked-row" key={key}><div className="row-text"><strong>{title}</strong></div><span>{previous && <><span className="muted">{diff?.[key]?.before ?? rows(previous.data?.[key]).length}</span><ChevronRight size={14} /></>}{rows(learning[key]).length}개</span></div>)}
    </details></section>}
    {rows(diff?.removed_question_ids).length > 0 && <Alert>삭제된 질문 {rows(diff.removed_question_ids).length}개 · 학생 답변은 이력에 보존됩니다.</Alert>}
    <section className="panel guidebook-book-preview"><div className="section-heading"><h2>교재 미리보기</h2>{!preview && <button className="button ghost small" disabled={previewLoading} onClick={openBookPreview}><BookOpen size={16} />{previewLoading ? '불러오는 중' : '교재 미리보기 열기'}</button>}</div>
      {preview ? <AdminBookPreview documents={rows(preview.documents)} learning={learning} onSelect={selectPreviewItem} onReady={() => setPreviewReady(true)} /> : <p className="guidebook-upload-note">등록한 교재의 목차와 본문, 연결된 활동·질문을 확인해 주세요.</p>}
      <ErrorMessage error={previewError} />
    </section>
    <section className="panel guidebook-learning-preview"><div className="section-heading"><h2>평가·학습 연결</h2><span className="muted">{version.status === 'staged' ? '발행 예정 자료' : '이 교재의 자료'}</span></div>
      <div className="admin-tabs">{tabs.map(([key, title]) => <button key={key} aria-pressed={tab === key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setSelected(null); }}>{title}<span>{rows(learning[key]).length}</span></button>)}</div>
      {currentTab.length ? <div className="admin-preview-list">{currentTab.map((item, i) => <button key={item.id || i} className="linked-row full guidebook-preview-row" onClick={() => setSelected(item)}><div className="row-text"><strong>{item.title || item.prompt || item.university || item.quote || item.location || `자료 ${i + 1}`}</strong><span>{item.activity_summary || item.question_intent || item.department || item.location || ''}</span>{tab === 'activities' && <div className="guidebook-row-meta">{rows(item.priority_assignments).map((assignment, index) => { const target = rows(learning.support_targets).find(t => t.id === assignment.support_target_id); return <span key={assignment.support_target_id || index}>{targetName(target)} <b>{assignment.priority}</b></span>; })}{rows(learning.student_context?.representative_activity_ids).includes(item.id) && <span>대표 활동</span>}<span>{factLabel(item.fact_confirmation)}</span></div>}{tab === 'questions' && <div className="guidebook-row-meta"><span>연결 활동 {rows(item.activity_ids).length}개</span><span>퀴즈 {materialQuestionPracticeItems(item, rows(learning.memory_items)).length}개</span><span>{['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(item.verification_status) ? '모의면접 질문' : '면접 연결 전 검수 필요'}</span></div>}{tab === 'memory_items' && <div className="guidebook-row-meta"><span>{rows(learning.questions).find(q => q.id === item.question_id)?.prompt || '연결 질문 확인'}</span></div>}</div><ChevronRight size={16} /></button>)}</div> : <Empty title="이 항목이 없습니다" />}
    </section>
    {version.status === 'staged' && <section className="panel guidebook-preview-confirm"><div className="section-heading"><h2>발행 전 확인</h2>{previewConfirmed && <Badge tone="green">확인 완료</Badge>}</div>{previewConfirmed ? <p className="guidebook-upload-note">{dateTime(previewConfirmation.confirmed_at)}에 이 교재의 미리보기를 확인했습니다.</p> : <><label className="checkbox-row"><input type="checkbox" checked={acknowledged} disabled={!previewReady || previewLoading || op.busy} onChange={e => setAcknowledged(e.target.checked)} /><span>이 학생의 교재·활동별 평가·학습 연결을 확인했습니다.</span></label><div className="form-actions"><button className="button ghost" disabled={op.busy || !preview?.digest || !previewReady || !rows(preview.documents).length || !acknowledged} onClick={() => op.run(() => action('preview_confirm', { versionId: id, digest: preview!.digest }), '미리보기를 확인했습니다. 이제 발행할 수 있습니다.')}><Check size={16} />{op.busy ? '확인 중' : '미리보기 확인 완료'}</button></div>{!preview && <p className="guidebook-upload-note">먼저 교재 미리보기를 열어 주세요.</p>}</>}<p className="guidebook-upload-note">발행 후 퀴즈와 모의면접에 연결됩니다. 이전 교재의 답변·학습 기록은 보존됩니다.</p></section>}
    {version.review?.note && <section className="panel"><div className="section-heading"><h2>검토 메모</h2></div><p className="preserve-lines">{version.review.note}</p></section>}
    {otherVersions.length > 0 && <section className="panel"><div className="section-heading"><h2>다른 등록 자료</h2></div>{otherVersions.map(v => <LinkedRow href={`/admin/content/${v.id}`} key={v.id} title={dateTime(v.created_at)} subtitle={productionName(rows(admin.productionLinks), v.production_job_ref)} end={versionBadge(v, student?.active_version)} />)}</section>}
    <ErrorMessage error={op.error} />
    <div className="form-actions">
      {version.status === 'staged' && <button className="button ghost" onClick={() => setConfirm('reject')}>반려</button>}
      {version.status !== 'rejected' && !active && <button className="button primary" disabled={op.busy || (version.status === 'staged' && !previewConfirmed)} onClick={() => setConfirm(version.status === 'published' ? 'rollback' : 'publish')}>{version.status === 'published' ? <RotateCcw size={17} /> : <Send size={17} />}{version.status === 'published' ? '이 자료로 복귀' : '발행'}</button>}
    </div>
    {selected && <Modal title={selected.title || selected.prompt || selected.university || '자료 상세'} onClose={() => setSelected(null)}><PreviewItem item={selected} kind={tab} learning={learning} /></Modal>}
    {confirm && <Modal title={confirm === 'publish' ? '이 자료를 발행할까요?' : confirm === 'rollback' ? '이 자료로 복귀할까요?' : '등록 자료를 반려할까요?'} onClose={() => setConfirm(null)}>
      <div className="publish-summary"><strong>{version.student_name}</strong><span>{dateTime(version.created_at)} 등록</span>{rows(learning.support_targets).map(t => <span key={t.id}>{targetName(t)} · {targetMajor(t)}</span>)}</div>
      <Field label={confirm === 'reject' ? '반려 사유' : '작업 메모'}><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} /></Field><ErrorMessage error={op.error} />
      {confirm === 'publish' && <p className="guidebook-upload-note">학생에게 교재를 공개하고 활동·질문을 퀴즈와 모의면접에 연결합니다. 기존 학습 기록은 유지됩니다.</p>}<button className="button primary full" disabled={op.busy || (confirm === 'publish' && !previewConfirmed) || (confirm === 'reject' && !note.trim())} onClick={execute}>{op.busy ? '처리 중' : confirm === 'publish' ? '발행' : confirm === 'rollback' ? '복귀' : '반려'}</button>
    </Modal>}
  </>;
}

function factLabel(value: unknown): string { const state = typeof value === 'string' ? value : (value as Item)?.status; return ({ verified: '근거 확인됨', approved: '승인됨', confirmed: '확인됨', confirmed_from_record: '학생부 확인', confirmed_by_student: '학생 확인', needs_confirmation: '사실 확인 필요', student_says_different: '학생 진술과 다름', cannot_confirm: '확인 어려움', synthetic_reviewed: '테스트 자료' } as Record<string, string>)[state] || '확인 상태 미지정'; }

function AdminBookPreview({ documents, learning, onSelect, onReady }: { documents: Item[]; learning: Item; onSelect: (kind: string, item: Item) => void; onReady: () => void }) {
  const [kind, setKind] = useState('guidebook'), [mode, setMode] = useState('original'), [sectionId, setSectionId] = useState('');
  const doc = documents.find(d => d.kind === kind) || documents[0], book = doc?.data || doc || {}, sections = rows(book.sections), flat = sections.flatMap(section => [section, ...rows(section.children)]);
  const section = flat.find(s => s.id === sectionId) || rows(sections[0]?.children)[0] || sections[0], blocks = rows(book.blocks).filter(block => block.section_id === section?.id);
  useEffect(() => { if (doc && !doc.html) onReady(); }, [doc?.id, doc?.html]);
  if (!doc) return <Empty title="교재 본문을 찾을 수 없습니다" />;
  function renderBlock(block: Item) {
    if (block.type === 'text') return <p className="guidebook-preview-copy">{block.text}</p>;
    if (block.type === 'answer_script_ref') { const answer = rows(learning.answer_scripts).find(item => item.id === block.answer_script_id); return answer ? <blockquote>{answer.text}</blockquote> : null; }
    if (block.type === 'support_target_ref') { const target = rows(learning.support_targets).find(item => item.id === block.support_target_id); return target ? <div className="guidebook-preview-target"><strong>{targetName(target)} · {targetMajor(target)}</strong><p>{target.admission_type} · {target.admission_year}학년도</p></div> : null; }
    const reference: Record<string, [string, string, string]> = { activity_ref: ['activities', 'activity_id', '활동별 평가'], question_ref: ['questions', 'question_id', '질문·학습 연결'], memory_item_ref: ['memory_items', 'memory_item_id', '퀴즈'], source_ref: ['source_refs', 'source_ref_id', '근거'] };
    const config = reference[block.type];
    if (!config) return null;
    const item = rows(learning[config[0]]).find(item => item.id === block[config[1]]);
    return item ? <button className="guidebook-block-reference" onClick={() => onSelect(config[0], item)}><span>{config[2]}</span><div><strong>{item.title || item.prompt || item.quote || item.location}</strong>{(item.activity_summary || item.question_intent || item.location) && <p>{item.activity_summary || item.question_intent || item.location}</p>}</div><ChevronRight size={16} /></button> : null;
  }
  return <div className="guidebook-preview-reader">
    <div className="guidebook-preview-controls">{documents.length > 1 && <label className="form-field"><span>교재</span><select value={doc.kind} onChange={e => { setKind(e.target.value); setSectionId(''); }}><option value="guidebook">가이드북</option><option value="handbook">암기 핸드북</option></select></label>}{doc.html && <div className="admin-tabs">{[['original', '최종 HTML'], ['structured', '웹에서 읽는 방식']].map(([value, label]) => <button key={value} aria-pressed={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{label}</button>)}</div>}</div>
    {doc.html && mode === 'original' ? <iframe key={doc.id} className="guidebook-original-preview" title={`${doc.kind === 'guidebook' ? '가이드북' : '암기 핸드북'} 최종 HTML 미리보기`} sandbox="" referrerPolicy="no-referrer" srcDoc={doc.html} onLoad={onReady} /> : <><label className="form-field guidebook-section-selector"><span>목차</span><select aria-label="교재 미리보기 목차" value={section?.id || ''} onChange={e => setSectionId(e.target.value)}>{sections.map(chapter => <optgroup key={chapter.id} label={chapter.title}><option value={chapter.id}>{chapter.title}</option>{rows(chapter.children).map(child => <option key={child.id} value={child.id}>{child.title}</option>)}</optgroup>)}</select></label><article className="guidebook-preview-article"><h3>{section?.title}</h3>{blocks.length ? blocks.map(block => <div key={block.id}>{renderBlock(block)}</div>) : rows(section?.children).length ? <div className="guidebook-preview-children">{rows(section?.children).map(child => <button key={child.id} className="text-link" onClick={() => setSectionId(child.id)}>{child.title}<ChevronRight size={16} /></button>)}</div> : <p className="muted">이 절의 본문이 없습니다.</p>}</article></>}
  </div>;
}

function SourceEvidence({ ids, learning }: { ids: unknown; learning: Item }) {
  return <div className="guidebook-evidence">{rows(ids).map((id: any) => {
    const source = rows(learning.source_refs).find(s => s.id === id);
    return source ? <div key={String(id)}>{source.quote && <p>{source.quote}</p>}<span>{[source.area, source.page ? `${source.page}쪽` : '', source.location].filter(Boolean).join(' · ') || '연결 근거'}{source.url && /^https?:\/\//i.test(source.url) && <> · <a href={source.url} target="_blank" rel="noreferrer">출처 보기<ArrowUpRight size={12} /></a></>}</span></div> : null;
  })}</div>;
}

function ActivityEvaluationPreview({ item, learning }: { item: Item; learning: Item }) {
  const representative = rows(learning.student_context?.representative_activity_ids).includes(item.id);
  return <section className="guidebook-activity-evaluation"><div className="section-heading"><h3>지원처별 활동 평가</h3><Badge>{factLabel(item.fact_confirmation)}</Badge></div>{representative && <p className="guidebook-evaluation-summary">교재의 대표 활동</p>}{rows(item.priority_assignments).map(assignment => { const target = rows(learning.support_targets).find(t => t.id === assignment.support_target_id); return <article key={assignment.support_target_id}><div className="section-heading"><div><h4>{targetName(target)} · {targetMajor(target)}</h4><p className="muted">{target?.admission_type}</p></div><Badge>우선도 {assignment.priority}</Badge></div><p className="guidebook-evaluation-reason">{assignment.reason}</p>{assignment.representative_candidate !== undefined && <p className="guidebook-evaluation-summary">{assignment.representative_candidate ? '이 지원처의 대표 활동 후보' : '이 지원처의 보조 활동'}{assignment.representative_reason ? ` · ${assignment.representative_reason}` : ''}</p>}<dl><div><dt>{assignment.talent_tags ? '인재상 연결' : '공통 인재상 연결'}</dt><dd>{rows(assignment.talent_tags || item.talent_tags).join(' · ') || '연결 없음'}</dd></div><div><dt>{assignment.major_relevance !== undefined ? '전공 연결' : '공통 전공 연결'}</dt><dd>{(assignment.major_relevance !== undefined ? assignment.major_relevance : item.major_relevance) ?? '연결 없음'}</dd></div></dl><details><summary>평가 근거</summary><SourceEvidence ids={assignment.source_ref_ids} learning={learning} /></details></article>; })}{!rows(item.priority_assignments).length && <p className="muted">지원처별 평가가 없습니다.</p>}<p className="guidebook-upload-note">S/A/B/C/F는 면접 준비 우선도입니다.</p></section>;
}

function LearningConnectionPreview({ item, kind, learning }: { item: Item; kind: string; learning: Item }) {
  const questions = kind === 'activities' ? rows(learning.questions).filter(q => rows(q.activity_ids).includes(item.id)) : kind === 'questions' ? [item] : rows(learning.questions).filter(q => q.id === item.question_id);
  if (!questions.length) return <div className="preview-field"><span>학습 연결</span><p>연결된 질문이 없습니다.</p></div>;
  return <div className="guidebook-learning-connections"><h3>질문에서 이어지는 학습</h3>{questions.map(question => { const quizzes = materialQuestionPracticeItems(question, rows(learning.memory_items)); return <article key={question.id}><p>{question.prompt}</p><div className="guidebook-row-meta"><span>{['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(question.verification_status) ? '모의면접 질문' : '면접 연결 전 검수 필요'}</span><span>퀴즈 {quizzes.length}개</span><span>{factLabel(question.verification_status)}</span></div>{rows(question.support_target_ids).length > 0 && <p className="guidebook-upload-note">{rows(question.support_target_ids).map((id: any) => { const target = rows(learning.support_targets).find(t => t.id === id); return `${targetName(target)} · ${targetMajor(target)}`; }).join(' / ')}</p>}{quizzes.length > 0 && <ul>{quizzes.map(quiz => <li key={quiz.id}>{quiz.prompt}<small>{quiz.evaluation_method === 'reviewed_correct_answer' ? '검수된 정답 확인' : '자기 점검'}</small></li>)}</ul>}{!quizzes.length && <p className="guidebook-upload-note">이 질문에 연결된 퀴즈는 없습니다.</p>}</article>; })}</div>;
}

function PreviewItem({ item, kind, learning }: { item: Item; kind: string; learning: Item }) {
  const displayLabels: Record<string, string> = { keyword: '키워드', keyword_recall: '키워드 회상', choice: '선택형', order: '순서 맞추기', flip: '기억 카드', flip_card: '기억 카드', free_recall: '자유 회상', self_rating: '자가 점검', self_check: '자가 점검', reviewed_correct_answer: '정답 확인', confirmed: '확인됨', pending: '확인 대기', draft: '작성 중', student_record: '학생부', transcript: '학생부', official: '공식 자료', activity: '활동', role: '본인 역할', motivation: '동기', process: '과정', result: '결과', reflection: '배운 점', followup: '꼬리질문', pressure: '압박 질문', major: '전공', university: '대학', common: '공통', current_affairs: '시사', document: '서류', personal: '자기소개', academic: '학업', inquiry: '탐구', community: '공동체', basic: '기본' };
  Object.assign(displayLabels, { talent: '인재상', self_introduction: '자기소개', academic_plan: '학업 계획', career: '진로', verification: '사실 확인', verified: '근거 확인됨', approved: '승인됨', confirmed_from_record: '학생부 확인', confirmed_by_student: '학생 확인', needs_confirmation: '사실 확인 필요', student_says_different: '학생 진술과 다름', cannot_confirm: '확인 어려움', synthetic_reviewed: '테스트 자료' });
  const strings = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(strings).filter(Boolean).join(' · ');
    if (value && typeof value === 'object') { const item = value as Item; return strings(item.label || item.text || item.keyword || item.title || item.tag || ''); }
    return displayLabels[String(value)] || String(value ?? '');
  };
  const fields: Record<string, [string, string][]> = { activities: [['area', '영역'], ['grade', '학년'], ['activity_summary', '활동 요약'], ['motivation', '동기'], ['role', '역할'], ['process', '과정'], ['result', '결과'], ['lessons', '배운 점'], ['keywords', '키워드'], ['fact_confirmation', '사실 확인']], questions: [['question_intent', '질문 의도'], ['answer_elements', '필수 의미'], ['answer_structure', '답변 구조'], ['question_types', '질문 유형'], ['verification_status', '확인 상태']], memory_items: [['kind', '훈련 유형'], ['memory_keywords', '핵심 키워드'], ['back', '뒷면'], ['evaluation_method', '점검 방식']], support_targets: [['department', '학과'], ['campus', '캠퍼스'], ['admission_type', '전형'], ['admission_year', '모집 연도'], ['talent_tags', '인재상'], ['evaluation_elements', '평가 요소'], ['major_connection', '전공 연결'], ['verification_status', '확인 상태']], source_refs: [['type', '자료 유형'], ['page', '페이지'], ['area', '영역'], ['quote', '발췌'], ['location', '위치'], ['url', '출처 URL']] };
  const answer = kind === 'questions' ? rows(learning.answer_scripts).find(a => a.question_id === item.id) : null;
  return <div className="preview-detail guidebook-item-detail">{kind === 'activities' && <ActivityEvaluationPreview item={item} learning={learning} />}{(fields[kind] || []).filter(([key]) => item[key] !== undefined && item[key] !== null && item[key] !== '').map(([key, label]) => <div className="preview-field" key={key}><span>{label}</span><p>{strings(item[key])}</p></div>)}{answer && <div className="preview-field"><span>제공 답변</span><p>{answer.text}</p></div>}{rows(item.options).length > 0 && <div className="preview-field"><span>선택지</span>{rows(item.options).map(o => <p key={o.id}>{o.text}{o.id === item.correct_option_id && ' ✓'}</p>)}</div>}{['activities', 'questions', 'memory_items'].includes(kind) && <LearningConnectionPreview item={item} kind={kind} learning={learning} />}{rows(item.source_ref_ids).length > 0 && <div className="preview-field"><span>연결 근거</span><SourceEvidence ids={item.source_ref_ids} learning={learning} /></div>}</div>;
}

function Reviews() {
  const admin = useAdminData(), [filter, setFilter] = useState('open'), [term, setTerm] = useState('');
  const confirmations = rows(admin.confirmations).filter(c => (filter === 'all' || (filter === 'open' ? !['reviewed', 'rejected'].includes(c.state) : ['reviewed', 'rejected'].includes(c.state))) && `${c.student_name} ${c.question}`.toLowerCase().includes(term.toLowerCase()));
  return <><AdminCrumb section="검수·확인" /><PageTitle title="검수·확인" /><div className="filter-bar"><div className="search-field"><Search size={18} /><input aria-label="확인 요청 검색" placeholder="학생·확인 내용 검색" value={term} onChange={e => setTerm(e.target.value)} /></div><select value={filter} aria-label="검토 상태" onChange={e => setFilter(e.target.value)}><option value="open">처리할 요청</option><option value="done">검토 완료</option><option value="all">전체 요청</option></select></div><section className="panel"><div className="section-heading"><h2>사실 확인·정정 요청</h2><Badge>{confirmations.length}건</Badge></div>{confirmations.length ? confirmations.map(c => <LinkedRow key={c.id} href={`/admin/reviews/${c.id}`} title={c.question} subtitle={`${c.student_name} · ${dateTime(c.updated_at || c.created_at)}${c.response ? ' · 회신 있음' : ''}`} end={status(c.state)}><span className="round-icon"><ShieldCheck size={20} /></span></LinkedRow>) : <Empty title="처리할 확인 요청이 없습니다" />}</section>{rows(admin.answers).length > 0 && <section className="panel"><div className="section-heading"><h2>학생 답변 코멘트</h2><Badge>{rows(admin.answers).length}건</Badge></div>{rows(admin.answers).slice(0, 30).map(a => <LinkedRow key={a.id} href={`/admin/reviews/${a.id}`} title={a.question_prompt || '학생 답변'} subtitle={a.student_name} end={<ChevronRight size={16} />} />)}</section>}</>;
}

function ReviewDetail({ id }: { id: string }) {
  const admin = useAdminData(), op = useOperation(), c = rows(admin.confirmations).find(c => c.id === id), answer = rows(admin.answers).find(a => a.id === id);
  const [note, setNote] = useState(c?.data?.review_note || ''), [state, setState] = useState(c?.confirmation_status||c?.data?.confirmation_status||'needs_confirmation');
  if (!c && !answer) return <Empty title="검토 대상을 찾을 수 없습니다" href="/admin/reviews" label="검토 목록" />;
  const item = c || answer!;
  async function submit(e: FormEvent) { e.preventDefault(); await op.run(() => c ? post('/api/learning',{action:'confirmation_review',confirmationId:id,response:c.response||'',status:state,note,requestId:crypto.randomUUID()}) : action('review', { studentId: item.student_id, answerId:id,note }), c ? '검토 결과를 저장했습니다.' : '답변 코멘트를 남겼습니다.'); }
  return <><AdminCrumb section="검수·확인" detail={item.student_name} /><PageTitle title={c ? '사실 확인 검토' : '답변 코멘트'} aside={c && status(c.state)} /><section className="panel"><div className="section-heading"><Link className="text-link" href={`/admin/students/${item.student_id}`}><UserRound size={17} />{item.student_name}<ArrowUpRight size={14} /></Link><span className="muted">{dateTime(item.created_at)}</span></div><h2>{c ? c.question : answer?.question_prompt || '학생 답변'}</h2>{c ? <div className="review-response"><span>학생 회신</span><p>{c.response || (c.state === 'confirmed' ? '사실을 확인했습니다.' : c.state === 'unknown' ? '기억이 나지 않습니다.' : c.state === 'cannot_confirm' ? '확인이 어렵습니다.' : '아직 회신이 없습니다.')}</p></div> : <div className="preview-detail"><div className="preview-field"><span>답변 구조</span><p>{answer?.structure || '작성 전'}</p></div><div className="preview-field"><span>나의 답변</span><p>{answer?.script || '작성 전'}</p></div></div>}</section><form className="panel admin-form" onSubmit={submit}><div className="section-heading"><h2>{c ? '검토 결과' : '담당자 코멘트'}</h2><ShieldCheck size={20} /></div>{c && <Field label="처리"><select value={state} onChange={e => setState(e.target.value)}><option value="needs_confirmation">확인 필요</option><option value="confirmed_from_record">학생부 원문으로 확인</option><option value="confirmed_by_student">학생 진술로 확인</option><option value="student_says_different">학생 진술과 다름</option><option value="cannot_confirm">확인 어려움</option></select></Field>}<Field label={c ? '검토 메모' : '코멘트'}><textarea rows={5} value={note} required={!c} maxLength={4000} onChange={e => setNote(e.target.value)} /></Field><ErrorMessage error={op.error} /><div className="form-actions"><Link className="button ghost" href="/admin/reviews">목록으로</Link><button className="button primary" disabled={op.busy}>{op.busy ? '저장 중' : '검토 저장'}<Check size={16} /></button></div></form></>;
}

function Knowledge({ id }: { id?: string }) {
  const admin = useAdminData(), { data } = useApp(), [tab, setTab] = useState('briefings'), [create, setCreate] = useState(false);
  const briefings = rows(admin.briefings), releases = rows(admin.knowledge), selected = [...briefings, ...releases].find(b => b.id === id);
  const selectedKind = selected && releases.some(r => r.id === selected.id) ? 'knowledge_release' : 'briefing';
  if (id && !selected) return <Empty title="공용 자료를 찾을 수 없습니다" href="/admin/knowledge" label="공용 자료 목록" />;
  const list = tab === 'briefings' ? briefings : releases;
  return <><AdminCrumb section="공용 자료" detail={selected?.title} /><PageTitle title={selected?.title || '공용 자료'} aside={data.user.role === 'admin' && <button className="button primary" onClick={() => setCreate(true)}><Plus size={17} />{selected ? '자료 수정' : tab === 'briefings' ? '브리핑 등록' : '대학 자료 등록'}</button>} />{selected ? <section className="panel"><div className="section-heading"><Badge>{selected.category}</Badge>{status(selected.status)}</div><PreviewBriefing briefing={selected} /></section> : <><div className="admin-tabs"><button className={tab === 'briefings' ? 'active' : ''} onClick={() => setTab('briefings')}>시사 브리핑<span>{briefings.length}</span></button><button className={tab === 'universities' ? 'active' : ''} onClick={() => setTab('universities')}>대학·학과 맥락<span>{releases.length}</span></button></div><section className="panel">{list.length ? list.map(b => <LinkedRow key={b.id} href={`/admin/knowledge/${b.id}`} title={b.title} subtitle={[b.data?.university, b.data?.year ? `${b.data.year}학년도` : b.category, dateLabel(b.created_at)].filter(Boolean).join(' · ')} end={status(b.status)}><span className="round-icon"><BookOpen size={20} /></span></LinkedRow>) : <Empty title={tab === 'briefings' ? '등록된 브리핑이 없습니다' : '등록된 대학 자료가 없습니다'} />}</section></>}{create && <Modal title={selected ? '공용 자료 수정' : tab === 'briefings' ? '브리핑 등록' : '대학 자료 등록'} onClose={() => setCreate(false)}><BriefingForm value={selected} kind={selected ? selectedKind : tab === 'briefings' ? 'briefing' : 'knowledge_release'} onClose={() => setCreate(false)} /></Modal>}</>;
}

function PreviewBriefing({ briefing }: { briefing: Item }) {
  const value = briefing.data || {}, content = value.content || value.summary || value.fact_summary || value.facts || '';
  const safeSource = (() => { try { return ['https:', 'http:'].includes(new URL(value.source_url).protocol) ? value.source_url : ''; } catch { return ''; } })();
  return <div className="preview-detail">{value.university && <div className="preview-field"><span>적용 대학·연도</span><p>{value.university} · {value.year}학년도</p></div>}<p className="preserve-lines">{typeof content === 'string' ? content : JSON.stringify(content, null, 2)}</p>{value.discussion_question && <div className="preview-field"><span>생각해 볼 질문</span><p>{value.discussion_question}</p></div>}{value.major_connection && <div className="preview-field"><span>전공 연결</span><p>{value.major_connection}</p></div>}{rows(value.questions).map((q: any, i) => <div className="preview-field" key={i}><span>생각해 볼 질문 {i + 1}</span><p>{typeof q === 'string' ? q : q.prompt}</p></div>)}{safeSource && <div className="preview-field"><span>출처</span><a className="text-link" href={safeSource} target="_blank" rel="noopener noreferrer">원문 보기<ArrowUpRight size={15} /></a></div>}{rows(value.sources).length > 0 && <div className="preview-field"><span>연결 근거</span>{rows(value.sources).map((s: any, i) => <p key={i}>{typeof s === 'string' ? s : s.title || s.url}</p>)}</div>}<div className="admin-meta-grid">{[['발행일', value.published_date], ['사건일', value.event_date], ['확인일', value.checked_at]].filter(([, date]) => date).map(([label, date]) => <div key={label}><span>{label}</span><strong>{date}</strong></div>)}{value.source_kind && <div><span>출처</span><strong>{{ synthetic_test_briefing: '테스트 자료', official: '공식 자료', news: '언론 보도', research: '연구 자료' }[value.source_kind as string] || '공용 자료'}</strong></div>}</div></div>;
}

function BriefingForm({ value, kind = 'briefing', onClose }: { value?: Item; kind?: string; onClose: () => void }) {
  const asLines=(items:unknown)=>rows(items).map(i=>typeof i==='string'?i:i.text||i.prompt||i.viewpoint||i.definition||'').join('\n');
  const [facts,setFacts]=useState(asLines(value?.data?.facts)),[views,setViews]=useState(asLines(value?.data?.viewpoints)),[concepts,setConcepts]=useState(asLines(value?.data?.concepts)),[connection,setConnection]=useState(value?.data?.major_connection||''),[reviewNote,setReviewNote]=useState(value?.data?.review_note||'');
  const lines=(text:string)=>text.split('\n').map(s=>s.trim()).filter(Boolean);
  const op = useOperation(), [title, setTitle] = useState(value?.title || ''), [category, setCategory] = useState(value?.category || (kind === 'briefing' ? '시사' : '대학·전형')), [content, setContent] = useState(value?.data?.summary || ''), [question, setQuestion] = useState(value?.data?.discussion_question || ''), [source, setSource] = useState(value?.data?.source_url || ''), [sourceKind, setSourceKind] = useState(value?.data?.source_kind || 'official'), [state, setState] = useState(value?.status || 'draft'), [publishedDate, setPublishedDate] = useState(value?.data?.published_date || ''), [eventDate, setEventDate] = useState(value?.data?.event_date || ''), [checkedAt, setCheckedAt] = useState(value?.data?.checked_at || ''), [university, setUniversity] = useState(value?.data?.university || ''), [year, setYear] = useState(value?.data?.year || 2027);
  async function submit(e: FormEvent) { e.preventDefault(); await op.run(() => action(kind, { id: value?.id, expectedRevision:value?.data?.revision||0, title, category, status: state, summary: content, discussionQuestion: question, sourceURL: source, sourceKind, publishedDate, eventDate, checkedAt, university, year: Number(year), documentType: value?.data?.document_type || '', ...(kind==='briefing'?{facts:lines(facts),viewpoints:lines(views),concepts:lines(concepts),majorConnection:connection,reviewNote,questions:question.trim()?[question.trim()]:[]}:{} ) }), state === 'published' ? '공용 자료를 발행했습니다.' : '공용 자료를 저장했습니다.', onClose); }
  return <form className="admin-form" onSubmit={submit}><Field label="제목"><input value={title} required maxLength={180} onChange={e => setTitle(e.target.value)} /></Field><Field label="분야"><input value={category} required onChange={e => setCategory(e.target.value)} /></Field>{kind === 'knowledge_release' && <div className="form-grid"><Field label="대학"><input required value={university} onChange={e => setUniversity(e.target.value)} /></Field><Field label="모집 연도"><input type="number" required min={2026} max={2100} value={year} onChange={e => setYear(e.target.value)} /></Field></div>}<Field label="요약"><textarea rows={5} required maxLength={8000} value={content} onChange={e => setContent(e.target.value)} /></Field>{kind === 'briefing' && <Field label="생각해 볼 질문"><textarea rows={2} value={question} onChange={e => setQuestion(e.target.value)} /></Field>}{kind === 'briefing' && <><Field label="핵심 사실 · 최대 3개" hint="한 줄에 하나씩, 확인한 사실만 적어주세요."><textarea rows={3} value={facts} onChange={e=>setFacts(e.target.value)}/></Field><Field label="관점 · 최대 2개"><textarea rows={2} value={views} onChange={e=>setViews(e.target.value)}/></Field><Field label="핵심 개념"><textarea rows={2} value={concepts} onChange={e=>setConcepts(e.target.value)}/></Field><Field label="전공 연결"><textarea rows={2} value={connection} onChange={e=>setConnection(e.target.value)}/></Field><Field label="검수 메모"><textarea rows={2} value={reviewNote} onChange={e=>setReviewNote(e.target.value)}/></Field></>}<Field label="출처 URL"><input type="url" required={state === 'published'} value={source} onChange={e => setSource(e.target.value)} /></Field><Field label="출처 유형"><select value={sourceKind} onChange={e => setSourceKind(e.target.value)}><option value="official">공식 자료</option><option value="news">언론 보도</option><option value="research">연구 자료</option>{sourceKind === 'synthetic_test_briefing' && <option value="synthetic_test_briefing">합성 테스트 자료</option>}</select></Field><div className="form-grid"><Field label="발행일"><input type="date" value={publishedDate} onChange={e => setPublishedDate(e.target.value)} /></Field><Field label="사건일"><input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)} /></Field></div><div className="form-grid"><Field label="확인일"><input type="date" required={state === 'published'} value={checkedAt} onChange={e => setCheckedAt(e.target.value)} /></Field><Field label="상태"><select value={state} onChange={e => setState(e.target.value)}><option value="draft">작성 중</option><option value="published">검토 완료·발행</option></select></Field></div><ErrorMessage error={op.error} /><button className="button primary full" disabled={op.busy}>{op.busy ? '저장 중' : state === 'published' ? '검토 완료·발행' : '저장'}</button></form>;
}

function Settings() {
  const admin = useAdminData(), { data } = useApp(), op = useOperation();
  const [tab, setTab] = useState('assignments'), [staffCreate, setStaffCreate] = useState(false), [studentId, setStudentId] = useState(''), [staffId, setStaffId] = useState('');
  const tabs = [['assignments', '계정·배정'], ['usage', 'AI 사용량'], ['notifications', '알림'], ['logs', '작업 이력']], students = rows(admin.students), staff = rows(admin.staff);
  async function assign(e: FormEvent) { e.preventDefault(); await op.run(() => action('assignments', { studentId, staffId }), '담당자를 배정했습니다.', () => { setStudentId(''); setStaffId(''); }); }
  return <><AdminCrumb section="운영 설정" /><PageTitle title="운영 설정" /><div className="admin-tabs">{tabs.map(([key, title]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{title}</button>)}</div><ErrorMessage error={op.error} />{tab === 'assignments' && <><section className="panel"><div className="section-heading"><h2>운영 계정</h2>{data.user.role === 'admin' && <button className="button small ghost" onClick={() => setStaffCreate(true)}><Plus size={15} />담당자 생성</button>}</div><div className="linked-row"><span className="avatar">{data.user.name?.slice(0, 1)}</span><div className="row-text"><strong>{data.user.name}</strong><span>{data.user.email}</span></div>{status(data.user.role)}</div>{staff.filter(s => s.id !== data.user.id).map(s => <div className="linked-row" key={s.id}><span className="avatar">{s.name?.slice(0, 1)}</span><div className="row-text"><strong>{s.name}</strong><span>{s.email}</span></div>{status(s.role)}<Badge tone={s.active ? 'green' : 'neutral'}>{s.active ? '활성' : '비활성'}</Badge></div>)}</section><section className="panel"><div className="section-heading"><h2>학생·담당자 배정</h2><Users size={20} /></div>{data.user.role === 'admin' && <form className="assignment-form" onSubmit={assign}><Field label="학생"><select required value={studentId} onChange={e => setStudentId(e.target.value)}><option value="">학생 선택</option>{students.map(s => <option key={s.id} value={s.id}>{s.name} · {s.email}</option>)}</select></Field><Field label="담당자">{staff.length ? <select required value={staffId} onChange={e => setStaffId(e.target.value)}><option value="">담당자 선택</option>{staff.filter(s => s.role === 'staff' && s.active).map(s => <option value={s.id} key={s.id}>{s.name} · {s.email}</option>)}</select> : <input required placeholder="담당자 ID" value={staffId} onChange={e => setStaffId(e.target.value)} />}</Field><button className="button primary" disabled={op.busy || !studentId || !staffId}>배정<Plus size={16} /></button></form>}{rows(admin.assignments).length ? rows(admin.assignments).map(a => <div className="linked-row" key={`${a.student_id}-${a.staff_id}`}><div className="row-text"><strong>{students.find(s => s.id === a.student_id)?.name || '학생'}</strong><span>{a.staff_name}</span></div>{data.user.role === 'admin' && <button className="button small ghost" disabled={op.busy} onClick={() => op.run(() => action('assignments', { studentId: a.student_id, staffId: a.staff_id, remove: true }), '배정을 해제했습니다.')}>해제<X size={13} /></button>}</div>) : <Empty title="담당자 배정이 없습니다" />}</section></>}{tab === 'usage' && <Usage usage={rows(admin.usage?.logs)} />}{tab === 'notifications' && <Notifications students={students} notifications={rows(admin.notifications)} />}{tab === 'logs' && <section className="panel"><div className="section-heading"><h2>최근 작업 이력</h2><Badge>{rows(admin.audit).length}건</Badge></div><AuditList logs={rows(admin.audit)} students={students} /></section>}{staffCreate && <Modal title="담당자 계정 생성" onClose={() => setStaffCreate(false)}><AccountForm role="staff" onClose={() => setStaffCreate(false)} /></Modal>}</>;
}

function Usage({ usage }: { usage: Item[] }) {
  const input = usage.reduce((total, u) => total + Number(u.input_tokens || 0), 0), output = usage.reduce((total, u) => total + Number(u.output_tokens || 0), 0), total = usage.reduce((sum, u) => sum + Number(u.requests || u.count || 1), 0);
  return <><div className="admin-stats compact">{[['요청', total, '건'], ['입력 토큰', input, ''], ['출력 토큰', output, '']].map(([title, count, unit]) => <section className="panel admin-stat" key={title}><span>{title}</span><strong>{Number(count).toLocaleString()}<small>{unit}</small></strong></section>)}</div><section className="panel"><div className="section-heading"><h2>기능별 사용 기록</h2><Activity size={20} /></div>{usage.length ? usage.map((u, i) => <div className="linked-row" key={u.id || i}><div className="row-text"><strong>{u.student_name ? `${u.student_name} · ` : ''}{u.feature || u.kind}</strong><span>{u.model} · {dateTime(u.created_at)}</span></div><span className="muted">입력 {Number(u.input_tokens || 0).toLocaleString()} · 출력 {Number(u.output_tokens || 0).toLocaleString()}</span>{u.status && status(u.status)}</div>) : <Empty title="AI 사용 기록이 없습니다" />}</section></>;
}

function Notifications({ students, notifications }: { students: Item[]; notifications: Item[] }) {
  const op = useOperation(), [studentId, setStudentId] = useState(''), [title, setTitle] = useState(''), [body, setBody] = useState('');
  async function submit(e: FormEvent) { e.preventDefault(); await op.run(() => action('notification', { studentId, title, body, href: '/my' }), '알림을 보냈습니다.', () => { setTitle(''); setBody(''); }); }
  return <><form className="panel admin-form" onSubmit={submit}><div className="section-heading"><h2>학생에게 알림</h2><Bell size={20} /></div><Field label="학생"><select required value={studentId} onChange={e => setStudentId(e.target.value)}><option value="">학생 선택</option>{students.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name} · {s.email}</option>)}</select></Field><Field label="제목"><input required maxLength={180} value={title} onChange={e => setTitle(e.target.value)} /></Field><Field label="내용"><textarea required maxLength={2000} rows={3} value={body} onChange={e => setBody(e.target.value)} /></Field><ErrorMessage error={op.error} /><div className="form-actions"><button className="button primary" disabled={op.busy}>{op.busy ? '보내는 중' : '알림 보내기'}<Send size={16} /></button></div></form><section className="panel"><div className="section-heading"><h2>발송 이력</h2><Badge>{notifications.length}건</Badge></div>{notifications.length ? notifications.map(n => <div className="linked-row" key={n.id}><div className="row-text"><strong>{n.title}</strong><span>{n.student_name || students.find(s => s.id === n.student_id)?.name} · {n.body}</span></div><span className="muted">{dateTime(n.created_at)}</span><Badge tone={n.read_at ? 'green' : 'neutral'}>{n.read_at ? '읽음' : '안 읽음'}</Badge></div>) : <Empty title="발송한 알림이 없습니다" />}</section></>;
}

function AuditList({ logs, students }: { logs: Item[]; students: Item[] }) { return logs.length ? <div className="audit-list">{logs.map(log => <div className="audit-row" key={log.id}><span className="audit-dot" /><div><strong>{auditLabels[log.action] || '운영 작업'}</strong><span>{students.find(s => s.id === log.student_id)?.name || log.actor_name || '운영 작업'}</span></div><time>{dateTime(log.created_at)}</time></div>)}</div> : <Empty title="작업 이력이 없습니다" />; }





