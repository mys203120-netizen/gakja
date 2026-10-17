'use client';
import Link from 'next/link';
import type {ComponentProps} from 'react';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Bookmark, Search, ArrowUpRight, MessagesSquare, Check, Save, ChevronRight, FileText, History, Flag, ListOrdered } from 'lucide-react';
import { useApp } from './app-shell';
import { action, PageTitle as BasePageTitle, Breadcrumb, Badge, Empty, Alert, LinkedRow, Modal, Spinner, api, post, type Item } from './shared';
import { DepartmentNews } from './department-news';
import styles from './learning-surfaces.module.css';
import { MaterialNavigation } from './material-navigation';
import { materialActivityEvaluation, materialContextHref, materialFactStatusLabel, materialInterviewHref, materialQuestionMatchesTarget, materialQuestionPracticeItems, materialQuizHref } from '@/lib/material-learning-flow';
function historyDate(value?:string){const date=value?new Date(value):null;return date&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(date):'저장한 답변';}
const tabs=[['','전체'],['activities','활동'],['questions','예상 질문'],['answers','답변 초안'],['guidebook','가이드북'],['handbook','암기 핸드북'],['briefings','시사 브리핑']];
function PageTitle(props:ComponentProps<typeof BasePageTitle>){return <><BasePageTitle {...props}/><MaterialNavigation/></>;}
export function Materials({slug=[]}:{slug?:string[]}){
  const{data}=useApp();const section=slug[0]||'';
  const breadcrumbs=section==='briefings'
    ?[{label:'자료',href:'/knowledge'},{label:'시사',href:slug[1]?'/materials/briefings':undefined},...(slug[1]?[{label:'기사'}]:[])]
    :[{label:'자료',href:'/knowledge'},{label:'내 교재',href:section?'/materials':undefined},...(section?[{label:tabs.find(t=>t[0]===section)?.[1]||'자료',href:slug[1]?`/materials/${section}`:undefined}]:[]),...(slug[1]?[{label:'상세'}]:[])];
  return <><Breadcrumb items={breadcrumbs}/>{section==='briefings'?(slug[1]==='news'?<DepartmentNews articleId={slug[2]}/>:slug[1]?<Briefings key={slug[1]} id={slug[1]}/>:<DepartmentNews/>):!data.package?<><PageTitle title="내 교재"/><Empty title="자료가 준비 중이에요" href="/interview" label="공통 질문 연습"/></>:section==='guidebook'||section==='handbook'?<BookReader key={section} kind={section}/>:section==='activities'?slug[1]?<ActivityDetail key={slug[1]} id={slug[1]}/>:<ActivityList/>:section==='questions'?slug[1]?<QuestionDetail key={slug[1]} id={slug[1]}/>:<QuestionList/>:section==='answers'?slug[1]?<AnswerEditor key={slug[1]} id={slug[1]}/>:<QuestionList answers/>:<MaterialsOverview/>}</>;
}

function MaterialsOverview(){
  const{data,targetId}=useApp();
  const questionIds=new Set(data.learning.questions.filter((question:Item)=>materialQuestionMatchesTarget(question,targetId)).map((question:Item)=>question.id));
  const representativeIds=data.learning.student_context?.representative_activity_ids||[];
  const representative=data.learning.activities.filter((activity:Item)=>{const evaluation=materialActivityEvaluation(activity,targetId);return evaluation.representativeCandidate!==undefined?evaluation.representativeCandidate:representativeIds.includes(activity.id);}).slice(0,3);
  return <>
    <PageTitle title="내 교재"/>

    <nav className={'materials-links '+styles.materialEntries} aria-label="내 교재 목록">
      {[{title:'활동',count:data.learning.activities.length,href:'activities',icon:Bookmark},{title:'예상 질문',count:questionIds.size,href:'questions',icon:MessagesSquare},{title:'답변 초안',count:new Set(data.answers.filter(a=>questionIds.has(a.question_id)&&(a.script?.trim()||a.structure?.trim())).map(a=>a.question_id)).size,href:'answers',icon:FileText}].map(c=><Link href={`/materials/${c.href}`} key={c.href}><c.icon size={19}/><span>{c.title}</span><strong>{c.count}</strong><ChevronRight size={16}/></Link>)}
    </nav>
    {!!representative.length&&<section className="detail-section"><div className="section-heading"><h2>대표 활동</h2><Link className="text-link" href="/materials/activities">전체 보기<ChevronRight size={15}/></Link></div>
      <div className="section-body">{representative.map((a:Item)=><LinkedRow key={a.id} href={`/materials/activities/${a.id}`} title={a.title} subtitle={`${a.grade}학년 · ${a.area}`}/>)}</div>
    </section>}
  </>;
}
function ActivityList(){
  const{data,targetId}=useApp();const[search,setSearch]=useState('');const[grade,setGrade]=useState('all');const[area,setArea]=useState('all');
  const activities:Item[]=data.learning.activities||[];
  const results=activities.filter(a=>(a.title+' '+a.activity_summary).includes(search)&&(grade==='all'||String(a.grade)===grade)&&(area==='all'||a.area===area));
  return <><PageTitle title="활동" aside={<span className="muted">{activities.length}개</span>}/>
    <div className="filter-bar"><div className="search-field"><Search size={18}/><input aria-label="활동 검색" placeholder="활동 검색" value={search} onChange={e=>setSearch(e.target.value)}/></div><select aria-label="학년" value={grade} onChange={e=>setGrade(e.target.value)}><option value="all">전체 학년</option>{[1,2,3].map(g=><option key={g} value={g}>{g}학년</option>)}</select><select aria-label="학생부 영역" value={area} onChange={e=>setArea(e.target.value)}><option value="all">전체 영역</option>{[...new Set(activities.map(a=>a.area))].map(a=><option key={a}>{a}</option>)}</select></div>
    <div className="activity-list">{results.map(a=>{const evaluation=materialActivityEvaluation(a,targetId);return <Link key={a.id} className="activity-row" href={`/materials/activities/${a.id}`}>
      <div className="activity-row-content"><h2>{a.title}</h2><p>{a.activity_summary}</p><div className="activity-row-meta"><span>{a.grade}학년 · {a.area}</span>{evaluation.priority&&<span>준비 우선도 {evaluation.priority}</span>}<span>{data.learning.questions.filter((q:Item)=>q.activity_ids?.includes(a.id)&&materialQuestionMatchesTarget(q,targetId)).length}개 연결 질문</span>{evaluation.talentTags.slice(0,3).map((t:any,i:number)=><span key={i}>#{typeof t==='string'?t:t.label||t.tag}</span>)}</div></div><ArrowUpRight size={20}/>
    </Link>;})}</div>{!results.length&&<Empty title="검색 결과가 없어요"/>}
  </>;
}
function ActivityDetail({ id }: { id: string }) {
  const { data, target, targetId, toast, refresh, openResource } = useApp();
  const a: Item = data.learning.activities.find((a: Item) => a.id === id);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('cannot_recall');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const requestId = useRef('');
  if (!a) return <Empty title="자료를 찾을 수 없어요" />;
  const sources: Item[] = data.learning.source_refs.filter((s: Item) => a.source_ref_ids?.includes(s.id));
  const linked: Item[] = data.learning.questions.filter((q: Item) => q.activity_ids?.includes(id) && materialQuestionMatchesTarget(q, targetId));
  const evaluation = materialActivityEvaluation(a, targetId);
  const evaluationSources: Item[] = data.learning.source_refs.filter((source: Item) => evaluation.sourceRefIds.includes(source.id));
  const experience = [['동기', a.motivation], ['내 역할', a.role], ['과정', a.process], ['결과', a.result], ['배운 점', a.lessons]].filter(([, value]) => typeof value === 'string' && value.trim());
  const practiceQuestion = linked.find(question => materialQuestionPracticeItems(question, data.learning.memory_items, targetId).length) || linked.find(question => ['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(question.verification_status));
  const quizItem = practiceQuestion && materialQuestionPracticeItems(practiceQuestion, data.learning.memory_items, targetId)[0];
  const status = typeof a.fact_confirmation === 'string' ? a.fact_confirmation : a.fact_confirmation?.status || a.verification_status;
  async function correction() {
    if (busy.current || !note.trim()) return;
    busy.current = true; setSaving(true); setError(''); requestId.current ||= crypto.randomUUID();
    try {
      await post('/api/learning', { action: 'confirmation_save', entityId: id, question: note.trim(), reason, requestId: requestId.current });
      setConfirm(false); setNote(''); requestId.current = ''; toast('사실 확인함에 남겼어요.'); await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { busy.current = false; setSaving(false); }
  }
  return <>
    <PageTitle title={a.title} aside={<button className="button ghost" onClick={() => { setConfirm(true); setError(''); }}><Flag size={16} />사실 확인</button>}><span>{a.grade}학년 · {a.area}</span></PageTitle>
    <div className="detail-grid"><div>
      <section className="panel detail-section"><div className="section-heading"><h2>활동 요약</h2><button className="text-link" onClick={async () => { try { await action('preparation_state', { entityId: id, stage: 'read', completed: true }); await refresh(); toast('읽기 상태를 저장했어요.'); } catch (err) { toast((err as Error).message); } }}>읽기 완료<Check size={14} /></button><Badge>{materialFactStatusLabel(status)}</Badge></div><div className="section-body"><p className="body-copy">{a.activity_summary}</p></div></section>
      {!!experience.length&&<section className="panel detail-section"><h2>경험의 흐름</h2><div className="section-body">{experience.map(([label,value])=><div key={label}><h3>{label}</h3><p className="body-copy">{value}</p></div>)}</div></section>}
      <section className="panel detail-section"><h2>학생부 원문</h2><div className="section-body source-body">{sources.length ? sources.map(s => <blockquote key={s.id}><p>{s.quote}</p><cite>{[s.area, s.page ? `${s.page}쪽` : s.type].filter(Boolean).join(' · ')}</cite><button className="text-link" onClick={() => openResource({ kind: 'source', id: s.id })}>근거 보기<ArrowUpRight size={15} /></button></blockquote>) : <p className="muted">연결된 원문이 없어요.</p>}</div></section>
      <section className="panel detail-section"><h2>연결 질문</h2><div className="section-body">{linked.length?linked.map(q => <LinkedRow href={`/materials/questions/${q.id}`} key={q.id} title={q.prompt} subtitle={q.question_intent} />):<p className="muted">이 지원처에 연결된 질문이 없어요.</p>}</div></section>
    </div><aside>
      <section className="panel detail-section accent-panel"><h2>활동 평가</h2><div className="section-body">{target&&<p className="muted">{target.university} · {target.department}</p>}{evaluation.priority&&<div className="priority-meta"><span>준비 우선도</span><Badge>{evaluation.priority}</Badge></div>}<p>{evaluation.reason || '선택한 지원처의 활동 평가가 아직 없어요.'}</p>{evaluation.talentTags.length>0&&<div className="tag-list">{evaluation.talentTags.map((tag:any,i:number)=><span key={i}>#{typeof tag==='string'?tag:tag.label||tag.tag}</span>)}</div>}{evaluation.majorRelevance&&<><h3>전공과의 연결</h3><p className="body-copy">{evaluation.majorRelevance}</p></>}{evaluation.representativeCandidate&&<><h3>대표 활동 후보</h3>{evaluation.representativeReason&&<p className="body-copy">{evaluation.representativeReason}</p>}</>}{evaluationSources.length>0&&<details><summary>평가 근거</summary>{evaluationSources.map(source=><div key={source.id}><p className="body-copy">{source.quote}</p><button className="text-link" onClick={()=>openResource({kind:'source',id:source.id})}>근거 보기<ArrowUpRight size={15}/></button></div>)}</details>}</div></section>
      <section className="panel detail-section"><h2>이 경험으로</h2><div className="section-body"><Link className="button primary full" href={materialContextHref('/on',{activityId:a.id,targetId,sourceVersion:data.package?.active_version})}><MessagesSquare size={17} />각자ON에서 정리</Link>{quizItem&&<Link className="button ghost full" href={materialQuizHref(quizItem,targetId,undefined,data.package?.active_version)}>연결 퀴즈 풀기</Link>}{practiceQuestion&&<Link className="button ghost full" href={materialInterviewHref(practiceQuestion.id,{targetId,sourceVersion:data.package?.active_version})}>연결 질문 면접 연습</Link>}</div></section>
    </aside></div>
    {confirm && <Modal title="사실 확인" onClose={() => { if (!saving) setConfirm(false); }}>
      {error && <Alert>{error}</Alert>}
      <label>확인할 이유<select disabled={saving} value={reason} onChange={e => { setReason(e.target.value); requestId.current = ''; }}><option value="cannot_recall">기억 안 남</option><option value="record_differs">기록과 다름</option><option value="role_check">내 역할 확인</option></select></label>
      <label>확인할 내용<textarea disabled={saving} placeholder="본인이 한 역할이나 확인할 내용을 적어주세요." value={note} maxLength={2000} onChange={e => { setNote(e.target.value); requestId.current = ''; }} /></label>
      <button disabled={saving || !note.trim()} className="button primary" onClick={correction}>{saving ? '저장 중' : '사실 확인함에 남기기'}</button>
    </Modal>}
  </>;
}
function QuestionList({answers=false}:{answers?:boolean}){const{data,targetId}=useApp();const[search,setSearch]=useState('');const[type,setType]=useState('all');const questions:Item[]=data.learning.questions.filter((question:Item)=>materialQuestionMatchesTarget(question,targetId));const results=questions.filter(q=>q.prompt.includes(search)&&(type==='all'||q.question_types?.includes(type)));return <><PageTitle title={answers?'답변 초안':'예상 질문'} aside={<span className="muted">{questions.length}개</span>}/><div className="filter-bar"><div className="search-field"><Search size={18}/><input aria-label="질문 검색" placeholder="질문 검색" value={search} onChange={e=>setSearch(e.target.value)}/></div><select value={type} aria-label="질문 유형" onChange={e=>setType(e.target.value)}><option value="all">전체 질문</option><option value="activity">활동 질문</option><option value="major">전공 질문</option><option value="values">가치관 질문</option><option value="common">공통 질문</option></select></div><div className="panel question-list">{results.map((q,i)=>{const written=data.answers.find(a=>a.question_id===q.id);return <Link className="question-row" href={`/materials/${answers?'answers':'questions'}/${q.id}`} key={q.id}><span className="question-index">Q{String(i+1).padStart(2,'0')}</span><div><strong>{q.prompt}</strong><p>{q.question_intent}</p></div>{written?.script?<Badge tone="green">작성됨</Badge>:answers?<span className="muted">미작성</span>:null}<ChevronRight size={19}/></Link>;})}</div>{!results.length&&<Empty title="검색 결과가 없어요"/>}</>;}
function QuestionDetail({id}:{id:string}) {
  const {data,targetId,openResource}=useApp();
  const q:Item=data.learning.questions.find((q:Item)=>q.id===id);
  if(!q)return <Empty title="질문을 찾을 수 없어요"/>;
  const script=data.learning.answer_scripts.find((s:Item)=>s.question_id===id);
  const quizItems=materialQuestionPracticeItems(q,data.learning.memory_items,targetId);
  const practiceAvailable=materialQuestionMatchesTarget(q,targetId)&&['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(q.verification_status);
  return <>
    <PageTitle title={q.prompt} questionId={q.id} aside={<button className="button ghost" onClick={()=>openResource({kind:'question',id})}>근거 보기<ArrowUpRight size={16}/></button>}/>
    <div className="detail-grid"><div>
      <section className="panel detail-section"><h2>질문의 의도</h2><div className="section-body"><p className="body-copy">{q.question_intent}</p></div></section>
      <section className="panel detail-section"><h2>답변 설계</h2><div className="section-body"><div className="answer-structure">{(q.answer_structure||q.answer_elements||[]).map((s:any,i:number)=><div key={i}><span>0{i+1}</span><strong>{typeof s==='string'?s:s.label||s.title}</strong>{i<(q.answer_structure||q.answer_elements||[]).length-1&&<ChevronRight size={16}/>}</div>)}</div>{script&&<><h3>교재 답변 예시</h3><p className="body-copy">{script.text||script.script||script.sentences?.map((s:Item)=>s.text).join(' ')}</p></>}</div></section>
      <section className="panel detail-section"><h2>이 답의 재료</h2><div className="section-body">{(q.activity_ids||[]).map((id:string)=>{const a=data.learning.activities.find((a:Item)=>a.id===id);return a?<LinkedRow key={id} href={`/materials/activities/${id}`} title={a.title} subtitle={a.activity_summary}/>:null;})}</div></section>
      {!!quizItems.length&&<section className="panel detail-section"><h2>연결 퀴즈</h2><div className="section-body">{quizItems.map(item=><LinkedRow key={item.id} href={materialQuizHref(item,targetId,undefined,data.package?.active_version)} title={item.prompt} subtitle={item.kind==='choice'?'10초 퀴즈':'Q&A · 답변 녹음'}/>)}</div></section>}
      {q.followup_question_ids?.length>0&&<section className="panel detail-section"><h2>꼬리질문</h2><div className="section-body">{q.followup_question_ids.map((id:string)=>{const f=data.learning.questions.find((x:Item)=>x.id===id);return f?<LinkedRow key={id} title={f.prompt} href={`/materials/questions/${id}`}/>:null;})}</div></section>}
    </div><aside>
      <section className="panel detail-section"><h2>답변 준비</h2><div className="section-body"><Link className="button primary full" href={`/materials/answers/${id}`}>답변 초안 작성</Link><Link className="button ghost full" href={materialContextHref('/on',{questionId:id,targetId,sourceVersion:data.package?.active_version})}><MessagesSquare size={16}/>각자ON에서 답변 설계</Link>{practiceAvailable?<Link className="button ghost full" href={materialInterviewHref(id,{targetId,sourceVersion:data.package?.active_version})}>이 질문 면접 연습</Link>:<p className="muted">선택한 지원처와 질문의 확인 상태를 확인해 주세요.</p>}<Link className="text-link" href={materialContextHref('/records/comparisons',{questionId:id,targetId,sourceVersion:data.package?.active_version})}>내 답변의 변화<ArrowUpRight size={16}/></Link></div></section>
    </aside></div>
  </>;
}
function AnswerEditor({id}:{id:string}){const{data,targetId,refresh,toast,openResource}=useApp();const q=data.learning.questions.find((q:Item)=>q.id===id);const old=data.answers.find(a=>a.question_id===id);const[structure,setStructure]=useState(old?.structure||'');const[script,setScript]=useState(old?.script||'');const[revision,setRevision]=useState(old?.revision||0);const[saved,setSaved]=useState('');const[error,setError]=useState('');const[history,setHistory]=useState(false);const[versions,setVersions]=useState<Item[]>([]);const[comments,setComments]=useState<Item[]>([]);const first=useRef(true);const busy=useRef(false);const revisionRef=useRef(revision);revisionRef.current=revision;const values=useRef({structure,script});values.current={structure,script};async function save(){if(busy.current)return;const snapshot={...values.current};if(snapshot.script===lastSaved.current.script&&snapshot.structure===lastSaved.current.structure){setSaved('저장됨');setError('');sessionStorage.removeItem(draftKey);return;}busy.current=true;let failed=false;setSaved('저장 중');try{const result=await action('save_answer',{questionId:id,structure:snapshot.structure,script:snapshot.script,expectedRevision:revisionRef.current});revisionRef.current=result.answer?.revision||result.revision||revisionRef.current+1;setRevision(revisionRef.current);lastSaved.current=snapshot;if(snapshot.script===values.current.script&&snapshot.structure===values.current.structure)sessionStorage.removeItem(draftKey);setSaved('저장됨');setError('');await refresh();}catch(err){failed=true;setError((err as Error).message);setSaved('저장 실패');}finally{busy.current=false;if(!failed&&(snapshot.script!==values.current.script||snapshot.structure!==values.current.structure))setTimeout(save,250);}}async function openHistory(){setHistory(true);try{const result=await api(`/api/actions?questionId=${id}`);setVersions(result.versions||[]);setComments(result.comments||[]);}catch(e){setError((e as Error).message);}}const lastSaved=useRef({structure:old?.structure||'',script:old?.script||''});const draftKey=`gakja-draft:${data.user.id}:${id}`;useEffect(()=>{const saved=sessionStorage.getItem(draftKey);if(saved){try{const draft=JSON.parse(saved);if(draft.baseRevision===revisionRef.current){setStructure(draft.structure);setScript(draft.script);setSaved('이 기기의 초안');}}catch{}}return()=>{const v=values.current;if(v.script!==lastSaved.current.script||v.structure!==lastSaved.current.structure){sessionStorage.setItem(draftKey,JSON.stringify({...v,baseRevision:revisionRef.current}));fetch('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify({action:'save_answer',payload:{questionId:id,...v,expectedRevision:revisionRef.current}})}).catch(()=>{});}};},[]);useEffect(()=>{sessionStorage.setItem(draftKey,JSON.stringify({...values.current,baseRevision:revisionRef.current}));},[structure,script]);useEffect(()=>{if(first.current){first.current=false;return;}setSaved('작성 중');const timer=setTimeout(save,1400);return()=>clearTimeout(timer);},[structure,script]);if(!q)return <Empty title="질문을 찾을 수 없어요"/>;return <><PageTitle title="답변 초안" aside={<div className="inline-actions"><Badge tone={saved==='저장됨'?'green':'neutral'}>{saved||'자동 저장'}</Badge><button className="button ghost" onClick={openHistory}><History size={16}/>이력</button><button className="button primary" onClick={save}><Save size={16}/>저장</button></div>}/><div className="question-banner"><h2 data-question-key={q.id}>{q.prompt}</h2><button className="text-link" onClick={()=>openResource({kind:'question',id})}>근거 보기<ArrowUpRight size={16}/></button></div>{error&&<Alert>{error}</Alert>}<div className="editor-grid"><section className="panel detail-section"><div className="section-heading"><h2 id="answer-structure-heading">답변 설계</h2><ListOrdered size={19}/></div><div className="tag-list">{q.answer_elements?.map((e:string)=><span key={e}>{e}</span>)}</div><textarea aria-labelledby="answer-structure-heading" className="structure-textarea" placeholder="어떤 경험을, 어떤 순서로 말할까요?" value={structure} onChange={e=>setStructure(e.target.value)}/></section><section className="panel detail-section"><div className="section-heading"><h2 id="answer-script-heading">답변 초안</h2><span className="muted">{script.length}자</span></div><textarea aria-labelledby="answer-script-heading" className="script-textarea" placeholder="실제로 한 경험을 내 말로 적어보세요." value={script} onChange={e=>setScript(e.target.value)}/><div className="editor-foot"><Link href={materialContextHref('/on',{questionId:id,targetId,sourceVersion:data.package?.active_version})}>각자ON에서 다듬기<ArrowUpRight size={15}/></Link></div></section></div><div className="learning-inline-links"><button className="text-link" onClick={()=>openResource({kind:'question',id})}>질문과 근거<ArrowUpRight size={16}/></button><Link className="text-link" href={materialContextHref('/records/comparisons',{questionId:id,targetId,sourceVersion:data.package?.active_version})}>답변 비교<ArrowUpRight size={16}/></Link></div>{history&&<Modal title="답변 이력" onClose={()=>setHistory(false)}>{versions.length?versions.map((a:Item)=><div className="history-version" key={a.id}><time>{historyDate(a.created_at||a.updated_at)}</time><p>{a.script}</p></div>):<p className="muted">아직 저장한 이력이 없어요.</p>}{comments.map(c=><div className="history-version" key={c.id}><strong>{c.author_name}의 의견</strong><time>{historyDate(c.created_at)}</time><p>{c.content}</p></div>)}</Modal>}</>;}
function BookReader({kind}:{kind:string}){
  const{data,toast}=useApp();
  const doc=data.documents.find(document=>document.kind===kind||(kind==='handbook'&&document.kind==='memory_handbook'));
  const[sectionId,setSectionId]=useState('');
  const[original,setOriginal]=useState<Item|null>(null),[showOriginal,setShowOriginal]=useState(false),[originalLoading,setOriginalLoading]=useState(false),[originalError,setOriginalError]=useState('');
  const sections:Item[]=doc?.sections||[];
  const flat:Item[]=sections.flatMap(section=>[section,...(section.children||section.sections||[])]);
  const section=flat.find(section=>section.id===sectionId)||flat[0];
  const blocks=(doc?.blocks||[]).filter((block:Item)=>block.section_id===section?.id);
  useEffect(()=>{
    if(!doc||flat.some(section=>section.id===sectionId))return;
    const saved=data.readingProgress?.find((progress:Item)=>progress.document_kind===doc.kind)?.section_id;
    const validSaved=flat.some(section=>section.id===saved)?saved:null;
    setSectionId(validSaved||sections[0]?.children?.[0]?.id||sections[0]?.id||'');
  },[doc,sectionId]);
  useEffect(()=>{
    if(!doc||!sectionId||!flat.some(section=>section.id===sectionId))return;
    const timer=setTimeout(()=>action('mark_read',{documentKind:doc.kind,sectionId}).catch(()=>{}),500);
    return()=>clearTimeout(timer);
  },[doc?.id,sectionId]);
  async function viewOriginal(){
    if(!doc||originalLoading)return;
    setShowOriginal(true);setOriginalError('');
    if(original?.id===doc.id&&original?.content_version===doc.content_version)return;
    setOriginalLoading(true);setOriginal(null);
    try{const result=await api('/api/documents?'+new URLSearchParams({kind:doc.kind,contentVersion:String(doc.content_version||data.package?.active_version)}).toString());if(typeof result.document?.html!=='string')throw new Error('교재 원본을 찾을 수 없어요.');setOriginal(result.document);}
    catch(error){setOriginalError((error as Error).message);}
    finally{setOriginalLoading(false);}
  }
  if(!doc)return <Empty title="발행된 책이 없어요"/>;
  return <>
    <PageTitle title={kind==='guidebook'?'가이드북':'암기 핸드북'} aside={kind==='guidebook'?<button className="button ghost" disabled={originalLoading} onClick={viewOriginal}><FileText size={16}/>교재 원본 보기</button>:undefined}/>
    <label className="reader-section-select">목차<select aria-label="읽을 절" value={section?.id||''} onChange={event=>setSectionId(event.target.value)}>{sections.map(section=><optgroup key={section.id} label={section.title}><option value={section.id}>{section.title}</option>{(section.children||section.sections||[]).map((child:Item)=><option key={child.id} value={child.id}>{child.title}</option>)}</optgroup>)}</select></label>
    <div className="reader-layout"><aside className="reader-toc"><div className="toc-heading"><BookOpen size={18}/>목차</div>{sections.map(section=><div key={section.id} className="toc-chapter"><button className={sectionId===section.id?'active':''} onClick={()=>setSectionId(section.id)}>{section.title}</button>{(section.children||section.sections||[]).map((child:Item)=><button key={child.id} className={sectionId===child.id?'active child':'child'} onClick={()=>setSectionId(child.id)}>{child.title}</button>)}</div>)}</aside>
      <article className="panel reader-article"><div className="reader-article-top"><button className="icon-button" aria-label="현재 위치 저장" title="현재 위치 저장" onClick={async()=>{try{await action('mark_read',{documentKind:doc.kind,sectionId:section?.id});toast('읽은 위치를 저장했어요.');}catch(error){toast((error as Error).message);}}}><Bookmark size={18}/></button></div><h2>{section?.title}</h2>
        {blocks.length?blocks.map((block:Item,index:number)=><BookBlock key={block.id||index} block={block}/>):<div className="chapter-links">{(section?.children||[]).map((child:Item)=><button key={child.id} onClick={()=>setSectionId(child.id)}>{child.title}<ChevronRight size={17}/></button>)}{!section?.children?.length&&<p className="muted">이 절에 연결된 자료가 없습니다.</p>}</div>}
        <div className="reader-next">{flat.indexOf(section)<flat.length-1&&<button className="button ghost" onClick={()=>setSectionId(flat[flat.indexOf(section)+1].id)}>다음 절<ChevronRight size={16}/></button>}</div>
      </article>
    </div>
    {showOriginal&&<Modal title="가이드북 원본" onClose={()=>setShowOriginal(false)}>{originalLoading?<Spinner/>:originalError?<Alert>{originalError}</Alert>:original&&<iframe title="최종 승인 가이드북" srcDoc={original.html} sandbox="" referrerPolicy="no-referrer" style={{width:'100%',height:'65vh',border:0,background:'#fff'}}/>}</Modal>}
  </>;
}
function BookBlock({block:b}:{block:Item}){
  const{data,targetId,openResource}=useApp();
  if(b.type==='activity_ref'){
    const activity=data.learning.activities.find((activity:Item)=>activity.id===b.activity_id);
    return activity?<LinkedRow href={`/materials/activities/${activity.id}`} title={activity.title} subtitle={activity.activity_summary}/>:null;
  }
  if(b.type==='question_ref'){
    const question=data.learning.questions.find((question:Item)=>question.id===b.question_id);
    return question?<LinkedRow href={`/materials/questions/${question.id}`} title={question.prompt} subtitle={question.question_intent}/>:null;
  }
  if(b.type==='memory_item_ref'||b.type==='memory_ref'){
    const memory=data.learning.memory_items.find((memory:Item)=>memory.id===b.memory_item_id);
    const question=memory&&data.learning.questions.find((question:Item)=>question.id===memory.question_id);
    const available=question&&materialQuestionPracticeItems(question,data.learning.memory_items,targetId).some(item=>item.id===memory.id);
    return memory?(available?<LinkedRow href={materialQuizHref(memory,targetId,undefined,data.package?.active_version)} title={memory.prompt} subtitle={memory.kind==='choice'?'10초 퀴즈':'내 말로 답하기'}/>:<p className="body-copy">{memory.prompt}</p>):null;
  }
  if(b.type==='answer_script_ref'){
    const script=data.learning.answer_scripts.find((script:Item)=>script.id===b.answer_script_id);
    return script?<><blockquote>{script.text||script.script}</blockquote><Link className="text-link" href={`/materials/questions/${script.question_id}`}>질문·연결 퀴즈 보기<ArrowUpRight size={15}/></Link></>:null;
  }
  if(b.type==='support_target_ref'){
    const target=data.targets.find(target=>target.id===b.support_target_id);
    return target?<div className="detail-section"><h3>{target.university} · {target.department}</h3><p>{target.admission_type} · {target.admission_year}학년도</p></div>:null;
  }
  if(b.type==='source_ref'){
    const source=data.learning.source_refs.find((source:Item)=>source.id===b.source_ref_id);
    return source?<blockquote><p>{source.quote}</p><cite>{source.area} · {source.page?`${source.page}쪽`:source.type}</cite><button className="text-link" onClick={()=>openResource({kind:'source',id:source.id})}>근거 보기<ArrowUpRight size={15}/></button></blockquote>:null;
  }
  if(b.type==='heading')return <h3>{b.text}</h3>;
  return <p className="body-copy">{b.text||b.content||''}</p>;
}
function briefingText(value: any): string { return typeof value === 'string' ? value : value?.text || value?.fact || value?.viewpoint || value?.prompt || value?.definition || ''; }
function safeBriefingURL(value: unknown) { if (typeof value !== 'string') return null; try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function briefingDate(value?: string) { if (!value || !Number.isFinite(new Date(value).getTime())) return ''; return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value.length === 10 ? value + 'T00:00:00+09:00' : value)); }
function Briefings({ id }: { id?: string }) {
  const { data, refresh, openResource } = useApp();
  const briefings: Item[] = data.briefings || [];
  const b = briefings.find(b => b.id === id);
  const stored: Item | undefined = data.briefingThoughts?.find((t: Item) => t.briefing_id === id) || data.preferences?.briefingThoughts?.[id || ''];
  const [thought, setThought] = useState(stored?.content || '');
  const [revision, setRevision] = useState(stored?.revision || 0);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const draftKey = `gakja-briefing-thought:${data.user.id}:${id || 'all'}`;
  const [thoughtLoading, setThoughtLoading] = useState(!!id);
  const [thoughtVersions, setThoughtVersions] = useState<Item[]>([]);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    if (!id) return;
    let active = true; const controller = new AbortController(); setThoughtLoading(true);
    api(`/api/actions?briefingId=${encodeURIComponent(id)}`, { signal: controller.signal }).then(result => {
      if (!active) return;
      const current = result.thought; const base = current?.revision || 0;
      let content = current?.content || '';
      try { const draft = sessionStorage.getItem(draftKey); if (draft) { const parsed = JSON.parse(draft); if (parsed.revision === base) { content = parsed.content; setSaved('이 기기의 초안'); } } } catch {}
      setThought(content); setRevision(base); setThoughtVersions(result.versions || []);
    }).catch(err => { if (active) setError((err as Error).message); }).finally(() => { if (active) setThoughtLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [id, draftKey]);
  function writeThought(content: string) { setThought(content); setSaved('작성 중'); sessionStorage.setItem(draftKey, JSON.stringify({ content, revision })); }
  async function saveThought() {
    if (busy.current || !b || !thought.trim()) return;
    busy.current = true; setSaving(true); setError('');
    try { const result = await action('briefing_thought', { briefingId: b.id, content: thought.trim(), expectedRevision: revision }); setRevision(result.thought?.revision || revision + 1); setSaved('저장됨'); sessionStorage.removeItem(draftKey); try { const latest = await api(`/api/actions?briefingId=${encodeURIComponent(b.id)}`); setThoughtVersions(latest.versions || []); await refresh(); } catch { setError('생각은 저장했어요. 이력은 잠시 후 다시 확인해 주세요.'); } }
    catch (err) { setError((err as Error).message); setSaved('저장 실패'); }
    finally { busy.current = false; setSaving(false); }
  }
  if (id && !b) return <Empty title="브리핑을 찾을 수 없어요" href="/materials/briefings" label="브리핑 목록" />;
  if (!b) return <div className="learning-v2"><PageTitle title="시사 브리핑" />{briefings.length ? <div className="briefing-library">{briefings.map(item => <LinkedRow href={`/materials/briefings/${item.id}`} key={item.id} title={item.title} subtitle={item.data?.summary || item.summary} end={<span className="row-action">{briefingDate(item.data?.published_date || item.published_at)}<ArrowUpRight size={18} /></span>} />)}</div> : <Empty title="아직 발행된 브리핑이 없어요" />}</div>;
  const value = b.data || {};
  const facts: any[] = Array.isArray(value.facts || b.facts) ? value.facts || b.facts : [];
  const viewpoints: any[] = Array.isArray(value.viewpoints) ? value.viewpoints : [];
  const concepts: any[] = Array.isArray(value.concepts) ? value.concepts : [];
  const questions: any[] = Array.isArray(value.questions) && value.questions.length ? value.questions : [b.question || value.discussion_question || value.question].filter(Boolean);
  const primaryURL = safeBriefingURL(value.source_url);
  const sources: any[] = Array.isArray(value.sources || b.sources) ? [...(value.sources || b.sources)] : [];
  if (primaryURL && !sources.some(s => safeBriefingURL(typeof s === 'string' ? s : s.url) === primaryURL)) sources.unshift({ id: 'primary', title: '원문 보기', url: primaryURL });
  const dates = [['발행일', value.published_date], ['사건일', value.event_date], ['확인일', value.checked_at]].filter(([, date]) => !!date);
  return <div className="learning-v2 briefing-detail">
    <PageTitle title={b.title} aside={<button className="button ghost" onClick={() => openResource({ kind: 'briefing', id: b.id })}>자료 패널<ArrowUpRight size={16} /></button>} />
    <div className="briefing-provenance">{value.source_kind === 'synthetic_test_briefing' && <Badge>테스트 자료</Badge>}{dates.map(([label, date]) => <span key={label}>{label} {briefingDate(date)}</span>)}{!value.published_date && b.published_at && <span>브리핑 발행 {briefingDate(b.published_at)}</span>}</div>
    {(value.summary || b.summary) && <p className="body-copy briefing-lead">{value.summary || b.summary}</p>}
    {facts.length > 0 && <section className="briefing-reading-section"><h2>핵심 사실</h2><ol className="briefing-facts">{facts.slice(0, 3).map((fact, index) => <li key={fact.id || index}><p>{briefingText(fact)}</p>{typeof fact === 'object' && fact.quote && <blockquote>{fact.quote}</blockquote>}{typeof fact === 'object' && safeBriefingURL(fact.source_url || fact.url) && <a className="text-link" href={safeBriefingURL(fact.source_url || fact.url)!} rel="noopener noreferrer" target="_blank">근거 원문<ArrowUpRight size={14} /></a>}</li>)}</ol></section>}
    {concepts.length > 0 && <section className="briefing-reading-section"><h2>연결되는 개념</h2><div className="section-body">{concepts.map((concept, index) => <div className="briefing-concept" key={concept.id || index}>{typeof concept === 'string' ? <p>{concept}</p> : <><h3>{concept.concept || concept.name || concept.title}</h3><p>{concept.definition || concept.text}</p></>}</div>)}</div></section>}
    {value.major_connection && <section className="briefing-reading-section"><h2>전공과의 연결</h2><div className="section-body"><p className="body-copy">{value.major_connection}</p></div></section>}
    {viewpoints.length > 0 && <section className="briefing-reading-section"><h2>서로 다른 관점</h2><div className="section-body">{viewpoints.map((view, index) => <div className="briefing-viewpoint" key={view.id || index}>{typeof view === 'object' && (view.stakeholder || view.title) && <h3>{view.stakeholder || view.title}</h3>}<p className="body-copy">{briefingText(view)}</p>{typeof view === 'object' && view.quote && <blockquote>{view.quote}</blockquote>}</div>)}</div></section>}
    {questions.length > 0 && <section className="briefing-reading-section"><h2>생각해볼 질문</h2><div className="section-body">{questions.slice(0, 2).map((question, index) => {
      const approved = typeof question === 'object' && data.learning.questions?.find((q: Item) => q.id === (question.question_id || question.id));
      return <div className="briefing-question" key={question.id || index}><h3>{briefingText(question)}</h3><Link className="text-link" href={approved ? `/interview/new?questionId=${approved.id}` : `/interview/new?briefingId=${b.id}&briefingQuestionIndex=${index}`}>이 질문 연습<ArrowUpRight size={16} /></Link></div>;
    })}</div></section>}
    {sources.length > 0 && <section className="briefing-reading-section"><h2>원문과 출처</h2><div className="section-body">{sources.map((source, index) => { const url = safeBriefingURL(typeof source === 'string' ? source : source.url); return url ? <a className="briefing-source-row" key={source.id || index} href={url} rel="noopener noreferrer" target="_blank"><span><strong>{source.title || source.name || new URL(url).hostname}</strong>{(source.published_date || source.checked_at) && <small>{source.published_date && '발행 ' + briefingDate(source.published_date)}{source.checked_at && ' · 확인 ' + briefingDate(source.checked_at)}</small>}</span><ArrowUpRight size={18} /></a> : null; })}</div></section>}
    <section className="briefing-reading-section briefing-thought"><div className="section-heading"><h2>내 생각</h2><span className="muted">{thoughtLoading ? '불러오는 중' : saved || (revision ? '저장된 생각' : '')}</span></div><div className="section-body">{error && <Alert>{error}</Alert>}<textarea aria-label="브리핑에 대한 내 생각" disabled={saving || thoughtLoading} value={thought} maxLength={8000} onChange={e => writeThought(e.target.value)} placeholder="나의 관점과 그 이유를 적어주세요." /><div className="learning-inline-links"><button className="button primary" disabled={saving || thoughtLoading || !thought.trim()} onClick={saveThought}>{saving ? '저장 중' : '내 생각 저장'}<Save size={16} /></button><button className="button ghost" disabled={!thoughtVersions.length} onClick={() => setHistory(true)}><History size={16} />이력</button><Link className="text-link" href={`/on?briefingId=${b.id}`}>각자ON에서 정리<ArrowUpRight size={16} /></Link></div></div></section>
    {history && <Modal title="내 생각 이력" onClose={() => setHistory(false)}>{thoughtVersions.map(version => <div className="history-version" key={version.id}><time>{historyDate(version.created_at)}</time><p>{version.content}</p></div>)}</Modal>}
  </div>;
}


