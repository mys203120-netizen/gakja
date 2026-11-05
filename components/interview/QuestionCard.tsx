import { ArrowUpRight, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { Phase, PreparationStatus, PreparedTurn } from '@/hooks/useInterviewSession';
import { ADMISSIONS_GUIDE_URL } from '@/lib/interview/target-links';
import { isInterviewDurationSeconds } from '@/lib/interview/timing';
export function QuestionCard({ turn, phase, preparation, loadingError, refresh, endingRequested = false }: { turn: PreparedTurn | null; phase: Phase; preparation: PreparationStatus | null; loadingError: string; refresh: () => void; micReady?: boolean; cameraReady?: boolean; endingRequested?: boolean }) {
  if (endingRequested || phase === 'ending' || phase === 'completed') return null;
  if (turn) return <section className="question-card" aria-label="현재 질문">
    <div className="question-heading"><h2>{turn.questionKind === 'clarification' ? '질문 다시 확인' : <>주질문 <strong>{turn.mainIndex}</strong>{turn.mainCountIsLimit !== false && <span> / {turn.mainCount}</span>}</>}</h2>{turn.questionKind === 'follow_up' && <span className="followup-tag">꼬리질문 {turn.followUpIndex}</span>}</div>
    <span className="question-label">질문 내용</span>
    <div className="question-content" aria-live="polite"><p>{turn.questionText}</p></div>
  </section>;
  const overview = preparation?.interviewOverview;
  const hasOverview = overview && isInterviewDurationSeconds(overview.durationSeconds) && Array.isArray(overview.lines) && overview.lines.length === 3 && overview.lines.every(line => typeof line === 'string' && line.trim());
  const configurationProblem = preparation && !preparation.ready && (preparation.missingKeys.length > 0 || preparation.errors.length > 0);
  return <section className={`question-card ready-card ${configurationProblem ? 'needs-setup' : ''}`} aria-label="면접 준비 상태">
    <h1 className="target-heading"><span>서울시립대학교 <a className="admissions-guide-link" href={ADMISSIONS_GUIDE_URL} target="_blank" rel="noopener noreferrer" aria-label="서울시립대학교 모집요강 열기"><ArrowUpRight size={22} /></a></span><br /><span>융합응용화학과</span></h1>
    <div className="target-info"><small>2027학년도 · 학생부종합전형I (면접형)</small></div>
    <div className="interview-overview" aria-label="학교 면접 안내">
      {hasOverview ? overview.lines.map((line, index) => <span key={index}>{line}</span>) : configurationProblem || loadingError ? <span>면접 안내 자료를 확인해 주세요.</span> : <span><LoaderCircle size={12} className="spinning" /> 면접 개요를 확인하고 있어요.</span>}
    </div>
    {loadingError && <div className="setup-note"><span>{loadingError}</span><button onClick={refresh}>다시 확인</button></div>}
    {configurationProblem && <div className="setup-note configuration-note"><ShieldCheck size={16} /><div><strong>시작 전 연결 설정이 필요해요</strong>{preparation.missingKeys.length > 0 && <><span>아래 항목을 .env.local에 입력해 주세요.</span><div className="key-list">{preparation.missingKeys.map(key => <code key={key}>{key}</code>)}</div></>}{preparation.errors.map((error, i) => <p key={i}>{error}</p>)}<button onClick={refresh}>설정 다시 확인</button></div></div>}
  </section>;
}
