'use client';
import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import gsap from 'gsap';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutGrid, BookOpen, MessagesSquare, Sparkles, ChartNoAxesCombined, Settings2, Bell, LogOut, Users, Upload, History, ListChecks, Library, PanelLeftClose, Search, X, Ellipsis } from 'lucide-react';
import { api, post, Logo, Spinner, Alert, Modal, Badge, targetName, targetMajor, type Bootstrap, type Item } from './shared';
import { PageMotion } from './motion';
import { AccountMenu } from './account-menu';
import { ResourcePanel, type Resource } from './resource-panel';
import { StudySessionProvider, finishStudySession } from './study-session-provider';
import { SchoolLogo } from './school-logo';
import { studentOnboardingDestination } from '@/lib/student-onboarding';
import { normalizeMaterialQuery, searchStudentMaterials } from '@/lib/material-search';
import shellStyles from './shell-refinement.module.css';
import railStyles from './navigation-rail.module.css';
import {STUDENT_NAVIGATION,studentSection} from '@/lib/app-navigation';
import {SectionNavigation} from './section-navigation';
const Context = createContext<{ data: Bootstrap; learningRevision:number; target: Item | undefined; targetId: string; setTargetId: (id: string) => void; refresh: () => Promise<void>; toast: (message: string) => void; openResource: (resource: Resource) => void } | null>(null);
export function useApp() { const ctx = useContext(Context); if (!ctx) throw new Error('App context missing'); return ctx; }
const studentIcons={today:LayoutGrid,practice:Sparkles,resources:BookOpen,reports:ChartNoAxesCombined,armory:Library};
const studentNav=STUDENT_NAVIGATION.map(item=>({...item,short:item.label,icon:studentIcons[item.id]}));
const adminNav = [{href:'/admin',label:'운영 현황',short:'현황',icon:LayoutGrid},{href:'/admin/students',label:'학생 관리',short:'학생',icon:Users},{href:'/admin/assignments',label:'학습 과제',short:'과제',icon:ListChecks},{href:'/admin/schools',label:'대학별 면접 기준',short:'면접',icon:Library},{href:'/admin/schedules',label:'면접 일정',short:'일정',icon:History},{href:'/admin/imports',label:'콘텐츠 등록',short:'등록',icon:Upload},{href:'/admin/content',label:'콘텐츠 이력',short:'이력',icon:History},{href:'/admin/reviews',label:'검수·확인',short:'검수',icon:ListChecks},{href:'/admin/knowledge',label:'공용 자료',short:'자료',icon:BookOpen},{href:'/admin/settings',label:'운영 설정',short:'설정',icon:Settings2}];
export function AppShell({children,admin=false}:{children:React.ReactNode;admin?:boolean}) {
 const path = usePathname(); const router = useRouter(); const [data,setData]=useState<Bootstrap|null>(null); const [error,setError]=useState(''); const [targetId,setTarget]=useState(''); const [notification,setNotification]=useState(false); const [search,setSearch]=useState(false); const [term,setTerm]=useState(''); const [toastMessage,setToastMessage]=useState('');
 const [resource,setResource]=useState<Resource|null>(null); const [learningRevision,setLearningRevision]=useState(0); const [moreNavigation,setMoreNavigation]=useState(false); const searchInput=useRef<HTMLInputElement>(null);
 const sidebarNavigation=useRef<HTMLDivElement>(null); const sidebarSelection=useRef<HTMLSpanElement>(null); const selectionPositioned=useRef(false); const selectionDestination=useRef<{x:number;y:number;width:number;height:number}|null>(null);
 const closeResource=useCallback(()=>setResource(null),[]);
 const onboardingDestination=studentOnboardingDestination(data,path,admin);
 const initialSchoolSetup=studentOnboardingDestination(data,'/my',admin)!==null;
 useEffect(()=>{if(onboardingDestination)router.replace(onboardingDestination);},[onboardingDestination,router]);
 const refreshSequence=useRef(0);
 const refresh=useCallback(async()=>{ const sequence=++refreshSequence.current; try { const next=await api<Bootstrap>('/api/bootstrap'); if(sequence!==refreshSequence.current)return; setData(next); setLearningRevision(value=>value+1); setTarget(prev => {const saved=prev||next.preferences?.selectedTargetId||sessionStorage.getItem(`gakja-target:${next.user.id}`);return next.targets?.some(t=>t.id===saved) ? saved : next.targets?.[0]?.id || '';}); setError(''); } catch(err) { if(sequence===refreshSequence.current)setError((err as Error).message); } },[]);
 useEffect(()=>{void refresh();return()=>{refreshSequence.current++;};},[refresh]); useEffect(()=>{setSearch(false);setMoreNavigation(false);},[path]); useEffect(()=>{if(!toastMessage)return;const id=setTimeout(()=>setToastMessage(''),3500);return()=>clearTimeout(id);},[toastMessage]);
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
 const nav=admin?adminNav:initialSchoolSetup?[]:studentNav; const active=(href:string)=> !admin ? Boolean(studentSection(href)&&studentSection(path)===studentSection(href)) : href==='/admin'?path==='/admin':href==='/interview'?(path.startsWith('/interview')||path.startsWith('/chat/interviews')||path.startsWith('/practice/video')):href==='/quiz'?(path.startsWith('/quiz')||(path.startsWith('/practice')&&!path.startsWith('/practice/video'))):href==='/records'?(path.startsWith('/records')||path.startsWith('/reports')):path===href||path.startsWith(href+'/');
 const adminPrimaryPaths=['/admin','/admin/students','/admin/assignments','/admin/schedules'];
 const mobileNav=admin?adminPrimaryPaths.map(href=>adminNav.find(item=>item.href===href)!):nav;
 const moreNav=admin?adminNav.filter(item=>!adminPrimaryPaths.includes(item.href)):[];
 const searchResults=searchStudentMaterials(data?.learning,term,targetId); const hasSearchTerm=Boolean(normalizeMaterialQuery(term));
 async function logout(){if(!admin)await finishStudySession('logout');await post('/api/auth',{action:'logout'});for(const key of Object.keys(sessionStorage)){if(key.startsWith('gakja-')||key.startsWith('interview-draft:'))sessionStorage.removeItem(key);}setResource(null);router.push('/login');router.refresh();}
 function openAssistant(event:React.MouseEvent){const pause=new Event('gakja:open-on',{cancelable:true});window.dispatchEvent(pause);if(pause.defaultPrevented)event.preventDefault();}
 const workspaceLabel=studentNav.find(item=>item.id===studentSection(path))?.label||(path.startsWith('/on')?'AI 비서':path.startsWith('/account')?'내 계정':'각자ON');
 const target=data?.targets?.find(t=>t.id===targetId); const visibleNotifications=data?.preferences?.notificationsEnabled===false?[]:(data?.notifications||[]);
 const unreadNotifications=visibleNotifications.filter(n=>!n.read_at);
 const readingNotifications=useRef(false);
 async function openNotifications(){
  setNotification(true);
  if(!unreadNotifications.length||readingNotifications.current)return;
  readingNotifications.current=true;
  const timestamp=new Date().toISOString();
  setData(previous=>previous?{...previous,notifications:previous.notifications.map(n=>n.read_at?n:{...n,read_at:timestamp})}:previous);
  try{await post('/api/actions',{action:'mark_read',payload:{all:true}});}
  catch{await refresh();setToastMessage('읽음 상태를 저장하지 못했어요. 다시 확인해 주세요.');}
  finally{readingNotifications.current=false;}
 }
 function setTargetId(id:string){if(!data?.targets?.some(t=>t.id===id))return;setTarget(id);sessionStorage.setItem(`gakja-target:${data.user.id}`,id);setData(previous=>previous?{...previous,preferences:{...previous.preferences,selectedTargetId:id}}:previous);void post('/api/actions',{action:'preference',payload:{selectedTargetId:id}}).catch(()=>setToastMessage('지원처 선택을 저장하지 못했어요.'));}
 return <div className={`app-shell ${shellStyles.shell} ${admin?'admin-shell':railStyles.studentShell}`}>
 <a className="skip-content" href="#main-content">본문으로 건너뛰기</a><aside className="sidebar">
  <Link className="sidebar-brand" href={admin?'/admin':'/my'} aria-label={admin?'관리자 홈':'각자ON 홈'}>{admin?<><Logo size={36}/><span className="admin-caption">관리자</span></>:<><Logo size={36} wordmark={false}/><span className="service-wordmark">각자ON</span></>}</Link>
  <div className="sidebar-navigation" ref={sidebarNavigation}>
   <span className="sidebar-selection" ref={sidebarSelection} aria-hidden="true" />
   <nav className="main-nav" aria-label={admin?'운영 메뉴':'학습 메뉴'}>{nav.map(n=><Link href={n.href} key={n.href} className={active(n.href)?'active':''} aria-current={active(n.href)?'page':undefined} aria-label={n.label} title={admin?n.label:undefined}><n.icon size={20} strokeWidth={1.7}/><span className={admin?undefined:railStyles.navigationLabel}>{n.label}</span></Link>)}</nav>
  </div>
  <div className="sidebar-account"><AccountMenu name={data?.user?.name||'내 계정'} admin={admin} onLogout={logout}/></div>
 </aside>
 <div className="app-body"><header className="topbar"><div className="topbar-context"><Link href={admin?'/admin':'/my'} className="mobile-brand" aria-label="각자의답 홈"><Logo size={25} wordmark={false}/></Link>{!admin&&<span className={shellStyles.locationLabel}>{workspaceLabel}</span>}{!admin&&target&&<SchoolLogo school={target} size={24}/>}{!admin&&data?.targets?.length?<label className="target-select"><span className="sr-only">지원처 선택</span><select value={targetId} onChange={e=>setTargetId(e.target.value)}>{data.targets.map(t=><option value={t.id} key={t.id}>{targetName(t)} · {targetMajor(t)}</option>)}</select></label>:!admin&&<span className="muted">지원처 미등록</span>}</div><div className="topbar-actions">{!admin&&!initialSchoolSetup&&<Link className={`icon-button ${railStyles.assistantLink}`} href="/on" onClick={openAssistant} aria-label="AI 비서" title="AI 비서"><MessagesSquare size={19}/><span>AI 비서</span></Link>}<button className="icon-button" onClick={()=>setSearch(true)} aria-label="자료 검색" title="자료 검색"><Search size={19}/></button><button className="icon-button notification-button" onClick={()=>void openNotifications()} aria-label="알림" title="알림"><Bell size={19}/>{unreadNotifications.length>0&&<i/>}</button><AccountMenu name={data?.user?.name||'내 계정'} admin={admin} compact onLogout={logout}/></div></header><main id="main-content" tabIndex={-1} className="main-content">{error?<div className="connection-error"><Alert>{error}</Alert><button className="button primary" onClick={refresh}>다시 불러오기</button></div>:!data||onboardingDestination?<Spinner/>:<Context.Provider value={{data,learningRevision,target,targetId,setTargetId,refresh,toast:setToastMessage,openResource:setResource}}>{admin?<PageMotion>{children}</PageMotion>:<StudySessionProvider userId={data.user.id}><PageMotion>{!initialSchoolSetup&&<SectionNavigation/>}{children}</PageMotion></StudySessionProvider>}{resource&&<ResourcePanel data={resource.snapshot?{...data,...resource.snapshot}:data} resource={resource} onClose={closeResource} onSelect={r=>setResource({...r,snapshot:resource.snapshot})}/>}</Context.Provider>}</main><footer className="app-footer"><span>각자ON · 각자의답 © {new Date().getFullYear()}</span></footer></div><nav className={`mobile-nav ${admin?shellStyles.mobilePrimary:''}`} aria-label="주 메뉴">{mobileNav.map(n=><Link onClick={e=>{if(n.href==='/on'){const event=new Event('gakja:open-on',{cancelable:true});window.dispatchEvent(event);if(event.defaultPrevented)e.preventDefault();}}} href={n.href} key={n.href} aria-current={active(n.href)?'page':undefined} className={active(n.href)?'active':''}><n.icon size={20}/><span>{n.short}</span></Link>)}{admin&&<button type="button" aria-label="운영 메뉴 더보기" aria-haspopup="dialog" aria-expanded={moreNavigation} data-active={moreNav.some(item=>active(item.href))?'true':'false'} onClick={()=>setMoreNavigation(true)}><Ellipsis size={20}/><span>더보기</span></button>}</nav>{toastMessage&&<div className="toast" role="status">{toastMessage}</div>}{notification&&<Modal title="알림" onClose={()=>setNotification(false)}>{visibleNotifications.length?visibleNotifications.map(n=><div className="notification-item" key={n.id}><strong>{n.title||n.data?.title||'자료가 발행됐어요'}</strong><p>{n.message||n.data?.message||n.body}</p></div>):<p className="muted">{data?.preferences?.notificationsEnabled===false?<>앱 알림이 꺼져 있어요. <Link href="/account/settings">알림 설정</Link></>:'새로운 알림이 없어요.'}</p>}</Modal>}{search&&<Modal title="나의 자료 검색" onClose={()=>setSearch(false)} initialFocusRef={searchInput}><p className={shellStyles.searchScope}>{targetId?'내 학생부 활동과 선택한 지원처의 예상·공통 질문을 검색해요.':'내 학생부 활동과 예상 질문을 검색해요.'}</p><div className="search-field"><Search size={18}/><input ref={searchInput} aria-label="활동·질문 검색" autoFocus placeholder="활동·질문 검색" value={term} onChange={e=>setTerm(e.target.value)}/></div><div className={shellStyles.searchMeta}><p className={shellStyles.searchCount} role="status" aria-live="polite">{hasSearchTerm?`검색 결과 ${searchResults.length}개`:'찾고 싶은 활동이나 질문을 입력해 주세요.'}</p>{term&&<button type="button" className={shellStyles.searchReset} onClick={()=>{setTerm('');searchInput.current?.focus();}}>검색 초기화</button>}</div><div className={shellStyles.searchResults}>{searchResults.map(item=><Link href={item.href} key={item.key} onClick={()=>setSearch(false)}><small>{item.kind}</small><span>{item.label}</span></Link>)}{hasSearchTerm&&!searchResults.length&&<div className={shellStyles.searchEmpty}><p>검색 결과가 없어요.</p><p>다른 단어로 검색하거나 지원처 선택을 확인해 주세요.</p></div>}</div></Modal>}{moreNavigation&&admin&&<Modal title="운영 메뉴" onClose={()=>setMoreNavigation(false)}><nav className={shellStyles.moreLinks} aria-label="추가 운영 메뉴">{moreNav.map(item=><Link href={item.href} key={item.href} aria-current={active(item.href)?'page':undefined} onClick={()=>setMoreNavigation(false)}><item.icon size={19}/><span>{item.label}</span></Link>)}</nav></Modal>}</div>;
}


