'use client';
import {ownedClassName} from './owned-class-name';

import Link from 'next/link';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,ArrowLeft,ArrowUpRight,CalendarDays,Check,BookOpen,ChevronRight,Search,X,GraduationCap,Plus} from 'lucide-react';
import {SchoolPicker} from './school-picker';
import {SchoolLogo} from './school-logo';
import {api,post,ActionButton,Alert,Spinner,Logo,type Item} from './shared';
import {scheduleDateLabel} from '@/lib/schedule';
import type {SchoolCalendarPreview} from '@/lib/school-onboarding-calendar-model';
import {visibleCalendarSourceUrl,visibleCalendarSourceLabel,visibleCalendarSourceText} from '@/lib/calendar-source-presentation';
import styles from './school-registration.module.css';
import {StudentDocument} from './student-document';

type Props={catalog:Item[];loading:boolean;error:string;onSaved:(target:Item)=>Promise<void>;onboarding:boolean;initialTarget?:Item;registeredTargets?:Item[]};
type SchoolDraft={referenceId:string;other:boolean;university:string;campus:string;track:string;major:string;departmentId:string;manualMajor:boolean;interestDepartment:string;calendar:SchoolCalendarPreview|null;acknowledged:boolean;payload:Item};
const stepLabels=['학교 선택','학과·전형','일정 등록'];
const dateRange=(item:SchoolCalendarPreview['matched'][number])=>item.startDate===item.endDate?scheduleDateLabel(item.startDate):`${scheduleDateLabel(item.startDate)}–${scheduleDateLabel(item.endDate)}`;
const schoolDetails=new Map<string,{at:number;school:Item}>(),schoolRequests=new Map<string,Promise<Item>>();
function loadSchoolDetails(id:string,force=false){
  if(force)schoolDetails.delete(id);
  const cached=schoolDetails.get(id);if(!force&&cached&&Date.now()-cached.at<3_600_000)return Promise.resolve({school:cached.school});
  if(!force&&schoolRequests.has(id))return schoolRequests.get(id)!;
  const request=api(`/api/schools/catalog?schoolId=${encodeURIComponent(id)}&view=registration`,force?{cache:'no-store'}:undefined).then(result=>{if(schoolRequests.get(id)===request)schoolDetails.set(id,{at:Date.now(),school:result.school});return result;});
  schoolRequests.set(id,request);void request.finally(()=>{if(schoolRequests.get(id)===request)schoolRequests.delete(id);}).catch(()=>{});return request;
}
function prefetchSchool(id:string){void loadSchoolDetails(id).catch(()=>{});}

export function SchoolRegistration({catalog,loading,error,onSaved,onboarding,initialTarget,registeredTargets=[]}:Props){
  // The parent mounts the editor only once its target has loaded. Refreshes must not overwrite edits.
  const initial=useRef(initialTarget).current,editing=Boolean(initial);
  const initialReference=initial?.school_reference_id||'',initialDepartment=initial?.department_catalog_id||'';
  const initialDepartmentPending=useRef(Boolean(initialReference&&initialDepartment));
  const [step,setStep]=useState(editing?1:0),[search,setSearch]=useState('');
  const admissionYear=2027;
  const [referenceId,setReferenceId]=useState(initialReference),[other,setOther]=useState(editing&&!initialReference),[university,setUniversity]=useState(initial?.university||'');
  const [campus,setCampus]=useState(initial?.campus==='미정'?'':initial?.campus||''),[track,setTrack]=useState(initial?.admission_type||initial?.track||'');
  const [major,setMajor]=useState(initial?.department||initial?.major||''),[departmentId,setDepartmentId]=useState(initialDepartment),[manualMajor,setManualMajor]=useState(editing&&!initialDepartment);
  const [interestDepartment,setInterestDepartment]=useState(initial?.interest_department||'');
  const [school,setSchool]=useState<Item|null>(null),[departmentLoading,setDepartmentLoading]=useState(false),[busy,setBusy]=useState(false),[saveError,setSaveError]=useState('');
  const [calendar,setCalendar]=useState<SchoolCalendarPreview|null>(null),[calendarKey,setCalendarKey]=useState(''),[calendarLoading,setCalendarLoading]=useState(false),[departmentRetry,setDepartmentRetry]=useState(0);
  const [trackChoices,setTrackChoices]=useState<string[]>([]),[calendarError,setCalendarError]=useState(''),[retry,setRetry]=useState(0);
  const [acknowledged,setAcknowledged]=useState(false),[registered,setRegistered]=useState<Item|null>(null);
  const [sessionTargets,setSessionTargets]=useState<Item[]>([]);
  const [selectedSchools,setSelectedSchools]=useState<string[]>([]),[schoolIndex,setSchoolIndex]=useState(0);
  const schoolDrafts=useRef(new Map<string,SchoolDraft>()),submission=useRef(false),savedResponse=useRef<Item[]|null>(null);
  const calendarCache=useRef(new Map<string,{at:number;calendar:SchoolCalendarPreview}>());
  const calendarRequests=useRef(new Map<string,Promise<Item>>());
  const heading=useRef<HTMLHeadingElement>(null),completionHeading=useRef<HTMLHeadingElement>(null),previousStep=useRef(`${step}:${referenceId}`);
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
  const filtered=catalog.filter(item=>`${item.university} ${item.canonicalName||''} ${/UNIST|울산과학기술원/i.test(item.university)?'유니스트':''}`.replace(/\s/g,'').toLocaleLowerCase().includes(normalizedSearch));
  const tracks=trackChoices,hasKnownTrack=tracks.some(item=>item===track);
  useEffect(()=>{if(!track&&tracks.length===1)setTrack(tracks[0]);},[track,tracks]);
  const savedTargets=[...registeredTargets.filter(item=>!sessionTargets.some(saved=>saved.id===item.id)),...sessionTargets];

  useEffect(()=>{
    const current=`${step}:${referenceId}`;if(previousStep.current!==current){previousStep.current=current;heading.current?.focus();}
  },[step,referenceId]);
  useEffect(()=>{if(registered)completionHeading.current?.focus();},[registered]);
  useEffect(()=>{
    if(!referenceId||other){setSchool(null);setDepartmentLoading(false);return;}
    const controller=new AbortController();setDepartmentLoading(true);setSchool(null);
    loadSchoolDetails(referenceId,departmentRetry>0)
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
    if(!completeSelection){setCalendarLoading(false);return;}
    const cached=calendarCache.current.get(selectionKey);
    if(cached&&Date.now()-cached.at<30_000){setCalendar(cached.calendar);setCalendarKey(selectionKey);setTrackChoices(cached.calendar.tracks);setCalendarLoading(false);return;}
    const controller=new AbortController();setCalendarLoading(true);
    const run=()=>{let request=calendarRequests.current.get(selectionKey);if(!request){request=api('/api/schools/onboarding-calendar',{method:'POST',body:selectionKey});calendarRequests.current.set(selectionKey,request);void request.finally(()=>{if(calendarRequests.current.get(selectionKey)===request)calendarRequests.current.delete(selectionKey);}).catch(()=>{});}
      void request.then(result=>{if(!controller.signal.aborted){calendarCache.current.set(selectionKey,{at:Date.now(),calendar:result.calendar});if(result.suggestedCalendar){const suggestedKey=JSON.stringify({...JSON.parse(selectionKey),track:result.suggestedCalendar.track});calendarCache.current.set(suggestedKey,{at:Date.now(),calendar:result.suggestedCalendar});}setCalendar(result.calendar);setCalendarKey(selectionKey);setTrackChoices(result.calendar.tracks);}})
      .catch(err=>{if(!controller.signal.aborted)setCalendarError((err as Error).message);})
      .finally(()=>{if(!controller.signal.aborted)setCalendarLoading(false);});};
    const timer=other||manualMajor?setTimeout(run,180):null;if(timer===null)run();
    return()=>{if(timer!==null)clearTimeout(timer);controller.abort();};
  },[selectionKey,completeSelection,retry]);

  function rememberSchool(){if(referenceId&&!editing)schoolDrafts.current.set(referenceId,{referenceId,other,university,campus,track,major,departmentId,manualMajor,interestDepartment,calendar:currentCalendar,acknowledged,payload});}
  function goTo(next:number){if(next===0)rememberSchool();setStep(next);setAcknowledged(false);setSaveError('');}
  function activateSchool(id:string,index:number){
    rememberSchool();const draft=schoolDrafts.current.get(id);
    initialDepartmentPending.current=false;setOther(false);setReferenceId(id);setSchoolIndex(index);setUniversity('');
    setCampus(draft?.campus||'');setTrack(draft?.track||'');setMajor(draft?.major||'');setDepartmentId(draft?.departmentId||'');
    setManualMajor(draft?.manualMajor||false);setInterestDepartment(draft?.interestDepartment||'');setTrackChoices(draft?.calendar?.tracks||[]);
    setDepartmentRetry(0);setCalendarError('');setSaveError('');setAcknowledged(false);setStep(1);
  }
  function clearDetails(){
    initialDepartmentPending.current=false;
    setSchool(null);setDepartmentId('');setMajor('');setInterestDepartment('');setCampus('');setTrack('');setManualMajor(false);
    setTrackChoices([]);setCalendar(null);setCalendarKey('');setCalendarError('');setAcknowledged(false);setSaveError('');
  }
  function chooseSchool(id:string){
    if(!editing){setSelectedSchools(items=>items.includes(id)?items.filter(value=>value!==id):items.length<20?[...items,id]:items);setSaveError('');return;}
    if(other||referenceId!==id){clearDetails();setDepartmentRetry(0);setOther(false);setReferenceId(id);}
    goTo(1);
  }
  function chooseDepartment(id:string){
    if(id!==departmentId){setDepartmentId(id);setInterestDepartment('');setTrack('');setTrackChoices([]);setAcknowledged(false);}
  }
  function toggleManualSchool(){
    clearDetails();setReferenceId('');setOther(value=>!value);goTo(0);
  }
  function toggleManualMajor(){
    setManualMajor(value=>!value);setDepartmentId('');setMajor('');setInterestDepartment('');setTrack('');setTrackChoices([]);setAcknowledged(false);
  }
  function retryCalendar(){calendarCache.current.delete(selectionKey);calendarRequests.current.delete(selectionKey);setCalendar(null);setCalendarKey('');setAcknowledged(false);setRetry(value=>value+1);}
  function addAnotherSchool(){
    schoolDrafts.current.clear();savedResponse.current=null;setSelectedSchools([]);setSchoolIndex(0);clearDetails();setReferenceId('');setOther(false);setUniversity('');setSearch('');setRegistered(null);goTo(0);
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy||submission.current)return;
    if(step===0){if(other&&university.trim())goTo(1);else if(!editing&&selectedSchools.length)activateSchool(selectedSchools[0],0);else if(editing&&!other&&filtered.length===1)chooseSchool(filtered[0].id);return;}
    if(step===1){if(ready)goTo(2);return;}
    if(!ready||!acknowledged||!currentCalendar)return;
    rememberSchool();
    if(!editing&&selectedSchools.length>1&&schoolIndex<selectedSchools.length-1){activateSchool(selectedSchools[schoolIndex+1],schoolIndex+1);return;}
    const reviewed=currentCalendar;
    submission.current=true;setBusy(true);setSaveError('');
    try{
      const body={...payload,onboarding,calendarReview:{fingerprint:reviewed.fingerprint,acknowledged:true}};
      let targets=savedResponse.current;
      if(!targets){
        if(editing){const result=await api('/api/schools',{method:'PATCH',body:JSON.stringify({...body,targetId:initial!.id})});targets=[result.target];}
        else if(selectedSchools.length>1){
          const registrations=selectedSchools.map(id=>{const draft=schoolDrafts.current.get(id);if(!draft?.calendar||!draft.acknowledged)throw Error('각 학교의 학과·전형과 면접 일정을 확인해 주세요.');return {...draft.payload,onboarding,calendarReview:{fingerprint:draft.calendar.fingerprint,acknowledged:true}};});
          const result=await post('/api/schools',{registrations});targets=result.targets;
        }else{const result=await post('/api/schools',body);targets=[result.target];}
        savedResponse.current=targets;
      }
      if(!targets?.length)throw Error('등록 결과를 확인하지 못했어요. 다시 시도해 주세요.');
      // Record the successful response before refreshing the parent: a refresh
      // failure must not submit a second mutation or erase the reviewed batch.
      setSessionTargets(items=>[...items.filter(item=>!targets!.some(target=>target.id===item.id)),...targets!]);
      try{await onSaved(targets[targets.length-1]);}catch{setSaveError('학교 등록은 완료했어요. 최신 목록이 보이지 않으면 화면을 새로고침해 주세요.');}
      setRegistered(targets[targets.length-1]);
    }catch(err){setSaveError((err as Error).message);if(!savedResponse.current)retryCalendar();}
    finally{submission.current=false;setBusy(false);}
  }

  if(registered&&onboarding&&!editing)return <StudentDocument onboarding/>;

  if(registered)return <div className={ownedClassName(`${styles.page} ${styles.complete}`,true)}>
    <span className={ownedClassName(styles.completeMark,true)}><Check size={30}/></span><p className={ownedClassName(styles.eyebrow,true)}>나의 면접 준비</p>
    <h1 ref={completionHeading} tabIndex={-1} className={ownedClassName(undefined,true)}>{editing?'지원 정보를 변경했어요.':'지원 학교를 등록했어요.'}</h1>
    {saveError&&<Alert>{saveError}</Alert>}
    <RegisteredSchoolList targets={savedTargets} currentId={registered.id}/>
    <div className={ownedClassName(styles.completeSchedule,true)}><CalendarDays size={22}/><div className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{registered.university} · {currentCalendar?.statusLabel}</span>
      <p className={ownedClassName(undefined,true)}>{currentCalendar?.matched.length?currentCalendar.matched.map(dateRange).join(' · '):currentCalendar?.status==='no_interview'?'선택한 전형은 면접 미실시예요.':'일정 확인 상태를 저장했어요.'}</p>
      <small className={ownedClassName(undefined,true)}>{admissionYear}학년도{currentCalendar?.matched.length?' · 개인 응시 시간은 별도 발표':''}</small></div></div>
    <p className={ownedClassName(styles.completeNote,true)}>{editing?'변경한 지원 정보와 일정 확인 상태를 저장했어요.':'이제 공통 질문 한 개에 답해봐요. 다른 학교와 개인 자료는 나중에 연결해도 돼요.'}</p>
    <div className={ownedClassName(styles.completeActions,true)}><Link className={ownedClassName("button primary")} href={editing?'/schools':'/start?targetId='+encodeURIComponent(registered.id)}>{editing?'지원 학교 관리':'첫 질문 1개 답해보기'}<ArrowRight size={17}/></Link>{editing?<Link className={ownedClassName("button")} href="/schools/new"><Plus size={17}/>학교 추가</Link>:<button type="button" className={ownedClassName("text-link",true)} onClick={addAnotherSchool}><Plus size={17}/>학교 추가 (선택)</button>}</div>
    <div className={ownedClassName(styles.completeLinks,true)}><Link href="/preparation#training-calendar"><CalendarDays size={15}/>캘린더 확인<ArrowUpRight size={15}/></Link><Link href={`/schools/${encodeURIComponent(registered.id)}`}>학교 면접 안내<ArrowUpRight size={15}/></Link>{!editing&&<Link href="/schools">지원 학교 관리<ArrowUpRight size={15}/></Link>}</div>
  </div>;

  return <div className={ownedClassName(styles.page,true)} data-registration-step={step}>
    <header className={ownedClassName(styles.header,true)}><h1 className={ownedClassName(undefined,true)}>{editing?'지원 정보 변경':'지원 학교 등록'}</h1><p className={ownedClassName(undefined,true)}>{admissionYear}학년도 학교·학과·전형과 면접 일정을 연결해요.</p></header>
    {onboarding&&!editing&&<p className={ownedClassName(styles.optionalPractice,true)}><Link className={ownedClassName("text-link")} href="/start">학교 등록 전에 공통 질문 한 개 답해보기<ArrowUpRight size={15}/></Link></p>}
    {!editing&&savedTargets.length>0&&<RegisteredSchoolList targets={savedTargets} finish={onboarding}/>}
    <ol className={ownedClassName(styles.steps,true)} aria-label="지원 학교 등록 단계">{stepLabels.map((label,index)=><li key={label} data-state={index<step?'done':index===step?'current':'next'} className={ownedClassName(undefined,true)}><button type="button" onClick={()=>goTo(index)} disabled={index>=step||busy} aria-current={index===step?'step':undefined} className={ownedClassName(undefined,true)}><span className={ownedClassName(styles.stepNumber,true)}>{index<step?<Check size={14}/>:index+1}</span><span className={ownedClassName(undefined,true)}>{label}</span></button>{index<2&&<ChevronRight size={17} aria-hidden="true"/>}</li>)}</ol>
    {!editing&&selectedSchools.length>0&&<nav className={ownedClassName(styles.batchSchools,true)} aria-label="선택한 대학별 지원 정보">{selectedSchools.map((id,index)=><button key={id} type="button" aria-current={step>0&&schoolIndex===index?'step':undefined} disabled={busy||step===0||index>schoolIndex&&!schoolDrafts.current.get(id)?.acknowledged} onClick={()=>activateSchool(id,index)} className={ownedClassName(undefined,true)}><span>{schoolDrafts.current.get(id)?.acknowledged?<Check size={13}/>:index+1}</span>{catalog.find(item=>item.id===id)?.university}</button>)}</nav>}
    {error&&<Alert>{error}</Alert>}
    <div className={ownedClassName(styles.workspace,true)}>
      <form className={ownedClassName(`${styles.form} school-registration`,true)} onSubmit={submit}><fieldset disabled={busy||loading} className={ownedClassName(undefined,true)}>
        <section className={ownedClassName(styles.stage,true)} key={step} aria-labelledby="school-registration-heading">
          <div className={ownedClassName(styles.stageHeading,true)}><div className={ownedClassName(undefined,true)}><h2 id="school-registration-heading" ref={heading} tabIndex={-1} className={ownedClassName(undefined,true)}>{step===0?'어느 학교를 준비하나요?':step===1?'학과와 전형을 골라주세요.':'면접 일정을 확인해 주세요.'}</h2></div><span className={ownedClassName(styles.stageCount,true)}>{step>0&&!editing&&selectedSchools.length>1?`${schoolIndex+1} / ${selectedSchools.length}개 대학`:`${step+1} / 3`}</span></div>
          {step===0&&<>{other?<div className={ownedClassName(styles.manualSchool,true)}><label className={ownedClassName(undefined,true)}>지원 학교 이름<input value={university} onChange={event=>setUniversity(event.target.value)} maxLength={100} required placeholder="학교 이름을 입력해 주세요" className={ownedClassName(undefined,true)}/></label><p className={ownedClassName(undefined,true)}>목록에 없는 학교도 등록할 수 있어요. 면접 일정은 입학처 확인이 필요해요.</p><button type="button" className={ownedClassName(styles.linkButton,true)} onClick={toggleManualSchool}>학교 목록에서 선택</button><div className={ownedClassName(styles.actions,true)}><span className={ownedClassName(undefined,true)}/><button className={ownedClassName("button primary",true)} disabled={!university.trim()}>학과·전형 선택<ArrowRight size={17}/></button></div></div>:<>
            <label className={ownedClassName(styles.search,true)}><Search size={19}/><input type="search" aria-label="지원 대학 검색" placeholder="학교 이름으로 검색" value={search} autoComplete="off" onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();if(!event.nativeEvent.isComposing&&filtered.length===1)chooseSchool(filtered[0].id);}}} className={ownedClassName(undefined,true)}/>{search&&<button type="button" aria-label="학교 검색어 지우기" onClick={()=>setSearch('')} className={ownedClassName(undefined,true)}><X size={17}/></button>}</label>
            <div className={ownedClassName(styles.listHeading,true)}><span className={ownedClassName(undefined,true)}>{normalizedSearch?'검색한 학교':'지원 대학'}</span><span aria-live="polite" className={ownedClassName(undefined,true)}>{filtered.length}개 대학</span></div>
            {loading?<Spinner/>:filtered.length?<ul className={ownedClassName(styles.schoolList,true)} aria-label="지원할 학교">{filtered.map(item=><li key={item.id} className={ownedClassName(undefined,true)}><button type="button" data-selected={editing?referenceId===item.id:selectedSchools.includes(item.id)} aria-pressed={editing?undefined:selectedSchools.includes(item.id)} disabled={!editing&&selectedSchools.length>=20&&!selectedSchools.includes(item.id)} onPointerEnter={()=>prefetchSchool(item.id)} onFocus={()=>prefetchSchool(item.id)} onPointerDown={()=>prefetchSchool(item.id)} onClick={()=>chooseSchool(item.id)} className={ownedClassName(undefined,true)}><SchoolLogo school={item} size={34} loading="lazy"/><span className={ownedClassName(undefined,true)}>{item.university}</span>{!editing&&selectedSchools.includes(item.id)?<Check size={17}/>:editing?<ChevronRight size={16}/>:<Plus size={16}/>}</button></li>)}</ul>:<div className={ownedClassName(styles.noResults,true)}><GraduationCap size={28}/><p className={ownedClassName(undefined,true)}>검색한 학교가 없어요.</p><span className={ownedClassName(undefined,true)}>학교 이름을 다시 확인해 주세요. 제시문·교과 구술 면접만 있는 학교는 목록에 없어요.</span></div>}
            {!editing&&<div className={ownedClassName(styles.selectionActions,true)}><span aria-live="polite">{selectedSchools.length?`${selectedSchools.length}개 대학 선택`:`여러 대학을 함께 선택할 수 있어요.`}</span><button className={ownedClassName("button primary")} disabled={!selectedSchools.length}>학과·전형 선택<ArrowRight size={17}/></button></div>}
          </>}</>}
          {step===1&&<>
            <div className={ownedClassName(styles.selectedSchool,true)}><SchoolLogo school={selected||{university:universityName}} size={40}/><span className={ownedClassName(undefined,true)}>{universityName}</span><button type="button" className={ownedClassName(styles.linkButton,true)} onClick={()=>goTo(0)}>변경</button></div>
            <div className={ownedClassName(styles.fields,true)}>
              <div className={ownedClassName(styles.field,true)}>{other||manualMajor?<label className={ownedClassName(undefined,true)}>지원 학과·학부·모집단위<input required value={major} onChange={event=>setMajor(event.target.value)} maxLength={120} placeholder="모집요강의 모집단위명" className={ownedClassName(undefined,true)}/></label>:<SchoolPicker label="지원 학과·학부" choices={departments.map(item=>({id:item.id,label:item.name,detail:[item.college==='단과대구분없음'?null:item.college,item.campus,item.programs?.length?`${item.programs.length}개 세부 전공`:null].filter(Boolean).join(' · '),keywords:item.programs}))} value={departmentId} onChange={chooseDepartment} placeholder={departmentLoading?'학과 불러오는 중':'학과·학부를 선택해 주세요'} disabled={busy||departmentLoading}/>}
                {!other&&<button type="button" className={ownedClassName(styles.fieldAlternative,true)} onClick={toggleManualMajor}>{manualMajor?'학과 목록에서 선택':'신설·변경된 모집단위 직접 입력'}</button>}
                {!other&&saveError&&!currentSchool&&!departmentLoading&&<button type="button" className={ownedClassName(styles.linkButton,true)} onClick={()=>{setSaveError('');setDepartmentRetry(value=>value+1);}}>학과 다시 불러오기</button>}
              </div>
              {!manualMajor&&department&&department.programs?.length>0&&<label className={ownedClassName(undefined,true)}>관심 세부 전공<select value={interestDepartment} onChange={event=>setInterestDepartment(event.target.value)} className={ownedClassName(undefined,true)}><option value="" className={ownedClassName(undefined,true)}>광역 모집단위 전체로 준비할게요</option>{department.programs.map((name:string)=><option key={name} value={name} className={ownedClassName(undefined,true)}>{name}</option>)}</select><small className={ownedClassName(undefined,true)}>실제 지원 모집단위는 {department.name}로 유지해요. 관심 전공은 지식한입과 면접 질문에 반영하며, 입학 후 전공 배정을 보장하지 않아요. {department.programSourceUrl&&<a href={department.programSourceUrl} target="_blank" rel="noreferrer" className={ownedClassName(undefined,true)}>{department.programSourceYear}학년도 공식 전공 안내</a>}</small></label>}
              <div className={ownedClassName(styles.field,true)} aria-busy={calendarLoading}>
                <SchoolPicker label="학생부형 지원 전형" choices={tracks.map(item=>({id:item,label:item,detail:currentCalendar?.trackOptions?.find(option=>option.label===item)?.scope==='school_reference'?'학과 범위 확인 전':undefined}))} value={hasKnownTrack?track:''} onChange={setTrack} placeholder={!completeSelection?'학과를 먼저 선택해 주세요':calendarLoading?'전형 확인 중':tracks.length?'지원 전형을 선택해 주세요':'확인된 학생부형 전형 없음'} disabled={!completeSelection||busy||calendarLoading||!tracks.length}/>
                {completeSelection&&!calendarLoading&&currentCalendar&&(!tracks.length||track&&!ready)&&<p className={ownedClassName(styles.sourceNote,true)}>{!tracks.length?'이 학과에서 확인된 학생부형 면접 전형이 없어요. 다른 학과를 선택해 주세요.':'지원할 전형을 위 목록에서 다시 선택해 주세요.'}{editing?' 기존 지원 정보와 학습 기록은 저장 전까지 그대로 유지돼요.':''}</p>}
                {calendarError&&<div className={ownedClassName(styles.error,true)}><Alert>{calendarError}</Alert><button type="button" className={ownedClassName(styles.linkButton,true)} onClick={retryCalendar}>전형 다시 확인</button></div>}
                {ready&&currentCalendar&&<p className={ownedClassName(styles.sourceNote,true)}>{currentCalendar.matched.length?'면접일 · '+currentCalendar.matched.map(dateRange).join(' · '):currentCalendar.statusLabel}{tracks.length===1?' · 해당 학생부형 전형을 선택했어요.':''}</p>}
              </div>
              {(other||manualMajor)&&<label className={ownedClassName(undefined,true)}>캠퍼스<input value={campus} onChange={event=>setCampus(event.target.value)} maxLength={100} placeholder="캠퍼스명 (선택)" className={ownedClassName(undefined,true)}/></label>}
            </div>
            {(other||manualMajor)&&<p className={ownedClassName(styles.sourceNote,true)}>직접 입력한 학교·학과는 확인 전이에요. 모집요강과 함께 확인해 주세요.</p>}
            <div className={ownedClassName(styles.actions,true)}><button type="button" className={ownedClassName(styles.back,true)} onClick={()=>goTo(0)}><ArrowLeft size={15}/>학교 선택</button><button className={ownedClassName("button primary",true)} disabled={!ready}>다음<ArrowRight size={17}/></button></div>
          </>}
          {step===2&&<>
            <div className={ownedClassName(styles.reviewIdentity,true)}><SchoolLogo school={selected||{university:universityName}} size={42}/><div className={ownedClassName(undefined,true)}><h3 className={ownedClassName(undefined,true)}>{universityName}</h3><p className={ownedClassName(undefined,true)}>{majorName} · {track} · {admissionYear}학년도</p></div><button type="button" className={ownedClassName(styles.linkButton,true)} onClick={()=>goTo(1)}>수정</button></div>
            <div className={ownedClassName(styles.calendar,true)} aria-live="polite">{calendarLoading||(!currentCalendar&&!calendarError)?<Spinner/>:currentCalendar?<SchoolCalendarReview calendar={currentCalendar}/>:null}</div>
            {calendarError&&<div className={ownedClassName(styles.error,true)}><Alert>{calendarError}</Alert><button type="button" className={ownedClassName(styles.linkButton,true)} onClick={retryCalendar}>일정 다시 조회<ArrowRight size={14}/></button></div>}
            <label className={ownedClassName(styles.ack,true)}><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} disabled={!ready} className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}>{currentCalendar?.matched.length?'학교 공개 일정이며 개인 응시 시간은 별도 발표되는 것을 확인했어요.':'일정 확인 상태를 확인했어요. 날짜나 면접 여부가 확정되기 전에는 개인 일정으로 등록되지 않아요.'}</span></label>
            <div className={ownedClassName(styles.actions,true)}><button type="button" className={ownedClassName(styles.back,true)} onClick={()=>goTo(1)}><ArrowLeft size={15}/>학과·전형</button><ActionButton type="submit" className={ownedClassName("button primary")} disabled={!ready||!acknowledged} pending={busy} pendingLabel={editing?'변경 내용 저장 중':'학교 등록 중'}>{editing?'변경 내용 저장':selectedSchools.length>1?schoolIndex<selectedSchools.length-1?'다음 대학':`${selectedSchools.length}개 대학 등록`:'학교 등록'}<ArrowRight size={17}/></ActionButton></div>
          </>}
          {saveError&&<div className={ownedClassName(styles.error,true)}><Alert>{saveError}</Alert></div>}
        </section>
      </fieldset></form>
      <aside className={ownedClassName(styles.summary,true)} data-step={step} aria-label="선택한 지원 정보">
        <div className={ownedClassName(styles.summaryTop,true)}><Logo size={34} wordmark={false}/><span className={ownedClassName(undefined,true)}>나의 면접 준비</span><span className={ownedClassName(undefined,true)}>{admissionYear}학년도</span></div>
        <h2 className={ownedClassName(undefined,true)}>{universityName||'선택한 지원 정보'}</h2>
        <dl className={ownedClassName(styles.summaryDetails,true)}><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>지원 학교</dt><dd data-pending={!universityName} className={ownedClassName(undefined,true)}>{universityName||'학교 선택 전'}</dd></div><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>학과·학부</dt><dd data-pending={!majorName} className={ownedClassName(undefined,true)}>{majorName||'학과 선택 전'}</dd></div><div className={ownedClassName(undefined,true)}><dt className={ownedClassName(undefined,true)}>지원 전형</dt><dd data-pending={!track.trim()} className={ownedClassName(undefined,true)}>{track.trim()||'전형 선택 전'}</dd></div></dl>
        <div className={ownedClassName(styles.summarySchedule,true)}><CalendarDays size={20}/><div className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{calendarLoading?'면접 일정 조회 중':track.trim()&&currentCalendar?currentCalendar.statusLabel:'전형 선택 후 일정 조회'}</span><p className={ownedClassName(undefined,true)}>{track.trim()&&currentCalendar?currentCalendar.matched.length?currentCalendar.matched.map(dateRange).join(' · '):visibleCalendarSourceText(currentCalendar.note):`${admissionYear}학년도`}</p></div></div>
      </aside>
    </div>
  </div>;
}
function RegisteredSchoolList({targets,currentId,finish=false}:{targets:Item[];currentId?:string;finish?:boolean}){
  if(!targets.length)return null;
  return <section className={ownedClassName(styles.savedSection,true)} aria-label="등록한 지원 학교"><div className={ownedClassName(styles.savedHeading,true)}><h2 className={ownedClassName(undefined,true)}>등록한 지원 학교 <span className={ownedClassName(undefined,true)}>{targets.length}개</span></h2>{finish&&<Link href="/my">등록 마치고 시작<ArrowRight size={14}/></Link>}</div><ul className={ownedClassName(styles.savedList,true)}>{targets.map(target=><li className={ownedClassName(styles.savedItem,true)} key={target.id}><SchoolLogo school={target} size={38}/><div className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{target.university}</span><p className={ownedClassName(undefined,true)}>{[target.department||target.major,target.admission_type||target.track].filter(Boolean).join(' · ')}</p></div>{currentId===target.id&&<span className={ownedClassName(styles.savedCheck,true)}><Check size={13}/>저장됨</span>}</li>)}</ul></section>;
}
function SchoolCalendarReview({calendar}:{calendar:SchoolCalendarPreview}){
  const days=(item:SchoolCalendarPreview['matched'][number])=>item.startDate===item.endDate?scheduleDateLabel(item.startDate):`${scheduleDateLabel(item.startDate)}–${scheduleDateLabel(item.endDate)}`;
  return <section className={ownedClassName("school-calendar-review",true)} aria-labelledby="school-calendar-review-title"><div className={ownedClassName("section-heading",true)}><h2 id="school-calendar-review-title" className={ownedClassName(undefined,true)}><CalendarDays size={20}/>면접 일정</h2><span className={ownedClassName("school-calendar-state",true)} data-status={calendar.status}>{calendar.statusLabel}</span></div>
    <p className={ownedClassName(undefined,true)}>{visibleCalendarSourceText(calendar.note)}</p>
    {calendar.matched.length>0&&<ul className={ownedClassName("school-calendar-dates",true)}>{calendar.matched.map(item=><li key={item.id} className={ownedClassName(undefined,true)}><div className={ownedClassName(undefined,true)}><time dateTime={item.startDate} className={ownedClassName(undefined,true)}>{days(item)}</time><span className={ownedClassName(undefined,true)}>{item.format==='video_submission'?'동영상 면접 제출기간':item.trackLabel} · {item.matchedDepartment||calendar.department}</span>{visibleCalendarSourceText(item.note)&&<small className={ownedClassName(undefined,true)}>{visibleCalendarSourceText(item.note)}</small>}</div>{visibleCalendarSourceUrl(item.sourceUrl)&&<a href={visibleCalendarSourceUrl(item.sourceUrl)} target="_blank" rel="noreferrer" className={ownedClassName(undefined,true)}>{visibleCalendarSourceLabel(item.sourceLabel,item.sourceUrl)||'일정'} 원문<ArrowUpRight size={14}/></a>}</li>)}</ul>}
    {visibleCalendarSourceUrl(calendar.decisionSourceUrl)&&<a className={ownedClassName("school-source-link",true)} href={visibleCalendarSourceUrl(calendar.decisionSourceUrl)} target="_blank" rel="noreferrer">{visibleCalendarSourceLabel(calendar.decisionSourceLabel,calendar.decisionSourceUrl)||'일정'} 확인 근거<ArrowUpRight size={14}/></a>}
    {calendar.references.length>0&&<details className={ownedClassName("school-calendar-reference",true)}><summary className={ownedClassName(undefined,true)}>학교 참고 일정 {calendar.references.length}개</summary><ul className={ownedClassName(undefined,true)}>{calendar.references.map(item=><li key={item.id} className={ownedClassName(undefined,true)}><span className={ownedClassName(undefined,true)}>{days(item)} · {item.trackLabel}</span>{visibleCalendarSourceUrl(item.sourceUrl)&&<a href={visibleCalendarSourceUrl(item.sourceUrl)} target="_blank" rel="noreferrer" className={ownedClassName(undefined,true)}>원문<ArrowUpRight size={13}/></a>}</li>)}</ul></details>}
    {!!calendar.unresolved.length&&<div className={ownedClassName("school-calendar-unresolved",true)}>{calendar.unresolved.filter(item=>item.trackLabel===calendar.track).map((item,index)=><p key={index} className={ownedClassName(undefined,true)}>{item.trackLabel} · {visibleCalendarSourceText(item.rawDate)}<small className={ownedClassName(undefined,true)}>{visibleCalendarSourceText(item.reason)}</small></p>)}</div>}
    <p className={ownedClassName("school-calendar-checked",true)}><time dateTime={calendar.checkedAt} className={ownedClassName(undefined,true)}>{scheduleDateLabel(calendar.checkedAt)} 확인</time>{calendar.stale&&<span className={ownedClassName(undefined,true)}>마지막 확인 자료 · 입학처 원문을 함께 확인해 주세요.</span>}</p>
    {!calendar.matched.length&&calendar.officialSources.some(source=>visibleCalendarSourceUrl(source.url))&&<details className={ownedClassName("school-calendar-reference",true)}><summary className={ownedClassName(undefined,true)}>입학처 자료</summary>{calendar.officialSources.filter(source=>visibleCalendarSourceUrl(source.url)).map(source=><a className={ownedClassName("school-source-link",true)} key={source.url} href={source.url} target="_blank" rel="noreferrer">{visibleCalendarSourceText(source.title)}<ArrowUpRight size={13}/></a>)}</details>}
  </section>;
}

