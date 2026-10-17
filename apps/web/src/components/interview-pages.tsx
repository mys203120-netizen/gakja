'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowUpRight, MessagesSquare, Video, Play } from 'lucide-react';
import { useApp } from './app-shell';
import { PageTitle, LinkedRow, dateLabel, targetName, targetMajor, type Item } from './shared';
import { InterviewSetup, InterviewSession } from './interview';
import { interviewSetupHref } from '@/lib/interview-flow';
import { interviewTargetSnapshot, splitInterviewsByLearningTarget } from '@/lib/learning-target-scope';
import styles from './school-context.module.css';
export function InterviewPages({ slug = [] }: { slug?: string[] }) {
  const params = useSearchParams();
  const { data, targetId } = useApp();
  const kind = ['video','live'].includes(params.get('kind') || '') || slug[0] === 'live' ? 'video' : 'chat';
  if (['new','chat','live'].includes(slug[0])) return <InterviewSetup kind={kind}/>;
  if (slug[0]) return <InterviewSession id={slug[0]} kind={data.interviews?.find(s => s.id === slug[0])?.kind === 'video' ? 'video' : kind}/>;
  const active = data.interviews?.filter(s => !['completed', 'cancelled', 'deleted'].includes(s.state || s.status)) || [];
  const selectedTarget = data.targets.find(target => target.id === targetId);
  const { current, other } = splitInterviewsByLearningTarget(active, selectedTarget);
  function sessionLabel(session: Item) {
    const snapshot = interviewTargetSnapshot(session);
    return snapshot ? [targetName(snapshot), targetMajor(snapshot)].filter(Boolean).join(' · ') : session.title || session.data?.targetName || '지원처 미지정 면접';
  }
  function sessionRow(session: Item) {
    const snapshot = interviewTargetSnapshot(session);
    const context = snapshot ? [snapshot.admission_year || snapshot.year ? `${snapshot.admission_year || snapshot.year}학년도` : '', snapshot.campus, snapshot.admission_type || snapshot.track].filter(Boolean).join(' · ') : '시작 당시 지원처 정보 없음';
    const questionCount = Number(session.data?.questionCount ?? session.data?.questionQueue?.length ?? 0);
    return <LinkedRow key={session.id} href={`/interview/${session.id}?kind=${session.kind}`} title={sessionLabel(session)} subtitle={`${context}\n${dateLabel(session.updated_at || session.created_at)} · ${session.kind === 'video' ? 'Live' : 'Chat'}${questionCount ? ` · 문항 ${Math.min(Number(session.data.index || 0) + 1, questionCount)}/${questionCount}` : ''}`} end={<span className="row-action"><Play size={14}/>이어서</span>}/>;
  }
  return <div className={`interview-home ${styles.interviewHome}`}><PageTitle title="모의면접"/>
    {selectedTarget && <p className={styles.currentContext}>현재 지원처<span>{[targetName(selectedTarget), targetMajor(selectedTarget)].filter(Boolean).join(' · ')}</span></p>}
    {current.length > 0 ? <section className={`detail-section ${styles.resumeSection}`}><h2>이어서 연습</h2>{sessionRow(current[0])}{current.length > 1 && <details className={styles.otherSessions}><summary>이 지원처의 진행 중 면접 {current.length - 1}개</summary>{current.slice(1).map(sessionRow)}</details>}</section> : selectedTarget && <p className={styles.resumeEmpty}>이 지원처에서 새 면접을 시작해 보세요.</p>}
    <section className="interview-new"><h2 className="section-label">새 면접 시작</h2><div className="interview-entry-choices"><Link href={interviewSetupHref('chat', params, { targetId })}><MessagesSquare size={30} strokeWidth={1.4}/><div><h3>채팅 면접 <small>Chat</small></h3><p>질문에 글로 답하는 면접</p></div><ArrowUpRight size={24}/></Link><Link href={interviewSetupHref('video', params, { targetId })}><Video size={30} strokeWidth={1.4}/><div><h3>화상 면접 <small>Live</small></h3><p>카메라와 목소리로 답하는 면접</p></div><ArrowUpRight size={24}/></Link></div></section>
    {other.length > 0 && <details className={styles.otherSessions}><summary>다른 지원처·이전 지원 정보의 면접 {other.length}개</summary><p className={styles.historyNote}>시작 당시의 학교·학과·전형으로 이어져요.</p>{other.map(sessionRow)}</details>}
    {!data.package && <p className="body-copy">공통 질문부터 시작할 수 있어요.</p>}<div className="inline-actions"><Link className="text-link" href={targetId ? `/schools/${encodeURIComponent(targetId)}` : '/schools'}>학교 면접 안내<ArrowUpRight size={15}/></Link><Link className="text-link" href="/records">내 리포트<ArrowUpRight size={15}/></Link></div></div>;
}
