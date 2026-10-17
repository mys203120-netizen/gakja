'use client';
import Link from 'next/link';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,ArrowLeft,ArrowUpRight,CalendarDays,Check,BookOpen,ChevronRight,Search,X,GraduationCap,MessageCircle,Plus} from 'lucide-react';
import {SchoolPicker} from './school-picker';
import {SchoolLogo} from './school-logo';
import {api,post,ActionButton,Breadcrumb,Alert,Spinner,Logo,type Item} from './shared';
import {scheduleDateLabel} from '@/lib/schedule';
import type {SchoolCalendarPreview} from '@/lib/school-onboarding-calendar-model';
import {visibleCalendarSourceUrl,visibleCalendarSourceLabel,visibleCalendarSourceText} from '@/lib/calendar-source-presentation';
import styles from './school-registration.module.css';

type Props={catalog:Item[];loading:boolean;error:string;onSaved:(target:Item)=>Promise<void>;onboarding:boolean;initialTarget?:Item;registeredTargets?:Item[]};
const stepLabels=['학교 선택','학과·전형','일정 등록'];
const dateRange=(item:SchoolCalendarPreview['matched'][number])=>item.startDate===item.endDate?scheduleDateLabel(item.startDate):`${scheduleDateLabel(item.startDate)}–${scheduleDateLabel(item.endDate)}`;

export function SchoolRegistration({catalog,loading,error,onSaved,onboarding,initialTarget,registeredTargets=[]}:Props){
  // The parent mounts the editor only once its target has loaded. Refreshes must not overwrite edits.
  const initial=useRef(initialTarget).current,editing=Boolean(initial);
  const initialReference=initial?.school_reference_id||'',initialDepartment=initial?.department_catalog_id||'';
  const initialDepartmentPending=useRef(Boolean(initialReference&&initialDepartment));
  const [step,setStep]=useState(editing?1:0),[search,setSearch]=useState('');
  const [admissionYear,setAdmissionYear]=useState(Number(initial?.admission_year||initial?.year)||2027);
  const [referenceId,setReferenceId]=useState(initialReference),[other,setOther]=useState(editing&&!initialReference),[university,setUniversity]=useState(initial?.university||'');
  const [campus,setCampus]=useState(initial?.campus==='미정'?'':initial?.campus||''),[track,setTrack]=useState(initial?.admission_type||initial?.track||''),[manualTrack,setManualTrack]=useState(editing);
  const [major,setMajor]=useState(initial?.department||initial?.major||''),[departmentId,setDepartmentId]=useState(initialDepartment),[manualMajor,setManualMajor]=useState(editing&&!initialDepartment);
  const [interestDepartment,setInterestDepartment]=useState(initial?.interest_department||'');
  const [school,setSchool]=useState<Item|null>(null),[departmentLoading,setDepartmentLoading]=useState(false),[busy,setBusy]=useState(false),[saveError,setSaveError]=useState('');
  const [calendar,setCalendar]=useState<SchoolCalendarPreview|null>(null),[calendarKey,setCalendarKey]=useState(''),[calendarLoading,setCalendarLoading]=useState(false),[departmentRetry,setDepartmentRetry]=useState(0);
  const [trackChoices,setTrackChoices]=useState<string[]>([]),[calendarError,setCalendarError]=useState(''),[retry,setRetry]=useState(0);
  const [acknowledged,setAcknowledged]=useState(false),[registered,setRegistered]=useState<Item|null>(null);
  const [sessionTargets,setSessionTargets]=useState<Item[]>([]);
  const heading=useRef<HTMLHeadingElement>(null),completionHeading=useRef<HTMLHeadingElement>(null),previousStep=useRef(step);
  const selected=catalog.find(item=>item.id===referenceId),currentSchool=school?.id===referenceId?school:null;
  const departments:Item[]=currentSchool?.departments||[],department=departments.find(item=>item.id===departmentId);
  const universityName=other?university.trim():selected?.university||(referenceId===initialReference?initial?.university:'')||'';
  const majorName=other||manualMajor?major.trim():department?.name||'';
  const completeSelection=Boolean(universityName&&majorName&&(other||manualMajor||departmentId));
  const payload={referenceId:other?null:referenceId,departmentId:other||manualMajor?null:departmentId,university:other?university.trim():undefined,
    admissionYear,campus:campus.trim()||'미정',track:track.trim()||'미정',major:majorName||undefined,...(interestDepartment?{interestDepartment}:{})};
  const selectionKey=JSON.stringify(payload);
  // Bind the preview to its exact inputs, including the render before the request effect runs.
  const currentCalendar=calendarKey===selectionKey?calendar:null;
  const ready=Boolean(currentCalendar&&!calendarLoading&&!departmentLoading&&currentCalendar.canReview&&track.trim()&&track.trim()!=='미정');
  const normalizedSearch=search.trim().replace(/\s/g,'').toLocaleLowerCase();
  const filtered=catalog.filter(item=>`${item.university} ${item.canonicalName||''}`.replace(/\s/g,'').toLocaleLowerCase().includes(normalizedSearch));
  const tracks=trackChoices,hasKnownTrack=tracks.some(item=>item===track);
  const savedTargets=[...registeredTargets.filter(item=>!sessionTargets.some(saved=>saved.id===item.id)),...sessionTargets];

  useEffect(()=>{
    if(previousStep.current!==step){previousStep.current=step;heading.current?.focus();}
  },[step]);
  useEffect(()=>{if(registered)completionHeading.current?.focus();},[registered]);
  useEffect(()=>{
    if(!referenceId||other){setSchool(null);setDepartmentLoading(false);return;}
    const controller=new AbortController();setDepartmentLoading(true);setSchool(null);
    api(`/api/schools/catalog?schoolId=${encodeURIComponent(referenceId)}`,{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted){
        setSchool(result.school);
        if(initialDepartmentPending.current&&referenceId===initialReference){
          initialDepartmentPending.current=false;
          if(!result.school.departments?.some((item:Item)=>item.id===initialDepartment)){setDepartmentId('');setManualMajor(true);}
        }
      }})
      .catch(err=>{if(!controller.signal.aborted)setSaveError((err as Error).message);})
      .finally(()=>{if(!controller.signal.aborted)setDepartmentLoading(false);});
    return()=>controller.abort();
  },[referenceId,other,departmentRetry]);
  useEffect(()=>{
    setCalendar(null);setCalendarKey('');setAcknowledged(false);setCalendarError('');
    if(!completeSelection||!Number.isInteger(admissionYear)||admissionYear<2024||admissionYear>2040){setCalendarLoading(false);return;}
    const controller=new AbortController();setCalendarLoading(true);
    const timer=setTimeout(()=>{api<{calendar:SchoolCalendarPreview}>('/api/schools/onboarding-calendar',{method:'POST',body:selectionKey,signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted){setCalendar(result.calendar);setCalendarKey(selectionKey);setTrackChoices(result.calendar.tracks);}})
      .catch(err=>{if(!controller.signal.aborted)setCalendarError((err as Error).message);})
      .finally(()=>{if(!controller.signal.aborted)setCalendarLoading(false);});},180);
    return()=>{clearTimeout(timer);controller.abort();};
  },[selectionKey,completeSelection,retry]);

  function goTo(next:number){setStep(next);setAcknowledged(false);setSaveError('');}
  function clearDetails(){
    initialDepartmentPending.current=false;
    setSchool(null);setDepartmentId('');setMajor('');setInterestDepartment('');setCampus('');setTrack('');setManualMajor(false);setManualTrack(false);
    setTrackChoices([]);setCalendar(null);setCalendarKey('');setCalendarError('');setAcknowledged(false);setSaveError('');
  }
  function chooseSchool(id:string){
    if(other||referenceId!==id){clearDetails();setOther(false);setReferenceId(id);}
    goTo(1);
  }
  function chooseDepartment(id:string){
    if(id!==departmentId){setDepartmentId(id);setInterestDepartment('');setTrack('');setTrackChoices([]);setManualTrack(false);setAcknowledged(false);}
  }
  function toggleManualSchool(){
    clearDetails();setReferenceId('');setOther(value=>!value);goTo(0);
  }
  function toggleManualMajor(){
    setManualMajor(value=>!value);setDepartmentId('');setMajor('');setInterestDepartment('');setTrack('');setTrackChoices([]);setManualTrack(false);setAcknowledged(false);
  }
  function retryCalendar(){setCalendar(null);setCalendarKey('');setAcknowledged(false);setRetry(value=>value+1);}
  function addAnotherSchool(){
    clearDetails();setReferenceId('');setOther(false);setUniversity('');setSearch('');setRegistered(null);goTo(0);
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;
    if(step===0){if(other&&university.trim())goTo(1);else if(!other&&filtered.length===1)chooseSchool(filtered[0].id);return;}
    if(step===1){if(completeSelection&&track.trim()&&track.trim()!=='미정'&&!departmentLoading)goTo(2);return;}
    if(!ready||!acknowledged||!currentCalendar)return;
    const reviewed=currentCalendar;
    setBusy(true);setSaveError('');
    try{
      const body={...payload,onboarding,calendarReview:{fingerprint:reviewed.fingerprint,acknowledged:true}};
      const result=editing?await api('/api/schools',{method:'PATCH',body:JSON.stringify({...body,targetId:initial!.id})}):await post('/api/schools',body);
      await onSaved(result.target);
      setSessionTargets(items=>[...items.filter(item=>item.id!==result.target.id),result.target]);setRegistered(result.target);
    }catch(err){setSaveError((err as Error).message);retryCalendar();}
    finally{setBusy(false);}
  }

  if(registered)return <div className={`${styles.page} ${styles.complete}`}>
    <span className={styles.completeMark}><Check size={30}/></span><p className={styles.eyebrow}>나의 면접 준비</p>
    <h1 ref={completionHeading} tabIndex={-1}>{editing?'지원 정보를 변경했어요.':'지원 학교를 등록했어요.'}</h1>
    <RegisteredSchoolList targets={savedTargets} currentId={registered.id}/>
    <div className={styles.completeSchedule}><CalendarDays size={22}/><div><span>{registered.university} · {currentCalendar?.statusLabel}</span>
      <p>{currentCalendar?.matched.length?currentCalendar.matched.map(dateRange).join(' · '):currentCalendar?.status==='no_interview'?'선택한 전형은 면접 미실시예요.':'일정 확인 상태를 저장했어요.'}</p>
      <small>{admissionYear}학년도{currentCalendar?.matched.length?' · 개인 응시 시간은 별도 발표':''}</small></div></div>
    <p className={styles.completeNote}>{editing?'변경한 지원 정보와 일정 확인 상태를 저장했어요.':'지원하는 학교가 더 있다면 이어서 추가해 주세요.'}</p>
    <div className={styles.completeActions}><Link className="button primary" href={editing?'/schools':'/my'}>{editing?'지원 학교 관리':'등록 마치고 시작'}<ArrowRight size={17}/></Link>{editing?<Link className="button" href="/schools/new"><Plus size={17}/>학교 추가</Link>:<button type="button" className="button" onClick={addAnotherSchool}><Plus size={17}/>학교 추가</button>}</div>
    <div className={styles.completeLinks}><Link href={'/my/today?'+new URLSearchParams({questionId:'common_motivation',targetId:registered.id,sourceType:'common'}).toString()}><BookOpen size={15}/>첫 질문 준비<ArrowUpRight size={15}/></Link><Link href="/my#dashboard-planner"><CalendarDays size={15}/>캘린더 확인<ArrowUpRight size={15}/></Link><Link href={`/schools/${encodeURIComponent(registered.id)}`}>학교 면접 안내<ArrowUpRight size={15}/></Link>{!editing&&<Link href="/schools">지원 학교 관리<ArrowUpRight size={15}/></Link>}</div>
  </div>;

  return <div className={styles.page}>
    {!onboarding&&<Breadcrumb items={[{label:'내 계정',href:'/account'},{label:'지원 학교',href:'/schools'},{label:editing?'지원 정보 변경':'학교 등록'}]}/>}
    <header className={styles.header}><p className={styles.eyebrow}>{editing?'지원 정보 변경':onboarding?'각자ON 시작하기':'지원 학교 추가'}</p><h1>{editing?'변경할 지원 정보를 확인해 주세요.':'지원 학교부터, 나의 면접까지.'}</h1><p>{editing?'학교·학과·전형을 수정하고 면접 일정을 다시 확인해요.':`학교별로 학과와 전형을 고르고, ${admissionYear}학년도 면접 일정을 함께 등록해요.`}</p></header>
    {!editing&&savedTargets.length>0&&<RegisteredSchoolList targets={savedTargets} finish={onboarding}/>}
    <ol className={styles.steps} aria-label="지원 학교 등록 단계">{stepLabels.map((label,index)=><li key={label} data-state={index<step?'done':index===step?'current':'next'}><button type="button" onClick={()=>goTo(index)} disabled={index>=step||busy} aria-current={index===step?'step':undefined}><span className={styles.stepNumber}>{index<step?<Check size={14}/>:index+1}</span><span>{label}</span></button>{index<2&&<ChevronRight size={17} aria-hidden="true"/>}</li>)}</ol>
    {error&&<Alert>{error}</Alert>}
    <div className={styles.workspace}>
      <form className={`${styles.form} school-registration`} onSubmit={submit}><fieldset disabled={busy||loading}>
        <section className={styles.stage} key={step} aria-labelledby="school-registration-heading">
          <div className={styles.stageHeading}><div><h2 id="school-registration-heading" ref={heading} tabIndex={-1}>{step===0?'어느 학교를 준비하나요?':step===1?'학과와 전형을 골라주세요.':'면접 일정을 확인해 주세요.'}</h2><p>{step===0?'학교를 고르면 학과 선택으로 이어져요.':step===1?'지원할 모집단위와 전형을 기준으로 일정을 찾아요.':'공개된 일정과 확인 상태를 캘린더에 연결해요.'}</p></div><span className={styles.stageCount}>{step+1} / 3</span></div>
          {step===0&&<>{other?<div className={styles.manualSchool}><label>지원 학교 이름<input value={university} onChange={event=>setUniversity(event.target.value)} maxLength={100} required placeholder="학교 이름을 입력해 주세요"/></label><p>목록에 없는 학교도 등록할 수 있어요. 면접 일정은 입학처 확인이 필요해요.</p><button type="button" className={styles.linkButton} onClick={toggleManualSchool}>학교 목록에서 선택</button><div className={styles.actions}><span/><button className="button primary" disabled={!university.trim()}>학과·전형 선택<ArrowRight size={17}/></button></div></div>:<>
            <label className={styles.search}><Search size={19}/><input type="search" aria-label="지원 대학 검색" placeholder="학교 이름으로 검색" value={search} autoComplete="off" onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();if(!event.nativeEvent.isComposing&&filtered.length===1)chooseSchool(filtered[0].id);}}}/>{search&&<button type="button" aria-label="학교 검색어 지우기" onClick={()=>setSearch('')}><X size={17}/></button>}</label>
            <div className={styles.listHeading}><span>{normalizedSearch?'검색한 학교':'지원 대학'}</span><span aria-live="polite">{filtered.length}개 대학</span></div>
            {loading?<Spinner/>:filtered.length?<ul className={styles.schoolList} aria-label="지원할 학교">{filtered.map(item=><li key={item.id}><button type="button" data-selected={referenceId===item.id} onClick={()=>chooseSchool(item.id)}><SchoolLogo school={item} size={34} loading="lazy"/><span>{item.university}</span><ChevronRight size={16}/></button></li>)}</ul>:<div className={styles.noResults}><GraduationCap size={28}/><p>검색한 학교가 없어요.</p><span>학교 이름을 다시 확인하거나 직접 입력해 주세요.</span><button type="button" className={styles.linkButton} onClick={toggleManualSchool}>학교 직접 입력</button></div>}
            {(loading||filtered.length>0)&&<div className={styles.directoryFoot}><span>찾는 학교가 없나요?</span><button type="button" className={styles.linkButton} onClick={toggleManualSchool}>학교 직접 입력<ArrowRight size={13}/></button></div>}
          </>}</>}
          {step===1&&<>
            <div className={styles.selectedSchool}><SchoolLogo school={selected||{university:universityName}} size={40}/><span>{universityName}</span><button type="button" className={styles.linkButton} onClick={()=>goTo(0)}>변경</button></div>
            <div className={styles.fields}>
              <div className={styles.field}>{other||manualMajor?<label>지원 학과·학부·모집단위<input required value={major} onChange={event=>setMajor(event.target.value)} maxLength={120} placeholder="모집요강의 모집단위명"/></label>:<SchoolPicker label="지원 학과·학부" choices={departments.map(item=>({id:item.id,label:item.name,detail:[item.college==='단과대구분없음'?null:item.college,item.campus,item.programs?.length?`${item.programs.length}개 세부 전공`:null].filter(Boolean).join(' · '),keywords:item.programs}))} value={departmentId} onChange={chooseDepartment} placeholder={departmentLoading?'학과 불러오는 중':'학과·학부를 선택해 주세요'} disabled={busy||departmentLoading}/>}
                {!other&&<button type="button" className={styles.fieldAlternative} onClick={toggleManualMajor}>{manualMajor?'학과 목록에서 선택':'신설·변경된 모집단위 직접 입력'}</button>}
                {!other&&saveError&&!currentSchool&&!departmentLoading&&<button type="button" className={styles.linkButton} onClick={()=>{setSaveError('');setDepartmentRetry(value=>value+1);}}>학과 다시 불러오기</button>}
              </div>
              {!manualMajor&&department&&department.programs?.length>0&&<label>관심 세부 전공<select value={interestDepartment} onChange={event=>setInterestDepartment(event.target.value)}><option value="">광역 모집단위 전체로 준비할게요</option>{department.programs.map((name:string)=><option key={name} value={name}>{name}</option>)}</select><small>실제 지원 모집단위는 {department.name}로 유지해요. 관심 전공은 지식한입과 면접 질문에 반영하며, 입학 후 전공 배정을 보장하지 않아요. {department.programSourceUrl&&<a href={department.programSourceUrl} target="_blank" rel="noreferrer">{department.programSourceYear}학년도 공식 전공 안내</a>}</small></label>}
              <div className={styles.yearRow}><label>지원 학년도<input type="number" min={2024} max={2040} required value={admissionYear} onChange={event=>setAdmissionYear(Number(event.target.value))}/></label></div>
              <div className={styles.field} aria-busy={calendarLoading}>{!manualTrack&&tracks.length?<><SchoolPicker label="지원 전형" choices={tracks.map(item=>({id:item,label:item}))} value={hasKnownTrack?track:''} onChange={setTrack} placeholder="공개 일정의 전형을 선택해 주세요" disabled={!completeSelection||busy}/><button type="button" className={styles.fieldAlternative} onClick={()=>setManualTrack(true)}>목록에 없는 전형 직접 입력</button></>:<><label>지원 전형<input required value={track} onChange={event=>{setTrack(event.target.value);setManualTrack(true);}} maxLength={120} placeholder={!completeSelection?'학과를 먼저 선택해 주세요':'모집요강에 있는 전형명'} disabled={!completeSelection}/></label>{tracks.length>0&&<button type="button" className={styles.fieldAlternative} onClick={()=>{setManualTrack(false);setTrack('');}}>전형 목록에서 선택</button>}</>}</div>
              {(other||manualMajor)&&<label>캠퍼스<input value={campus} onChange={event=>setCampus(event.target.value)} maxLength={100} placeholder="캠퍼스명 (선택)"/></label>}
            </div>
            <p className={styles.sourceNote}>{other||manualMajor?'직접 입력한 학교·학과는 확인 전이에요. 모집요강과 함께 확인해 주세요.':<>지원 학년도 모집단위는 {selected?.admissionUrl?<a href={selected.admissionUrl} target="_blank" rel="noreferrer">입학처<ArrowUpRight size={12}/></a>:'입학처'}에서 확인해 주세요.</>}</p>
            <div className={styles.actions}><button type="button" className={styles.back} onClick={()=>goTo(0)}><ArrowLeft size={15}/>학교 선택</button><button className="button primary" disabled={!completeSelection||!track.trim()||track.trim()==='미정'||departmentLoading}>면접 일정 확인<ArrowRight size={17}/></button></div>
          </>}
          {step===2&&<>
            <div className={styles.reviewIdentity}><SchoolLogo school={selected||{university:universityName}} size={42}/><div><h3>{universityName}</h3><p>{majorName} · {track} · {admissionYear}학년도</p></div><button type="button" className={styles.linkButton} onClick={()=>goTo(1)}>수정</button></div>
            <div className={styles.calendar} aria-live="polite">{calendarLoading||(!currentCalendar&&!calendarError)?<Spinner/>:currentCalendar?<SchoolCalendarReview calendar={currentCalendar}/>:null}</div>
            {calendarError&&<div className={styles.error}><Alert>{calendarError}</Alert><button type="button" className={styles.linkButton} onClick={retryCalendar}>일정 다시 조회<ArrowRight size={14}/></button></div>}
            <label className={styles.ack}><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} disabled={!ready}/><span>{currentCalendar?.matched.length?'학교 공개 일정이며 개인 응시 시간은 별도 발표되는 것을 확인했어요.':'일정 확인 상태를 확인했어요. 날짜나 면접 여부가 확정되기 전에는 개인 일정으로 등록되지 않아요.'}</span></label>
            <div className={styles.actions}><button type="button" className={styles.back} onClick={()=>goTo(1)}><ArrowLeft size={15}/>학과·전형</button><ActionButton type="submit" className="button primary" disabled={!ready||!acknowledged} pending={busy} pendingLabel={editing?'변경 내용 저장 중':'학교 등록 중'}>{editing?'변경 내용 저장':'학교 등록'}<ArrowRight size={17}/></ActionButton></div>
          </>}
          {saveError&&<div className={styles.error}><Alert>{saveError}</Alert></div>}
        </section>
      </fieldset></form>
      <aside className={styles.summary} data-step={step} aria-label="선택한 지원 정보">
        <div className={styles.summaryTop}><Logo size={34} wordmark={false}/><span>나의 면접 준비</span><span>{admissionYear}학년도</span></div>
        <h2>{universityName||'어디로 향하고 있나요?'}</h2><p className={styles.summarySubtitle}>{universityName?'선택한 지원 정보가 준비의 기준이 돼요.':'학교를 고르면 준비 내용이 여기에 모여요.'}</p>
        <dl className={styles.summaryDetails}><div><dt>지원 학교</dt><dd data-pending={!universityName}>{universityName||'학교 선택 전'}</dd></div><div><dt>학과·학부</dt><dd data-pending={!majorName}>{majorName||'학과 선택 전'}</dd></div><div><dt>지원 전형</dt><dd data-pending={!track.trim()}>{track.trim()||'전형 선택 전'}</dd></div></dl>
        <div className={styles.summarySchedule}><CalendarDays size={20}/><div><span>{calendarLoading?'면접 일정 조회 중':track.trim()&&currentCalendar?currentCalendar.statusLabel:'전형 선택 후 일정 조회'}</span><p>{track.trim()&&currentCalendar?currentCalendar.matched.length?currentCalendar.matched.map(dateRange).join(' · '):visibleCalendarSourceText(currentCalendar.note):`${admissionYear}학년도`}</p></div></div>
        <div className={styles.connected}><span>등록 후 이어지는 준비</span><p><GraduationCap size={16}/>학교 면접 안내</p><p><MessageCircle size={16}/>지원 정보에 맞춘 면접 연습</p><p><CalendarDays size={16}/>캘린더에 면접 일정 연결</p></div>
      </aside>
    </div>
  </div>;
}
function RegisteredSchoolList({targets,currentId,finish=false}:{targets:Item[];currentId?:string;finish?:boolean}){
  if(!targets.length)return null;
  return <section className={styles.savedSection} aria-label="등록한 지원 학교"><div className={styles.savedHeading}><h2>등록한 지원 학교 <span>{targets.length}개</span></h2>{finish&&<Link href="/my">등록 마치고 시작<ArrowRight size={14}/></Link>}</div><ul className={styles.savedList}>{targets.map(target=><li className={styles.savedItem} key={target.id}><SchoolLogo school={target} size={30}/><div><span>{target.university}</span><p>{[target.department||target.major,target.admission_type||target.track].filter(Boolean).join(' · ')}</p></div>{currentId===target.id&&<span className={styles.savedCheck}><Check size={13}/>저장됨</span>}</li>)}</ul></section>;
}
function SchoolCalendarReview({calendar}:{calendar:SchoolCalendarPreview}){
  const days=(item:SchoolCalendarPreview['matched'][number])=>item.startDate===item.endDate?scheduleDateLabel(item.startDate):`${scheduleDateLabel(item.startDate)}–${scheduleDateLabel(item.endDate)}`;
  return <section className="school-calendar-review" aria-labelledby="school-calendar-review-title"><div className="section-heading"><h2 id="school-calendar-review-title"><CalendarDays size={20}/>면접 일정</h2><span className="school-calendar-state" data-status={calendar.status}>{calendar.statusLabel}</span></div>
    <p>{visibleCalendarSourceText(calendar.note)}</p>
    {calendar.matched.length>0&&<ul className="school-calendar-dates">{calendar.matched.map(item=><li key={item.id}><div><time dateTime={item.startDate}>{days(item)}</time><span>{item.format==='video_submission'?'동영상 면접 제출기간':item.trackLabel} · {item.matchedDepartment||calendar.department}</span>{visibleCalendarSourceText(item.note)&&<small>{visibleCalendarSourceText(item.note)}</small>}</div>{visibleCalendarSourceUrl(item.sourceUrl)&&<a href={visibleCalendarSourceUrl(item.sourceUrl)} target="_blank" rel="noreferrer">{visibleCalendarSourceLabel(item.sourceLabel,item.sourceUrl)||'일정'} 원문<ArrowUpRight size={14}/></a>}</li>)}</ul>}
    {visibleCalendarSourceUrl(calendar.decisionSourceUrl)&&<a className="school-source-link" href={visibleCalendarSourceUrl(calendar.decisionSourceUrl)} target="_blank" rel="noreferrer">{visibleCalendarSourceLabel(calendar.decisionSourceLabel,calendar.decisionSourceUrl)||'일정'} 확인 근거<ArrowUpRight size={14}/></a>}
    {calendar.references.length>0&&<details className="school-calendar-reference"><summary>학교 참고 일정 {calendar.references.length}개</summary><ul>{calendar.references.map(item=><li key={item.id}><span>{days(item)} · {item.trackLabel}</span>{visibleCalendarSourceUrl(item.sourceUrl)&&<a href={visibleCalendarSourceUrl(item.sourceUrl)} target="_blank" rel="noreferrer">원문<ArrowUpRight size={13}/></a>}</li>)}</ul></details>}
    {!!calendar.unresolved.length&&<div className="school-calendar-unresolved">{calendar.unresolved.filter(item=>item.trackLabel===calendar.track).map((item,index)=><p key={index}>{item.trackLabel} · {visibleCalendarSourceText(item.rawDate)}<small>{visibleCalendarSourceText(item.reason)}</small></p>)}</div>}
    <p className="school-calendar-checked"><time dateTime={calendar.checkedAt}>{scheduleDateLabel(calendar.checkedAt)} 확인</time>{calendar.stale&&<span>마지막 확인 자료 · 입학처 원문을 함께 확인해 주세요.</span>}</p>
    {!calendar.matched.length&&calendar.officialSources.some(source=>visibleCalendarSourceUrl(source.url))&&<details className="school-calendar-reference"><summary>입학처 자료</summary>{calendar.officialSources.filter(source=>visibleCalendarSourceUrl(source.url)).map(source=><a className="school-source-link" key={source.url} href={source.url} target="_blank" rel="noreferrer">{visibleCalendarSourceText(source.title)}<ArrowUpRight size={13}/></a>)}</details>}
  </section>;
}

