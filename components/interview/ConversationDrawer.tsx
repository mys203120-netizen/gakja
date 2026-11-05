'use client';
import { useEffect, useRef } from 'react';
import { MessageSquare, X, AudioLines } from 'lucide-react';
import type { ConversationMessage, Phase } from '@/hooks/useInterviewSession';
export function ConversationDrawer({ open, messages, phase, onClose }: { open: boolean; messages: ConversationMessage[]; phase: Phase; onClose: () => void }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [messages, open]);
  return <aside className={`conversation-drawer ${open ? 'is-open' : ''}`} aria-label="실시간 대화" aria-hidden={!open} inert={!open}>
    <header><div><MessageSquare size={18} /><h2>실시간 대화</h2></div><button className="icon-button" aria-label="대화 닫기" onClick={onClose}><X size={19} /></button></header>
    <div className="conversation-scroll">
      {!messages.length && <div className="empty-conversation"><MessageSquare size={28} strokeWidth={1} /><p>대화가 여기에 차곡차곡 쌓여요.</p><span>질문과 제출한 답변을 확인할 수 있어요.</span></div>}
      {messages.map(m => <article key={m.id} className={`conversation-message ${m.role}`}><span className="message-author">{m.role === 'candidate' ? '윤지우 · 나' : '면접관'} <time>{new Date(m.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></span><div className="message-bubble">{m.text || (m.pending ? '마지막 음성을 확인하고 있어요.' : '인식된 답변이 없습니다.')}{m.pending && <small>전사 확정 중</small>}</div></article>)}
      {phase === 'listening' && <article className="conversation-message candidate"><span className="message-author">윤지우 · 나</span><div className="message-bubble listening-bubble"><AudioLines size={16} /> 답변 중 · 제출하면 내용이 표시돼요</div></article>}
      <div ref={bottom} />
    </div>
  </aside>;
}
