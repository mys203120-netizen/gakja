'use client';
import {ownedClassName} from './owned-class-name';

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import gsap from 'gsap';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, LayoutGrid, BookOpen, MessagesSquare, Sparkles, ChartNoAxesCombined, Settings2, Bell, LogOut, Users, Upload, History, ListChecks, Library, ChevronLeft, ChevronRight, Search, Check, X, Ellipsis, ChevronDown, LockKeyhole } from 'lucide-react';
import { api, post, Logo, Spinner, Alert, Modal, Badge, FloatingNotice, targetName, targetMajor, type Bootstrap, type Item } from './shared';
import { PageMotion } from './motion';
import { AccountMenu } from './account-menu';
import { ResourcePanel, type Resource } from './resource-panel';
import { StudySessionProvider, finishStudySession } from './study-session-provider';
import { SchoolLogo } from './school-logo';
import { studentOnboardingDestination } from '@/lib/student-onboarding';
import { normalizeMaterialQuery, searchStudentMaterials } from '@/lib/material-search';
import shellStyles from './shell-refinement.module.css';
import railStyles from './navigation-rail.module.css';
import {STUDENT_NAVIGATION,MOBILE_STUDENT_NAVIGATION,mobileStudentActive,studentSection} from '@/lib/app-navigation';
import {SectionNavigation} from './section-navigation';
import {HelpPreferencesProvider} from './help-preferences';
import {MobileTabSwipe} from './mobile-tab-swipe';
import {MobileScrollNavigation} from './mobile-scroll-navigation';
import {useRecordPages} from './use-record-pages';
import {flushPendingDrafts} from '@/lib/client/draft-save';
const Context = createContext<{ data: Bootstrap; learningRevision:number; target: Item | undefined; targetId: string; setTargetId: (id: string) => void; refresh: () => Promise<void>; toast: (message: string) => void; openResource: (resource: Resource) => void } | null>(null);
export function useApp() { const ctx = useContext(Context); if (!ctx) throw new Error('App context missing'); return ctx; }
const studentIcons={today:ListChecks,preparation:Library,records:History};
const studentNav=STUDENT_NAVIGATION.map(item=>({...item,short:item.label,icon:studentIcons[item.id]}));
const adminNav = [{href:'/admin',label:'운영 현황',short:'현황',icon:LayoutGrid},{href:'/admin/students',label:'학생 관리',short:'학생',icon:Users},{href:'/admin/assignments',label:'학습 과제',short:'과제',icon:ListChecks},{href:'/admin/schools',label:'대학별 면접 기준',short:'면접',icon:Library},{href:'/admin/schedules',label:'면접 일정',short:'일정',icon:History},{href:'/admin/imports',label:'콘텐츠 등록',short:'등록',icon:Upload},{href:'/admin/content',label:'콘텐츠 이력',short:'이력',icon:History},{href:'/admin/reviews',label:'검수·확인',short:'검수',icon:ListChecks},{href:'/admin/knowledge',label:'공용 자료',short:'자료',icon:BookOpen},{href:'/admin/settings',label:'운영 설정',short:'설정',icon:Settings2}];
export function AppShell({children,admin=false}:{children:React.ReactNode;admin?:boolean}) {
 const path = usePathname(); const router = useRouter(); const [data,setData]=useState<Bootstrap|null>(null); const [error,setError]=useState(''); const [targetId,setTarget]=useState(''); const [notification,setNotification]=useState(false); const [search,setSearch]=useState(false); const [term,setTerm]=useState(''); const [toastMessage,setToastState]=useState(''); const [toastRevision,setToastRevision]=useState(0); const setToastMessage=useCallback((message:string)=>{setToastState(message);setToastRevision(value=>value+1);},[]);
 const [loggingOut,setLoggingOut]=useState(false); const [resource,setResource]=useState<Resource|null>(null); const [learningRevision,setLearningRevision]=useState(0); const [moreNavigation,setMoreNavigation]=useState(false); const [sidebarCollapsed,setSidebarCollapsed]=useState(false); const searchInput=useRef<HTMLInputElement>(null);
 const [schoolSwitchOpen,setSchoolSwitchOpen]=useState(false); const schoolSwitch=useRef<HTMLDivElement>(null);
 const sidebarNavigation=useRef<HTMLDivElement>(null); const sidebarSelection=useRef<HTMLSpanElement>(null); const selectionPositioned=useRef(false); const selectionDestination=useRef<{x:number;y:number;width:number;height:number}|null>(null);
 const closeResource=useCallback(()=>setResource(null),[]);
 useEffect(()=>{try{setSidebarCollapsed(localStorage.getItem('gakja-sidebar-collapsed')==='true');}catch{/* Keep navigation usable when browser storage is unavailable. */}},[]);
 function toggleSidebar(){const next=!sidebarCollapsed;setSidebarCollapsed(next);try{localStorage.setItem('gakja-sidebar-collapsed',String(next));}catch{/* Collapsing still works without persistence. */}}
 const onboardingDestination=studentOnboardingDestination(data,path,admin);
 const initialSchoolSetup=studentOnboardingDestination(data,'/my',admin)!==null;
 useEffect(()=>{if(onboardingDestination)router.replace(onboardingDestination);},[onboardingDestination,router]);
 const refreshSequence=useRef(0);
 const refresh=useCallback(async()=>{ const sequence=++refreshSequence.current; try { const next=await api<Bootstrap>('/api/bootstrap'); if(sequence!==refreshSequence.current)return; setData(next); setLearningRevision(value=>value+1); setTarget(prev => {const saved=prev||next.preferences?.selectedTargetId||sessionStorage.getItem(`gakja-target:${next.user.id}`);return next.targets?.some(t=>t.id===saved) ? saved : next.targets?.[0]?.id || '';}); setError(''); } catch(err) { if(sequence===refreshSequence.current)setError((err as Error).message); } },[]);
 useEffect(()=>{void refresh();return()=>{refreshSequence.current++;};},[refresh]); useEffect(()=>{setSearch(false);setNotification(false);setMoreNavigation(false);setSchoolSwitchOpen(false);},[path]);
 useEffect(()=>{if(!schoolSwitchOpen)return;const close=(event:PointerEvent)=>{if(!schoolSwitch.current?.contains(event.target as Node))setSchoolSwitchOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[schoolSwitchOpen]);
 useEffect(()=>{
  const navigation=sidebarNavigation.current; const selection=sidebarSelection.current;
  if(!navigation||!selection)return;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)'); let frame=0;
  function place(animate:boolean,force=false){
   if(!navigation||!selection)return;
   const selected=navigation.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
   if(!selected||navigation.clientWidth===0){gsap.set(selection,{opacity:0});navigation.dataset.motionReady='false';return;}
   const linkBox=selected.getBoundingClientRect();const navBox=navigation.getBoundingClientRect();
   const position={x:linkBox.left-navBox.left+navigation.scrollLeft,y:linkBox.top-navBox.top+navigation.scrollTop,width:linkBox.width,height:linkBox.height,opacity:1};
   const previous=selectionDestination.current;
   if(!force&&!animate&&navigation.dataset.motionReady==='true'&&previous&&previous.x===position.x&&previous.y===position.y&&previous.width===position.width&&previous.height===position.height)return;
   selectionDestination.current=position;
   navigation.dataset.motionReady='true';
   if(!selectionPositioned.current||!animate||reduced.matches){gsap.killTweensOf(selection);gsap.set(selection,position);}
   else gsap.to(selection,{...position,duration:.22,ease:'power3.out',overwrite:'auto'});
   selectionPositioned.current=true;
  }
  function remeasure(){window.cancelAnimationFrame(frame);frame=window.requestAnimationFrame(()=>place(false));}
  function motionPreferenceChanged(){place(false,true);}
  place(true);
  const observer=new ResizeObserver(remeasure);observer.observe(navigation);
  navigation.querySelectorAll('nav,a').forEach(element=>observer.observe(element));
  window.addEventListener('resize',remeasure);reduced.addEventListener('change',motionPreferenceChanged);
  return()=>{window.cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',remeasure);reduced.removeEventListener('change',motionPreferenceChanged);gsap.killTweensOf(selection);};
 },[path,admin]);
 const nav=admin?adminNav:studentNav; const active=(href:string)=> !admin ? Boolean(studentSection(href)&&studentSection(path)===studentSection(href)) : href==='/admin'?path==='/admin':href==='/interview'?(path.startsWith('/interview')||path.startsWith('/chat/interviews')||path.startsWith('/practice/video')):href==='/quiz'?(path.startsWith('/quiz')||(path.startsWith('/practice')&&!path.startsWith('/practice/video'))):href==='/records'?(path.startsWith('/records')||path.startsWith('/reports')):path===href||path.startsWith(href+'/');
 const adminPrimaryPaths=['/admin','/admin/students','/admin/assignments','/admin/schedules'];
 const mobileNav=admin?adminPrimaryPaths.map(href=>adminNav.find(item=>item.href===href)!):initialSchoolSetup?[]:MOBILE_STUDENT_NAVIGATION.map(item=>({...item,short:item.label,icon:studentIcons[item.id]}));
 const mobileActive=(href:string)=>admin?active(href):mobileStudentActive(path,href);
 const assistantWorkspace=!admin&&(path==='/on'||path.startsWith('/on/'))&&!(path==='/on/interviews'||path.startsWith('/on/interviews/'));
 const moreNav=admin?adminNav.filter(item=>!adminPrimaryPaths.includes(item.href)):[];
 const canSearch=Boolean(data&&(admin||data.targets?.length));
 const searchResults=canSearch?searchStudentMaterials(data?.learning,term,targetId):[]; const hasSearchTerm=Boolean(normalizeMaterialQuery(term));
 function openSearch(){if(!canSearch)return;setSearch(true);}
 async function logout(){setLoggingOut(true);try{if(data?.user?.id)await flushPendingDrafts(data.user.id);if(!admin)await finishStudySession('logout');await post('/api/auth',{action:'logout'});try{if(data?.user?.id)sessionStorage.removeItem(`gakja-target:${data.user.id}`);}catch{/* Cached selection cannot block a completed logout. */}window.location.replace('/login');}catch(cause){setLoggingOut(false);throw cause;}}
 function openAssistant(event:React.MouseEvent){const pause=new Event('gakja:open-on',{cancelable:true});window.dispatchEvent(pause);if(pause.defaultPrevented)event.preventDefault();}
 const target=data?.targets?.find(t=>t.id===targetId); const notificationRecords=useRecordPages('notifications','',Boolean(notification&&data?.user?.role==='student'),data?.user?.id||'');
 const visibleNotifications=data?.preferences?.notificationsEnabled===false?[]:notificationRecords.items;
 const unreadNotificationCount=data?.preferences?.notificationsEnabled===false?0:Number(data?.summary?.unread_notifications||0);
 const readingNotifications=useRef(false);
 async function openNotifications(){
  setNotification(true);
  if(!unreadNotificationCount||readingNotifications.current)return;
  readingNotifications.current=true;
  const timestamp=new Date().toISOString();
  setData(previous=>previous?{...previous,summary:{...previous.summary,unread_notifications:0}}:previous);
  try{await post('/api/actions',{action:'mark_read',payload:{all:true}});}
  catch{await refresh();setToastMessage('읽음 상태를 저장하지 못했어요. 다시 확인해 주세요.');}
  finally{readingNotifications.current=false;}
 }
 function setTargetId(id:string){if(!data?.targets?.some(t=>t.id===id))return;setTarget(id);sessionStorage.setItem(`gakja-target:${data.user.id}`,id);setData(previous=>previous?{...previous,preferences:{...previous.preferences,selectedTargetId:id}}:previous);void post('/api/actions',{action:'preference',payload:{selectedTargetId:id}}).catch(()=>setToastMessage('지원처 선택을 저장하지 못했어요.'));}
 return <div inert={loggingOut||undefined} aria-busy={loggingOut||undefined} className={ownedClassName(`app-shell ${shellStyles.shell} ${railStyles.collapsibleShell} ${admin?'admin-shell':railStyles.studentShell} ${assistantWorkspace?'assistant-shell':''}`,true)} data-sidebar-collapsed={sidebarCollapsed?'true':'false'} data-school-setup={initialSchoolSetup?'true':undefined}>
 <a className={ownedClassName("skip-content",true)} href="#main-content">본문으로 건너뛰기</a>
  <button type="button" className={ownedClassName(railStyles.collapseToggle,true)} onClick={toggleSidebar} aria-label={sidebarCollapsed?'메뉴 펼치기':'메뉴 접기'} title={sidebarCollapsed?'메뉴 펼치기':'메뉴 접기'} aria-expanded={!sidebarCollapsed} aria-controls="desktop-navigation"><ChevronLeft size={14} aria-hidden="true"/></button>
 <aside className={ownedClassName("sidebar",true)}>
  <Link className={ownedClassName("sidebar-brand")} href={admin?'/admin':'/my'} aria-label={admin?'관리자 홈':'각자ON 홈'}>{admin?<><Logo size={36} wordmark={false}/><span className={ownedClassName("admin-caption",true)}>관리자</span></>:<><Logo size={36} wordmark={false}/><span className={ownedClassName("service-wordmark",true)}><span aria-hidden="true" className={ownedClassName(undefined,true)}>각자</span><sup className={ownedClassName("brand-on-sup",true)}><img className={ownedClassName("brand-on-image",true)} src="/brand-on.png" alt="" width={26} height={15}/></sup><span className={ownedClassName("sr-only",true)}>각자ON</span></span></>}</Link>
  {!admin&&<p className={ownedClassName(railStyles.sidebarNote,true)}>나의 경험을, 나만의 답으로.</p>}
  <div className={ownedClassName("sidebar-navigation",true)} ref={sidebarNavigation}>
   <span className={ownedClassName("sidebar-selection",true)} ref={sidebarSelection} aria-hidden="true" />
   <nav className={ownedClassName("main-nav",true)} id="desktop-navigation" aria-label={admin?'운영 메뉴':'학습 메뉴'}>{nav.map(n=>{
    const description='description' in n&&typeof n.description==='string'?n.description:undefined;
    const accessibleLabel=description?`${n.label} · ${description}`:n.label;
    if(!admin&&initialSchoolSetup)return <Link href={n.href} key={n.href} aria-disabled="true" tabIndex={-1} className={ownedClassName(railStyles.lockedNavigationItem)} aria-label={n.label+' · 학교 등록 후 이용'} title="학교 등록 후 이용할 수 있어요" onClick={event=>event.preventDefault()}><n.icon size={20} strokeWidth={1.7} aria-hidden="true" className={ownedClassName(undefined,true)}/><span className={ownedClassName(railStyles.navigationLabel,true)}>{n.label}</span><LockKeyhole size={12} className={ownedClassName(railStyles.navigationLock)} aria-hidden="true"/></Link>;
    return <Link href={n.href} key={n.href} className={ownedClassName(active(n.href)?'active':'')} aria-current={active(n.href)?'page':undefined} aria-label={accessibleLabel} title={accessibleLabel} onClick={n.href==='/on'?openAssistant:undefined}><n.icon size={20} strokeWidth={1.7} aria-hidden="true" className={ownedClassName(undefined,true)}/><span className={ownedClassName(railStyles.navigationLabel,true)}>{n.label}{description&&<small className={ownedClassName(railStyles.navigationDescription,true)}>{description}</small>}</span></Link>;
   })}</nav>
  </div>
  <div className={ownedClassName("sidebar-account",true)}><AccountMenu name={data?.user?.name||'내 계정'} admin={admin} onLogout={logout}/></div>
 </aside>
 <div className={ownedClassName("app-body",true)}><header className={ownedClassName("topbar",true)}><div className={ownedClassName("topbar-context",true)}>{admin&&<Link href="/admin" className={ownedClassName("mobile-brand")} aria-label="관리자 홈"><Logo size={25} wordmark={false}/></Link>}{assistantWorkspace&&<Link href="/my" className={ownedClassName("assistant-back icon-button")} aria-label="오늘로 돌아가기"><ArrowLeft size={22}/></Link>}{!admin&&target&&<SchoolLogo school={target} size={24}/>}{!admin&&data?.targets?.length?<div className={ownedClassName(railStyles.targetSwitcher,true)} ref={schoolSwitch} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setSchoolSwitchOpen(false);}} onKeyDown={event=>{
  const menu=schoolSwitch.current?.querySelector<HTMLElement>('[role="menu"]');
  const options=Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')||[]);
  if(event.key==='Escape'){event.preventDefault();setSchoolSwitchOpen(false);schoolSwitch.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus({preventScroll:true});}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(!schoolSwitchOpen){setSchoolSwitchOpen(true);requestAnimationFrame(()=>schoolSwitch.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus({preventScroll:true}));}else{const current=options.indexOf(document.activeElement as HTMLButtonElement);const index=event.key==='Home'?0:event.key==='End'?options.length-1:event.key==='ArrowDown'?(current+1)%options.length:(current-1+options.length)%options.length;options[index]?.focus({preventScroll:true});}}
 }}><button type="button" className={ownedClassName(railStyles.targetTrigger,true)} aria-label={`지원 학교 변경 · ${target?targetName(target)+' '+targetMajor(target):'지원처 선택'}`} aria-haspopup="menu" aria-expanded={schoolSwitchOpen} onClick={()=>setSchoolSwitchOpen(value=>!value)}><span className={ownedClassName("target-copy",true)} aria-hidden="true"><strong className={ownedClassName(undefined,true)}>{target?targetName(target):'지원처 선택'}</strong><small className={ownedClassName(undefined,true)}>{target?targetMajor(target):''}</small></span><ChevronDown size={15} aria-hidden="true"/></button>{schoolSwitchOpen&&<div className={ownedClassName(railStyles.targetMenu,true)} role="menu" aria-label="지원 학교 선택"><p className={ownedClassName(undefined,true)}>지원 학교</p>{data.targets.map(t=><button type="button" role="menuitemradio" aria-checked={targetId===t.id} key={t.id} onClick={()=>{setTargetId(t.id);setSchoolSwitchOpen(false);schoolSwitch.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus({preventScroll:true});}} className={ownedClassName(undefined,true)}><SchoolLogo school={t} size={27}/><span className={ownedClassName(undefined,true)}><strong className={ownedClassName(undefined,true)}>{targetName(t)}</strong><small className={ownedClassName(undefined,true)}>{targetMajor(t)}</small></span>{targetId===t.id&&<Check size={17} aria-hidden="true"/>}</button>)}<Link href="/schools" onClick={()=>setSchoolSwitchOpen(false)}>지원 학교 관리<ChevronRight size={14}/></Link></div>}</div>:!admin&&(data?<Link href="/schools/new?onboarding=1" className={ownedClassName(railStyles.unregisteredBrand)} aria-label="각자ON · 지원 학교 선택"><Logo size={30} wordmark={false}/><span className={ownedClassName("service-wordmark",true)} aria-hidden="true"><span className={ownedClassName(undefined,true)}>각자</span><sup className={ownedClassName("brand-on-sup",true)}><img className={ownedClassName("brand-on-image",true)} src="/brand-on.png" alt="" width={26} height={15}/></sup></span></Link>:<div className={ownedClassName(railStyles.targetPending,true)} role="status" aria-label="지원 정보 불러오는 중"><span className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}/></div>)}</div><div className={ownedClassName("topbar-actions",true)}>{canSearch&&<button className={ownedClassName("icon-button",true)} onClick={openSearch} aria-label="자료 검색" title="자료 검색"><Search size={19}/></button>}<button className={ownedClassName("icon-button notification-button",true)} onClick={()=>void openNotifications()} aria-label="알림" title="알림"><Bell size={19}/>{unreadNotificationCount>0&&<i className={ownedClassName(undefined,true)}/>}</button><div className={ownedClassName(railStyles.mobileAccount,true)}><AccountMenu name={data?.user?.name||'내 계정'} admin={admin} compact onLogout={logout}/></div></div></header><main id="main-content" tabIndex={-1} className={ownedClassName("main-content",true)}>{error?<div className={ownedClassName("connection-error",true)}><Alert>{error}</Alert><button className={ownedClassName("button primary",true)} onClick={refresh}>다시 불러오기</button></div>:!data||onboardingDestination?<Spinner/>:<Context.Provider value={{data,learningRevision,target,targetId,setTargetId,refresh,toast:setToastMessage,openResource:setResource}}><HelpPreferencesProvider enabled={data.preferences?.helpEnabled!==false}><MobileTabSwipe enabled={!admin&&!initialSchoolSetup}/>{admin?<PageMotion>{children}</PageMotion>:<StudySessionProvider userId={data.user.id}><PageMotion>{!initialSchoolSetup&&<SectionNavigation/>}{children}</PageMotion></StudySessionProvider>}{resource&&<ResourcePanel data={resource.snapshot?{...data,...resource.snapshot}:data} resource={resource} onClose={closeResource} onSelect={r=>setResource({...r,snapshot:resource.snapshot})}/>}</HelpPreferencesProvider></Context.Provider>}</main><footer className={ownedClassName("app-footer",true)}><span className={ownedClassName(undefined,true)}>각자ON · 각자의답 © {new Date().getFullYear()}</span></footer></div>{mobileNav.length>0&&<nav className={ownedClassName(`mobile-nav ${admin?shellStyles.mobilePrimary:''}`,true)} aria-label="주 메뉴" data-ready={data?'true':'false'}>{mobileNav.map(n=><Link onClick={n.href==='/on'?openAssistant:undefined} href={n.href} key={n.href} aria-label={n.label} title={n.label} aria-current={mobileActive(n.href)?'page':undefined} className={ownedClassName(mobileActive(n.href)?'active':'')}>{!admin&&n.href==='/my'?<Logo size={25} wordmark={false}/>:<n.icon size={22} strokeWidth={1.8} className={ownedClassName(undefined,true)}/>}<span className={ownedClassName("sr-only",true)}>{n.short}</span></Link>)}{admin&&<button type="button" aria-label="운영 메뉴 더보기" aria-haspopup="dialog" aria-expanded={moreNavigation} data-active={moreNav.some(item=>active(item.href))?'true':'false'} onClick={()=>setMoreNavigation(true)} className={ownedClassName(undefined,true)}><Ellipsis size={20}/><span className={ownedClassName(undefined,true)}>더보기</span></button>}</nav>}{mobileNav.length>0&&<MobileScrollNavigation/>}{toastMessage&&<FloatingNotice key={toastRevision} onDismiss={()=>setToastState('')}>{toastMessage}</FloatingNotice>}{notification&&<Modal title="알림" onClose={()=>setNotification(false)}>{notificationRecords.loading&&!visibleNotifications.length?<Spinner/>:notificationRecords.error?<Alert>{notificationRecords.error}</Alert>:visibleNotifications.length?visibleNotifications.map(n=><div className={ownedClassName("notification-item",true)} key={n.id}><strong className={ownedClassName(undefined,true)}>{n.title||n.data?.title||'자료가 발행됐어요'}</strong><p className={ownedClassName(undefined,true)}>{n.message||n.data?.message||n.body}</p></div>):<p className={ownedClassName("muted",true)}>{data?.preferences?.notificationsEnabled===false?<>앱 알림이 꺼져 있어요. <Link href="/account/settings">알림 설정</Link></>:'새로운 알림이 없어요.'}</p>}{notificationRecords.page?.hasMore&&<button className={ownedClassName("button ghost",true)} disabled={notificationRecords.loading} onClick={()=>void notificationRecords.more()}>더 보기</button>}</Modal>}{search&&canSearch&&<Modal title="나의 자료 검색" onClose={()=>setSearch(false)} initialFocusRef={searchInput}><p className={ownedClassName(shellStyles.searchScope,true)}>{targetId?'내 학생부 활동과 선택한 지원처의 예상·공통 질문을 검색해요.':'내 학생부 활동과 예상 질문을 검색해요.'}</p><div className={ownedClassName("search-field",true)}><Search size={18}/><input ref={searchInput} aria-label="활동·질문 검색" autoFocus placeholder="활동·질문 검색" value={term} onChange={e=>setTerm(e.target.value)} className={ownedClassName(undefined,true)}/></div><div className={ownedClassName(shellStyles.searchMeta,true)}><p className={ownedClassName(shellStyles.searchCount,true)} role="status" aria-live="polite">{hasSearchTerm?`검색 결과 ${searchResults.length}개`:'찾고 싶은 활동이나 질문을 입력해 주세요.'}</p>{term&&<button type="button" className={ownedClassName(shellStyles.searchReset,true)} onClick={()=>{setTerm('');searchInput.current?.focus();}}>검색 초기화</button>}</div><div className={ownedClassName(shellStyles.searchResults,true)}>{searchResults.map(item=><Link href={item.href} key={item.key} onClick={()=>setSearch(false)}><small className={ownedClassName(undefined,true)}>{item.kind}</small><span className={ownedClassName(undefined,true)}>{item.label}</span></Link>)}{hasSearchTerm&&!searchResults.length&&<div className={ownedClassName(shellStyles.searchEmpty,true)}><p className={ownedClassName(undefined,true)}>검색 결과가 없어요.</p><p className={ownedClassName(undefined,true)}>다른 단어로 검색하거나 지원처 선택을 확인해 주세요.</p></div>}</div></Modal>}{moreNavigation&&admin&&<Modal title="운영 메뉴" onClose={()=>setMoreNavigation(false)}><nav className={ownedClassName(shellStyles.moreLinks,true)} aria-label="추가 운영 메뉴">{moreNav.map(item=><Link href={item.href} key={item.href} aria-current={active(item.href)?'page':undefined} onClick={()=>setMoreNavigation(false)}><item.icon size={19} className={ownedClassName(undefined,true)}/><span className={ownedClassName(undefined,true)}>{item.label}</span></Link>)}</nav></Modal>}</div>;
}


