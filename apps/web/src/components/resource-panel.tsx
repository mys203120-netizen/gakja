'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowUpRight, X } from 'lucide-react';
import { type Bootstrap, type Item } from './shared';

export type Resource = { kind: 'activity' | 'source' | 'question' | 'guidebook' | 'handbook' | 'briefing'; id?: string; snapshot?: {learning: Item; documents: Item[]; briefings?:Item[]} };
const labels = { activity: '활동', source: '학생부 원문', question: '예상 질문', guidebook: '가이드북', handbook: '암기 핸드북', briefing: '시사 브리핑' };
function safeUrl(value?: string) { try { const url = new URL(value || ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } }
export function ResourcePanel({ data, resource, onClose, onSelect }: { data: Bootstrap; resource: Resource; onClose: () => void; onSelect: (resource: Resource) => void }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; panel.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select,input,textarea,[tabindex="0"]') || []);
      if (!nodes.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === panel.current)) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && (document.activeElement === nodes.at(-1) || document.activeElement === panel.current)) { event.preventDefault(); nodes[0].focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  const activities: Item[] = data.learning?.activities || [], questions: Item[] = data.learning?.questions || [], sources: Item[] = data.learning?.source_refs || [];
  const item = resource.kind === 'activity' ? activities.find(i => i.id === resource.id) : resource.kind === 'question' ? questions.find(i => i.id === resource.id) : resource.kind === 'source' ? sources.find(i => i.id === resource.id) : resource.kind === 'briefing' ? data.briefings?.find((i: Item) => i.id === resource.id) : data.documents?.find(i => i.kind === resource.kind || resource.kind === 'handbook' && i.kind === 'memory_handbook');
  const docSections: Item[] = (item?.sections || []).flatMap((s: Item) => [s, ...(s.children || s.sections || [])]);
  const section = docSections.find(i => i.id === resource.id) || docSections.find(s=>(item?.blocks||[]).some((b:Item)=>b.section_id===s.id)) || docSections[1] || docSections[0];
  const href = resource.kind === 'source' ? undefined : `/materials/${resource.kind === 'activity' ? 'activities' : resource.kind === 'question' ? 'questions' : resource.kind === 'briefing' ? 'briefings' : resource.kind}${['activity', 'question', 'briefing'].includes(resource.kind) && resource.id ? '/' + encodeURIComponent(resource.id) : ''}`;
  const title = item?.title || item?.prompt || labels[resource.kind];
  function Source({ source }: { source: Item }) { return <blockquote><p>{source.quote}</p><cite>{[source.area, source.page && `${source.page}쪽`].filter(Boolean).join(' · ')}</cite></blockquote>; }
  function Ref({ kind, id, title }: { kind: Resource['kind']; id?: string; title: string }) { return <button className="resource-link" onClick={() => onSelect({ kind, id })}>{title}<ArrowUpRight size={16}/></button>; }
  return <div className="resource-overlay"><button className="resource-backdrop" onClick={onClose} aria-label="자료 닫기" tabIndex={-1}/><aside ref={panel} tabIndex={-1} className="resource-panel" role="dialog" aria-modal="true" aria-labelledby="resource-title"><header><span>{labels[resource.kind]}</span><button className="icon-button" onClick={onClose} aria-label="자료 닫기"><X size={20}/></button></header><div className="resource-body"><h2 id="resource-title">{title}</h2>{!item ? <p className="muted">연결된 자료를 찾을 수 없어요.</p> : <>
    {resource.kind === 'source' && <Source source={item}/>}
    {resource.kind === 'activity' && <><p className="body-copy">{item.activity_summary}</p><h3>학생부 원문</h3>{sources.filter(s => item.source_ref_ids?.includes(s.id)).map(s => <Source source={s} key={s.id}/>)}<h3>연결 질문</h3>{questions.filter(q => q.activity_ids?.includes(item.id)).map(q => <Ref key={q.id} kind="question" id={q.id} title={q.prompt}/>)}</>}
    {resource.kind === 'question' && <><h3>질문의 의도</h3><p className="body-copy">{item.question_intent}</p><h3>답변에 담을 것</h3><ol>{(item.answer_elements || item.answer_structure || []).map((s: any, i: number) => <li key={i}>{typeof s === 'string' ? s : s.label || s.title}</li>)}</ol>{sources.filter(s => item.source_ref_ids?.includes(s.id)).map(s => <Source source={s} key={s.id}/>)}{activities.filter(a => item.activity_ids?.includes(a.id)).map(a => <Ref key={a.id} kind="activity" id={a.id} title={a.title}/>)}</>}
    {resource.kind === 'briefing' && <><p className="body-copy">{item.data?.summary || item.summary}</p><h3>생각해 볼 질문</h3><p>{item.data?.discussion_question||item.discussion_question}</p>{safeUrl(item.data?.source_url||item.source_url) && <a className="text-link" href={safeUrl(item.data?.source_url||item.source_url)} target="_blank" rel="noopener noreferrer">출처 확인<ArrowUpRight size={14}/></a>}</>}
    {['guidebook', 'handbook'].includes(resource.kind) && <><select aria-label="자료의 목차" value={section?.id || ''} onChange={e => onSelect({ kind: resource.kind, id: e.target.value })}>{docSections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select><h3>{section?.title}</h3>{(section?.children||section?.sections||[]).map((s:Item)=><Ref key={s.id} kind={resource.kind} id={s.id} title={s.title}/>)}{(item.blocks || []).filter((b: Item) => b.section_id === section?.id).map((b: Item, i: number) => b.type === 'activity_ref' ? <Ref key={i} kind="activity" id={b.activity_id} title={activities.find(a => a.id === b.activity_id)?.title || '활동'}/> : b.type === 'question_ref' ? <Ref key={i} kind="question" id={b.question_id} title={questions.find(q => q.id === b.question_id)?.prompt || '질문'}/> : b.type === 'source_ref' ? <Ref key={i} kind="source" id={b.source_ref_id} title="학생부 원문"/> : b.type === 'memory_item_ref' || b.type === 'memory_ref' ? (resource.snapshot ? <Ref key={i} kind="question" id={data.learning?.memory_items?.find((m:Item)=>m.id===b.memory_item_id)?.question_id} title={data.learning?.memory_items?.find((m:Item)=>m.id===b.memory_item_id)?.prompt||'당시 연결 질문'}/> : <Link key={i} className="resource-link" href={`/practice/memory/${encodeURIComponent(b.memory_item_id)}`} onClick={onClose}>{data.learning?.memory_items?.find((m:Item)=>m.id===b.memory_item_id)?.prompt||'회상 훈련'}<ArrowUpRight size={16}/></Link>) : b.type === 'support_target_ref' ? <div key={i}>{(data.learning?.support_targets||data.targets).filter((t:Item)=>t.id===b.support_target_id).map((t:Item)=><p key={t.id}>{[t.university,t.department,t.admission_type,t.admission_year&&`${t.admission_year}학년도`].filter(Boolean).join(' · ')}</p>)}</div> : b.type === 'heading' ? <h3 key={i}>{b.text}</h3> : b.type === 'answer_script_ref' ? <p key={i} className="body-copy">{data.learning?.answer_scripts?.find((s: Item) => s.id === b.answer_script_id)?.text}</p> : <p key={i} className="body-copy">{b.text || b.content || ''}</p>)}</>}
  </>}{href && !resource.snapshot && <Link href={href} className="button ghost full" onClick={onClose}>자료 페이지 열기<ArrowUpRight size={16}/></Link>}</div></aside></div>;
}

