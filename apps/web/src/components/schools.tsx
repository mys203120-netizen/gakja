'use client';
import Link from 'next/link';
import { useEffect,useState } from 'react';
import { useSearchParams,useRouter } from 'next/navigation';
import { ArrowRight,ArrowUpRight,Plus,BookOpen,Check,PencilLine,Trash2,CalendarDays } from 'lucide-react';
import { useApp } from './app-shell';
import { api,ActionButton,Breadcrumb,PageTitle,Alert,Spinner,Empty,Modal,targetName,targetMajor,type Item } from './shared';
import './schools.css';
import styles from './school-context.module.css';
import management from './school-management.module.css';
import { scheduleDateLabel } from '@/lib/schedule';
import { SchoolRegistration } from './school-registration';
import { SchoolLogo } from './school-logo';
import {visibleCalendarSourceUrl} from '@/lib/calendar-source-presentation';

export function SchoolPages({slug=[]}:{slug?:string[]}) {
  const {data,refresh,setTargetId}=useApp();const params=useSearchParams();const router=useRouter();
  const [catalog,setCatalog]=useState<Item[]>([]);const [targets,setTargets]=useState<Item[]>([]);const [error,setError]=useState('');const [loading,setLoading]=useState(true);
  const [deleting,setDeleting]=useState<Item|null>(null),[deleteBusy,setDeleteBusy]=useState(false),[deleteError,setDeleteError]=useState(''),[pendingTargetId,setPendingTargetId]=useState('');
  const isNew=slug[0]==='new',isEditing=slug[1]==='edit';const selected=targets.find(target=>target.id===slug[0]);
  async function load(){setLoading(true);setError('');try{const result=await api('/api/schools');setCatalog(result.catalog);setTargets(result.targets);}catch(err){setError((err as Error).message);}finally{setLoading(false);}}
  useEffect(()=>{void load();},[slug[0],isEditing]);
  useEffect(()=>{if(selected && data.targets.some(target=>target.id===selected.id))setTargetId(selected.id);},[selected?.id,data.targets.length]);
  useEffect(()=>{if(pendingTargetId&&data.targets.some(target=>target.id===pendingTargetId)){setTargetId(pendingTargetId);setPendingTargetId('');}},[pendingTargetId,data.targets]);
  async function saved(target:Item){setTargets(previous=>previous.some(item=>item.id===target.id)?previous.map(item=>item.id===target.id?target:item):[...previous,target]);setPendingTargetId(target.id);await refresh();}
  function requestDelete(target:Item){setDeleteError('');setDeleting(target);}
  async function confirmDelete(){
    if(!deleting||deleteBusy)return;
    setDeleteBusy(true);setDeleteError('');
    try{
      const result=await api('/api/schools',{method:'DELETE',body:JSON.stringify({targetId:deleting.id})});
      const removedId=deleting.id;setTargets(previous=>previous.filter(target=>target.id!==removedId));setPendingTargetId(result.selectedTargetId||'');setDeleting(null);
      await refresh();if(selected?.id===removedId)router.replace('/schools');
    }catch(err){setDeleteError((err as Error).message);}finally{setDeleteBusy(false);}
  }
  if(isNew)return <SchoolRegistration onboarding={params.get('onboarding')==='1'} catalog={catalog} registeredTargets={targets} loading={loading} error={error} onSaved={saved}/>;
  if(isEditing)return loading?<Spinner/>:selected?<SchoolRegistration key={selected.id} initialTarget={selected} registeredTargets={targets} onboarding={false} catalog={catalog} loading={false} error={error} onSaved={saved}/>:<Empty title="지원 학교를 찾을 수 없어요" href="/schools" label="지원 학교 보기"/>;
  return <div className="school-learning">
    <Breadcrumb items={[{label:'자료',href:'/knowledge'},{label:'지원 학교',href:selected?'/schools':undefined},...(selected?[{label:targetName(selected)}]:[])]}/>
    <PageTitle title={selected?targetName(selected):'지원 학교'} aside={targets.length>0?<Link className={`button ${slug.length?'ghost':'primary'}`} href="/schools/new"><Plus size={16}/>학교 추가</Link>:undefined}>{!selected&&!loading&&targets.length>0&&<p>등록한 {targets.length}개 지원처의 면접 일정을 한 캘린더에서 확인해요.</p>}</PageTitle>
    {error&&<Alert>{error}</Alert>}{loading?<Spinner/>:slug.length&&!selected?<Empty title="지원 학교를 찾을 수 없어요" href="/schools" label="지원 학교 보기"/>:selected?<><div className={management.overviewActions}><Link href={`/schools/${encodeURIComponent(selected.id)}/edit`}><PencilLine size={15}/>지원 정보 수정</Link><button type="button" onClick={()=>requestDelete(selected)}><Trash2 size={15}/>지원 학교 삭제</button></div><SchoolOverview target={selected}/></>:targets.length?<ul className={management.list} aria-label="등록한 지원 학교">{targets.map(target=><li key={target.id}>
      <Link className={management.identity} href={`/schools/${encodeURIComponent(target.id)}`}><SchoolLogo school={target} size={46}/><div><h2>{targetName(target)}</h2><p>{targetMajor(target)||'모집단위 미정'}</p><span>{[target.admission_year||target.year?`${target.admission_year||target.year}학년도`:null,target.admission_type||target.track||'전형 미정',target.campus&&target.campus!=='미정'?target.campus:null].filter(Boolean).join(' · ')}</span></div><ArrowUpRight size={17}/></Link>
      <span className={management.schedule}><CalendarDays size={15}/>{schoolScheduleLabel(target)}</span>
      <div className={management.rowActions}><Link href={`/schools/${encodeURIComponent(target.id)}/edit`} aria-label={`${targetName(target)} ${targetMajor(target)} 지원 정보 수정`}><PencilLine size={15}/>수정</Link><button type="button" aria-label={`${targetName(target)} ${targetMajor(target)} 지원 정보 삭제`} onClick={()=>requestDelete(target)}><Trash2 size={15}/>삭제</button></div>
    </li>)}</ul>:<Empty title="지원할 학교를 추가해 주세요" href="/schools/new" label="학교 추가">학교별 학과·전형과 면접 일정을 함께 등록할 수 있어요.</Empty>}
    {deleting&&<Modal title="지원 학교를 삭제할까요?" onClose={()=>{if(!deleteBusy)setDeleting(null);}}><div className={management.deleteIdentity}><SchoolLogo school={deleting} size={42}/><div><p>{targetName(deleting)}</p><span>{[targetMajor(deleting),deleting.admission_type||deleting.track].filter(Boolean).join(' · ')}</span></div></div><p className={management.deleteNote}>캘린더와 앞으로의 학습 추천에서 제외돼요.<br/>지금까지 남긴 답변과 리포트는 유지돼요.</p>{deleteError&&<Alert>{deleteError}</Alert>}<div className={management.deleteActions}><button type="button" className="button" data-autofocus disabled={deleteBusy} onClick={()=>setDeleting(null)}>취소</button><ActionButton type="button" className={`button ${management.deleteButton}`} pending={deleteBusy} pendingLabel="삭제 중" onClick={()=>void confirmDelete()}><Trash2 size={15}/>지원 학교 삭제</ActionButton></div></Modal>}
  </div>;
}
function schoolScheduleLabel(target:Item){const state=target.admission_calendar_registration?.status;return ({registered:'일정 연결됨',no_interview:'면접 미실시',date_pending:'날짜 미정',unpublished:'일정 미공개'} as Record<string,string>)[state]||'일정 확인 필요';}
function targetDetails(target:Item){return [target.admission_year||target.year?`${target.admission_year||target.year}학년도`:null,target.campus?`${target.campus}${target.campus==='미정'?' 캠퍼스':''}`:null,target.admission_type||target.track||'전형 미정',targetMajor(target)||'모집단위 미정'].filter(Boolean).join(' · ');}
function SchoolOverview({target}:{target:Item}){
  const profile=target.profile;const official=profile?.status==='official_confirmed';const blocks:Item[]=profile?.overview||[];const source=profile?.source||{};
  const weights=profile?.evaluation_weights;const weightRows=Array.isArray(weights)?weights:weights?.items||weights?.criteria||[];
  return <><div className={`school-overview-identity ${styles.schoolIdentity}`}><SchoolLogo school={target} size={56}/><div><p className="school-target-details">{targetDetails(target)}</p>{target.departmentVerification&&<p className="school-input-note">{target.departmentVerification.status==='public_2026'?<><a href={target.departmentVerification.sourceUrl} target="_blank" rel="noreferrer">교육부 2026 공시 확인</a> · {target.admission_year||target.year||'지원'}학년도 모집단위 {official?'공식 확인':'확인 전'}</>:target.departmentVerification.note}</p>}</div></div>
    <SchoolInterviewSummary target={target}/>
    <section className="school-first-practice"><div><strong>첫 질문부터 말해 볼까요?</strong><span>{official?'지원 전형에 맞춰 준비해요.':'생기부 없이 시작할 수 있어요.'}</span></div><Link className="button primary" href={`/interview/chat?questionId=common_motivation&targetId=${encodeURIComponent(target.id)}&questionCount=1&sourceType=common`}>공통 질문 연습<ArrowRight size={17}/></Link></section>
    <details className="school-overview school-overview-fold"><summary>면접 세부 안내와 평가 기준</summary><div className="section-heading"><span className="school-reference-state">{official?<><Check size={14}/>공식 확인</>:'제공 자료 기준 · 공식 확인 전'}</span></div>
      {profile?<><p className="school-reference-context">{profile.stale?'과거 지원처 안내 · 현재 지원 정보와 다름':profile.reviewed?'선택한 지원처의 안내':'대학 전체 참고자료 · 전형별 적용 확인 필요'}</p>
        {profile.stale&&<p className="school-practice-scope">{[profile.admission_year?`${profile.admission_year}학년도`:null,profile.campus,profile.admission_type,profile.department].filter(Boolean).join(' · ')} 기준 자료예요. 현재 지원 정보에 맞는 재확인이 필요해요.</p>}
        {blocks.length?blocks.map((block,index)=><div className="school-reference-block" key={index}><OverviewQuote text={block.text}/></div>):<ReviewedOverview profile={profile}/>}
        {!!weightRows.length&&<div className="school-evaluation"><h3>평가 요소</h3><p className="muted">질문 출제 비율과는 별개예요.</p>{weightRows.map((item:Item,index:number)=><div className="linked-row" key={index}><strong>{item.element||item.label||item.name||item.id}</strong><span>{item.weight??item.value??''}{Array.isArray(weights)||weights?.unit==='percent'?'%':weights?.unit==='points'?'점':''}</span></div>)}</div>}
        {(!official||!['document_individual','document','document_based'].includes(profile.format))&&<p className="school-practice-scope">현재 면접은 1인 질문·답변 연습이에요. 제시문·MMI·집단 과제·영상 제출은 해당 전형 방식의 재현 범위에 포함되지 않아요.</p>}
        {visibleCalendarSourceUrl(source.source_url)&&/^https?:\/\//.test(source.source_url)&&<a className="school-source-link" href={visibleCalendarSourceUrl(source.source_url)} target="_blank" rel="noreferrer"><BookOpen size={15}/>안내 출처<ArrowUpRight size={15}/></a>}
      </>:<p className="muted">등록된 면접 안내가 아직 없어요. 공통 질문으로 준비를 시작할 수 있어요.</p>}</details><SchoolTalent target={target}/></>;
}
function SchoolInterviewSummary({target}:{target:Item}){
  const [calendar,setCalendar]=useState<Item|null>(null),[calendarError,setCalendarError]=useState(false);
  useEffect(()=>{
    let alive=true;setCalendar(null);setCalendarError(false);
    api(`/api/planner?targetId=${encodeURIComponent(target.id)}`).then(result=>{if(alive)setCalendar(result);}).catch(()=>{if(alive)setCalendarError(true);});
    return()=>{alive=false;};
  },[target.id,target.admission_year,target.campus,target.department,target.major,target.admission_type]);
  const profile=target.profile,source=profile?.source||{},official=profile?.status==='official_confirmed'&&!profile?.stale;
  const labels:Item={document_individual:'서류 기반 개인 면접',document:'서류 기반 면접',document_based:'서류 기반 면접',presentation:'제시문·발표 면접',passage:'제시문 면접',mmi:'MMI',group:'집단 면접',video_submission:'영상 제출',unknown:'확인 필요',reference:'전형별 확인 필요',other:'별도 방식'};
  const range=(value:Item|number|null|undefined,unit:string)=>typeof value==='number'?`${value}${unit}`:value&&Number.isFinite(value.min)&&Number.isFinite(value.max)?`${value.min===value.max?value.min:`${value.min}–${value.max}`}${unit}`:'확인 필요';
  const coverage=calendar?.interviewScheduleCoverage?.targets?.find((item:Item)=>item.targetId===target.id);
  const schedules:Item[]=(calendar?.interviewSchedules||[]).filter((item:Item)=>item.targetId===target.id&&item.applicability==='track_match');
  const states:Item={no_interview:'면접 미실시',date_pending:'날짜 미정',unpublished:'일정 미공개',unverified:'전형·학과 확인 필요',needs_review:'날짜 확인 필요',not_listed:'면접 여부 확인 필요',source_missing:'면접 여부 확인 필요',year_mismatch:'지원 학년도 확인 필요',campus_mismatch:'캠퍼스·학과 확인 필요',available:'학교 참고 일정 · 전형 확인 필요'};
  const noInterview=coverage?.status==='no_interview'||official&&profile.interview_conducted===false;
  const scheduleState=noInterview?'면접 미실시':schedules.length?schedules.map(item=>item.startDate===item.endDate?scheduleDateLabel(item.startDate):`${scheduleDateLabel(item.startDate)}–${scheduleDateLabel(item.endDate)}`).join(' · '):calendarError?'일정 연결 확인 필요':calendar?states[coverage?.status]||'일정 확인 필요':'일정 확인 중';
  const scheduleSource=schedules[0]||null,sourceUrl=visibleCalendarSourceUrl(source.source_url||source.sourceUrl),checkedAt=source.checked_at||source.checkedAt;
  const scheduleUrl=[coverage?.decisionSourceUrl,scheduleSource?.sourceUrl,...(coverage?.officialSources||[]).map((item:Item)=>item.url)].map(visibleCalendarSourceUrl).find(Boolean);
  const scheduleCheckedAt=coverage?.decisionCheckedAt||scheduleSource?.checkedAt;
  return <section className={styles.schoolSummary} aria-labelledby="school-interview-summary-title"><div className={styles.summaryHeading}><h2 id="school-interview-summary-title">면접 한눈에 보기</h2><span>{official?'공식 확인':profile?.stale?'이전 지원 정보 기준':'제공 자료 기준 · 전형 확인 필요'}</span></div>
    <dl className={styles.summaryMetrics}><div><dt>방식</dt><dd>{noInterview?'면접 미실시':labels[profile?.format]||'전형별 확인 필요'}</dd></div><div><dt>시간</dt><dd>{noInterview?'해당 없음':range(profile?.interview_minutes,'분')}</dd></div><div><dt>면접관 · 지원자</dt><dd>{noInterview?'해당 없음':`${range(profile?.interviewer_count,'명')} · ${range(profile?.applicant_count,'명')}`}</dd></div></dl>
    <div className={styles.scheduleSummary}><span>면접 일정</span><div><p>{scheduleState}</p>{schedules.length>0&&!noInterview&&<small>{target.admission_year||target.year}학년도 · 개인 응시 시각은 입학처 발표 후 확인</small>}{scheduleUrl&&<a href={scheduleUrl} target="_blank" rel="noreferrer">{coverage?.decisionSourceLabel==='관리자'||scheduleSource?.sourceLabel==='관리자'?'관리자 참고 출처':'일정 출처'}<ArrowUpRight size={14}/>{scheduleCheckedAt&&<span>{scheduleCheckedAt.slice(0,10)} 확인</span>}</a>}</div></div>
    <div className={styles.summarySources}>{sourceUrl&&<a href={sourceUrl} target="_blank" rel="noreferrer"><BookOpen size={14}/>면접 안내 출처<ArrowUpRight size={14}/></a>}{checkedAt&&<span>{String(checkedAt).slice(0,10)} 확인</span>}{target.school_admission_url&&<a href={target.school_admission_url} target="_blank" rel="noreferrer">입학처<ArrowUpRight size={14}/></a>}</div>
  </section>;
}
function SchoolTalent({target}:{target:Item}){
  const talent=target.talentProfile,verified=talent?.status==='official_source';
  const profiles:Item[]=talent?.profiles?.length?talent.profiles:verified?[talent]:[];
  const kindLabel=(kind:string)=>kind==='education_goal'?'교육목표':kind==='core_competencies'?'핵심역량':'인재상';
  return <section className="school-talent" aria-labelledby="school-talent-title"><div className="section-heading"><h2 id="school-talent-title">학교가 지향하는 인재</h2></div><div className="section-body">
    {verified?<>{profiles.map(profile=><div className="school-talent-profile" key={profile.id}><div className="section-heading"><h3>{profile.title}</h3><span className="school-reference-state">{profile.scope==='department'?'학과':'대학 공통'} · {kindLabel(profile.definitionKind)}</span></div><ul className="school-talent-points">{(talent.points||[]).filter((point:Item)=>!point.profileId||point.profileId===profile.id).map((point:Item)=><li key={point.key||point.id}><div><h3>{point.label}</h3><p>{point.description}</p></div>{point.practiceQuestionId&&<Link className="text-link" href={'/my/today?'+new URLSearchParams({questionId:point.practiceQuestionId,targetId:target.id}).toString()}>이 주제로 준비하기<ArrowRight size={14}/></Link>}</li>)}</ul><a className="school-source-link" href={profile.source.url} target="_blank" rel="noreferrer">{profile.source.title}<ArrowUpRight size={14}/></a></div>)}<p className="school-talent-caption">공식 정의를 바탕으로 만든 연습 질문이에요.</p><Link className="text-link" href={'/knowledge?targetId='+encodeURIComponent(target.id)}>학교·학과 더 알아보기<ArrowRight size={14}/></Link></>:<><p className="muted">학교의 공식 정의를 확인하고 있어요.</p><Link className="text-link" href={'/my/today?'+new URLSearchParams({questionId:'common_talent_values',targetId:target.id}).toString()}>내 가치관 준비하기<ArrowRight size={14}/></Link></>}
  </div></section>;
}
function ReviewedOverview({profile}:{profile:Item}){const labels:Item={document_individual:'서류 기반 개인 면접',document:'서류 기반 면접',presentation:'제시문·발표 면접',passage:'제시문 면접',mmi:'MMI',group:'집단 면접',video_submission:'영상 제출',unknown:'확인 필요',other:'별도 방식'};const range=(value:any)=>typeof value==='number'?String(value):value.min===value.max?String(value.min):`${value.min}–${value.max}`;const rules=Array.isArray(profile.blind_rules)?profile.blind_rules:profile.blind_rules?[profile.blind_rules]:[];return <div className="school-reviewed-overview">{profile.format&&<p><strong>면접 방식</strong><span>{labels[profile.format]||profile.format}</span></p>}{profile.interview_conducted===false&&<p>면접을 실시하지 않는 전형으로 등록되어 있어요.</p>}{profile.preparation_minutes!=null&&<p><strong>준비 시간</strong><span>{range(profile.preparation_minutes)}분</span></p>}{profile.interview_minutes!=null&&<p><strong>면접 시간</strong><span>{range(profile.interview_minutes)}분</span></p>}{profile.interviewer_count&&<p><strong>면접관</strong><span>{range(profile.interviewer_count)}명</span></p>}{profile.applicant_count&&<p><strong>지원자</strong><span>{range(profile.applicant_count)}명</span></p>}{rules.map((rule:string,index:number)=><p key={index}>{rule}</p>)}{profile.notes&&<p>{profile.notes}</p>}</div>;}
function OverviewQuote({text}:{text:string}){
  const lines=text.split('\n').filter(line=>!/^1[.)]\s*면접 개요/.test(line));const pieces:React.ReactNode[]=[];
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    if(line.trim().startsWith('|')){const table:string[][]=[];while(index<lines.length&&lines[index].trim().startsWith('|')){const cells=lines[index].split('|').slice(1,-1).map(cell=>cell.trim());if(!cells.every(cell=>/^:?-+:?$/.test(cell)))table.push(cells);index++;}index--;pieces.push(<div className="school-table-wrap" key={index}><table><tbody>{table.map((cells,row)=><tr key={row}>{[...Array(Math.max(0,(table[0]?.length||0)-cells.length)).fill(''),...cells].map((cell,col)=>row===0?<th key={col} scope="col">{cell}</th>:<td key={col}>{cell}</td>)}</tr>)}</tbody></table></div>);}
    else if(/^\d[)]/.test(line))pieces.push(<h3 key={index}>{line}</h3>);
    else pieces.push(<p key={index}>{line}</p>);
  }return <div className="school-quote">{pieces}</div>;
}
