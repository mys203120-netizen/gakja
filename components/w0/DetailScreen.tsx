'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, FileText, LockKeyhole, Video } from 'lucide-react';
import { detailPages, primaryNavigation } from '@/lib/w0/navigation';
import { evaluationLabel, interviewDateLabel } from '@/lib/w0/view-model';
import { useW0 } from './W0Context';
import { GuideContents } from './EntryScreens';
import { QuestionPreview } from './QuestionPreview';
import { PageHeading, StateNotice } from './ui';
import styles from './DetailScreen.module.css';

function ExistingInterview() {
  return <section className={styles.engine}><Video size={23} aria-hidden="true" /><div><h2>면접 화면으로 이어가기</h2><p>별도 면접 화면에서 지원처와 장비 상태를 확인해 주세요. 이 학습 공간의 지원처 선택은 진행 중인 면접에 반영되지 않아요.</p><a href="/interview" target="_blank" rel="noopener noreferrer">기존 면접 화면 열기 <ExternalLink size={15} aria-hidden="true" /><span className={styles.srOnly}> (새 탭)</span></a></div></section>;
}

function AnswerRecords({ report = false }: { report?: boolean }) {
  const { model } = useW0();
  const [kind, setKind] = useState<'practice' | 'mock'>('practice');
  const sessions = model.sessions.filter((session) => session.kind === (report ? 'mock' : kind));
  return <section className={styles.records} aria-label={report ? '회차별 리포트' : '면접 기록'}>
    {!report && <fieldset className={styles.segment}><legend className={styles.srOnly}>면접 기록 종류</legend>{(['practice', 'mock'] as const).map((value) => <label key={value}><input type="radio" name="w0-record-kind" value={value} checked={kind === value} onChange={() => setKind(value)} /><span>{value === 'practice' ? '연습 면접' : '실전 모의면접'}</span></label>)}</fieldset>}
    {sessions.length ? <div className={styles.sessionList}>{sessions.map((session) => <details key={session.id}><summary><span><strong>{session.title}</strong><time dateTime={session.date}>{interviewDateLabel(session.date)}</time></span><span>{session.kind === 'practice' && session.evaluation === 'ready' ? '피드백 준비됨' : evaluationLabel(session.evaluation, session.score)}</span></summary><div><p>{session.evaluation === 'review_required' ? '평가 검수 대기 · 점수는 아직 확정되지 않았어요.' : session.kind === 'practice' ? '예시 세션의 정성 피드백 상태예요. 실제 발화·답변 기록은 포함하지 않아요.' : '평가 자료를 확인하고 있어요.'}</p><p>예시 데이터 · 실제 회차의 답변이나 리포트가 아니에요.</p></div></details>)}</div> : <div className={styles.empty}><FileText size={28} aria-hidden="true" /><h2>{model.status === 'empty' ? `아직 ${report || kind === 'mock' ? '실전' : '연습'} 기록이 없어요` : '확인할 수 있는 기록이 없어요'}</h2><p>실제 기록이 연결되면 세션과 회차별로 확인할 수 있어요.</p></div>}
  </section>;
}

function PracticeSetup() {
  const [source, setSource] = useState('질문 선택');
  const [medium, setMedium] = useState('chat');
  return <section className={styles.setup} aria-label="연습 설정">
    <fieldset className={styles.segment}><legend className={styles.srOnly}>질문 준비 방법</legend>{['질문 선택', 'AI 질문 생성', '직접 입력'].map((value) => <label key={value}><input type="radio" name="w0-source" checked={source === value} onChange={() => setSource(value)} /><span>{value}</span></label>)}</fieldset>
    <div className={styles.settingBody}><h2>{source}</h2><p>{source === '질문 선택' ? '내가 추가한 항목, 가이드북 전체, 보완 추천에서 질문을 선택할 수 있도록 준비하고 있어요.' : source === 'AI 질문 생성' ? '학생부와 지원처 자료가 연결되면 유효한 조건으로 질문을 준비할 수 있어요.' : '질문을 보관하고 연습하는 기능을 준비하고 있어요. 아직 입력하거나 제출할 수 없어요.'}</p></div>
    <fieldset className={styles.medium}><legend>연습 방식</legend><label><input type="radio" name="w0-medium" checked={medium === 'chat'} onChange={() => setMedium('chat')} />채팅</label><label><input type="radio" name="w0-medium" checked={medium === 'video'} onChange={() => setMedium('video')} />화상</label></fieldset>
    <button className={styles.disabledButton} disabled>연습 시작</button><p className={styles.help}>연습할 질문과 이용 가능 여부를 확인할 수 있게 되면 시작할 수 있어요.</p>
  </section>;
}

function AccountTargets() {
  const { model, target, setSelectedTargetId, preview } = useW0();
  return <section className={styles.accountTargets}><h2>등록된 지원처</h2>{model.targets.length ? <ul>{model.targets.map((item) => <li key={item.id}><div><strong>{item.university}</strong><p>{item.department}</p><small>{item.admission}</small><p>개인 면접일 · {interviewDateLabel(item.interviewDate)}</p></div><button disabled={!preview || item.id === target?.id} onClick={() => setSelectedTargetId(item.id)}>{item.id === target?.id ? '선택됨' : '예시 지원처 선택'}</button></li>)}</ul> : <p>등록된 지원처를 확인할 수 없어요. 지원처 등록과 면접일 수정 기능은 준비 중이에요.</p>}<p className={styles.help}>{preview ? '미리보기에서만 선택이 바뀌며 실제 등록·변경·권한에는 반영되지 않아요.' : '등록·변경·추가와 일정 저장은 계정 정보가 연결된 뒤 이용할 수 있어요.'}</p></section>;
}

export function DetailScreen({ id }: { id: string }) {
  const page = detailPages[id];
  const { model, target, viewHref } = useW0();
  const parent = primaryNavigation.find((item) => item.area === page.area);
  const guide = id.startsWith('G');
  const questionExample = id === 'G04' && model.isExample && !!model.questionPreview;
  const noticeStatus = model.status === 'ready' ? 'disconnected' : model.status;
  let body: React.ReactNode;
  if (id === 'I01') body = <PracticeSetup />;
  else if (['I05', 'I06', 'I07'].includes(id)) body = <><div className={styles.factLine}><Video size={18} aria-hidden="true" /><strong>실전 모의면접 · 화상 전용</strong></div><ExistingInterview /></>;
  else if (id === 'A01' || id === 'A03') body = <AnswerRecords report={id === 'A03'} />;
  else if (id === 'A06') body = <section className={styles.empty}><LockKeyhole size={30} aria-hidden="true" /><h2>{target?.interviewDate ? '면접 하루 전 열려요' : '면접일이 아직 미확정이에요'}</h2><p>{target?.interviewDate ? '공개 조건과 자료 준비가 확인된 뒤 요약을 볼 수 있어요.' : '면접일을 등록하면 열리는 날짜를 알려드려요.'}</p><Link href={viewHref('/w0/view/U01')}>지원처 관리</Link></section>;
  else if (id === 'U01') body = <AccountTargets />;
  else if (id === 'G07') body = <section className={styles.reading}><h2>필요한 장을 골라 읽어요</h2><p>목차에서 나의 면접 전략과 학생부, 질문·답변을 살펴보세요.</p><h2>저장한 질문은 연습실에서 만나요</h2><p>질문을 저장한 뒤 면접 연습실에서 연습할 질문을 선택해요. 질문 저장이 바로 연습을 시작하지는 않아요.</p><h2>가이드북 안에서 도움받아요</h2><p>AI 비서는 가이드북의 확인된 내용을 바탕으로 답하도록 준비하고 있어요.</p></section>;
  else if (questionExample) body = <QuestionPreview />;
  else body = <section className={styles.empty}><FileText size={28} aria-hidden="true" /><h2>{id === 'G02' ? '확인된 학생부 원문을 기다리고 있어요' : id === 'G04' ? '질문·답변 자료를 준비하고 있어요' : '확인된 자료가 준비되면 보여드릴게요'}</h2><p>{id === 'G02' ? '원문은 문단과 수치, 순서를 보존해 제공해요. 현재 열람할 수 있는 원문이 없어요.' : id.startsWith('M') ? '이용 범위와 검수된 학습 자료를 확인한 뒤 이용할 수 있어요.' : '이 기능은 아직 이용할 수 없어요. 준비된 학습 메뉴를 먼저 둘러보세요.'}</p>{id.startsWith('M') && model.status === 'forbidden' && <Link href={viewHref('/w0/view/U02')}>요금제 보기</Link>}</section>;
  return <div><Link href={viewHref(parent?.path ?? '/w0')} className={styles.back}><ArrowLeft size={16} aria-hidden="true" />{parent?.label ?? 'MY 홈'}</Link><PageHeading eyebrow={guide ? 'GUIDEBOOK' : 'MY LEARNING'} title={page.title} description={page.description} />
    <div className={guide ? styles.guideLayout : undefined}>{guide && <aside className={styles.contents}><div className={styles.desktopContents}><GuideContents currentId={id} /></div><details className={styles.mobileContents}><summary>목차</summary><GuideContents currentId={id} /></details></aside>}<div className={styles.body}>
      {!questionExample && id !== 'G07' && <StateNotice status={noticeStatus} compact />}
      {body}
    </div></div>
  </div>;
}
